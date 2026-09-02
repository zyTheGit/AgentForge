/**
 * init -i 的交互五步编排（Spec §7.1.1，M9）：
 * ① Scope 选择 ② Detector 运行 ③ 探测结果确认（Y / n / edit）
 * ④ 目标 Agent multiselect ⑤ 写入确认 → 可选立即 sync。
 *
 * 为什么单独成模块：交互路径的复杂度全在「提问顺序 × 每一步的落盘时机」上——③ 的
 * edit 分支会**先**把 habits.yaml 骨架与子目录落盘，于是此后任一提问处 Ctrl-C 都
 * 会留下半初始化的 SoT，第⑤步的取消分支也要据此区分「已写入」与「将写入」。这套
 * 状态机与非交互 runInit 的线性写盘是两种完全不同的读法，混在一个文件里读者要在
 * 两种心智模型间反复切换。分开后本模块只单向依赖 init-scaffold 的物化原语与
 * init-artifacts 的清单累加。
 *
 * 分层不变：本模块只做流程编排与落盘，不做输出格式化；唯一的例外是第⑤步末尾
 * 「立即 sync」沿用命令层的 printSyncResult 打印 sync 结果——该行为在拆分前即
 * 如此，此处原样保留，不在本次结构重构中调整。
 */
import path from 'node:path';
import { defaultHabits, windowsDefaultProfile } from '../../core/config/defaults';
import { HABITS_FILE, loadHabits, PROFILE_FILE } from '../../core/config/load';
import { serializeYamlDoc } from '../../core/config/serialize';
import type { DetectedSnapshot } from '../../core/detector/engine';
import { runDetection } from '../../core/detector/engine';
import type { EnvSnapshot, Scope } from '../../core/env';
import { readEnv } from '../../core/env';
import { resolveProjectSoT, resolveUserSoT } from '../../core/paths';
import { ALL_TARGET_IDS, syncOnce } from '../../core/project/engine';
import { claudeMainRulePath } from '../../core/project/projectors/claude';
import { codexMainRulePath } from '../../core/project/projectors/codex';
import { opencodeMainRulePath } from '../../core/project/projectors/opencode';
import { piMainRulePath } from '../../core/project/projectors/pi';
import type { ProjectContext } from '../../core/project/types';
import { isCancelledError, type PromptApi, type PromptOption } from '../../infra/prompt';
import type { HabitsInput, ProfileInput } from '../../schema';
import { HabitsSchema, ProfileSchema } from '../../schema';
import {
  attachInitArtifacts,
  type CancelledInitArtifacts,
  type MutableInitArtifacts,
  recordCreated,
} from './init-artifacts';

import {
  habitsSkeleton,
  type InitContext,
  type InitOptions,
  materializeSoT,
  projectionRootDir,
  resolveFreshSoTRoot,
  rollbackMaterialized,
  type SoTFile,
  seedDefaultSourcesForInit,
  sotSubdirPaths,
} from './init-scaffold';
import { printSyncResult } from './sync';

/** 交互 init 上下文：注入 prompt（脚本化 fake）与版本号。 */
export interface InteractiveInitContext extends InitContext {
  readonly prompt: PromptApi;
  /** 写入 sync-meta 用的 CLI 版本（交互第⑤步「立即 sync」）。 */
  readonly agentforgeVersion: string;
}

/** 交互 init 结果（cancelled=true 表示用户在写入确认处选 n，产物已回滚）。 */
export interface InitInteractiveResult {
  readonly scope: Scope;
  readonly sotRoot: string;
  /** ④ 选择并落盘到 profile.yaml 的 target 列表（顺序固定 opencode → codex → claude → pi）。 */
  readonly targets: readonly string[];
  /** cancelled=false 时为本次创建的文件；cancelled=true 时为回滚后**残留**的文件（常态空）。 */
  readonly createdFiles: readonly string[];
  /** 同 createdFiles：取消时语义为回滚后残留的目录。 */
  readonly createdDirs: readonly string[];
  readonly detection: DetectedSnapshot;
  readonly cancelled: boolean;
  /** 第⑤步末尾是否执行了 sync（cancelled 恒为 false）。 */
  readonly synced: boolean;
  /** 播种进 user 层 sources.json 的默认注册源 id（取消时恒为空——未 commit 不播种）。 */
  readonly registeredSources: readonly string[];
  /** 播种失败原因（成功 / 跳过 / 取消 → null）。 */
  readonly sourcesWarning: string | null;
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
    commandsToExpose: [],
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
 * 用户在任一提问处 Ctrl-C（prompt 层抛 CancelledError）时，按「是否已过写入确认」
 * 分两种处置（见 CancelledInitArtifacts.committed）：未确认 → 回滚 ③ edit 分支的
 * 落盘并回报残留；已确认 → 保留有效 SoT 并回报产物。清单挂到错误上原样重抛，命令层
 * 据此打印（见 formatCancelledInitArtifacts），退出码仍由 main.ts 统一出口给出 130。
 */
export async function runInitInteractive(
  ctx: InteractiveInitContext,
  options: InitOptions = {},
): Promise<InitInteractiveResult> {
  // 函数级累加器：materializeSoT 每次成功落盘后累加（见 recordCreated 调用点）
  const created: MutableInitArtifacts = { createdFiles: [], createdDirs: [], committed: false };
  try {
    return await runInitInteractiveFlow(ctx, options, created);
  } catch (err) {
    if (isCancelledError(err)) {
      throw attachInitArtifacts(err, await settleCancelledArtifacts(ctx, created));
    }
    throw err;
  }
}

/**
 * 取消时决定产物去留，返回给命令层打印的清单。
 *
 * - 已过写入确认（committed）：**不回滚**，原样回报——habits.yaml 与 profile.yaml
 *   已原子写成功，SoT 是有效初始化状态，删掉用户刚确认写下的配置比留着糟得多
 *   （这条路径就是在「立即 sync？」处 Ctrl-C）。
 * - 未过写入确认：回滚 ③ edit 分支落的 habits.yaml 与子目录。不回滚则 SoT 根非空，
 *   重跑 `aforge init` 必被 resolveFreshSoTRoot 判为「目录非空」→ ConfigError(2)，
 *   用户只能手删；交互已是默认模式（见 flags.resolveInitMode），这条路径的命中面是
 *   全部终端用户。
 *
 * 回滚复用 init-scaffold 的 rollbackMaterialized（与 materializeSoT 的失败回滚同一套
 * best-effort 语义），随后逐项 exists 复核：删不掉的（文件被编辑器占用、权限不足）
 * 如实回报，好过谎称已清理干净。SoT 根本身不清理——空目录不影响重跑。
 */
async function settleCancelledArtifacts(
  ctx: InitContext,
  created: MutableInitArtifacts,
): Promise<CancelledInitArtifacts> {
  if (created.committed) {
    return {
      createdFiles: [...created.createdFiles],
      createdDirs: [...created.createdDirs],
      committed: true,
    };
  }
  await rollbackMaterialized(ctx, created.createdFiles, created.createdDirs);
  const leftoverFiles: string[] = [];
  const leftoverDirs: string[] = [];
  for (const file of created.createdFiles) {
    if (await ctx.host.exists(file)) {
      leftoverFiles.push(file);
    }
  }
  for (const dir of created.createdDirs) {
    if (await ctx.host.exists(dir)) {
      leftoverDirs.push(dir);
    }
  }
  return { createdFiles: leftoverFiles, createdDirs: leftoverDirs, committed: false };
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

  let habitsInput: HabitsInput = habitsSkeleton(detection);
  let habitsWritten = false;

  if (action === 'edit') {
    // 先落盘 habits.yaml 骨架（含 detected 快照），提示手动编辑，confirm 等待
    recordCreated(
      created,
      await materializeSoT(ctx, sotRoot, [
        { path: path.join(sotRoot, HABITS_FILE), content: serializeYamlDoc(habitsInput) },
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

  ctx.prompt.note(
    [
      ...(habitsWritten ? [`  ${habitsFile}（已写入，编辑内容保留）`] : [`  ${habitsFile}`]),
      `  ${profileFile}`,
      '',
      '将创建的目录：',
      ...sotSubdirPaths(sotRoot).map((dir) => `  ${dir}`),
    ].join('\n'),
    '将创建的文件',
  );

  const confirmed = await ctx.prompt.confirm('写入以上文件？');
  if (!confirmed) {
    // 与 Ctrl-C 路径同一处置（此处恒未 committed）：先回滚 ③ edit 分支已落盘的
    // habits.yaml + 子目录，再返回**残留**清单（常态为空）。不回滚会让 SoT 根非空、
    // 重跑 init 撞 ConfigError(2)；只返回「已创建」清单则会让命令层打出「什么都
    // 没写」的假话。
    const leftover = await settleCancelledArtifacts(ctx, created);
    return {
      scope,
      sotRoot,
      targets: selectedTargets,
      createdFiles: leftover.createdFiles,
      createdDirs: leftover.createdDirs,
      detection,
      cancelled: true,
      synced: false,
      registeredSources: [],
      sourcesWarning: null,
    };
  }

  // profile：Windows 安装默认值 + 本次 scope 与 targets（交互结果持久化）
  const profileInput: ProfileInput = {
    ...windowsDefaultProfile(),
    scope,
    targets: selectedTargets,
  };

  const files: SoTFile[] = [];
  if (!habitsWritten) {
    files.push({ path: habitsFile, content: serializeYamlDoc(habitsInput) });
  }
  files.push({ path: profileFile, content: serializeYamlDoc(profileInput) });

  const { createdFiles, createdDirs } = await materializeSoT(ctx, sotRoot, files);
  recordCreated(created, { createdFiles, createdDirs });
  // 过了这一行 SoT 才算有效初始化：此后的取消（「立即 sync？」处 Ctrl-C）不得回滚
  created.committed = true;

  // 官方模板源播种（零网络、best-effort，与静默 runInit 同一实现）。刻意放在
  // committed 之后：写入确认处选 n 时不该在 user 层留下任何东西
  const seeded = await seedDefaultSourcesForInit(ctx, env);

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
    targets: selectedTargets,
    createdFiles,
    createdDirs,
    detection,
    cancelled: false,
    synced,
    registeredSources: seeded.registeredSources,
    sourcesWarning: seeded.sourcesWarning,
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
