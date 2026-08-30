/**
 * `learning.auto_capture: prompt` 的投影集成测试（验收 §11.2-15）：
 *
 * 1. `prompt` → 投影正文 marker 区间内出现 `## Learning Protocol` 段，且位置固定
 *    在 custom 规则（§5.2 第 ① 层）之后、`## Learnings`（第 ② 层）之前；
 * 2. 改回 `off` → 该段从投影中消失，custom / Learnings 内容与 **marker 外**手写
 *    内容都不受影响；
 * 3. 声明 `hook`（MVP 未实现）→ 与 `off` 同，不渲染该段。
 *
 * 为什么要在集成层再来一遍：段落内容与渲染判据的单测在
 * `tests/unit/learning/auto-capture.spec.ts` 与 `tests/unit/generate/composer.spec.ts`，
 * 但「真投影文件里出现/消失、且不碰 marker 外」跨了 composer → projector → writer
 * 三层，只有端到端跑一次 sync 才算验收。
 *
 * 用真实临时目录 + realHost（env 经包装 host 指向临时 home；mkdtemp 前缀含中文与
 * 空格，天然覆盖 §11.2.10）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { runInit } from '../../src/commands/init';
import { runLearn } from '../../src/commands/learn';
import { runPromote } from '../../src/commands/promote';
import { runSync } from '../../src/commands/sync';
import {
  LEARNING_PROTOCOL_HEADING,
  LEARNING_PROTOCOL_SECTION,
} from '../../src/core/learning/auto-capture';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END, splitByMarkers } from '../../src/core/markers';
import { currentOs } from '../../src/core/paths';
import type { Host } from '../../src/infra/host';
import { realHost } from '../../src/infra/real-host';
import type { AutoCapture } from '../../src/schema';

const OS = currentOs();
const VERSION = 'test-0.1.0';
const CUSTOM_RULE = '提交信息使用中文，首行不超过 50 字。';
const LEARNING_CONTENT = '包管理器统一使用 pnpm，禁止 npm install 直装依赖。';
/** marker 外的手写正文：sync 不得改动它（§8.2）。 */
const OUTSIDE_NOTE = '<!-- 我自己写的，sync 不许动 -->';

interface Workspace {
  readonly root: string;
  readonly host: Host;
  readonly sotRoot: string;
  readonly claudeMd: string;
  readonly agentsMd: string;
}

async function createWorkspace(): Promise<Workspace> {
  const base = await mkdtemp(path.join(tmpdir(), 'aforge-集成 learning-protocol-'));
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
    claudeMd: path.join(root, 'CLAUDE.md'),
    agentsMd: path.join(root, 'AGENTS.md'),
  };
}

describe('Learning Protocol 段投影（§7.4 prompt 档 / 验收 §11.2-15）', () => {
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

  /** init + 一条 custom 规则（第 ① 层）+ 一条已 promote 的 learning（第 ② 层）。 */
  async function seed(): Promise<void> {
    await runInit(ctx());
    await writeFile(path.join(ws.sotRoot, 'custom', 'commit.md'), `${CUSTOM_RULE}\n`, 'utf8');
    await writeFile(path.join(ws.root, 'notes.md'), `${LEARNING_CONTENT}\n`, 'utf8');
    await runLearn(ctx(), { file: 'notes.md', id: 'pnpm-only', category: 'tooling' });
    await runPromote(ctx(), 'pnpm-only');
  }

  /** 投影文件的 marker 区间正文（marker 必须存在）。 */
  async function inside(file: string): Promise<string> {
    const split = splitByMarkers(
      await readFile(file, 'utf8'),
      DEFAULT_MARKER_BEGIN,
      DEFAULT_MARKER_END,
    );
    expect(split.hasMarkers).toBe(true);
    return split.inside;
  }

  it('prompt → marker 区间含完整 Learning Protocol 段，位置固定在 custom 之后、Learnings 之前', async () => {
    await seed();
    await setAutoCapture('prompt');
    await runSync({ ...ctx(), agentforgeVersion: VERSION });

    for (const file of [ws.claudeMd, ws.agentsMd]) {
      const text = await inside(file);
      // 段落逐字落地（标题 + 正文），不是只有标题
      expect(text).toContain(LEARNING_PROTOCOL_SECTION);
      // §5.2 顺序：① custom → ①' Learning Protocol → ② Learnings
      const custom = text.indexOf(CUSTOM_RULE);
      const protocol = text.indexOf(LEARNING_PROTOCOL_HEADING);
      const learnings = text.indexOf('## Learnings');
      expect(custom).toBeGreaterThanOrEqual(0);
      expect(protocol).toBeGreaterThan(custom);
      expect(learnings).toBeGreaterThan(protocol);
    }
  }, 60_000);

  it('改回 off → 段落消失，custom / Learnings 与 marker 外手写内容都不受影响', async () => {
    await seed();
    await setAutoCapture('prompt');
    await runSync({ ...ctx(), agentforgeVersion: VERSION });

    // marker 外追加手写内容（§8.2 只替换区间内，区间外恒保留）
    for (const file of [ws.claudeMd, ws.agentsMd]) {
      await writeFile(file, `${await readFile(file, 'utf8')}\n${OUTSIDE_NOTE}\n`, 'utf8');
    }

    await setAutoCapture('off');
    await runSync({ ...ctx(), agentforgeVersion: VERSION });

    for (const file of [ws.claudeMd, ws.agentsMd]) {
      const whole = await readFile(file, 'utf8');
      expect(whole).toContain(OUTSIDE_NOTE);

      const text = await inside(file);
      expect(text).not.toContain(LEARNING_PROTOCOL_HEADING);
      // 其余层不受影响：custom 规则与已晋升 learning 仍在
      expect(text).toContain(CUSTOM_RULE);
      expect(text).toContain(LEARNING_CONTENT);
    }
  }, 60_000);

  it('声明 hook（MVP 未实现）→ 等同 off，不渲染该段', async () => {
    await seed();
    await setAutoCapture('hook');
    await runSync({ ...ctx(), agentforgeVersion: VERSION });

    for (const file of [ws.claudeMd, ws.agentsMd]) {
      expect(await inside(file)).not.toContain(LEARNING_PROTOCOL_HEADING);
    }
  }, 60_000);
});
