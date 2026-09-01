/**
 * learnings 子命令 `--json` 契约（Spec §6.2）与 `edit` 的编辑器流程。
 *
 * `list` 早已支持 `--json`，`show|edit|rm` 是本轮补齐的三个。这三个 action 走
 * defaultCommandContext（realHost + process.cwd），故用真实临时目录 + AGF_HOME
 * 指向临时 user SoT；条目只放 user 层（project 层 = cwd\.agentforge 不命中，
 * findOne 回落 user 层，故无需 chdir）。
 *
 * `edit` 的编辑器流程（#33）不走 commander：它要注入 fake host（内存 fs +
 * 记账的 spawnInteractive）与 fake TtyProbe，故直接调 runLearningsEdit。
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { registerLearningsCommand } from '../../src/commands/knowledge';
import {
  formatLearningsEdit,
  type LearningsEditContext,
  runLearningsEdit,
} from '../../src/commands/knowledge/learnings';
import { ConfigError } from '../../src/core/errors';
import { learningFilePath } from '../../src/core/learning/store';
import { createUi } from '../../src/infra/ui';
import { abs, createFakeHost, type FakeHost } from './test-utils';

const ID = 'l20260826010203-abc123';

let userSoT = '';
let base = '';
let learningFile = '';
let savedAgfHome: string | undefined;
let savedEditor: string | undefined;

/** §4.3 必填字段齐全的条目（category/confidence 等；scope 与所在层一致）。 */
const LEARNING = {
  id: ID,
  scope: 'user',
  confidence: 0.9,
  trigger: 'pnpm',
  content: '包管理器统一使用 pnpm。',
  category: 'tooling',
  source: 'test',
  created_at: '2026-08-26T01:02:03.000Z',
  updated_at: '2026-08-26T01:02:03.000Z',
  promoted: false,
  promoted_at: null,
  promote_target: 'custom_rule',
} as const;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'aforge-learnings-json-'));
  userSoT = path.join(base, '.agentforge');
  learningFile = learningFilePath(userSoT, ID);
  await mkdir(path.dirname(learningFile), { recursive: true });
  await writeFile(learningFile, stringifyYaml(LEARNING, { lineWidth: 0 }), 'utf8');
  savedAgfHome = process.env.AGF_HOME;
  savedEditor = process.env.EDITOR;
  process.env.AGF_HOME = userSoT;
  process.env.EDITOR = 'code';
});

afterEach(async () => {
  process.env.AGF_HOME = savedAgfHome;
  process.env.EDITOR = savedEditor;
  if (savedAgfHome === undefined) {
    delete process.env.AGF_HOME;
  }
  if (savedEditor === undefined) {
    delete process.env.EDITOR;
  }
  await rm(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 注册 learnings 命令并跑一次，返回 console.log 的单次输出解析结果。 */
async function runJson(argv: readonly string[]): Promise<unknown> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
    logs.push(String(line));
  });
  const program = new Command();
  program.exitOverride();
  registerLearningsCommand(program);
  await program.parseAsync([...argv], { from: 'user' });
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0] ?? '');
}

describe('learnings show|edit|rm --json（Spec §6.2）', () => {
  it('show --json：条目字段 + scope + file + content（YAML 原文）+ quality（读时派生量）', async () => {
    const raw = await readFile(learningFile, 'utf8');
    const json = (await runJson(['learnings', 'show', ID, '--json'])) as Record<string, unknown>;
    const { quality, ...entry } = json;

    expect(entry).toEqual({
      ...LEARNING,
      scope: 'user',
      file: learningFile,
      content: raw,
    });

    // quality 恒不落盘（core/learning/scoring 的架构约束）：base 来自条目，
    // effective / ageDays / breakdown 都是按 host.now() 现算的。这里只断言不随
    // 真实时钟变化的部分，避免用例随日期推移变红。
    const q = quality as Record<string, unknown>;
    expect(q.confidenceBase).toBe(0.9);
    // 该 fixture 是"自动打分上线前"的老条目：没有 confidence_source
    expect(q.confidenceSource).toBeNull();
    expect(typeof q.ageDays).toBe('number');
    expect(q.confidenceEffective as number).toBeLessThanOrEqual(0.9);
    expect((q.heuristic as { signals: unknown[] }).signals).toHaveLength(6);
  });

  it('edit --json：另带 editor（EDITOR 环境变量）与 content，不打印人类提示', async () => {
    const raw = await readFile(learningFile, 'utf8');
    expect(await runJson(['learnings', 'edit', ID, '--json'])).toEqual({
      ...LEARNING,
      scope: 'user',
      file: learningFile,
      editor: 'code',
      content: raw,
    });
  });

  it('rm --json：{ id, file, scope } 且文件确实被删除', async () => {
    expect(await runJson(['learnings', 'rm', ID, '--json'])).toEqual({
      id: ID,
      file: learningFile,
      scope: 'user',
    });
    expect(existsSync(learningFile)).toBe(false);
  });

  it('全局前置 --json 等价（aforge --json learnings show <id>）', async () => {
    const program = new Command();
    program.exitOverride().option('--json', 'machine-readable output');
    registerLearningsCommand(program);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });
    await program.parseAsync(['--json', 'learnings', 'show', ID], { from: 'user' });
    expect((JSON.parse(logs[0] ?? '') as { id: string }).id).toBe(ID);
  });
});

// ---------------------------------------------------------------------------
// edit 的编辑器流程（#33）：fake host + fake TtyProbe，不起真进程
// ---------------------------------------------------------------------------

const WIN32 = process.platform === 'win32';
/** PATH 上的编辑器目录与其绝对路径（win32 候选名由 PATHEXT 展开，故带 .EXE）。 */
const EDITOR_DIR = abs('tools', 'bin');
const EDITOR_ABS = path.join(EDITOR_DIR, WIN32 ? 'code.EXE' : 'code');

interface EditFixtureOptions {
  /** TTY 探测结果（false = CI / 管道）。 */
  readonly interactive: boolean;
  /** 「用户在编辑器里做的事」：spawnInteractive 返回前执行。 */
  readonly onEdit?: (host: FakeHost, file: string) => void;
}

/** 装配 edit 用的注入上下文：内存条目 + PATH 上的 code + 可控 TTY。 */
function editFixture(options: EditFixtureOptions): {
  ctx: LearningsEditContext;
  host: FakeHost;
  file: string;
} {
  const sotRoot = abs('agf-home');
  const base = createFakeHost({
    AGF_HOME: sotRoot,
    EDITOR: 'code',
    PATH: EDITOR_DIR,
    PATHEXT: '.EXE',
  });
  const file = learningFilePath(sotRoot, ID);
  base.files.set(file, stringifyYaml(LEARNING, { lineWidth: 0 }));
  base.files.set(EDITOR_ABS, 'binary');

  const host: FakeHost = {
    ...base,
    async spawnInteractive(cmd, args, opts) {
      const code = await base.spawnInteractive(cmd, args, opts);
      options.onEdit?.(base, file);
      return code;
    },
  };
  const ctx: LearningsEditContext = {
    host,
    cwd: abs('proj'),
    os: { platform: process.platform as 'win32' | 'darwin' | 'linux' },
    tty: { isInteractive: () => options.interactive },
  };
  return { ctx, host, file };
}

describe('learnings edit 拉起 $EDITOR（#33）', () => {
  it('TTY：spawn 的是 PATH 上解析出的编辑器绝对路径 + 条目文件路径', async () => {
    const { ctx, host, file } = editFixture({ interactive: true });
    const result = await runLearningsEdit(ctx, ID);
    expect(host.spawnInteractiveCalls).toEqual([{ cmd: EDITOR_ABS, args: [file], cwd: undefined }]);
    expect(result.outcome).toBe('valid');
    expect(result.editorPath).toBe(EDITOR_ABS);
  });

  it('非 TTY：不 spawn，退回打印文件路径 + 正文（不抛错）', async () => {
    const { ctx, host, file } = editFixture({ interactive: false });
    const result = await runLearningsEdit(ctx, ID);
    expect(host.spawnInteractiveCalls).toEqual([]);
    expect(result.outcome).toBe('printed');
    expect(result.fallback).toBe('not-tty');
    expect(result.content).toBe(host.files.get(file));
  });

  it('编辑后内容非法 → ConfigError(2)', async () => {
    const { ctx } = editFixture({
      interactive: true,
      onEdit: (host, file) => {
        host.files.set(file, 'confidence: 高\n');
      },
    });
    const err = await runLearningsEdit(ctx, ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe(2);
  });

  it('编辑后文件被删 → 不抛错，提示文件已删除', async () => {
    const { ctx, host } = editFixture({
      interactive: true,
      onEdit: (base, file) => {
        base.files.delete(file);
      },
    });
    const result = await runLearningsEdit(ctx, ID);
    expect(result.outcome).toBe('deleted');
    expect(host.spawnInteractiveCalls).toHaveLength(1);
    expect(
      formatLearningsEdit(result, createUi({ color: false, unicode: false, columns: 80 })),
    ).toContain('learning file deleted');
  });
});
