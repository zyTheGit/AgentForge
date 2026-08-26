/**
 * learnings 子命令 `--json` 契约（Spec §6.2）。
 *
 * `list` 早已支持 `--json`，`show|edit|rm` 是本轮补齐的三个。这三个 action 走
 * defaultCommandContext（realHost + process.cwd），故用真实临时目录 + AGF_HOME
 * 指向临时 user SoT；条目只放 user 层（project 层 = cwd\.agentforge 不命中，
 * findOne 回落 user 层，故无需 chdir）。
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { registerLearningsCommand } from '../../src/commands/learnings';
import { learningFilePath } from '../../src/core/learning/store';

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
  it('show --json：条目字段 + scope + file + content（YAML 原文）', async () => {
    const raw = await readFile(learningFile, 'utf8');
    expect(await runJson(['learnings', 'show', ID, '--json'])).toEqual({
      ...LEARNING,
      scope: 'user',
      file: learningFile,
      content: raw,
    });
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
