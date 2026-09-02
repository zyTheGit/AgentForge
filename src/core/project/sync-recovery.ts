/**
 * 崩溃恢复与备份保全（Spec §7.3-6 / §10）：上次 sync 被强杀后的落盘备份处理。
 *
 * 两件事都围绕同一个底线——**绝不让用户在被告知「请手工处理」时手上没有原文**：
 * - recoverPendingTransaction：在锁内检出 `.agf-backup\journal.json`，校验来源
 *   （SoT / 机器 / 用户）与每条目标路径的白名单边界后再恢复；跨机器或越界的
 *   journal 一律不动，只报告；
 * - preserveBackup*：回滚存在 restored=false 的条目时，把备份另存为
 *   `.agf-backup-failed-<ts>\` 并写进失败汇总（退出码 6）。
 */
import path from 'node:path';
import { atomicWrite, mkdirp } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import { isWithinAnyRoot, longPathAware, type OsContext } from '../paths';
import {
  backupStampOf,
  failedBackupDir,
  SYNC_BACKUP_DIRNAME,
  SYNC_BACKUP_JOURNAL_FILE,
} from './sync-artifacts';
import { machineIdOf, userIdOf } from './sync-identity';
import {
  removeBackupArtifacts,
  rollbackWrites,
  type SyncBackupJournal,
  type SyncBackupJournalEntry,
  type SyncTransaction,
} from './sync-transaction';
import type { SyncRollbackEntry } from './sync-types';

/** 时间戳后缀（`.agf-backup-failed-<ts>` 用；文件名安全：只留数字）。 */
function backupStamp(host: Host): string {
  return backupStampOf(host.now());
}

/**
 * 保留一份备份证据到 `.agf-backup-failed-<ts>/`（回滚 / 恢复未能全部完成时）。
 *
 * 为什么必须保留：`restored=false` 的条目在磁盘上留着本次 sync 的**新**内容，其
 * sync 前原文只剩那份 `.bak`——原实现在 finally 里无条件删除备份目录，等于把用户
 * 唯一的原文销毁（内存备份也随进程消失），而命令层的 `rolledBack` 明细还是在删除
 * 之后才打印，提示「手工处理」时已无据可依。
 *
 * 另存而非原地保留：新目录名不叫 `.agf-backup`，因此不会被下次 sync 的
 * recoverPendingTransaction 反复处理；journal 一并另存（含未恢复条目说明）。
 *
 * @param contentOf 取某条目备份内容的方式（事务内取内存备份；崩溃恢复读落盘副本）。
 * @returns 保留目录绝对路径；失败 → null（调用方据此**跳过**清理原备份目录，
 *   宁可留下 `.agf-backup` 也不能让备份消失）。
 */
export async function preserveBackupCopies(
  host: Host,
  os: OsContext,
  sotRoot: string,
  journal: SyncBackupJournal,
  contentOf: (entry: SyncBackupJournalEntry) => Promise<string | null>,
  unresolved: readonly SyncRollbackEntry[],
): Promise<string | null> {
  const dir = longPathAware(
    failedBackupDir(path.join(sotRoot, SYNC_BACKUP_DIRNAME), backupStamp(host)),
    os,
  );
  try {
    await mkdirp(host, dir);
    const entries: SyncBackupJournalEntry[] = [];
    for (const entry of journal.entries) {
      const content = await contentOf(entry);
      if (content === null) {
        entries.push({ ...entry, backupFile: null });
        continue;
      }
      const name = `${String(entries.length).padStart(3, '0')}-${path.basename(entry.path)}.bak`;
      const dest = path.join(dir, name);
      await atomicWrite(host, dest, content);
      entries.push({ ...entry, backupFile: dest });
    }
    const preserved = {
      ...journal,
      entries,
      preservedAt: host.now().toISOString(),
      unresolved,
    };
    await atomicWrite(
      host,
      path.join(dir, SYNC_BACKUP_JOURNAL_FILE),
      `${JSON.stringify(preserved, null, 2)}\n`,
    );
    return dir;
  } catch {
    return null;
  }
}

/** 事务内的备份保留（内存备份即基准，必然可用）。 */
export async function preserveBackupArtifacts(
  tx: SyncTransaction,
  rolledBack: readonly SyncRollbackEntry[],
): Promise<string | null> {
  return preserveBackupCopies(
    tx.host,
    tx.os,
    tx.sotRoot,
    tx.journal,
    async (entry) => tx.backups.get(entry.path) ?? null,
    rolledBack.filter((r) => !r.restored),
  );
}

/** 读残留的备份日志（不存在 / 损坏 → null）。缺省字段按旧版本形态兜底。 */
export async function readBackupJournal(
  host: Host,
  journalFile: string,
): Promise<SyncBackupJournal | null> {
  if (!(await host.exists(journalFile))) {
    return null;
  }
  try {
    const parsed = JSON.parse(await host.readFile(journalFile)) as Partial<SyncBackupJournal>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return null;
    }
    return {
      version: 1,
      pid: typeof parsed.pid === 'number' ? parsed.pid : -1,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      sotRoot: typeof parsed.sotRoot === 'string' ? parsed.sotRoot : '',
      machine: typeof parsed.machine === 'string' ? parsed.machine : '',
      user: typeof parsed.user === 'string' ? parsed.user : '',
      committed: parsed.committed === true,
      entries: parsed.entries.map((entry) => ({
        path: entry.path,
        existedBefore: entry.existedBefore,
        backupFile: entry.backupFile ?? null,
        // 旧版本 journal 无 written 字段：writtenHash 非空即证明写过
        written: entry.written === true || (entry.writtenHash ?? null) !== null,
        writtenHash: entry.writtenHash ?? null,
      })),
    };
  } catch {
    return null;
  }
}

/** 恢复流程的产出：逐条结果 + 无法自动恢复时保留的备份目录。 */
export interface SyncRecoveryOutcome {
  readonly entries: SyncRollbackEntry[];
  readonly preservedDir: string | null;
}

/** 无基准可恢复的提示文案（人工核对，绝不静默丢弃）。 */
const RECOVERY_MANUAL_HINT =
  '上次 sync 未能记录该文件的写入基准（崩溃恢复能力当时已降级），为避免覆盖你的改动未自动恢复，请人工核对';

/**
 * 恢复被强杀（SIGKILL / 断电）的上次事务：在**锁内**、备份阶段之前执行。
 *
 * 安全边界（不可无条件信任 journal——它是磁盘上的普通 JSON，被篡改或串台后
 * 可让恢复流程把备份内容写到任意路径）：
 * - journal.sotRoot 必须落在当前 SoT 根内；
 * - journal.machine / journal.user 必须与当前一致（跨机器 / 跨用户的 journal 只清理）；
 * - 每个条目的目标路径必须落在 `allowedRoots` 白名单内（SoT 根 / 项目根 / 用户根 /
 *   CODEX_HOME / 本次 plan 的目标目录），否则拒绝该条并如实报告。
 *
 * 只回滚 `written=true` 的条目（= 上次确实写过的文件），且沿用同一套基准复核
 * （当前内容 ≠ 上次写入结果 → 报告冲突不覆盖）。`committed=true` 的 journal 表示
 * 上次事务已提交（sync-meta 已写），只清理不回滚。
 *
 * 存在未能恢复的条目时把备份另存为 `.agf-backup-failed-<ts>/` 再清理原目录，
 * 避免同一残留被反复处理，同时不销毁用户唯一的原文。
 */
export async function recoverPendingTransaction(
  host: Host,
  os: OsContext,
  sotRoot: string,
  allowedRoots: readonly string[],
): Promise<SyncRecoveryOutcome> {
  const backupDir = longPathAware(path.join(sotRoot, SYNC_BACKUP_DIRNAME), os);
  const journalFile = path.join(backupDir, SYNC_BACKUP_JOURNAL_FILE);
  const journal = await readBackupJournal(host, journalFile);
  if (journal === null) {
    // 残留目录但无可用日志：无从判断写入范围，只清理垃圾（不动任何投影文件）
    await removeBackupArtifacts(host, backupDir, null);
    return { entries: [], preservedDir: null };
  }

  // 来源校验：已提交 / SoT 不符 / 跨机器 / 跨用户 → 拒绝恢复，只清理（不往任何路径写入）
  const trusted =
    !journal.committed &&
    isWithinAnyRoot(journal.sotRoot, [sotRoot], os) &&
    journal.machine === machineIdOf(host) &&
    journal.user === userIdOf(host);
  if (!trusted) {
    await removeBackupArtifacts(host, backupDir, journal);
    return { entries: [], preservedDir: null };
  }

  const rejected: SyncRollbackEntry[] = [];
  const manual: SyncRollbackEntry[] = [];
  const backups = new Map<string, string | null>();
  const writtenHashes = new Map<string, string>();
  for (const entry of journal.entries.filter((e) => e.written)) {
    if (!isWithinAnyRoot(entry.path, allowedRoots, os)) {
      rejected.push({
        path: entry.path,
        restored: false,
        error: '备份日志中的目标路径不在本次 sync 的预期根内，已拒绝恢复（可能被篡改或串台）',
      });
      continue;
    }
    let content: string | null = null;
    if (entry.existedBefore) {
      if (entry.backupFile === null) {
        continue; // 上次备份副本未能落盘（降级）：无基准可恢复，跳过（不猜内容）
      }
      if (!isWithinAnyRoot(entry.backupFile, [backupDir], os)) {
        rejected.push({
          path: entry.path,
          restored: false,
          error: '备份日志中的副本路径不在备份目录内，已拒绝恢复（可能是被篡改的日志）',
        });
        continue;
      }
      try {
        content = await host.readFile(entry.backupFile);
      } catch {
        continue; // 备份副本丢失：同上，跳过
      }
    }
    if (entry.writtenHash === null) {
      // 有写入事实但无复核基准：不猜、不覆盖，交给用户核对（备份副本随保留目录留存）
      manual.push({ path: entry.path, restored: false, error: RECOVERY_MANUAL_HINT });
      continue;
    }
    backups.set(entry.path, content);
    writtenHashes.set(entry.path, entry.writtenHash);
  }

  const restored = await rollbackWrites(host, [...backups.keys()], backups, writtenHashes);
  const entries = [...restored, ...manual, ...rejected];

  let preservedDir: string | null = null;
  if (entries.some((e) => !e.restored)) {
    preservedDir = await preserveBackupCopies(
      host,
      os,
      sotRoot,
      journal,
      async (entry) => {
        if (entry.backupFile === null) {
          return null;
        }
        try {
          return await host.readFile(entry.backupFile);
        } catch {
          return null;
        }
      },
      entries.filter((e) => !e.restored),
    );
  }
  await removeBackupArtifacts(host, backupDir, journal);
  return { entries, preservedDir };
}
