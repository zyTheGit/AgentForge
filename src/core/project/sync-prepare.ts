/**
 * Sync 的准备阶段（Spec §7.3 第 1-3 条）：初始化检查 → 目标过滤 → 渲染正文。
 *
 * 这一段全是「读 + 纯计算」，不写任何文件：失败一律 fail-fast（ConfigError(2)），
 * 此时尚未动过磁盘，因此不需要事务与回滚——把它与写入阶段分成两个模块，正是为了
 * 让「哪些失败无需回滚」在文件边界上就看得出来。
 *
 * renderedRulesMd 在整个 sync 中只渲染一次，再分发给全部 target（§8.2）。
 * skills 与命令薄壳的解析（resolveSkillsForProjection）也在这一段：它同样是
 * 「读 SoT + 纯计算」，失败即 fail-fast，与写入阶段无关。
 */
import path from 'node:path';
import type { Host } from '../../infra/host';
import type { Habits, Learning, Profile } from '../../schema';
import { describeUnknownTargetId } from '../adapters/diagnostics';
import { HABITS_FILE, PROFILE_FILE } from '../config/load';
import type { EnvSnapshot } from '../env';
import { ConfigError } from '../errors';
import { composeRules, type TemplateContent } from '../generate/composer';
import { resolveTemplate } from '../generate/resolver';
import { effectiveAutoCapture } from '../learning/auto-capture';
import { readLearningLayer } from '../learning/store';
import { currentOs, type OsContext } from '../paths';
import type { SkillMaterializeSkip } from '../sources/skill';
import { readSkillsToMaterialize } from '../sources/skill';
import { resolveCommandsToExpose } from './commands';
import { registeredTargetIds } from './projectors/registry';
import type { SyncItemStatus } from './sync-types';
import type { CommandArtifact, ProjectContext, ProjectionPlan, SkillArtifact } from './types';
import { DEFAULT_PROJECTION_MARKERS, type ProjectionMarkers } from './writer';

/**
 * 未初始化检查（Spec §6.1：sync 前置）。
 * 两层 SoT 均无 profile.yaml / habits.yaml → ConfigError(2)。
 */
export async function assertInitialized(
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
 * - 含未知 target id（**不在注册表内**）→ ConfigError(2)；
 * - 过滤后与 profile.targets 无交集 → ConfigError(2)（指定的 target 未启用）。
 *
 * 校验基准是 `registeredTargetIds()`（每次现取），不是内置四件套的字面量常量：
 * 常量与注册表是两份事实源，后补注册的 target 会被判为「未知」而永远进不来。
 *
 * 未知 id 的提示走 `describeUnknownTargetId`（与 `schema/profile.TargetEnum` 同一份
 * 文案）：「打错了」「适配器加载失败」「project 层未授权」三种成因的修法完全不同，
 * 只列一遍有效值会让用户对着一个没问题的 adapters/*.yaml 反复检查。
 */
export function filterTargets(
  profileTargets: readonly string[],
  filter: readonly string[] | undefined,
): string[] {
  if (filter === undefined || filter.length === 0) {
    return [...profileTargets];
  }
  const known = registeredTargetIds();
  for (const id of filter) {
    if (!known.includes(id)) {
      throw new ConfigError(`未知 target: ${id}`, {
        hint: describeUnknownTargetId(id, known),
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
 *
 * 出口是**渲染就绪的字符串**：trigger 非空时前置一行 `**When:** <trigger>`（§4.3
 * 的 trigger 是"何时应用此规则"，不进投影等于采集了却不影响任何输出）。拼接放在
 * 这里而不是 composer：composer 只吃字符串、不引入 Learning schema 依赖，§4.3
 * 字段演化牵动不到渲染层。
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
    .map(renderLearningBody);
}

/** 单条 promoted learning 的投影正文：trigger 非空 → `**When:** …` + 空行 + content。 */
function renderLearningBody(learning: Learning): string {
  const trigger = learning.trigger.trim();
  return trigger === '' ? learning.content : `**When:** ${trigger}\n\n${learning.content}`;
}

/**
 * 渲染统一规则正文（§7.3-1..3）：
 * custom（两层合并）→ promoted learnings（两层合并，M8 learn/promote 接入）→
 * profile.templates 逐个 resolve（§5.2 未解析 id → ConfigError(2)）→ base/default。
 *
 * M7 起导出：doctor（core/doctor/check-consistency.ts 的 renderForDoctor）复用同一
 * 渲染路径计算当前 SoT contentHash，与 sync-meta 记录 / 投影区间比对（单一事实源，
 * 避免两处漂移）。
 *
 * 刻意**不吃 EnvSnapshot**：正文必须与环境无关，否则同一份 SoT 在 CI 与本地会渲染出
 * 不同的 marker 区间（contentHash 不同），跨环境的 hash 比对全部失真。
 * `learning.auto_capture` 因此只经 effectiveAutoCapture（与 CI 无关，§7.4）。
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
    // §7.4：有效档位由 learning 层判定，**与环境无关**（CI、本机装了哪个 CLI 都不影响
    // 渲染），否则同一份 SoT 会渲染出不同 marker 区间 → contentHash 跨环境漂移。
    // 只有 prompt 档插 `## Learning Protocol` 段；hook 档走会话钩子那条投递通道
    autoCapture: effectiveAutoCapture(profile),
  });
}

/** user scope 投影需要用户目录（rootDir 基准，Spec §8.5）；缺失即配置错误。 */
export function requireUserProfileForProjection(env: EnvSnapshot): string {
  if (env.userProfile === undefined || env.userProfile === '') {
    throw new ConfigError('user scope 投影需要用户目录（USERPROFILE 与 HOME 均未设置）', {
      hint: '设置 USERPROFILE（Windows）或 HOME（类 Unix）后重试',
    });
  }
  return env.userProfile;
}

/** 本轮 skills 相关的三份产出（技能正文 / 命令薄壳 / 跳过的 on_demand 名字）。 */
export interface ResolvedSkills {
  readonly artifacts: readonly SkillArtifact[];
  readonly commands: readonly CommandArtifact[];
  readonly skips: readonly SkillMaterializeSkip[];
}

/**
 * 解析本轮的 skills 与命令薄壳（§7.6 / §8.8 / Phase 2 `skills.on_demand`）。
 *
 * 两步合成一个函数，是因为第二步必须吃第一步的结果：`expose_as_command` 的子集
 * 校验比对的是**实际可物化的技能**，而不是静态的 `skills.always`（§5.3 合并后
 * 两者可能不同层）。
 *
 * 命令薄壳只认 `always` 的技能（`skills.filter(a => a.onDemand !== true)`）：
 * §8.8 明写「必须是 skills.always 的子集」，doctor 的 skills-expose-as-command
 * 也按 `skills.always` 判定——放 on_demand 进来，两处判据立刻分叉（doctor 报
 * error(2) 而 sync 通过）。
 *
 * @throws ConfigError(2) `skills.always` 声明的技能未安装 / `expose_as_command`
 *         条目非法或不是已装技能的子集（异常契约见被调两函数）。
 */
export async function resolveSkillsForProjection(
  host: Host,
  userSoTRoot: string,
  projectSoTRoot: string,
  profile: Profile,
): Promise<ResolvedSkills> {
  const materialized = await readSkillsToMaterialize(host, userSoTRoot, projectSoTRoot, profile);
  const alwaysOnly = materialized.artifacts.filter((artifact) => artifact.onDemand !== true);
  return {
    artifacts: materialized.artifacts,
    commands: resolveCommandsToExpose(profile, alwaysOnly),
    skips: materialized.skips,
  };
}

/** 一个 target 的 plan 结果与 apply 状态追踪（事务内部结构）。 */
export interface PlannedTarget {
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
export interface TargetFailure {
  readonly targetId: string;
  readonly itemPath: string;
  readonly error: unknown;
}

/**
 * plan 级标记解析：md marker 恒取 profile 配置（含 marker_mode，§4.2）；
 * TOML 标记段允许 plan 覆盖（§8.4）。
 */
export function resolveMarkers(plan: ProjectionPlan, ctx: ProjectContext): ProjectionMarkers {
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
