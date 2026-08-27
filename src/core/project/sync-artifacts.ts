/**
 * Sync 运行时产物的**命名事实源**：锁 / 备份 / 失败备份目录的名字与构造方式。
 *
 * 为什么这条缝划在这里：这些名字同时被三类互不相识的代码读写——写侧（事务、信号
 * 回滚）造出目录，判侧（残留诊断按前缀识别、.gitignore 按前缀生成忽略模式、崩溃
 * 恢复靠"改过名就不再叫 `.agf-backup`"避免反复处理）按同一套名字反推语义。名字
 * 一旦在某一侧用字符串拼接重造，另一侧的判据就会静默脱锚：目录还在磁盘上，但
 * doctor 不报、gitignore 不忽略，而 tsc 与测试都抓不到这种失配。
 *
 * 因此本模块是**叶子**：只有 `node:path`，不 import 任何 sync 模块，也不做 IO。
 * 这样它能被两条形态迥异的调用路径共用——异步的 Host 注入路径（sync-recovery）与
 * 信号处理器里的 `node:fs` 同步路径（sync-abort）。若把它放进任一重 IO 模块，
 * 另一条路径就会被迫拖进整套不需要的依赖（同步回滚拖进 Host / Promise 链尤其致命）。
 */
import path from 'node:path';

/** SoT 根内的事务锁**目录**名（原子 mkdir 即互斥原语；dry-run 不取锁）。 */
export const SYNC_LOCK_DIRNAME = '.sync.lock';

/** SoT 根内的落盘备份目录名（事务结束即删除；残留 = 上次被强杀）。 */
export const SYNC_BACKUP_DIRNAME = '.agf-backup';

/**
 * 备份目录内的日志文件名（记录备份副本位置与已写入状态）。
 *
 * 与目录名同处一个模块：判侧（残留诊断按 `<备份目录>\<journal>` 探测未提交事务、
 * 崩溃恢复据同一路径接手）与写侧（事务开启即建、结束即删）必须拼出同一个路径，
 * 而判侧是**只读诊断**，不该为了一个文件名把整套写入事务（连带 writer / 锁原语）
 * 拖进依赖图。
 */
export const SYNC_BACKUP_JOURNAL_FILE = 'journal.json';

/**
 * 回滚未能全部完成时保留的备份目录名前缀（`.agf-backup-failed-<时间戳>`）。
 *
 * 改名而非原地保留：`.agf-backup` 是崩溃恢复的入口，留在原地会被下次 sync 当成
 * 「上次被强杀」反复处理；改名后它只是**给用户手工恢复用的证据**，路径会出现在
 * 失败汇总与退出码 6 的输出里。
 *
 * 这个前缀是三处判据的唯一锚点（残留诊断的 `startsWith`、`.gitignore` 的忽略模式、
 * 崩溃恢复的"不叫 `.agf-backup` 就不处理"），所以目录名只能由 failedBackupDir 造。
 */
export const SYNC_BACKUP_FAILED_PREFIX = '.agf-backup-failed-';

/**
 * 失败备份目录的时间戳（文件名安全：只留数字，形如 `20240131T091500123` 去符号后）。
 *
 * 取 ISO 而非 epoch ms：同一 SoT 下的多份保留目录要能按名字排序看出先后，
 * epoch 数字串在人眼里不可读，两种格式混存则连排序都不成立。
 *
 * 旧版本可能已在盘上留下 epoch 毫秒命名的失败备份目录（前缀不变，故判据仍命中）；
 * 两种命名混存时按名排序不代表时间先后。
 */
export function backupStampOf(when: Date): string {
  return when.toISOString().replace(/[^0-9]/g, '');
}

/**
 * 失败备份目录的绝对路径：与 `.agf-backup` **同级**、改名为带前缀的证据目录。
 *
 * 取 `dirname(backupDir)` 而不是另接一个 sotRoot 参数：同步回滚路径手里只有
 * 事务的 backupDir（已过 longPathAware，Windows 长路径前缀必须保留才能 rename），
 * 从它推导出的父目录与写入时用的口径必然一致。
 */
export function failedBackupDir(backupDir: string, stamp: string): string {
  return path.join(path.dirname(backupDir), `${SYNC_BACKUP_FAILED_PREFIX}${stamp}`);
}
