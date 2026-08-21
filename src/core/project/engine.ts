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
import path from 'node:path';
import type { Host } from '../../infra/host';
import { atomicWrite, isPermissionErrno, mkdirp, sha256Hex } from '../../infra/fsutil';
import type { EnvSnapshot, Scope } from '../env';
import { resolveProjectSoT, resolveUserSoT, type OsContext } from '../paths';
import { ConflictError, ConfigError, PermissionError } from '../errors';
import { HABITS_FILE, PROFILE_FILE } from '../config/load';
import { resolveEffectiveConfig } from '../config/defaults';
import { composeRules, type TemplateContent } from '../generate/composer';
import { resolveTemplate } from '../generate/resolver';
import { renderedSectionHash, splitByMarkers } from '../markers';
import { readLearningLayer } from '../learning/store';
import { readSkillsToMaterialize } from '../sources/skill';
import type { Habits, Learning, Profile, SyncMeta } from '../../schema';
import { projectorRegistry } from './projectors/registry';
import { readSyncMeta, writeSyncMeta } from './sync-meta';
import {
  applyItem,
  DEFAULT_PROJECTION_MARKERS,
  readExistingForBackup,
  TOML_MARKER_BEGIN,
  TOML_MARKER_END,
  type ProjectionMarkers,
} from './writer';
import type { ProjectContext, Projector, ProjectionPlan, ProjectionPlanItem } from './types';

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
 */
export async function renderRulesMd(
  host: Host,
  userSoTRoot: string,
  projectSoTRoot: string,
  habits: Habits,
  profile: Profile,
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
}

/** 失败捕获（事务内部结构）。 */
interface TargetFailure {
  readonly targetId: string;
  readonly itemPath: string;
  readonly error: unknown;
}

/** plan 级标记解析：md marker 恒取 profile 配置；TOML 标记段允许 plan 覆盖（§8.4）。 */
function resolveMarkers(plan: ProjectionPlan, ctx: ProjectContext): ProjectionMarkers {
  return {
    ...DEFAULT_PROJECTION_MARKERS,
    begin: ctx.markerBegin,
    end: ctx.markerEnd,
    ...(plan.tomlMarkers !== undefined
      ? { tomlBegin: plan.tomlMarkers.begin, tomlEnd: plan.tomlMarkers.end }
      : {}),
  };
}

/**
 * 逆序恢复全部已动文件（§7.3-6 回滚）：
 * - 备份为 null → 删除本次新建的文件；
 * - 备份非 null → 原样写回（不做换行规范化——恢复 sync 前的逐字节状态）；
 * - mkdirp 预校验创建的目录不回收（空目录残留无害；回滚只聚焦文件内容）；
 * - 单个恢复失败按 best-effort 收集，不中断其余恢复（report.rolledBack 呈现）。
 */
async function rollbackWrites(
  host: Host,
  writtenFiles: readonly string[],
  backups: ReadonlyMap<string, string | null>,
): Promise<SyncRollbackEntry[]> {
  const entries: SyncRollbackEntry[] = [];
  for (const file of [...writtenFiles].reverse()) {
    const backup = backups.get(file) ?? null;
    try {
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
 * soft 项与 sync-meta（M6 决策，Spec §8.6 / §3.3）：
 * soft 项（pi settings.json）失败的 target **不写入** sync-meta 的该 target 记录
 * （另一可选方案为标记 skipped，但会改动 §3.3 schema）。理由：contentHash 是
 * doctor 一致性检测（M7）的基准，投影不完整的 target 不应提供基准，保留上次
 * 成功记录可让后续 doctor 识别漂移。
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
      targetsMeta[target.targetId] = { contentHash, writtenAt: now };
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
 * marker 区间冲突预检查（Spec §8.2-4，M7；在备份 / mkdirp 之前执行——
 * 冲突时零副作用，进零目录都不创建）：
 *
 * - 逐个 merge_marker 项：读现有投影文件 → splitByMarkers → 有区间时，
 *   markerSectionHash(现有文件) 与 sync-meta 记录的 contentHash 比对；
 * - 比对基准自洽：sync 写入的 contentHash = renderedSectionHash(renderedRulesMd)
 *   = 区间包裹后切回的 hash，与读回投影文件的 markerSectionHash 同构；
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
      if (sha256Hex(split.inside) !== recorded.contentHash) {
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

/**
 * 执行一次 sync（Spec §7.3，四 target 全事务版）。
 *
 * @throws ConfigError(2) 未初始化 / --targets 非法 / 模板解析失败 / 配置损坏 /
 *         sync-meta.json 损坏（冲突预检查阶段 fail-fast）；
 * @throws PermissionError(4) 目录创建失败（§7.3-7）/ 备份读取失败 / 投影写入失败；
 * @throws ConflictError(3) marker 区间被手动修改（§8.2-4，--force 跳过）/
 *         merge_json 目标损坏（writer 层映射）；
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
    rootDir:
      config.effectiveScope === 'project' ? cwd : requireUserProfileForProjection(env),
    renderedRulesMd,
    habits: config.habits,
    profile: config.profile,
    skillsToMaterialize, // M8：skill add 接入（write 项/事务 M6 已就绪）
    mcpServers: config.profile.mcp.servers ?? [],
    dryRun: opts.dryRun,
    lineEnding: config.profile.projection.line_ending,
    markerBegin: config.profile.projection.marker_begin,
    markerEnd: config.profile.projection.marker_end,
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

  // ---- 阶段 1.5：marker 区间冲突预检查（§8.2-4；--force 跳过；此刻零写入）----
  const sotRoot = config.effectiveScope === 'project' ? projectSoTRoot : userSoTRoot;
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
    };
  }

  // ---- 阶段 2：写入预校验——全部待写目录 mkdirp（§7.3-7；失败即抛，未写任何文件）----
  const dirs = new Set<string>();
  for (const target of planned) {
    for (const item of target.plan.items) {
      dirs.add(path.dirname(item.path));
    }
  }
  for (const dir of dirs) {
    await mkdirp(host, dir);
  }

  // ---- 阶段 3：备份——逐项读现有内容（null = 不存在；按路径去重，共享文件只备份一次）----
  const backups = new Map<string, string | null>();
  for (const target of planned) {
    for (const item of target.plan.items) {
      if (!backups.has(item.path)) {
        backups.set(item.path, await readExistingForBackup(host, item.path));
      }
    }
  }

  // ---- 阶段 4：逐一 apply（幂等跳写 + soft 容错；硬项失败 → 回滚并 rethrow）----
  const writtenFiles: string[] = [];
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
          writtenFiles.push(item.path);
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
  }

  // ---- 阶段 5：失败 → 逆序回滚全部已动文件 → rethrow 原始错误（附失败汇总）----
  if (failure !== undefined) {
    const fail = failure;
    const rolledBack = await rollbackWrites(host, writtenFiles, backups);
    const report: SyncFailureReport = {
      failedTargetId: fail.targetId,
      failedPath: fail.itemPath,
      targetStatuses: planned.map((t) => ({
        targetId: t.targetId,
        status: !t.started ? 'not-started' : t.targetId === fail.targetId ? 'failed' : 'ok-rolled-back',
      })),
      rolledBack,
    };
    throw attachFailureReport(fail.error, report);
  }

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
  };
}
