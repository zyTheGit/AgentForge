/**
 * aforge init 命令（Spec §7.1 非交互路径；§7.1.1 -i 交互五步，M9）。
 *
 * 非交互：确定 scope 与 SoT 根 → 探测（快照进 habits.detected）→ 写 habits.yaml
 * （声明字段空骨架 + detected 快照）与 profile.yaml（windowsDefaultProfile 按
 * scope 调整）→ 创建目录结构（custom/learnings/templates/skills/mcp）→
 * 打印创建的绝对路径列表。
 *
 * 交互（-i，Spec §7.1.1 五步 ≤5 次确认）：
 * ① Scope 选择（select，默认 project；--scope / AGF_SCOPE 已给则跳过询问）
 * ② Detector 运行并打印探测结果
 * ③ 确认探测结果（Y 确认 / n 重新探测 / edit 手动编辑——先落盘 habits.yaml
 *    骨架，confirm 等待编辑完成后重新读取）
 * ④ 目标 Agent multiselect（默认全选，hint 显示各 target 主规则绝对路径）
 * ⑤ 写入确认（将创建的文件列表；选 n → cancelled 不写盘）→ 可选立即 sync
 *
 * 交互结果持久化：habits.yaml（探测确认后的 detected 快照 / edit 后的用户
 * 编辑内容）与 profile.yaml（④ 选择的 targets）。
 *
 * 已初始化（SoT 根存在 profile.yaml）→ ConfigError(2)，不覆盖既有配置。
 * 正常输出纯 ASCII（Windows GBK 控制台兼容，见 cli.ts 约定）；交互 UI 文案
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
import { currentOs, resolveProjectSoT, resolveUserSoT, type OsContext } from '../core/paths';
import { ALL_TARGET_IDS, syncOnce } from '../core/project/engine';
import { claudeMainRulePath } from '../core/project/projectors/claude';
import { codexMainRulePath } from '../core/project/projectors/codex';
import { opencodeMainRulePath } from '../core/project/projectors/opencode';
import { piMainRulePath } from '../core/project/projectors/pi';
import type { ProjectContext } from '../core/project/types';
import type { HabitsInput, ProfileInput } from '../schema';
import { HabitsSchema, ProfileSchema } from '../schema';
import type { Host } from '../infra/host';
import { atomicWrite, mkdirp } from '../infra/fsutil';
import { assertTty, createClackPrompt, type PromptApi, type PromptOption } from '../infra/prompt';
import { realHost } from '../infra/real-host';
import { VERSION } from '../version';
import { printSyncResult } from './sync';

/** Spec §3.1 / §3.2：init 创建的 SoT 子目录（store/cache 由 source 管理按需创建）。 */
export const SOT_SUBDIRS = ['custom', 'learnings', 'templates', 'skills', 'mcp'] as const;

/** 命令上下文（host/os/cwd 注入；测试用真实临时目录 + realHost 或 env 覆盖 host）。 */
export interface InitContext {
  readonly host: Host;
  /** 项目根（project scope 的 SoT 位置与探测基准）。 */
  readonly cwd: string;
  readonly os: OsContext;
}

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

/** YAML 落盘统一以换行结尾（与既有 init 产物一致）。 */
function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
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

/** 解析 scope 对应的 SoT 根；已初始化 → ConfigError(2)（防误覆盖既有 SoT）。 */
async function resolveFreshSoTRoot(
  ctx: InitContext,
  env: EnvSnapshot,
  scope: Scope,
): Promise<string> {
  const userSoTRoot = resolveUserSoT(env, ctx.os);
  const projectSoTRoot = resolveProjectSoT(ctx.cwd, ctx.os);
  const sotRoot = scope === 'project' ? projectSoTRoot : userSoTRoot;

  if (await ctx.host.exists(path.join(sotRoot, PROFILE_FILE))) {
    throw new ConfigError(`SoT 已初始化: ${sotRoot}`, {
      hint: '已初始化，如需重置请先删除该目录（或其中的 profile.yaml）',
      details: { sotRoot },
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
 * @throws ConfigError(2) SoT 已初始化 / 用户目录无法解析。
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
  };
  return {
    opencode: opencodeMainRulePath(planCtx),
    codex: codexMainRulePath(planCtx),
    claude: claudeMainRulePath(planCtx),
    pi: piMainRulePath(planCtx),
  };
}

/** 交互 init 核心逻辑（五步；探测/写入与 runInit 共用底层，可注入 prompt 测试）。 */
export async function runInitInteractive(
  ctx: InteractiveInitContext,
  options: InitOptions = {},
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
    await materializeSoT(ctx, sotRoot, [
      { path: path.join(sotRoot, HABITS_FILE), content: ensureTrailingNewline(habitsYaml) },
    ]);
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
  const plannedFiles = habitsWritten ? [profileFile] : [habitsFile, profileFile];

  ctx.prompt.note(
    [
      ...(habitsWritten
        ? [`  ${habitsFile}（已写入，编辑内容保留）`]
        : [`  ${habitsFile}`]),
      `  ${profileFile}`,
      '',
      '将创建的目录：',
      ...SOT_SUBDIRS.map((dir) => `  ${path.join(sotRoot, dir)}`),
    ].join('\n'),
    '将创建的文件',
  );

  const confirmed = await ctx.prompt.confirm('写入以上文件？');
  if (!confirmed) {
    return {
      scope,
      sotRoot,
      targets: selectedTargets,
      createdFiles: [],
      createdDirs: [],
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
  return [
    `  node manager     : ${d.node.manager}`,
    `  python manager   : ${d.python.manager}`,
    `  package managers : ${pms === '' ? '(none)' : pms}`,
    `  shell            : ${d.shell}`,
    `  existing rules   : ${d.existing_rules.length === 0 ? '(none)' : d.existing_rules.join(', ')}`,
  ];
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('initialize the SoT directory (habits/profile skeletons + detect snapshot)')
    .option('--scope <scope>', 'SoT scope: project or user (default: project)')
    .option('-i, --interactive', 'interactive five-step init (requires a TTY)')
    .option('--json', 'print machine-readable JSON (absolute paths)')
    .action(async (options: { scope?: string; interactive?: boolean; json?: boolean }) => {
      let scope: Scope | undefined;
      if (options.scope !== undefined) {
        if (options.scope !== 'project' && options.scope !== 'user') {
          throw new ConfigError(`非法 scope: ${options.scope}`, {
            hint: '有效值: project, user',
          });
        }
        scope = options.scope;
      }

      const baseCtx = { host: realHost, cwd: process.cwd(), os: currentOs() };

      if (options.interactive === true) {
        // 交互模式：TTY 前置断言（CI / 管道 → ConfigError(2)）→ clack 动态加载
        assertTty();
        const prompt = await createClackPrompt();
        const result = await runInitInteractive(
          { ...baseCtx, prompt, agentforgeVersion: VERSION },
          { scope },
        );

        if (result.cancelled) {
          if (options.json === true) {
            console.log(JSON.stringify({ cancelled: true }, null, 2));
          } else {
            console.log('aforge init - cancelled at write confirmation, nothing written');
          }
          return;
        }

        if (options.json === true) {
          console.log(JSON.stringify({
            scope: result.scope,
            sotRoot: result.sotRoot,
            targets: result.targets,
            createdFiles: result.createdFiles,
            createdDirs: result.createdDirs,
            detection: result.detection,
            cancelled: false,
            synced: result.synced,
          }, null, 2));
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

      if (options.json === true) {
        console.log(JSON.stringify({
          scope: result.scope,
          sotRoot: result.sotRoot,
          createdFiles: result.createdFiles,
          createdDirs: result.createdDirs,
          detection: result.detection,
        }, null, 2));
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
    });
}
