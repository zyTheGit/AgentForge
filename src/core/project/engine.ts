/**
 * Sync 引擎 v2（Spec §7.3，M6 四 projector 全事务版）。
 *
 * 流程（§7.3 第 1-7 条）：
 * 1. 解析 SoT 根 → 三层配置装配（resolveEffectiveConfig）→ 初始化检查；
 * 2. 渲染统一 renderedRulesMd **一次**（custom + promoted learnings[空] + templates
 *    + base/default，§5.2 四层；§8.2 同一 SoT 渲染一次分发全部 target）；
 * 3. 对 profile.targets 逐个 projector.plan()（纯函数；plan 阶段失败如模板未
 *    解析属 ConfigError fail-fast——此时尚未写入任何文件，无需回滚）；
 * 4. **写入预校验**：对全部待写路径 mkdirp 目录（失败 → PermissionError(4)，
 *    §7.3-7 目录自动创建；此时同样未写入任何文件）；
 * 5. **备份**：逐项读现有文件内容存内存（不存在记 null；按路径去重——多个
 *    target 共享同一 AGENTS.md 时只备份一次）；
 * 6. **逐一 apply**（幂等跳写：目标已是最终形态则跳过）：
 *    - soft 项（§8.6 Pi MVP）失败 → 仅收集 warning，不计入失败、不触发回滚；
 *    - 任一硬项失败 → **逆序恢复全部已动文件**（备份为 null 的删除新建文件；
 *      回滚失败按 best-effort 收集进失败报告）→ 抛出失败汇总（rethrow 原始
 *      错误以保留类型与退出码——fail-fast 单失败点即 severityOf 最高者，
 *      §7.3-6 退出码取失败 target 中最高严重度）；
 * 7. 成功才写 sync-meta.json（§3.3）；回滚则不更新（保留上次记录）。
 *    soft 失败的 target 不记入 targets（该 target 投影不完整，不提供
 *    doctor 一致性基准——见下方 JSDoc「soft 项与 sync-meta」）。
 * 7.5 `projection.gitignore_generated=true` 且 project scope 时，在同一事务内
 *    把全部项目内投影产物写进 `<项目根>\.gitignore` 的 `# BEGIN AGENTFORGE`
 *    标记段（§4.2；段外用户条目保留，段内全量重算 → 幂等）。
 *
 * 并发与中断安全：
 * - **进程级排他锁**：非 dry-run 路径在 SoT 根取 `<sotRoot>/.sync.lock/`（**目录**，
 *   原子 mkdir 即互斥原语），覆盖「备份 → apply → 写 sync-meta」整段（只锁 apply
 *   无法阻止并发写入后被过期备份覆盖；writeSyncMetaOnSuccess 的读-改-写同样必须在
 *   锁内）。取不到锁 → ConflictError(3)；持锁期间有心跳，心跳停摆超过
 *   SYNC_LOCK_STALE_MS 且持有者进程已消失的锁才可抢占；产物落在 SoT 之外
 *   （CODEX_HOME / 用户目录）时额外取用户级 SoT 根的锁；
 * - **备份落盘**：备份基准同时写入 `<sotRoot>/.agf-backup/`（journal.json 记录
 *   路径映射与已写入状态），进程被 SIGKILL 后由下次 sync 在锁内检出并恢复；
 *   恢复前校验 journal 的来源（SoT / 机器 / 用户）与每条目标路径的白名单边界；
 * - **回滚前基准复核**：写回备份前复核目标文件当前内容仍等于「本次 sync 写入
 *   的结果」，不等（并发进程 / 编辑器已改动）则报告冲突而非覆盖；
 * - **回滚未完成不销毁备份**：存在 restored=false 的条目时把备份另存为
 *   `.agf-backup-failed-<ts>/` 并写进失败汇总（退出码 6），绝不让用户在被告知
 *   「手工处理」时手上没有 sync 前的原文；
 * - **信号中断**：当前事务句柄经模块级 activeTransaction 暴露，
 *   rollbackActiveSyncTransactionSync 供 main.ts 的信号 / 致命错误处理器同步回滚。
 *
 * M7（Spec §8.2-4）：apply 前执行 marker 区间冲突预检查——读现有投影文件，
 * 区间 hash 与 sync-meta 记录值不一致 → ConflictError(3)；--force 跳过；
 * 首次 sync（无记录）不检查。contentHash 基准同步统一为 marker 区间形态
 * （markers.renderedSectionHash，见其 M6→M7 调整说明）。损坏的 sync-meta
 * 在预检查阶段 fail-fast（ConfigError(2)，sync-meta.ts 契约：不静默丢基准）。
 *
 * 后续里程碑边界：
 * - sync 不刷新 habits.detected（渲染只消费声明字段；重新探测走 aforge detect）；
 * - skills 物化数据源（skillsToMaterialize）M8 skill add 接入；M6 引擎侧
 *   的 write 项 / 备份 / 回滚已就绪（skills copy 为实体 copy 非 symlink，§7.6）。
 */
import { randomBytes } from 'node:crypto';
// 例外：node:fs 的**同步** API 仅用于信号处理器内的事务回滚（见
// rollbackActiveSyncTransactionSync 的 JSDoc 理由说明）；其余 IO 一律经 Host。
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
import { atomicWrite, isPermissionErrno, listDirSafe, mkdirp, sha256Hex } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import type { Habits, Learning, Profile, SyncMeta } from '../../schema';
import { resolveEffectiveConfig } from '../config/defaults';
import { HABITS_FILE, PROFILE_FILE } from '../config/load';
import type { EnvSnapshot, Scope } from '../env';
import { ConfigError, ConflictError, PermissionError } from '../errors';
import { composeRules, type TemplateContent } from '../generate/composer';
import { resolveTemplate } from '../generate/resolver';
import { readLearningLayer } from '../learning/store';
import { markerSectionHash, renderedSectionHash, splitByMarkers } from '../markers';
import {
  currentOs,
  longPathAware,
  type OsContext,
  pathApiFor,
  resolveProjectSoT,
  resolveUserSoT,
  toPosixSeparators,
} from '../paths';
import { readSkillsToMaterialize } from '../sources/skill';
import { projectorRegistry } from './projectors/registry';
import { readSyncMeta, writeSyncMeta } from './sync-meta';
import type { ProjectContext, ProjectionPlan, ProjectionPlanItem, Projector } from './types';
import {
  applyItem,
  DEFAULT_PROJECTION_MARKERS,
  type ProjectionMarkers,
  readExistingForBackup,
} from './writer';

/** Spec §4.2 targets 全集（--targets 合法性校验基准）。 */
export const ALL_TARGET_IDS = ['opencode', 'codex', 'claude', 'pi'] as const;

/** 已注册的 projector（M6 起四件套齐备；经注册表获取，注册顺序即投影顺序）。 */
export const REGISTERED_PROJECTORS: readonly Projector[] = projectorRegistry.list();

/** syncOnce 输入（host/os/cwd 由命令层注入；测试可注入 fake host 与任意平台）。 */
export interface SyncOptions {
  readonly host: Host;
  readonly env: EnvSnapshot;
  readonly os: OsContext;
  /** 项目根（project scope 的投影基准，Spec §2.3）。 */
  readonly cwd: string;
  /** CLI 版本（写入 sync-meta.agentforgeVersion，Spec §3.3）。 */
  readonly agentforgeVersion: string;
  /** --targets 过滤（空 / 未给 → profile.targets 全量）。 */
  readonly targetsFilter?: readonly string[];
  readonly dryRun: boolean;
  /** --force（Spec §8.2-4）：跳过 marker 区间冲突预检查，强制覆盖。 */
  readonly force?: boolean;
}

/** 单个投影项的执行状态（apply 后；dry-run 恒为 'planned'）。 */
export type SyncItemStatus = 'planned' | 'written' | 'unchanged' | 'warning';

/** soft 项失败（§8.6 Pi MVP）：不触发回滚的 best-effort 警告。 */
export interface SyncWarning {
  readonly targetId: string;
  readonly path: string;
  readonly message: string;
}

/** 单个 target 的同步结果（items 为完整计划；statuses 与 items 一一对应）。 */
export interface SyncTargetResult {
  readonly targetId: string;
  readonly items: readonly ProjectionPlanItem[];
  readonly statuses: readonly SyncItemStatus[];
}

/** syncOnce 结果：命令层据此打印绝对路径与摘要。 */
export interface SyncResult {
  readonly scope: Scope;
  readonly userSoTRoot: string;
  readonly projectSoTRoot: string;
  /** sync-meta.json 所在 SoT 根（effectiveScope 对应层，Spec §3.3）。 */
  readonly sotRoot: string;
  /**
   * 渲染正文在 marker 区间形态下的 LF 规范化 sha256（= sync-meta contentHash
   * 基准；M7 起统一为 markers.renderedSectionHash，与投影文件读回的
   * markerSectionHash 可直接相等比较）。
   */
  readonly contentHash: string;
  readonly dryRun: boolean;
  readonly targets: readonly SyncTargetResult[];
  /** profile.targets 中已启用但注册表无 projector 的 target（提示用，非失败）。 */
  readonly skippedTargets: readonly string[];
  /** soft 项（§8.6）apply 失败收集的 warning（不阻塞 sync）。 */
  readonly warnings: readonly SyncWarning[];
  /**
   * 事务设施级警告（**不是**某个 target 的 soft 失败）：崩溃恢复能力降级
   * （备份日志 / 副本写不进去）、保留下来的失败备份目录、恢复阶段需人工核对的条目。
   *
   * 与 warnings 分开：writeSyncMetaOnSuccess 用 warnings 的 targetId 判定
   * 「哪个 target 投影不完整不记账」，把设施级问题混进去会误伤记账。
   */
  readonly transactionWarnings: readonly SyncWarning[];
  /**
   * 项目 `.gitignore` 的投影结果（Spec §4.2 projection.gitignore_generated）：
   * 该开关为 true 且 effective scope=project 时非 null，否则 null。
   *
   * 不并入 `targets`：它不是某个 agent target 的产物，也**不写入 sync-meta**
   * （sync-meta.targets 的 contentHash 是 doctor 的 marker 区间基准，.gitignore
   * 没有规则正文区间可比）。写入仍在同一事务内（备份 / 回滚一视同仁）。
   */
  readonly gitignore: SyncTargetResult | null;
  /**
   * 上次 sync 被强杀（SIGKILL / 断电）后遗留的落盘备份恢复明细（正常为空数组）。
   * 在本次 sync 取锁后、备份阶段之前执行——命令层据此提示用户曾发生崩溃恢复。
   */
  readonly recovered: readonly SyncRollbackEntry[];
}

/** 回滚明细：单文件恢复结果（失败收集 error，不中断其余恢复）。 */
export interface SyncRollbackEntry {
  readonly path: string;
  readonly restored: boolean;
  readonly error?: string;
}

/**
 * 失败汇总报告（§7.3-6）：附着在 rethrow 的原始错误上（getSyncFailureReport
 * 读取），命令层据此输出「每 target 状态表（成功/失败/原因）+ 回滚声明」。
 */
export interface SyncFailureReport {
  /** 失败项所属 target。 */
  readonly failedTargetId: string;
  /** 失败项路径。 */
  readonly failedPath: string;
  /** 全部 target 的终态（按投影顺序；含回滚声明语义）。 */
  readonly targetStatuses: readonly {
    readonly targetId: string;
    /** ok-rolled-back：全部项成功但被回滚；failed：含失败项；not-started：未执行。 */
    readonly status: 'ok-rolled-back' | 'failed' | 'not-started';
  }[];
  /** 逆序恢复的文件明细（restored=false 表示恢复失败）。 */
  readonly rolledBack: readonly SyncRollbackEntry[];
  /**
   * 存在未能恢复的文件时，备份基准被保留到该目录（`.agf-backup-failed-<ts>`）。
   * 命令层必须把它打进失败汇总与退出码 6 的输出——否则用户被告知「手工处理」时
   * 手上没有任何 sync 前的原文。null = 全部恢复成功（无需保留）或保留自身失败。
   */
  readonly preservedBackupDir?: string;
}

/** 失败报告在错误对象上的附加键（非枚举属性，不影响既有错误语义）。 */
const FAILURE_REPORT_KEY = 'agentforgeSyncFailureReport';

/** 读取附着在错误上的失败汇总报告（无 → undefined）。 */
export function getSyncFailureReport(err: unknown): SyncFailureReport | undefined {
  if (typeof err === 'object' && err !== null && FAILURE_REPORT_KEY in err) {
    const report = (err as Record<string, unknown>)[FAILURE_REPORT_KEY];
    return report as SyncFailureReport | undefined;
  }
  return undefined;
}

function attachFailureReport(err: unknown, report: SyncFailureReport): unknown {
  if (typeof err === 'object' && err !== null) {
    try {
      Object.defineProperty(err, FAILURE_REPORT_KEY, {
        value: report,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
      // 附加失败不影响原始错误传播（命令层回退为只打印错误本体）
    }
  }
  return err;
}

// ---------------------------------------------------------------------------
// 事务互斥锁（备份-写入-回滚整段串行化）
// ---------------------------------------------------------------------------

/** SoT 根内的事务锁**目录**名（原子 mkdir 即互斥原语；dry-run 不取锁）。 */
export const SYNC_LOCK_DIRNAME = '.sync.lock';

/** 锁目录内的持有者元数据文件名（pid / acquiredAt / token / 机器 / 用户）。 */
export const SYNC_LOCK_META_FILE = 'meta.json';

/** 陈旧锁阈值：心跳停止超过 5 分钟视为持有者已异常消失，可被抢占。 */
export const SYNC_LOCK_STALE_MS = 5 * 60 * 1000;

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
interface SyncLockHandle {
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
function machineIdOf(host: Host): string {
  return firstNonBlank(host.env('COMPUTERNAME'), host.env('HOSTNAME'), host.hostname());
}

/** 用户标识（同上；USER 在 cron / systemd 下同样可能未导出）。 */
function userIdOf(host: Host): string {
  return firstNonBlank(host.env('USERNAME'), host.env('USER'), host.username());
}

/**
 * 进程是否仍存活（`kill(pid, 0)` 探针，不发送任何信号）。
 *
 * 仅在「同机器 + 同用户」时可信：跨机器的 pid 与本机 pid 空间无关，
 * 跨用户的进程 kill 探针会得到 EPERM（存在但无权限 → 同样按存活处理）。
 */
function isProcessAlive(pid: number): boolean {
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
async function readSyncLockRecord(host: Host, metaFile: string): Promise<SyncLockRecord | null> {
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
function syncLockDir(sotRoot: string, os: OsContext): string {
  return longPathAware(path.join(sotRoot, SYNC_LOCK_DIRNAME), os);
}

/**
 * 锁的「静默时长」：优先取元数据里的最近心跳，元数据不可读时退回锁目录的 mtime。
 *
 * 为什么需要目录 mtime 兜底：胜者创建锁目录与写入元数据之间有一个 await 的窗口，
 * 若此刻另一个进程读不到元数据就判定「陈旧可抢占」，会把刚取得锁的进程挤掉。
 * 目录本身的 mtime 在这个窗口里已经是新鲜的。两者都取不到 → NaN（按陈旧处理）。
 */
async function lockAgeMs(host: Host, dir: string, holder: SyncLockRecord | null): Promise<number> {
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
    const fresh = Number.isFinite(ageMs) && ageMs <= SYNC_LOCK_STALE_MS;
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
async function acquireSyncLocks(
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
async function releaseSyncLocks(host: Host, locks: readonly SyncLockHandle[]): Promise<void> {
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

/**
 * 未初始化检查（Spec §6.1：sync 前置）。
 * 两层 SoT 均无 profile.yaml / habits.yaml → ConfigError(2)。
 */
async function assertInitialized(
  host: Host,
  userSoTRoot: string,
  projectSoTRoot: string,
): Promise<void> {
  const exists = await Promise.all([
    host.exists(path.join(userSoTRoot, PROFILE_FILE)),
    host.exists(path.join(userSoTRoot, HABITS_FILE)),
    host.exists(path.join(projectSoTRoot, PROFILE_FILE)),
    host.exists(path.join(projectSoTRoot, HABITS_FILE)),
  ]);
  if (!exists.some((v) => v)) {
    throw new ConfigError('SoT 未初始化（两层均未找到 profile.yaml / habits.yaml）', {
      hint: '先运行 aforge init',
      details: { userSoTRoot, projectSoTRoot },
    });
  }
}

/**
 * --targets 过滤（Spec §6 命令表）：
 * - 未给 / 空 → profile.targets 全量；
 * - 含未知 target id（不在四个枚举内）→ ConfigError(2)；
 * - 过滤后与 profile.targets 无交集 → ConfigError(2)（指定的 target 未启用）。
 */
export function filterTargets(
  profileTargets: readonly string[],
  filter: readonly string[] | undefined,
): string[] {
  if (filter === undefined || filter.length === 0) {
    return [...profileTargets];
  }
  for (const id of filter) {
    if (!(ALL_TARGET_IDS as readonly string[]).includes(id)) {
      throw new ConfigError(`未知 target: ${id}`, {
        hint: `有效值: ${ALL_TARGET_IDS.join(', ')}`,
        details: { id, filter },
      });
    }
  }
  const requested = profileTargets.filter((t) => filter.includes(t));
  if (requested.length === 0) {
    throw new ConfigError(
      `--targets 指定的 target 未在 profile.targets 中启用（当前启用: ${profileTargets.join(', ')}）`,
      {
        hint: '调整 --targets 或在 profile.yaml 的 targets 中启用该目标',
        details: { filter, profileTargets },
      },
    );
  }
  return requested;
}

/** 读单层 SoT 的 custom/*.md（按文件名序；只取直接子项文件）。 */
async function readCustomLayer(host: Host, sotRoot: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const dir = path.join(sotRoot, 'custom');
  let entries: readonly string[];
  try {
    // 目录不存在 / 不可读：视为无 custom 内容（探测/读取一律降级，不阻塞 sync）。
    // 不做 exists 前置检查——listDir 自身即权威探测（真实 host 对不存在目录抛 ENOENT）。
    entries = await host.listDir(dir);
  } catch {
    return files;
  }
  for (const name of [...entries].sort()) {
    if (!name.endsWith('.md')) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      const stat = await host.stat(file);
      if (!stat.isFile) {
        continue;
      }
      files.set(name, await host.readFile(file));
    } catch {
      // 单文件读取失败：跳过该文件（坏输入不阻塞整体 sync）
    }
  }
  return files;
}

/**
 * 两层 custom/*.md 合并：同名 project 覆盖 user（§5.3 优先级精神），按文件名序输出。
 * SoT 素材始终取两层合并（scope 只决定投影目的地，不裁剪素材来源）。
 */
async function readCustomContents(
  host: Host,
  userSoTRoot: string,
  projectSoTRoot: string,
): Promise<string[]> {
  const [userFiles, projectFiles] = await Promise.all([
    readCustomLayer(host, userSoTRoot),
    readCustomLayer(host, projectSoTRoot),
  ]);
  const merged = new Map(userFiles);
  for (const [name, content] of projectFiles) {
    merged.set(name, content);
  }
  return [...merged.keys()].sort().map((name) => merged.get(name) as string);
}

/**
 * 读取两层 SoT 的 promoted learnings（§5.2 第 ② 层；M8 learn/promote 接入）。
 * 同 id project 覆盖 user（§5.3 同名优先级精神）；按 created_at 稳定排序；
 * profile.learning.include_promoted_in_sync=false 时输出空（§4.2）。
 */
async function readPromotedLearnings(
  host: Host,
  userSoTRoot: string,
  projectSoTRoot: string,
  profile: Profile,
): Promise<string[]> {
  if (profile.learning.include_promoted_in_sync === false) {
    return [];
  }
  const merged = new Map<string, Learning>();
  for (const layer of [userSoTRoot, projectSoTRoot]) {
    for (const learning of await readLearningLayer(host, layer)) {
      merged.set(learning.id, learning);
    }
  }
  return [...merged.values()]
    .filter((l) => l.promoted)
    .sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1,
    )
    .map((l) => l.content);
}

/**
 * 渲染统一规则正文（§7.3-1..3）：
 * custom（两层合并）→ promoted learnings（两层合并，M8 learn/promote 接入）→
 * profile.templates 逐个 resolve（§5.2 未解析 id → ConfigError(2)）→ base/default。
 *
 * M7 起导出：doctor（core/doctor/checks.ts）复用同一渲染路径计算当前 SoT
 * contentHash，与 sync-meta 记录 / 投影区间比对（单一事实源，避免两处漂移）。
 *
 * @param os 宿主平台（`projection.path_style: auto` 的判据，§4.2）；缺省取当前进程
 *   平台——早期调用点（5 参形态）不必改签名即可保持生产语义正确。
 */
export async function renderRulesMd(
  host: Host,
  userSoTRoot: string,
  projectSoTRoot: string,
  habits: Habits,
  profile: Profile,
  os: OsContext = currentOs(),
): Promise<string> {
  const customContents = await readCustomContents(host, userSoTRoot, projectSoTRoot);
  const promotedLearnings = await readPromotedLearnings(host, userSoTRoot, projectSoTRoot, profile);

  const templateContents: TemplateContent[] = [];
  for (const id of profile.templates ?? []) {
    templateContents.push(
      await resolveTemplate(id, {
        host,
        userSoTRoot,
        projectSoTRoot,
        storeRoot: path.join(userSoTRoot, 'store'),
      }),
    );
  }

  return composeRules({
    habits,
    profile,
    customContents,
    promotedLearnings, // M8：learn → promote → sync 后注入 ## Learnings 段（§5.2 第 ② 层）
    templateContents,
    os,
  });
}

/** user scope 投影需要用户目录（rootDir 基准，Spec §8.5）；缺失即配置错误。 */
function requireUserProfileForProjection(env: EnvSnapshot): string {
  if (env.userProfile === undefined || env.userProfile === '') {
    throw new ConfigError('user scope 投影需要用户目录（USERPROFILE 与 HOME 均未设置）', {
      hint: '设置 USERPROFILE（Windows）或 HOME（类 Unix）后重试',
    });
  }
  return env.userProfile;
}

/** 一个 target 的 plan 结果与 apply 状态追踪（事务内部结构）。 */
interface PlannedTarget {
  readonly targetId: string;
  readonly plan: ProjectionPlan;
  /** 与 plan.items 对齐的执行状态（未执行到的项无记录）。 */
  statuses: SyncItemStatus[];
  /** 全部项是否执行完（失败或中断则为 false）。 */
  completed: boolean;
  /** 是否开始执行（false = not-started，失败汇总表用）。 */
  started: boolean;
  /**
   * 写入 sync-meta 的 contentHash：**本次实际落盘的 marker 区间形态**
   * （apply 后读回投影文件计算）。未能读回 → undefined，回退为渲染正文的区间 hash。
   */
  contentHash?: string;
}

/** 失败捕获（事务内部结构）。 */
interface TargetFailure {
  readonly targetId: string;
  readonly itemPath: string;
  readonly error: unknown;
}

/**
 * plan 级标记解析：md marker 恒取 profile 配置（含 marker_mode，§4.2）；
 * TOML 标记段允许 plan 覆盖（§8.4）。
 */
function resolveMarkers(plan: ProjectionPlan, ctx: ProjectContext): ProjectionMarkers {
  return {
    ...DEFAULT_PROJECTION_MARKERS,
    begin: ctx.markerBegin,
    end: ctx.markerEnd,
    mode: ctx.markerMode ?? 'replace_between_markers',
    ...(plan.tomlMarkers !== undefined
      ? { tomlBegin: plan.tomlMarkers.begin, tomlEnd: plan.tomlMarkers.end }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// 事务状态（落盘备份 + 中断回滚句柄）
// ---------------------------------------------------------------------------

/** SoT 根内的落盘备份目录名（事务结束即删除；残留 = 上次被强杀）。 */
export const SYNC_BACKUP_DIRNAME = '.agf-backup';

/** 备份目录内的日志文件名（记录备份副本位置与已写入状态）。 */
export const SYNC_BACKUP_JOURNAL_FILE = 'journal.json';

/**
 * 回滚未能全部完成时保留的备份目录名前缀（`.agf-backup-failed-<时间戳>`）。
 *
 * 改名而非原地保留：`.agf-backup` 是崩溃恢复的入口，留在原地会被下次 sync 当成
 * 「上次被强杀」反复处理；改名后它只是**给用户手工恢复用的证据**，路径会出现在
 * 失败汇总与退出码 6 的输出里。
 */
export const SYNC_BACKUP_FAILED_PREFIX = '.agf-backup-failed-';

/** 单个备份条目（落盘形态）。 */
interface SyncBackupJournalEntry {
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
interface SyncBackupJournal {
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
interface SyncTransaction {
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
 * 逆序恢复全部已动文件（§7.3-6 回滚）：
 * - **写回前复核基准**：读目标当前内容，其 hash 必须仍等于本次 sync 写入的结果；
 *   不等说明并发进程 / 编辑器在本次写入后又改过该文件 → 报告冲突而非覆盖
 *   （restored=false，明细进 report.rolledBack，命令层提示手工处理）；
 * - 备份为 null → 删除本次新建的文件；
 * - 备份非 null → 原样写回（不做换行规范化——恢复 sync 前的逐字节状态）；
 * - mkdirp 预校验创建的目录不回收（空目录残留无害；回滚只聚焦文件内容）；
 * - 单个恢复失败按 best-effort 收集，不中断其余恢复（report.rolledBack 呈现）。
 */
async function rollbackWrites(
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
async function persistJournal(tx: SyncTransaction): Promise<void> {
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
function degradeTransaction(tx: SyncTransaction, reason: string, err?: unknown): void {
  const detail = err instanceof Error ? `: ${err.message}` : '';
  const line = `${reason}${detail}`;
  if (!tx.degradedReasons.includes(line)) {
    tx.degradedReasons.push(line);
  }
}

/** 开启事务：建备份目录 + 空日志，并登记为模块级 activeTransaction（信号回滚用）。 */
async function beginTransaction(
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
async function backupTarget(tx: SyncTransaction, target: string): Promise<void> {
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
async function recordWrite(tx: SyncTransaction, target: string): Promise<void> {
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
 * 删除落盘备份产物（逐个副本 + journal + 目录）。
 *
 * 逐文件删除而非只删目录：Host.rm 的 recursive 语义由实现决定（真实 host 递归，
 * 内存实现可能只删同名 key），显式列举可保证不同实现下都不留残留——残留 journal
 * 会让下次 sync 误以为上次被强杀并执行「恢复」。
 */
async function removeBackupArtifacts(
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
async function discardTransaction(tx: SyncTransaction): Promise<void> {
  detachTransaction(tx);
  await removeBackupArtifacts(tx.host, tx.backupDir, tx.journal);
}

/** 只注销 activeTransaction，**保留**落盘备份（回滚未完成时的数据留存路径）。 */
function detachTransaction(tx: SyncTransaction): void {
  if (activeTransaction === tx) {
    activeTransaction = null;
  }
}

/** 时间戳后缀（`.agf-backup-failed-<ts>` 用；文件名安全：只留数字）。 */
function backupStamp(host: Host): string {
  const iso = host.now().toISOString();
  return iso.replace(/[^0-9]/g, '');
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
async function preserveBackupCopies(
  host: Host,
  os: OsContext,
  sotRoot: string,
  journal: SyncBackupJournal,
  contentOf: (entry: SyncBackupJournalEntry) => Promise<string | null>,
  unresolved: readonly SyncRollbackEntry[],
): Promise<string | null> {
  const dir = longPathAware(
    path.join(sotRoot, `${SYNC_BACKUP_FAILED_PREFIX}${backupStamp(host)}`),
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
async function preserveBackupArtifacts(
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
async function readBackupJournal(
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

/** 去掉 Windows 长路径前缀，使 journal 路径与白名单根可以逐段比较。 */
function stripLongPathPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${p.slice('\\\\?\\UNC\\'.length)}`;
  }
  return p.startsWith('\\\\?\\') ? p.slice('\\\\?\\'.length) : p;
}

/** 目标路径是否落在任一白名单根内（win32 大小写不敏感）。 */
function isWithinAnyRoot(target: string, roots: readonly string[], os: OsContext): boolean {
  const api = pathApiFor(os);
  const fold = (p: string): string => {
    const bare = stripLongPathPrefix(p);
    return os.platform === 'win32' ? bare.toLowerCase() : bare;
  };
  const folded = fold(target);
  return roots.some((root) => {
    const rel = api.relative(fold(root), folded);
    return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
  });
}

/** 恢复流程的产出：逐条结果 + 无法自动恢复时保留的备份目录。 */
interface SyncRecoveryOutcome {
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
 * - journal.sotRoot 必须等于当前 SoT 根；
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
async function recoverPendingTransaction(
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
  const tx = activeTransaction;
  if (tx === null) {
    return [];
  }
  activeTransaction = null;

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
      renameSync(tx.backupDir, `${tx.backupDir}-failed-${Date.now()}`);
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

/**
 * soft 项与 sync-meta（M6 决策，Spec §8.6 / §3.3）：
 * soft 项（pi settings.json）失败的 target **不写入** sync-meta 的该 target 记录
 * （另一可选方案为标记 skipped，但会改动 §3.3 schema）。理由：contentHash 是
 * doctor 一致性检测（M7）的基准，投影不完整的 target 不应提供基准，保留上次
 * 成功记录可让后续 doctor 识别漂移。
 *
 * 并发：此处的读-改-写（保留其他 target 既有记录）必须在 SoT 事务锁内执行，
 * 否则并发的子集 sync（--targets）会互相丢记录——调用点在 syncOnce 的锁作用域内。
 *
 * contentHash 取 `target.contentHash`（本次实际落盘的区间形态）而非渲染正文的区间
 * hash：`marker_mode: append_below_marker` 下落盘区间是「新正文 + 空行 + 旧内容」，
 * 记录渲染正文会让下一次 sync 的区间比对必然不等 → 该模式在其唯一有意义的场景下
 * 恒定误报 ConflictError(3)。读回失败时才退回渲染值（两者在 replace 模式下相等）。
 */
async function writeSyncMetaOnSuccess(
  host: Host,
  opts: SyncOptions,
  os: OsContext,
  sotRoot: string,
  contentHash: string,
  planned: readonly PlannedTarget[],
  warnings: readonly SyncWarning[],
  lineEnding: ProjectContext['lineEnding'],
): Promise<void> {
  const warnedTargets = new Set(warnings.map((w) => w.targetId));
  const existing = await readSyncMeta(host, sotRoot);
  const now = host.now().toISOString();
  const targetsMeta = { ...(existing?.targets ?? {}) };
  for (const target of planned) {
    if (!warnedTargets.has(target.targetId)) {
      targetsMeta[target.targetId] = {
        contentHash: target.contentHash ?? contentHash,
        writtenAt: now,
      };
    }
  }
  await writeSyncMeta(
    host,
    sotRoot,
    {
      version: 1,
      lastSyncAt: now,
      os: os.platform,
      agentforgeVersion: opts.agentforgeVersion,
      targets: targetsMeta,
    },
    lineEnding,
  );
}

/**
 * apply 之后读回投影文件，取本次实际落盘的 marker 区间 hash 作为该 target 的
 * sync-meta 基准（与 assertNoMarkerConflicts / doctor 读回投影后的算法同构）。
 *
 * 只看该 target 的 merge_marker 项（四个 projector 各恰有一个主规则项）；
 * `marker_mode: none` 的整文件 write 没有区间可比 → 返回 undefined 沿用渲染值。
 */
async function readBackSectionHash(
  host: Host,
  target: PlannedTarget,
  markers: ProjectionMarkers,
): Promise<string | undefined> {
  const item = target.plan.items.find((i) => i.action === 'merge_marker');
  if (item === undefined) {
    return undefined;
  }
  try {
    const content = await host.readFile(item.path);
    const split = splitByMarkers(content, markers.begin, markers.end);
    return split.hasMarkers ? markerSectionHash(content, markers.begin, markers.end) : undefined;
  } catch {
    return undefined; // 读不回（权限 / 已被并发删除）：退回渲染正文的区间 hash
  }
}

/**
 * marker 区间冲突预检查（Spec §8.2-4，M7；在备份 / mkdirp 之前执行——
 * 冲突时零副作用，进零目录都不创建）：
 *
 * - 逐个 merge_marker 项：读现有投影文件 → splitByMarkers 判定有区间 → 用
 *   markerSectionHash(现有文件) 与 sync-meta 记录的 contentHash 比对；
 * - 比对基准自洽：sync 记录的 contentHash 就是**上次实际落盘的区间** hash
 *   （writeSyncMetaOnSuccess 读回投影文件计算），与此处的 markerSectionHash 同构，
 *   因此 replace / append 两种 marker_mode 下都不会误报；
 * - 跳过：无 sync-meta / 该 target 无记录（首次或子集 sync）/ 文件不存在 /
 *   文件无 marker（用户已移除区间 → replaceBetween 走 EOF 追加，非冲突）；
 * - 读现有文件权限失败 → PermissionError(4)（与备份阶段同语义）。
 *
 * @throws ConflictError(3) 任一区间 hash 与记录不一致（details.conflicts 列出全部路径）。
 */
async function assertNoMarkerConflicts(
  host: Host,
  planned: readonly PlannedTarget[],
  syncMeta: SyncMeta | null,
  ctx: ProjectContext,
): Promise<void> {
  if (syncMeta === null) {
    return; // 首次 sync（或 sync-meta 尚不存在）：无基准，不检查
  }
  const conflicts: string[] = [];
  for (const target of planned) {
    const recorded = syncMeta.targets[target.targetId];
    if (recorded === undefined) {
      continue; // 该 target 无上次记录（如上次 --targets 子集 sync）
    }
    const markers = resolveMarkers(target.plan, ctx);
    for (const item of target.plan.items) {
      if (item.action !== 'merge_marker') {
        continue; // 只检查 md marker 区间（§8.2-4；merge_toml/json 不在本检测范围）
      }
      if (!(await host.exists(item.path))) {
        continue; // 投影文件不存在：sync 将新建，无区间可比
      }
      let existing: string;
      try {
        existing = await host.readFile(item.path);
      } catch (err) {
        if (isPermissionErrno(err)) {
          throw new PermissionError(`无法读取现有投影文件（冲突预检查）: ${item.path}`, {
            hint: '检查文件的读权限与所在目录 ACL（必要时以管理员身份运行）',
            details: err,
          });
        }
        throw err;
      }
      const split = splitByMarkers(existing, markers.begin, markers.end);
      if (!split.hasMarkers) {
        continue;
      }
      if (markerSectionHash(existing, markers.begin, markers.end) !== recorded.contentHash) {
        conflicts.push(item.path);
      }
    }
  }
  if (conflicts.length > 0) {
    throw new ConflictError('marker 区间可能被手动修改，请执行 aforge doctor 查看详情', {
      hint: '确认修改无需保留后执行 aforge sync --force 强制覆盖；否则请先恢复区间内容',
      details: { conflicts },
    });
  }
}

// ---------------------------------------------------------------------------
// .gitignore 投影（Spec §4.2 projection.gitignore_generated）
// ---------------------------------------------------------------------------

/** 项目根下的 .gitignore 文件名。 */
export const GITIGNORE_FILE = '.gitignore';

/**
 * .gitignore 在 SyncResult 里的伪 target id（不属于 ALL_TARGET_IDS，
 * 也不写 sync-meta.targets——仅用于命令层输出标注）。
 */
export const GITIGNORE_TARGET_ID = 'gitignore';

/**
 * .gitignore 内的 AgentForge 标记段（`#` 注释前缀——`.gitignore` 不支持 HTML
 * 注释，故不能复用 profile.projection 的 markdown marker）。段外用户条目原样保留，
 * 段内每次 sync 全量重算 → 幂等。
 */
export const GITIGNORE_MARKER_BEGIN = '# BEGIN AGENTFORGE';
export const GITIGNORE_MARKER_END = '# END AGENTFORGE';

/** .gitignore 写入用的标记对（只用 begin/end；action 恒为 merge_marker）。 */
const GITIGNORE_MARKERS: ProjectionMarkers = {
  ...DEFAULT_PROJECTION_MARKERS,
  begin: GITIGNORE_MARKER_BEGIN,
  end: GITIGNORE_MARKER_END,
  mode: 'replace_between_markers',
};

// ---------------------------------------------------------------------------
// 运行时残留诊断（doctor 用；只读，不清理任何东西）
// ---------------------------------------------------------------------------

/** 残留类型（doctor 按此选级别与文案）。 */
export type SyncResidualKind = 'lock-live' | 'lock-stale' | 'journal-pending' | 'backup-failed';

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
 * 唯一的原文副本，诊断路径上销毁它就是把「请手工处理」和「已被我删掉」同时告知，
 * 属于 C001 那一类错误。清理时机只有两处：正常事务结束、以及下次 sync 的崩溃恢复。
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
    const fresh = Number.isFinite(ageMs) && ageMs < SYNC_LOCK_STALE_MS;
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
    found.push({
      kind: 'journal-pending',
      path: journalFile,
      detail: `未提交的事务日志：${journal.entries.length} 个备份条目、${pending} 个已写入（起于 ${journal.startedAt || '未知时刻'}，pid ${journal.pid}）`,
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

/** 投影路径 → 根锚定的 gitignore 模式（`/AGENTS.md`、`/.codex/config.toml`）。 */
function gitignorePattern(target: string, projectRoot: string, os: OsContext): string | undefined {
  const api = pathApiFor(os);
  const rel = api.relative(projectRoot, target);
  if (rel === '' || rel.startsWith('..') || api.isAbsolute(rel)) {
    return undefined; // 项目根之外（user scope 投影 / CODEX_HOME 覆盖）：不进 .gitignore
  }
  return `/${toPosixSeparators(rel)}`;
}

/**
 * AgentForge 自身的运行时产物在 SoT 根下的根锚定目录模式（事务锁 / 备份 /
 * 回滚失败保留副本）。
 *
 * 为什么必须一并忽略：`<sotRoot>/.sync.lock/` 与 `<sotRoot>/.agf-backup/` 在 sync
 * 期间存在，`.agf-backup-failed-<ts>/` 在回滚不完整时会长期保留——三者都是**本机
 * 进程态 / 单机备份**，提交进仓库不仅无意义，还会让 clone 到别的机器上的仓库带着
 * 一个"别人的锁目录"，本机 sync 会据此误判有并发写入而拒绝执行。
 *
 * @returns 落在项目根内时的模式列表；SoT 根在项目根之外（user scope /
 *          AGF_HOME 指向别处）时为空数组——判据与投影产物共用 gitignorePattern。
 */
function runtimeGitignorePatterns(sotRoot: string, projectRoot: string, os: OsContext): string[] {
  const api = pathApiFor(os);
  const names = [SYNC_LOCK_DIRNAME, SYNC_BACKUP_DIRNAME, `${SYNC_BACKUP_FAILED_PREFIX}*`];
  const patterns: string[] = [];
  for (const name of names) {
    const pattern = gitignorePattern(api.join(sotRoot, name), projectRoot, os);
    if (pattern !== undefined) {
      patterns.push(`${pattern}/`); // 目录形式：只忽略目录，同名文件不受影响
    }
  }
  return patterns;
}

/**
 * 构造 .gitignore 投影项（Spec §4.2 projection.gitignore_generated=true 时）。
 *
 * 收集全部 target 的投影产物路径 + AgentForge 自身的运行时产物（见
 * runtimeGitignorePatterns）→ 只取落在项目根内的 → 转根锚定 posix 模式
 * （`.gitignore` 的分隔符恒为 `/`，与 projection.path_style 无关）→ 去重排序。
 *
 * @returns 投影项；无任何项目内产物时 undefined（不写空标记段）。
 */
export function buildGitignoreItem(
  planned: readonly { readonly plan: ProjectionPlan }[],
  projectRoot: string,
  sotRoot: string,
  os: OsContext,
): ProjectionPlanItem | undefined {
  const patterns = new Set<string>();
  for (const target of planned) {
    for (const item of target.plan.items) {
      const pattern = gitignorePattern(item.path, projectRoot, os);
      if (pattern !== undefined) {
        patterns.add(pattern);
      }
    }
  }
  for (const pattern of runtimeGitignorePatterns(sotRoot, projectRoot, os)) {
    patterns.add(pattern);
  }
  if (patterns.size === 0) {
    return undefined;
  }
  return {
    path: longPathAware(path.join(projectRoot, GITIGNORE_FILE), os),
    action: 'merge_marker',
    content: [...patterns].sort().join('\n'),
  };
}

/**
 * 执行一次 sync（Spec §7.3，四 target 全事务版）。
 *
 * @throws ConfigError(2) 未初始化 / --targets 非法 / 模板解析失败 / 配置损坏 /
 *         sync-meta.json 损坏（冲突预检查阶段 fail-fast）；
 * @throws PermissionError(4) 目录创建失败（§7.3-7）/ 备份读取失败 / 投影写入失败；
 * @throws ConflictError(3) marker 区间被手动修改（§8.2-4，--force 跳过）/
 *         merge_json 目标损坏（writer 层映射）/ 同一 SoT 已有 sync 在写入
 *         （`<sotRoot>/.sync.lock/` 被占用，心跳停摆且持有者进程消失才可抢占）；
 *         投影失败时先回滚全部已写文件再 rethrow 原始错误（类型与退出码不变，
 *         失败汇总经 getSyncFailureReport(err) 获取）。
 */
export async function syncOnce(opts: SyncOptions): Promise<SyncResult> {
  const { host, env, os, cwd } = opts;
  const userSoTRoot = resolveUserSoT(env, os);
  const projectSoTRoot = resolveProjectSoT(cwd, os);
  const config = await resolveEffectiveConfig(env, userSoTRoot, projectSoTRoot, host);

  await assertInitialized(host, userSoTRoot, projectSoTRoot);

  const requested = filterTargets(config.profile.targets, opts.targetsFilter);
  const renderedRulesMd = await renderRulesMd(
    host,
    userSoTRoot,
    projectSoTRoot,
    config.habits,
    config.profile,
    os,
  );
  // M8：skills.always 物化数据源（§7.6 实体 copy；同名 project > user，§5.3）
  const skillsToMaterialize = await readSkillsToMaterialize(
    host,
    userSoTRoot,
    projectSoTRoot,
    config.profile,
  );

  const ctx: ProjectContext = {
    os,
    scope: config.effectiveScope,
    rootDir: config.effectiveScope === 'project' ? cwd : requireUserProfileForProjection(env),
    renderedRulesMd,
    habits: config.habits,
    profile: config.profile,
    skillsToMaterialize, // M8：skill add 接入（write 项/事务 M6 已就绪）
    mcpServers: config.profile.mcp.servers ?? [],
    dryRun: opts.dryRun,
    lineEnding: config.profile.projection.line_ending,
    markerBegin: config.profile.projection.marker_begin,
    markerEnd: config.profile.projection.marker_end,
    markerMode: config.profile.projection.marker_mode,
    env,
  };

  // ---- 阶段 1：plan 全部 target（纯函数；失败 fail-fast，无需回滚）----
  const planned: PlannedTarget[] = [];
  const skippedTargets: string[] = [];
  for (const targetId of requested) {
    const projector = projectorRegistry.get(targetId);
    if (projector === undefined) {
      skippedTargets.push(targetId);
      continue;
    }
    const plan = projector.plan(ctx);
    planned.push({ targetId, plan, statuses: [], completed: false, started: false });
  }

  if (planned.length === 0) {
    throw new ConfigError('没有可同步的 target', {
      hint: `注册表中可用的 target: ${ALL_TARGET_IDS.join(', ')}`,
      details: { requested, skippedTargets },
    });
  }

  const contentHash = renderedSectionHash(renderedRulesMd, ctx.markerBegin, ctx.markerEnd);

  const sotRoot = config.effectiveScope === 'project' ? projectSoTRoot : userSoTRoot;

  // ---- 阶段 1.4：.gitignore 项（§4.2 gitignore_generated；仅 project scope）----
  // user scope 的投影落在用户目录，没有"项目仓库"概念，故不产出。
  const gitignoreItem =
    config.profile.projection.gitignore_generated === true && config.effectiveScope === 'project'
      ? buildGitignoreItem(planned, cwd, sotRoot, os)
      : undefined;

  // ---- 阶段 1.5：marker 区间冲突预检查（§8.2-4；--force 跳过；此刻零写入）----
  if (opts.force !== true) {
    const syncMeta = await readSyncMeta(host, sotRoot);
    await assertNoMarkerConflicts(host, planned, syncMeta, ctx);
  }

  // ---- dry-run：返回完整计划，不 mkdirp / 不备份 / 不 apply / 不写 sync-meta ----
  if (opts.dryRun) {
    return {
      scope: config.effectiveScope,
      userSoTRoot,
      projectSoTRoot,
      sotRoot,
      contentHash,
      dryRun: true,
      targets: planned.map((t) => ({
        targetId: t.targetId,
        items: t.plan.items,
        statuses: t.plan.items.map(() => 'planned' as const),
      })),
      skippedTargets,
      warnings: [],
      transactionWarnings: [],
      gitignore:
        gitignoreItem === undefined
          ? null
          : { targetId: GITIGNORE_TARGET_ID, items: [gitignoreItem], statuses: ['planned'] },
      recovered: [],
    };
  }

  // ---- 阶段 1.6：取事务锁（覆盖备份 → apply → 写 sync-meta 整段）----
  // 只锁 apply 是不够的：并发进程若在「备份」与「apply」之间写入同一 AGENTS.md，
  // 本次失败回滚会用过期备份把对方的改动覆盖掉。
  // 锁按根取，但产物可能落在 SoT 之外（CODEX_HOME 指向用户目录时两个项目会并发写
  // 同一个 ~/.codex/config.toml）→ 此时额外取用户级 SoT 根的锁，按路径序加锁防死锁。
  const allItemPaths = [
    ...planned.flatMap((t) => t.plan.items.map((i) => i.path)),
    ...(gitignoreItem === undefined ? [] : [gitignoreItem.path]),
  ];
  const outsideRoots = [env.userProfile, env.codexHome].filter(
    (root): root is string => root !== undefined && root !== '',
  );
  const locks = await acquireSyncLocks(
    host,
    resolveLockRoots(sotRoot, userSoTRoot, cwd, allItemPaths, outsideRoots, os),
    os,
  );

  let tx: SyncTransaction | undefined;
  // 回滚未全部成功时保留备份目录（否则 finally 的清理会销毁用户唯一的 sync 前原文）
  let preservedBackupDir: string | null = null;
  let rollbackIncomplete = false;
  try {
    // ---- 阶段 1.7：恢复上次被强杀（SIGKILL）遗留的落盘备份（锁内执行）----
    // 白名单：journal 的目标路径必须落在这些根内，否则拒绝恢复（不信任磁盘上的 JSON）
    const allowedRoots = [
      sotRoot,
      userSoTRoot,
      projectSoTRoot,
      cwd,
      ...outsideRoots,
      ...allItemPaths.map((p) => path.dirname(p)),
    ];
    const recovery = await recoverPendingTransaction(host, os, sotRoot, allowedRoots);
    const recovered = recovery.entries;

    // ---- 阶段 2：写入预校验——全部待写目录 mkdirp（§7.3-7；失败即抛，未写任何文件）----
    const dirs = new Set<string>();
    for (const target of planned) {
      for (const item of target.plan.items) {
        dirs.add(path.dirname(item.path));
      }
    }
    if (gitignoreItem !== undefined) {
      dirs.add(path.dirname(gitignoreItem.path));
    }
    for (const dir of dirs) {
      await mkdirp(host, dir);
    }

    // ---- 阶段 3：备份——内存 + 落盘副本（null = 不存在；按路径去重，共享文件只备份一次）----
    tx = await beginTransaction(host, os, sotRoot, locks);
    for (const target of planned) {
      for (const item of target.plan.items) {
        await backupTarget(tx, item.path);
      }
    }
    if (gitignoreItem !== undefined) {
      await backupTarget(tx, gitignoreItem.path); // .gitignore 与投影产物同一事务
    }

    // ---- 阶段 4：逐一 apply（幂等跳写 + soft 容错；硬项失败 → 回滚并 rethrow）----
    const warnings: SyncWarning[] = [];
    let failure: TargetFailure | undefined;

    for (const target of planned) {
      if (failure !== undefined) {
        break; // 已失败：后续 target 一律不再执行（not-started）
      }
      target.started = true;
      const markers = resolveMarkers(target.plan, ctx);
      for (const item of target.plan.items) {
        try {
          const wrote = await applyItem(host, item, ctx.lineEnding, markers);
          target.statuses.push(wrote ? 'written' : 'unchanged');
          if (wrote) {
            await recordWrite(tx, item.path);
          }
        } catch (err) {
          if (item.soft === true) {
            // §8.6 Pi MVP soft：失败仅 warning，不计入失败、不触发回滚
            target.statuses.push('warning');
            warnings.push({
              targetId: target.targetId,
              path: item.path,
              message: err instanceof Error ? err.message : String(err),
            });
            continue;
          }
          failure = { targetId: target.targetId, itemPath: item.path, error: err };
          break;
        }
      }
      target.completed = failure === undefined;
      if (failure === undefined) {
        // sync-meta 的基准取本次实际落盘的区间形态（见 writeSyncMetaOnSuccess）
        target.contentHash = await readBackSectionHash(host, target, markers);
      }
    }

    // ---- 阶段 4.5：.gitignore（§4.2）——全部 target 成功后写，与它们同一事务 ----
    let gitignoreResult: SyncTargetResult | null = null;
    if (gitignoreItem !== undefined && failure === undefined) {
      try {
        const wrote = await applyItem(host, gitignoreItem, ctx.lineEnding, GITIGNORE_MARKERS);
        if (wrote) {
          await recordWrite(tx, gitignoreItem.path);
        }
        gitignoreResult = {
          targetId: GITIGNORE_TARGET_ID,
          items: [gitignoreItem],
          statuses: [wrote ? 'written' : 'unchanged'],
        };
      } catch (err) {
        // 硬项：与投影产物同等对待（回滚 + rethrow），不静默吞掉写入失败
        failure = { targetId: GITIGNORE_TARGET_ID, itemPath: gitignoreItem.path, error: err };
      }
    }

    // ---- 阶段 5：失败 → 逆序回滚全部已动文件 → rethrow 原始错误（附失败汇总）----
    if (failure !== undefined) {
      const fail = failure;
      const rolledBack = await rollbackWrites(host, tx.writtenFiles, tx.backups, tx.writtenHashes);
      rollbackIncomplete = rolledBack.some((entry) => !entry.restored);
      if (rollbackIncomplete) {
        // 未恢复的文件在磁盘上是**新**内容，其 sync 前原文只剩那份 .bak → 必须留证据
        preservedBackupDir = await preserveBackupArtifacts(tx, rolledBack);
      }
      const report: SyncFailureReport = {
        failedTargetId: fail.targetId,
        failedPath: fail.itemPath,
        targetStatuses: planned.map((t) => ({
          targetId: t.targetId,
          status: !t.started
            ? 'not-started'
            : t.targetId === fail.targetId
              ? 'failed'
              : 'ok-rolled-back',
        })),
        rolledBack,
        ...(preservedBackupDir === null ? {} : { preservedBackupDir }),
      };
      throw attachFailureReport(fail.error, report);
    }

    // ---- 阶段 5.5：提交标记 —— 写 sync-meta 之前把 journal 标记为已提交 ----
    // 提交与 finally 删 journal 之间被强杀时，下次 sync 不得把已成功提交的投影当
    // 未完成事务回滚（子集 sync 不会重写被回滚的其他 target → 磁盘与 sync-meta 不一致）
    tx.journal.committed = true;
    await persistJournal(tx);

    // ---- 阶段 6：全部成功 → 写 sync-meta（soft 失败的 target 不记，见上方 JSDoc）----
    await writeSyncMetaOnSuccess(
      host,
      opts,
      os,
      sotRoot,
      contentHash,
      planned,
      warnings,
      ctx.lineEnding,
    );

    return {
      scope: config.effectiveScope,
      userSoTRoot,
      projectSoTRoot,
      sotRoot,
      contentHash,
      dryRun: false,
      targets: planned.map((t) => ({
        targetId: t.targetId,
        items: t.plan.items,
        statuses: t.statuses,
      })),
      skippedTargets,
      warnings,
      transactionWarnings: transactionWarningsOf(tx, sotRoot, recovery.preservedDir),
      gitignore: gitignoreResult,
      recovered,
    };
  } finally {
    if (tx !== undefined) {
      if (rollbackIncomplete && preservedBackupDir === null) {
        // 备份保留失败：宁可留下 .agf-backup（下次 sync 会按 journal 恢复）也不删除
        detachTransaction(tx);
      } else {
        await discardTransaction(tx);
      }
    }
    await releaseSyncLocks(host, locks);
  }
}

/** 事务设施级警告文本（崩溃恢复降级 + 恢复阶段保留的备份目录）。 */
function transactionWarningsOf(
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

/** transactionWarnings 的伪 targetId（不属于 ALL_TARGET_IDS，不参与 sync-meta 记账）。 */
const TRANSACTION_WARNING_TARGET_ID = '(transaction)';
