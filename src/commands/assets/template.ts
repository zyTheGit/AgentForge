/**
 * aforge template 命令（Spec §6 命令表 / §7.6）。
 *
 * `aforge template list | enable <id> | disable <id>`（三条子命令均支持 `--json`，§6.2）：
 * - list：内置 base/default（恒可用，§3.4；渲染层第 4 层恒渲染）+ 两层 SoT
 *   templates\ + 各源清单（manifest.templates，无 manifest 时回落扫描源根
 *   `templates\**.md`）；enabled = 是否在生效 profile.templates
 *   （resolveEffectiveConfig 两层合并后）中。**注意 list 不是纯只读命令**：已启用但
 *   尚无可用缓存的 git 源会在此按需首次拉取（离线 / CI / 拉取失败一律降级为 note 行，
 *   不影响其余清单）；`--json` 输出 `{ items, warnings }`，降级说明对脚本同样可见；
 * - enable/disable：**只改 profile.templates 数组**（§7.6），编辑目标层
 *   （AGF_SCOPE > project 在用 > user 在用）自己的 profile.yaml。
 */
import type { Command } from 'commander';
import { resolveEffectiveConfig } from '../../core/config/defaults';
import { resolveWriteTargetLayer } from '../../core/config/target-layer';
import { readEnv } from '../../core/env';
import { resolveProjectSoT, resolveUserSoT } from '../../core/paths';
import {
  listTemplates,
  type SetTemplateResult,
  setTemplateEnabled,
  type TemplateContext,
  type TemplateListItem,
  type TemplateListResult,
} from '../../core/sources/template';
import { getUi, type Ui } from '../../infra/ui';
import { type CommandContext, defaultCommandContext, printJson } from '../_shared/context';
import { resolveJsonFlag } from '../_shared/flags';

/** 详情行的 label 宽度（`templates` 最长，冒号同列）。 */
const TEMPLATE_LABEL_WIDTH = 9;

/** 命令上下文。 */
export type TemplateCommandContext = CommandContext;

/**
 * 构造 list 上下文：effectiveTemplates 来自 resolveEffectiveConfig 的合并
 * profile（与 sync 渲染同源：`profile.templates ?? []`，base/default 由渲染
 * 层第 4 层恒渲染兜底，不在此处追加）。
 */
async function buildTemplateContext(ctx: TemplateCommandContext): Promise<TemplateContext> {
  const env = readEnv(ctx.host);
  const userSoTRoot = resolveUserSoT(env, ctx.os);
  const projectSoTRoot = resolveProjectSoT(ctx.cwd, ctx.os);
  const effective = await resolveEffectiveConfig(env, userSoTRoot, projectSoTRoot, ctx.host);
  return {
    host: ctx.host,
    env,
    os: ctx.os,
    cwd: ctx.cwd,
    userSoTRoot,
    projectSoTRoot,
    effectiveTemplates: effective.profile.templates ?? [],
  };
}

/** list 核心逻辑（可注入、不打印）。 */
export async function runTemplateList(ctx: TemplateCommandContext): Promise<TemplateListResult> {
  return listTemplates(await buildTemplateContext(ctx));
}

/** enable/disable 核心逻辑（可注入）。@see setTemplateEnabled 异常契约。 */
export async function runSetTemplateEnabled(
  ctx: TemplateCommandContext,
  id: string,
  enabled: boolean,
): Promise<SetTemplateResult> {
  const env = readEnv(ctx.host);
  const targetLayer = await resolveWriteTargetLayer(ctx.host, env, ctx.os, ctx.cwd);
  return setTemplateEnabled(ctx.host, targetLayer, id, enabled, ctx.os);
}

/** 单行模板摘要（enabled/disabled 上色；恒渲染的内置项加 always-rendered 注记）。 */
function templateLine(item: TemplateListItem, ui: Ui): string {
  const origin = item.origin === 'source' ? `source:${item.sourceId ?? '?'}` : item.origin;
  const note = item.alwaysRendered === true ? ui.dim('  (always rendered, Spec 5.2)') : '';
  const state = item.enabled ? ui.green('enabled') : ui.dim('disabled');
  return `  ${ui.bold(item.id)}  [${origin}]  ${state}${note}`;
}

export function registerTemplateCommand(program: Command): void {
  const cmd = program.command('template').description('list / enable / disable rule templates');

  cmd
    .command('list')
    .description('list builtin + SoT + source templates with enabled state')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (options: { json?: boolean }, command: Command) => {
      const result = await runTemplateList(defaultCommandContext());
      if (resolveJsonFlag(command, options.json)) {
        // `{ items, warnings }` 而非裸数组：list 会为已启用但无缓存的 git 源发起 clone
        // （不限官方源），warnings 是"本次清单缺了谁、为什么"的唯一出口。只输出 items
        // 的话，脚本化调用既看不出清单被降级，也不知道自己刚触发了一次网络访问
        printJson({ items: result.items, warnings: result.warnings });
        return;
      }
      const ui = getUi();
      const lines = result.items.map((item) => templateLine(item, ui));
      lines.push('', ui.dim(`${result.items.length} template(s)`));
      for (const warning of result.warnings) {
        lines.push(ui.yellow(`note: ${warning}`));
      }
      console.log(lines.join('\n'));
    });

  cmd
    .command('enable <id>')
    .description('enable a template (appends to profile.templates)')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (id: string, options: { json?: boolean }, command: Command) => {
      const result = await runSetTemplateEnabled(defaultCommandContext(), id, true);
      if (resolveJsonFlag(command, options.json)) {
        printJson(result);
        return;
      }
      const ui = getUi();
      console.log(
        [
          result.changed
            ? `${ui.green('template enabled')}: ${ui.bold(result.id)}`
            : ui.dim(`template ${result.id} was already enabled (no change)`),
          ui.kv('profile', ui.path(result.profileFile), TEMPLATE_LABEL_WIDTH),
          ui.kv('templates', `[${result.templates.join(', ')}]`, TEMPLATE_LABEL_WIDTH),
        ].join('\n'),
      );
    });

  cmd
    .command('disable <id>')
    .description('disable a template (removes from profile.templates)')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (id: string, options: { json?: boolean }, command: Command) => {
      const result = await runSetTemplateEnabled(defaultCommandContext(), id, false);
      if (resolveJsonFlag(command, options.json)) {
        printJson(result);
        return;
      }
      const ui = getUi();
      console.log(
        [
          result.changed
            ? `${ui.green('template disabled')}: ${ui.bold(result.id)}`
            : ui.dim(`template ${result.id} was not enabled (no change)`),
          ui.kv('profile', ui.path(result.profileFile), TEMPLATE_LABEL_WIDTH),
          ui.kv('templates', `[${result.templates.join(', ')}]`, TEMPLATE_LABEL_WIDTH),
        ].join('\n'),
      );
    });
}
