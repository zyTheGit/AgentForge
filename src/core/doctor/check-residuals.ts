/**
 * 事务残留盘点 → 诊断结果（Spec §9）。
 *
 * 为什么单独成模块：残留只读盘点的事实来自 sync-residuals.inspectSyncResiduals
 * （直接指实现模块而不经 engine 门面：门面会把整个 sync 引擎图拖进 doctor），doctor
 * 侧的职责仅是「每类残留该报什么级别、给什么提示」——这套 level/hint 取舍（见下
 * 方 JSDoc）是最容易被误改成"一律 warn + 删掉即可"的地方，独立成文件让它带着
 * 理由一起被看到，也避免与其他检查项混在一个长文件里。
 */
import type { Host } from '../../infra/host';
import type { OsContext } from '../paths';
import {
  inspectClaudeLegacyUserMcp,
  inspectPiLegacyMcp,
  inspectSyncResiduals,
  type SyncResidual,
} from '../project/sync-residuals';
import type { DoctorCheckResult } from './check-types';

/**
 * 事务残留 → 诊断结果（§9；level/hint 的取舍见下）。
 *
 * `lock-live` 报 ok 而非 warn：另一个 sync 正在写入是**正常并发**，报警会诱导用户
 * 去删别人正在用的锁。`backup-failed` 的 hint 绝不能提"删掉即可"——那是回滚不完整
 * 时用户手上唯一的原文副本，必须先核对再由用户自己处置。
 */
export async function residualResults(
  host: Host,
  sotRoot: string,
  os: OsContext,
): Promise<DoctorCheckResult[]> {
  const residuals = await inspectSyncResiduals(host, sotRoot, os);
  if (residuals.length === 0) {
    return [
      { section: 'consistency', level: 'ok', item: 'residuals', detail: `无事务残留: ${sotRoot}` },
    ];
  }
  return residuals.map((residual) => ({
    section: 'consistency' as const,
    level: residual.kind === 'lock-live' ? ('ok' as const) : ('warn' as const),
    item: `residual/${residual.kind}`,
    detail: `${residual.detail}\n  ${residual.path}`,
    hint: residualHint(residual),
  }));
}

/** 每类残留的可操作提示（`lock-live` 无需动作 → undefined）。 */
function residualHint(residual: SyncResidual): string | undefined {
  switch (residual.kind) {
    case 'lock-live':
      return undefined;
    case 'lock-stale':
      return '确认无 aforge 进程在运行后删除该锁目录；下次 sync 也会在超过陈旧阈值时自行抢占';
    case 'journal-pending':
      return '下次 aforge sync 会据此日志回滚上次被中断的写入，通常无需手工处理';
    case 'backup-failed':
      return '这是上次回滚未能恢复的文件的唯一备份副本：请先与当前投影文件逐一核对，确认无需恢复后再自行删除该目录';
    case 'pi-legacy-mcp':
      return '升级前的旧落点：确认同目录 mcp.json 已生效后，手工删除这份 settings.json 里的 mcpServers 键（或整个文件，若其中没有你自己的 pi 设置）';
    case 'claude-legacy-user-mcp':
      return 'claude 从不读它当 user 级配置，aforge 也不再投影这里：确认不需要后手工删除这份文件里的 mcpServers 键（整份文件没有你自己的配置时可直接删除）。要让 MCP 在 claude 的所有项目里生效，请用 claude mcp add --scope user <name> -- <command>';
  }
}

/**
 * pi 历史 MCP 落点残留 → 诊断结果（§9；只诊断不删，见 inspectPiLegacyMcp）。
 *
 * 级别取 warn 而非 error：旧文件不影响新落点生效，但两份含 `mcpServers` 的文件并存
 * 时用户无从判断哪份在用——必须报出来，否则 doctor 全绿而盘上有歧义。
 */
export async function piLegacyMcpResults(
  host: Host,
  projectRoot: string,
  userProfile: string | undefined,
  os: OsContext,
): Promise<DoctorCheckResult[]> {
  return legacyMcpResults(await inspectPiLegacyMcp(host, projectRoot, userProfile, os));
}

/**
 * claude 的 user scope MCP 历史落点残留 → 诊断结果（issue #52；只诊断不删）。
 *
 * 级别同 pi 那条取 warn：这份文件不影响任何现行落点，但它里面躺着 AgentForge 曾经
 * 认领的 server 键、而 §7.6 的 prune 再也碰不到那个路径（理由见
 * `inspectClaudeLegacyUserMcp`）——不报出来就是永久孤儿且 doctor 全绿。
 */
export async function claudeLegacyUserMcpResults(
  host: Host,
  projectRoot: string,
  userProfile: string | undefined,
  os: OsContext,
): Promise<DoctorCheckResult[]> {
  return legacyMcpResults(await inspectClaudeLegacyUserMcp(host, projectRoot, userProfile, os));
}

/** 历史落点残留 → warn 结果（两个来源共用一份映射，级别 / 形状不会分叉）。 */
function legacyMcpResults(residuals: readonly SyncResidual[]): DoctorCheckResult[] {
  return residuals.map((residual) => ({
    section: 'consistency' as const,
    level: 'warn' as const,
    item: `residual/${residual.kind}`,
    detail: `${residual.detail}\n  ${residual.path}`,
    hint: residualHint(residual),
  }));
}
