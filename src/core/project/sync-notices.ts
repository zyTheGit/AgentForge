/**
 * plan 之后的「附带结论」收集（Spec §8.8.4 + Phase 2「MCP 字段与上游对齐」）。
 *
 * 这里的两类结论有共同性质，所以放在一个模块：
 * - 只由「SoT 声明」×「本轮投影哪些 target」决定，与写入成败无关 → dry-run 也照样给
 *   （用户在真写之前就该看到 codex 会跳掉哪条）；
 * - **刻意不并进 `warnings`**：writeSyncMetaOnSuccess 按 `warnings` 的 targetId 判定
 *   「该 target 投影不完整 → 不记账」，把上游能力落差塞进 warnings 会连带破坏
 *   §7.6 的差集清理判据。
 *
 * 单独成模块而不是留在 engine.ts 里：engine.ts 只留 syncOnce 的阶段编排
 * （同 sync-prune / sync-gitignore 的划分口径）。
 */
import { CODEX_PROJECT_COMMANDS_SKIP_REASON } from './commands';
import {
  collectMcpTransportNoticesForTargets,
  type McpTransportNotice,
} from './projectors/mcp-transport';
import type { PlannedTarget } from './sync-prepare';
import type { SyncCommandSkip } from './sync-types';
import type { ProjectContext } from './types';

/**
 * §8.8.4：codex 的 project scope 不支持命令文件 → 记一条 skipped 供命令层打印。
 *
 * 判据三条同时成立才记：本轮确有要暴露的命令、scope 是 project、codex 在投影列表里。
 */
export function collectCommandSkips(
  planned: readonly PlannedTarget[],
  ctx: ProjectContext,
): SyncCommandSkip[] {
  const hit =
    ctx.commandsToExpose.length > 0 &&
    ctx.scope === 'project' &&
    planned.some((target) => target.targetId === 'codex');
  return hit ? [{ targetId: 'codex', reason: CODEX_PROJECT_COMMANDS_SKIP_REASON }] : [];
}

/**
 * 本轮 MCP transport 的能力落差（降级 / 跳过）。
 *
 * planned 里的 targetId 已被 filterTargets 限定在四个注册 target 内。
 */
export function collectPlanMcpTransportNotices(
  planned: readonly PlannedTarget[],
  ctx: ProjectContext,
): McpTransportNotice[] {
  return collectMcpTransportNoticesForTargets(
    planned.map((target) => target.targetId),
    ctx.mcpServers,
  );
}
