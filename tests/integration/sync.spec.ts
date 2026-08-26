/**
 * sync 集成测试（Spec §7.1 init / §7.3 sync / §8.2 marker 外保留 / §8.5 claude
 * 投影 / §3.3 sync-meta / §2.5 换行 / §11.2.10 中文与空格路径 / §6.1 退出码）。
 *
 * 两层策略：
 * 1) 进程内：真实临时目录 + realHost（env 经包装 host 覆盖指向临时 home，
 *    与真实 ~/.agentforge 完全隔离；mkdtemp 前缀含中文与空格，全部用例天然
 *    覆盖 §11.2.10）；
 * 2) 子进程：node --import tsx main.ts 端到端（init && sync / 退出码语义 /
 *    POSIX 真实只读目录）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInit, SOT_SUBDIRS } from '../../src/commands/init';
import { runSync } from '../../src/commands/sync';
import { ConfigError, ExitCode, PermissionError, toExitCode } from '../../src/core/errors';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END, splitByMarkers } from '../../src/core/markers';
import { currentOs } from '../../src/core/paths';
import type { Host } from '../../src/infra/host';
import { realHost } from '../../src/infra/real-host';

const OS = currentOs();
const VERSION = 'test-0.1.0';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainTs = path.join(repoRoot, 'src', 'main.ts');
/** tsx loader 的绝对 file URL（子进程 cwd 在临时目录，相对说明符不可解析）。 */
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/** 去除首尾空行的对照基线（wrapWithMarkers 同一规范，避免测试重实现细节）。 */
function stripBlankEdges(s: string): string {
  return s.replace(/^\n+/, '').replace(/\n+$/, '');
}

interface Workspace {
  /** 项目根（project scope 的 SoT 与投影基准）。 */
  readonly root: string;
  /** 临时用户目录（USERPROFILE / HOME 指向，隔离真实 ~/.agentforge）。 */
  readonly home: string;
  /** env 覆盖的 realHost 包装（其余 IO 全真实）。 */
  readonly host: Host;
  readonly claudeMd: string;
  readonly sotRoot: string;
  readonly syncMetaPath: string;
}

/** mkdtemp 前缀含中文与空格：§11.2.10 全流程覆盖。 */
async function createWorkspace(label: string): Promise<Workspace> {
  const base = await mkdtemp(path.join(tmpdir(), `aforge-集成 ${label}-`));
  const root = path.join(base, 'proj');
  const home = path.join(base, 'home');
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });

  // AGF_* 显式置 undefined（用 in 判定屏蔽真实环境变量，防泄漏干扰）
  const overrides: Record<string, string | undefined> = {
    USERPROFILE: home,
    HOME: home,
    AGF_HOME: undefined,
    AGF_SCOPE: undefined,
    AGF_LINE_ENDING: undefined,
    AGF_OFFLINE: undefined,
    CI: undefined,
    CODEX_HOME: undefined,
  };
  const host: Host = {
    ...realHost,
    env(key) {
      return key in overrides ? overrides[key] : realHost.env(key);
    },
  };

  const sotRoot = path.join(root, '.agentforge');
  return {
    root,
    home,
    host,
    claudeMd: path.join(root, 'CLAUDE.md'),
    sotRoot,
    syncMetaPath: path.join(sotRoot, 'sync-meta.json'),
  };
}

async function disposeWorkspace(ws: Workspace): Promise<void> {
  await rm(path.dirname(ws.root), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 进程内：真实临时目录 + realHost
// ---------------------------------------------------------------------------

describe('init → sync 端到端（进程内，真实 fs）', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await createWorkspace('sync');
  });

  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('init 产出完整 SoT 结构：profile/habits + 五个子目录 + detected 快照（§7.1）', async () => {
    const result = await runInit({ host: ws.host, cwd: ws.root, os: OS });

    expect(result.scope).toBe('project');
    expect(result.sotRoot).toBe(ws.sotRoot);
    expect(result.createdFiles).toEqual([
      path.join(ws.sotRoot, 'habits.yaml'),
      path.join(ws.sotRoot, 'profile.yaml'),
    ]);

    for (const file of result.createdFiles) {
      expect(await stat(file)).toBeTruthy();
    }
    for (const dir of SOT_SUBDIRS) {
      const s = await stat(path.join(ws.sotRoot, dir));
      expect(s.isDirectory()).toBe(true);
    }

    const habits = await readFile(path.join(ws.sotRoot, 'habits.yaml'), 'utf8');
    expect(habits).toContain('version: 1');
    expect(habits).toContain('detected:');
    const profile = await readFile(path.join(ws.sotRoot, 'profile.yaml'), 'utf8');
    expect(profile).toContain('version: 1');
  }, 30_000);

  it('init → sync：CLAUDE.md 存在且 marker 区间 = 渲染结果（dry-run content 对照，§7.3/§8.5）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });

    // dry-run 拿到精确的 renderedRulesMd（渲染是纯函数：时间不参与）
    const dry = await runSync(
      { host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION },
      { dryRun: true },
    );
    const rendered = dry.targets[0]?.items[0]?.content as string;
    expect(rendered.length).toBeGreaterThan(0);

    const result = await runSync({
      host: ws.host,
      cwd: ws.root,
      os: OS,
      agentforgeVersion: VERSION,
    });
    expect(result.scope).toBe('project');
    // M6 四 projector 全注册：init 默认四 target 全部同步（§8.7 投影矩阵）
    expect(result.targets.map((t) => t.targetId)).toEqual(['opencode', 'codex', 'claude', 'pi']);
    expect(result.skippedTargets).toEqual([]);

    const claude = await readFile(ws.claudeMd, 'utf8');
    expect(claude).toContain(DEFAULT_MARKER_BEGIN);
    expect(claude).toContain(DEFAULT_MARKER_END);

    const split = splitByMarkers(claude, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END);
    expect(split.hasMarkers).toBe(true);
    expect(stripBlankEdges(split.inside as string)).toBe(stripBlankEdges(rendered));
    // 渲染正文锚点（base/default 首节）
    expect(split.inside).toContain('# AgentForge Rules');
  }, 30_000);

  it('幂等：两次 sync 后 CLAUDE.md 逐字节一致，contentHash 不变（§7.3）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    const ctx = { host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION };

    const first = await runSync(ctx);
    const firstBytes = await readFile(ws.claudeMd);

    const second = await runSync(ctx);
    const secondBytes = await readFile(ws.claudeMd);

    expect(secondBytes.equals(firstBytes)).toBe(true);
    expect(second.contentHash).toBe(first.contentHash);
  }, 30_000);

  it('marker 外用户内容保留（§8.2 replace_between）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    await writeFile(
      ws.claudeMd,
      `# 项目说明\n\n自定义约定：所有代码走 strict 模式。\n\n${DEFAULT_MARKER_BEGIN}\n旧内容\n${DEFAULT_MARKER_END}\n\n尾部备注（sync 后必须保留）\n`,
      'utf8',
    );

    await runSync({ host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION });

    const claude = await readFile(ws.claudeMd, 'utf8');
    expect(claude.startsWith('# 项目说明\n\n')).toBe(true);
    expect(claude).toContain('自定义约定：所有代码走 strict 模式。');
    expect(claude.endsWith('\n\n尾部备注（sync 后必须保留）\n')).toBe(true);
    // 旧 marker 区间被替换为当前渲染结果
    expect(claude).not.toContain('旧内容');
    expect(splitByMarkers(claude, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END).inside).toContain(
      '# AgentForge Rules',
    );
  }, 30_000);

  it('--dry-run 不写任何文件（四 target 全部计划均不落盘），返回将写入的绝对路径', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });

    const result = await runSync(
      { host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION },
      { dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    const claudeTarget = result.targets.find((t) => t.targetId === 'claude');
    expect(claudeTarget?.items[0]?.path).toBe(ws.claudeMd);
    expect(await realHost.exists(ws.claudeMd)).toBe(false);
    expect(await realHost.exists(path.join(ws.root, 'AGENTS.md'))).toBe(false);
    expect(await realHost.exists(path.join(ws.root, 'opencode.json'))).toBe(false);
    expect(await realHost.exists(path.join(ws.root, '.codex', 'config.toml'))).toBe(false);
    expect(await realHost.exists(path.join(ws.root, '.pi', 'settings.json'))).toBe(false);
    expect(await realHost.exists(ws.syncMetaPath)).toBe(false);
  }, 30_000);

  it('sync-meta.json 结构符合 §3.3：version/lastSyncAt/os/agentforgeVersion/targets.claude.*', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    const result = await runSync({
      host: ws.host,
      cwd: ws.root,
      os: OS,
      agentforgeVersion: VERSION,
    });

    const meta = JSON.parse(await readFile(ws.syncMetaPath, 'utf8')) as {
      version: number;
      lastSyncAt: string;
      os: string;
      agentforgeVersion: string;
      targets: Record<string, { contentHash: string; writtenAt: string }>;
    };

    expect(meta.version).toBe(1);
    expect(meta.lastSyncAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(meta.os).toBe(process.platform);
    expect(meta.agentforgeVersion).toBe(VERSION);
    expect(meta.targets.claude.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.targets.claude.contentHash).toBe(result.contentHash);
    expect(meta.targets.claude.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  }, 30_000);

  it('未初始化 → sync 抛 ConfigError(2)，hint 引导 aforge init（§7.3-1）', async () => {
    const err = await runSync({
      host: ws.host,
      cwd: ws.root,
      os: OS,
      agentforgeVersion: VERSION,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe(ExitCode.Config);
    expect((err as ConfigError).hint).toContain('aforge init');
  }, 30_000);

  it('重复 init → ConfigError(2)，hint 提示已初始化（§7.1-1 防误覆盖）', async () => {
    const ctx = { host: ws.host, cwd: ws.root, os: OS };
    await runInit(ctx);
    const err = await runInit(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe(ExitCode.Config);
    expect((err as ConfigError).hint).toContain('已初始化');
  }, 30_000);

  it('AGF_LINE_ENDING=crlf → CLAUDE.md 与 sync-meta.json 全文 CRLF（§2.4/§2.5）', async () => {
    const ws2 = await createWorkspace('crlf');
    try {
      const overrides: Record<string, string | undefined> = {
        AGF_LINE_ENDING: 'crlf',
      };
      const host: Host = {
        ...ws2.host,
        env(key) {
          return key in overrides ? overrides[key] : ws2.host.env(key);
        },
      };
      await runInit({ host, cwd: ws2.root, os: OS });
      await runSync({ host, cwd: ws2.root, os: OS, agentforgeVersion: VERSION });

      const claude = await readFile(ws2.claudeMd, 'utf8');
      expect(claude).toContain('\r\n');
      expect(claude).not.toMatch(/[^\r]\n/);
      const meta = await readFile(ws2.syncMetaPath, 'utf8');
      expect(meta).not.toMatch(/[^\r]\n/);
    } finally {
      await disposeWorkspace(ws2);
    }
  }, 30_000);

  it('写入失败（rename EPERM 注入）→ PermissionError(4)，退出码语义成立（§7.3-7）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    // 预置 CLAUDE.md：走 rename 覆盖分支（atomicWrite 原子替换）
    await writeFile(ws.claudeMd, `${DEFAULT_MARKER_BEGIN}\nold\n${DEFAULT_MARKER_END}\n`, 'utf8');

    const eperm = (): NodeJS.ErrnoException => {
      const e = new Error('injected EPERM: rename blocked') as NodeJS.ErrnoException;
      e.code = 'EPERM';
      return e;
    };
    const denied: Host = {
      ...ws.host,
      async rename() {
        throw eperm();
      },
    };

    const err = await runSync({
      host: denied,
      cwd: ws.root,
      os: OS,
      agentforgeVersion: VERSION,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PermissionError);
    const perm = err as PermissionError;
    expect(perm.code).toBe(ExitCode.Permission);
    expect(toExitCode(perm)).toBe(4);
    // M6：投影顺序 opencode 先于 claude → 首个失败项是共享根 AGENTS.md
    expect(perm.message).toContain('AGENTS.md');
    expect(perm.hint).toBeTruthy();
    // 事务：预置的 CLAUDE.md 在首个写入项失败后保持原样（未被触碰，无需恢复）
    expect(await readFile(ws.claudeMd, 'utf8')).toBe(
      `${DEFAULT_MARKER_BEGIN}\nold\n${DEFAULT_MARKER_END}\n`,
    );
    expect(await realHost.exists(path.join(ws.root, 'AGENTS.md'))).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 子进程端到端：node --import tsx src/main.ts
// ---------------------------------------------------------------------------

describe('aforge init && aforge sync（子进程端到端）', () => {
  let base: string;
  let tmpHome: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'aforge-e2e-'));
    tmpHome = path.join(base, 'home');
    await mkdir(tmpHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** 子进程 env：USERPROFILE/HOME 指向临时 home，清掉全部 AGF_* 变体。 */
  function childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith('AGF_')) {
        delete env[key];
      }
    }
    env.USERPROFILE = tmpHome;
    env.HOME = tmpHome;
    return env;
  }

  function runCli(args: readonly string[], cwd: string) {
    return spawnSync(process.execPath, ['--import', tsxImport, mainTs, ...args], {
      cwd,
      env: childEnv(),
      encoding: 'utf8',
    });
  }

  it('中文+空格目录全流程：init → sync → CLAUDE.md 产出（§11.2.10）', () => {
    const root = path.join(base, '项目 Alpha 专测');
    mkdirSync(root);

    const initResult = runCli(['init'], root);
    expect(initResult.error).toBeUndefined();
    expect(initResult.status).toBe(0);
    expect(initResult.stdout).toContain('created files');
    expect(initResult.stdout).toContain('aforge sync');

    // SoT 结构真实落盘
    const sotRoot = path.join(root, '.agentforge');
    expect(existsSync(path.join(sotRoot, 'profile.yaml'))).toBe(true);
    expect(existsSync(path.join(sotRoot, 'habits.yaml'))).toBe(true);

    const syncResult = runCli(['sync'], root);
    expect(syncResult.error).toBeUndefined();
    expect(syncResult.status).toBe(0);
    expect(syncResult.stdout).toContain('sync complete');
    expect(syncResult.stdout).toContain('CLAUDE.md');
    expect(syncResult.stdout).toContain('sync-meta.json');

    const claude = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain(DEFAULT_MARKER_BEGIN);
    expect(claude).toContain(DEFAULT_MARKER_END);
    expect(claude).toContain('# AgentForge Rules');

    // sync-meta 落盘且含 claude 记录
    const meta = JSON.parse(readFileSync(path.join(sotRoot, 'sync-meta.json'), 'utf8')) as {
      targets: Record<string, unknown>;
    };
    expect(Object.keys(meta.targets)).toContain('claude');
  }, 120_000);

  it('未初始化直接 sync → 退出码 2，stderr 引导 aforge init（§6.1/§7.3-1）', () => {
    const root = path.join(base, 'empty');
    mkdirSync(root);

    const result = runCli(['sync'], root);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('aforge init');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// POSIX：真实只读目录（Windows 上目录只读属性不影响写入，fault-injection 已由进程内用例覆盖）
// ---------------------------------------------------------------------------

const isPosix = process.platform !== 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe.skipIf(!isPosix || isRoot)('真实只读项目目录（POSIX chmod 0555）', () => {
  it('sync → PermissionError → 退出码 4（§7.3-7 / §6.1）', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'aforge-ro-'));
    const root = path.join(base, 'proj');
    const home = path.join(base, 'home');
    await mkdir(root, { recursive: true });
    await mkdir(home, { recursive: true });

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith('AGF_')) {
        delete env[key];
      }
    }
    env.USERPROFILE = home;
    env.HOME = home;

    try {
      const init = spawnSync(process.execPath, ['--import', tsxImport, mainTs, 'init'], {
        cwd: root,
        env,
        encoding: 'utf8',
      });
      expect(init.status).toBe(0);

      await chmod(root, 0o555); // 项目目录去写权限：CLAUDE.md 临时文件创建即失败

      const sync = spawnSync(process.execPath, ['--import', tsxImport, mainTs, 'sync'], {
        cwd: root,
        env,
        encoding: 'utf8',
      });
      expect(sync.status).toBe(4);
      // M6：预校验阶段 mkdirp `.codex` 目录即失败（§7.3-7 目录自动创建）
      expect(sync.stderr).toContain('无法创建目录');
    } finally {
      await chmod(root, 0o755); // 恢复以便清理
      await rm(base, { recursive: true, force: true });
    }
  }, 120_000);
});
