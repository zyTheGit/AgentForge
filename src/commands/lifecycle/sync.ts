/**
 * aforge sync 命令（Spec §6 命令表 / §7.3，M6 多 target 版；M7 增 --force）。
 *
 * `aforge sync [--targets a,b,c] [--dry-run] [--force]`：
 * - 未初始化（无 SoT）→ ConfigError(2)，hint 引导先运行 aforge init；
 * - marker 区间冲突（§8.2-4）→ ConflictError(3)，--force 跳过预检查强制覆盖；
 * - 输出：逐项写入明细（`[target] action: path`）+ 每 target 汇总表 +
 *   结果摘要；--dry-run 明确标注且不落盘（含 sync-meta）；
 * - soft warning（§8.6 Pi MVP）随成功结果输出 warning 列表；
 * - `learning.auto_capture: hook` 下没有钩子落点的 target 输出降级提示
 *   （sessionHookNotices；不是失败，该 target 其余产物照常投影，§7.4）；
 * - 投影失败（已回滚）时打印失败汇总表（每 target 状态 + 回滚声明）后
 *   rethrow 原始错误——退出码 / message / hint 语义由 main.ts 统一出口保持；
 * - 回滚**未能全部恢复**时改用「rollback incomplete」措辞、前置未恢复清单、给出
 *   保留下来的备份目录（`.agf-backup-failed-<ts>`），并把退出码抬升为
 *   EXIT_CODE_ROLLBACK_INCOMPLETE(6)；
 * - 事务设施级警告（崩溃恢复能力降级等）以 `crash recovery disabled` 前缀输出；
 * - 同一 SoT 已有 sync 在写入（`.sync.lock/` 被占用）→ ConflictError(3)。
 *
 * 核心逻辑在 core/project/engine.syncOnce；本层只做参数解析与输出（上色 + 符号，
 * GBK 控制台与管道自动降级为纯 ASCII，见 infra/ui）。
 */
import path from 'node:path';
import type { Command } from 'commander';
import { readEnv } from '../../core/env';
import {
  getSyncFailureReport,
  type SyncResult,
  type SyncSkillSkip,
  type SyncTargetResult,
  syncOnce,
} from '../../core/project/engine';
import { SYNC_META_FILE } from '../../core/project/sync-meta';
import { dryRunItem } from '../../core/project/writer';
import { getUi, type Ui } from '../../infra/ui';
import { VERSION } from '../../version';
import { type CommandContext, defaultCommandContext, printJson } from '../_shared/context';
import { resolveJsonFlag } from '../_shared/flags';

/** 命令上下文（host/os/cwd/版本注入；测试用真实临时目录 + realHost）。 */
export interface SyncCommandContext extends CommandContext {
  readonly agentforgeVersion: string;
}

export interface SyncCommandOptions {
  /** --targets 原始串（"a,b,c"）；undefined / 空白 → 不过滤。 */
  readonly targets?: string;
  readonly dryRun?: boolean;
  /** --force（§8.2-4）：跳过 marker 区间冲突预检查，强制覆盖。 */
  readonly force?: boolean;
}

/** 解析 --targets：逗号分隔、trim、去空段；空串 → undefined（全量）。 */
export function parseTargetsFilter(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return ids.length === 0 ? undefined : ids;
}

/** sync 核心逻辑（可注入、不打印）。@see syncOnce 的异常契约。 */
export async function runSync(
  ctx: SyncCommandContext,
  options: SyncCommandOptions = {},
): Promise<SyncResult> {
  return syncOnce({
    host: ctx.host,
    env: readEnv(ctx.host),
    os: ctx.os,
    cwd: ctx.cwd,
    agentforgeVersion: ctx.agentforgeVersion,
    targetsFilter: parseTargetsFilter(options.targets),
    dryRun: options.dryRun === true,
    force: options.force === true,
  });
}

/**
 * `skills.on_demand` 跳过原因的英文一行说明（口径与 doctor 的 skills-on-demand 一致）。
 *
 * 四种原因都不是失败：投影仍然完整，只是这个名字没拿到完整的「按需装载」待遇。
 */
function describeSkillSkip(skip: SyncSkillSkip): string {
  switch (skip.reason) {
    case 'not-installed':
      return 'not installed in either SoT layer - not projected (run `aforge skill add`)';
    case 'invalid-frontmatter':
      return 'frontmatter is not a valid YAML mapping - refused to rewrite it, projected as-is';
    case 'declared-false':
      return 'frontmatter declares a non-true disable-model-invocation - honored, on-demand not applied on any target';
    default:
      return 'SKILL.md has no frontmatter - projected as-is, on-demand marker not applied';
  }
}

/** 单个 target 的明细行（`[claude] merge (marker): <path>`，附状态标注）。 */
function targetItemLines(target: SyncTargetResult, dryRun: boolean, ui: Ui): string[] {
  return target.items.map((item, index) => {
    const base = `${dryRun ? 'would ' : ''}${dryRunItem(item)}`;
    const prefix = `[${ui.cyan(target.targetId)}]`;
    const status = target.statuses[index];
    if (status === 'unchanged') {
      return `${prefix} ${ui.dim(`${base} (unchanged, skipped)`)}`;
    }
    if (status === 'warning') {
      return `${prefix} ${base} ${ui.yellow('(soft, failed - see warnings)')}`;
    }
    return `${prefix} ${base}`;
  });
}

/** 单个 target 的汇总行（成功 / 带 warning）。 */
function targetSummaryLine(target: SyncTargetResult, ui: Ui): string {
  const written = target.statuses.filter((s) => s === 'written').length;
  const unchanged = target.statuses.filter((s) => s === 'unchanged').length;
  const warned = target.statuses.filter((s) => s === 'warning').length;
  const parts = [`${target.statuses.length} file(s)`];
  if (written > 0) {
    parts.push(`${written} written`);
  }
  if (unchanged > 0) {
    parts.push(`${unchanged} unchanged`);
  }
  if (warned > 0) {
    parts.push(`${warned} soft warning(s)`);
  }
  const verdict = warned > 0 ? ui.yellow('ok (warnings)') : ui.green('ok');
  return `  ${target.targetId}: ${verdict} ${ui.dim(`(${parts.join(', ')})`)}`;
}

/**
 * 结果摘要输出（逐项明细 + 每 target 汇总表 + 计数；dry-run 显式标注）。
 *
 * M9 起导出供 init -i 交互末尾的「立即 sync」复用。
 */
export function printSyncResult(result: SyncResult, ui: Ui = getUi()): void {
  const banner = result.dryRun
    ? `${ui.bold('aforge sync')} ${ui.yellow('(DRY RUN - no files will be written)')} - scope: ${ui.cyan(result.scope)}`
    : `${ui.bold('aforge sync')} - scope: ${ui.cyan(result.scope)}`;
  const lines: string[] = [banner, ''];

  if (result.recovered.length > 0) {
    // 上次 sync 被强杀（SIGKILL / 断电）遗留的落盘备份已在本次取锁后恢复
    lines.push(ui.bold('recovered from an interrupted previous sync:'));
    for (const entry of result.recovered) {
      lines.push(
        entry.restored
          ? `  restored: ${ui.path(entry.path)}`
          : ui.red(`  NOT restored: ${entry.path}: ${entry.error ?? 'unknown error'}`),
      );
    }
    lines.push('');
  }

  for (const target of result.targets) {
    lines.push(...targetItemLines(target, result.dryRun, ui));
  }
  if (result.gitignore !== null) {
    // §4.2 projection.gitignore_generated：项目 .gitignore 的标记段（非 agent target）
    lines.push(...targetItemLines(result.gitignore, result.dryRun, ui));
  }
  for (const skipped of result.skippedTargets) {
    lines.push(ui.dim(`[${skipped}] skipped: projector not available in this version`));
  }
  for (const skip of result.commandSkips) {
    // §8.8.4：命令薄壳整项跳过（该 target 的其余产物照常投影）
    lines.push(ui.yellow(`[${skip.targetId}] commands skipped: ${skip.reason}`));
  }
  for (const notice of result.sessionHookNotices) {
    // §7.4 hook 档：该 target 没有钩子落点 → 显式降级，不静默（该 target 其余产物照常投影）
    lines.push(ui.yellow(`[${notice.targetId}] ${notice.message}`));
  }
  for (const skip of result.skillSkips) {
    // `skills.on_demand` 侧的非致命跳过（未安装 / 被 always 遮蔽 / 无 frontmatter）；
    // 与 target 无关，故不带 [target] 前缀
    lines.push(
      ui.yellow(`[on_demand] ${skip.name}: ${describeSkillSkip(skip)} ${ui.dim(skip.detail)}`),
    );
  }

  if (result.targets.length > 0) {
    lines.push(
      '',
      ui.bold('target summary:'),
      ...result.targets.map((t) => targetSummaryLine(t, ui)),
    );
    if (result.gitignore !== null) {
      lines.push(targetSummaryLine(result.gitignore, ui));
    }
  }
  if (result.warnings.length > 0) {
    lines.push('', ui.yellow(ui.bold('warnings:')));
    for (const warning of result.warnings) {
      lines.push(`  [${warning.targetId}] ${warning.path}: ${ui.yellow(warning.message)}`);
    }
  }
  if (result.mcpTransportNotices.length > 0) {
    // Phase 2 MCP 对齐：上游表达不了某种 transport 时的降级 / 跳过（不影响退出码）
    lines.push('', ui.yellow(ui.bold('mcp transport notices:')));
    for (const notice of result.mcpTransportNotices) {
      const label = notice.support === 'unsupported' ? 'skipped' : 'degraded';
      lines.push(`  [${notice.targetId}] ${label}: ${ui.yellow(notice.detail)}`);
      lines.push(`    ${ui.dim(notice.hint)}`);
    }
  }
  if (result.transactionWarnings.length > 0) {
    // 事务设施级问题：崩溃恢复能力已失效 / 有备份被保留下来待人工核对
    lines.push('', ui.yellow(ui.bold('transaction warnings:')));
    for (const warning of result.transactionWarnings) {
      lines.push(`  ${ui.yellow(warning.message)} (${ui.path(warning.path)})`);
    }
  }
  if (result.pruned.length > 0) {
    // §7.6 差集清理：上一轮投影过、本轮不该再存在的产物 / MCP server 键
    lines.push('', ui.bold('pruned (no longer projected):'));
    for (const entry of result.pruned) {
      lines.push(
        entry.kind === 'mcp-server'
          ? `  mcp server "${entry.name}" removed from ${ui.path(entry.path)}`
          : `  deleted: ${ui.path(entry.path)}`,
      );
    }
  }
  if (result.pruneSkipped.length > 0) {
    // 跳过不影响退出码：残留无害，静默吞掉用户手工改过的内容才有害
    lines.push('', ui.yellow(ui.bold('prune skipped (needs manual review):')));
    for (const entry of result.pruneSkipped) {
      lines.push(`  ${ui.path(entry.path)}: ${entry.reason}`);
    }
  }

  const fileCount = result.targets.reduce((n, t) => n + t.items.length, 0);
  lines.push('');
  if (result.dryRun) {
    lines.push(
      ui.yellow(
        `dry-run complete: ${result.targets.length} target(s), ${fileCount} file(s) would be written (nothing touched)`,
      ),
    );
  } else {
    lines.push(
      ui.green(`sync complete: ${result.targets.length} target(s), ${fileCount} file(s) projected`),
    );
    lines.push(`${ui.dim('content hash')}: ${result.contentHash}`);
    lines.push(`${ui.dim('sync-meta')}: ${ui.path(path.join(result.sotRoot, SYNC_META_FILE))}`);
  }

  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// 失败汇总输出与退出码（回滚未完成必须与「已完全回滚」区分）
// ---------------------------------------------------------------------------

/**
 * 回滚未完成的退出码。
 *
 * Spec §6.1 的退出码表占用 0-5（0 成功 / 1 通用含部分投影失败回滚 / 2 配置 /
 * 3 冲突 / 4 权限 / 5 离线），6 未占用，故取 6 表示「投影失败且回滚未能全部
 * 恢复」——磁盘上留下了半新半旧的文件，严重度高于任何单一失败原因，脚本可据此
 * 与「已完全回滚」（沿用原始错误码 1/3/4）区分并停止后续自动化步骤。
 */
export const EXIT_CODE_ROLLBACK_INCOMPLETE = 6;

/** 退出码覆盖在错误对象上的附加键（非枚举属性，不影响既有错误语义）。 */
const EXIT_CODE_OVERRIDE_KEY = 'agentforgeExitCodeOverride';

/** 给错误附加退出码覆盖（main.ts 统一出口优先采用它）。 */
export function attachExitCodeOverride(err: unknown, code: number): void {
  if (typeof err !== 'object' || err === null) {
    return;
  }
  try {
    Object.defineProperty(err, EXIT_CODE_OVERRIDE_KEY, {
      value: code,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // 附加失败则退回原始错误码（输出中的文案仍然如实说明回滚未完成）
  }
}

/** 读取错误上的退出码覆盖（无 → undefined）。 */
export function getExitCodeOverride(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && EXIT_CODE_OVERRIDE_KEY in err) {
    const code = (err as Record<string, unknown>)[EXIT_CODE_OVERRIDE_KEY];
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

/**
 * 失败汇总文本（纯函数，便于单测）。
 *
 * 首行按未恢复数量分支：全部恢复 → `all written files have been rolled back`；
 * 存在未恢复 → `rollback incomplete - N file(s) could not be restored`，且把未恢复
 * 清单**前置**（用户最需要先看到哪些文件还处于被改动状态），随后给出保留下来的
 * 备份目录——「手工处理」的提示只有配上 sync 前的原文才有意义。
 */
export function formatFailureReport(
  report: {
    readonly targetStatuses: readonly { readonly targetId: string; readonly status: string }[];
    readonly rolledBack: readonly {
      readonly path: string;
      readonly restored: boolean;
      readonly error?: string;
    }[];
    readonly preservedBackupDir?: string;
  },
  ui: Ui = getUi(),
): string {
  const restored = report.rolledBack.filter((r) => r.restored).length;
  const failed = report.rolledBack.filter((r) => !r.restored);

  const lines: string[] = [];
  if (failed.length === 0) {
    lines.push(ui.yellow('aforge sync failed - all written files have been rolled back'), '');
  } else {
    lines.push(
      ui.red(
        `aforge sync failed - rollback incomplete - ${failed.length} file(s) could not be restored`,
      ),
      '',
      ui.bold('files left in a modified state (restore them manually before the next sync):'),
    );
    for (const entry of failed) {
      lines.push(`  ${ui.path(entry.path)}: ${ui.red(entry.error ?? 'unknown error')}`);
    }
    lines.push('');
    if (report.preservedBackupDir !== undefined) {
      lines.push(
        `pre-sync backups kept for manual recovery: ${ui.path(report.preservedBackupDir)}`,
        '',
      );
    }
  }

  lines.push(ui.bold('target summary:'));
  for (const entry of report.targetStatuses) {
    if (entry.status === 'failed') {
      lines.push(`  ${entry.targetId}: ${ui.red('failed (see error below)')}`);
    } else if (entry.status === 'ok-rolled-back') {
      lines.push(`  ${entry.targetId}: ${ui.yellow('ok (rolled back to pre-sync state)')}`);
    } else {
      lines.push(`  ${entry.targetId}: ${ui.dim('not started')}`);
    }
  }

  lines.push('');
  lines.push(
    `rollback: ${restored} file(s) restored${failed.length > 0 ? `, ${ui.red(`${failed.length} restore error(s)`)}` : ''}`,
  );
  if (failed.length > 0) {
    lines.push(ui.red(`exit code: ${EXIT_CODE_ROLLBACK_INCOMPLETE} (rollback incomplete)`));
  }
  return lines.join('\n');
}

/** 投影失败汇总输出（§7.3-6：每 target 状态表 + 回滚声明；随后 rethrow 由上层统一报错）。 */
function printFailureReport(err: unknown): void {
  const report = getSyncFailureReport(err);
  if (report === undefined) {
    return;
  }
  console.error(formatFailureReport(report));
  if (report.rolledBack.some((r) => !r.restored)) {
    // 回滚未完成：退出码抬升为 6（比原始错误更严重——磁盘上留下了半新半旧的文件）
    attachExitCodeOverride(err, EXIT_CODE_ROLLBACK_INCOMPLETE);
  }
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('render SoT rules and project them to agent targets')
    .option('--targets <ids>', 'comma-separated target ids to sync (e.g. claude,pi)')
    .option('--dry-run', 'show what would be written without touching disk')
    .option('--force', 'overwrite marker sections even if manually modified (skip conflict check)')
    .option('--json', 'print machine-readable JSON (absolute paths)')
    .action(
      async (
        options: { targets?: string; dryRun?: boolean; force?: boolean; json?: boolean },
        command: Command,
      ) => {
        try {
          const result = await runSync(
            { ...defaultCommandContext(), agentforgeVersion: VERSION },
            { targets: options.targets, dryRun: options.dryRun, force: options.force },
          );
          if (resolveJsonFlag(command, options.json)) {
            printJson(result);
          } else {
            printSyncResult(result);
          }
        } catch (err) {
          printFailureReport(err);
          throw err;
        }
      },
    );
}
