/**
 * aforge template 命令（Spec §6 命令表 / §7.6）。
 *
 * `aforge template list | enable <id> | disable <id>`（三条子命令均支持 `--json`，§6.2）：
 * - list：内置 base/default（恒可用，§3.4；渲染层第 4 层恒渲染）+ 两层 SoT
 *   templates\ + 各源 manifest.templates 清单；enabled = 是否在生效
 *   profile.templates（resolveEffectiveConfig 两层合并后）中；
 * - enable/disable：**只改 profile.templates 数组**（§7.6），编辑目标层
 *   （AGF_SCOPE > project 在用 > user 在用）自己的 profile.yaml。
 */
import type { Command } from 'commander';
import { resolveEffectiveConfig } from '../core/config/defaults';
import { resolveWriteTargetLayer } from '../core/config/target-layer';
import { readEnv } from '../core/env';
import { resolveProjectSoT, resolveUserSoT } from '../core/paths';
import {
  listTemplates,
  type SetTemplateResult,
  setTemplateEnabled,
  type TemplateContext,
  type TemplateListItem,
} from '../core/sources/template';
import { type CommandContext, defaultCommandContext, printJson } from './context';
import { resolveJsonFlag } from './flags';

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
export async function runTemplateList(ctx: TemplateCommandContext): Promise<TemplateListItem[]> {
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

/** 单行模板摘要（ASCII；builtin 项加 always-rendered 注记）。 */
function templateLine(item: TemplateListItem): string {
  const origin = item.origin === 'source' ? `source:${item.sourceId ?? '?'}` : item.origin;
  const note = item.origin === 'builtin' ? '  (always rendered, Spec 5.2)' : '';
  return `  ${item.id}  [${origin}]  ${item.enabled ? 'enabled' : 'disabled'}${note}`;
}

export function registerTemplateCommand(program: Command): void {
  const cmd = program.command('template').description('list / enable / disable rule templates');

  cmd
    .command('list')
    .description('list builtin + SoT + source templates with enabled state')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (options: { json?: boolean }, command: Command) => {
      const items = await runTemplateList(defaultCommandContext());
      if (resolveJsonFlag(command, options.json)) {
        printJson(items);
        return;
      }
      const lines = items.map(templateLine);
      lines.push('', `${items.length} template(s)`);
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
      console.log(
        [
          result.changed
            ? `template enabled: ${result.id}`
            : `template ${result.id} was already enabled (no change)`,
          `  profile   : ${result.profileFile}`,
          `  templates : [${result.templates.join(', ')}]`,
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
      console.log(
        [
          result.changed
            ? `template disabled: ${result.id}`
            : `template ${result.id} was not enabled (no change)`,
          `  profile   : ${result.profileFile}`,
          `  templates : [${result.templates.join(', ')}]`,
        ].join('\n'),
      );
    });
}
