/**
 * `SyncResult` 的装配（Spec §7.3 输出契约）。
 *
 * 为什么从 engine.ts 拆出来：syncOnce 有**两条**返回路径（dry-run 提前返回、apply
 * 成功返回）。`SyncResult` 共 17 个字段，其中 8 个两条路径取值不同（`dryRun` / 逐项
 * `targets` status / `warnings` / `transactionWarnings` / `gitignore` / `recovered` /
 * `pruned` / `pruneSkipped`），剩下 9 个完全相同。两份字面量并排写在 engine 里，加字段
 * 时漏改一处就会让 dry-run 与实写的输出形态悄悄分叉——`SyncResult` 是命令层唯一的数据
 * 来源，分叉直接表现为「--dry-run 看不到某类提示」。集中到这里之后 engine.ts 只留阶段
 * 编排。
 *
 * **类型能卡住什么、卡不住什么**（别高估 `spreadBase` 的 `Omit`）：
 * - 给 `SyncResult` 加一个**两条路径取值不同**的字段（即同时加进 `Omit` 列表）→ 两个
 *   builder 的字面量都缺字段，两处同时报错。这是主要护栏；
 * - 给 `SyncResult` 加一个**共享**字段（不进 `Omit` 列表）→ 只有 `spreadBase` 的返回
 *   字面量报错一处；两个 builder 因为 `...spreadBase(base)` 在类型上已声明含该字段而
 *   不报错。这恰好是想要的结果（共享字段只该在一处赋值），但**不是**「两个 builder
 *   同时被强制」；
 * - `SyncAdvisories` 加一类提示 → 由 `flattenAdvisories` 的 `satisfies` 报错（见该函数）。
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
 * 以及与写入成败无关的结论（skippedTargets + 五类提示，见 sync-notices）。
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
  /**
   * 命令跳过 / MCP transport 落差 / MCP 落点不可写 / 会话钩子降级 /
   * on_demand 技能跳过；五类都不进 `warnings`。
   */
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

/**
 * `SyncAdvisories` 的五类提示摊平进 `SyncResult` 的顶层字段。
 *
 * `satisfies` 把两边的键集绑在一起：给 `SyncAdvisories` 新增一类提示而忘了在这里摊平
 * → 本对象缺键 → TS 立刻报错。手写摊平且**没有**这道断言时，新增的那类会被
 * `collectSyncAdvisories` 算出来后无声丢弃，命令层永远看不到它，且零编译提示。
 *
 * 为什么不让 `SyncResult` 直接持有 `advisories: SyncAdvisories`：那要把命令层与
 * doctor 的全部读取点改成 `result.advisories.x`（连既有测试断言一起动），diff 远大于
 * 本文件这一处断言换来的等价保证。
 */
function flattenAdvisories(advisories: SyncAdvisories): {
  readonly [K in keyof SyncAdvisories]: SyncAdvisories[K];
} {
  return {
    commandSkips: advisories.commandSkips,
    mcpTransportNotices: advisories.mcpTransportNotices,
    mcpTransportUnmeasuredTargets: advisories.mcpTransportUnmeasuredTargets,
    mcpScopeNotices: advisories.mcpScopeNotices,
    sessionHookNotices: advisories.sessionHookNotices,
    skillSkips: advisories.skillSkips,
  } satisfies { readonly [K in keyof SyncAdvisories]: SyncAdvisories[K] };
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
    ...flattenAdvisories(base.advisories),
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
