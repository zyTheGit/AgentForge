/**
 * aforge source 命令（Spec §6 命令表 / §7.6 Source 安装 / §7.8 Offline 降级矩阵）。
 *
 * `aforge source add <local路径|git url> [--ref <x>] [--id <id>] | list
 *            | remove <id> | update <id> | enable <id> | disable <id>`
 * （六条子命令均支持 `--json`，§6.2）：
 * - add：目标按 git/local 语义识别（url 协议 / git@ scp 语法 / .git 后缀 →
 *   git 源；其余按 local 路径登记，§7.6"登记路径"）；
 * - git add：缺 --ref → ConfigError(2)；AGF_OFFLINE=1 → OfflineError(5)；
 * - list：sources.json 全量（含 enabled 位；默认注册但禁用的官方源在尾行点名）；
 * - remove：删登记 + 删 store\ 缓存；
 * - update：git fetch + checkout pinned commit（离线 → 5）；
 * - enable/disable：只翻 `enabled` 位、不联网、不动缓存。`enable` 一个**尚未登记的
 *   默认注册项**（官方源）会按常量表补登记——这是老 SoT 拿到官方源的唯一途径
 *   （见 core/sources/official.setSourceEnabled）。
 *
 * sources.json 与 store\ 均在 user 层 SoT（§3.1）；核心逻辑在
 * core/sources/manager 与 core/sources/official，本层只做目标识别与输出。
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
import {
  isDefaultSourceId,
  type SetSourceEnabledResult,
  setSourceEnabled,
} from '../../core/sources/official';
import { getUi, type Ui } from '../../infra/ui';
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

/** enable/disable 核心逻辑。@see setSourceEnabled 异常契约（含默认项补登记语义）。 */
export async function runSetSourceEnabled(
  ctx: SourceCommandContext,
  id: string,
  enabled: boolean,
): Promise<SetSourceEnabledResult> {
  return setSourceEnabled(managerContext(ctx), id, enabled);
}

/**
 * list 表头（首列是源 id——remove/update/enable 的入参，避免与 commit 混淆）。
 *
 * ENABLED 列是本特性引入的：默认注册的官方源以 `disabled` 落盘，若不打这一列，
 * 用户在 `source list` 里会看到一条"看起来能用"的登记项，却在 `template list` 里
 * 找不到它的模板。
 */
const LIST_HEADER = ['ID', 'TYPE', 'ENABLED', 'REF', 'COMMIT/PATH'] as const;

/** 单行源摘要拆成列：git → ref + commit 前 12 位；local → path（无 ref）。 */
function sourceCells(source: Source, ui: Ui): string[] {
  const state = source.enabled ? ui.green('yes') : ui.dim('no');
  return source.type === 'git'
    ? [
        ui.bold(source.id),
        source.type,
        state,
        source.ref ?? '-',
        ui.dim((source.commit ?? '?').slice(0, 12)),
      ]
    : [ui.bold(source.id), source.type, state, '-', ui.path(source.path)];
}

/** 详情行的 label 宽度（`store cleaned` 最长，冒号同列）。 */
const DETAIL_LABEL_WIDTH = 13;

export function registerSourceCommand(program: Command): void {
  const cmd = program
    .command('source')
    .description(
      'manage rule/template/skill sources (add | list | remove | update | enable | disable)',
    );

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
        const ui = getUi();
        const lines: string[] = [`${ui.green('source added')}: ${ui.bold(s.id)} (${s.type})`];
        if (s.type === 'git') {
          lines.push(
            // url / ref / commit / store 在 git 源上必然已填（addGitSource 的后置条件），
            // 但类型上是可选字段——退化成 '-' 而不是打出字面 "undefined"
            ui.kv('url', s.url ?? '-', DETAIL_LABEL_WIDTH),
            ui.kv('ref', s.ref ?? '-', DETAIL_LABEL_WIDTH),
            ui.kv('commit', s.commit ?? '-', DETAIL_LABEL_WIDTH),
            ui.kv('store', ui.path(result.storeDir ?? '-'), DETAIL_LABEL_WIDTH),
          );
        } else {
          lines.push(ui.kv('path', ui.path(s.path), DETAIL_LABEL_WIDTH));
        }
        lines.push(ui.kv('file', ui.path(result.file), DETAIL_LABEL_WIDTH));
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
      const ui = getUi();
      if (sources.length === 0) {
        console.log(
          `no sources registered - run ${ui.code('aforge source add <path-or-url>')} to add one`,
        );
        return;
      }
      const lines = ui.table([[...LIST_HEADER], ...sources.map((s) => sourceCells(s, ui))]);
      lines.push('', ui.dim(`${sources.length} source(s)`));
      // 默认注册但仍禁用的官方源：点名 + 给出启用命令。不点名的话"登记了却不生效"
      // 只能靠用户自己盯 ENABLED 列的 no
      const disabledDefaults = sources
        .filter((s) => s.enabled === false && isDefaultSourceId(s.id))
        .map((s) => s.id);
      if (disabledDefaults.length > 0) {
        lines.push(
          ui.dim(
            `official source(s) registered but disabled: ${disabledDefaults.join(', ')} - enable with ${ui.code(`aforge source enable ${disabledDefaults[0]}`)}`,
          ),
        );
      }
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
      const ui = getUi();
      const lines = [
        `${ui.green('source removed')}: ${ui.bold(result.removed.id)} (${result.removed.type})`,
      ];
      if (result.storeDir !== undefined) {
        lines.push(ui.kv('store cleaned', ui.path(result.storeDir), DETAIL_LABEL_WIDTH));
      }
      lines.push(ui.kv('file', ui.path(result.file), DETAIL_LABEL_WIDTH));
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
      const ui = getUi();
      console.log(
        [
          `${ui.green('source updated')}: ${ui.bold(s.id)}`,
          ui.kv('ref', s.ref ?? '-', DETAIL_LABEL_WIDTH),
          ui.kv('commit', s.commit ?? '-', DETAIL_LABEL_WIDTH),
          ui.kv('store', ui.path(result.storeDir), DETAIL_LABEL_WIDTH),
          ui.kv('file', ui.path(result.file), DETAIL_LABEL_WIDTH),
        ].join('\n'),
      );
    });

  for (const spec of [
    {
      name: 'enable',
      enabled: true,
      description:
        'enable a registered source (registers the official source if not yet in sources.json)',
    },
    { name: 'disable', enabled: false, description: 'disable a source without deleting its cache' },
  ] as const) {
    cmd
      .command(`${spec.name} <id>`)
      .description(spec.description)
      .option('--json', 'machine-readable output (Spec 6.2)')
      .action(async (id: string, options: { json?: boolean }, command: Command) => {
        const result = await runSetSourceEnabled(defaultCommandContext(), id, spec.enabled);
        if (resolveJsonFlag(command, options.json)) {
          printJson(result);
          return;
        }
        const ui = getUi();
        const lines: string[] = [
          result.changed
            ? `${ui.green(`source ${spec.name}d`)}: ${ui.bold(result.source.id)}`
            : ui.dim(`source ${result.source.id} was already ${spec.name}d (no change)`),
        ];
        if (result.registered) {
          lines.push(
            ui.kv('registered', 'official source added to sources.json', DETAIL_LABEL_WIDTH),
          );
        }
        if (result.source.type === 'git') {
          lines.push(ui.kv('ref', result.source.ref ?? '-', DETAIL_LABEL_WIDTH));
        }
        lines.push(ui.kv('file', ui.path(result.file), DETAIL_LABEL_WIDTH));
        if (spec.enabled && result.source.type === 'git' && result.source.commit === undefined) {
          // 尚未拉取：下一条命令要么是 template list（按需自动拉），要么显式 update
          lines.push(
            ui.next(
              `content is fetched on first use - run ${ui.code('aforge template list')} (or ${ui.code(`aforge source update ${result.source.id}`)})`,
            ),
          );
        }
        console.log(lines.join('\n'));
      });
  }
}
