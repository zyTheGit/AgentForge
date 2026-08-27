/**
 * Sync 事务互斥锁（Spec §7.3 并发安全）：`<sotRoot>\.sync.lock\` 目录锁。
 *
 * 用**目录**而非文件：非递归 `mkdir` 在 Windows 与 POSIX 上都原子，`EEXIST` 即败者，
 * 不需要额外的 CAS 原语。锁覆盖「备份 → apply → 写 sync-meta」整段——只锁 apply
 * 挡不住并发进程在备份之后写入、随后被过期备份覆盖。
 *
 * 陈旧锁判定同时看两件事：心跳停摆超过 SYNC_LOCK_STALE_MS **且**持有者进程已不存活。
 * 只看时间会误杀慢 sync（大仓库叠加杀毒扫描），只看进程会被 pid 重用骗过。
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { isPermissionErrno, mkdirp } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import { ConflictError, PermissionError } from '../errors';
import { isWithinAnyRoot, longPathAware, type OsContext } from '../paths';
import { SYNC_LOCK_DIRNAME } from './sync-artifacts';

// ---------------------------------------------------------------------------
// 事务互斥锁（备份-写入-回滚整段串行化）
// ---------------------------------------------------------------------------

// 锁目录名迁到 sync-artifacts（运行时产物命名的单一事实源）；此处 re-export
// 保持对外导出面不变（engine 门面与 doctor 都从这里取）。
export { SYNC_LOCK_DIRNAME };

/** 锁目录内的持有者元数据文件名（pid / acquiredAt / token / 机器 / 用户）。 */
export const SYNC_LOCK_META_FILE = 'meta.json';

/** 陈旧锁阈值：心跳停止超过 5 分钟视为持有者已异常消失，可被抢占。 */
export const SYNC_LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * 锁是否仍新鲜（= 持有者的心跳还在阈值内）。
 *
 * 为什么要导出：裁决方（acquireSyncLock，决定能否抢占）与诊断方
 * （inspectSyncResiduals，决定报 lock-live 还是 lock-stale）必须给出同一个结论，
 * 否则恰好卡在阈值上时 doctor 说「陈旧、可清理」而 sync 仍拒绝抢占，用户拿到两条
 * 互相矛盾的结论。
 *
 * 边界含等号（`ageMs <= SYNC_LOCK_STALE_MS` 视为新鲜），与 acquireSyncLock 的抢占
 * 判据同口径；此前 doctor 侧用的是严格小于，`ageMs` 恰为阈值时两者结论相反。
 *
 * `ageMs` 为 NaN（元数据与目录 mtime 都取不到，见 lockAgeMs）→ 非新鲜。
 */
export function isLockFresh(ageMs: number): boolean {
  return Number.isFinite(ageMs) && ageMs <= SYNC_LOCK_STALE_MS;
}

/**
 * 心跳间隔：持锁期间周期性刷新 acquiredAt。
 *
 * 无心跳时「大量 skills copy / 慢盘 / OneDrive 同步」导致 sync 超过
 * SYNC_LOCK_STALE_MS 就会被第二个进程判定陈旧并抢占，随后崩溃恢复流程会回滚
 * 前者**正在写**的文件——这是比「等一会儿」严重得多的后果。
 */
export const SYNC_LOCK_HEARTBEAT_MS = 30 * 1000;

/** 锁元数据：持有者身份 + 最近一次心跳时刻 + 随机 token（释放时的归属判定）。 */
interface SyncLockRecord {
  readonly pid: number;
  /** 最近一次心跳时刻（获取时写入，持锁期间每 SYNC_LOCK_HEARTBEAT_MS 刷新）。 */
  readonly acquiredAt: string;
  readonly token: string;
  /** 机器标识（跨机器共享 SoT 时无法用 pid 判活）。 */
  readonly machine: string;
  /** 用户标识（同机多用户时同理）。 */
  readonly user: string;
}

/** 已获得的锁句柄（释放时校验 token，避免误删他人重新取得的锁）。 */
export interface SyncLockHandle {
  /** 锁目录（`<sotRoot>/.sync.lock`）。 */
  readonly dir: string;
  /** 锁目录内的元数据文件。 */
  readonly metaFile: string;
  readonly token: string;
  /** 心跳定时器（release 时清理；unref 后不阻塞进程退出）。 */
  heartbeat: ReturnType<typeof setInterval> | null;
}

/**
 * 取第一个非空白值（`??` 不够：环境变量可以导出为空串，那与「没有」等价）。
 * 全部缺失时返回空串——调用方（锁 / journal 的归属判据）把空串视为"未知"。
 */
function firstNonBlank(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== '') {
      return trimmed;
    }
  }
  return '';
}

/**
 * 机器标识（优先 Host.env 口径，便于注入；环境变量缺失时退回 host.hostname()）。
 *
 * 为什么必须有 os 兜底：HOSTNAME 不是 POSIX 导出变量，`sh -c` / 容器 / systemd 下
 * 常常读不到。退化成空串后，「跨机器 journal 只清理不恢复」与「同机同用户才判 pid
 * 存活」两处判据会双双变成恒真——共享 SoT（网盘 / NFS）时可能拿别人机器的 journal
 * 回滚本机文件，或按本机 pid 空间误判他人的锁已死而抢占。
 */
export function machineIdOf(host: Host): string {
  return firstNonBlank(host.env('COMPUTERNAME'), host.env('HOSTNAME'), host.hostname());
}

/** 用户标识（同上；USER 在 cron / systemd 下同样可能未导出）。 */
export function userIdOf(host: Host): string {
  return firstNonBlank(host.env('USERNAME'), host.env('USER'), host.username());
}

/**
 * 进程是否仍存活（`kill(pid, 0)` 探针，不发送任何信号）。
 *
 * 仅在「同机器 + 同用户」时可信：跨机器的 pid 与本机 pid 空间无关，
 * 跨用户的进程 kill 探针会得到 EPERM（存在但无权限 → 同样按存活处理）。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读锁元数据并解析；不存在 / 内容损坏 → null（损坏锁按陈旧处理，允许抢占）。 */
export async function readSyncLockRecord(
  host: Host,
  metaFile: string,
): Promise<SyncLockRecord | null> {
  try {
    const parsed = JSON.parse(await host.readFile(metaFile)) as Partial<SyncLockRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.acquiredAt !== 'string') {
      return null;
    }
    return {
      pid: parsed.pid,
      acquiredAt: parsed.acquiredAt,
      token: typeof parsed.token === 'string' ? parsed.token : '',
      machine: typeof parsed.machine === 'string' ? parsed.machine : '',
      user: typeof parsed.user === 'string' ? parsed.user : '',
    };
  } catch {
    return null;
  }
}

/** 锁目录的绝对路径（长路径保护同投影写入口径，Spec §2.1.1）。 */
export function syncLockDir(sotRoot: string, os: OsContext): string {
  return longPathAware(path.join(sotRoot, SYNC_LOCK_DIRNAME), os);
}

/**
 * 锁的「静默时长」：优先取元数据里的最近心跳，元数据不可读时退回锁目录的 mtime。
 *
 * 为什么需要目录 mtime 兜底：胜者创建锁目录与写入元数据之间有一个 await 的窗口，
 * 若此刻另一个进程读不到元数据就判定「陈旧可抢占」，会把刚取得锁的进程挤掉。
 * 目录本身的 mtime 在这个窗口里已经是新鲜的。两者都取不到 → NaN（按陈旧处理）。
 */
export async function lockAgeMs(
  host: Host,
  dir: string,
  holder: SyncLockRecord | null,
): Promise<number> {
  if (holder !== null) {
    const parsed = Date.parse(holder.acquiredAt);
    if (Number.isFinite(parsed)) {
      return host.now().getTime() - parsed;
    }
  }
  try {
    const stat = await host.stat(dir);
    return host.now().getTime() - stat.mtimeMs;
  } catch {
    return Number.NaN;
  }
}

/** 把「无法创建锁目录」的 errno 映射为 PermissionError(4)（不降级：无锁不写）。 */
function lockCreateError(err: unknown, dir: string): unknown {
  if (isPermissionErrno(err)) {
    return new PermissionError(`无法在 SoT 根创建事务锁目录: ${dir}`, {
      hint: '检查 SoT 目录的写权限（必要时以管理员身份运行）；sync 需要锁来串行化写入',
      details: err,
    });
  }
  return err;
}

/** 持有者仍在写入（新鲜锁 / 陈旧但进程仍存活）→ ConflictError(3)。 */
function lockBusyError(dir: string, holder: SyncLockRecord | null, ageMs: number): ConflictError {
  const who = holder === null ? '未知进程' : `pid ${holder.pid}，自 ${holder.acquiredAt}`;
  return new ConflictError(`另一个 aforge sync 正在写入同一 SoT（${who}）`, {
    hint: `等待该进程结束后重试；确认无进程持有该锁时删除锁目录: ${dir}`,
    details: { lockDir: dir, holder, ageMs },
  });
}

/**
 * 取 SoT 根的事务排他锁（覆盖备份 → apply → 写 sync-meta 整段）。
 *
 * 互斥原语是 **非递归 mkdir**（Host.mkdirExclusive）：Windows 与 POSIX 均保证
 * 「创建 / EEXIST」不可分割，因此并发进程中**至多一个**能创建出锁目录并进入事务段。
 * 旧实现的「exists 探测 → writeFile → 回读校验 token」无法排除
 * 「B 在 A 的探测之后、A 的回读之后才写入」的交错——两个进程都能读回自己的 token
 * 而同时判定胜出。回读校验在此保留为**纵深防御**（察觉锁目录被外部替换），不再是
 * 唯一判据。
 *
 * 抢占陈旧锁的判据是「心跳停摆 > SYNC_LOCK_STALE_MS **且**持有者进程已不存活」：
 * 只看时间会误杀慢 sync（见 SYNC_LOCK_HEARTBEAT_MS）。
 *
 * @throws ConflictError(3) 锁被其他进程持有 / 抢占后被他人先取得 / 抢占清理失败。
 * @throws PermissionError(4) SoT 根不可写（锁目录建不出来 → 无法保证互斥，不降级）。
 */
async function acquireSyncLock(
  host: Host,
  sotRoot: string,
  os: OsContext,
): Promise<SyncLockHandle> {
  const dir = syncLockDir(sotRoot, os);
  const metaFile = path.join(dir, SYNC_LOCK_META_FILE);
  await mkdirp(host, sotRoot);

  let created: boolean;
  try {
    created = await host.mkdirExclusive(dir);
  } catch (err) {
    throw lockCreateError(err, dir);
  }

  if (!created) {
    const holder = await readSyncLockRecord(host, metaFile);
    const ageMs = await lockAgeMs(host, dir, holder);
    const sameHost =
      holder !== null && holder.machine === machineIdOf(host) && holder.user === userIdOf(host);
    const fresh = isLockFresh(ageMs);
    if (fresh || (sameHost && isProcessAlive(holder.pid))) {
      throw lockBusyError(dir, holder, ageMs);
    }
    // 陈旧锁（心跳停摆且持有者已消失）/ 元数据损坏：抢占
    try {
      await host.rm(dir);
    } catch (err) {
      // 裸 errno 会绕过本函数的统一映射，让用户拿到无 hint 的退出码 1
      if (isPermissionErrno(err)) {
        throw new PermissionError(`无法清理陈旧的事务锁目录: ${dir}`, {
          hint: `确认无 aforge 进程在运行后手工删除该目录: ${dir}`,
          details: err,
        });
      }
      throw new ConflictError(`陈旧事务锁目录无法清理（可能仍被占用）: ${dir}`, {
        hint: `等待占用者退出后重试；确认无进程持有该锁时手工删除: ${dir}`,
        details: err,
      });
    }
    let retaken: boolean;
    try {
      retaken = await host.mkdirExclusive(dir);
    } catch (err) {
      throw lockCreateError(err, dir);
    }
    if (!retaken) {
      throw lockBusyError(dir, await readSyncLockRecord(host, metaFile), Number.NaN);
    }
  }

  const token = randomBytes(12).toString('hex');
  const lock: SyncLockHandle = { dir, metaFile, token, heartbeat: null };
  try {
    await writeSyncLockRecord(host, lock);
  } catch (err) {
    await releaseSyncLock(host, lock); // 元数据写不进去 → 不留下无主锁目录
    throw lockCreateError(err, dir);
  }

  // 纵深防御：锁目录被外部替换 / 元数据被他人覆盖时主动让出（互斥已由 mkdir 保证）
  const readBack = await readSyncLockRecord(host, metaFile);
  if (readBack === null || readBack.token !== token) {
    // 与上方 writeSyncLockRecord 失败分支同口径：让出前先释放，否则盘上留下的 meta
    // 其 acquiredAt 就是刚写的，isLockFresh 单独即为真——接下来整个
    // SYNC_LOCK_STALE_MS 窗口内**任何**进程的 sync 都会撞 lockBusyError。
    // releaseSyncLock 内部 token 相同才删，不会误删他人已重新取得的锁。
    await releaseSyncLock(host, lock);
    throw new ConflictError('取事务锁失败：锁元数据在写入后被其他进程改动', {
      hint: '稍后重试（同一 SoT 的 sync 需串行执行）',
      details: { lockDir: dir, holder: readBack },
    });
  }

  startLockHeartbeat(host, lock);
  return lock;
}

/** 写入 / 刷新锁元数据（acquiredAt 即最近心跳时刻）。 */
async function writeSyncLockRecord(host: Host, lock: SyncLockHandle): Promise<void> {
  const record: SyncLockRecord = {
    pid: process.pid,
    acquiredAt: host.now().toISOString(),
    token: lock.token,
    machine: machineIdOf(host),
    user: userIdOf(host),
  };
  await host.writeFile(lock.metaFile, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * 启动心跳：周期性刷新 acquiredAt，向其他进程证明本次 sync 仍在活动。
 * 定时器 unref——绝不因心跳而延长进程生命周期。
 */
function startLockHeartbeat(host: Host, lock: SyncLockHandle): void {
  const timer = setInterval(() => {
    void writeSyncLockRecord(host, lock).catch(() => {
      // best-effort：单次心跳失败无害（下一次仍会尝试；真正的写权限问题在 apply 阶段报错）
    });
  }, SYNC_LOCK_HEARTBEAT_MS);
  timer.unref?.();
  lock.heartbeat = timer;
}

/** 释放锁（token 不匹配 → 保留：锁已属于他人）。失败不上抛，避免掩盖主流程错误。 */
async function releaseSyncLock(host: Host, lock: SyncLockHandle): Promise<void> {
  if (lock.heartbeat !== null) {
    clearInterval(lock.heartbeat);
    lock.heartbeat = null;
  }
  try {
    const holder = await readSyncLockRecord(host, lock.metaFile);
    if (holder !== null && holder.token !== lock.token) {
      return;
    }
    await host.rm(lock.dir);
  } catch {
    // best-effort：残留锁会在心跳停摆超过 SYNC_LOCK_STALE_MS 后被判定陈旧并抢占
  }
}

/**
 * 按路径字典序取多把锁（防死锁：所有进程的加锁顺序一致）。
 *
 * 为什么需要多把：锁按 SoT 根取，但投影产物可能落在 SoT 之外——CODEX_HOME 指向
 * 用户目录时，两个不同项目的 project-scope sync 各持自己的 `.sync.lock`，却并发写
 * 同一个 `~/.codex/config.toml`。此时额外取用户级 SoT 根的锁把它们串行化。
 *
 * 任一把取不到 → 逆序释放已取得的锁后上抛（不留下半持锁状态）。
 *
 * 为什么 sync 主链路不走 withSotLock 的 callback 形式（两者共用同一对底层原语，
 * 看起来像未收敛的重复）：这里取得的句柄要存进 `tx.locks`，供**信号处理器**里的
 * 同步回滚与崩溃恢复读取。callback 形式把句柄封在闭包里，跨不过信号处理器边界。
 */
export async function acquireSyncLocks(
  host: Host,
  roots: readonly string[],
  os: OsContext,
): Promise<SyncLockHandle[]> {
  const ordered = [...new Set(roots)].sort();
  const acquired: SyncLockHandle[] = [];
  try {
    for (const root of ordered) {
      acquired.push(await acquireSyncLock(host, root, os));
    }
  } catch (err) {
    for (const lock of [...acquired].reverse()) {
      await releaseSyncLock(host, lock);
    }
    throw err;
  }
  return acquired;
}

/** 逆序释放全部锁（best-effort）。 */
export async function releaseSyncLocks(
  host: Host,
  locks: readonly SyncLockHandle[],
): Promise<void> {
  for (const lock of [...locks].reverse()) {
    await releaseSyncLock(host, lock);
  }
}

/**
 * 在 SoT 根的事务锁保护下执行一段读-改-写（sync 之外的 SoT 写入方复用同一把锁）。
 *
 * 为什么要导出：`aforge promote` 与 `profile.yaml` 定点编辑同样是对 SoT 下文件的
 * 「读 → 改 → 写」，不持锁就会与并发 sync 互相覆盖（sync 在锁内备份 → apply →
 * 写 sync-meta，期间被外部改动的文件会被过期备份覆盖）。锁语义必须与 sync 完全
 * 同源——同一个 `<sotRoot>/.sync.lock` 目录、同一个原子 mkdir 原语、同一套
 * stale / heartbeat 常量——所以这里复用 acquireSyncLock/releaseSyncLock，而不是
 * 在调用方另起一套锁。
 *
 * 多个根时请按**路径字典序**从外到内嵌套调用（与 acquireSyncLocks 的加锁顺序
 * 一致），否则可能与 sync 形成环形等待。
 *
 * sync 主链路**故意不**调用这里，而是直接用 acquireSyncLocks 拿裸句柄——原因见
 * 那个函数的 JSDoc（句柄要跨越信号处理器边界）。两处不是未收敛的重复。
 *
 * @throws ConflictError(3) 锁被其他进程持有；
 * @throws PermissionError(4) SoT 根不可写（锁目录建不出来 → 不降级为无锁写入）。
 */
export async function withSotLock<T>(
  host: Host,
  sotRoot: string,
  os: OsContext,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireSyncLock(host, sotRoot, os);
  try {
    return await fn();
  } finally {
    await releaseSyncLock(host, lock);
  }
}

/**
 * 本次事务需要持有的锁根（按路径字典序返回——所有进程加锁顺序一致，不会死锁）。
 *
 * 基础是本层 SoT 根。此外：投影产物若**落在项目根之外**且位于用户目录 /
 * CODEX_HOME 下（例如 project-scope 的 sync 写 `~/.codex/config.toml`），两个不同
 * 项目各持自己的 `.sync.lock` 却在写同一个文件——此时额外取用户级 SoT 根的锁把它们
 * 串行化。判据刻意加了「项目根之外」：否则「项目正好放在用户主目录下」这种常见布局
 * 会让同一用户的所有项目 sync 互相串行，代价远大于收益。
 */
export function resolveLockRoots(
  sotRoot: string,
  userSoTRoot: string,
  projectRoot: string,
  itemPaths: readonly string[],
  userRoots: readonly string[],
  os: OsContext,
): string[] {
  const roots = new Set<string>([sotRoot]);
  if (sotRoot !== userSoTRoot && userRoots.length > 0) {
    const outsideProject = itemPaths.filter((p) => !isWithinAnyRoot(p, [projectRoot], os));
    if (outsideProject.some((p) => isWithinAnyRoot(p, userRoots, os))) {
      roots.add(userSoTRoot);
    }
  }
  return [...roots].sort();
}
