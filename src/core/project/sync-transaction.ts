/**
 * Sync 写入事务（Spec §7.3-6 / §10）：备份基准落盘、逐项记账、回滚。
 *
 * 备份同时留内存与磁盘两份：内存副本让正常回滚零 IO 依赖，`<sotRoot>\.agf-backup\`
 * 里的 journal.json + 副本让进程被 SIGKILL 后仍可由下次 sync 在锁内接手恢复。
 * 只有内存副本时，断电就等于永久丢失 sync 前的原文。
 *
 * 回滚前复核目标文件当前内容仍等于「本次写入的结果」：不等说明并发进程或编辑器改过，
 * 此时覆盖回备份就是拿旧内容吃掉别人的改动，因此报冲突而不是硬写。
 *
 * 当前事务句柄经模块级 activeTransaction 暴露给 sync-abort（信号处理器同步回滚）。
 */
import path from 'node:path';
import { atomicWrite, mkdirp, sha256Hex } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import { longPathAware, type OsContext } from '../paths';
import {
  SYNC_BACKUP_DIRNAME,
  SYNC_BACKUP_FAILED_PREFIX,
  SYNC_BACKUP_JOURNAL_FILE,
} from './sync-artifacts';
import { machineIdOf, type SyncLockHandle, userIdOf } from './sync-lock';
import type { SyncRollbackEntry, SyncWarning } from './sync-types';
import { readExistingForBackup } from './writer';

// ---------------------------------------------------------------------------
// 事务状态（落盘备份 + 中断回滚句柄）
// ---------------------------------------------------------------------------

// 备份目录名、失败备份前缀与 journal 文件名迁到 sync-artifacts（运行时产物命名的
// 单一事实源，同步回滚路径与只读诊断都不能依赖本模块）；此处 re-export 保持对外
// 导出面不变。
export { SYNC_BACKUP_DIRNAME, SYNC_BACKUP_FAILED_PREFIX, SYNC_BACKUP_JOURNAL_FILE };

/** 单个备份条目（落盘形态）。 */
export interface SyncBackupJournalEntry {
  readonly path: string;
  /** sync 前该文件是否已存在（false → 恢复语义是「删除本次新建的文件」）。 */
  readonly existedBefore: boolean;
  /** 备份副本路径；null = 无副本（不存在或副本落盘失败 → 恢复时不猜内容）。 */
  backupFile: string | null;
  /**
   * 本次 sync 是否已实写该文件。
   *
   * 与 writtenHash 分开记录：hash 需要读回落盘内容（一次 await），先登记
   * `written=true, writtenHash=null` 才能让「恰好落在读回窗口内的强杀」仍被
   * 恢复流程看见——否则该文件既不在同步回滚清单也不在 journal 里，两道兜底同时漏掉。
   */
  written: boolean;
  /** 本次 sync 写入后的内容 hash（未写入 / 读回失败 → null；回滚前复核基准）。 */
  writtenHash: string | null;
}

/** 备份日志（落盘 JSON；下次 sync 据此恢复被强杀的事务）。 */
export interface SyncBackupJournal {
  readonly version: 1;
  readonly pid: number;
  readonly startedAt: string;
  readonly sotRoot: string;
  /** 机器标识（跨机器共享 SoT 时不得据此恢复——pid 与路径都无可比性）。 */
  readonly machine: string;
  /** 用户标识（同理）。 */
  readonly user: string;
  /**
   * 事务是否已提交（写 sync-meta 之前置 true）。
   *
   * 提交与「finally 删 journal」之间被强杀时，下次 sync 不得把已成功提交的投影
   * 当作未完成事务回滚——子集 sync（--targets）不会重写被回滚的其他 target，
   * 磁盘与 sync-meta 会立刻不一致。
   */
  committed: boolean;
  readonly entries: SyncBackupJournalEntry[];
}

/** 进行中的事务（模块级单例：同一进程内 syncOnce 由锁保证不并发）。 */
export interface SyncTransaction {
  readonly host: Host;
  readonly os: OsContext;
  readonly sotRoot: string;
  /** 本次事务持有的全部锁（SoT 根 + 必要时的用户级根；释放按逆序）。 */
  readonly locks: readonly SyncLockHandle[];
  readonly backupDir: string;
  readonly journalFile: string;
  readonly journal: SyncBackupJournal;
  /**
   * 落盘备份是否仍可用（false = 已降级为纯内存备份）。
   *
   * SoT 不可写（只读挂载 / ACL / 文件被占用）时不应因为「崩溃恢复辅助设施」写不进去
   * 而阻断整个 sync：本次事务的回滚仍由内存备份保证，只是失去被 SIGKILL 后由下次
   * sync 恢复的能力（真正影响投影的写权限问题会在 apply / sync-meta 阶段如实报错）。
   */
  persisted: boolean;
  /** 降级原因（随 SyncResult.transactionWarnings 上报，命令层提示能力已失效）。 */
  readonly degradedReasons: string[];
  /** 路径 → 备份基准内容（null = sync 前不存在，回滚语义为删除新建文件）。 */
  readonly backups: Map<string, string | null>;
  /** 路径 → 本次写入后的内容 hash（回滚前复核，避免覆盖并发改动）。 */
  readonly writtenHashes: Map<string, string>;
  /** 已实写文件（写入顺序；回滚逆序执行）。按路径去重——重复条目会让回滚二次遍历误判。 */
  readonly writtenFiles: string[];
}

/**
 * 当前进行中的事务（供 main.ts 的信号处理器在进程退出前同步回滚）。
 * 同一进程只可能有一个事务：syncOnce 在 SoT 根持有排他锁。
 */
let activeTransaction: SyncTransaction | null = null;

/** 事务快照（只读视图；命令层 / 信号处理器判断「是否有半成品需要回滚」）。 */
export interface ActiveSyncTransactionSnapshot {
  readonly sotRoot: string;
  /** 已实写、需要回滚的文件（按写入顺序）。 */
  readonly writtenFiles: readonly string[];
  /** 已备份的全部路径（含未写入项）。 */
  readonly backedUpFiles: readonly string[];
}

/** 读取当前事务快照（无进行中事务 → null）。 */
export function getActiveSyncTransaction(): ActiveSyncTransactionSnapshot | null {
  if (activeTransaction === null) {
    return null;
  }
  return {
    sotRoot: activeTransaction.sotRoot,
    writtenFiles: [...activeTransaction.writtenFiles],
    backedUpFiles: [...activeTransaction.backups.keys()],
  };
}

/**
 * 取出并注销当前事务（供 sync-abort 的同步回滚路径）。
 *
 * 读取与清空必须是同一步：信号处理器拿到句柄后若事务仍挂着，重复触发的信号会对
 * 同一批文件回滚两次（第二次的基准复核已经不匹配，只会平白报出一串"已被外部修改"）。
 */
export function takeActiveTransaction(): SyncTransaction | null {
  const tx = activeTransaction;
  activeTransaction = null;
  return tx;
}

/**
 * 逆序恢复全部已动文件（§7.3-6 回滚）：
 * - **写回前复核基准**：读目标当前内容，其 hash 必须仍等于本次 sync 写入的结果；
 *   不等说明并发进程 / 编辑器在本次写入后又改过该文件 → 报告冲突而非覆盖
 *   （restored=false，明细进 report.rolledBack，命令层提示手工处理）；
 * - 备份为 null → 删除本次新建的文件；
 * - 备份非 null → 原样写回（不做换行规范化——恢复 sync 前的逐字节状态）；
 * - mkdirp 预校验创建的目录不回收（空目录残留无害；回滚只聚焦文件内容）；
 * - 单个恢复失败按 best-effort 收集，不中断其余恢复（report.rolledBack 呈现）。
 */
export async function rollbackWrites(
  host: Host,
  writtenFiles: readonly string[],
  backups: ReadonlyMap<string, string | null>,
  writtenHashes: ReadonlyMap<string, string> = new Map(),
): Promise<SyncRollbackEntry[]> {
  const entries: SyncRollbackEntry[] = [];
  for (const file of [...writtenFiles].reverse()) {
    const backup = backups.get(file) ?? null;
    try {
      const drift = await detectPostWriteDrift(host, file, writtenHashes.get(file));
      if (drift !== undefined) {
        entries.push({ path: file, restored: false, error: drift });
        continue;
      }
      if (backup === null) {
        await host.rm(file);
      } else {
        await atomicWrite(host, file, backup);
      }
      entries.push({ path: file, restored: true });
    } catch (err) {
      entries.push({
        path: file,
        restored: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return entries;
}

/**
 * 回滚前的基准复核：目标文件当前内容是否仍等于本次 sync 写入的结果。
 *
 * @returns 冲突说明（不应覆盖）；无漂移 / 无基准可比 → undefined。
 */
async function detectPostWriteDrift(
  host: Host,
  file: string,
  expectedHash: string | undefined,
): Promise<string | undefined> {
  if (expectedHash === undefined) {
    return undefined; // 无写入基准（理论不可达：writtenFiles 均记录 hash）
  }
  if (!(await host.exists(file))) {
    return undefined; // 已被删除：无内容可覆盖，按正常回滚处理（备份写回 / rm 幂等）
  }
  let current: string;
  try {
    current = await host.readFile(file);
  } catch {
    return undefined; // 读不到则交由下面的写回路径报告真实错误
  }
  if (sha256Hex(current) === expectedHash) {
    return undefined;
  }
  return '目标文件在本次 sync 写入后被外部修改（内容与本次写入结果不一致），已跳过回滚以避免覆盖他人改动';
}

/** 备份副本文件名：序号前缀保证唯一 + 原文件名便于人工辨认。 */
function backupCopyPath(backupDir: string, index: number, target: string): string {
  return path.join(backupDir, `${String(index).padStart(3, '0')}-${path.basename(target)}.bak`);
}

/**
 * 备份日志落盘（原子写；每次备份 / apply 成功后刷新）。
 *
 * 落盘失败（SoT 只读等）→ 记 tx.persisted=false 并**不再重试**：本次事务降级为
 * 纯内存备份（回滚照常工作），只失去被强杀后的下次恢复能力。降级不再静默——
 * 原因收集进 tx.degradedReasons，随 SyncResult.transactionWarnings 上报，
 * 命令层打印 `crash recovery disabled`。
 */
export async function persistJournal(tx: SyncTransaction): Promise<void> {
  if (!tx.persisted) {
    return;
  }
  try {
    await atomicWrite(tx.host, tx.journalFile, `${JSON.stringify(tx.journal, null, 2)}\n`);
  } catch (err) {
    tx.persisted = false;
    degradeTransaction(tx, `备份日志无法写入 ${tx.journalFile}`, err);
  }
}

/** 登记一条降级原因（去重：同一原因只记一次）。 */
export function degradeTransaction(tx: SyncTransaction, reason: string, err?: unknown): void {
  const detail = err instanceof Error ? `: ${err.message}` : '';
  const line = `${reason}${detail}`;
  if (!tx.degradedReasons.includes(line)) {
    tx.degradedReasons.push(line);
  }
}

/** 开启事务：建备份目录 + 空日志，并登记为模块级 activeTransaction（信号回滚用）。 */
export async function beginTransaction(
  host: Host,
  os: OsContext,
  sotRoot: string,
  locks: readonly SyncLockHandle[],
): Promise<SyncTransaction> {
  const backupDir = longPathAware(path.join(sotRoot, SYNC_BACKUP_DIRNAME), os);
  const tx: SyncTransaction = {
    host,
    os,
    sotRoot,
    locks,
    backupDir,
    journalFile: path.join(backupDir, SYNC_BACKUP_JOURNAL_FILE),
    journal: {
      version: 1,
      pid: process.pid,
      startedAt: host.now().toISOString(),
      sotRoot,
      machine: machineIdOf(host),
      user: userIdOf(host),
      committed: false,
      entries: [],
    },
    persisted: true,
    degradedReasons: [],
    backups: new Map(),
    writtenHashes: new Map(),
    writtenFiles: [],
  };
  activeTransaction = tx;
  try {
    await mkdirp(host, backupDir);
  } catch (err) {
    // 备份目录建不出来 → 降级（理由见 SyncTransaction.persisted）
    tx.persisted = false;
    degradeTransaction(tx, `备份目录无法创建 ${backupDir}`, err);
  }
  await persistJournal(tx);
  return tx;
}

/** 备份单个投影路径（内存 + 落盘副本；已备份过的路径直接跳过——共享文件只备份一次）。 */
export async function backupTarget(tx: SyncTransaction, target: string): Promise<void> {
  if (tx.backups.has(target)) {
    return;
  }
  const content = await readExistingForBackup(tx.host, target);
  tx.backups.set(target, content);

  let backupFile: string | null = null;
  if (content !== null && tx.persisted) {
    const candidate = backupCopyPath(tx.backupDir, tx.journal.entries.length, target);
    try {
      await atomicWrite(tx.host, candidate, content);
      backupFile = candidate;
    } catch (err) {
      // 副本写不进去 → 降级为纯内存备份；条目保持 backupFile=null，
      // 恢复流程据 existedBefore=true && backupFile=null 跳过（绝不猜内容）
      tx.persisted = false;
      degradeTransaction(tx, `备份副本无法写入 ${candidate}`, err);
    }
  }
  tx.journal.entries.push({
    path: target,
    existedBefore: content !== null,
    backupFile,
    written: false,
    writtenHash: null,
  });
  await persistJournal(tx);
}

/**
 * 记录一次实写。
 *
 * 顺序刻意如此：**先**登记路径与 journal 的 `written=true`（writtenHash 暂为 null）
 * 并刷盘，**再**读回落盘内容补算 hash。反过来（先算 hash 再登记）会留下一个 await
 * 空窗：窗口内到达的 SIGINT 使该文件既不在同步回滚清单、也不在 journal 里，
 * 两道兜底同时漏掉，而中断输出仍会声称 rollback complete。
 *
 * hash 读回失败不再静默：登记降级原因，回滚路径据 writtenHashes 无该键得知
 * 「本条目无复核基准」（detectPostWriteDrift 返回 undefined → 直接写回备份）。
 */
export async function recordWrite(tx: SyncTransaction, target: string): Promise<void> {
  if (!tx.writtenFiles.includes(target)) {
    tx.writtenFiles.push(target);
  }
  const entry = tx.journal.entries.find((e) => e.path === target);
  if (entry !== undefined) {
    entry.written = true;
  }
  await persistJournal(tx);

  let hash = '';
  try {
    hash = sha256Hex(await tx.host.readFile(target));
  } catch (err) {
    degradeTransaction(tx, `写入后无法读回内容以计算回滚复核基准 ${target}`, err);
  }
  if (hash === '') {
    return;
  }
  tx.writtenHashes.set(target, hash);
  if (entry !== undefined) {
    entry.writtenHash = hash;
  }
  await persistJournal(tx);
}

/**
 * 记录一次**删除**（Spec §7.6 prune）。
 *
 * 与 recordWrite 的区别只在 hash：文件已经不在盘上，读回必然失败，走 recordWrite
 * 会白记一条 `写入后无法读回内容` 的降级原因。writtenHash 留 null 即「无复核基准」
 * ——回滚时 detectPostWriteDrift 见文件不存在直接返回 undefined，备份原样写回。
 *
 * 调用方须先 backupTarget(tx, target) 再删（否则备份里没有这份原文可还）。
 */
export async function recordDelete(tx: SyncTransaction, target: string): Promise<void> {
  if (!tx.writtenFiles.includes(target)) {
    tx.writtenFiles.push(target);
  }
  const entry = tx.journal.entries.find((e) => e.path === target);
  if (entry !== undefined) {
    entry.written = true;
    entry.writtenHash = null;
  }
  tx.writtenHashes.delete(target);
  await persistJournal(tx);
}

/**
 * 删除落盘备份产物（逐个副本 + journal + 目录）。
 *
 * 逐文件删除而非只删目录：Host.rm 的 recursive 语义由实现决定（真实 host 递归，
 * 内存实现可能只删同名 key），显式列举可保证不同实现下都不留残留——残留 journal
 * 会让下次 sync 误以为上次被强杀并执行「恢复」。
 */
export async function removeBackupArtifacts(
  host: Host,
  backupDir: string,
  journal: SyncBackupJournal | null,
): Promise<void> {
  const targets: string[] = [];
  for (const entry of journal?.entries ?? []) {
    if (entry.backupFile !== null) {
      targets.push(entry.backupFile);
    }
  }
  targets.push(path.join(backupDir, SYNC_BACKUP_JOURNAL_FILE), backupDir);
  for (const target of targets) {
    try {
      await host.rm(target);
    } catch {
      // best-effort：单个残留不影响后续（journal 已先于目录删除）
    }
  }
}

/** 结束事务：删除落盘备份产物并注销 activeTransaction（锁由调用方释放）。 */
export async function discardTransaction(tx: SyncTransaction): Promise<void> {
  detachTransaction(tx);
  await removeBackupArtifacts(tx.host, tx.backupDir, tx.journal);
}

/** 只注销 activeTransaction，**保留**落盘备份（回滚未完成时的数据留存路径）。 */
export function detachTransaction(tx: SyncTransaction): void {
  if (activeTransaction === tx) {
    activeTransaction = null;
  }
}

/** transactionWarnings 的伪 targetId（不在 `registeredTargetIds()` 内，不参与 sync-meta 记账）。 */
const TRANSACTION_WARNING_TARGET_ID = '(transaction)';

/**
 * 事务设施级警告文本（崩溃恢复降级 + 恢复阶段保留的备份目录）。
 *
 * 放在本模块而不是引擎里：它读的全是事务自身的状态（degradedReasons / 保留目录），
 * 引擎只负责把结果塞进 SyncResult.transactionWarnings。
 */
export function transactionWarningsOf(
  tx: SyncTransaction,
  sotRoot: string,
  recoveredPreservedDir: string | null,
): SyncWarning[] {
  const warnings: SyncWarning[] = tx.degradedReasons.map((reason) => ({
    targetId: TRANSACTION_WARNING_TARGET_ID,
    path: sotRoot,
    message: `crash recovery disabled: ${reason}`,
  }));
  if (recoveredPreservedDir !== null) {
    warnings.push({
      targetId: TRANSACTION_WARNING_TARGET_ID,
      path: recoveredPreservedDir,
      message: '上次中断的 sync 有文件未能自动恢复，备份基准已保留在该目录，请人工核对',
    });
  }
  return warnings;
}
