/**
 * init 的 SoT 脚手架层（Spec §7.1 非交互路径）：scope 解析 → SoT 根「必须为空」
 * 校验 → 探测 → 目录与骨架文件物化，以及非交互入口 runInit。
 *
 * 为什么单独成模块：这一层是「可注入、不打印」的纯落盘逻辑，非交互 init 与 `-i`
 * 交互五步共用同一套物化原语（materializeSoT / resolveFreshSoTRoot）。与交互层的
 * 提问编排混在一个文件里时，改一句提问文案要先通读全部写盘细节，反之亦然；分开后
 * 「SoT 长什么样、写在哪、什么情况下拒写」只有这一个出处。
 *
 * 取舍：materializeSoT / resolveFreshSoTRoot / projectionRootDir / SoTFile 原为
 * 文件私有，拆分后交互层复用故补 export——它们仍是实现细节，入口 init.ts 不
 * re-export，对外导出面与拆分前一致。
 */
import path from 'node:path';
import { defaultHabits, windowsDefaultProfile } from '../../core/config/defaults';
import { HABITS_FILE, PROFILE_FILE, SOURCES_FILE } from '../../core/config/load';
import { serializeYamlDoc } from '../../core/config/serialize';
import type { DetectedSnapshot } from '../../core/detector/engine';
import { runDetection } from '../../core/detector/engine';
import type { EnvSnapshot, Scope } from '../../core/env';
import { readEnv } from '../../core/env';
import { ConfigError } from '../../core/errors';
import { resolveProjectSoT, resolveUserSoT, SKILLS_DIRNAME } from '../../core/paths';
import { SYNC_LOCK_DIRNAME, withSotLock } from '../../core/project/sync-lock';
import { seedDefaultSources } from '../../core/sources/official';
import { STORE_DIR } from '../../core/sources/store';
import { atomicWrite, listDirSafe, mkdirp } from '../../infra/fsutil';
import type { HabitsInput } from '../../schema';
import type { CommandContext } from '../_shared/context';

/** Spec §3.1 / §3.2：init 创建的 SoT 子目录（store/cache 由 source 管理按需创建）。 */
export const SOT_SUBDIRS = ['custom', 'learnings', 'templates', SKILLS_DIRNAME, 'mcp'] as const;

/**
 * SoT 子目录的绝对路径清单（物化、交互第⑤步的 note 文案、取消清单共用）。
 *
 * 三处都得到同一份清单才有意义：note 承诺"将创建的目录"、取消分支报告"已创建的
 * 目录"、materializeSoT 才是真正落盘的那一处。各自 `path.join(sotRoot, dir)` 时，
 * 一旦 SOT_SUBDIRS 改成按 scope 取子集，前两处就会与磁盘实况分叉。
 */
export function sotSubdirPaths(sotRoot: string): string[] {
  return SOT_SUBDIRS.map((dir) => path.join(sotRoot, dir));
}

/**
 * habits.yaml 的初始骨架：声明字段空缺省 + 探测快照（Spec §7.1-2）。
 *
 * 非交互 runInit 与 `init -i` 的 ③ edit 分支共用——两侧原先各构造一次，且只有交互
 * 侧带类型断言，同一份数据被赋予了两种类型说法。断言收敛到这里一处：
 * `HabitsSchema.detected` 是 `z.looseObject({})`（§4.1 passthrough，键结构由探测器
 * 自定），其 z.input 是索引签名对象，而 DetectedSnapshot 是具名 interface——TS 不为
 * interface 推导隐式索引签名，故必须显式断言。schema 侧的运行时校验不动（passthrough
 * 本就接受该结构）。
 */
export function habitsSkeleton(detection: DetectedSnapshot): HabitsInput {
  return {
    ...defaultHabits(),
    detected: detection as unknown as NonNullable<HabitsInput['detected']>,
  };
}

/** 命令上下文（host/os/cwd 注入；测试用真实临时目录 + realHost 或 env 覆盖 host）。 */
export type InitContext = CommandContext;

export interface InitOptions {
  /** --scope；缺省回落 AGF_SCOPE，再缺省 project（Spec §7.1-1）。 */
  readonly scope?: Scope;
}

export interface InitResult {
  readonly scope: Scope;
  readonly sotRoot: string;
  /**
   * 落盘到 profile.yaml 的 target 列表（静默路径恒为默认全选四个）。
   *
   * 回报而非让调用方复算 windowsDefaultProfile().targets：静默 init 会把规则投影
   * 到这四个 Agent，用户没被问过也就得在输出里看见，否则「装到哪了」只能去翻
   * profile.yaml。
   */
  readonly targets: readonly string[];
  readonly createdFiles: readonly string[];
  readonly createdDirs: readonly string[];
  readonly detection: DetectedSnapshot;
  /**
   * 本次播种进 user 层 sources.json 的默认注册源 id（§12 Phase 2 官方模板源）。
   *
   * 空数组的两种含义：该登记表已存在（此前 init 过 / 用户管过源），或播种失败
   * （原因在 `sourcesWarning`）。播种语义与"为什么写 user 层"见
   * core/sources/official.seedDefaultSources。
   */
  readonly registeredSources: readonly string[];
  /** 播种失败的原因（成功或跳过 → null）；init 本身不因此失败。 */
  readonly sourcesWarning: string | null;
}

/** seedDefaultSourcesForInit 结果（并入 InitResult 的两个字段）。 */
export interface InitSeededSources {
  readonly registeredSources: readonly string[];
  readonly sourcesWarning: string | null;
}

/**
 * init 顺带把默认注册源（官方模板源）播种进 **user 层** sources.json。
 *
 * 三条设计约束在这里交汇：
 * - **零网络**：只写一个 JSON，不 clone（条目以 disabled + 无 commit 落盘，内容首次
 *   用到时才拉，见 core/sources/template.listTemplates）。所以离线安装的第一条
 *   `aforge init` 不会因此变慢或失败；
 * - **写 user 层而非本次 init 的层**：`sources.json` 按 §3.1 恒在 user 层，项目层的
 *   登记表没有读取方。`project` scope 的 init 因此会额外创建
 *   `<AGF_HOME>\sources.json`——它出现在 `registeredSources` 的回报里，不是静默副作用；
 * - **best-effort**：user 目录不可解析（无 HOME / UNC AGF_HOME）或不可写时只回报
 *   warning。init 的主职责是建 SoT 骨架，不该被一个可选特性拖挂；用户随后可用
 *   `aforge source enable official` 补上（那条路径会自己建登记表）。
 */
export async function seedDefaultSourcesForInit(
  ctx: InitContext,
  env: EnvSnapshot,
): Promise<InitSeededSources> {
  try {
    const result = await seedDefaultSources({
      host: ctx.host,
      env,
      userSoTRoot: resolveUserSoT(env, ctx.os),
      cwd: ctx.cwd,
      os: ctx.os,
    });
    return { registeredSources: result.registered, sourcesWarning: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      registeredSources: [],
      sourcesWarning: `未能登记官方模板源（可稍后运行 aforge source enable official）: ${reason}`,
    };
  }
}

/** 待落盘文件（materializeSoT 的输入；调用方负责 YAML 序列化）。 */
export interface SoTFile {
  readonly path: string;
  readonly content: string;
}

/**
 * SoT 物化（runInit 与交互流程共用）：mkdirp 根与子目录 → 逐一原子写。
 *
 * **部分写入必回滚**：任一步失败（PermissionError(4) 等）都会逆序删除本次新建的
 * 文件与目录后重抛**原**错误。不回滚时残骸会与 resolveFreshSoTRoot 的「目录非空即拒」
 * 撞死：重跑 init 必得 ConfigError(2)，用户只能手删。逆序删除本身失败时静默忽略——
 * 原错误才是用户要看的原因（清理失败最多留下与修复前等同的残骸）。
 *
 * 只删**本次新建**的目录：已存在的子目录（`init -i` 的 edit 分支会先落一次骨架，
 * 此后再次调用本函数）不属于本次产物，不能顺手删掉。
 *
 * @throws PermissionError(4) SoT 目录无写权限（回滚后原样重抛）。
 */
export async function materializeSoT(
  ctx: InitContext,
  sotRoot: string,
  files: readonly SoTFile[],
): Promise<{ createdFiles: string[]; createdDirs: string[] }> {
  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  // 回滚清单：仅本次真正新建的项（顺序即创建顺序，回滚时逆序消费）
  const newDirs: string[] = [];

  try {
    const rootExisted = await ctx.host.exists(sotRoot);
    await mkdirp(ctx.host, sotRoot);
    if (!rootExisted) {
      newDirs.push(sotRoot);
    }

    for (const abs of sotSubdirPaths(sotRoot)) {
      const existed = await ctx.host.exists(abs);
      await mkdirp(ctx.host, abs);
      createdDirs.push(abs);
      if (!existed) {
        newDirs.push(abs);
      }
    }

    for (const file of files) {
      await atomicWrite(ctx.host, file.path, file.content);
      createdFiles.push(file.path);
    }
  } catch (err) {
    await rollbackMaterialized(ctx, createdFiles, newDirs);
    throw err;
  }

  return { createdFiles, createdDirs };
}

/**
 * 逆序清理落盘的文件与新建目录（best-effort：失败不掩盖原错误）。
 *
 * 两个调用点：materializeSoT 自身的失败回滚，以及交互 init 的取消回滚（见
 * init-interactive 的 rollbackOnCancel）——后者要的正是同一套「逆序删、失败忽略」
 * 语义，故此处 export 而非各写一遍。
 */
export async function rollbackMaterialized(
  ctx: InitContext,
  createdFiles: readonly string[],
  newDirs: readonly string[],
): Promise<void> {
  for (const file of [...createdFiles].reverse()) {
    try {
      await ctx.host.rm(file);
    } catch {
      // best-effort
    }
  }
  for (const dir of [...newDirs].reverse()) {
    try {
      await ctx.host.rm(dir);
    } catch {
      // best-effort
    }
  }
}

/** scope → SoT 根（纯路径计算；runInit 取锁与 resolveFreshSoTRoot 共用同一处判定）。 */
export function sotRootForScope(ctx: InitContext, env: EnvSnapshot, scope: Scope): string {
  return scope === 'project' ? resolveProjectSoT(ctx.cwd, ctx.os) : resolveUserSoT(env, ctx.os);
}

/**
 * SoT 根下**不算用户内容**的直接子项：计入「目录非空」判据会让 init 自己把自己挡死。
 *
 * - `.sync.lock`：事务锁目录。runInit 把「判空 → 写入」整段包在 withSotLock 里
 *   （并发 init 串行化），锁目录就建在这个还没内容的根下，它是运行时产物（§3.2）；
 * - `sources.json` / `store\`：源登记表与 git 源缓存**恒在 user 层**（§3.1）。任意
 *   项目里跑过一次 `aforge init`（project scope）都会顺带播种出 user 层的
 *   `sources.json`（见 seedDefaultSourcesForInit），此后 `aforge init --scope user`
 *   会撞上 ConfigError(2)「SoT 目录非空」——而那条 hint 让用户"清空该目录"，
 *   照做就删掉了自己的源登记表与全部源缓存。它们与 `.sync.lock` 同属登记 / 运行时
 *   产物，不是用户放进去的内容。
 */
const NON_CONTENT_ENTRIES: readonly string[] = [SYNC_LOCK_DIRNAME, SOURCES_FILE, STORE_DIR];

/**
 * 解析 scope 对应的 SoT 根；**已存在且非空** → ConfigError(2)（Spec §6.1
 * 「init 目录非空」）。
 *
 * 为什么判据是「非空」而不是「已存在 profile.yaml」：§6.1 明确把「init 目录非空」
 * 列为退出码 2 的触发场景，而"不覆盖用户已有内容"也是更安全的默认——SoT 根里已
 * 手工放了 custom/、habits.yaml 但缺 profile.yaml 时，旧判据会直接写入并把这些
 * 内容纳入一个用户没打算创建的 SoT。init -i 的交互流程不受影响：本函数在任何
 * 写入之前只调用一次（edit 分支落盘 habits.yaml 骨架发生在此之后）。
 *
 * 例外见 NON_CONTENT_ENTRIES：运行时 / 登记产物不算"用户内容"。
 */
export async function resolveFreshSoTRoot(
  ctx: InitContext,
  env: EnvSnapshot,
  scope: Scope,
): Promise<string> {
  const sotRoot = sotRootForScope(ctx, env, scope);

  // 目录不存在 / 不可读 → []（等同"空目录"，init 可继续）
  const entries = (await listDirSafe(ctx.host, sotRoot)).filter(
    (entry) => !NON_CONTENT_ENTRIES.includes(entry),
  );
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
export function projectionRootDir(ctx: InitContext, env: EnvSnapshot, scope: Scope): string {
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
 * 并发：「判空校验 → 探测 → 物化」整段持 SoT 事务锁（withSotLock，与 sync /
 * editProfile 同一把 `<sotRoot>/.sync.lock`）。无锁时两个并发 `aforge init` 会
 * 同时通过非空校验，后写者静默覆盖前者。锁目录建在尚不存在的根下没问题：
 * acquireSyncLock 先 mkdirp 根再原子建锁目录，而判空判据已把 `.sync.lock` 排除
 * （见 resolveFreshSoTRoot）。第二个 init 会拿到 ConflictError(3) 而不是覆盖。
 *
 * @throws ConfigError(2) SoT 目录非空（含已初始化）/ 用户目录无法解析。
 * @throws ConflictError(3) 同一 SoT 根上另有 aforge 正在写入（并发 init / sync）。
 * @throws PermissionError(4) SoT 目录无写权限。
 */
export async function runInit(ctx: InitContext, options: InitOptions = {}): Promise<InitResult> {
  const env = readEnv(ctx.host);
  const scope: Scope = options.scope ?? env.agfScope ?? 'project';

  return withSotLock(ctx.host, sotRootForScope(ctx, env, scope), ctx.os, async () => {
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
    const profileInput = { ...windowsDefaultProfile(), scope };
    const { createdFiles, createdDirs } = await materializeSoT(ctx, sotRoot, [
      {
        path: path.join(sotRoot, HABITS_FILE),
        content: serializeYamlDoc(habitsSkeleton(detection)),
      },
      {
        path: path.join(sotRoot, PROFILE_FILE),
        content: serializeYamlDoc(profileInput),
      },
    ]);

    // 官方模板源播种：写 user 层 sources.json，零网络、best-effort（见函数注释）。
    // 放在锁内是刻意的——它与 SoT 骨架同属"这次 init 的产物"，不该让并发 init
    // 各写一次；写的又是另一个根，与本锁保护的目录不冲突。
    const seeded = await seedDefaultSourcesForInit(ctx, env);

    return {
      scope,
      sotRoot,
      targets: profileInput.targets,
      createdFiles,
      createdDirs,
      detection,
      registeredSources: seeded.registeredSources,
      sourcesWarning: seeded.sourcesWarning,
    };
  });
}
