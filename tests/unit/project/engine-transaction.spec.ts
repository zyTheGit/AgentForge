/**
 * sync 引擎事务化单测（M6，Spec §7.3-6/7 + §8.6/§8.7，fake host）：
 * 四 target 全量投影（共享根 AGENTS.md）/ MCP 管理键落盘 / 幂等跳写 /
 * soft（pi settings）失败仅 warning 且不写该 target 的 sync-meta /
 * 硬项失败 → 逆序回滚（已存在恢复原内容、新建文件删除）+ 失败汇总报告。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermissionError, toExitCode } from '../../../src/core/errors';
import { readEnv } from '../../../src/core/env';
import { currentOs } from '../../../src/core/paths';
import {
  getSyncFailureReport,
  syncOnce,
  type SyncOptions,
} from '../../../src/core/project/engine';
import { syncMetaPath } from '../../../src/core/project/sync-meta';
import { splitByMarkers, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../../../src/core/markers';
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
          if (rest === '') continue;
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
      docs: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
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
