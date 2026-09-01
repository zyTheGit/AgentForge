/**
 * `SyncResult` 的装配（Spec §7.3 输出契约）。
 *
 * 为什么从 engine.ts 拆出来：syncOnce 有**两条**返回路径（dry-run 提前返回、apply
 * 成功返回），两者的 15 个字段完全相同、只有 5 个字段（`dryRun` / 逐项 status /
 * `warnings` / `transactionWarnings` / prune 与 recovered）不同。两份字面量并排写在
 * engine 里，加字段时漏改一处就会让 dry-run 与实写的输出形态悄悄分叉——`SyncResult`
 * 是命令层唯一的数据来源，分叉直接表现为「--dry-run 看不到某类提示」。集中到这里之后
 * engine.ts 只留阶段编排，新增字段由 TS 在两个 builder 上同时强制。
 *
 * 全部纯函数、不碰 IO。
 */
import type { Scope } from '../env';
import { GITIGNORE_TARGET_ID } from './sync-gitignore';
import type { SyncAdvisories } from './sync-notices';
import type { PlannedTarget } from './sync-prepare';
import type { SyncPruneResult } from './sync-prune';
import type { SyncResult, SyncRollbackEntry, SyncTargetResult, SyncWarning } from './sync-types';
import type { ProjectionPlanItem } from './types';

/**
 * 两条返回路径共享的本轮事实：位置（scope / 三个根）、内容基准（contentHash）、
 * 以及与写入成败无关的 plan 派生结论（skippedTargets + 三类提示，见 sync-notices）。
 */
export interface SyncResultBase {
  readonly scope: Scope;
  readonly userSoTRoot: string;
  readonly projectSoTRoot: string;
  /** sync-meta.json 所在 SoT 根（effectiveScope 对应层，Spec §3.3）。 */
  readonly sotRoot: string;
  readonly contentHash: string;
  /** profile.targets 中已启用但注册表无 projector 的 target。 */
  readonly skippedTargets: readonly string[];
  /** 命令跳过 / MCP transport 落差 / 会话钩子降级；三类都不进 `warnings`。 */
  readonly advisories: SyncAdvisories;
}

/** apply 走完之后才有的事实（dry-run 一律取空 / null）。 */
export interface AppliedSyncFacts {
  /** soft 项（§8.6）apply 失败收集的 warning。 */
  readonly warnings: readonly SyncWarning[];
  /** 事务设施级警告（崩溃恢复降级 / 保留的失败备份目录）。 */
  readonly transactionWarnings: readonly SyncWarning[];
  /** `.gitignore` 的投影结果（未产出该项 → null）。 */
  readonly gitignore: SyncTargetResult | null;
  /** 本次取锁后从上次强杀里恢复的落盘备份明细。 */
  readonly recovered: readonly SyncRollbackEntry[];
  /** §7.6 差集清理结果。 */
  readonly prune: SyncPruneResult;
}

/** 把 base 的共享字段摊平进结果对象（两个 builder 唯一的公共来源）。 */
function spreadBase(
  base: SyncResultBase,
): Omit<
  SyncResult,
  | 'dryRun'
  | 'targets'
  | 'warnings'
  | 'transactionWarnings'
  | 'gitignore'
  | 'recovered'
  | 'pruned'
  | 'pruneSkipped'
> {
  return {
    scope: base.scope,
    userSoTRoot: base.userSoTRoot,
    projectSoTRoot: base.projectSoTRoot,
    sotRoot: base.sotRoot,
    contentHash: base.contentHash,
    skippedTargets: base.skippedTargets,
    commandSkips: base.advisories.commandSkips,
    mcpTransportNotices: base.advisories.mcpTransportNotices,
    sessionHookNotices: base.advisories.sessionHookNotices,
  };
}

/**
 * dry-run 的结果：完整计划 + 全部提示，逐项 status 恒为 `planned`。
 *
 * `pruned` / `pruneSkipped` 恒空：差集要在本轮产物落定后才成立，而 dry-run 什么都
 * 不写。`recovered` 恒空：崩溃恢复在锁内执行，dry-run 不取锁。
 */
export function buildDryRunSyncResult(
  base: SyncResultBase,
  planned: readonly PlannedTarget[],
  gitignoreItem: ProjectionPlanItem | undefined,
): SyncResult {
  return {
    ...spreadBase(base),
    dryRun: true,
    targets: planned.map((t) => ({
      targetId: t.targetId,
      items: t.plan.items,
      statuses: t.plan.items.map(() => 'planned' as const),
    })),
    warnings: [],
    transactionWarnings: [],
    gitignore:
      gitignoreItem === undefined
        ? null
        : { targetId: GITIGNORE_TARGET_ID, items: [gitignoreItem], statuses: ['planned'] },
    recovered: [],
    pruned: [],
    pruneSkipped: [],
  };
}

/** apply 全部成功后的结果：逐项取实际执行状态，事务侧事实由 applied 带入。 */
export function buildAppliedSyncResult(
  base: SyncResultBase,
  planned: readonly PlannedTarget[],
  applied: AppliedSyncFacts,
): SyncResult {
  return {
    ...spreadBase(base),
    dryRun: false,
    targets: planned.map((t) => ({
      targetId: t.targetId,
      items: t.plan.items,
      statuses: t.statuses,
    })),
    warnings: applied.warnings,
    transactionWarnings: applied.transactionWarnings,
    gitignore: applied.gitignore,
    recovered: applied.recovered,
    pruned: applied.prune.pruned,
    pruneSkipped: applied.prune.skipped,
  };
}
