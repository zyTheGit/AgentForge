/**
 * 官方模板源在离线 / CI 下的行为（§12 Phase 2 + §7.8 Offline 降级矩阵）。
 *
 * 关注点只有一个：**默认注册不得把网络拉进主流程**。真实临时目录 + realHost
 * （env 经包装 host 覆盖指向临时 home，AGF_OFFLINE 可按用例注入），并在 host.exec
 * 上挂计数器 —— 只要 `init` / `status` / `doctor` 里出现一次 git 调用，用例就红。
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
import { OFFICIAL_TEMPLATES_SOURCE_ID } from '../../src/core/sources/official';
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
  /** 本次工作区内发生过的 git 调用（参数序列）。 */
  readonly gitCalls: readonly string[][];
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

describe('官方模板源：离线（AGF_OFFLINE=1）下的 init / status / doctor', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await createWorkspace('离线', true);
  });

  afterEach(async () => {
    await rm(path.dirname(ws.root), { recursive: true, force: true });
  });

  it('init：登记官方源（禁用态）并零 git 调用，退出码语义不变', async () => {
    const result = await runInit({ host: ws.host, cwd: ws.root, os: OS });

    expect(result.registeredSources).toEqual([OFFICIAL_TEMPLATES_SOURCE_ID]);
    expect(result.sourcesWarning).toBeNull();
    // 登记表在 **user 层**（§3.1），而本次 init 是 project scope
    expect(await registry(ws)).toMatchObject({
      version: 1,
      sources: [{ id: OFFICIAL_TEMPLATES_SOURCE_ID, type: 'git', enabled: false }],
    });
    expect(ws.gitCalls).toEqual([]);
  }, 30_000);

  it('status：官方源可见且不联网，命令正常返回', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
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
    expect(entry?.hint).toContain(`aforge source enable ${OFFICIAL_TEMPLATES_SOURCE_ID}`);
    expect(report.exitCode).toBe(0);
    expect(ws.gitCalls).toEqual([]);
  }, 30_000);

  it('离线下 enable 只翻位、不联网；doctor 随即变 warn（尚未拉取）但退出码仍 0', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
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

  it('project init 播种后再 init --scope user → 不被"SoT 目录非空"挡住（登记产物不算用户内容）', async () => {
    const ctx = { host: ws.host, cwd: ws.root, os: OS };
    const first = await runInit(ctx);
    expect(first.registeredSources).toEqual([OFFICIAL_TEMPLATES_SOURCE_ID]);
    // 播种把 sources.json 写进了 **user 层** SoT 根，而它此时还没 init 过
    expect(await registry(ws)).not.toBeNull();

    const second = await runInit(ctx, { scope: 'user' });
    expect(second.scope).toBe('user');
    expect(second.sotRoot).toBe(ws.userSoTRoot);
    // 登记表原样留着（user init 不覆盖它，也不再播种）
    expect(second.registeredSources).toEqual([]);
    expect(await registry(ws)).toMatchObject({
      sources: [{ id: OFFICIAL_TEMPLATES_SOURCE_ID, enabled: false }],
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

  it('remove 官方源后再 init（另一个项目根）→ 不复活', async () => {
    const ctx = { host: ws.host, cwd: ws.root, os: OS };
    await runInit(ctx);
    await runSourceRemove(ctx, OFFICIAL_TEMPLATES_SOURCE_ID);
    expect(await runSourceList(ctx)).toEqual([]);

    // 另一个项目根，共享同一张 user 层登记表
    const other = path.join(path.dirname(ws.root), 'proj2');
    await mkdir(other, { recursive: true });
    const second = await runInit({ host: ws.host, cwd: other, os: OS });

    expect(second.registeredSources).toEqual([]);
    expect(await runSourceList(ctx)).toEqual([]);
    expect(await registry(ws)).toMatchObject({ sources: [] });
  }, 30_000);
});
