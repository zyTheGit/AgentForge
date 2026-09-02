/**
 * `learning.auto_capture: hook` 的会话钩子投影集成测试（§7.4 / §12 Phase 3）：
 *
 * 1. `hook` + 默认四家 target → 只有 codex 落出 `.codex\hooks.json`（内容逐字等于
 *    `codexSessionHooksJson()`），其余三家产出**降级提示**而非静默失效；
 * 2. 降级提示走 `sessionHookNotices`，**不进 `warnings`**——warnings 里出现某个
 *    target 会让 `writeSyncMetaOnSuccess` 判定"该 target 投影不完整"而整轮不记账，
 *    §7.6 的 prune 从此清不掉它的产物（这条断言就是那道回归护栏）；
 * 3. 改回 `off` → 下一轮 sync 把钩子文件整个 prune 掉（独占文件 + `write` 动作
 *    直接落进 artifacts 记账，不需要任何专用清理路径）；
 * 4. 但**手工改过的那份不静默吞**：内容与记账不一致 → 进 `pruneSkipped` 并保留文件
 *    （§7.6 硬约束 2，也是 docs/learning.md 对这一档的核心安全承诺）；
 * 5. `--dry-run` 能看到钩子写入项，且磁盘上不产生任何文件。
 *
 * **不真的注册钩子、也不执行任何外部命令**：钩子文件只是数据，本测试只读它的内容；
 * `aforge learn --print-protocol` 的行为由 `tests/unit/learning/hook-capture.spec.ts`
 * 与 `learn` 的命令层单测覆盖。
 *
 * 用真实临时目录 + realHost（env 经包装 host 指向临时 home；mkdtemp 前缀含中文与
 * 空格，天然覆盖 §11.2.10 的路径形态）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runInit, runSync } from '../../src/commands/lifecycle';
import { codexSessionHooksJson } from '../../src/core/learning/hook-capture';
import { currentOs } from '../../src/core/paths';
import { SESSION_HOOK_NOTICE_ITEM } from '../../src/core/project/sync-notices';
import type { Host } from '../../src/infra/host';
import { realHost } from '../../src/infra/real-host';
import type { AutoCapture } from '../../src/schema';

const OS = currentOs();
const VERSION = 'test-0.1.0';
/** 声明了 hook 但没有钩子落点的三家（§7.4 支持矩阵）。 */
const UNSUPPORTED = ['opencode', 'claude', 'pi'];

interface Workspace {
  readonly root: string;
  readonly host: Host;
  readonly sotRoot: string;
  readonly hooksJson: string;
}

async function createWorkspace(): Promise<Workspace> {
  const base = await mkdtemp(path.join(tmpdir(), 'aforge-集成 hook-capture-'));
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

  return {
    root,
    host,
    sotRoot: path.join(root, '.agentforge'),
    hooksJson: path.join(root, '.codex', 'hooks.json'),
  };
}

describe('会话钩子投影（§7.4 hook 档 / §12 Phase 3）', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await createWorkspace();
  });

  afterEach(async () => {
    await rm(path.dirname(ws.root), { recursive: true, force: true });
  });

  function ctx() {
    return { host: ws.host, cwd: ws.root, os: OS };
  }

  /** 改写 SoT profile.yaml 的 learning.auto_capture。 */
  async function setAutoCapture(value: AutoCapture): Promise<void> {
    const file = path.join(ws.sotRoot, 'profile.yaml');
    const profile = parseYaml(await readFile(file, 'utf8')) as {
      learning?: Record<string, unknown>;
    };
    profile.learning = { ...profile.learning, auto_capture: value };
    await writeFile(file, stringifyYaml(profile), 'utf8');
  }

  async function exists(file: string): Promise<boolean> {
    return ws.host.exists(file);
  }

  it('hook → codex 落出 .codex\\hooks.json（内容逐字等于声明的钩子 JSON）', async () => {
    await runInit(ctx());
    await setAutoCapture('hook');
    const result = await runSync({ ...ctx(), agentforgeVersion: VERSION });

    expect(await readFile(ws.hooksJson, 'utf8')).toBe(codexSessionHooksJson());
    // 该项进了 codex 的写入清单（→ 落进 §7.6 的 artifacts 记账）
    const codex = result.targets.find((t) => t.targetId === 'codex');
    expect(codex?.items.some((item) => item.path === ws.hooksJson && item.action === 'write')).toBe(
      true,
    );
    // 产物里没有本机路径：换台机器 sync 出的钩子文件逐字相同
    const content = await readFile(ws.hooksJson, 'utf8');
    expect(content).not.toContain(ws.root);
    expect(content).not.toContain(process.execPath);
  }, 60_000);

  it('hook → 其余三家显式降级：sessionHookNotices 各一条，且不混进 warnings', async () => {
    await runInit(ctx());
    await setAutoCapture('hook');
    const result = await runSync({ ...ctx(), agentforgeVersion: VERSION });

    expect([...result.sessionHookNotices].map((n) => n.targetId).sort()).toEqual(
      [...UNSUPPORTED].sort(),
    );
    for (const notice of result.sessionHookNotices) {
      expect(notice.item).toBe(SESSION_HOOK_NOTICE_ITEM);
      expect(notice.message).toContain(notice.targetId);
    }
    // 关键回归：降级不是 warning——否则这些 target 本轮 artifacts 不记账，prune 永久失效
    for (const id of UNSUPPORTED) {
      expect(result.warnings.some((w) => w.targetId === id)).toBe(false);
    }
    // codex 支持钩子，不该被提示
    expect(result.sessionHookNotices.some((n) => n.targetId === 'codex')).toBe(false);
    // 三家其余产物照常投影（降级只针对钩子这一项）
    for (const id of UNSUPPORTED) {
      expect(result.targets.find((t) => t.targetId === id)?.items.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it('off / prompt 档：不产出钩子文件，也没有降级提示', async () => {
    await runInit(ctx());
    for (const tier of ['off', 'prompt'] as const) {
      await setAutoCapture(tier);
      const result = await runSync({ ...ctx(), agentforgeVersion: VERSION });
      expect(await exists(ws.hooksJson)).toBe(false);
      expect(result.sessionHookNotices).toEqual([]);
    }
  }, 60_000);

  it('hook → off：下一轮 sync 把钩子文件 prune 掉（§7.6 差集清理）', async () => {
    await runInit(ctx());
    await setAutoCapture('hook');
    await runSync({ ...ctx(), agentforgeVersion: VERSION });
    expect(await exists(ws.hooksJson)).toBe(true);

    await setAutoCapture('off');
    const result = await runSync({ ...ctx(), agentforgeVersion: VERSION });

    expect(await exists(ws.hooksJson)).toBe(false);
    expect(result.pruned.some((entry) => entry.path === ws.hooksJson)).toBe(true);
    // 不是"改过的不删"那条分支：文件未被手工改动，应当干净删除
    expect(result.pruneSkipped.some((entry) => entry.path === ws.hooksJson)).toBe(false);
    // 降级提示随档位一起消失
    expect(result.sessionHookNotices).toEqual([]);
  }, 60_000);

  it('hook → 手工改过 hooks.json → 改回 off：不静默吞掉，进 pruneSkipped 并保留文件', async () => {
    await runInit(ctx());
    await setAutoCapture('hook');
    await runSync({ ...ctx(), agentforgeVersion: VERSION });

    // 用户手工编辑了这份钩子文件（改了状态提示、加了自己的一条钩子……形态不重要）
    const edited = codexSessionHooksJson().replace('AgentForge:', 'AgentForge (edited):');
    await writeFile(ws.hooksJson, edited, 'utf8');

    await setAutoCapture('off');
    const result = await runSync({ ...ctx(), agentforgeVersion: VERSION });

    // §7.6 硬约束 2「改过的不删」：宁可残留也不静默吞（docs/learning.md 的核心承诺）
    expect(await readFile(ws.hooksJson, 'utf8')).toBe(edited);
    expect(result.pruned.some((entry) => entry.path === ws.hooksJson)).toBe(false);
    const skip = result.pruneSkipped.find((entry) => entry.path === ws.hooksJson);
    expect(skip?.kind).toBe('artifact');
    expect(skip?.reason).toContain('疑似手工修改');
  }, 60_000);

  it('--dry-run：能看到钩子写入项与降级提示，磁盘上什么都不产生', async () => {
    await runInit(ctx());
    await setAutoCapture('hook');
    const result = await runSync({ ...ctx(), agentforgeVersion: VERSION }, { dryRun: true });

    expect(result.dryRun).toBe(true);
    const codex = result.targets.find((t) => t.targetId === 'codex');
    expect(codex?.items.some((item) => item.path === ws.hooksJson)).toBe(true);
    // dry-run 与实际写入共用同一份提示判定
    expect([...result.sessionHookNotices].map((n) => n.targetId).sort()).toEqual(
      [...UNSUPPORTED].sort(),
    );
    expect(await exists(ws.hooksJson)).toBe(false);
  }, 60_000);
});
