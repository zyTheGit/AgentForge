/**
 * aforge learnings 命令（Spec §6 命令表：list | show <id> | edit <id> | rm <id>）。
 *
 * - list：两层 SoT 条目汇总（含**衰减后**的 confidence）；
 * - show：输出条目 YAML 原文 + confidence 质量段（打分 breakdown、衰减档位、
 *   stale 清理提示，见 confidence-view）；
 * - edit：TTY 下拉起 `$EDITOR`（缺省 notepad）编辑条目 yaml，等编辑器退出后
 *   重校验；非 TTY（CI / 管道）或 `$EDITOR` 在 PATH 上解析不到时退回打印
 *   「文件路径 + 正文」的旧行为，**不报错**；
 * - rm：删除条目文件（先 show 确认建议由用户自行执行）。
 *
 * 四个子命令都支持 `--json`（§6.2；判定走 resolveJsonFlag，故 `aforge --json
 * learnings show <id>` 与 `aforge learnings show <id> --json` 等价）。JSON 字段
 * 与 list 同风格：条目字段展开 + `scope` + `file`（show/edit 另带正文 `content`）。
 * **`--json` 恒不拉编辑器**（见 edit action 内的契约注释）。
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
import { defaultTtyProbe, type TtyProbe } from '../../infra/prompt';
import { resolveExecutable } from '../../infra/shell';
import { getUi, type Ui } from '../../infra/ui';
import type { Learning } from '../../schema';
import { type CommandContext, defaultCommandContext, printJson } from '../_shared/context';
import { resolveJsonFlag } from '../_shared/flags';
import {
  confidenceBreakdownLines,
  confidenceSummary,
  learningQualityJson,
} from './confidence-view';

/** 命令上下文。 */
export type LearningsCommandContext = CommandContext;

/** `$EDITOR` 缺失时的兜底编辑器（沿用改造前的口径）。 */
const EDITOR_FALLBACK = 'notepad';

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

/** rm 核心逻辑（在条目所在层删除）。@throws ConfigError(2) id 不存在。 */
export async function runLearningsRemove(
  ctx: LearningsCommandContext,
  id: string,
): Promise<{ id: string; file: string; scope: 'user' | 'project' }> {
  const found = await requireOne(ctx, id);
  await removeLearning({ host: ctx.host, sotRoot: path.dirname(path.dirname(found.file)) }, id);
  return { id, file: found.file, scope: found.scope };
}

/** edit 的注入上下文：额外带 TTY 探测（测试伪造 CI / 管道环境）。 */
export interface LearningsEditContext extends LearningsCommandContext {
  readonly tty: TtyProbe;
}

/**
 * edit 的结局：
 * - `printed`：没拉编辑器，退回「打印文件路径 + 正文」的旧行为；
 * - `valid`：编辑器退出后重校验通过；
 * - `deleted`：用户在编辑器里把该文件删了（不算失败）。
 */
export type LearningsEditOutcome = 'printed' | 'valid' | 'deleted';

/** 退回打印分支的原因（决定是否先给一条编辑器解析失败的提示）。 */
export type LearningsEditFallback = 'not-tty' | 'editor-unresolved';

export interface LearningsEditResult {
  readonly item: LearningListItem;
  /** `$EDITOR` 原始值（缺省 notepad）；与 `--json` 的 editor 字段同源。 */
  readonly editor: string;
  /** 实际拉起的编辑器绝对路径（PATH 解析结果）；未拉起 → undefined。 */
  readonly editorPath?: string;
  /** 编辑器退出码；未拉起 → undefined。 */
  readonly exitCode?: number;
  readonly outcome: LearningsEditOutcome;
  /** 条目正文（仅 `printed` 分支需要，用于原地展示给用户手工编辑）。 */
  readonly content?: string;
  readonly fallback?: LearningsEditFallback;
}

/**
 * edit 核心逻辑：TTY 下拉起 `$EDITOR` 编辑条目文件，退出后重校验。
 *
 * 三条边界（都是刻意选择，不要改成抛错）：
 * - **非 TTY 不报错**：CI / 管道里 `learnings edit` 不该炸，退回打印路径 + 正文
 *   （与改造前行为一致），故不用 prompt.assertTty；
 * - **`$EDITOR` 在 PATH 上解析不到 → 同样退回打印**：绝不 spawn 一个解析不出的
 *   裸名（§10：Windows CreateProcess 解析裸命令名会先搜当前目录）；
 * - **编辑器非零退出仍然重校验**：用户可能保存后才让编辑器崩掉，跳过校验会漏报
 *   坏文件；调用方按 exitCode 补一条 warning 即可。
 *
 * @throws ConfigError(2) id 不存在；编辑后内容非法（readLearningFile 冒泡，正确行为）。
 */
export async function runLearningsEdit(
  ctx: LearningsEditContext,
  id: string,
): Promise<LearningsEditResult> {
  const found = await requireOne(ctx, id);
  const editor = ctx.host.env('EDITOR') ?? EDITOR_FALLBACK;

  if (!ctx.tty.isInteractive()) {
    return {
      item: found,
      editor,
      outcome: 'printed',
      fallback: 'not-tty',
      content: await ctx.host.readFile(found.file),
    };
  }

  const editorPath = await resolveExecutable(ctx.host, editor, { platform: ctx.os.platform });
  if (editorPath === undefined) {
    return {
      item: found,
      editor,
      outcome: 'printed',
      fallback: 'editor-unresolved',
      content: await ctx.host.readFile(found.file),
    };
  }

  const exitCode = await ctx.host.spawnInteractive(editorPath, [found.file]);
  // 重校验复用 store.readLearningFile：不存在 → null；内容非法 → ConfigError(2) 冒泡
  const edited = await readLearningFile(ctx.host, found.file);
  if (edited === null) {
    return { item: found, editor, editorPath, exitCode, outcome: 'deleted' };
  }
  return {
    item: { ...found, learning: edited },
    editor,
    editorPath,
    exitCode,
    outcome: 'valid',
  };
}

/** edit 的人类可读输出（调用方 console.log）。 */
export function formatLearningsEdit(result: LearningsEditResult, ui: Ui = getUi()): string {
  const { item } = result;
  if (result.outcome === 'printed') {
    const lines: string[] = [];
    if (result.fallback === 'editor-unresolved') {
      lines.push(
        `${ui.yellow('editor not found on PATH')}: ${result.editor}`,
        ui.hint('point $EDITOR at an executable on PATH, then rerun'),
      );
    }
    lines.push(
      `${ui.dim('learning file')}: ${ui.path(item.file)}`,
      ui.dim(`open it with your editor (e.g. \`${result.editor} "${item.file}"\`) and save;`),
      ui.dim('current content:'),
      ui.dim('---'),
      result.content ?? '',
      ui.dim('---'),
    );
    return lines.join('\n');
  }

  const lines: string[] = [];
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    lines.push(
      `${ui.yellow('editor exited abnormally')}: ${result.editor} (code ${result.exitCode})`,
    );
  }
  if (result.outcome === 'deleted') {
    lines.push(
      `${ui.yellow('learning file deleted')}: ${ui.bold(item.learning.id)} (${item.scope} layer)\n  ${ui.path(item.file)}`,
    );
  } else {
    lines.push(
      `${ui.green('learning updated')}: ${ui.bold(item.learning.id)} (${item.scope} layer)\n  ${ui.path(item.file)}`,
    );
  }
  return lines.join('\n');
}

/**
 * 单行列摘要（两列对齐；promoted 绿 / draft 暗）。
 *
 * confidence 展示的是**衰减后**的 effective 值（见 core/learning/scoring）：list 是
 * 判断"哪几条该先 promote / 该清掉"的入口，摆一个不随时间变化的 base 值没有意义。
 */
function listLine(item: LearningListItem, now: Date, ui: Ui): string {
  const l = item.learning;
  const state = l.promoted ? ui.green('promoted') : ui.dim('draft   ');
  const conf = confidenceSummary(l, now);
  return `  ${ui.bold(l.id)}  [${item.scope}]  ${state}  ${ui.dim(l.category.padEnd(12))}${ui.dim(conf)}${l.trigger === '' ? '' : `  ${l.trigger}`}`;
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
      const ctx = defaultCommandContext();
      const items = await runLearningsList(ctx);
      const now = ctx.host.now();
      if (resolveJsonFlag(command, options.json)) {
        printJson(
          items.map((i) => ({
            ...i.learning,
            scope: i.scope,
            file: i.file,
            quality: learningQualityJson(i.learning, now),
          })),
        );
        return;
      }
      const ui = getUi();
      if (items.length === 0) {
        console.log(`no learnings yet - run ${ui.code('aforge learn')} to create one`);
        return;
      }
      const lines = items.map((item) => listLine(item, now, ui));
      lines.push('', ui.dim(`${items.length} learning(s)`));
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
          quality: learningQualityJson(found.learning, ctx.host.now()),
        });
        return;
      }
      // 人类可读：YAML 原文在前（既有契约），质量 breakdown 附在后
      const found = await requireOne(ctx, id);
      const yaml = await ctx.host.readFile(found.file);
      console.log(
        [yaml, ...confidenceBreakdownLines(found.learning, ctx.host.now(), getUi())].join('\n'),
      );
    });

  cmd
    .command('edit <id>')
    .description('open a learning entry in $EDITOR (prints the path when non-interactive)')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (id: string, options: { json?: boolean }, command: Command) => {
      const ctx: LearningsEditContext = { ...defaultCommandContext(), tty: defaultTtyProbe() };
      // 契约：`--json` **恒不拉编辑器**，只回条目元数据（含 editor 名）+ 正文。
      // 机器模式下拉起交互程序没有意义（脚本 / 管道无人按键），还会把编辑器的
      // 终端渲染混进 stdout 破坏 §6.2 的「单次 JSON 输出」约定。
      if (resolveJsonFlag(command, options.json)) {
        const found = await requireOne(ctx, id);
        printJson({
          ...found.learning,
          scope: found.scope,
          file: found.file,
          editor: ctx.host.env('EDITOR') ?? EDITOR_FALLBACK,
          content: await ctx.host.readFile(found.file),
        });
        return;
      }
      console.log(formatLearningsEdit(await runLearningsEdit(ctx, id)));
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
      const ui = getUi();
      console.log(
        `${ui.green('learning removed')}: ${ui.bold(result.id)} (${result.scope} layer)\n  ${ui.path(result.file)}`,
      );
    });
}
