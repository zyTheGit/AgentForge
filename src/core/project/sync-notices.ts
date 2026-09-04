/**
 * Sync 的**提示类**产出（Spec §7.3 输出 / §7.4 / §8.8.4 / Phase 2「MCP 字段与上游
 * 对齐」/「skills 按需装载」）：不是失败、也不是 soft 失败，只是"这次投影里有件事
 * 用户必须知道"。
 *
 * 五类结论放在同一个模块，因为它们是**同一种东西**——与写入成败无关的本轮结论：
 * - 只由「SoT 声明」×「本轮投影哪些 target」决定 → dry-run 也照样给（用户在真写
 *   之前就该看到 codex 会跳掉哪条、哪几家的钩子等同 off、哪个技能没备上货）；
 * - **刻意不并进 `SyncResult.warnings`**：`writeSyncMetaOnSuccess` 按
 *   `warnings[].targetId` 判定「该 target 投影不完整 → 本轮不记账」（见 sync-verify
 *   的 JSDoc）。这五类都是**设计如此**的边界、投影仍然完整，混进 warnings 会让那个
 *   target 的 `artifacts` 记账整轮丢失 → §7.6 的 prune 从此永远清不掉它的产物。
 *
 * 五个来源：
 * - **命令薄壳整项跳过**（§8.8.4）：codex 的 project scope 不支持命令文件；
 * - **MCP transport 能力落差**（Phase 2）：某个 target 表达不了某个 server 的
 *   transport 时的降级 / 跳过（判据与文案的单一事实源在 `projectors/mcp-transport`
 *   的能力矩阵，这里只负责"本轮投影哪些 target"这一层过滤）；
 * - **MCP 落点不可安全写入**（issue #52）：claude 的 user 级 MCP 只认
 *   `~\.claude.json`，而那是 claude 的运行时状态转储 → 整项不投影（判据的单一事实源
 *   是 `projectors/claude.claudeMcpPath`，文案是同文件的
 *   `CLAUDE_USER_MCP_SKIP_REASON`）；
 * - **`learning.auto_capture: hook` 的 target 支持度**（§7.4）：声明了 hook，但启用的
 *   target 里有几家没有可声明式写入的会话钩子（opencode / pi 需要投放可执行的
 *   plugin / extension 代码，claude 的钩子只能并入共享的 `.claude\settings.json`
 *   数组——详见 docs/learning.md 的支持矩阵与理由）。这些 target 在 hook 档下
 *   **行为等同 off**，必须说出来，不能静默；
 * - **`skills.on_demand` 未按预期物化**（Phase 2「skills 按需装载」）：名单里的技能
 *   没装 / 被 `always` 遮蔽 / frontmatter 缺失或非法而无处注入按需标记。判定发生在
 *   更早的 `sync-prepare.resolveSkillsForProjection`（读 SoT 时就定了），本模块
 *   **不重算**，只负责把它归到同一个通道上。
 *
 * 单独成模块而不是留在 engine.ts 里：engine.ts 只留 syncOnce 的阶段编排（同
 * sync-prune / sync-gitignore 的划分口径）。数据形状（`SyncCommandSkip` /
 * `SyncNotice` / `SyncSkillSkip`）在 sync-types、`McpTransportNotice` 在
 * projectors/mcp-transport，这里只放"本轮该报哪几条"的判定。
 *
 * 全部纯函数、不碰 IO：engine 在 plan 之后、写入之前调 `collectSyncAdvisories`
 * 一次，dry-run 与实际写入走同一份结论。
 */
import type { McpServer, Profile } from '../../schema';
import type { Scope } from '../env';
import { effectiveAutoCapture, writesSessionHooks } from '../learning/auto-capture';
import { CODEX_PROJECT_COMMANDS_SKIP_REASON } from './commands';
import { CLAUDE_USER_MCP_SKIP_REASON } from './projectors/claude';
import {
  collectMcpTransportNoticesForTargets,
  collectUnmeasuredMcpTransportTargets,
  enabledMcpServerNames,
  type McpTransportNotice,
} from './projectors/mcp-transport';
import type { SyncCommandSkip, SyncNotice, SyncSkillSkip } from './sync-types';
import type { Projector } from './types';

/** `learning.auto_capture: hook` 下不支持钩子写入的 target 的提示 item。 */
export const SESSION_HOOK_NOTICE_ITEM = 'learning-auto-capture-hook';

/**
 * user scope 下 claude 的 MCP 整项不投影的提示 item（doctor 侧同名，issue #52）。
 */
export const CLAUDE_USER_MCP_NOTICE_ITEM = 'mcp-scope/claude-user';

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
 * 有 MCP 落点的 target id（按 projector 的 `writesMcp` 能力声明筛，升序稳定）。
 *
 * 与 `hookCapableTargetIds` 同一处理口径：能力声明住在各 projector 里，这里只筛。
 * 唯一消费方是 unmeasured 占位提示——只投 `main_rule` / `skills_dir` 的声明式适配器
 * 压根没有 MCP 产物，不该收到 transport 相关的任何结论。
 */
export function mcpCapableTargetIds(projectors: readonly Projector[]): string[] {
  return projectors
    .filter((p) => p.writesMcp)
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
  /**
   * `skills.on_demand` 的物化跳过项，来自 `sync-prepare.resolveSkillsForProjection`。
   *
   * 与其余三类不同，这一类**不是本模块算出来的**：判定要读 SoT（技能装没装、
   * frontmatter 合不合法），发生在 plan 之前，本模块是纯函数、不碰 IO，重算既做不到
   * 也必然与 sync-prepare 的判据漂移。
   *
   * 直接收结论数组而不是整个 `ResolvedSkills`：这里一行都用不到 `artifacts`，收窄
   * 到实际依赖面能避免把 sync-notices 绑在 sync-prepare 的内部形状上。
   */
  readonly skillSkips: readonly SyncSkillSkip[];
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
 * user scope 下 claude 的 MCP 整项不投影 → 记一条提示（issue #52）。
 *
 * 判据三条同时成立才记：effective scope 是 user、claude 在本轮投影列表里、SoT 里
 * 确有 **enabled** 的 server。第三条不能省——一条 server 都没声明时，「这项没投影」
 * 是废话，报出来只是噪音（口径与 accountMcpServers / merge_json 载荷同源：
 * `enabled: false` 不算）。
 *
 * 为什么在这里判而不在 projector 里：projector.plan 是纯函数、只产出"写什么"，
 * 它没有"该向用户说什么"的出口；而这里已经拿到 scope / targetIds / mcpServers 三个
 * 本轮事实，与 collectCommandSkips 的形状完全一致。跳过与否的**唯一判据**仍在
 * `claudeMcpPath`（user scope → null），本函数只负责把同一件事说出来。
 */
export function collectMcpScopeNotices(input: SyncAdvisoryInput): SyncNotice[] {
  const hit =
    input.scope === 'user' &&
    input.targetIds.includes('claude') &&
    enabledMcpServerNames(input.mcpServers).length > 0;
  return hit
    ? [
        {
          targetId: 'claude',
          item: CLAUDE_USER_MCP_NOTICE_ITEM,
          message: CLAUDE_USER_MCP_SKIP_REASON,
        },
      ]
    : [];
}

/**
 * 本轮的全部提示类产出。
 *
 * **五类分开保存而不是压成一个数组**：五者的载荷不同构——`SyncCommandSkip` 是
 * targetId + reason，`SyncNotice` 是 targetId + item + message，
 * `McpTransportNotice` 还带 serverName / transport / support / hint，而
 * `SyncSkillSkip` 是 name + reason 且**根本没有 targetId**（说的是 SoT 侧名单，
 * 与投影到哪几家无关）。命令层要按 `support` 选 `skipped` / `degraded` 标签并把
 * hint 单独打一行 dim。压成一条 message 字符串会让这些结构化字段（以及 doctor 的
 * `hint` 出口）全部退化成不可解析的文本。共同的**不变式**（不进 warnings、dry-run
 * 也给）由本模块的 JSDoc 与单一入口 `collectSyncAdvisories` 保证，不靠"塞进同一个
 * 数组"来表达。
 */
export interface SyncAdvisories {
  readonly commandSkips: readonly SyncCommandSkip[];
  readonly mcpTransportNotices: readonly McpTransportNotice[];
  /**
   * 不在 transport 能力矩阵内的 target id（每 target 恰一条，非每 server 一条）。
   *
   * 只带 id：落差判定压根没跑，没有 serverName / transport / support 可填，文案由
   * `mcpTransportUnmeasuredReason` 现算——塞进 `mcpTransportNotices` 得给那三个字段
   * 编空值，读的人分不清"空"是"没有落差"还是"没判定"。
   */
  readonly mcpTransportUnmeasuredTargets: readonly string[];
  /** user scope 下 claude 的 MCP 整项不投影（issue #52；见 collectMcpScopeNotices）。 */
  readonly mcpScopeNotices: readonly SyncNotice[];
  readonly sessionHookNotices: readonly SyncNotice[];
  readonly skillSkips: readonly SyncSkillSkip[];
}

/**
 * 汇总本轮提示（纯函数）：命令薄壳跳过（§8.8.4）+ MCP transport 落差（Phase 2）+
 * MCP 落点不可写（issue #52 claude user scope）+ hook 档 target 降级（§7.4）+
 * `skills.on_demand` 物化跳过（Phase 2）。
 *
 * 五类走同一个出口而不是散在 engine 各处：它们的共同点是"投影是完整的，但有件事
 * 必须告诉用户"，且都必须在 dry-run 下也成立。engine 只管把结论塞进 SyncResult。
 */
export function collectSyncAdvisories(input: SyncAdvisoryInput): SyncAdvisories {
  return {
    commandSkips: collectCommandSkips(input),
    // targetIds 的取值域含声明式适配器 id（knownTargetIds()），不止四个内置 id：
    // 矩阵里没有的 id 由 collect* 内部按 id 守卫跳过，另出一条 unmeasured 占位
    mcpTransportNotices: collectMcpTransportNoticesForTargets(input.targetIds, input.mcpServers),
    mcpTransportUnmeasuredTargets: collectUnmeasuredMcpTransportTargets(
      input.targetIds,
      input.mcpServers,
      mcpCapableTargetIds(input.projectors),
    ),
    mcpScopeNotices: collectMcpScopeNotices(input),
    sessionHookNotices: collectSessionHookNotices(
      writesSessionHooks(effectiveAutoCapture(input.profile)),
      input.targetIds,
      input.projectors,
    ),
    // 只归通道、不重算：判定在 sync-prepare（见 SyncAdvisoryInput.skillSkips）
    skillSkips: input.skillSkips,
  };
}
