/**
 * Sync 引擎 v1（Spec §7.3，M5 单 target 版）。
 *
 * 流程：解析 SoT 根 → 三层配置装配（resolveEffectiveConfig）→ 初始化检查 →
 * 渲染统一 renderedRulesMd（custom + promoted learnings[空] + templates + base/default，
 * §5.2 四层）→ projector.plan()（纯函数）→ 逐项 apply / dry-run → 写 sync-meta.json
 * （§3.3：lastSyncAt / os / agentforgeVersion / targets[].contentHash+writtenAt）。
 *
 * M5 边界（M6 升级点）：
 * - 逐项顺序执行，失败即中断向上抛（不做全 target 事务回滚，§7.3-6）；
 * - 仅注册 claude projector；profile.targets 中其余 target 记入 skipped；
 * - sync 不刷新 habits.detected（渲染只消费声明字段；探测快照仅在 init 落盘，
 *   重新探测走 aforge detect / 后续版本的刷新入口）；
 * - marker 区间冲突检测（§8.2-4，对比 sync-meta 记录 hash）留待 M7 doctor。
 */
import path from 'node:path';
import type { Host } from '../../infra/host';
import { sha256Hex } from '../../infra/fsutil';
import type { EnvSnapshot, Scope } from '../env';
import { resolveProjectSoT, resolveUserSoT, type OsContext } from '../paths';
import { ConfigError } from '../errors';
import { HABITS_FILE, PROFILE_FILE } from '../config/load';
import { resolveEffectiveConfig } from '../config/defaults';
import { composeRules, type TemplateContent } from '../generate/composer';
import { resolveTemplate } from '../generate/resolver';
import type { Habits, Profile } from '../../schema';
import { claudeProjector } from './projectors/claude';
import { readSyncMeta, writeSyncMeta } from './sync-meta';
import { applyItem, DEFAULT_PROJECTION_MARKERS } from './writer';
import type { ProjectContext, Projector, ProjectionPlanItem } from './types';

/** Spec §4.2 targets 全集（--targets 合法性校验基准）。 */
export const ALL_TARGET_IDS = ['opencode', 'codex', 'claude', 'pi'] as const;

/** 已注册的 projector（M5：仅 claude；M6 起补齐其余三个）。 */
export const REGISTERED_PROJECTORS: readonly Projector[] = [claudeProjector];

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
}

/** 单个 target 的同步结果（items 为完整计划；dry-run 时即"将写入"列表）。 */
export interface SyncTargetResult {
  readonly targetId: string;
  readonly items: readonly ProjectionPlanItem[];
}

/** syncOnce 结果：命令层据此打印绝对路径与摘要。 */
export interface SyncResult {
  readonly scope: Scope;
  readonly userSoTRoot: string;
  readonly projectSoTRoot: string;
  /** sync-meta.json 所在 SoT 根（effectiveScope 对应层，Spec §3.3）。 */
  readonly sotRoot: string;
  /** renderedRulesMd 的 LF 规范化 sha256（= sync-meta contentHash 基准）。 */
  readonly contentHash: string;
  readonly dryRun: boolean;
  readonly targets: readonly SyncTargetResult[];
  /** profile.targets 中已启用但本版本无 projector 的 target（提示用，非失败）。 */
  readonly skippedTargets: readonly string[];
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
 * 渲染统一规则正文（§7.3-1..3）：
 * custom（两层合并）→ promoted learnings（M5 恒空，M7 learn/promote 接入）→
 * profile.templates 逐个 resolve（§5.2 未解析 id → ConfigError(2)）→ base/default。
 */
async function renderRulesMd(
  host: Host,
  userSoTRoot: string,
  projectSoTRoot: string,
  habits: Habits,
  profile: Profile,
): Promise<string> {
  const customContents = await readCustomContents(host, userSoTRoot, projectSoTRoot);

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
    promotedLearnings: [], // M7：learn → promote → sync 后注入 ## Learnings 段
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

/**
 * 执行一次 sync（Spec §7.3，单 target 闭环版）。
 *
 * @throws ConfigError(2) 未初始化 / --targets 非法 / 模板解析失败 / 配置损坏；
 * @throws PermissionError(4) 投影路径无写权限（Spec §7.3-7）；
 * @throws ConflictError(3) merge_json 目标损坏（writer 层映射）。
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

  const ctx: ProjectContext = {
    os,
    scope: config.effectiveScope,
    rootDir:
      config.effectiveScope === 'project' ? cwd : requireUserProfileForProjection(env),
    renderedRulesMd,
    habits: config.habits,
    profile: config.profile,
    skillsToMaterialize: [], // M8：skills 物化（copy_mode）
    mcpServers: config.profile.mcp.servers ?? [], // M6/M8：MCP 投影
    dryRun: opts.dryRun,
    lineEnding: config.profile.projection.line_ending,
    markerBegin: config.profile.projection.marker_begin,
    markerEnd: config.profile.projection.marker_end,
  };

  const byId = new Map(REGISTERED_PROJECTORS.map((p) => [p.id, p]));
  const targets: SyncTargetResult[] = [];
  const skippedTargets: string[] = [];
  for (const targetId of requested) {
    const projector = byId.get(targetId);
    if (projector === undefined) {
      skippedTargets.push(targetId);
      continue;
    }
    const plan = projector.plan(ctx);
    const markers = {
      ...DEFAULT_PROJECTION_MARKERS,
      begin: ctx.markerBegin,
      end: ctx.markerEnd,
    };
    for (const item of plan.items) {
      if (!opts.dryRun) {
        await applyItem(host, item, ctx.lineEnding, markers);
      }
    }
    targets.push({ targetId, items: plan.items });
  }

  if (targets.length === 0) {
    throw new ConfigError('没有可同步的 target', {
      hint: `当前版本仅支持: ${REGISTERED_PROJECTORS.map((p) => p.id).join(', ')}；其余 target 将在后续里程碑提供`,
      details: { requested, skippedTargets },
    });
  }

  // sync-meta.json（§3.3）：写到 effectiveScope 对应层；保留其他 target 的既有记录
  const sotRoot = config.effectiveScope === 'project' ? projectSoTRoot : userSoTRoot;
  const contentHash = sha256Hex(renderedRulesMd);
  if (!opts.dryRun) {
    const existing = await readSyncMeta(host, sotRoot);
    const now = host.now().toISOString();
    const targetsMeta = { ...(existing?.targets ?? {}) };
    for (const t of targets) {
      targetsMeta[t.targetId] = { contentHash, writtenAt: now };
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
      ctx.lineEnding,
    );
  }

  return {
    scope: config.effectiveScope,
    userSoTRoot,
    projectSoTRoot,
    sotRoot,
    contentHash,
    dryRun: opts.dryRun,
    targets,
    skippedTargets,
  };
}
