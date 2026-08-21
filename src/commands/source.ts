/**
 * aforge source 命令（Spec §6 命令表 / §7.6 Source 安装 / §7.8 Offline 降级矩阵）。
 *
 * `aforge source add <local路径|git url> [--ref <x>] [--id <id>] | list [--json]
 *            | remove <id> | update <id>`：
 * - add：目标按 git/local 语义识别（url 协议 / git@ scp 语法 / .git 后缀 →
 *   git 源；其余按 local 路径登记，§7.6"登记路径"）；
 * - git add：缺 --ref → ConfigError(2)；AGF_OFFLINE=1 → OfflineError(5)；
 * - list：sources.json 全量（--json 机器可读输出，§6.2）；
 * - remove：删登记 + 删 store\ 缓存；
 * - update：git fetch + checkout pinned commit（离线 → 5）。
 *
 * sources.json 与 store\ 均在 user 层 SoT（§3.1）；核心逻辑在
 * core/sources/manager，本层只做目标识别与输出。
 */
import type { Command } from 'commander';
import { readEnv } from '../core/env';
import { currentOs, resolveUserSoT, type OsContext } from '../core/paths';
import {
  addGitSource,
  addLocalSource,
  listSources,
  removeSource,
  updateSource,
  type AddSourceResult,
  type SourceManagerContext,
  type UpdateSourceResult,
} from '../core/sources/manager';
import type { Source } from '../schema';
import type { Host } from '../infra/host';
import { realHost } from '../infra/real-host';

/** 命令上下文。 */
export interface SourceCommandContext {
  readonly host: Host;
  readonly cwd: string;
  readonly os: OsContext;
}

/** git/local 语义识别：url 协议 / git@ scp 语法 / .git 后缀 → git；其余 local。 */
export function isGitTarget(target: string): boolean {
  return (
    /^(https?|git|ssh|file):\/\//i.test(target) ||
    /^git@/i.test(target) ||
    /\.git$/i.test(target)
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
export async function runSourceUpdate(ctx: SourceCommandContext, id: string): Promise<UpdateSourceResult> {
  return updateSource(managerContext(ctx), id);
}

/** 单行源摘要（ASCII，固定列对齐）。 */
function sourceLine(source: Source): string {
  const detail =
    source.type === 'git'
      ? `${source.ref ?? source.commit ?? '?'} @ ${(source.commit ?? '?').slice(0, 12)}`
      : source.path;
  return `  ${source.id}  [${source.type}]  ${detail}`;
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
    .action(async (target: string, options: { ref?: string; id?: string }) => {
      const result = await runSourceAdd(
        { host: realHost, cwd: process.cwd(), os: currentOs() },
        target,
        options,
      );
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
    });

  cmd
    .command('list')
    .description('list all registered sources')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (options: { json?: boolean }) => {
      const sources = await runSourceList({ host: realHost, cwd: process.cwd(), os: currentOs() });
      if (options.json) {
        console.log(JSON.stringify(sources, null, 2));
        return;
      }
      if (sources.length === 0) {
        console.log('no sources registered - run `aforge source add <path-or-url>` to add one');
        return;
      }
      const lines = sources.map(sourceLine);
      lines.push('', `${sources.length} source(s)`);
      console.log(lines.join('\n'));
    });

  cmd
    .command('remove <id>')
    .description('remove a registered source (store cache is deleted too)')
    .action(async (id: string) => {
      const result = await runSourceRemove({ host: realHost, cwd: process.cwd(), os: currentOs() }, id);
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
    .action(async (id: string) => {
      const result = await runSourceUpdate({ host: realHost, cwd: process.cwd(), os: currentOs() }, id);
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
