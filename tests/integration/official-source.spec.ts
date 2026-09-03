/**
 * 官方模板源在离线 / CI 下的行为（§12 Phase 2 + §7.8 Offline 降级矩阵）。
 *
 * 关注点只有一个：**官方源不得把网络拉进主流程**。真实临时目录 + realHost
 * （env 经包装 host 覆盖指向临时 home，AGF_OFFLINE 可按用例注入），并在 host.exec
 * 上挂计数器 —— 只要 `init` / `status` / `doctor` 里出现一次 git 调用，用例就红。
 *
 * `init` 已**不再播种**该源（Spec §4.6）：登记表只在用户显式 `source enable` 时出现，
 * 所以需要"已登记"前置的用例一律自己造（enable 或写一张夹具登记表），而不是靠 init。
 *
 * 为什么用真 host 而不是 fake：这三条命令都要走锁目录、原子写、目录遍历，
 * 单测里的内存 fs 覆盖不到"离线环境下真跑一遍不会挂"这件事本身。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSetSourceEnabled, runSourceList, runSourceRemove } from '../../src/commands/assets';
import { runDoctor, runInit, runStatus } from '../../src/commands/lifecycle';
import { currentOs } from '../../src/core/paths';
import {
  DEFAULT_SOURCES,
  defaultSourceEntry,
  OFFICIAL_TEMPLATES_SOURCE_ID,
} from '../../src/core/sources/official';
import type { ExecOptions, Host } from '../../src/infra/host';
import { realHost } from '../../src/infra/real-host';

const OS = currentOs();

/** 命令是否为 git（裸名 / PATH 绝对路径 + Windows 后缀都算，同 unit helper）。 */
function isGitCommand(cmd: string): boolean {
  const base = path.win32.basename(cmd).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com)$/, '') === 'git';
}

interface Workspace {
  readonly root: string;
  readonly host: Host;
  readonly sotRoot: string;
  readonly userSoTRoot: string;
  readonly sourcesFile: string;
  /**
   * 本次工作区内发生过的 git 调用（参数序列）。
   *
   * 元素数组本身可变：用例之间靠 `ws.gitCalls.length = 0` 清零「init 阶段的调用」，
   * 只断言被测命令自己有没有联网。原先声明成 `readonly string[][]`，与这个用法
   * 冲突（tests 进 tsc 后报 TS2540：length 只读）。
   */
  readonly gitCalls: string[][];
}

/** mkdtemp 前缀含中文与空格：§11.2.10 全流程覆盖（同其余集成用例）。 */
async function createWorkspace(label: string, offline: boolean): Promise<Workspace> {
  const base = await mkdtemp(path.join(tmpdir(), `aforge-官方源 ${label}-`));
  const root = path.join(base, 'proj');
  const home = path.join(base, 'home');
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });

  const overrides: Record<string, string | undefined> = {
    USERPROFILE: home,
    HOME: home,
    AGF_HOME: undefined,
    AGF_SCOPE: undefined,
    AGF_LINE_ENDING: undefined,
    AGF_OFFLINE: offline ? '1' : undefined,
    CI: undefined,
    CODEX_HOME: undefined,
  };
  const gitCalls: string[][] = [];
  const host: Host = {
    ...realHost,
    env(key) {
      return key in overrides ? overrides[key] : realHost.env(key);
    },
    async exec(cmd: string, args: readonly string[], opts?: ExecOptions) {
      if (isGitCommand(cmd)) {
        gitCalls.push([...args]);
      }
      return realHost.exec(cmd, args, opts);
    },
  };

  const userSoTRoot = path.join(home, '.agentforge');
  return {
    root,
    host,
    sotRoot: path.join(root, '.agentforge'),
    userSoTRoot,
    sourcesFile: path.join(userSoTRoot, 'sources.json'),
    gitCalls,
  };
}

/** 登记表内容（未创建 → null）。 */
async function registry(ws: Workspace): Promise<{ version: number; sources: unknown[] } | null> {
  try {
    return JSON.parse(await readFile(ws.sourcesFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 夹具：写一张「官方源已登记、禁用」的 user 层登记表（老 SoT 的存量形态）。
 *
 * `init` 不再播种（Spec §4.6）后这个状态没有命令能一步造出来：`source enable` 会把
 * `enabled` 翻成 true，测不到"登记了但禁用"这一态，而 status 可见性与 doctor 的
 * 「已登记、当前禁用」分支正是要在这一态上验证。条目走 defaultSourceEntry 而不是
 * 手写 url/ref，免得夹具的 pin 与内置声明不一致，让 doctor 多打一句"本机改写优先"。
 */
async function seedDisabledRegistry(ws: Workspace): Promise<void> {
  await mkdir(ws.userSoTRoot, { recursive: true });
  const sources = DEFAULT_SOURCES.map((decl) => defaultSourceEntry(decl, false));
  await writeFile(ws.sourcesFile, `${JSON.stringify({ version: 1, sources }, null, 2)}\n`, 'utf8');
}

describe('官方模板源：离线（AGF_OFFLINE=1）下的 init / status / doctor', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await createWorkspace('离线', true);
  });

  afterEach(async () => {
    await rm(path.dirname(ws.root), { recursive: true, force: true });
  });

  it('init 不再播种官方源：user 层 sources.json 不被创建，且零 git 调用', async () => {
    const result = await runInit({ host: ws.host, cwd: ws.root, os: OS });

    // Spec §4.6：init 不写登记表。这里断言"文件根本没被创建"而不是"里面没有 official"，
    // 因为播种的具体代价就是往每台机器的 user 层落一张带硬编码 pin 的表。
    expect(await registry(ws)).toBeNull();
    // 退出码语义不变：project scope 正常初始化，命令返回而不是抛错
    expect(result.scope).toBe('project');
    expect(result.sotRoot).toBe(ws.sotRoot);
    expect(ws.gitCalls).toEqual([]);
  }, 30_000);

  it('status：已登记的官方源可见且不联网，命令正常返回', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    await seedDisabledRegistry(ws);
    ws.gitCalls.length = 0;

    const status = await runStatus({ host: ws.host, cwd: ws.root, os: OS });
    const official = status.sources.find((s) => s.id === OFFICIAL_TEMPLATES_SOURCE_ID);
    expect(official).toMatchObject({ enabled: false, materialized: false, official: true });
    expect(official?.ref).not.toBeNull();
    expect(ws.gitCalls).toEqual([]);
  }, 30_000);

  it('doctor：官方源那条是 ok（不是 error）、退出码 0、零 git 调用', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    ws.gitCalls.length = 0;

    const report = await runDoctor({ host: ws.host, cwd: ws.root, os: OS });
    const entry = report.results.find(
      (r) => r.item === `sources/default/${OFFICIAL_TEMPLATES_SOURCE_ID}`,
    );
    expect(entry?.level).toBe('ok');
    // init 不播种 → 常规态就是"未登记"，报告要说清这是决议裁剪而非配置出错
    expect(entry?.detail).toContain('未登记（init 不再播种该源');
    expect(entry?.hint).toContain(`aforge source enable ${OFFICIAL_TEMPLATES_SOURCE_ID}`);
    expect(report.exitCode).toBe(0);
    expect(ws.gitCalls).toEqual([]);
  }, 30_000);

  it('离线下 enable 只翻位、不联网；doctor 随即变 warn（尚未拉取）但退出码仍 0', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    // 已登记（禁用）→ enable 走"翻位"那一支（registered:false），而不是补登记
    await seedDisabledRegistry(ws);
    ws.gitCalls.length = 0;

    const ctx = { host: ws.host, cwd: ws.root, os: OS };
    const enabled = await runSetSourceEnabled(ctx, OFFICIAL_TEMPLATES_SOURCE_ID, true);
    expect(enabled).toMatchObject({ changed: true, registered: false });
    expect(ws.gitCalls).toEqual([]);

    const report = await runDoctor(ctx);
    const entry = report.results.find(
      (r) => r.item === `sources/default/${OFFICIAL_TEMPLATES_SOURCE_ID}`,
    );
    expect(entry?.level).toBe('warn');
    expect(entry?.detail).toContain('尚未拉取');
    expect(report.exitCode).toBe(0);
    expect(ws.gitCalls).toEqual([]);
  }, 30_000);

  it('user 层已有 sources.json 时 init --scope user 不被"SoT 目录非空"挡住（登记产物不算用户内容）', async () => {
    const ctx = { host: ws.host, cwd: ws.root, os: OS };
    await runInit(ctx);
    // 前置不能再靠 init 播种：显式 enable 官方源，它会把 sources.json 落到 **user 层**
    // SoT 根，而那一层此时还没 init 过 —— 正是 NON_CONTENT_ENTRIES 豁免要挡住的场景
    const enabled = await runSetSourceEnabled(ctx, OFFICIAL_TEMPLATES_SOURCE_ID, true);
    expect(enabled.registered).toBe(true);
    expect(await registry(ws)).not.toBeNull();

    const second = await runInit(ctx, { scope: 'user' });
    expect(second.scope).toBe('user');
    expect(second.sotRoot).toBe(ws.userSoTRoot);
    // 登记表原样留着（user init 既不覆盖它，也不改 enabled 位）
    expect(await registry(ws)).toMatchObject({
      sources: [{ id: OFFICIAL_TEMPLATES_SOURCE_ID, enabled: true }],
    });
    expect(await readFile(path.join(ws.userSoTRoot, 'profile.yaml'), 'utf8')).toContain('user');
    expect(ws.gitCalls).toEqual([]);
  }, 30_000);

  it('user 层 SoT 里有真正的用户内容 → init --scope user 仍以 ConfigError(2) 拒写', async () => {
    await mkdir(ws.userSoTRoot, { recursive: true });
    await writeFile(path.join(ws.userSoTRoot, '手工放的.md'), '用户内容\n', 'utf8');

    await expect(
      runInit({ host: ws.host, cwd: ws.root, os: OS }, { scope: 'user' }),
    ).rejects.toMatchObject({ code: 2 });
  }, 30_000);

  it('enable → remove → 再 init（另一个项目根）：init 不会把它加回来', async () => {
    const ctx = { host: ws.host, cwd: ws.root, os: OS };
    await runInit(ctx);
    await runSetSourceEnabled(ctx, OFFICIAL_TEMPLATES_SOURCE_ID, true);
    await runSourceRemove(ctx, OFFICIAL_TEMPLATES_SOURCE_ID);
    expect(await runSourceList(ctx)).toEqual([]);

    // 另一个项目根，共享同一张 user 层登记表：init 既不播种也不"修复"缺失的默认项
    const other = path.join(path.dirname(ws.root), 'proj2');
    await mkdir(other, { recursive: true });
    await runInit({ host: ws.host, cwd: other, os: OS });

    expect(await runSourceList(ctx)).toEqual([]);
    expect(await registry(ws)).toMatchObject({ sources: [] });
  }, 30_000);
});
