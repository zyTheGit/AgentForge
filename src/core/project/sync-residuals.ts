/**
 * SoT 内的 sync 残留物盘点（供 `aforge doctor` / `status` 提示用，Spec §9）。
 *
 * 四类：活锁、陈旧锁、待恢复的 journal、保留下来的失败备份目录。只读不动——清理时机
 * 由下次 sync 在锁内决定，doctor 侧擅自删会与正在运行的 sync 抢资源。
 */
import { listDirSafe } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import { longPathAware, type OsContext, pathApiFor } from '../paths';
import { PI_DIRNAME, PI_USER_DIR_SEGMENTS } from './projectors/pi';
import {
  SYNC_BACKUP_DIRNAME,
  SYNC_BACKUP_FAILED_PREFIX,
  SYNC_BACKUP_JOURNAL_FILE,
} from './sync-artifacts';
import {
  isLockFresh,
  isProcessAlive,
  lockAgeMs,
  machineIdOf,
  readSyncLockRecord,
  SYNC_LOCK_DIRNAME,
  SYNC_LOCK_META_FILE,
  syncLockDir,
  userIdOf,
} from './sync-lock';
import { readBackupJournal } from './sync-recovery';

// ---------------------------------------------------------------------------
// 运行时残留诊断（doctor 用；只读，不清理任何东西）
// ---------------------------------------------------------------------------

/** 残留类型（doctor 按此选级别与文案）。 */
export type SyncResidualKind =
  | 'lock-live'
  | 'lock-stale'
  | 'journal-pending'
  | 'backup-failed'
  | 'pi-legacy-mcp';

/** 单条残留诊断（path 一律给绝对路径，便于用户直接定位）。 */
export interface SyncResidual {
  readonly kind: SyncResidualKind;
  readonly path: string;
  readonly detail: string;
}

/**
 * 体检 SoT 根下的事务残留（`.sync.lock` / `.agf-backup` / `.agf-backup-failed-*`）。
 *
 * **只读**：这个函数不删任何东西。`.agf-backup-failed-*` 是回滚不完整时用户手上
 * 唯一的原文副本，诊断路径上销毁它就是把「请手工处理」和「已被我删掉」同时告知。
 * 清理时机只有两处：正常事务结束、以及下次 sync 的崩溃恢复。
 *
 * 判活口径与 acquireSyncLock 保持一致——同机同用户才信 pid，跨机器的 pid 与本机
 * pid 空间无关，只能按「静默是否超过 SYNC_LOCK_STALE_MS」判断。
 *
 * 探测手段是**列 SoT 根的目录项**而不是 `host.exists(锁目录)`：`exists` 对"目录"的
 * 语义在各 Host 实现下并不一致，而目录项列举对二者都成立。代价是「胜者刚建好锁目录、
 * 还没写 meta.json」的窗口内可能报不出——这对**诊断**可以接受，锁的裁决权在
 * acquireSyncLock 而不在 doctor。
 */
export async function inspectSyncResiduals(
  host: Host,
  sotRoot: string,
  os: OsContext,
): Promise<SyncResidual[]> {
  const found: SyncResidual[] = [];
  const api = pathApiFor(os);
  const names = await listDirSafe(host, sotRoot);

  const lockDir = syncLockDir(sotRoot, os);
  if (names.includes(SYNC_LOCK_DIRNAME)) {
    const holder = await readSyncLockRecord(host, api.join(lockDir, SYNC_LOCK_META_FILE));
    const ageMs = await lockAgeMs(host, lockDir, holder);
    const sameHost =
      holder !== null && holder.machine === machineIdOf(host) && holder.user === userIdOf(host);
    const alive = sameHost && isProcessAlive(holder.pid);
    const fresh = isLockFresh(ageMs);
    const who =
      holder === null ? '持有者未知（元数据不可读）' : `pid ${holder.pid} @ ${holder.acquiredAt}`;
    const silence = Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s` : '未知时长';
    found.push(
      alive || fresh
        ? { kind: 'lock-live', path: lockDir, detail: `锁被持有中：${who}` }
        : { kind: 'lock-stale', path: lockDir, detail: `锁已静默 ${silence}：${who}` },
    );
  }

  return residualBackupsOf(host, sotRoot, os, names, found);
}

/**
 * 备份侧残留：未提交的 journal + 全部 `.agf-backup-failed-*` 目录。
 *
 * journal 的 `committed !== true` 才算残留——已提交的 journal 只是还没被清掉的
 * 尾巴，下次 sync 不会据它回滚，报出来只会制造噪音。
 */
async function residualBackupsOf(
  host: Host,
  sotRoot: string,
  os: OsContext,
  names: readonly string[],
  found: SyncResidual[],
): Promise<SyncResidual[]> {
  const api = pathApiFor(os);
  const journalFile = longPathAware(
    api.join(sotRoot, SYNC_BACKUP_DIRNAME, SYNC_BACKUP_JOURNAL_FILE),
    os,
  );
  const journal = await readBackupJournal(host, journalFile);
  if (journal !== null && journal.committed !== true) {
    const pending = journal.entries.filter((entry) => entry.written).length;
    const startedAt = journal.startedAt || '未知时刻';
    found.push({
      kind: 'journal-pending',
      path: journalFile,
      detail:
        `未提交的事务日志：${journal.entries.length} 个备份条目、${pending} 个已写入` +
        `（起于 ${startedAt}，pid ${journal.pid}）`,
    });
  }

  for (const name of names) {
    if (name.startsWith(SYNC_BACKUP_FAILED_PREFIX)) {
      found.push({
        kind: 'backup-failed',
        path: longPathAware(api.join(sotRoot, name), os),
        detail: '上次 sync 回滚未能全部完成，保留的备份副本（退出码 6）',
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 投影侧的历史落点残留（pi 的 MCP 从 settings.json 迁到 mcp.json）
// ---------------------------------------------------------------------------

/** pi 迁移**前**的 MCP 投影文件名（现落点见 projectors/pi.PI_MCP_FILENAME）。 */
export const PI_LEGACY_MCP_FILENAME = 'settings.json';

/**
 * pi 的历史 MCP 落点残留：`.pi\settings.json`（project）/ `~\.pi\agent\settings.json`
 * （user）**且内容含 `mcpServers` 键**。
 *
 * 为什么需要：MCP 投影落点从 `settings.json` 迁到了 `mcp.json`，但迁移是"换个路径写"
 * ——旧文件既没人删也没人认。sync-meta 从此只记新路径、doctor 全绿，用户盘上却躺着
 * 两份含 `mcpServers` 的文件，无从判断哪份生效（pi 项还是 soft，写成功即静默）。
 *
 * **只诊断不删**（与本模块其他残留项同风格）：这是用户目录里的文件，可能被用户手工
 * 编辑过、也可能含 pi 自己的其他配置键；在 projector 里加自动 delete 会把一个 soft
 * target 变成会删用户文件的路径，风险远大于收益。
 *
 * 判据要求含 `mcpServers` 键：`settings.json` 本身是 pi 的通用设置文件，只有带这个
 * 键才说明它承载过 AgentForge 的 MCP 投影。读不到 / 不是合法 JSON / 不是对象 → 不报。
 *
 * @param projectRoot project scope 的投影基准根（命令层的 cwd）。
 * @param userProfile user scope 的投影基准根（用户目录）；缺失时跳过 user 侧。
 */
export async function inspectPiLegacyMcp(
  host: Host,
  projectRoot: string,
  userProfile: string | undefined,
  os: OsContext,
): Promise<SyncResidual[]> {
  const api = pathApiFor(os);
  const candidates = [api.join(projectRoot, PI_DIRNAME, PI_LEGACY_MCP_FILENAME)];
  if (userProfile !== undefined && userProfile !== '') {
    candidates.push(api.join(userProfile, ...PI_USER_DIR_SEGMENTS, PI_LEGACY_MCP_FILENAME));
  }

  const found: SyncResidual[] = [];
  for (const file of candidates) {
    if (await hasMcpServersKey(host, longPathAware(file, os))) {
      found.push({
        kind: 'pi-legacy-mcp',
        path: file,
        detail:
          'pi 的 MCP 投影已迁到同目录的 mcp.json；这份 settings.json 里的 mcpServers 已不再被 aforge 维护',
      });
    }
  }
  return found;
}

/** 文件是否为含顶层 `mcpServers` 键的 JSON 对象（读不到 / 不合法 → false）。 */
async function hasMcpServersKey(host: Host, file: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await host.readFile(file));
    return typeof parsed === 'object' && parsed !== null && 'mcpServers' in parsed;
  } catch {
    return false;
  }
}
