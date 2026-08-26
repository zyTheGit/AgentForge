/**
 * aforge promote 命令（Spec §6 命令表 / §7.5）。
 *
 * `aforge promote <id> [--to user] [--yes]`：
 * - --to user：产物写入 user 层 SoT——**显式确认语义**在 CLI 层（TTY confirm；
 *   非 TTY 需 --yes，否则 ConfigError(2)），core 层直接执行；
 * - 核心流程见 core/learning/promote.promoteLearning（id 校验 → 按
 *   promote_target 写 custom/ 或 skills/ → 标记 promoted，条目保留）；
 * - 完成后提示可 `aforge sync`（§7.5-4 可选立即 sync，不自动执行）。
 */

import { cancel, confirm, isCancel } from '@clack/prompts';
import type { Command } from 'commander';
import { readEnv } from '../core/env';
import { ConfigError } from '../core/errors';
import { type PromoteResult, promoteLearning } from '../core/learning/promote';
import { currentOs, resolveUserSoT } from '../core/paths';
import { realHost } from '../infra/real-host';
import { type CommandContext, defaultCommandContext, printJson } from './context';
import { resolveJsonFlag } from './flags';
import { isInteractiveStdin } from './stdin';

/** 命令上下文。 */
export type PromoteCommandContext = CommandContext;

export interface PromoteOptions {
  /** --to user：写入 user 层 SoT。 */
  readonly to?: 'user';
  /** --yes：跳过确认（非 TTY 时 --to user 必须提供）。 */
  readonly yes?: boolean;
}

/** promote 核心逻辑（可注入、不打印）。@see promoteLearning 异常契约。 */
export async function runPromote(
  ctx: PromoteCommandContext,
  id: string,
  options: PromoteOptions = {},
): Promise<PromoteResult> {
  return promoteLearning({ host: ctx.host, env: readEnv(ctx.host), os: ctx.os, cwd: ctx.cwd }, id, {
    to: options.to,
  });
}

export function registerPromoteCommand(program: Command): void {
  program
    .command('promote <id>')
    .description('promote a learning into custom/ or skills/ and mark it promoted')
    .option('--to <layer>', 'write the promoted artifact to the user-level SoT')
    .option('--yes', 'skip confirmation (required with --to user in non-interactive mode)')
    .action(
      async (
        id: string,
        options: { to?: string; yes?: boolean; json?: boolean },
        command: Command,
      ) => {
        const json = resolveJsonFlag(command, options.json);
        if (options.to !== undefined && options.to !== 'user') {
          throw new ConfigError(`非法 --to 值: ${options.to}`, {
            hint: '有效值: user',
          });
        }
        const to = options.to === 'user' ? ('user' as const) : undefined;

        // --to user 的显式确认（CLI 层语义；core 层直接执行）
        if (to === 'user' && options.yes !== true) {
          if (!isInteractiveStdin()) {
            throw new ConfigError('--to user 在非交互环境需要 --yes 显式确认', {
              hint: '确认写入用户级 SoT 后加 --yes 重试，或去掉 --to 写入 learning 所在层',
            });
          }
          const userSoTRoot = resolveUserSoT(readEnv(realHost), currentOs());
          const ok = await confirm({
            message: `将晋升到用户级 SoT（${userSoTRoot}），继续？`,
          });
          if (isCancel(ok) || !ok) {
            cancel('已取消');
            return;
          }
        }

        const result = await runPromote(defaultCommandContext(), id, { to });

        if (json) {
          // §6.2 机器可读输出（路径为绝对路径）
          printJson({
            learning: result.learning,
            fromScope: result.fromScope,
            targetScope: result.targetScope,
            targetSoTRoot: result.targetSoTRoot,
            targetFile: result.targetFile,
          });
          return;
        }

        const lines: string[] = [
          `learning promoted: ${result.learning.id}`,
          `  from      : ${result.fromScope} layer`,
          `  target    : ${result.targetScope} layer (${result.targetSoTRoot})`,
          `  artifact  : ${result.targetFile}`,
          `  entry     : kept (promoted: true, promoted_at: ${result.learning.promoted_at})`,
          '',
          'next: run `aforge sync` to project the promoted rule into agent targets',
        ];
        console.log(lines.join('\n'));
      },
    );
}
