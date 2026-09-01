/**
 * aforge status 命令（Spec §6 / §2.2，M7）：SoT 状态与路径一览。
 *
 * 输出（UTF-8 终端上色 + 符号，GBK 控制台与管道自动降级为纯 ASCII，见 infra/ui）：
 * - 两层 scope 与 SoT 根绝对路径 + 初始化状态；
 * - effective scope 与启用 targets 及各自将写入的绝对路径（§2.2：status
 *   必须打印实际将写入的绝对路径——取 projector.plan 的全部 items 路径，
 *   含 skills / mcp 配置等非 md 项），以及各 target 的**技能调用前缀**
 *   （§6.1 / §8.8：codex 为 `$<name>`，其余三家为 `/<name>`）；
 * - 最近一次成功 sync 时间（effective scope 层 sync-meta.lastSyncAt；
 *   无记录 → never）；
 * - custom / learnings / templates 计数（两层合并、同名 / 同 id 去重——
 *   与渲染素材口径一致：project 覆盖 user）；
 * - profile.skills 的 always / on_demand 清单——on_demand 在 MVP 中**只登记不物化**
 *   （Spec §4.2 注记），在此如实标注，避免该字段静默无效；
 * - profile.learning.auto_capture 的声明值与生效值（§7.4）：`prompt` 时说明投影正文含
 *   `## Learning Protocol` 段，`hook` 时如实列出钩子装到哪几个 target、哪几个没有
 *   钩子落点（等同 off），CI 下补一句"本次不会写入"；
 * - --json 输出机器可读 JSON（路径一律绝对路径）。
 *
 * 只读命令：不做渲染（profile.templates 未解析不影响路径展示，环境探测
 * 归 aforge doctor）；坏 YAML / 损坏 sync-meta → ConfigError(2) fail-fast。
 */
import path from 'node:path';
import type { Command } from 'commander';
import { resolveEffectiveConfig } from '../../core/config/defaults';
import { HABITS_FILE, PROFILE_FILE } from '../../core/config/load';
import { readEnv, type Scope } from '../../core/env';
import { ConfigError } from '../../core/errors';
import {
  type AutoCaptureState,
  LEARNING_PROTOCOL_HEADING,
  rendersLearningProtocol,
  resolveAutoCapture,
  writesSessionHooks,
} from '../../core/learning/auto-capture';
import { SESSION_HOOK_EVENT } from '../../core/learning/hook-capture';
import { resolveProjectSoT, resolveUserSoT } from '../../core/paths';
import { projectorRegistry } from '../../core/project/projectors/registry';
import { readSyncMeta } from '../../core/project/sync-meta';
import { partitionSessionHookTargets } from '../../core/project/sync-notices';
import type { ProjectContext, SkillInvokePrefix } from '../../core/project/types';
import { listDirSafe } from '../../infra/fsutil';
import type { FileStat, Host } from '../../infra/host';
import { getUi, type Ui } from '../../infra/ui';
import type { AutoCapture } from '../../schema';
import {
  type CommandContext,
  defaultCommandContext,
  printJson,
  renderList,
} from '../_shared/context';
import { resolveJsonFlag } from '../_shared/flags';

/** 命令上下文（host/os/cwd 注入；测试可换 fake host 与任意平台）。 */
export type StatusCommandContext = CommandContext;

/** 单个启用 target 的写入路径（plan items 全量）与技能调用前缀。 */
export interface StatusTargetInfo {
  readonly targetId: string;
  readonly paths: readonly string[];
  /**
   * 该 target 里调用已装技能的前缀（§6.1 要求 status 打印；§8.8 实测表）。
   *
   * 取值域复用 Projector 契约的 SkillInvokePrefix，不宽化成 string——`--json` 的对外
   * 类型契约与 core 侧保持同一精度，映射表也只有 projector 一处事实源。
   */
  readonly skillInvokePrefix: SkillInvokePrefix;
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
  /**
   * profile.learning.auto_capture 的声明值与生效值（§7.4）。
   *
   * 三档现在都各自生效，declared 与 effective 恒等（保留两个字段：将来若再引入
   * 需要归并的档位，"声明了但被降级"这件事必须可见）。`hook` 档的降级发生在
   * **target 粒度**：hookTargets / hookUnsupportedTargets 如实列出钩子装到哪几家、
   * 哪几家等同 off，避免"声明了 hook 却什么都没发生"变成静默。
   * `ciNote` 另说一件事——CI 下 learnings 恒不落盘，但**生效档位与投影正文不变**
   * （否则 contentHash 跨环境不稳定）。
   */
  readonly autoCapture: Readonly<{
    declared: AutoCapture;
    effective: AutoCapture;
    reason: string | null;
    ciNote: string | null;
    /** hook 档下会被写入会话钩子的已启用 target（非 hook 档为空数组）。 */
    hookTargets: readonly string[];
    /** hook 档下没有钩子落点、行为等同 off 的已启用 target（非 hook 档为空数组）。 */
    hookUnsupportedTargets: readonly string[];
  }>;
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
    commandsToExpose: [],
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
    targets.push({
      targetId,
      paths: projector.plan(planCtx).items.map((i) => i.path),
      skillInvokePrefix: projector.skillInvokePrefix,
    });
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

  const autoCapture = resolveAutoCapture(config.profile, env);
  // §7.4 hook 档的支持度按 target 粒度报（能力声明在各 projector 上，不做环境探测）
  const hookSplit = partitionSessionHookTargets(
    writesSessionHooks(autoCapture.effective),
    config.profile.targets,
    projectorRegistry.list(),
  );

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
    autoCapture: {
      declared: autoCapture.declared,
      effective: autoCapture.effective,
      reason: describeAutoCaptureReason(autoCapture, hookSplit),
      ciNote: describeAutoCaptureCiNote(autoCapture),
      hookTargets: hookSplit.capable,
      hookUnsupportedTargets: hookSplit.incapable,
    },
  };
}

/**
 * hook 档下"这次到底会不会装上钩子"的一句话说明（其余档位 → null）。
 *
 * 只在**一家都装不上**时才出这句：此时声明了 hook 却整体等同 off，不说等于静默。
 * 部分支持的情况由 hookTargets / hookUnsupportedTargets 两张名单自己表达
 * （formatStatus 逐行打印），不再重复一句概括。
 */
function describeAutoCaptureReason(
  state: AutoCaptureState,
  hookSplit: { readonly capable: readonly string[] },
): string | null {
  if (!writesSessionHooks(state.effective) || hookSplit.capable.length > 0) {
    return null;
  }
  return 'no enabled target supports session hooks - behaves as off';
}

/**
 * 当前环境下会不会真的采集（非 CI → null）。
 *
 * 与 reason 分开：CI 只挡*写入*（§7.4 护栏 3），不改变生效档位与投影正文——
 * 否则同一份 SoT 在 CI 与本地会渲染出不同的 contentHash。
 */
function describeAutoCaptureCiNote(state: AutoCaptureState): string | null {
  return state.ciNoCapture
    ? 'CI detected - no learnings will be written (projected rules are unchanged)'
    : null;
}

/** SoT 根描述行：`<绝对路径> (initialized|not initialized)`。 */
function describeSoTRoot(root: string | null, initialized: boolean, ui: Ui): string {
  if (root === null) {
    return ui.yellow('(unresolvable - see aforge doctor)');
  }
  const state = initialized ? ui.green('initialized') : ui.yellow('not initialized');
  return `${ui.path(root)} (${state})`;
}

/** kv 行的 label 宽度（scope / counts / skills 三组共用，保证冒号同列）。 */
const LABEL_WIDTH = 9;

/** counts / skills 组的 label 宽度（`auto_capture` 最长，故单独一档）。 */
const WIDE_LABEL_WIDTH = 10;

/**
 * 人类可读输出（调用方 console.log）。
 *
 * @param ui 呈现能力（默认取进程级单例；ASCII 档与改造前逐字节一致，见 infra/ui）。
 */
export function formatStatus(result: StatusResult, ui: Ui = getUi()): string {
  const lines: string[] = [...ui.title('aforge status', 'source of truth overview')];

  lines.push(ui.bold('scope:'));
  lines.push(
    ui.kv('user', describeSoTRoot(result.userSoTRoot, result.initialized.user, ui), LABEL_WIDTH),
  );
  lines.push(
    ui.kv(
      'project',
      describeSoTRoot(result.projectSoTRoot, result.initialized.project, ui),
      LABEL_WIDTH,
    ),
  );
  lines.push(ui.kv('effective', ui.cyan(result.effectiveScope), LABEL_WIDTH));
  lines.push('');

  lines.push(ui.bold(`targets (${result.enabledTargets.length} enabled):`));
  for (const target of result.targets) {
    // 前缀取自 projector.skillInvokePrefix（映射表的单一事实源在各 projector 里，
    // 见 core/project/types.ts 的 Projector 契约）。不打这一行，用户在 codex 里敲
    // `/name` 不展开，会以为投影没生效。
    lines.push(
      `  ${ui.bold(target.targetId)} (invoke skills as ${ui.cyan(`${target.skillInvokePrefix}<name>`)}):`,
    );
    for (const file of target.paths) {
      lines.push(`    ${ui.path(file)}`);
    }
  }
  for (const id of result.skippedTargets) {
    lines.push(`  ${id}: ${ui.dim('(no projector in this version)')}`);
  }
  lines.push('');

  lines.push(`last sync: ${result.lastSyncAt ?? ui.yellow('(never - run aforge sync)')}`);
  lines.push('');

  lines.push(ui.bold('counts (two layers merged, project overrides user on collision):'));
  lines.push(ui.kv('custom', `${result.counts.custom} file(s)`, WIDE_LABEL_WIDTH));
  lines.push(ui.kv('learnings', `${result.counts.learnings} entry(ies)`, WIDE_LABEL_WIDTH));
  lines.push(ui.kv('templates', `${result.counts.templates} template(s)`, WIDE_LABEL_WIDTH));

  lines.push('');
  lines.push(ui.bold('skills (profile.skills):'));
  const always = renderList(result.alwaysSkills);
  const onDemand = renderList(result.onDemandSkills);
  lines.push(ui.kv('always', `${always} ${ui.dim('(materialized by sync)')}`, WIDE_LABEL_WIDTH));
  // MVP 决定：on_demand 只登记不物化（Spec §4.2 注记）——如实说明，避免用户
  // 以为声明后就会被投影
  lines.push(
    ui.kv(
      'on_demand',
      `${onDemand} ${ui.dim('(declared only - not projected in MVP)')}`,
      WIDE_LABEL_WIDTH,
    ),
  );

  lines.push('');
  lines.push(ui.bold('learning (profile.learning):'));
  // 声明值与生效值分开打：将来若再引入被归并的档位，只打一个会骗人
  const capture = result.autoCapture;
  lines.push(
    `  ${ui.dim('auto_capture')}: ${capture.declared}${capture.declared === capture.effective ? '' : ` -> ${ui.yellow(capture.effective)}`}`,
  );
  if (capture.reason !== null) {
    lines.push(`                ${ui.dim(capture.reason)}`);
  }
  if (rendersLearningProtocol(capture.effective)) {
    lines.push(
      `                ${ui.dim(`projected rules include a ${LEARNING_PROTOCOL_HEADING} section`)}`,
    );
  }
  // hook 档：钩子装到哪几家、哪几家没有落点（等同 off）——两张名单都要可见
  if (capture.hookTargets.length > 0) {
    lines.push(
      `                ${ui.dim(`session hook (${SESSION_HOOK_EVENT}) written for: ${renderList(capture.hookTargets)}`)}`,
    );
  }
  if (capture.hookUnsupportedTargets.length > 0) {
    lines.push(
      `                ${ui.yellow(`no session hook target: ${renderList(capture.hookUnsupportedTargets)} (behaves as off)`)}`,
    );
  }
  if (capture.ciNote !== null) {
    lines.push(`                ${ui.dim(capture.ciNote)}`);
  }

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
