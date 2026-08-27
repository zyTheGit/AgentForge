/**
 * 信号 / 致命错误路径下的同步回滚（Spec §7.3-6）。
 *
 * 例外说明：本模块是全仓唯一直接用 `node:fs` **同步** API 的地方——其余 IO 一律经
 * Host 注入。理由是它由 main.ts 的 SIGINT/SIGTERM 与 uncaughtException 处理器调用，
 * 那里没有 await 的机会：Node 在信号处理器返回后就会退出，异步回滚的 Promise 根本
 * 没有机会被 microtask 队列执行完，结果是「回滚了一半」的文件系统。
 */
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../../infra/fsutil';
import { backupStampOf, failedBackupDir } from './sync-artifacts';
import { type SyncTransaction, takeActiveTransaction } from './sync-transaction';
import type { SyncRollbackEntry } from './sync-types';

/**
 * 同步回滚进行中的事务（**仅**供 main.ts 的信号 / 致命错误处理器调用）。
 *
 * 为何在此使用 node:fs 的同步 API（全项目其他位置一律经 Host）：处理器运行在
 * 进程即将退出的路径上，`process.exit()` 不等待微任务队列——异步 IO（Host / Promise）
 * 很可能在事件循环被终止前来不及落盘，导致「声称已回滚但实际没回滚」。同步 API 是
 * 该路径下唯一可保证完成的写入方式。
 *
 * 语义与 rollbackWrites 一致：逆序、备份为 null 则删除、写回前复核基准。Windows 上写回前
 * 先 `chmodSync(0o666)`：异步路径的 atomicWrite 会做同样的事（host.clearReadonly），
 * 同步路径若省略，带只读属性的文件（git clone 常见）会以 EPERM 恢复失败。
 */
export function rollbackActiveSyncTransactionSync(): SyncRollbackEntry[] {
  const tx = takeActiveTransaction();
  if (tx === null) {
    return [];
  }

  const entries: SyncRollbackEntry[] = [];
  for (const file of [...tx.writtenFiles].reverse()) {
    const backup = tx.backups.get(file) ?? null;
    try {
      const expected = tx.writtenHashes.get(file);
      const exists = existsSync(file);
      if (expected !== undefined && exists && sha256Hex(readFileSync(file, 'utf8')) !== expected) {
        entries.push({
          path: file,
          restored: false,
          error:
            '目标文件在本次 sync 写入后被外部修改（内容与本次写入结果不一致），已跳过回滚以避免覆盖他人改动',
        });
        continue;
      }
      if (backup === null) {
        if (exists) {
          rmSync(file, { force: true });
        }
      } else {
        if (exists) {
          try {
            // Windows 只读属性：不先清除会 EPERM。POSIX 上跳过——0o666 会把备份
            // 文件原有的 0600 放宽，而写回本身不需要放宽权限（当前用户即所有者）
            if (process.platform === 'win32') {
              chmodSync(file, 0o666);
            }
          } catch {
            // best-effort：真正的失败由下面的写入报告
          }
        }
        writeFileSync(file, backup, 'utf8');
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

  // 事务残留清理（备份副本 + journal + 目录 + 锁 + atomicWrite 临时文件）：同样必须
  // 同步完成——journal 残留会让下次 sync 误判「上次被强杀」，锁残留要等陈旧阈值。
  // 回滚未全部成功时**保留**备份目录：磁盘上留着半新半旧的文件，那份 .bak 是用户
  // 唯一的原文（改名以免被下次 sync 当成未完成事务重复处理）。
  const incomplete = entries.some((entry) => !entry.restored);
  removeStaleTempFilesSync(tx);
  if (incomplete) {
    try {
      // 目录名与时间戳口径都走 sync-artifacts：残留诊断 / .gitignore / 崩溃恢复三处
      // 判据都以 SYNC_BACKUP_FAILED_PREFIX 为锚，这里自行拼接就会静默脱锚。
      renameSync(tx.backupDir, failedBackupDir(tx.backupDir, backupStampOf(new Date())));
    } catch {
      // 改名失败：宁可留下 .agf-backup（下次 sync 会按 journal 恢复）也不删除
    }
  } else {
    for (const entry of tx.journal.entries) {
      if (entry.backupFile !== null) {
        try {
          rmSync(entry.backupFile, { force: true });
        } catch {
          // 单个备份副本清理失败无害
        }
      }
    }
    try {
      rmSync(tx.backupDir, { recursive: true, force: true });
    } catch {
      // 清理失败无害：下次 sync 会按日志处理残留
    }
  }
  for (const lock of tx.locks) {
    try {
      rmSync(lock.dir, { recursive: true, force: true });
    } catch {
      // 锁清理失败无害：心跳停摆超过 SYNC_LOCK_STALE_MS 后可被抢占
    }
  }
  return entries;
}

/**
 * 清理本次事务留下的 atomicWrite 临时文件（`<target>.agf-<12hex>.tmp`）。
 *
 * atomicWrite 的 finally 依赖事件循环，`process.exit()` 之后不会执行——临时文件名
 * 又是随机的，没有清理入口就会永久残留在用户配置目录。故在同步回滚路径按「投影
 * 目标所在目录 + 文件名前缀」扫描删除（只删自己命名规范的文件，不碰其它内容）。
 */
function removeStaleTempFilesSync(tx: SyncTransaction): void {
  const dirs = new Set<string>();
  for (const target of tx.backups.keys()) {
    dirs.add(path.dirname(target));
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // 目录读不到（已被删 / 无权限）：无从清理
    }
    for (const name of names) {
      if (/\.agf-[0-9a-f]{12}\.tmp$/.test(name)) {
        try {
          rmSync(path.join(dir, name), { force: true });
        } catch {
          // 单个残留清理失败无害
        }
      }
    }
  }
}
