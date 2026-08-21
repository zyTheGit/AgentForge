/**
 * aforge sync 命令（Spec §6 命令表 / §7.3）。
 *
 * `aforge sync [--targets a,b,c] [--dry-run]`：
 * - 未初始化（无 SoT）→ ConfigError(2)，hint 引导先运行 aforge init；
 * - 输出：各写入文件绝对路径 + 结果摘要；--dry-run 明确标注且不落盘（含 sync-meta）。
 *
 * 核心逻辑在 core/project/engine.syncOnce；本层只做参数解析与输出（纯 ASCII）。
 */
import path from 'node:path';
import type { Command } from 'commander';
import { readEnv } from '../core/env';
import { currentOs, type OsContext } from '../core/paths';
import { syncOnce, type SyncResult } from '../core/project/engine';
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
  });
}

/** 结果摘要输出（绝对路径列表 + 计数；dry-run 显式标注）。 */
function printResult(result: SyncResult): void {
  const banner = result.dryRun
    ? `aforge sync (DRY RUN - no files will be written) - scope: ${result.scope}`
    : `aforge sync - scope: ${result.scope}`;
  const lines: string[] = [banner, ''];

  for (const target of result.targets) {
    for (const item of target.items) {
      lines.push(`[${target.targetId}] ${result.dryRun ? 'would ' : ''}${dryRunItem(item)}`);
    }
  }
  for (const skipped of result.skippedTargets) {
    lines.push(`[${skipped}] skipped: projector not available in this version`);
  }

  const fileCount = result.targets.reduce((n, t) => n + t.items.length, 0);
  lines.push('');
  if (result.dryRun) {
    lines.push(
      `dry-run complete: ${result.targets.length} target(s), ${fileCount} file(s) would be written (nothing touched)`,
    );
  } else {
    lines.push(`sync complete: ${result.targets.length} target(s), ${fileCount} file(s) written`);
    lines.push(`content hash: ${result.contentHash}`);
    lines.push(`sync-meta: ${path.join(result.sotRoot, SYNC_META_FILE)}`);
  }

  console.log(lines.join('\n'));
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('render SoT rules and project them to agent targets')
    .option('--targets <ids>', 'comma-separated target ids to sync (e.g. claude,pi)')
    .option('--dry-run', 'show what would be written without touching disk')
    .action(async (options: { targets?: string; dryRun?: boolean }) => {
      const result = await runSync(
        {
          host: realHost,
          cwd: process.cwd(),
          os: currentOs(),
          agentforgeVersion: VERSION,
        },
        { targets: options.targets, dryRun: options.dryRun },
      );
      printResult(result);
    });
}
