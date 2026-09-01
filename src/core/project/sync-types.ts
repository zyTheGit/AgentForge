/**
 * Sync 的对外数据契约（Spec §7.3 / §3.3）：入参、逐项状态、结果、失败汇总。
 *
 * 单独成模块的理由：命令层（sync / status / doctor）与引擎内部各阶段模块都要引用
 * 这些类型，留在 engine.ts 里会让「用一个 interface」变成「依赖引擎实现」，
 * 拆开后阶段模块之间也不必为拿一个类型而互相 import。
 *
 * 失败汇总（SyncFailureReport）以非枚举属性附着在 rethrow 的原始错误上——错误类型
 * 与退出码保持不变（§7.3-6），命令层经 getSyncFailureReport(err) 取回。
 */
import type { Host } from '../../infra/host';
import type { EnvSnapshot, Scope } from '../env';
import type { OsContext } from '../paths';
import type { McpTransportNotice } from './projectors/mcp-transport';
import type { SyncPrunedEntry, SyncPruneSkip } from './sync-prune';
import type { ProjectionPlanItem } from './types';

/** syncOnce 输入（host/os/cwd 由命令层注入；测试可注入 fake host 与任意平台）。 */
export interface SyncOptions {
  readonly host: Host;
  readonly env: EnvSnapshot;
  readonly os: OsContext;
  /** 项目根（project scope 的投影基准，Spec §2.3）。 */
  readonly cwd: string;
  /** CLI 版本（写入 sync-meta.agentforgeVersion，Spec §3.3）。 */
  readonly agentforgeVersion: string;
  /** --targets 过滤（空 / 未给 → profile.targets 全量）。 */
  readonly targetsFilter?: readonly string[];
  readonly dryRun: boolean;
  /** --force（Spec §8.2-4）：跳过 marker 区间冲突预检查，强制覆盖。 */
  readonly force?: boolean;
}

/** 单个投影项的执行状态（apply 后；dry-run 恒为 'planned'）。 */
export type SyncItemStatus = 'planned' | 'written' | 'unchanged' | 'warning';

/** soft 项失败（§8.6 Pi MVP）：不触发回滚的 best-effort 警告。 */
export interface SyncWarning {
  readonly targetId: string;
  readonly path: string;
  readonly message: string;
}

/** 单个 target 的同步结果（items 为完整计划；statuses 与 items 一一对应）。 */
export interface SyncTargetResult {
  readonly targetId: string;
  readonly items: readonly ProjectionPlanItem[];
  readonly statuses: readonly SyncItemStatus[];
}

/**
 * 某 target 的命令薄壳本轮整项跳过（§8.8.4）：目前唯一来源是 codex 的 project scope。
 *
 * 刻意不并进 `warnings`：writeSyncMetaOnSuccess 按 `warnings` 的 targetId 判定
 * 「该 target 投影不完整 → 不记账」，而这里的跳过是**设计如此**、投影仍然完整，
 * 混进去会让 codex 的 artifacts 记账整轮丢失（下一轮就永远不清理它的产物）。
 */
export interface SyncCommandSkip {
  readonly targetId: string;
  readonly reason: string;
}

/** syncOnce 结果：命令层据此打印绝对路径与摘要。 */
export interface SyncResult {
  readonly scope: Scope;
  readonly userSoTRoot: string;
  readonly projectSoTRoot: string;
  /** sync-meta.json 所在 SoT 根（effectiveScope 对应层，Spec §3.3）。 */
  readonly sotRoot: string;
  /**
   * 渲染正文在 marker 区间形态下的 LF 规范化 sha256（= sync-meta contentHash
   * 基准；M7 起统一为 markers.renderedSectionHash，与投影文件读回的
   * markerSectionHash 可直接相等比较）。
   */
  readonly contentHash: string;
  readonly dryRun: boolean;
  readonly targets: readonly SyncTargetResult[];
  /** profile.targets 中已启用但注册表无 projector 的 target（提示用，非失败）。 */
  readonly skippedTargets: readonly string[];
  /** 命令薄壳被整项跳过的 target（§8.8.4：codex + project scope；提示用，非失败）。 */
  readonly commandSkips: readonly SyncCommandSkip[];
  /** soft 项（§8.6）apply 失败收集的 warning（不阻塞 sync）。 */
  readonly warnings: readonly SyncWarning[];
  /**
   * MCP transport 与目标格式的能力落差（Phase 2「MCP 字段与上游对齐」）：
   * 某个 target 表达不了某个 server 的 transport 时的降级 / 跳过结论。
   *
   * 刻意不并进 `warnings`（同 `commandSkips` 的理由）：writeSyncMetaOnSuccess 按
   * `warnings` 的 targetId 判定「该 target 投影不完整 → 不记账」，而能力落差是
   * **上游本身的边界**、投影结果就是该 target 能达到的最佳形态，混进去会让
   * codex / opencode 的 artifacts 记账整轮丢失（下一轮就永远不清理它的产物）。
   */
  readonly mcpTransportNotices: readonly McpTransportNotice[];
  /**
   * 事务设施级警告（**不是**某个 target 的 soft 失败）：崩溃恢复能力降级
   * （备份日志 / 副本写不进去）、保留下来的失败备份目录、恢复阶段需人工核对的条目。
   *
   * 与 warnings 分开：writeSyncMetaOnSuccess 用 warnings 的 targetId 判定
   * 「哪个 target 投影不完整不记账」，把设施级问题混进去会误伤记账。
   */
  readonly transactionWarnings: readonly SyncWarning[];
  /**
   * 项目 `.gitignore` 的投影结果（Spec §4.2 projection.gitignore_generated）：
   * 该开关为 true 且 effective scope=project 时非 null，否则 null。
   *
   * 不并入 `targets`：它不是某个 agent target 的产物，也**不写入 sync-meta**
   * （sync-meta.targets 的 contentHash 是 doctor 的 marker 区间基准，.gitignore
   * 没有规则正文区间可比）。写入仍在同一事务内（备份 / 回滚一视同仁）。
   */
  readonly gitignore: SyncTargetResult | null;
  /**
   * 上次 sync 被强杀（SIGKILL / 断电）后遗留的落盘备份恢复明细（正常为空数组）。
   * 在本次 sync 取锁后、备份阶段之前执行——命令层据此提示用户曾发生崩溃恢复。
   */
  readonly recovered: readonly SyncRollbackEntry[];
  /**
   * 本次清理掉的上一轮残留（Spec §7.6 prune）：不再产出的整文件产物、
   * 以及从 MCP 配置里摘掉的 server 键。dry-run 恒为空数组（见 syncOnce）。
   */
  readonly pruned: readonly SyncPrunedEntry[];
  /**
   * 该清理但被跳过的项：内容与记账不一致（疑似手工修改）、读写失败等。
   * 跳过不影响退出码——残留无害，静默吞掉用户的手工编辑才有害。
   */
  readonly pruneSkipped: readonly SyncPruneSkip[];
}

/** 回滚明细：单文件恢复结果（失败收集 error，不中断其余恢复）。 */
export interface SyncRollbackEntry {
  readonly path: string;
  readonly restored: boolean;
  readonly error?: string;
}

/**
 * 失败汇总报告（§7.3-6）：附着在 rethrow 的原始错误上（getSyncFailureReport
 * 读取），命令层据此输出「每 target 状态表（成功/失败/原因）+ 回滚声明」。
 */
export interface SyncFailureReport {
  /** 失败项所属 target。 */
  readonly failedTargetId: string;
  /** 失败项路径。 */
  readonly failedPath: string;
  /** 全部 target 的终态（按投影顺序；含回滚声明语义）。 */
  readonly targetStatuses: readonly {
    readonly targetId: string;
    /** ok-rolled-back：全部项成功但被回滚；failed：含失败项；not-started：未执行。 */
    readonly status: 'ok-rolled-back' | 'failed' | 'not-started';
  }[];
  /** 逆序恢复的文件明细（restored=false 表示恢复失败）。 */
  readonly rolledBack: readonly SyncRollbackEntry[];
  /**
   * 存在未能恢复的文件时，备份基准被保留到该目录（`.agf-backup-failed-<ts>`）。
   * 命令层必须把它打进失败汇总与退出码 6 的输出——否则用户被告知「手工处理」时
   * 手上没有任何 sync 前的原文。null = 全部恢复成功（无需保留）或保留自身失败。
   */
  readonly preservedBackupDir?: string;
}

/** 失败报告在错误对象上的附加键（非枚举属性，不影响既有错误语义）。 */
const FAILURE_REPORT_KEY = 'agentforgeSyncFailureReport';

/** 读取附着在错误上的失败汇总报告（无 → undefined）。 */
export function getSyncFailureReport(err: unknown): SyncFailureReport | undefined {
  if (typeof err === 'object' && err !== null && FAILURE_REPORT_KEY in err) {
    const report = (err as Record<string, unknown>)[FAILURE_REPORT_KEY];
    return report as SyncFailureReport | undefined;
  }
  return undefined;
}

/**
 * 把失败汇总以**非枚举**属性附着到错误上并原样返回该错误（不改变错误类型与退出码）。
 *
 * 非枚举：JSON 序列化 / 展开 / 遍历都看不见它，既有错误的对外形态不变。
 * 目标不是对象（或 defineProperty 被拒）时静默跳过——附加失败不该盖掉原始错误。
 */
export function attachFailureReport(err: unknown, report: SyncFailureReport): unknown {
  if (typeof err === 'object' && err !== null) {
    try {
      Object.defineProperty(err, FAILURE_REPORT_KEY, {
        value: report,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
      // 附加失败不影响原始错误传播（命令层回退为只打印错误本体）
    }
  }
  return err;
}
