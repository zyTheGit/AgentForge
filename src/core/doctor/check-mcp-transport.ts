/**
 * MCP transport 能力落差检查（Spec §9 + Phase 2「MCP 字段与上游对齐」）。
 *
 * 为什么单独成模块：判据完全来自 projectors/mcp-transport 的能力矩阵（transport ×
 * target），与 check-consistency 里那批「这次 sync 会不会失败」的检查没有共享前提，
 * 混进去只会让那个文件继续膨胀。
 *
 * 口径同 skills-copy-mode / learning-auto-capture 那一类「声明 vs 实际」：
 * - 恒**不影响退出码**（warn 不参与 §6.1 的码计算）——投影结果就是该 target 能达到
 *   的最佳形态，是上游的能力边界，不是 AgentForge 的错误；
 * - 但绝不静默：不说出来，用户会以为 `transport: sse` 在 codex 里生效了。
 *
 * 只检查 `profile.targets` 里启用的 target：没启用的 target 报能力落差是噪音。
 */
import type { EffectiveConfig } from '../config/defaults';
import { collectMcpTransportNoticesForTargets } from '../project/projectors/mcp-transport';
import type { DoctorCheckResult } from './check-types';

/**
 * transport × target 能力落差（降级 → warn、跳过 → warn；无落差 → 单条 ok）。
 *
 * item 命名 `mcp-transport/<target>/<server>`：同一个 server 可能在多个 target 上
 * 各有一条结论（sse 在 codex 是跳过、在 opencode 是降级），不带 target 会撞名。
 */
export function checkMcpTransport(results: DoctorCheckResult[], config: EffectiveConfig): void {
  const servers = config.profile.mcp.servers ?? [];
  if (servers.length === 0) {
    results.push({
      section: 'config',
      level: 'ok',
      item: 'mcp-transport',
      detail: 'profile.mcp.servers 未声明（无 MCP 投影内容）',
    });
    return;
  }

  const notices = collectMcpTransportNoticesForTargets(config.profile.targets, servers);
  if (notices.length === 0) {
    results.push({
      section: 'config',
      level: 'ok',
      item: 'mcp-transport',
      detail: `${servers.length} 个 MCP server 的 transport 在启用的 target（${config.profile.targets.join(' / ')}）上均可无损表达`,
    });
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
