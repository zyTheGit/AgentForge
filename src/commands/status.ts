/**
 * aforge status 命令（Spec §6 / §2.2，M7）：SoT 状态与路径一览。
 *
 * 输出（纯 ASCII）：
 * - 两层 scope 与 SoT 根绝对路径 + 初始化状态；
 * - effective scope 与启用 targets 及各自将写入的绝对路径（§2.2：status
 *   必须打印实际将写入的绝对路径——取 projector.plan 的全部 items 路径，
 *   含 skills / mcp 配置等非 md 项）；
 * - 最近一次成功 sync 时间（effective scope 层 sync-meta.lastSyncAt；
 *   无记录 → never）；
 * - custom / learnings / templates 计数（两层合并、同名 / 同 id 去重——
 *   与渲染素材口径一致：project 覆盖 user）；
 * - profile.skills 的 always / on_demand 清单——on_demand 在 MVP 中**只登记不物化**
 *   （Spec §4.2 注记），在此如实标注，避免该字段静默无效；
 * - --json 输出机器可读 JSON（路径一律绝对路径）。
 *
 * 只读命令：不做渲染（profile.templates 未解析不影响路径展示，环境探测
 * 归 aforge doctor）；坏 YAML / 损坏 sync-meta → ConfigError(2) fail-fast。
 */
import path from 'node:path';
import type { Command } from 'commander';
import { resolveEffectiveConfig } from '../core/config/defaults';
import { HABITS_FILE, PROFILE_FILE } from '../core/config/load';
import { readEnv, type Scope } from '../core/env';
import { ConfigError } from '../core/errors';
import { resolveProjectSoT, resolveUserSoT } from '../core/paths';
import { projectorRegistry } from '../core/project/projectors/registry';
import { readSyncMeta } from '../core/project/sync-meta';
import type { ProjectContext } from '../core/project/types';
import { listDirSafe } from '../infra/fsutil';
import type { FileStat, Host } from '../infra/host';
import { type CommandContext, defaultCommandContext, printJson, renderList } from './context';
import { resolveJsonFlag } from './flags';

/** 命令上下文（host/os/cwd 注入；测试可换 fake host 与任意平台）。 */
export type StatusCommandContext = CommandContext;

/** 单个启用 target 的写入路径（plan items 全量）。 */
export interface StatusTargetInfo {
  readonly targetId: string;
  readonly paths: readonly string[];
}

/** custom / learnings / templates 计数（两层合并去重）。 */
export interface StatusCounts {
  readonly custom: number;
  readonly learnings: number;
  readonly templates: number;
}

/** status 结果（--json 的序列化形态；路径一律绝对路径）。 */
export interface StatusResult {
  readonly effectiveScope: Scope;
  /** user SoT 根绝对路径；用户目录不可解析 → null（详情见 aforge doctor）。 */
  readonly userSoTRoot: string | null;
  readonly projectSoTRoot: string;
  /** 两层初始化状态（有 profile.yaml / habits.yaml 之一即 initialized）。 */
  readonly initialized: Readonly<{ user: boolean; project: boolean }>;
  /** profile.targets 声明的全部 target id（含本版本无 projector 的）。 */
  readonly enabledTargets: readonly string[];
  /** 启用且可投影的 target 及写入路径。 */
  readonly targets: readonly StatusTargetInfo[];
  /** profile.targets 中本版本无 projector 的 target（提示用，非失败）。 */
  readonly skippedTargets: readonly string[];
  /** 最近一次成功 sync（effective scope 层 sync-meta.lastSyncAt；无 → null）。 */
  readonly lastSyncAt: string | null;
  readonly counts: StatusCounts;
  /** profile.skills.always：会被 sync 物化并投影的 skill 名。 */
  readonly alwaysSkills: readonly string[];
  /**
   * profile.skills.on_demand：**MVP 只登记不物化**（Spec §4.2 注记）。
   * 在此展示，是为了让「声明了但不会被投影」这件事可见——否则该字段静默无效。
   */
  readonly onDemandSkills: readonly string[];
}

/** stat 失败（不存在 / 不可访问）→ 非文件。 */
async function isFileSafe(host: Host, file: string): Promise<boolean> {
  try {
    return (await host.stat(file)).isFile;
  } catch {
    return false;
  }
}

/** 统计各层 custom/*.md 文件名集合（同名 project 覆盖 user，与渲染素材一致）。 */
async function countCustomFiles(host: Host, ...roots: readonly string[]): Promise<number> {
  const names = new Set<string>();
  for (const root of roots) {
    const dir = path.join(root, 'custom');
    for (const name of await listDirSafe(host, dir)) {
      if (name.endsWith('.md') && (await isFileSafe(host, path.join(dir, name)))) {
        names.add(name);
      }
    }
  }
  return names.size;
}

/** 统计各层 learnings/*.yaml|*.yml（去扩展名即 learning id；同 id 合并）。 */
async function countLearningFiles(host: Host, ...roots: readonly string[]): Promise<number> {
  const ids = new Set<string>();
  for (const root of roots) {
    for (const name of await listDirSafe(host, path.join(root, 'learnings'))) {
      if (name.endsWith('.yaml')) {
        ids.add(name.slice(0, -'.yaml'.length));
      } else if (name.endsWith('.yml')) {
        ids.add(name.slice(0, -'.yml'.length));
      }
    }
  }
  return ids.size;
}

/** 递归收集 templates/ 下 .md 文件的相对 id（模板 id 可含 /，§5.2）。 */
async function collectTemplateIds(
  host: Host,
  dir: string,
  prefix: string,
  ids: Set<string>,
): Promise<void> {
  for (const name of await listDirSafe(host, dir)) {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    let stat: FileStat | undefined;
    try {
      stat = await host.stat(path.join(dir, name));
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory) {
      await collectTemplateIds(host, path.join(dir, name), rel, ids);
    } else if (name.endsWith('.md') && (stat === undefined || stat.isFile)) {
      // stat 不可得（无目录概念的实现）时按 .md 后缀计入；嵌套 id 目录见下方递归
      ids.add(rel);
    } else if (stat === undefined) {
      // 非文件后缀且 stat 不可得：可能是子目录，递归探测（无内容则自然为空）
      await collectTemplateIds(host, path.join(dir, name), rel, ids);
    }
  }
}

/** 统计各层 templates/ 下 .md 模板数（相对路径 id 合并，project 覆盖 user）。 */
async function countTemplateFiles(host: Host, ...roots: readonly string[]): Promise<number> {
  const ids = new Set<string>();
  for (const root of roots) {
    await collectTemplateIds(host, path.join(root, 'templates'), '', ids);
  }
  return ids.size;
}

/** 一层 SoT 是否有 profile.yaml / habits.yaml 之一。 */
async function isInitialized(host: Host, sotRoot: string): Promise<boolean> {
  return (
    (await host.exists(path.join(sotRoot, PROFILE_FILE))) ||
    (await host.exists(path.join(sotRoot, HABITS_FILE)))
  );
}

/**
 * status 核心逻辑（可注入、不打印）。
 *
 * @throws ConfigError(2) 未初始化 / 坏 YAML / user scope 缺用户目录 / 损坏 sync-meta。
 */
export async function runStatus(ctx: StatusCommandContext): Promise<StatusResult> {
  const { host, cwd, os } = ctx;
  const env = readEnv(host);

  // ---- 两层 SoT 根（user 不可解析 → null；装配用 project 根占位，与 doctor 一致）----
  let userSoTRoot: string | null = null;
  try {
    userSoTRoot = resolveUserSoT(env, os);
  } catch {
    userSoTRoot = null; // 不重复报错（doctor 的 user-sot-root 条目负责诊断），保证 status 可用
  }
  const projectSoTRoot = resolveProjectSoT(cwd, os);
  const userRootForLoad = userSoTRoot ?? projectSoTRoot;

  // ---- 初始化检查（两层均无 → ConfigError(2)，与 sync 前置一致）----
  const userInit = userSoTRoot !== null && (await isInitialized(host, userSoTRoot));
  const projectInit = await isInitialized(host, projectSoTRoot);
  if (!(userInit || projectInit)) {
    throw new ConfigError('SoT 未初始化（两层均未找到 profile.yaml / habits.yaml）', {
      hint: '先运行 aforge init；环境问题可运行 aforge doctor 查看详情',
      details: { userSoTRoot, projectSoTRoot },
    });
  }

  // ---- 配置装配 + 各 target 写入路径（渲染正文留空：status 只展示路径）----
  const config = await resolveEffectiveConfig(env, userRootForLoad, projectSoTRoot, host);
  const rootDir = config.effectiveScope === 'project' ? cwd : env.userProfile;
  if (rootDir === undefined || rootDir === '') {
    throw new ConfigError('user scope 投影需要用户目录（USERPROFILE 与 HOME 均未设置）', {
      hint: '设置 USERPROFILE（Windows）或 HOME（类 Unix）后重试',
    });
  }
  const planCtx: ProjectContext = {
    os,
    scope: config.effectiveScope,
    rootDir,
    renderedRulesMd: '',
    habits: config.habits,
    profile: config.profile,
    skillsToMaterialize: [],
    mcpServers: config.profile.mcp.servers ?? [],
    dryRun: true,
    lineEnding: config.profile.projection.line_ending,
    markerBegin: config.profile.projection.marker_begin,
    markerEnd: config.profile.projection.marker_end,
    markerMode: config.profile.projection.marker_mode,
    env,
  };

  const targets: StatusTargetInfo[] = [];
  const skipped: string[] = [];
  for (const targetId of config.profile.targets) {
    const projector = projectorRegistry.get(targetId);
    if (projector === undefined) {
      skipped.push(targetId);
      continue;
    }
    targets.push({ targetId, paths: projector.plan(planCtx).items.map((i) => i.path) });
  }

  // ---- 最近 sync（effective scope 层；损坏 → ConfigError(2) fail-fast）----
  const sotRoot = config.effectiveScope === 'project' ? projectSoTRoot : userRootForLoad;
  const syncMeta = await readSyncMeta(host, sotRoot);

  // ---- 素材计数（两层合并去重；project 覆盖 user——与渲染素材口径一致）----
  const counts: StatusCounts = {
    custom: await countCustomFiles(host, userRootForLoad, projectSoTRoot),
    learnings: await countLearningFiles(host, userRootForLoad, projectSoTRoot),
    templates: await countTemplateFiles(host, userRootForLoad, projectSoTRoot),
  };

  return {
    effectiveScope: config.effectiveScope,
    userSoTRoot,
    projectSoTRoot,
    initialized: { user: userInit, project: projectInit },
    enabledTargets: [...config.profile.targets],
    targets,
    skippedTargets: skipped,
    lastSyncAt: syncMeta?.lastSyncAt ?? null,
    counts,
    alwaysSkills: config.profile.skills.always ?? [],
    onDemandSkills: config.profile.skills.on_demand ?? [],
  };
}

/** SoT 根描述行：`<绝对路径> (initialized|not initialized)`。 */
function describeSoTRoot(root: string | null, initialized: boolean): string {
  if (root === null) {
    return '(unresolvable - see aforge doctor)';
  }
  return `${root} (${initialized ? 'initialized' : 'not initialized'})`;
}

/** 人类可读输出（纯 ASCII；调用方 console.log）。 */
export function formatStatus(result: StatusResult): string {
  const lines: string[] = ['aforge status - source of truth overview', ''];

  lines.push('scope:');
  lines.push(`  user     : ${describeSoTRoot(result.userSoTRoot, result.initialized.user)}`);
  lines.push(`  project  : ${describeSoTRoot(result.projectSoTRoot, result.initialized.project)}`);
  lines.push(`  effective: ${result.effectiveScope}`);
  lines.push('');

  lines.push(`targets (${result.enabledTargets.length} enabled):`);
  for (const target of result.targets) {
    lines.push(`  ${target.targetId}:`);
    for (const file of target.paths) {
      lines.push(`    ${file}`);
    }
  }
  for (const id of result.skippedTargets) {
    lines.push(`  ${id}: (no projector in this version)`);
  }
  lines.push('');

  lines.push(`last sync: ${result.lastSyncAt ?? '(never - run aforge sync)'}`);
  lines.push('');

  lines.push('counts (two layers merged, project overrides user on collision):');
  lines.push(`  custom    : ${result.counts.custom} file(s)`);
  lines.push(`  learnings : ${result.counts.learnings} entry(ies)`);
  lines.push(`  templates : ${result.counts.templates} template(s)`);

  lines.push('');
  lines.push('skills (profile.skills):');
  const always = renderList(result.alwaysSkills);
  const onDemand = renderList(result.onDemandSkills);
  lines.push(`  always    : ${always} (materialized by sync)`);
  // MVP 决定：on_demand 只登记不物化（Spec §4.2 注记）——如实说明，避免用户
  // 以为声明后就会被投影
  lines.push(`  on_demand : ${onDemand} (declared only - not projected in MVP)`);

  return lines.join('\n');
}

/** 注册 status 命令（由 cli.ts 装配调用）。 */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('show SoT scope, target paths, last sync time and content counts')
    .option('--json', 'print machine-readable JSON (absolute paths)')
    .action(async (options: { json?: boolean }, command: Command) => {
      const result = await runStatus(defaultCommandContext());
      if (resolveJsonFlag(command, options.json)) {
        printJson(result);
      } else {
        console.log(formatStatus(result));
      }
    });
}
