/**
 * MCP 投影的「声明 vs 实际」检查（Spec §9 + Phase 2「MCP 字段与上游对齐」+ issue #52）。
 *
 * 两类判据、同一种性质：
 * - **transport × target 能力落差**：来自 projectors/mcp-transport 的能力矩阵；
 * - **scope × target 落点不可写**：来自 projectors/claude 的 `claudeMcpPath`
 *   （user scope 返回 null → 整项不投影）。
 *
 * 为什么单独成模块：两者都与 check-consistency 里那批「这次 sync 会不会失败」的检查
 * 没有共享前提，混进去只会让那个文件继续膨胀。
 *
 * 口径同 skills-copy-mode / learning-auto-capture 那一类「声明 vs 实际」：
 * - 恒**不影响退出码**（warn 不参与 §6.1 的码计算）——投影结果就是该 target 能达到
 *   的最佳形态，是上游的能力边界，不是 AgentForge 的错误；
 * - 但绝不静默：不说出来，用户会以为 `transport: sse` 在 codex 里生效了、或者以为
 *   `aforge mcp add --scope user` 之后 claude 里就有这个 server。
 *
 * 只检查 `profile.targets` 里启用的 target：没启用的 target 报能力落差是噪音。
 */
import type { EffectiveConfig } from '../config/defaults';
import { CLAUDE_USER_MCP_SKIP_REASON } from '../project/projectors/claude';
import {
  collectMcpTransportNoticesForTargets,
  collectUnmeasuredMcpTransportTargets,
  enabledMcpServerNames,
  isMcpProjectionTargetId,
  MCP_TRANSPORT_UNMEASURED_HINT,
  mcpTransportUnmeasuredItem,
  mcpTransportUnmeasuredReason,
} from '../project/projectors/mcp-transport';
import { CLAUDE_USER_MCP_NOTICE_ITEM } from '../project/sync-notices';
import type { DoctorCheckResult } from './check-types';

/**
 * transport × target 能力落差（降级 → warn、跳过 → warn；无落差 → 单条 ok）。
 *
 * item 命名 `mcp-transport/<target>/<server>`：同一个 server 可能在多个 target 上
 * 各有一条结论（sse 在 codex 是跳过、在 opencode 是降级），不带 target 会撞名。
 */
export function checkMcpTransport(results: DoctorCheckResult[], config: EffectiveConfig): void {
  const servers = config.profile.mcp.servers ?? [];
  // 早退看**启用**的条数，与 collectUnmeasuredMcpTransportTargets / collectMcpScopeNotices
  // 同口径：全部 enabled: false 时一条都不投影，说"N 个 server 均可无损表达"是假结论
  const enabledCount = enabledMcpServerNames(servers).length;
  if (enabledCount === 0) {
    results.push({
      section: 'config',
      level: 'ok',
      item: 'mcp-transport',
      detail:
        servers.length === 0
          ? 'profile.mcp.servers 未声明（无 MCP 投影内容）'
          : `profile.mcp.servers 的 ${servers.length} 个 server 全部 enabled: false（无 MCP 投影内容）`,
    });
    return;
  }

  // 矩阵外的 target 先各出一条占位 warn：落差判定对它们压根没跑，下面的结论
  // （无论 ok 还是 warn）都只覆盖已实测 target，不能让它们混在同一句里
  for (const targetId of collectUnmeasuredMcpTransportTargets(config.profile.targets, servers)) {
    results.push({
      section: 'config',
      level: 'warn',
      item: mcpTransportUnmeasuredItem(targetId),
      detail: mcpTransportUnmeasuredReason(targetId),
      hint: MCP_TRANSPORT_UNMEASURED_HINT,
    });
  }
  // 已实测集合由守卫**正向**判定，不拿 unmeasured 的补集算：那个函数带 enabled 过滤，
  // 空结果既可能是"全是内置 id"也可能是"没有启用的 server"，补集会把后者算成全集
  const measuredTargets = [...new Set(config.profile.targets.filter(isMcpProjectionTargetId))];

  const notices = collectMcpTransportNoticesForTargets(config.profile.targets, servers);
  if (notices.length === 0) {
    // 一个已实测 target 都没有时不给这条 ok：对空集合说"均可无损表达"是假结论，
    // 情况已由上面每 target 一条的 unmeasured warn 说清
    if (measuredTargets.length > 0) {
      results.push({
        section: 'config',
        level: 'ok',
        item: 'mcp-transport',
        detail: `${enabledCount} 个启用的 MCP server 的 transport 在已实测 target（${measuredTargets.join(' / ')}）上均可无损表达`,
      });
    }
    return;
  }

  for (const notice of notices) {
    results.push({
      section: 'config',
      level: 'warn',
      item: `mcp-transport/${notice.targetId}/${notice.serverName}`,
      detail:
        notice.support === 'unsupported'
          ? `${notice.detail}（该 server 在 ${notice.targetId} 侧整条跳过）`
          : `${notice.detail}（仍会投影，但连接行为降级）`,
      hint: notice.hint,
    });
  }
}

/**
 * user scope + claude 启用 + 确有 MCP 声明 → warn：该项整项不投影（issue #52）。
 *
 * 与 sync 的 `mcpScopeNotices` 是同一件事：同一个 item 名、同一句文案
 * （`CLAUDE_USER_MCP_SKIP_REASON`）——两处措辞分叉会让用户以为是两件事。判据在这里
 * 独立成立（doctor 不跑 plan，也不该为拿一条提示去造一次 sync），三条与
 * `sync-notices.collectMcpScopeNotices` 逐条对应：effective scope 是 user、claude 在
 * `profile.targets` 里、`mcp.servers` 非空。
 *
 * 级别 warn 而非 error：project scope 的 `.mcp.json` 照常投影，claude 的其余产物
 * （CLAUDE.md / skills / commands）也照常投影，这次 sync 是成功的。
 */
export function checkClaudeUserScopeMcp(
  results: DoctorCheckResult[],
  config: EffectiveConfig,
): void {
  const hit =
    config.effectiveScope === 'user' &&
    config.profile.targets.includes('claude') &&
    (config.profile.mcp.servers ?? []).length > 0;
  if (!hit) {
    return;
  }
  results.push({
    section: 'config',
    level: 'warn',
    item: CLAUDE_USER_MCP_NOTICE_ITEM,
    detail: CLAUDE_USER_MCP_SKIP_REASON,
    hint: '要走投影就把这些 server 声明放到项目层（aforge mcp add --scope project → .mcp.json），否则按上面的命令在 claude 侧手工登记 user 级 MCP',
  });
}
