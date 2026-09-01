/**
 * aforge source 命令（Spec §6 命令表 / §7.6 Source 安装 / §7.8 Offline 降级矩阵）。
 *
 * `aforge source add <local路径|git url> [--ref <x>] [--id <id>] | list
 *            | remove <id> | update <id>`（四条子命令均支持 `--json`，§6.2）：
 * - add：目标按 git/local 语义识别（url 协议 / git@ scp 语法 / .git 后缀 →
 *   git 源；其余按 local 路径登记，§7.6"登记路径"）；
 * - git add：缺 --ref → ConfigError(2)；AGF_OFFLINE=1 → OfflineError(5)；
 * - list：sources.json 全量；
 * - remove：删登记 + 删 store\ 缓存；
 * - update：git fetch + checkout pinned commit（离线 → 5）。
 *
 * sources.json 与 store\ 均在 user 层 SoT（§3.1）；核心逻辑在
 * core/sources/manager，本层只做目标识别与输出。
 */
import type { Command } from 'commander';
import { readEnv } from '../../core/env';
import { resolveUserSoT } from '../../core/paths';
import {
  type AddSourceResult,
  addGitSource,
  addLocalSource,
  listSources,
  removeSource,
  type SourceManagerContext,
  type UpdateSourceResult,
  updateSource,
} from '../../core/sources/manager';
import type { Source } from '../../schema';
import { type CommandContext, defaultCommandContext, printJson } from '../_shared/context';
import { resolveJsonFlag } from '../_shared/flags';

/** 命令上下文。 */
export type SourceCommandContext = CommandContext;

/** git/local 语义识别：url 协议 / git@ scp 语法 / .git 后缀 → git；其余 local。 */
export function isGitTarget(target: string): boolean {
  return (
    /^(https?|git|ssh|file):\/\//i.test(target) || /^git@/i.test(target) || /\.git$/i.test(target)
  );
}

/** 构造 manager 上下文（sources.json 与 store\ 在 user 层 SoT，§3.1）。 */
function managerContext(ctx: SourceCommandContext): SourceManagerContext {
  const env = readEnv(ctx.host);
  return {
    host: ctx.host,
    env,
    userSoTRoot: resolveUserSoT(env, ctx.os),
    cwd: ctx.cwd,
    os: ctx.os,
  };
}

/** add 核心逻辑（可注入、不打印）。@see addLocalSource/addGitSource 异常契约。 */
export async function runSourceAdd(
  ctx: SourceCommandContext,
  target: string,
  options: { ref?: string; id?: string } = {},
): Promise<AddSourceResult> {
  const mgr = managerContext(ctx);
  if (isGitTarget(target)) {
    return addGitSource(mgr, { url: target, ref: options.ref, id: options.id });
  }
  return addLocalSource(mgr, { path: target, id: options.id });
}

/** list 核心逻辑。 */
export async function runSourceList(ctx: SourceCommandContext): Promise<Source[]> {
  return listSources(managerContext(ctx));
}

/** remove 核心逻辑。@see removeSource 异常契约。 */
export async function runSourceRemove(
  ctx: SourceCommandContext,
  id: string,
): Promise<{ removed: Source; file: string; storeDir?: string }> {
  return removeSource(managerContext(ctx), id);
}

/** update 核心逻辑。@see updateSource 异常契约。 */
export async function runSourceUpdate(
  ctx: SourceCommandContext,
  id: string,
): Promise<UpdateSourceResult> {
  return updateSource(managerContext(ctx), id);
}

/** list 表头（首列是源 id——remove/update 的入参，避免与 commit 混淆）。 */
const LIST_HEADER = ['ID', 'TYPE', 'REF', 'COMMIT/PATH'] as const;

/** 单行源摘要拆成列：git → ref + commit 前 12 位；local → path（无 ref）。 */
function sourceCells(source: Source): string[] {
  return source.type === 'git'
    ? [source.id, source.type, source.ref ?? '-', (source.commit ?? '?').slice(0, 12)]
    : [source.id, source.type, '-', source.path];
}

/** 渲染 ASCII 表格（列宽按内容自适应，两空格缩进 + 两空格列间距；末列不补空格）。 */
function renderTable(rows: readonly string[][]): string[] {
  const columns = rows[0]?.length ?? 0;
  const widths = Array.from({ length: columns }, (_, col) =>
    Math.max(...rows.map((row) => (row[col] ?? '').length)),
  );
  return rows.map((row) => {
    const cells = row.map((cell, col) =>
      col === columns - 1 ? cell : cell.padEnd(widths[col] ?? 0),
    );
    return `  ${cells.join('  ')}`;
  });
}

export function registerSourceCommand(program: Command): void {
  const cmd = program
    .command('source')
    .description('manage rule/template/skill sources (add | list | remove | update)');

  cmd
    .command('add <target>')
    .description('register a source: local path or git url (git requires --ref)')
    .option('--ref <ref>', 'git ref to pin (tag / branch / commit; required for git sources)')
    .option('--id <id>', 'custom source id (default: derived from url/path basename)')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(
      async (
        target: string,
        options: { ref?: string; id?: string; json?: boolean },
        command: Command,
      ) => {
        // 只把 add 语义相关的字段传下去：--json 是输出契约，不属于 addSource 的入参
        const result = await runSourceAdd(defaultCommandContext(), target, {
          ref: options.ref,
          id: options.id,
        });
        if (resolveJsonFlag(command, options.json)) {
          printJson(result);
          return;
        }
        const s = result.source;
        const lines: string[] = [`source added: ${s.id} (${s.type})`];
        if (s.type === 'git') {
          lines.push(
            `  url    : ${s.url}`,
            `  ref    : ${s.ref}`,
            `  commit : ${s.commit}`,
            `  store  : ${result.storeDir}`,
          );
        } else {
          lines.push(`  path   : ${s.path}`);
        }
        lines.push(`  file   : ${result.file}`);
        console.log(lines.join('\n'));
      },
    );

  cmd
    .command('list')
    .description('list all registered sources')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (options: { json?: boolean }, command: Command) => {
      const sources = await runSourceList(defaultCommandContext());
      if (resolveJsonFlag(command, options.json)) {
        printJson(sources);
        return;
      }
      if (sources.length === 0) {
        console.log('no sources registered - run `aforge source add <path-or-url>` to add one');
        return;
      }
      const lines = renderTable([[...LIST_HEADER], ...sources.map(sourceCells)]);
      lines.push('', `${sources.length} source(s)`);
      console.log(lines.join('\n'));
    });

  cmd
    .command('remove <id>')
    .description('remove a registered source (store cache is deleted too)')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (id: string, options: { json?: boolean }, command: Command) => {
      const result = await runSourceRemove(defaultCommandContext(), id);
      if (resolveJsonFlag(command, options.json)) {
        printJson(result);
        return;
      }
      const lines = [`source removed: ${result.removed.id} (${result.removed.type})`];
      if (result.storeDir !== undefined) {
        lines.push(`  store cleaned: ${result.storeDir}`);
      }
      lines.push(`  file          : ${result.file}`);
      console.log(lines.join('\n'));
    });

  cmd
    .command('update <id>')
    .description('re-fetch a git source and checkout its pinned commit')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (id: string, options: { json?: boolean }, command: Command) => {
      const result = await runSourceUpdate(defaultCommandContext(), id);
      if (resolveJsonFlag(command, options.json)) {
        printJson(result);
        return;
      }
      const s = result.source;
      console.log(
        [
          `source updated: ${s.id}`,
          `  ref    : ${s.ref}`,
          `  commit : ${s.commit}`,
          `  store  : ${result.storeDir}`,
          `  file   : ${result.file}`,
        ].join('\n'),
      );
    });
}
