/**
 * Sync 的**提示类**产出（Spec §7.3 输出 / §7.4 / §8.8.4 / Phase 2「MCP 字段与上游
 * 对齐」）：不是失败、也不是 soft 失败，只是"这次投影里有件事用户必须知道"。
 *
 * 三类结论放在同一个模块，因为它们是**同一种东西**——plan 派生的结论：
 * - 只由「SoT 声明」×「本轮投影哪些 target」决定，与写入成败无关 → dry-run 也照样
 *   给（用户在真写之前就该看到 codex 会跳掉哪条、哪几家的钩子等同 off）；
 * - **刻意不并进 `SyncResult.warnings`**：`writeSyncMetaOnSuccess` 按
 *   `warnings[].targetId` 判定「该 target 投影不完整 → 本轮不记账」（见 sync-verify
 *   的 JSDoc）。这三类都是**设计如此**的边界、投影仍然完整，混进 warnings 会让那个
 *   target 的 `artifacts` 记账整轮丢失 → §7.6 的 prune 从此永远清不掉它的产物。
 *
 * 三个来源：
 * - **命令薄壳整项跳过**（§8.8.4）：codex 的 project scope 不支持命令文件；
 * - **MCP transport 能力落差**（Phase 2）：某个 target 表达不了某个 server 的
 *   transport 时的降级 / 跳过（判据与文案的单一事实源在 `projectors/mcp-transport`
 *   的能力矩阵，这里只负责"本轮投影哪些 target"这一层过滤）；
 * - **`learning.auto_capture: hook` 的 target 支持度**（§7.4）：声明了 hook，但启用的
 *   target 里有几家没有可声明式写入的会话钩子（opencode / pi 需要投放可执行的
 *   plugin / extension 代码，claude 的钩子只能并入共享的 `.claude\settings.json`
 *   数组——详见 docs/learning.md 的支持矩阵与理由）。这些 target 在 hook 档下
 *   **行为等同 off**，必须说出来，不能静默。
 *
 * 单独成模块而不是留在 engine.ts 里：engine.ts 只留 syncOnce 的阶段编排（同
 * sync-prune / sync-gitignore 的划分口径）。数据形状（`SyncCommandSkip` /
 * `SyncNotice`）在 sync-types、`McpTransportNotice` 在 projectors/mcp-transport，
 * 这里只放"本轮该报哪几条"的判定。
 *
 * 全部纯函数、不碰 IO：engine 在 plan 之后、写入之前调 `collectSyncAdvisories`
 * 一次，dry-run 与实际写入走同一份结论。
 */
import type { McpServer, Profile } from '../../schema';
import type { Scope } from '../env';
import { effectiveAutoCapture, writesSessionHooks } from '../learning/auto-capture';
import { CODEX_PROJECT_COMMANDS_SKIP_REASON } from './commands';
import {
  collectMcpTransportNoticesForTargets,
  type McpTransportNotice,
} from './projectors/mcp-transport';
import type { SyncCommandSkip, SyncNotice } from './sync-types';
import type { Projector } from './types';

/** `learning.auto_capture: hook` 下不支持钩子写入的 target 的提示 item。 */
export const SESSION_HOOK_NOTICE_ITEM = 'learning-auto-capture-hook';

/**
 * 声明了 hook 但该 target 没有钩子落点时的提示文案（doctor 与 sync 共用一句，
 * 两处措辞分叉会让用户以为是两件事）。
 */
export function sessionHookUnsupportedMessage(targetId: string): string {
  return `${targetId} 没有可声明式写入的会话钩子落点，learning.auto_capture: hook 对该 target 等同 off（其余产物照常投影）`;
}

/**
 * 支持会话钩子写入的 target id（按 projector 的能力声明筛，升序稳定）。
 *
 * 从 projector 读而不是维护一张外部映射表：能力与"钩子落在哪个文件"是同一份
 * target 知识，写在各 projector 里，新增 target 时 TS 会强制补上
 * （同 `skillInvokePrefix` 的既有先例）。
 */
export function hookCapableTargetIds(projectors: readonly Projector[]): string[] {
  return projectors
    .filter((p) => p.writesSessionHooks)
    .map((p) => p.id)
    .sort();
}

/**
 * 把本次参与的 target 按"有没有钩子落点"分成两半（纯函数）。
 *
 * sync 只需要 incapable（打降级提示），`aforge status` / `aforge doctor` 两边都要
 * （如实说明"钩子会装到哪几家、哪几家等同 off"）。共用这一处切分，三个出口才不会
 * 各自维护一份口径。
 *
 * @param writesHooks 本次是否处于 hook 档（调用方经
 *   `learning/auto-capture.writesSessionHooks(effectiveAutoCapture(profile))` 判定）。
 * @param targetIds 本次参与的 target id（sync 传 `--targets` 过滤后的名单，
 *   status / doctor 传 `profile.targets`）。
 * @param projectors 用于查能力的 projector 全集。
 * @returns 非 hook 档 → 两侧都空（这一档根本不写钩子，报告支持度只是噪音）。
 */
export function partitionSessionHookTargets(
  writesHooks: boolean,
  targetIds: readonly string[],
  projectors: readonly Projector[],
): { readonly capable: readonly string[]; readonly incapable: readonly string[] } {
  if (!writesHooks) {
    return { capable: [], incapable: [] };
  }
  const capableIds = new Set(hookCapableTargetIds(projectors));
  return {
    capable: targetIds.filter((id) => capableIds.has(id)),
    incapable: targetIds.filter((id) => !capableIds.has(id)),
  };
}

/**
 * 收集 hook 档的降级提示（纯函数）。
 *
 * @param writesHooks 本次是否处于 hook 档（同 partitionSessionHookTargets）。
 * @param targetIds 本次参与投影的 target id（`--targets` 过滤之后的名单——
 *   没参与的 target 这轮什么都没写，替它报降级只是噪音）。
 * @param projectors 用于查能力的 projector 全集。
 * @returns 每个不支持钩子的 target 一条提示；非 hook 档 → 空数组。
 */
export function collectSessionHookNotices(
  writesHooks: boolean,
  targetIds: readonly string[],
  projectors: readonly Projector[],
): SyncNotice[] {
  return partitionSessionHookTargets(writesHooks, targetIds, projectors).incapable.map(
    (targetId) => ({
      targetId,
      item: SESSION_HOOK_NOTICE_ITEM,
      message: sessionHookUnsupportedMessage(targetId),
    }),
  );
}

/** collectSyncAdvisories 的入参（全部取自 engine 已算好的本轮事实，不重新推导）。 */
export interface SyncAdvisoryInput {
  readonly profile: Profile;
  readonly scope: Scope;
  /**
   * §8.8 本轮是否有要产出的命令薄壳。
   *
   * 取 boolean 而非数组：判据只关心「有没有」，而入参里另有 `targetIds` /
   * `mcpServers` 两个数组——收 `readonly unknown[]` 时把它们中的任一个误传进来 TS 不
   * 会拦，条数还刚好能让判定"看起来成立"。调用方写 `commandsToExpose.length > 0`。
   */
  readonly hasCommandsToExpose: boolean;
  /** 本轮实际参与投影的 target id（`--targets` 过滤且注册表命中之后）。 */
  readonly targetIds: readonly string[];
  readonly projectors: readonly Projector[];
  /** SoT 声明的 MCP server 全集（`enabled: false` 的过滤在能力矩阵侧做）。 */
  readonly mcpServers: readonly McpServer[];
}

/**
 * §8.8.4：codex 的 project scope 不支持命令文件 → 记一条 skipped 供命令层打印。
 *
 * 判据三条同时成立才记：本轮确有要暴露的命令、scope 是 project、codex 在投影列表里。
 */
export function collectCommandSkips(input: SyncAdvisoryInput): SyncCommandSkip[] {
  const hit =
    input.hasCommandsToExpose && input.scope === 'project' && input.targetIds.includes('codex');
  return hit ? [{ targetId: 'codex', reason: CODEX_PROJECT_COMMANDS_SKIP_REASON }] : [];
}

/**
 * 本轮的全部提示类产出。
 *
 * **三类分开保存而不是压成一个数组**：三者的载荷不同构——`SyncCommandSkip` 是
 * targetId + reason，`SyncNotice` 是 targetId + item + message，
 * `McpTransportNotice` 还带 serverName / transport / support / hint，命令层要按
 * `support` 选 `skipped` / `degraded` 标签并把 hint 单独打一行 dim。压成一条
 * message 字符串会让这些结构化字段（以及 doctor 的 `hint` 出口）全部退化成不可
 * 解析的文本。共同的**不变式**（不进 warnings、dry-run 也给）由本模块的 JSDoc 与
 * 单一入口 `collectSyncAdvisories` 保证，不靠"塞进同一个数组"来表达。
 */
export interface SyncAdvisories {
  readonly commandSkips: readonly SyncCommandSkip[];
  readonly mcpTransportNotices: readonly McpTransportNotice[];
  readonly sessionHookNotices: readonly SyncNotice[];
}

/**
 * 汇总本轮提示（纯函数）：命令薄壳跳过（§8.8.4）+ MCP transport 落差（Phase 2）+
 * hook 档 target 降级（§7.4）。
 *
 * 三类一起算而不是散在 engine 各处：它们的共同点是"投影是完整的，但有件事必须
 * 告诉用户"，且都必须在 dry-run 下也成立。engine 只管把结论塞进 SyncResult。
 */
export function collectSyncAdvisories(input: SyncAdvisoryInput): SyncAdvisories {
  return {
    commandSkips: collectCommandSkips(input),
    // targetIds 已被 filterTargets 限定在四个注册 target 内（能力矩阵按 id 查表）
    mcpTransportNotices: collectMcpTransportNoticesForTargets(input.targetIds, input.mcpServers),
    sessionHookNotices: collectSessionHookNotices(
      writesSessionHooks(effectiveAutoCapture(input.profile)),
      input.targetIds,
      input.projectors,
    ),
  };
}
