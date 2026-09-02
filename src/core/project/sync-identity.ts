/**
 * 事务锁与 journal 的**持有者身份**判据（Spec §7.3 并发安全）：机器 / 用户 / pid 空间。
 *
 * 为什么从 sync-lock 分出来：这些函数只做**环境自省**（读 env 与 os 信息），不碰文件、
 * 不参与锁的生命周期，却被四个模块共同消费——sync-lock（能否抢占）、sync-residuals
 * （doctor 报 lock-live 还是 lock-stale）、sync-transaction（写 journal 的归属字段）、
 * sync-recovery（要不要信任落盘 journal）。锁的生命周期是这四者的其中一个消费者，
 * 把共享判据压在它里面会让另外三个模块为了一个纯计算函数依赖整套锁实现。
 *
 * 判据的宽严有确定方向：**为真才允许 pid 探针**，所以任何"取不到"一律按不相等处理。
 */
import type { Host } from '../../infra/host';
import type { OsContext } from '../paths';

/** 锁元数据：持有者身份 + 最近一次心跳时刻 + 随机 token（释放时的归属判定）。 */
export interface SyncLockRecord {
  readonly pid: number;
  /** 最近一次心跳时刻（获取时写入，持锁期间每 SYNC_LOCK_HEARTBEAT_MS 刷新）。 */
  readonly acquiredAt: string;
  readonly token: string;
  /** 机器标识（跨机器共享 SoT 时无法用 pid 判活）。 */
  readonly machine: string;
  /** 用户标识（同机多用户时同理）。 */
  readonly user: string;
  /**
   * pid 空间标识（见 pidSpaceIdOf）：机器 + 用户相同**也不足以**说明 pid 可比——
   * WSL 的 hostname 默认就是 Windows 计算机名，两侧用户名也常相同。
   * 读不到（老版本写的锁文件没有这个字段）→ 空串，判据按"不同 pid 空间"降级。
   */
  readonly pidSpace: string;
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
 * 常常读不到。退化成空串后，「跨机器 journal 只清理不恢复」这处判据会变成恒真——
 * 共享 SoT（网盘 / NFS）时可能拿别人机器的 journal 回滚本机文件。
 * 锁侧的 pid 判据不再有这个隐患：sameProcessSpace 要求三项**都不为空**。
 */
export function machineIdOf(host: Host): string {
  return firstNonBlank(host.env('COMPUTERNAME'), host.env('HOSTNAME'), host.hostname());
}

/** 用户标识（同上；USER 在 cron / systemd 下同样可能未导出）。 */
export function userIdOf(host: Host): string {
  return firstNonBlank(host.env('USERNAME'), host.env('USER'), host.username());
}

/**
 * pid 空间标识：同一台物理机上**pid 互不可比**的执行环境要拿到不同的值。
 *
 * 为什么 machineId + userId 不够：WSL 发行版的 hostname 默认就是 Windows 计算机名
 * （`machineIdOf` 的三条来源在 WSL 里都会给出它），两侧用户名也常常相同。于是
 * 「同机器 + 同用户」在跨 Windows / WSL 边界时可能为真，而两侧的 pid 空间毫无关系
 * ——`kill(pid, 0)` 探到的是本侧一个碰巧同号的无关进程。
 *
 * 判据：
 * - `WSL_DISTRO_NAME` 置位 → `wsl:<发行版>`（两个不同发行版之间同样不可比）；
 * - 检出 WSL（`WSL_INTEROP`）但读不到发行版名 → 空串，即"未知"。调用方把未知当成
 *   不同 pid 空间，宁可多等一个 stale 窗口，也不要拿一个可能撞名的标识去开 pid 探针；
 * - 其余 → `native:<platform>`（Windows 侧恒为 `native:win32`，原生 Linux 为
 *   `native:linux`，与任何 `wsl:*` 都不相等）。
 *
 * 只读环境变量、不读 `/proc/version`：判据必须是同步的（machineIdOf / userIdOf 也是），
 * 而 Host 的文件 IO 全是异步的。`WSL_INTEROP` 由 WSL init 注入，覆盖面够用；不够时的
 * 降级方向（未知 → 不做 pid 探针）是安全的那一侧。
 *
 * 只看 `WSL_INTEROP` 而不看 `WSLENV`：后者是**Windows 侧**用来声明环境变量透传的，
 * 在 Windows 上也常常置位，拿它判 WSL 会把 Windows 侧也判成"未知"。
 */
export function pidSpaceIdOf(host: Host, os: OsContext): string {
  const distro = firstNonBlank(host.env('WSL_DISTRO_NAME'));
  if (distro !== '') {
    return `wsl:${distro}`;
  }
  if (firstNonBlank(host.env('WSL_INTEROP')) !== '') {
    return '';
  }
  return `native:${os.platform}`;
}

/**
 * 锁持有者是否与当前进程处于**同一 pid 空间**——只有这样 isProcessAlive 才有意义。
 *
 * 三项必须同时相等且**都不为空**：机器、用户、pid 空间。空串代表"取不到"，一律按
 * 不同处理：两侧都取不到时 `'' === ''` 会让判据凭空为真（见 machineIdOf 的 JSDoc），
 * 而这个判据为真的唯一用途就是允许 pid 探针，宁缺勿滥。
 *
 * **老锁文件的降级语义**：`pidSpace` 是后加的字段，老版本写的 meta.json 里没有它 →
 * readSyncLockRecord 给出空串 → 本函数返回 false → 不做 pid 探针 → 只能走
 * 「心跳停摆超过 SYNC_LOCK_STALE_MS」这条超时路径。这个方向是刻意选的：反过来
 * （缺字段就沿用旧的 machine+user 判据）会让跨 WSL 边界的陈旧锁被误判成本机活锁，
 * 从而**永久**拒绝抢占——那是个必须人工删目录才能解开的死结。而本方向的代价只是
 * 一个真·本机活锁在心跳停摆 5 分钟后可能被抢占，且活着的持有者本就在持续刷新心跳。
 *
 * 裁决方（acquireSyncLock）与诊断方（inspectSyncResiduals）必须共用这一个函数，
 * 否则同一把锁会得到「doctor 说陈旧可清理 / sync 说还活着」两个矛盾结论。
 */
export function sameProcessSpace(
  holder: SyncLockRecord | null,
  host: Host,
  os: OsContext,
): holder is SyncLockRecord {
  if (holder === null) {
    return false;
  }
  const machine = machineIdOf(host);
  const user = userIdOf(host);
  const pidSpace = pidSpaceIdOf(host, os);
  return (
    machine !== '' &&
    user !== '' &&
    pidSpace !== '' &&
    holder.machine === machine &&
    holder.user === user &&
    holder.pidSpace === pidSpace
  );
}

/**
 * 进程是否仍存活（`kill(pid, 0)` 探针，不发送任何信号）。
 *
 * 仅在 sameProcessSpace 为真时可信：跨机器的 pid 与本机 pid 空间无关；**同一台机器
 * 上跨内核边界（Windows ↔ WSL 发行版）的 pid 同样无关**，那是 WSL 特有的形态，靠
 * 机器名 + 用户名区分不出来（两侧默认相同），所以 pid 空间要单独入判据。
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
