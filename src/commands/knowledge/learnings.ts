/**
 * aforge learnings 命令（Spec §6 命令表：list | show <id> | edit <id> | rm <id>）。
 *
 * - list：两层 SoT 条目汇总；
 * - show：输出条目 YAML 原文；
 * - edit：**简单实现**——读出条目内容与文件绝对路径，提示手动编辑
 *   （$EDITOR / notepad 打开该 yaml；M8 不内嵌编辑器流程）；
 * - rm：删除条目文件（先 show 确认建议由用户自行执行）。
 *
 * 四个子命令都支持 `--json`（§6.2；判定走 resolveJsonFlag，故 `aforge --json
 * learnings show <id>` 与 `aforge learnings show <id> --json` 等价）。JSON 字段
 * 与 list 同风格：条目字段展开 + `scope` + `file`（show/edit 另带正文 `content`）。
 *
 * 条目查找：project 层优先于 user 层（与 promote 同序）。
 */
import path from 'node:path';
import type { Command } from 'commander';
import { readEnv } from '../../core/env';
import {
  learningFilePath,
  listLearnings,
  readLearningFile,
  removeLearning,
} from '../../core/learning/store';
import { resolveProjectSoT, resolveUserSoT } from '../../core/paths';
import { realHost } from '../../infra/real-host';
import type { Learning } from '../../schema';
import { type CommandContext, defaultCommandContext, printJson } from '../_shared/context';
import { resolveJsonFlag } from '../_shared/flags';

/** 命令上下文。 */
export type LearningsCommandContext = CommandContext;

/** list 条目（附所在层与文件路径）。 */
export interface LearningListItem {
  readonly learning: Learning;
  readonly scope: 'user' | 'project';
  readonly file: string;
}

/** 读取两层条目（project 在前；各层内按文件名序）。 */
async function listAll(ctx: LearningsCommandContext): Promise<LearningListItem[]> {
  const env = readEnv(ctx.host);
  const userSoTRoot = resolveUserSoT(env, ctx.os);
  const projectSoTRoot = resolveProjectSoT(ctx.cwd, ctx.os);
  const items: LearningListItem[] = [];
  for (const layer of [
    { scope: 'project' as const, sotRoot: projectSoTRoot },
    { scope: 'user' as const, sotRoot: userSoTRoot },
  ]) {
    for (const learning of await listLearnings({ host: ctx.host, sotRoot: layer.sotRoot })) {
      items.push({
        learning,
        scope: layer.scope,
        file: learningFilePath(layer.sotRoot, learning.id),
      });
    }
  }
  return items;
}

/** 在两层中查找条目（project 优先）。 */
async function findOne(ctx: LearningsCommandContext, id: string): Promise<LearningListItem | null> {
  const env = readEnv(ctx.host);
  const userSoTRoot = resolveUserSoT(env, ctx.os);
  const projectSoTRoot = resolveProjectSoT(ctx.cwd, ctx.os);
  for (const layer of [
    { scope: 'project' as const, sotRoot: projectSoTRoot },
    { scope: 'user' as const, sotRoot: userSoTRoot },
  ]) {
    const file = learningFilePath(layer.sotRoot, id);
    const learning = await readLearningFile(ctx.host, file);
    if (learning !== null) {
      return { learning, scope: layer.scope, file };
    }
  }
  return null;
}

/**
 * 在两层中查找条目，缺失即报错（show / edit / rm 共用同一条错误文案与错误码）。
 *
 * @throws ConfigError(2) id 不存在。
 */
async function requireOne(ctx: LearningsCommandContext, id: string): Promise<LearningListItem> {
  const found = await findOne(ctx, id);
  if (found === null) {
    const { ConfigError } = await import('../../core/errors');
    throw new ConfigError(`learning 不存在: ${id}`, {
      hint: '运行 aforge learnings list 查看全部条目',
      details: { id },
    });
  }
  return found;
}

/** list 核心逻辑（可注入）。 */
export async function runLearningsList(ctx: LearningsCommandContext): Promise<LearningListItem[]> {
  return listAll(ctx);
}

/** show 核心逻辑。@throws ConfigError(2) id 不存在。 */
export async function runLearningsShow(ctx: LearningsCommandContext, id: string): Promise<string> {
  const found = await requireOne(ctx, id);
  return await ctx.host.readFile(found.file);
}

/** rm 核心逻辑（在条目所在层删除）。@throws ConfigError(2) id 不存在。 */
export async function runLearningsRemove(
  ctx: LearningsCommandContext,
  id: string,
): Promise<{ id: string; file: string; scope: 'user' | 'project' }> {
  const found = await requireOne(ctx, id);
  await removeLearning({ host: ctx.host, sotRoot: path.dirname(path.dirname(found.file)) }, id);
  return { id, file: found.file, scope: found.scope };
}

/** 单行列摘要（ASCII，两列对齐）。 */
function listLine(item: LearningListItem): string {
  const l = item.learning;
  return `  ${l.id}  [${item.scope}]  ${l.promoted ? 'promoted' : 'draft   '}  ${l.category.padEnd(12)}${l.trigger === '' ? '' : `  ${l.trigger}`}`;
}

export function registerLearningsCommand(program: Command): void {
  const cmd = program
    .command('learnings')
    .description('manage learning entries (list | show | edit | rm)');

  cmd
    .command('list')
    .description('list all learning entries in both SoT layers')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (options: { json?: boolean }, command: Command) => {
      const items = await runLearningsList(defaultCommandContext());
      if (resolveJsonFlag(command, options.json)) {
        printJson(items.map((i) => ({ ...i.learning, scope: i.scope, file: i.file })));
        return;
      }
      if (items.length === 0) {
        console.log('no learnings yet - run `aforge learn` to create one');
        return;
      }
      const lines = items.map(listLine);
      lines.push('', `${items.length} learning(s)`);
      console.log(lines.join('\n'));
    });

  cmd
    .command('show <id>')
    .description('print a learning entry as YAML')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (id: string, options: { json?: boolean }, command: Command) => {
      const ctx = defaultCommandContext();
      if (resolveJsonFlag(command, options.json)) {
        const found = await requireOne(ctx, id);
        printJson({
          ...found.learning,
          scope: found.scope,
          file: found.file,
          content: await ctx.host.readFile(found.file),
        });
        return;
      }
      const yaml = await runLearningsShow(ctx, id);
      console.log(yaml);
    });

  cmd
    .command('edit <id>')
    .description('print entry file path and content for manual editing')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (id: string, options: { json?: boolean }, command: Command) => {
      const found = await requireOne(defaultCommandContext(), id);
      const content = await realHost.readFile(found.file);
      const editor = realHost.env('EDITOR') ?? 'notepad';
      if (resolveJsonFlag(command, options.json)) {
        printJson({
          ...found.learning,
          scope: found.scope,
          file: found.file,
          editor,
          content,
        });
        return;
      }
      console.log(
        [
          `learning file: ${found.file}`,
          `open it with your editor (e.g. \`${editor} "${found.file}"\`) and save;`,
          'current content:',
          '---',
          content,
          '---',
        ].join('\n'),
      );
    });

  cmd
    .command('rm <id>')
    .description('remove a learning entry file')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (id: string, options: { json?: boolean }, command: Command) => {
      const result = await runLearningsRemove(defaultCommandContext(), id);
      if (resolveJsonFlag(command, options.json)) {
        printJson(result);
        return;
      }
      console.log(`learning removed: ${result.id} (${result.scope} layer)\n  ${result.file}`);
    });
}
