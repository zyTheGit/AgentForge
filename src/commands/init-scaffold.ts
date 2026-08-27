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
import { defaultHabits, windowsDefaultProfile } from '../core/config/defaults';
import { HABITS_FILE, PROFILE_FILE } from '../core/config/load';
import { serializeYamlDoc } from '../core/config/serialize';
import type { DetectedSnapshot } from '../core/detector/engine';
import { runDetection } from '../core/detector/engine';
import type { EnvSnapshot, Scope } from '../core/env';
import { readEnv } from '../core/env';
import { ConfigError } from '../core/errors';
import { resolveProjectSoT, resolveUserSoT, SKILLS_DIRNAME } from '../core/paths';
import { SYNC_LOCK_DIRNAME, withSotLock } from '../core/project/sync-lock';
import { atomicWrite, listDirSafe, mkdirp } from '../infra/fsutil';
import type { HabitsInput } from '../schema';
import type { CommandContext } from './context';

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
  readonly createdFiles: readonly string[];
  readonly createdDirs: readonly string[];
  readonly detection: DetectedSnapshot;
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

/** 逆序清理本次落盘的文件与新建目录（best-effort：失败不掩盖原错误）。 */
async function rollbackMaterialized(
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
 * 解析 scope 对应的 SoT 根；**已存在且非空** → ConfigError(2)（Spec §6.1
 * 「init 目录非空」）。
 *
 * 为什么判据是「非空」而不是「已存在 profile.yaml」：§6.1 明确把「init 目录非空」
 * 列为退出码 2 的触发场景，而"不覆盖用户已有内容"也是更安全的默认——SoT 根里已
 * 手工放了 custom/、habits.yaml 但缺 profile.yaml 时，旧判据会直接写入并把这些
 * 内容纳入一个用户没打算创建的 SoT。init -i 的交互流程不受影响：本函数在任何
 * 写入之前只调用一次（edit 分支落盘 habits.yaml 骨架发生在此之后）。
 *
 * 唯一的例外是事务锁目录 `.sync.lock`：runInit 把「判空 → 写入」整段包在
 * withSotLock 里（并发 init 串行化），锁目录就建在这个还没内容的根下。它是**运行时
 * 产物**而非用户内容（Spec §3.2），若计入非空判据，init 会自己把自己挡死。
 */
export async function resolveFreshSoTRoot(
  ctx: InitContext,
  env: EnvSnapshot,
  scope: Scope,
): Promise<string> {
  const sotRoot = sotRootForScope(ctx, env, scope);

  // 目录不存在 / 不可读 → []（等同"空目录"，init 可继续）
  const entries = (await listDirSafe(ctx.host, sotRoot)).filter(
    (entry) => entry !== SYNC_LOCK_DIRNAME,
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
    const { createdFiles, createdDirs } = await materializeSoT(ctx, sotRoot, [
      {
        path: path.join(sotRoot, HABITS_FILE),
        content: serializeYamlDoc(habitsSkeleton(detection)),
      },
      {
        path: path.join(sotRoot, PROFILE_FILE),
        content: serializeYamlDoc({ ...windowsDefaultProfile(), scope }),
      },
    ]);

    return {
      scope,
      sotRoot,
      createdFiles,
      createdDirs,
      detection,
    };
  });
}
