/**
 * sync 引擎事务化单测（M6，Spec §7.3-6/7 + §8.6/§8.7，fake host）：
 * 四 target 全量投影（共享根 AGENTS.md）/ MCP 管理键落盘 / 幂等跳写 /
 * soft（pi settings）失败仅 warning 且不写该 target 的 sync-meta /
 * 硬项失败 → 逆序回滚（已存在恢复原内容、新建文件删除）+ 失败汇总报告。
 *
 * 并发与中断：`.sync.lock/` 排他锁（**目录**形态，原子 mkdir 互斥；占用 →
 * ConflictError(3)、陈旧可抢占、持锁心跳、覆盖备份→apply→sync-meta 整段）/
 * 回滚前基准复核（写入后被外部改动 → 不覆盖）/ 回滚未完成时保留备份目录 /
 * 落盘备份与崩溃恢复（journal 来源与路径白名单校验、committed 只清理不回滚）/
 * 中断回滚句柄（getActiveSyncTransaction + rollbackActiveSyncTransactionSync，真实 fs 直测）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readEnv } from '../../../src/core/env';
import { ConflictError, PermissionError, toExitCode } from '../../../src/core/errors';
import {
  DEFAULT_MARKER_BEGIN,
  DEFAULT_MARKER_END,
  markerSectionHash,
  splitByMarkers,
} from '../../../src/core/markers';
import { currentOs } from '../../../src/core/paths';
import {
  getActiveSyncTransaction,
  getSyncFailureReport,
  inspectSyncResiduals,
  resolveLockRoots,
  rollbackActiveSyncTransactionSync,
  SYNC_BACKUP_DIRNAME,
  SYNC_BACKUP_FAILED_PREFIX,
  SYNC_BACKUP_JOURNAL_FILE,
  SYNC_LOCK_DIRNAME,
  SYNC_LOCK_META_FILE,
  type SyncOptions,
  syncOnce,
} from '../../../src/core/project/engine';
import { syncMetaPath } from '../../../src/core/project/sync-meta';
import { sha256Hex } from '../../../src/infra/fsutil';
import { realHost } from '../../../src/infra/real-host';
import { createFakeHost, type FakeHost } from '../test-utils';

const OS = currentOs();
const HOME = path.resolve('/home/u');
const CWD = path.resolve('/proj');
const PROJECT_SOT = path.join(CWD, '.agentforge');

// M6 四 target 的关键投影路径（投影矩阵 §8.7：opencode/codex/pi 共享根 AGENTS.md）
const AGENTS_MD = path.join(CWD, 'AGENTS.md');
const OPENCODE_JSON = path.join(CWD, 'opencode.json');
const CODEX_TOML = path.join(CWD, '.codex', 'config.toml');
const CLAUDE_MD = path.join(CWD, 'CLAUDE.md');
const MCP_JSON = path.join(CWD, '.mcp.json');
const PI_SETTINGS = path.join(CWD, '.pi', 'settings.json');

const HABITS_YAML = 'version: 1\n';
/** 空声明 habits + base/default 的渲染结果（composer 规范化后）。 */
const RENDERED_MINIMAL = '# AgentForge Rules\n';

const PROFILE_ALL = 'version: 1\ntargets: [opencode, codex, claude, pi]\n';

const PROFILE_WITH_MCP = [
  'version: 1',
  'targets: [opencode, codex, claude, pi]',
  'mcp:',
  '  servers:',
  '    - name: fs',
  '      transport: stdio',
  '      command: npx',
  '      args: ["-y", "server-fs"]',
  '      env:',
  '        KEY: v',
  '    - name: docs',
  '      transport: http',
  '      url: https://example.com/mcp',
  '      headers:',
  '        Authorization: Bearer x',
  '',
].join('\n');

/** 目录感知 listDir（engine 的 readCustomLayer 经宿主 path.join 拼路径）。 */
function createSyncHost(): FakeHost {
  const base = createFakeHost({ USERPROFILE: HOME });
  return {
    ...base,
    async listDir(p) {
      const prefix = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
      const names = new Set<string>();
      for (const key of base.files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (rest === '') {
            continue;
          }
          const sep = rest.search(/[\\/]/);
          names.add(sep === -1 ? rest : rest.slice(0, sep));
        }
      }
      return [...names].sort();
    },
  };
}

async function seed(host: FakeHost, profileYaml: string): Promise<void> {
  await host.writeFile(path.join(PROJECT_SOT, 'profile.yaml'), profileYaml);
  await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
}

function syncOptions(host: FakeHost, overrides: Partial<SyncOptions> = {}): SyncOptions {
  return {
    host,
    env: readEnv(host),
    os: OS,
    cwd: CWD,
    agentforgeVersion: 'test-0.1.0',
    dryRun: false,
    ...overrides,
  };
}

function eperm(message: string): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = 'EPERM';
  return e;
}

/** 注入：rename(to === denyPath) 抛 EPERM（atomicWrite 最终一步失败）。 */
function withDeniedRename(base: FakeHost, denyPath: string): FakeHost {
  return {
    ...base,
    async rename(from, to) {
      if (to === denyPath) {
        throw eperm(`injected EPERM: rename to ${denyPath}`);
      }
      return base.rename(from, to);
    },
  };
}

/** 注入：对 denyPath 本体及其 atomicWrite 临时文件的 writeFile 抛 EPERM。 */
function withDeniedWrite(base: FakeHost, denyPath: string): FakeHost {
  return {
    ...base,
    async writeFile(p, content) {
      if (p === denyPath || p.startsWith(`${denyPath}.agf-`)) {
        throw eperm(`injected EPERM: write to ${p}`);
      }
      return base.writeFile(p, content);
    },
  };
}

describe('syncOnce — 四 target 全量投影（§8.7 投影矩阵）', () => {
  it('六个投影文件全部落盘；AGENTS.md 仅一份且 marker 区间 = 渲染结果；共享文件幂等跳写', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);

    const result = await syncOnce(syncOptions(host));

    expect(result.targets.map((t) => t.targetId)).toEqual(['opencode', 'codex', 'claude', 'pi']);
    expect(result.skippedTargets).toEqual([]);
    expect(result.warnings).toEqual([]);

    // §8.7：opencode/codex/pi 共用根 AGENTS.md（一份），claude 独立 CLAUDE.md
    expect(host.files.has(AGENTS_MD)).toBe(true);
    expect(host.files.has(OPENCODE_JSON)).toBe(true);
    expect(host.files.has(CODEX_TOML)).toBe(true);
    expect(host.files.has(CLAUDE_MD)).toBe(true);
    expect(host.files.has(MCP_JSON)).toBe(true);
    expect(host.files.has(PI_SETTINGS)).toBe(true);

    // AGENTS.md marker 区间 = 统一渲染正文（§8.2 渲染一次分发）
    const agents = host.files.get(AGENTS_MD) as string;
    const split = splitByMarkers(agents, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END);
    expect(split.hasMarkers).toBe(true);
    expect(split.inside).toBe(`\n${RENDERED_MINIMAL}`);

    // MCP 管理键恒产出（空 servers → 空管理键声明，§8.3/§8.5/§8.6）
    expect(JSON.parse(host.files.get(OPENCODE_JSON) as string)).toEqual({ mcp: {} });
    expect(JSON.parse(host.files.get(MCP_JSON) as string)).toEqual({ mcpServers: {} });
    expect(JSON.parse(host.files.get(PI_SETTINGS) as string)).toEqual({ mcpServers: {} });
    const toml = host.files.get(CODEX_TOML) as string;
    expect(toml).toContain('# BEGIN AGENTFORGE MCP');
    expect(toml).toContain('# END AGENTFORGE MCP');

    // 共享 AGENTS.md：首个 target 实写，后续 target 幂等跳写（unchanged）
    const [opencode, codex, claude, pi] = result.targets;
    expect(opencode?.statuses).toEqual(['written', 'written']);
    expect(codex?.statuses).toEqual(['unchanged', 'written']);
    expect(claude?.statuses).toEqual(['written', 'written']);
    expect(pi?.statuses).toEqual(['unchanged', 'written']);
  });

  it('MCP servers 配置 → 四种管理键形态各就各位（opencode local/remote、claude/pi mcpServers、codex TOML 表块）', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_WITH_MCP);

    await syncOnce(syncOptions(host));

    expect(JSON.parse(host.files.get(OPENCODE_JSON) as string)).toEqual({
      mcp: {
        fs: {
          type: 'local',
          command: ['npx', '-y', 'server-fs'],
          enabled: true,
          environment: { KEY: 'v' },
        },
        docs: {
          type: 'remote',
          url: 'https://example.com/mcp',
          enabled: true,
          headers: { Authorization: 'Bearer x' },
        },
      },
    });

    const mcpServers = {
      fs: { command: 'npx', args: ['-y', 'server-fs'], env: { KEY: 'v' } },
      docs: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
      },
    };
    expect(JSON.parse(host.files.get(MCP_JSON) as string)).toEqual({ mcpServers });
    expect(JSON.parse(host.files.get(PI_SETTINGS) as string)).toEqual({ mcpServers });

    const toml = host.files.get(CODEX_TOML) as string;
    expect(toml).toContain('[[mcp_servers.fs]]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('args = ["-y", "server-fs"]');
    expect(toml).toContain('env = { KEY = "v" }');
    expect(toml).toContain('[[mcp_servers.docs]]');
    expect(toml).toContain('url = "https://example.com/mcp"');
    expect(toml).toContain('headers = { Authorization = "Bearer x" }');
  });

  it('幂等：二次 sync 全部 unchanged，contentHash 不变', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    const first = await syncOnce(syncOptions(host));

    const second = await syncOnce(syncOptions(host));
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.warnings).toEqual([]);
    for (const target of second.targets) {
      expect(target.statuses.every((s) => s === 'unchanged')).toBe(true);
    }
  });

  it('sync-meta 记录全部四个 target（contentHash 一致）', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    const result = await syncOnce(syncOptions(host));

    const meta = JSON.parse(host.files.get(syncMetaPath(PROJECT_SOT)) as string) as {
      targets: Record<string, { contentHash: string; writtenAt: string }>;
    };
    expect(Object.keys(meta.targets).sort()).toEqual(['claude', 'codex', 'opencode', 'pi']);
    for (const id of ['claude', 'codex', 'opencode', 'pi']) {
      expect(meta.targets[id]?.contentHash).toBe(result.contentHash);
    }
  });

  it('dry-run：四 target 计划齐全（statuses 全 planned），不写任何文件', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    const result = await syncOnce(syncOptions(host, { dryRun: true }));

    expect(result.dryRun).toBe(true);
    expect(result.targets.map((t) => t.targetId)).toEqual(['opencode', 'codex', 'claude', 'pi']);
    for (const target of result.targets) {
      expect(target.statuses.every((s) => s === 'planned')).toBe(true);
    }
    for (const file of [AGENTS_MD, OPENCODE_JSON, CODEX_TOML, CLAUDE_MD, MCP_JSON, PI_SETTINGS]) {
      expect(host.files.has(file)).toBe(false);
    }
    expect(host.files.has(syncMetaPath(PROJECT_SOT))).toBe(false);
  });
});

describe('syncOnce — soft 项（§8.6 Pi MVP）', () => {
  it('settings 写入失败 → sync 整体成功 + warning；sync-meta 不含 pi，其余 target 照常记录', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    const denied = withDeniedWrite(host, PI_SETTINGS);

    const result = await syncOnce(syncOptions(denied));

    // 整体成功：四 target 全部执行，无异常
    expect(result.targets.map((t) => t.targetId)).toEqual(['opencode', 'codex', 'claude', 'pi']);
    expect(result.warnings).toEqual([
      {
        targetId: 'pi',
        path: PI_SETTINGS,
        message: expect.stringContaining('无法写入目标文件'),
      },
    ]);

    // pi target：AGENTS.md 照常（unchanged），settings 项标记 warning
    const pi = result.targets.find((t) => t.targetId === 'pi');
    expect(pi?.statuses).toEqual(['unchanged', 'warning']);

    // 其余 target 文件正常落盘；settings 未写入
    expect(host.files.has(AGENTS_MD)).toBe(true);
    expect(host.files.has(OPENCODE_JSON)).toBe(true);
    expect(host.files.has(CODEX_TOML)).toBe(true);
    expect(host.files.has(CLAUDE_MD)).toBe(true);
    expect(host.files.has(MCP_JSON)).toBe(true);
    expect(host.files.has(PI_SETTINGS)).toBe(false);

    // sync-meta：pi 投影不完整 → 不记录（doctor 基准不受污染）
    const meta = JSON.parse(host.files.get(syncMetaPath(PROJECT_SOT)) as string) as {
      targets: Record<string, unknown>;
    };
    expect(Object.keys(meta.targets).sort()).toEqual(['claude', 'codex', 'opencode']);
  });
});

describe('syncOnce — 事务回滚（§7.3-6）', () => {
  it('硬项失败：已存在文件恢复原内容（逐字节）、未开始 target 无文件、sync-meta 不写、rethrow PermissionError(4) + 失败汇总', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);

    // 预置用户内容：AGENTS.md（marker 外 + 旧区间）、opencode.json（未知键）
    const agentsPreset = `# 项目说明\n\n${DEFAULT_MARKER_BEGIN}\n旧规则\n${DEFAULT_MARKER_END}\n\n尾部备注\n`;
    const opencodePreset = '{"theme": "dark"}\n';
    await host.writeFile(AGENTS_MD, agentsPreset);
    await host.writeFile(OPENCODE_JSON, opencodePreset);

    // 注入：codex 的 config.toml rename 失败（此时 opencode 两项已写入）
    const denied = withDeniedRename(host, CODEX_TOML);
    const err = await syncOnce(syncOptions(denied)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PermissionError);
    expect(toExitCode(err as PermissionError)).toBe(4);
    expect((err as PermissionError).message).toContain('config.toml');

    // 已写文件恢复到 sync 前内容（逐字节，不做任何规范化重排）
    expect(host.files.get(AGENTS_MD)).toBe(agentsPreset);
    expect(host.files.get(OPENCODE_JSON)).toBe(opencodePreset);

    // 未开始的 target（claude / pi）无任何文件
    expect(host.files.has(CLAUDE_MD)).toBe(false);
    expect(host.files.has(MCP_JSON)).toBe(false);
    expect(host.files.has(PI_SETTINGS)).toBe(false);

    // 失败汇总报告（§7.3-6：每 target 状态表 + 回滚声明）
    const report = getSyncFailureReport(err);
    expect(report).toBeDefined();
    expect(report?.failedTargetId).toBe('codex');
    expect(report?.failedPath).toBe(CODEX_TOML);
    expect(report?.targetStatuses).toEqual([
      { targetId: 'opencode', status: 'ok-rolled-back' },
      { targetId: 'codex', status: 'failed' },
      { targetId: 'claude', status: 'not-started' },
      { targetId: 'pi', status: 'not-started' },
    ]);
    // 逆序恢复全部已动文件（opencode.json 后写先恢复）
    expect(report?.rolledBack.map((r) => r.path)).toEqual([OPENCODE_JSON, AGENTS_MD]);
    expect(report?.rolledBack.every((r) => r.restored)).toBe(true);

    // 回滚则不更新 sync-meta（保留上次记录；本例无上次 → 不存在）
    expect(host.files.has(syncMetaPath(PROJECT_SOT))).toBe(false);
  });

  it('硬项失败（全新目录）：本次新建的文件被删除（备份为 null → rm）', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);

    const denied = withDeniedRename(host, CODEX_TOML);
    const err = await syncOnce(syncOptions(denied)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PermissionError);
    expect(toExitCode(err as PermissionError)).toBe(4);

    // 新建文件被删除：AGENTS.md / opencode.json 均不存在
    expect(host.files.has(AGENTS_MD)).toBe(false);
    expect(host.files.has(OPENCODE_JSON)).toBe(false);
    expect(host.files.has(CLAUDE_MD)).toBe(false);

    const report = getSyncFailureReport(err);
    expect(report?.rolledBack.map((r) => r.path)).toEqual([OPENCODE_JSON, AGENTS_MD]);
    expect(report?.rolledBack.every((r) => r.restored)).toBe(true);
    expect(host.files.has(syncMetaPath(PROJECT_SOT))).toBe(false);
  });

  it('soft 项失败不触发回滚：pi settings 写失败时其余文件保持写入后状态', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    const denied = withDeniedWrite(host, PI_SETTINGS);

    // sync 成功（无异常）→ 无回滚：AGENTS.md 等保持写入后状态
    const result = await syncOnce(syncOptions(denied));
    expect(result.warnings).toHaveLength(1);
    const agents = host.files.get(AGENTS_MD) as string;
    expect(splitByMarkers(agents, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END).inside).toBe(
      `\n${RENDERED_MINIMAL}`,
    );
    expect(host.files.has(OPENCODE_JSON)).toBe(true);
    expect(host.files.has(CLAUDE_MD)).toBe(true);
  });

  it('非权限类失败同样回滚：ConflictError（merge_json 现有文件损坏）→ 退出码 3', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    // 预置损坏的 opencode.json（非合法 JSON）→ opencode target 的 merge_json 失败
    await host.writeFile(OPENCODE_JSON, '{ not json');

    const err = await syncOnce(syncOptions(host)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(toExitCode(err as Error)).toBe(3); // ConflictError
    expect((err as Error).message).toContain('opencode.json');

    // 失败发生在首个写入项之前？——不：AGENTS.md 先成功写入，随后 opencode.json 失败 → AGENTS.md 被回滚删除
    expect(host.files.has(AGENTS_MD)).toBe(false);
    expect(host.files.get(OPENCODE_JSON)).toBe('{ not json'); // 损坏文件原样保留

    const report = getSyncFailureReport(err);
    expect(report?.failedTargetId).toBe('opencode');
    expect(report?.targetStatuses).toEqual([
      { targetId: 'opencode', status: 'failed' },
      { targetId: 'codex', status: 'not-started' },
      { targetId: 'claude', status: 'not-started' },
      { targetId: 'pi', status: 'not-started' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 事务排他锁（.sync.lock/ 目录 + 目录内 meta.json）
// ---------------------------------------------------------------------------

const LOCK_DIR = path.join(PROJECT_SOT, SYNC_LOCK_DIRNAME);
const LOCK_META = path.join(LOCK_DIR, SYNC_LOCK_META_FILE);
const JOURNAL_FILE = path.join(PROJECT_SOT, SYNC_BACKUP_DIRNAME, SYNC_BACKUP_JOURNAL_FILE);

/**
 * 写一个「他人持有」的锁（fake 时钟为 epoch；ageMinutes 为最近心跳的年龄）。
 *
 * machine 默认写成另一台机器：抢占陈旧锁时本进程无法对跨机器 pid 判活，
 * 判据退回「心跳停摆」——否则测试机上恰好存在同号 pid 会让结果不确定。
 */
async function seedLock(
  host: FakeHost,
  ageMinutes: number,
  pid = 4242,
  machine = 'another-machine',
  user = 'someone',
): Promise<void> {
  await host.writeFile(
    LOCK_META,
    JSON.stringify({
      pid,
      acquiredAt: new Date(host.now().getTime() - ageMinutes * 60_000).toISOString(),
      token: 'other-process-token',
      machine,
      user,
    }),
  );
}

describe('syncOnce — 事务排他锁（并发）', () => {
  it('锁被其他进程持有 → ConflictError(3)，且零写入（不碰任何投影文件）', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    await seedLock(host, 0);

    const err = await syncOnce(syncOptions(host)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(toExitCode(err as ConflictError)).toBe(3);
    expect((err as ConflictError).message).toContain('4242');
    expect((err as ConflictError).hint).toContain(LOCK_DIR);
    for (const file of [AGENTS_MD, OPENCODE_JSON, CODEX_TOML, CLAUDE_MD, MCP_JSON, PI_SETTINGS]) {
      expect(host.files.has(file)).toBe(false);
    }
    expect(host.files.has(syncMetaPath(PROJECT_SOT))).toBe(false);
    // 他人的锁不被删除
    expect(host.files.get(LOCK_META)).toContain('other-process-token');
  });

  it('陈旧锁（心跳停摆 >5 分钟且持有者不可判活）→ 抢占后正常 sync，结束时锁已释放', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    await seedLock(host, 6);

    const result = await syncOnce(syncOptions(host));

    expect(result.targets).toHaveLength(4);
    expect(host.files.has(AGENTS_MD)).toBe(true);
    expect(host.files.has(LOCK_META)).toBe(false); // finally 释放
    expect(host.dirs.has(LOCK_DIR)).toBe(false);
  });

  it('陈旧但持有者进程仍存活（同机器同用户）→ 报冲突而非抢占（慢 sync 不被误杀）', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    // machine/user 与 fake host 的 env 一致（均为空串），pid 取本进程 → 必然存活
    await seedLock(host, 60, process.pid, '', '');

    const err = await syncOnce(syncOptions(host)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(host.files.get(LOCK_META)).toContain('other-process-token');
    expect(host.files.has(AGENTS_MD)).toBe(false);
  });

  it('原子创建即互斥：并发两次取锁只有一个成功（mkdirExclusive 第二次 EEXIST）', async () => {
    const hostA = createSyncHost();
    await seed(hostA, PROFILE_ALL);
    // 两个「进程」共享同一份内存 fs（含 dirs），模拟同一 SoT 上的并发 sync
    const hostB: FakeHost = { ...hostA };

    const [a, b] = await Promise.allSettled([
      syncOnce(syncOptions(hostA)),
      syncOnce(syncOptions(hostB)),
    ]);
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === 'rejected' && rejected[0].reason).toBeInstanceOf(ConflictError);
  });

  it('持锁期间刷新心跳：锁元数据的 acquiredAt 被重写（token 不变）', async () => {
    const base = createSyncHost();
    await seed(base, PROFILE_ALL);
    const metaWrites: string[] = [];
    const host: FakeHost = {
      ...base,
      async writeFile(p, content) {
        if (p === LOCK_META) {
          metaWrites.push(content);
        }
        return base.writeFile(p, content);
      },
    };

    await syncOnce(syncOptions(host));
    // 至少写过一次（取锁时）；内容含 pid/token/machine/user 四要素
    expect(metaWrites).toHaveLength(1);
    const record = JSON.parse(metaWrites[0] as string) as Record<string, unknown>;
    expect(record.pid).toBe(process.pid);
    expect(typeof record.token).toBe('string');
    expect(record).toHaveProperty('machine');
    expect(record).toHaveProperty('user');
  });

  it('抢占陈旧锁时清理失败（EPERM）→ PermissionError(4) 且 hint 给出锁路径', async () => {
    const base = createSyncHost();
    await seed(base, PROFILE_ALL);
    await seedLock(base, 6);
    const host: FakeHost = {
      ...base,
      async rm(p) {
        if (p === LOCK_DIR) {
          throw eperm(`injected EPERM: rm ${LOCK_DIR}`);
        }
        return base.rm(p);
      },
    };

    const err = await syncOnce(syncOptions(host)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);
    expect(toExitCode(err as PermissionError)).toBe(4);
    expect((err as PermissionError).hint).toContain(LOCK_DIR);
  });

  it('dry-run 不取锁（他人持锁时仍可预览）', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    await seedLock(host, 0);

    const result = await syncOnce(syncOptions(host, { dryRun: true }));
    expect(result.dryRun).toBe(true);
    expect(result.targets).toHaveLength(4);
    expect(host.files.has(AGENTS_MD)).toBe(false);
  });

  it('锁覆盖「备份 → apply → 写 sync-meta」整段（每次落盘时锁与 journal 均在位）', async () => {
    const base = createSyncHost();
    await seed(base, PROFILE_ALL);

    const lockPresent = new Map<string, boolean>();
    const journalPresent = new Map<string, boolean>();
    const host: FakeHost = {
      ...base,
      async rename(from, to) {
        lockPresent.set(to, base.files.has(LOCK_META));
        journalPresent.set(to, base.files.has(JOURNAL_FILE));
        return base.rename(from, to);
      },
    };

    const result = await syncOnce(syncOptions(host));
    expect(result.recovered).toEqual([]);
    expect(result.transactionWarnings).toEqual([]);

    // apply 阶段（首个投影文件）与 sync-meta 写入均在锁内；备份日志此时已落盘
    expect(lockPresent.get(AGENTS_MD)).toBe(true);
    expect(journalPresent.get(AGENTS_MD)).toBe(true);
    expect(lockPresent.get(syncMetaPath(PROJECT_SOT))).toBe(true);
    expect(journalPresent.get(syncMetaPath(PROJECT_SOT))).toBe(true);
    // 事务结束：锁与备份产物均清理
    expect(host.files.has(LOCK_META)).toBe(false);
    expect(host.files.has(JOURNAL_FILE)).toBe(false);
    expect([...host.files.keys()].some((k) => k.includes(SYNC_BACKUP_DIRNAME))).toBe(false);
  });

  it('锁元数据损坏 → 视为陈旧可抢占（不因坏锁永久卡死）', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    await host.writeFile(LOCK_META, 'not json at all');

    const result = await syncOnce(syncOptions(host));
    expect(result.targets).toHaveLength(4);
    expect(host.files.has(LOCK_META)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 回滚前基准复核 + 回滚部分失败
// ---------------------------------------------------------------------------

describe('syncOnce — 回滚前基准复核（并发改动不被覆盖）', () => {
  it('本次写入后文件被外部改动 → 该文件不回滚（restored=false + 冲突说明），外部内容保留', async () => {
    const base = createSyncHost();
    await seed(base, PROFILE_ALL);
    const agentsPreset = `# 项目说明\n\n${DEFAULT_MARKER_BEGIN}\n旧规则\n${DEFAULT_MARKER_END}\n`;
    await base.writeFile(AGENTS_MD, agentsPreset);

    const external = '# 并发进程写入的内容\n';
    const host: FakeHost = {
      ...base,
      async rename(from, to) {
        if (to === CODEX_TOML) {
          // 模拟：本次 sync 写完 AGENTS.md 后，另一个进程 / 编辑器又改了它
          base.files.set(AGENTS_MD, external);
          throw eperm(`injected EPERM: rename to ${CODEX_TOML}`);
        }
        return base.rename(from, to);
      },
    };

    const err = await syncOnce(syncOptions(host)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);

    const report = getSyncFailureReport(err);
    const agentsEntry = report?.rolledBack.find((r) => r.path === AGENTS_MD);
    expect(agentsEntry?.restored).toBe(false);
    expect(agentsEntry?.error).toContain('外部修改');
    // 外部内容原样保留（既不写回过期备份，也不留本次渲染结果）
    expect(host.files.get(AGENTS_MD)).toBe(external);
    // 未被外部改动的文件照常回滚（本次新建 → 删除）
    expect(report?.rolledBack.find((r) => r.path === OPENCODE_JSON)?.restored).toBe(true);
    expect(host.files.has(OPENCODE_JSON)).toBe(false);
  });
});

describe('syncOnce — 回滚部分失败（报告如实呈现）', () => {
  it('恢复动作自身失败 → 该条目 restored=false 且带错误信息，其余条目照常恢复', async () => {
    const base = createSyncHost();
    await seed(base, PROFILE_ALL);
    const host: FakeHost = {
      ...base,
      async rm(p) {
        if (p === OPENCODE_JSON) {
          throw eperm(`injected EPERM: rm ${OPENCODE_JSON}`);
        }
        return base.rm(p);
      },
      async rename(from, to) {
        if (to === CODEX_TOML) {
          throw eperm(`injected EPERM: rename to ${CODEX_TOML}`);
        }
        return base.rename(from, to);
      },
    };

    const err = await syncOnce(syncOptions(host)).catch((e: unknown) => e);
    const report = getSyncFailureReport(err);

    expect(report?.rolledBack.find((r) => r.path === OPENCODE_JSON)).toEqual({
      path: OPENCODE_JSON,
      restored: false,
      error: expect.stringContaining('injected EPERM'),
    });
    expect(report?.rolledBack.find((r) => r.path === AGENTS_MD)?.restored).toBe(true);
    expect(host.files.has(AGENTS_MD)).toBe(false); // 新建文件已删除
    expect(host.files.has(OPENCODE_JSON)).toBe(true); // 删除失败 → 残留（报告已声明）
  });
});

// ---------------------------------------------------------------------------
// 落盘备份与崩溃（SIGKILL）恢复
// ---------------------------------------------------------------------------

/** 伪造一份「上次 sync 被强杀」的落盘备份：AGENTS.md 已写入、备份副本尚存。 */
async function seedKilledTransaction(
  host: FakeHost,
  halfWritten: string,
  backupContent: string,
  writtenHash: string | null,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const backupDir = path.join(PROJECT_SOT, SYNC_BACKUP_DIRNAME);
  const backupFile = path.join(backupDir, '000-AGENTS.md.bak');
  await host.writeFile(AGENTS_MD, halfWritten);
  await host.writeFile(backupFile, backupContent);
  await host.writeFile(
    JOURNAL_FILE,
    JSON.stringify({
      version: 1,
      pid: 999,
      startedAt: host.now().toISOString(),
      sotRoot: PROJECT_SOT,
      // fake host 的 env 无 COMPUTERNAME/USERNAME → 引擎侧机器/用户标识均为空串
      machine: '',
      user: '',
      committed: false,
      entries: [{ path: AGENTS_MD, existedBefore: true, backupFile, written: true, writtenHash }],
      ...overrides,
    }),
  );
  return backupFile;
}

describe('syncOnce — 崩溃恢复（残留落盘备份）', () => {
  it('残留 journal 中已写入的文件被恢复为备份基准，并报告在 result.recovered', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    const halfWritten = '# 半成品（上次被强杀时写下的内容）\n';
    const backupFile = await seedKilledTransaction(
      host,
      halfWritten,
      '# sync 前的原始内容\n',
      sha256Hex(halfWritten),
    );

    const result = await syncOnce(syncOptions(host));

    expect(result.recovered).toEqual([{ path: AGENTS_MD, restored: true }]);
    // 残留产物清理干净（否则下次 sync 会重复"恢复"）
    expect(host.files.has(JOURNAL_FILE)).toBe(false);
    expect(host.files.has(backupFile)).toBe(false);
    // 恢复后本次 sync 正常投影
    expect(
      splitByMarkers(host.files.get(AGENTS_MD) as string, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END)
        .inside,
    ).toBe(`\n${RENDERED_MINIMAL}`);
  });

  it('残留基准与当前内容不符（其后又被人改过）→ 不覆盖，恢复条目 restored=false', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    await seedKilledTransaction(
      host,
      '# 用户后来又手改过的内容\n',
      '# sync 前的原始内容\n',
      sha256Hex('# 上次写入时的内容（已过期）\n'),
    );

    const result = await syncOnce(syncOptions(host));
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.restored).toBe(false);
    expect(result.recovered[0]?.error).toContain('外部修改');
  });

  it('残留备份目录但 journal 损坏 → 只清理垃圾，不动投影文件', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    await host.writeFile(AGENTS_MD, '# 用户内容\n');
    await host.writeFile(JOURNAL_FILE, '{ broken');

    const result = await syncOnce(syncOptions(host));
    expect(result.recovered).toEqual([]);
    expect(host.files.has(JOURNAL_FILE)).toBe(false);
    expect(host.files.get(AGENTS_MD)).toContain('# 用户内容');
  });

  it('备份落盘失败（SoT 不可写）→ 降级为内存备份：sync 不被阻断，回滚照常生效', async () => {
    const base = createSyncHost();
    await seed(base, PROFILE_ALL);
    const agentsPreset = `# 项目说明\n\n${DEFAULT_MARKER_BEGIN}\n旧规则\n${DEFAULT_MARKER_END}\n`;
    await base.writeFile(AGENTS_MD, agentsPreset);

    const backupDir = path.join(PROJECT_SOT, SYNC_BACKUP_DIRNAME);
    const host: FakeHost = {
      ...base,
      async writeFile(p, content) {
        if (p.startsWith(`${backupDir}${path.sep}`)) {
          throw eperm(`injected EPERM: backup write ${p}`); // 备份产物一律写不进去
        }
        return base.writeFile(p, content);
      },
      async rename(from, to) {
        if (to === CODEX_TOML) {
          throw eperm(`injected EPERM: rename to ${CODEX_TOML}`);
        }
        return base.rename(from, to);
      },
    };

    const err = await syncOnce(syncOptions(host)).catch((e: unknown) => e);

    // 失败点仍是真正的投影项（不是备份设施），回滚用内存备份恢复原内容
    expect(err).toBeInstanceOf(PermissionError);
    expect((err as PermissionError).message).toContain('config.toml');
    expect(host.files.get(AGENTS_MD)).toBe(agentsPreset);
    expect(getSyncFailureReport(err)?.rolledBack.every((r) => r.restored)).toBe(true);
    // 落盘备份降级：journal 未生成
    expect(host.files.has(JOURNAL_FILE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ctrl-C 中断路径（回滚句柄暴露 + 同步回滚函数）
//
// 同步回滚走 node:fs 的同步 API（信号处理器内异步 IO 不可靠），故本组用真实
// 临时目录 + realHost 直测——fake host 的内存 fs 对 node:fs 不可见。
// ---------------------------------------------------------------------------

describe('中断回滚句柄（SIGINT 路径直测）', () => {
  let tmpRoot: string | undefined;

  afterEach(() => {
    if (tmpRoot !== undefined) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  it('事务外：getActiveSyncTransaction() → null，同步回滚为空操作', () => {
    expect(getActiveSyncTransaction()).toBeNull();
    expect(rollbackActiveSyncTransactionSync()).toEqual([]);
  });

  it('apply 中途：句柄暴露已写文件；同步回滚写回原内容并清理锁与落盘备份', async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'agf-tx-'));
    const projectRoot = path.join(tmpRoot, 'proj');
    const sotRoot = path.join(projectRoot, '.agentforge');
    const userSoTRoot = path.join(tmpRoot, 'userhome');
    const claudeMd = path.join(projectRoot, 'CLAUDE.md');
    const mcpJson = path.join(projectRoot, '.mcp.json');
    const original = '# 我的项目说明（sync 前）\n';

    await realHost.mkdirp(sotRoot);
    await realHost.mkdirp(userSoTRoot);
    await realHost.writeFile(
      path.join(sotRoot, 'profile.yaml'),
      'version: 1\nscope: project\ntargets: [claude]\n',
    );
    await realHost.writeFile(path.join(sotRoot, 'habits.yaml'), HABITS_YAML);
    await realHost.writeFile(claudeMd, original);

    let snapshot: ReturnType<typeof getActiveSyncTransaction> = null;
    let syncRollback: ReturnType<typeof rollbackActiveSyncTransactionSync> = [];
    const interrupting = {
      ...realHost,
      async rename(from: string, to: string): Promise<void> {
        if (to === mcpJson) {
          // 此刻 CLAUDE.md 已写入并记账 —— 模拟 Ctrl-C 落在 apply 循环中途
          snapshot = getActiveSyncTransaction();
          syncRollback = rollbackActiveSyncTransactionSync();
          throw new Error('simulated SIGINT');
        }
        return realHost.rename(from, to);
      },
    };

    await syncOnce({
      host: interrupting,
      env: {
        agfHome: userSoTRoot,
        agfScope: undefined,
        offline: false,
        lineEnding: undefined,
        ci: false,
        codexHome: undefined,
        userProfile: path.join(tmpRoot, 'home'),
      },
      os: OS,
      cwd: projectRoot,
      agentforgeVersion: 'test-0.1.0',
      dryRun: false,
    }).catch(() => undefined);

    // 句柄：已写文件与 SoT 根可读
    expect(snapshot).not.toBeNull();
    expect(snapshot?.sotRoot).toBe(sotRoot);
    expect(snapshot?.writtenFiles).toEqual([claudeMd]);
    expect(snapshot?.backedUpFiles).toContain(claudeMd);

    // 同步回滚：内容写回 sync 前状态
    expect(syncRollback).toEqual([{ path: claudeMd, restored: true }]);
    expect(readFileSync(claudeMd, 'utf8')).toBe(original);
    expect(existsSync(mcpJson)).toBe(false);

    // 锁与落盘备份均已清理；事务句柄注销
    expect(existsSync(path.join(sotRoot, SYNC_LOCK_DIRNAME))).toBe(false);
    expect(existsSync(path.join(sotRoot, SYNC_BACKUP_DIRNAME))).toBe(false);
    expect(getActiveSyncTransaction()).toBeNull();
    // sync-meta 未写（事务未完成）
    expect(existsSync(syncMetaPath(sotRoot))).toBe(false);
  });

  it('中断落在 recordWrite 的 hash 读回窗口内：文件仍被回滚，遗留 .agf-*.tmp 被清理', async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'agf-tx-'));
    const projectRoot = path.join(tmpRoot, 'proj');
    const sotRoot = path.join(projectRoot, '.agentforge');
    const userSoTRoot = path.join(tmpRoot, 'userhome');
    const claudeMd = path.join(projectRoot, 'CLAUDE.md');
    const strayTmp = path.join(projectRoot, 'CLAUDE.md.agf-aaaaaaaaaaaa.tmp');
    const original = '# 我的项目说明（sync 前）\n';

    await realHost.mkdirp(sotRoot);
    await realHost.mkdirp(userSoTRoot);
    await realHost.writeFile(
      path.join(sotRoot, 'profile.yaml'),
      'version: 1\nscope: project\ntargets: [claude]\n',
    );
    await realHost.writeFile(path.join(sotRoot, 'habits.yaml'), HABITS_YAML);
    await realHost.writeFile(claudeMd, original);
    await realHost.writeFile(strayTmp, 'leftover from a killed sync\n');

    let tripped = false;
    let rolledBack: ReturnType<typeof rollbackActiveSyncTransactionSync> = [];
    let contentRightAfterRollback: string | undefined;
    const interrupting = {
      ...realHost,
      async readFile(p: string): Promise<string> {
        // 「文件内容已不是 sync 前的原文」= 刚写完、正在读回算 hash 的那一刻
        if (p === claudeMd && !tripped && readFileSync(claudeMd, 'utf8') !== original) {
          tripped = true;
          rolledBack = rollbackActiveSyncTransactionSync();
          contentRightAfterRollback = readFileSync(claudeMd, 'utf8');
          throw new Error('simulated interrupt inside the hash window');
        }
        return realHost.readFile(p);
      },
    };

    await syncOnce({
      host: interrupting,
      env: {
        agfHome: userSoTRoot,
        agfScope: undefined,
        offline: false,
        lineEnding: undefined,
        ci: false,
        codexHome: undefined,
        userProfile: path.join(tmpRoot, 'home'),
      },
      os: OS,
      cwd: projectRoot,
      agentforgeVersion: 'test-0.1.0',
      dryRun: false,
    }).catch(() => undefined);

    // 关键：hash 尚未算出，但文件已在回滚清单里 → 中断照样把它恢复到 sync 前
    expect(rolledBack).toEqual([{ path: claudeMd, restored: true }]);
    expect(contentRightAfterRollback).toBe(original);
    // atomicWrite 的临时文件不再永久残留（process.exit 后 finally 不会执行）
    expect(existsSync(strayTmp)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 回滚未完成 → 保留备份证据（数据留存；退出码 6 的输出依据）
// ---------------------------------------------------------------------------

/** 构造「回滚未全部成功」的场景：AGENTS.md 写入后被外部改动 → 漂移判定不覆盖。 */
function withDriftDuringRollback(base: FakeHost, external: string): FakeHost {
  return {
    ...base,
    async rename(from, to) {
      if (to === CODEX_TOML) {
        base.files.set(AGENTS_MD, external); // 模拟并发进程 / 编辑器改动
        throw eperm(`injected EPERM: rename to ${CODEX_TOML}`);
      }
      return base.rename(from, to);
    },
  };
}

describe('syncOnce — 回滚未完成时保留备份', () => {
  it('存在 restored=false → 备份另存到 .agf-backup-failed-<ts>/（原备份目录清理），路径进失败汇总', async () => {
    const base = createSyncHost();
    await seed(base, PROFILE_ALL);
    const agentsPreset = `# 项目说明\n\n${DEFAULT_MARKER_BEGIN}\n旧规则\n${DEFAULT_MARKER_END}\n`;
    await base.writeFile(AGENTS_MD, agentsPreset);
    const host = withDriftDuringRollback(base, '# 并发进程写入的内容\n');

    const err = await syncOnce(syncOptions(host)).catch((e: unknown) => e);
    const report = getSyncFailureReport(err);

    // 保留目录进入失败汇总（命令层据此在退出码 6 的输出里指路）
    const preserved = report?.preservedBackupDir;
    expect(preserved).toBeDefined();
    expect(path.basename(preserved as string).startsWith(SYNC_BACKUP_FAILED_PREFIX)).toBe(true);

    // 目录里留着 sync 前的原文与一份 journal —— 用户「手工处理」时有据可依
    const kept = [...host.files.keys()].filter((k) => k.startsWith(`${preserved}${path.sep}`));
    expect(kept.some((k) => k.endsWith(SYNC_BACKUP_JOURNAL_FILE))).toBe(true);
    expect(kept.some((k) => host.files.get(k) === agentsPreset)).toBe(true);

    // 原备份目录（崩溃恢复入口）已清理，避免下次 sync 反复「恢复」同一残留
    expect(host.files.has(JOURNAL_FILE)).toBe(false);
  });

  it('全部恢复成功 → 不保留（无 preservedBackupDir，备份产物清理干净）', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    const denied = withDeniedRename(host, CODEX_TOML);

    const err = await syncOnce(syncOptions(denied)).catch((e: unknown) => e);
    const report = getSyncFailureReport(err);

    expect(report?.rolledBack.every((r) => r.restored)).toBe(true);
    expect(report?.preservedBackupDir).toBeUndefined();
    expect([...host.files.keys()].some((k) => k.includes(SYNC_BACKUP_DIRNAME))).toBe(false);
  });

  it('回滚清单按路径去重（共享 AGENTS.md 被三个 target 计划，只回滚一次）', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    const denied = withDeniedRename(host, CODEX_TOML);

    const err = await syncOnce(syncOptions(denied)).catch((e: unknown) => e);
    const paths = getSyncFailureReport(err)?.rolledBack.map((r) => r.path) ?? [];
    expect(paths).toEqual([...new Set(paths)]);
  });
});

// ---------------------------------------------------------------------------
// recordWrite 的记账顺序（先登记后算 hash：两道兜底都不漏）
// ---------------------------------------------------------------------------

describe('recordWrite — 无 await 空窗', () => {
  it('读回内容算 hash 时，该文件已在回滚清单与 journal（written=true / writtenHash 待补）', async () => {
    const base = createSyncHost();
    await seed(base, PROFILE_ALL);

    let snapshot: ReturnType<typeof getActiveSyncTransaction> = null;
    let journalInWindow: string | undefined;
    const host: FakeHost = {
      ...base,
      async readFile(p) {
        // 首次「AGENTS.md 已存在时的读取」即 recordWrite 的读回（applyItem 的
        // readExisting 发生在文件创建之前）
        if (p === AGENTS_MD && snapshot === null && base.files.has(AGENTS_MD)) {
          snapshot = getActiveSyncTransaction();
          journalInWindow = base.files.get(JOURNAL_FILE);
        }
        return base.readFile(p);
      },
    };

    await syncOnce(syncOptions(host));

    expect(snapshot?.writtenFiles).toContain(AGENTS_MD);
    const journal = JSON.parse(journalInWindow as string) as {
      entries: { path: string; written: boolean; writtenHash: string | null }[];
    };
    const entry = journal.entries.find((e) => e.path === AGENTS_MD);
    expect(entry?.written).toBe(true);
    expect(entry?.writtenHash).toBeNull();
  });

  it('读回失败（hash 无基准）→ 记录降级警告，其余流程照常', async () => {
    const base = createSyncHost();
    await seed(base, PROFILE_ALL);
    let denied = false;
    const host: FakeHost = {
      ...base,
      async readFile(p) {
        // 只拦第一次「文件已存在时的读取」= recordWrite 的读回；后续 readExisting 照常
        if (p === AGENTS_MD && !denied && base.files.has(AGENTS_MD)) {
          denied = true;
          throw eperm(`injected EPERM: read back ${AGENTS_MD}`);
        }
        return base.readFile(p);
      },
    };

    const result = await syncOnce(syncOptions(host));
    expect(denied).toBe(true);
    expect(
      result.transactionWarnings.some((w) => w.message.includes('crash recovery disabled')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 崩溃恢复的信任边界（journal 是磁盘上的普通 JSON，不可无条件照做）
// ---------------------------------------------------------------------------

describe('recoverPendingTransaction — journal 校验', () => {
  it('目标路径越出预期根 → 拒绝恢复（该文件内容分毫不动），并保留备份待人工核对', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    const outside = path.resolve('/elsewhere/victim.txt');
    const victim = 'sensitive content\n';
    await host.writeFile(outside, victim);
    const backupFile = path.join(PROJECT_SOT, SYNC_BACKUP_DIRNAME, '000-victim.txt.bak');
    await host.writeFile(backupFile, 'attacker payload\n');
    await host.writeFile(
      JOURNAL_FILE,
      JSON.stringify({
        version: 1,
        pid: 999,
        startedAt: host.now().toISOString(),
        sotRoot: PROJECT_SOT,
        machine: '',
        user: '',
        committed: false,
        entries: [
          {
            path: outside,
            existedBefore: true,
            backupFile,
            written: true,
            writtenHash: sha256Hex(victim),
          },
        ],
      }),
    );

    const result = await syncOnce(syncOptions(host));

    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.restored).toBe(false);
    expect(result.recovered[0]?.error).toContain('拒绝恢复');
    expect(host.files.get(outside)).toBe(victim); // 备份内容没有被写进越界路径
    expect(host.files.has(JOURNAL_FILE)).toBe(false);
    expect(result.transactionWarnings.some((w) => w.message.includes('人工核对'))).toBe(true);
  });

  it('跨机器的 journal → 只清理不恢复（pid 与路径都无可比性）', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    await seedKilledTransaction(
      host,
      '# 半成品\n',
      '# sync 前的原始内容\n',
      sha256Hex('# 半成品\n'),
      {
        machine: 'another-machine',
      },
    );

    const result = await syncOnce(syncOptions(host));
    expect(result.recovered).toEqual([]);
    expect(host.files.get(AGENTS_MD)).toContain('半成品');
    expect(host.files.get(AGENTS_MD)).not.toContain('sync 前的原始内容');
    expect(host.files.has(JOURNAL_FILE)).toBe(false);
  });

  it('committed=true 的 journal（上次已提交后被强杀）→ 只清理不回滚', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    await seedKilledTransaction(
      host,
      '# 半成品\n',
      '# sync 前的原始内容\n',
      sha256Hex('# 半成品\n'),
      {
        committed: true,
      },
    );

    const result = await syncOnce(syncOptions(host));
    expect(result.recovered).toEqual([]);
    expect(host.files.get(AGENTS_MD)).not.toContain('sync 前的原始内容');
  });

  it('写入过但无复核基准（journal 降级）→ 提示人工核对而非静默丢弃', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    await seedKilledTransaction(host, '# 半成品\n', '# sync 前的原始内容\n', null);

    const result = await syncOnce(syncOptions(host));
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.restored).toBe(false);
    expect(result.recovered[0]?.error).toContain('人工核对');
  });

  it('提交标记在写 sync-meta 之前落盘（committed=true 才写 sync-meta）', async () => {
    const base = createSyncHost();
    await seed(base, PROFILE_ALL);
    let journalAtMetaWrite: string | undefined;
    const host: FakeHost = {
      ...base,
      async rename(from, to) {
        if (to === syncMetaPath(PROJECT_SOT)) {
          journalAtMetaWrite = base.files.get(JOURNAL_FILE);
        }
        return base.rename(from, to);
      },
    };

    await syncOnce(syncOptions(host));
    const journal = JSON.parse(journalAtMetaWrite as string) as { committed: boolean };
    expect(journal.committed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// marker_mode: append_below_marker —— 追加语义与冲突预检查的基准必须同源
// ---------------------------------------------------------------------------

const PROFILE_APPEND = [
  'version: 1',
  'targets: [claude]',
  'projection:',
  '  marker_mode: append_below_marker',
  '',
].join('\n');

describe('syncOnce — append_below_marker 不误报冲突', () => {
  it('sync → 改 SoT → sync（区间追加）→ sync：第三次不抛冲突，区间保留两段正文', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_APPEND);

    await syncOnce(syncOptions(host));
    await host.writeFile(path.join(PROJECT_SOT, 'custom', 'a.md'), '# 追加的自定义规则\n');
    await syncOnce(syncOptions(host)); // 区间 = 新正文 + 空行 + 旧正文

    const afterAppend = host.files.get(CLAUDE_MD) as string;
    expect(afterAppend).toContain('追加的自定义规则');
    expect(splitByMarkers(afterAppend, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END).hasMarkers).toBe(
      true,
    );

    // 第三次 sync：落盘区间与 sync-meta 记录同源 → 既不冲突也不再膨胀
    const third = await syncOnce(syncOptions(host));
    expect(third.targets.map((t) => t.targetId)).toEqual(['claude']);
    expect(host.files.get(CLAUDE_MD)).toBe(afterAppend);
  });

  it('sync-meta 记录本次实际落盘的区间 hash（追加模式下不等于渲染正文的区间 hash）', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_APPEND);
    await syncOnce(syncOptions(host));
    await host.writeFile(path.join(PROJECT_SOT, 'custom', 'a.md'), '# 追加的自定义规则\n');
    const result = await syncOnce(syncOptions(host));

    const meta = JSON.parse(host.files.get(syncMetaPath(PROJECT_SOT)) as string) as {
      targets: Record<string, { contentHash: string }>;
    };
    const onDisk = markerSectionHash(
      host.files.get(CLAUDE_MD) as string,
      DEFAULT_MARKER_BEGIN,
      DEFAULT_MARKER_END,
    );
    expect(meta.targets.claude?.contentHash).toBe(onDisk);
    expect(meta.targets.claude?.contentHash).not.toBe(result.contentHash);
  });

  it('replace_between_markers（默认）下两个基准仍然相等（不改变既有语义）', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    const result = await syncOnce(syncOptions(host));

    const meta = JSON.parse(host.files.get(syncMetaPath(PROJECT_SOT)) as string) as {
      targets: Record<string, { contentHash: string }>;
    };
    expect(meta.targets.claude?.contentHash).toBe(result.contentHash);
  });
});

// ---------------------------------------------------------------------------
// 锁根解析（SoT 之外的投影目标 + 固定加锁顺序）
// ---------------------------------------------------------------------------

const USER_SOT = path.join(HOME, '.agentforge');

describe('resolveLockRoots', () => {
  it('产物全在项目根内 → 只锁本层 SoT（不牵连同一用户的其他项目）', () => {
    expect(
      resolveLockRoots(PROJECT_SOT, USER_SOT, CWD, [AGENTS_MD, CODEX_TOML], [HOME], OS),
    ).toEqual([PROJECT_SOT]);
  });

  it('产物落在项目根之外的用户目录 / CODEX_HOME → 额外锁用户级 SoT，按字典序返回', () => {
    const codexHome = path.join(HOME, '.codex');
    const roots = resolveLockRoots(
      PROJECT_SOT,
      USER_SOT,
      CWD,
      [AGENTS_MD, path.join(codexHome, 'config.toml')],
      [HOME, codexHome],
      OS,
    );
    expect(roots).toEqual([PROJECT_SOT, USER_SOT].sort());
    expect(roots).toEqual([...roots].sort()); // 固定加锁顺序 → 不会与他人交叉死锁
  });

  it('user scope（sotRoot === userSoTRoot）→ 一把锁已覆盖，不重复取', () => {
    expect(
      resolveLockRoots(USER_SOT, USER_SOT, CWD, [path.join(HOME, 'AGENTS.md')], [HOME], OS),
    ).toEqual([USER_SOT]);
  });
});

// ---------------------------------------------------------------------------
// 运行时残留诊断（inspectSyncResiduals；doctor 的数据源，只读）
// ---------------------------------------------------------------------------

describe('inspectSyncResiduals（Spec §3.2 运行时产物）', () => {
  /** 写一份 journal（committed 可控；entries 固定一条已写入）。 */
  async function seedJournal(host: FakeHost, committed: boolean): Promise<void> {
    await host.writeFile(
      JOURNAL_FILE,
      JSON.stringify({
        version: 1,
        pid: 4242,
        startedAt: new Date(host.now().getTime()).toISOString(),
        sotRoot: PROJECT_SOT,
        machine: 'another-machine',
        user: 'someone',
        committed,
        entries: [{ path: CLAUDE_MD, existedBefore: true, backupFile: null, written: true }],
      }),
    );
  }

  it('干净的 SoT → 无残留', async () => {
    const host = createSyncHost();
    await seed(host, PROFILE_ALL);
    expect(await inspectSyncResiduals(host, PROJECT_SOT, OS)).toEqual([]);
  });

  it('新鲜锁 → lock-live（另一个 sync 正在写，不该被当成故障）', async () => {
    const host = createSyncHost();
    await seedLock(host, 0);
    const residuals = await inspectSyncResiduals(host, PROJECT_SOT, OS);
    expect(residuals.map((r) => r.kind)).toEqual(['lock-live']);
    expect(residuals[0]?.path).toBe(LOCK_DIR);
  });

  it('心跳停摆超过陈旧阈值 → lock-stale', async () => {
    const host = createSyncHost();
    await seedLock(host, 10); // 10 分钟 > SYNC_LOCK_STALE_MS（5 分钟）
    expect((await inspectSyncResiduals(host, PROJECT_SOT, OS)).map((r) => r.kind)).toEqual([
      'lock-stale',
    ]);
  });

  it('committed=false 的 journal → journal-pending；committed=true → 不报', async () => {
    const pendingHost = createSyncHost();
    await seedJournal(pendingHost, false);
    expect((await inspectSyncResiduals(pendingHost, PROJECT_SOT, OS)).map((r) => r.kind)).toEqual([
      'journal-pending',
    ]);

    const committedHost = createSyncHost();
    await seedJournal(committedHost, true);
    expect(await inspectSyncResiduals(committedHost, PROJECT_SOT, OS)).toEqual([]);
  });

  it('.agf-backup-failed-<ts> 目录 → backup-failed（只报告，不删除）', async () => {
    const host = createSyncHost();
    const failedDir = path.join(PROJECT_SOT, `${SYNC_BACKUP_FAILED_PREFIX}19700101000000`);
    const evidence = path.join(failedDir, '000-CLAUDE.md.bak');
    await host.writeFile(evidence, 'original');

    const residuals = await inspectSyncResiduals(host, PROJECT_SOT, OS);

    expect(residuals.map((r) => r.kind)).toEqual(['backup-failed']);
    expect(residuals[0]?.path).toBe(failedDir);
    expect(host.files.get(evidence)).toBe('original'); // 诊断绝不销毁唯一副本
  });
});
