/**
 * aforge sync 命令（Spec §6 命令表 / §7.3，M6 多 target 版；M7 增 --force）。
 *
 * `aforge sync [--targets a,b,c] [--dry-run] [--force]`：
 * - 未初始化（无 SoT）→ ConfigError(2)，hint 引导先运行 aforge init；
 * - marker 区间冲突（§8.2-4）→ ConflictError(3)，--force 跳过预检查强制覆盖；
 * - 输出：逐项写入明细（`[target] action: path`）+ 每 target 汇总表 +
 *   结果摘要；--dry-run 明确标注且不落盘（含 sync-meta）；
 * - soft warning（§8.6 Pi MVP）随成功结果输出 warning 列表；
 * - 投影失败（已回滚）时打印失败汇总表（每 target 状态 + 回滚声明）后
 *   rethrow 原始错误——退出码 / message / hint 语义由 main.ts 统一出口保持。
 *
 * 核心逻辑在 core/project/engine.syncOnce；本层只做参数解析与输出（纯 ASCII）。
 */
import path from 'node:path';
import type { Command } from 'commander';
import { readEnv } from '../core/env';
import { currentOs, type OsContext } from '../core/paths';
import {
  getSyncFailureReport,
  syncOnce,
  type SyncResult,
  type SyncTargetResult,
} from '../core/project/engine';
import { dryRunItem } from '../core/project/writer';
import { SYNC_META_FILE } from '../core/project/sync-meta';
import type { Host } from '../infra/host';
import { realHost } from '../infra/real-host';
import { VERSION } from '../version';

/** 命令上下文（host/os/cwd/版本注入；测试用真实临时目录 + realHost）。 */
export interface SyncCommandContext {
  readonly host: Host;
  readonly cwd: string;
  readonly os: OsContext;
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
  if (raw === undefined) return undefined;
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

/** 单个 target 的明细行（`[claude] merge (marker): <path>`，附状态标注）。 */
function targetItemLines(target: SyncTargetResult, dryRun: boolean): string[] {
  return target.items.map((item, index) => {
    const base = `${dryRun ? 'would ' : ''}${dryRunItem(item)}`;
    const status = target.statuses[index];
    if (status === 'unchanged') {
      return `[${target.targetId}] ${base} (unchanged, skipped)`;
    }
    if (status === 'warning') {
      return `[${target.targetId}] ${base} (soft, failed - see warnings)`;
    }
    return `[${target.targetId}] ${base}`;
  });
}

/** 单个 target 的汇总行（成功 / 带 warning）。 */
function targetSummaryLine(target: SyncTargetResult): string {
  const written = target.statuses.filter((s) => s === 'written').length;
  const unchanged = target.statuses.filter((s) => s === 'unchanged').length;
  const warned = target.statuses.filter((s) => s === 'warning').length;
  const parts = [`${target.statuses.length} file(s)`];
  if (written > 0) parts.push(`${written} written`);
  if (unchanged > 0) parts.push(`${unchanged} unchanged`);
  if (warned > 0) parts.push(`${warned} soft warning(s)`);
  return `  ${target.targetId}: ${warned > 0 ? 'ok (warnings)' : 'ok'} (${parts.join(', ')})`;
}

/** 结果摘要输出（逐项明细 + 每 target 汇总表 + 计数；dry-run 显式标注）。M9 起导出供 init -i 交互末尾的「立即 sync」复用。 */
export function printSyncResult(result: SyncResult): void {
  const banner = result.dryRun
    ? `aforge sync (DRY RUN - no files will be written) - scope: ${result.scope}`
    : `aforge sync - scope: ${result.scope}`;
  const lines: string[] = [banner, ''];

  for (const target of result.targets) {
    lines.push(...targetItemLines(target, result.dryRun));
  }
  for (const skipped of result.skippedTargets) {
    lines.push(`[${skipped}] skipped: projector not available in this version`);
  }

  if (result.targets.length > 0) {
    lines.push('', 'target summary:', ...result.targets.map(targetSummaryLine));
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const warning of result.warnings) {
      lines.push(`  [${warning.targetId}] ${warning.path}: ${warning.message}`);
    }
  }

  const fileCount = result.targets.reduce((n, t) => n + t.items.length, 0);
  lines.push('');
  if (result.dryRun) {
    lines.push(
      `dry-run complete: ${result.targets.length} target(s), ${fileCount} file(s) would be written (nothing touched)`,
    );
  } else {
    lines.push(`sync complete: ${result.targets.length} target(s), ${fileCount} file(s) projected`);
    lines.push(`content hash: ${result.contentHash}`);
    lines.push(`sync-meta: ${path.join(result.sotRoot, SYNC_META_FILE)}`);
  }

  console.log(lines.join('\n'));
}

/** 投影失败汇总输出（§7.3-6：每 target 状态表 + 回滚声明；随后 rethrow 由上层统一报错）。 */
function printFailureReport(err: unknown): void {
  const report = getSyncFailureReport(err);
  if (report === undefined) {
    return;
  }
  const restored = report.rolledBack.filter((r) => r.restored).length;
  const failed = report.rolledBack.filter((r) => !r.restored);

  const lines: string[] = ['aforge sync failed - all written files have been rolled back', ''];
  lines.push('target summary:');
  for (const entry of report.targetStatuses) {
    if (entry.status === 'failed') {
      lines.push(`  ${entry.targetId}: failed (see error below)`);
    } else if (entry.status === 'ok-rolled-back') {
      lines.push(`  ${entry.targetId}: ok (rolled back to pre-sync state)`);
    } else {
      lines.push(`  ${entry.targetId}: not started`);
    }
  }
  lines.push('');
  lines.push(`rollback: ${restored} file(s) restored${failed.length > 0 ? `, ${failed.length} restore error(s)` : ''}`);
  for (const entry of failed) {
    lines.push(`  rollback failed: ${entry.path}: ${entry.error ?? 'unknown error'}`);
  }
  console.error(lines.join('\n'));
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('render SoT rules and project them to agent targets')
    .option('--targets <ids>', 'comma-separated target ids to sync (e.g. claude,pi)')
    .option('--dry-run', 'show what would be written without touching disk')
    .option(
      '--force',
      'overwrite marker sections even if manually modified (skip conflict check)',
    )
    .option('--json', 'print machine-readable JSON (absolute paths)')
    .action(
      async (options: {
        targets?: string;
        dryRun?: boolean;
        force?: boolean;
        json?: boolean;
      }) => {
        try {
          const result = await runSync(
            {
              host: realHost,
              cwd: process.cwd(),
              os: currentOs(),
              agentforgeVersion: VERSION,
            },
            { targets: options.targets, dryRun: options.dryRun, force: options.force },
          );
          if (options.json === true) {
            console.log(JSON.stringify(result, null, 2));
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
