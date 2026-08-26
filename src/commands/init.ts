/**
 * aforge init 命令（Spec §7.1 非交互路径；§7.1.1 -i 交互五步，M9）。
 *
 * 非交互：确定 scope 与 SoT 根 → 探测（快照进 habits.detected）→ 创建目录结构
 * （custom/learnings/templates/skills/mcp）→ 原子写 habits.yaml（声明字段空骨架 +
 * detected 快照）与 profile.yaml（windowsDefaultProfile 按 scope 调整）→
 * 打印创建的绝对路径列表。
 *
 * 交互（-i，Spec §7.1.1 五步 ≤5 次确认）：
 * ① Scope 选择（select，默认 project；--scope / AGF_SCOPE 已给则跳过询问）
 * ② Detector 运行并打印探测结果
 * ③ 确认探测结果（Y 确认 / n 重新探测 / edit 手动编辑——先落盘 habits.yaml
 *    骨架与全部子目录，confirm 等待编辑完成后重新读取）
 * ④ 目标 Agent multiselect（默认全选，hint 显示各 target 主规则绝对路径）
 * ⑤ 写入确认（将创建的文件列表；选 n → cancelled，profile.yaml 不写盘，但 ③
 *    edit 分支已落盘的 habits.yaml 与子目录保留并在结果中回报）→ 可选立即 sync
 *
 * 任一提问处 Ctrl-C / Esc：此前已落盘的产物清单挂到取消错误上回传，命令层打印
 * 后重抛（退出码 130 由 main.ts 统一出口给出）。
 *
 * 交互结果持久化：habits.yaml（探测确认后的 detected 快照 / edit 后的用户
 * 编辑内容）与 profile.yaml（④ 选择的 targets）。
 *
 * SoT 根已存在且非空 → ConfigError(2)（Spec §6.1「init 目录非空」），不覆盖用户
 * 已有内容。正常输出纯 ASCII（Windows GBK 控制台兼容，见 cli.ts 约定）；交互 UI 文案
 * 随 clack 渲染（TTY 环境下 UTF-8）。
 */
import path from 'node:path';
import type { Command } from 'commander';
import { stringify as stringifyYaml } from 'yaml';
import { defaultHabits, windowsDefaultProfile } from '../core/config/defaults';
import { HABITS_FILE, loadHabits, PROFILE_FILE } from '../core/config/load';
import type { DetectedSnapshot } from '../core/detector/engine';
import { runDetection } from '../core/detector/engine';
import type { EnvSnapshot, Scope } from '../core/env';
import { readEnv } from '../core/env';
import { ConfigError } from '../core/errors';
import { resolveProjectSoT, resolveUserSoT, SKILLS_DIRNAME } from '../core/paths';
import { ALL_TARGET_IDS, syncOnce } from '../core/project/engine';
import { claudeMainRulePath } from '../core/project/projectors/claude';
import { codexMainRulePath } from '../core/project/projectors/codex';
import { opencodeMainRulePath } from '../core/project/projectors/opencode';
import { piMainRulePath } from '../core/project/projectors/pi';
import type { ProjectContext } from '../core/project/types';
import { atomicWrite, ensureTrailingNewline, listDirSafe, mkdirp } from '../infra/fsutil';
import {
  assertTty,
  createClackPrompt,
  isCancelledError,
  type PromptApi,
  type PromptOption,
} from '../infra/prompt';
import type { HabitsInput, ProfileInput } from '../schema';
import { HabitsSchema, ProfileSchema } from '../schema';
import { VERSION } from '../version';
import { type CommandContext, defaultCommandContext, printJson } from './context';
import { resolveJsonFlag } from './flags';
import { printSyncResult } from './sync';

/** Spec §3.1 / §3.2：init 创建的 SoT 子目录（store/cache 由 source 管理按需创建）。 */
export const SOT_SUBDIRS = ['custom', 'learnings', 'templates', SKILLS_DIRNAME, 'mcp'] as const;

/** 命令上下文（host/os/cwd 注入；测试用真实临时目录 + realHost 或 env 覆盖 host）。 */
export type InitContext = CommandContext;

export interface InitOptions {
  /** --scope；缺省回落 AGF_SCOPE，再缺省 project（Spec §7.1-1）。 */
  readonly scope?: Scope;
}

export interface InitResult {
  readonly scope: Scope;
  readonly sotRoot: string;
  readonly createdFiles: readonly string[];
  readonly createdDirs: readonly string[];
  readonly detection: DetectedSnapshot;
}

/** 待落盘文件（materializeSoT 的输入；调用方负责 YAML 序列化）。 */
interface SoTFile {
  readonly path: string;
  readonly content: string;
}

/**
 * SoT 物化（runInit 与交互流程共用）：mkdirp 根与子目录 → 逐一原子写。
 *
 * @throws PermissionError(4) SoT 目录无写权限。
 */
async function materializeSoT(
  ctx: InitContext,
  sotRoot: string,
  files: readonly SoTFile[],
): Promise<{ createdFiles: string[]; createdDirs: string[] }> {
  await mkdirp(ctx.host, sotRoot);
  const createdDirs: string[] = [];
  for (const dir of SOT_SUBDIRS) {
    const abs = path.join(sotRoot, dir);
    await mkdirp(ctx.host, abs);
    createdDirs.push(abs);
  }

  const createdFiles: string[] = [];
  for (const file of files) {
    await atomicWrite(ctx.host, file.path, file.content);
    createdFiles.push(file.path);
  }
  return { createdFiles, createdDirs };
}

/**
 * 解析 scope 对应的 SoT 根；**已存在且非空** → ConfigError(2)（Spec §6.1
 * 「init 目录非空」）。
 *
 * 为什么判据是「非空」而不是「已存在 profile.yaml」：§6.1 明确把「init 目录非空」
 * 列为退出码 2 的触发场景，而"不覆盖用户已有内容"也是更安全的默认——SoT 根里已
 * 手工放了 custom/、habits.yaml 但缺 profile.yaml 时，旧判据会直接写入并把这些
 * 内容纳入一个用户没打算创建的 SoT。init -i 的交互流程不受影响：本函数在任何
 * 写入之前只调用一次（edit 分支落盘 habits.yaml 骨架发生在此之后）。
 */
async function resolveFreshSoTRoot(
  ctx: InitContext,
  env: EnvSnapshot,
  scope: Scope,
): Promise<string> {
  const userSoTRoot = resolveUserSoT(env, ctx.os);
  const projectSoTRoot = resolveProjectSoT(ctx.cwd, ctx.os);
  const sotRoot = scope === 'project' ? projectSoTRoot : userSoTRoot;

  // 目录不存在 / 不可读 → []（等同"空目录"，init 可继续）
  const entries = await listDirSafe(ctx.host, sotRoot);
  if (entries.length > 0) {
    const hasProfile = await ctx.host.exists(path.join(sotRoot, PROFILE_FILE));
    throw new ConfigError(hasProfile ? `SoT 已初始化: ${sotRoot}` : `SoT 目录非空: ${sotRoot}`, {
      hint: hasProfile
        ? '已初始化，如需重置请先删除该目录（或其中的 profile.yaml）'
        : `该目录已有内容（${entries.slice(0, 5).join(', ')}...），init 不覆盖已有内容——请清空该目录或换一个 scope`,
      details: { sotRoot, entries },
    });
  }
  return sotRoot;
}

/** 投影基准根（Spec §8.1 rootDir）：project → 项目根；user → 用户目录。 */
function projectionRootDir(ctx: InitContext, env: EnvSnapshot, scope: Scope): string {
  if (scope === 'project') {
    return ctx.cwd;
  }
  const home = env.userProfile;
  if (home === undefined || home === '') {
    // resolveUserSoT 已保证 userProfile 存在（否则此前已抛 ConfigError），此为防御分支
    throw new ConfigError('user scope 投影需要用户目录（USERPROFILE 与 HOME 均未设置）', {
      hint: '设置 USERPROFILE（Windows）或 HOME（类 Unix）后重试',
    });
  }
  return home;
}

/**
 * init 核心逻辑（可注入、不打印——CLI 输出与测试共用同一入口）。
 *
 * @throws ConfigError(2) SoT 目录非空（含已初始化）/ 用户目录无法解析。
 * @throws PermissionError(4) SoT 目录无写权限。
 */
export async function runInit(ctx: InitContext, options: InitOptions = {}): Promise<InitResult> {
  const env = readEnv(ctx.host);
  const scope: Scope = options.scope ?? env.agfScope ?? 'project';
  const sotRoot = await resolveFreshSoTRoot(ctx, env, scope);

  // 探测（Spec §7.1-2）：快照进 detected；交互确认到声明字段是 -i 模式的职责
  const detection = await runDetection({
    host: ctx.host,
    os: ctx.os.platform,
    cwd: ctx.cwd,
    env,
  });

  // habits.yaml：声明字段空骨架 + detected 快照（Spec §7.1-2）
  // profile.yaml：Windows 安装默认值，scope 按本次 init 调整（Spec §4.2 / §7.1-3）
  const habitsYaml = stringifyYaml({ ...defaultHabits(), detected: detection }, { lineWidth: 0 });
  const profileYaml = stringifyYaml({ ...windowsDefaultProfile(), scope }, { lineWidth: 0 });

  const { createdFiles, createdDirs } = await materializeSoT(ctx, sotRoot, [
    { path: path.join(sotRoot, HABITS_FILE), content: ensureTrailingNewline(habitsYaml) },
    { path: path.join(sotRoot, PROFILE_FILE), content: ensureTrailingNewline(profileYaml) },
  ]);

  return {
    scope,
    sotRoot,
    createdFiles,
    createdDirs,
    detection,
  };
}

// ---------------------------------------------------------------------------
// 交互流程（Spec §7.1.1，M9）
// ---------------------------------------------------------------------------

/** 交互 init 上下文：注入 prompt（脚本化 fake）与版本号。 */
export interface InteractiveInitContext extends InitContext {
  readonly prompt: PromptApi;
  /** 写入 sync-meta 用的 CLI 版本（交互第⑤步「立即 sync」）。 */
  readonly agentforgeVersion: string;
}

/** 交互 init 结果（cancelled=true 表示用户在写入确认处选 n，未写任何文件）。 */
export interface InitInteractiveResult {
  readonly scope: Scope;
  readonly sotRoot: string;
  /** ④ 选择的 target id 列表（按固定顺序 opencode → codex → claude → pi）。 */
  readonly targets: readonly string[];
  readonly createdFiles: readonly string[];
  readonly createdDirs: readonly string[];
  readonly detection: DetectedSnapshot;
  readonly cancelled: boolean;
  /** 第⑤步末尾是否执行了 sync（cancelled 恒为 false）。 */
  readonly synced: boolean;
}

/** 探测确认的三种动作（Spec §7.1.1-3）。 */
export type DetectConfirmAction = 'confirm' | 'redetect' | 'edit';

// ---- 取消时的产物清单（Ctrl-C 后让用户看得见磁盘上留下了什么）----

/**
 * 交互 init 被取消时已落盘的产物清单。
 *
 * 为什么需要：`init -i` 的 edit 分支会**先**写 habits.yaml 骨架与全部子目录
 * （见 runInitInteractive 的 ③ edit 分支），此后任一提问处 Ctrl-C 都会留下半
 * 初始化的 SoT。prompt.unwrap 抛出的 CancelledError 只带退出码 130，命令层
 * 无从得知产物，故由 runInitInteractive 把清单挂到错误上回传。
 */
export interface CancelledInitArtifacts {
  readonly createdFiles: readonly string[];
  readonly createdDirs: readonly string[];
}

/** CancelledError 上承载清单的属性名（普通属性：跨 bundle 边界安全，同 isCancelledError 的取舍）。 */
const CANCELLED_ARTIFACTS_PROP = 'agfInitArtifacts';

/** 累加中的产物清单（仅 runInitInteractive 内部可变；对外暴露为只读形态）。 */
interface MutableInitArtifacts {
  readonly createdFiles: string[];
  readonly createdDirs: string[];
}

/** 记录一次 materializeSoT 成功落盘的产物（去重：edit 分支的子目录会被再次 mkdirp）。 */
function recordCreated(
  acc: MutableInitArtifacts,
  created: { readonly createdFiles: readonly string[]; readonly createdDirs: readonly string[] },
): void {
  for (const file of created.createdFiles) {
    if (!acc.createdFiles.includes(file)) {
      acc.createdFiles.push(file);
    }
  }
  for (const dir of created.createdDirs) {
    if (!acc.createdDirs.includes(dir)) {
      acc.createdDirs.push(dir);
    }
  }
}

/** 把清单挂到取消错误上（原错误原样重抛，退出码 130 语义不变）。 */
function attachInitArtifacts(err: unknown, artifacts: CancelledInitArtifacts): unknown {
  if (typeof err === 'object' && err !== null) {
    (err as Record<string, unknown>)[CANCELLED_ARTIFACTS_PROP] = artifacts;
  }
  return err;
}

/** 从取消错误上取回清单（无清单 / 结构不符 → undefined）。@see attachInitArtifacts */
export function extractInitArtifacts(err: unknown): CancelledInitArtifacts | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const raw = (err as Record<string, unknown>)[CANCELLED_ARTIFACTS_PROP];
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const { createdFiles, createdDirs } = raw as Partial<CancelledInitArtifacts>;
  if (!Array.isArray(createdFiles) || !Array.isArray(createdDirs)) {
    return undefined;
  }
  return { createdFiles, createdDirs };
}

/**
 * 取消提示文案（命令层打印；清单为空 → 明确告知 nothing was written）。
 *
 * 产物路径与提示分行输出，便于用户直接复制路径删除。
 */
export function formatCancelledInitArtifacts(
  artifacts: CancelledInitArtifacts | undefined,
): string[] {
  const files = artifacts?.createdFiles ?? [];
  const dirs = artifacts?.createdDirs ?? [];
  if (files.length === 0 && dirs.length === 0) {
    return ['aforge init - cancelled: nothing was written'];
  }
  return [
    'aforge init - cancelled; the following artifacts remain on disk:',
    ...files.map((file) => `created file: ${file}`),
    ...dirs.map((dir) => `created dir: ${dir}`),
    '',
    '删除以上内容可回到未初始化状态，或重新运行 aforge init -i 继续',
  ];
}

/** 四 target 的主规则绝对路径（multiselect hint 与结果打印共用）。 */
export function targetMainRulePaths(
  ctx: InitContext,
  env: EnvSnapshot,
  scope: Scope,
): Readonly<Record<(typeof ALL_TARGET_IDS)[number], string>> {
  const profile = ProfileSchema.parse(windowsDefaultProfile());
  const habits = HabitsSchema.parse(defaultHabits());
  const planCtx: ProjectContext = {
    os: ctx.os,
    scope,
    rootDir: projectionRootDir(ctx, env, scope),
    renderedRulesMd: '',
    habits,
    profile,
    skillsToMaterialize: [],
    mcpServers: [],
    dryRun: true,
    lineEnding: profile.projection.line_ending,
    markerBegin: profile.projection.marker_begin,
    markerEnd: profile.projection.marker_end,
    markerMode: profile.projection.marker_mode,
    // env 必须注入：codexMainRulePath 走 ctx.env?.codexHome 分支，缺了 env 会忽略
    // CODEX_HOME，导致第④步 hint 与 sync 实际写入路径不一致（engine / status /
    // doctor 三处 plan ctx 均已注入，此处对齐）
    env,
  };
  return {
    opencode: opencodeMainRulePath(planCtx),
    codex: codexMainRulePath(planCtx),
    claude: claudeMainRulePath(planCtx),
    pi: piMainRulePath(planCtx),
  };
}

/**
 * 交互 init（对外入口）：在核心流程外裹一层取消捕获。
 *
 * 用户在任一提问处 Ctrl-C（prompt 层抛 CancelledError）时，把此前已落盘的
 * 文件/目录清单挂到错误上再原样重抛——命令层据此打印清单（见
 * formatCancelledInitArtifacts），退出码仍由 main.ts 统一出口给出 130。
 */
export async function runInitInteractive(
  ctx: InteractiveInitContext,
  options: InitOptions = {},
): Promise<InitInteractiveResult> {
  // 函数级累加器：materializeSoT 每次成功落盘后累加（见 recordCreated 调用点）
  const created: MutableInitArtifacts = { createdFiles: [], createdDirs: [] };
  try {
    return await runInitInteractiveFlow(ctx, options, created);
  } catch (err) {
    if (isCancelledError(err)) {
      throw attachInitArtifacts(err, {
        createdFiles: [...created.createdFiles],
        createdDirs: [...created.createdDirs],
      });
    }
    throw err;
  }
}

/** 交互 init 核心逻辑（五步；探测/写入与 runInit 共用底层，可注入 prompt 测试）。 */
async function runInitInteractiveFlow(
  ctx: InteractiveInitContext,
  options: InitOptions,
  created: MutableInitArtifacts,
): Promise<InitInteractiveResult> {
  const env = readEnv(ctx.host);

  // ---- ① Scope 选择（--scope / AGF_SCOPE 显式给出时跳过询问，减少确认次数）----
  let scope: Scope;
  if (options.scope !== undefined || env.agfScope !== undefined) {
    scope = options.scope ?? env.agfScope ?? 'project';
  } else {
    const projectSoTRoot = resolveProjectSoT(ctx.cwd, ctx.os);
    const userSoTRoot = resolveUserSoT(env, ctx.os);
    scope = await ctx.prompt.select<Scope>(
      'SoT 存放位置（scope）',
      [
        {
          value: 'project',
          label: 'project（随项目提交，团队共享）',
          hint: projectSoTRoot,
        },
        {
          value: 'user',
          label: 'user（个人全局，跨项目复用）',
          hint: userSoTRoot,
        },
      ],
      'project',
    );
  }

  const sotRoot = await resolveFreshSoTRoot(ctx, env, scope);

  // ---- ②③ 探测 → 确认（n → 重新探测循环；edit → 落盘骨架 + 等待手动编辑）----
  const detect = (): Promise<DetectedSnapshot> =>
    runDetection({ host: ctx.host, os: ctx.os.platform, cwd: ctx.cwd, env });

  let detection = await detect();
  let action = await askDetectConfirm(ctx.prompt);
  while (action === 'redetect') {
    detection = await detect();
    action = await askDetectConfirm(ctx.prompt);
  }

  let habitsInput: HabitsInput = {
    ...defaultHabits(),
    detected: detection as unknown as NonNullable<HabitsInput['detected']>,
  };
  let habitsWritten = false;

  if (action === 'edit') {
    // 先落盘 habits.yaml 骨架（含 detected 快照），提示手动编辑，confirm 等待
    const habitsYaml = stringifyYaml(habitsInput, { lineWidth: 0 });
    recordCreated(
      created,
      await materializeSoT(ctx, sotRoot, [
        { path: path.join(sotRoot, HABITS_FILE), content: ensureTrailingNewline(habitsYaml) },
      ]),
    );
    habitsWritten = true;

    ctx.prompt.note(
      [
        `habits.yaml 骨架已写入（探测快照见 detected 字段）：`,
        path.join(sotRoot, HABITS_FILE),
        '',
        '请在编辑器中确认声明字段（runtime.node.manager / runtime.python.manager /',
        'runtime.package_managers / tools.shell 等），保存后回到此窗口继续。',
      ].join('\n'),
      '手动编辑 habits.yaml',
    );
    await ctx.prompt.confirm('已在编辑器中保存 habits.yaml，继续？');
    habitsInput = (await loadHabits(ctx.host, sotRoot)) ?? habitsInput;
  }

  // ---- ④ 目标 Agent multiselect（默认全选；hint 显示各 target 主规则绝对路径）----
  const mainRulePaths = targetMainRulePaths(ctx, env, scope);
  const targetOptions: readonly PromptOption<string>[] = ALL_TARGET_IDS.map((targetId) => ({
    value: targetId,
    label: targetId,
    hint: mainRulePaths[targetId],
  }));
  const targets = await ctx.prompt.multiselect<string>(
    '目标 Agent（空格切换，回车确认）',
    targetOptions,
    [...ALL_TARGET_IDS],
    true,
  );
  // multiselect 选项即由 ALL_TARGET_IDS 构造，结果必为其子集；过滤收窄类型供 profile 使用
  const selectedTargets = targets.filter((t): t is (typeof ALL_TARGET_IDS)[number] =>
    (ALL_TARGET_IDS as readonly string[]).includes(t),
  );

  // ---- ⑤ 写入确认（显示将创建的文件列表；n → cancelled，不写任何文件）----
  const habitsFile = path.join(sotRoot, HABITS_FILE);
  const profileFile = path.join(sotRoot, PROFILE_FILE);
  const _plannedFiles = habitsWritten ? [profileFile] : [habitsFile, profileFile];

  ctx.prompt.note(
    [
      ...(habitsWritten ? [`  ${habitsFile}（已写入，编辑内容保留）`] : [`  ${habitsFile}`]),
      `  ${profileFile}`,
      '',
      '将创建的目录：',
      ...SOT_SUBDIRS.map((dir) => `  ${path.join(sotRoot, dir)}`),
    ].join('\n'),
    '将创建的文件',
  );

  const confirmed = await ctx.prompt.confirm('写入以上文件？');
  if (!confirmed) {
    // 取消时返回实际已创建的文件/目录列表（③ edit 分支已写入 habits.yaml + 子目录）
    return {
      scope,
      sotRoot,
      targets: selectedTargets,
      createdFiles: habitsWritten ? [habitsFile] : [],
      createdDirs: habitsWritten ? SOT_SUBDIRS.map((dir) => path.join(sotRoot, dir)) : [],
      detection,
      cancelled: true,
      synced: false,
    };
  }

  // profile：Windows 安装默认值 + 本次 scope 与 targets（交互结果持久化）
  const profileInput: ProfileInput = {
    ...windowsDefaultProfile(),
    scope,
    targets: selectedTargets,
  };
  const profileYaml = stringifyYaml(profileInput, { lineWidth: 0 });

  const files: SoTFile[] = [];
  if (!habitsWritten) {
    files.push({
      path: habitsFile,
      content: ensureTrailingNewline(stringifyYaml(habitsInput, { lineWidth: 0 })),
    });
  }
  files.push({ path: profileFile, content: ensureTrailingNewline(profileYaml) });

  const { createdFiles, createdDirs } = await materializeSoT(ctx, sotRoot, files);
  recordCreated(created, { createdFiles, createdDirs });

  // ---- ⑤末：可选立即 sync（Spec §7.1-4）----
  const doSync = await ctx.prompt.confirm('立即执行 aforge sync 投影到目标 Agent？');
  let synced = false;
  if (doSync) {
    const syncResult = await syncOnce({
      host: ctx.host,
      env,
      os: ctx.os,
      cwd: ctx.cwd,
      agentforgeVersion: ctx.agentforgeVersion,
      dryRun: false,
    });
    printSyncResult(syncResult);
    synced = true;
  }

  return {
    scope,
    sotRoot,
    targets,
    createdFiles,
    createdDirs,
    detection,
    cancelled: false,
    synced,
  };
}

/** ③ 探测结果确认询问（Y / n / edit，Spec §7.1.1-3）。 */
async function askDetectConfirm(prompt: PromptApi): Promise<DetectConfirmAction> {
  return prompt.select<DetectConfirmAction>(
    '确认探测结果（快照将写入 habits.yaml 的 detected 字段）',
    [
      { value: 'confirm', label: 'Y - 确认，使用以上探测结果' },
      { value: 'redetect', label: 'n - 重新探测' },
      {
        value: 'edit',
        label: 'edit - 写入 habits.yaml 后手动编辑（声明字段覆盖探测）',
      },
    ],
    'confirm',
  );
}

// ---------------------------------------------------------------------------
// CLI 装配（打印逻辑只在 action 层）
// ---------------------------------------------------------------------------

/** 探测摘要行（ASCII，两列对齐）。 */
function detectionSummary(d: DetectedSnapshot): string[] {
  const pms = d.package_managers.map((p) => p.name).join(', ');
  const rules = d.existing_rules.length === 0 ? '(none)' : d.existing_rules.join(', ');
  return [
    `  node manager     : ${d.node.manager}`,
    `  python manager   : ${d.python.manager}`,
    `  package managers : ${pms === '' ? '(none)' : pms}`,
    `  shell            : ${d.shell}`,
    `  existing rules   : ${rules}`,
  ];
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('initialize the SoT directory (habits/profile skeletons + detect snapshot)')
    .option('--scope <scope>', 'SoT scope: project or user (default: project)')
    .option('-i, --interactive', 'interactive five-step init (requires a TTY)')
    .option('--json', 'print machine-readable JSON (absolute paths)')
    .action(
      async (
        options: { scope?: string; interactive?: boolean; json?: boolean },
        command: Command,
      ) => {
        const json = resolveJsonFlag(command, options.json);
        let scope: Scope | undefined;
        if (options.scope !== undefined) {
          if (options.scope !== 'project' && options.scope !== 'user') {
            throw new ConfigError(`非法 scope: ${options.scope}`, {
              hint: '有效值: project, user',
            });
          }
          scope = options.scope;
        }

        const baseCtx = defaultCommandContext();

        if (options.interactive === true) {
          // 交互模式：TTY 前置断言（CI / 管道 → ConfigError(2)）→ clack 动态加载
          assertTty();
          const prompt = await createClackPrompt();
          let result: InitInteractiveResult;
          try {
            result = await runInitInteractive(
              { ...baseCtx, prompt, agentforgeVersion: VERSION },
              { scope },
            );
          } catch (err) {
            // Ctrl-C / Esc：打印已落盘产物清单后重抛（退出码 130 由 main.ts 给出）
            if (isCancelledError(err)) {
              const artifacts = extractInitArtifacts(err);
              if (json) {
                printJson({
                  cancelled: true,
                  interrupted: true,
                  createdFiles: artifacts?.createdFiles ?? [],
                  createdDirs: artifacts?.createdDirs ?? [],
                });
              } else {
                console.error(formatCancelledInitArtifacts(artifacts).join('\n'));
              }
            }
            throw err;
          }

          if (result.cancelled) {
            if (json) {
              printJson({ cancelled: true });
            } else {
              console.log('aforge init - cancelled at write confirmation, nothing written');
            }
            return;
          }

          if (json) {
            printJson({
              scope: result.scope,
              sotRoot: result.sotRoot,
              targets: result.targets,
              createdFiles: result.createdFiles,
              createdDirs: result.createdDirs,
              detection: result.detection,
              cancelled: false,
              synced: result.synced,
            });
            return;
          }

          const lines: string[] = [
            `aforge init - scope: ${result.scope}`,
            `SoT root: ${result.sotRoot}`,
            `targets: ${result.targets.join(', ')}`,
            '',
            'created files:',
            ...result.createdFiles.map((f) => `  ${f}`),
            '',
            'created dirs:',
            ...result.createdDirs.map((d) => `  ${d}`),
            '',
            'detected (snapshot saved to habits.yaml):',
            ...detectionSummary(result.detection),
            '',
            result.synced
              ? 'init complete (sync already executed above)'
              : 'next: run `aforge sync` to project rules to agent targets',
          ];
          console.log(lines.join('\n'));
          return;
        }

        const result = await runInit(baseCtx, { scope });

        if (json) {
          printJson({
            scope: result.scope,
            sotRoot: result.sotRoot,
            createdFiles: result.createdFiles,
            createdDirs: result.createdDirs,
            detection: result.detection,
          });
          return;
        }

        const lines: string[] = [
          `aforge init - scope: ${result.scope}`,
          `SoT root: ${result.sotRoot}`,
          '',
          'created files:',
          ...result.createdFiles.map((f) => `  ${f}`),
          '',
          'created dirs:',
          ...result.createdDirs.map((d) => `  ${d}`),
          '',
          'detected (snapshot saved to habits.yaml):',
          ...detectionSummary(result.detection),
          '',
          'next: run `aforge sync` to project rules to agent targets',
        ];
        console.log(lines.join('\n'));
      },
    );
}
