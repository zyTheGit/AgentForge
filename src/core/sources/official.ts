/**
 * 默认注册源（官方模板仓库，Spec §4.4 / §12 Phase 2「可选官方模板仓库」）。
 *
 * 这个模块回答三个问题，且只回答这三个：
 * 1. **官方源长什么样**：`DEFAULT_SOURCES` 是一张常量表（数据声明），加第二个官方源
 *    （例如官方 skills 源）只改这张表，不改任何流程分支；
 * 2. **它什么时候进 SoT**：`seedDefaultSources` —— 只在 user 层 `sources.json`
 *    **尚不存在**时播种一次；
 * 3. **怎么开关**：`setSourceEnabled` —— 翻 `enabled` 位；对老 SoT（登记表已存在但
 *    没有官方源条目）的 `enable` 兼作补登记，这就是迁移路径。
 *
 * ## 为什么"落盘进 SoT"而不是"像内置模板那样运行时隐式存在"
 *
 * 隐式方案（不落盘、用户只能 disable）看似对老 SoT 自动生效，但有两处硬伤：
 * - **pin 会随 CLI 版本漂移**：隐式条目的 url/ref 存在发行包的常量里，升级 CLI 就换了
 *   一个 pin，而用户的 SoT 一个字节都没变。`bundle export/import` 搬到另一台装了不同
 *   版本的机器上时，同一份 bundle 会解析出不同的模板内容——这与「SoT 是唯一事实源」
 *   直接冲突；落盘方案里 pin 写在 sources.json 内，bundle 原样带走（export 对
 *   sources.json 是原文直拷），往返后 ref/commit/enabled 逐字节不变。
 * - **"已删除"需要墓碑**：用户删掉隐式条目后要让它不复活，就得再存一份"我删过它"的
 *   记录——那还是落盘，只是把状态取反、并且多一种文件格式。
 *
 * 落盘方案的代价是"老 SoT 拿不到"，用一条显式命令（`aforge source enable official`）
 * 兑掉，见 setSourceEnabled 的补登记分支。
 *
 * ## 为什么"只在 sources.json 不存在时播种"
 *
 * 这是"不复活"的关键：`sources.json` 的**存在**本身就是墓碑。用户
 * `aforge source remove official` 后，登记表仍在（内容是 `sources: []`），此后任何
 * `init`（包括在别的项目里跑的 project scope init，它们共享同一张 user 层登记表）
 * 都不再播种。`sync` 从头到尾不写登记表，自然也不会加回来。
 *
 * ## 零网络
 *
 * 播种只写一个 JSON，**不做任何 git 调用**：条目带 `ref`、不带 `commit`，store 下也
 * 没有目录。内容在首次真正用到时才补（见 manager.materializeGitSource 与
 * template.listTemplates）。因此离线 / CI 下 `init` 不会因官方源变慢或失败。
 */
import type { GitSource, Source } from '../../schema';
import { ConfigError } from '../errors';
import {
  assertSourceId,
  loadSources,
  type SourceManagerContext,
  saveSources,
  sourcesFilePath,
} from './store';

/** 官方模板源的 id（`aforge source enable official` 里的那个名字）。 */
export const OFFICIAL_TEMPLATES_SOURCE_ID = 'official';

/** 一条默认注册项的声明（常量表的元素）。 */
export interface DefaultSourceDecl {
  /** 源 id（须满足 assertSourceId 的格式，因为它直接参与 `store\<id>` 路径拼装）。 */
  readonly id: string;
  readonly url: string;
  /**
   * 显式 pin（tag 或 commit sha）。
   *
   * **不允许浮动 `main`**：沿用 §4.4 对 git 源的既有口径（`source add` 缺 `--ref`
   * 即 ConfigError(2)）。浮动 ref 会让"同一份 SoT 渲染出同一份规则"这条不变量失效。
   */
  readonly ref: string;
  /** 该源提供的内容类别（§4.4 kind）。 */
  readonly kind: GitSource['kind'];
  /**
   * 播种时是否直接启用。
   *
   * 官方源恒为 `false`：启用它意味着"这台机器会去 clone 一个远端仓库"，那是用户的
   * 决定而不是安装器的决定。禁用态下 listTemplates / resolveTemplate 都跳过它，
   * 于是「默认注册」不带来任何网络与行为变化——真正的零配置是"想用时一条命令"，
   * 不是"装完就偷偷联网"。
   */
  readonly enabledByDefault: boolean;
  /** 人类可读说明（doctor / status 的展示文案）。 */
  readonly description: string;
}

/**
 * 默认注册项常量表（**唯一事实源**）。
 *
 * 官方模板仓库当前就是 AgentForge 本仓库：它的 `templates/` 目录即官方模板集
 * （v0.2.2 只有 `base/default.md`，后续官方模板会往这里加）。指向本仓库而不是另开
 * 一个仓库，是为了让 pin 与 CLI 版本天然同源、不必维护两套 tag 节奏。
 *
 * 注意与内置模板的**同名优先级**：本源里的 `templates/base/default.md` 与发行包内置的
 * `base/default` 同 id，而 resolveTemplate 恒先返回内置内容（§3.4 内置模板不可被
 * 覆盖）。因此启用官方源不会改变现有投影，只会**新增**它独有的模板 id。
 */
export const DEFAULT_SOURCES: readonly DefaultSourceDecl[] = [
  {
    id: OFFICIAL_TEMPLATES_SOURCE_ID,
    url: 'https://github.com/zyTheGit/AgentForge.git',
    ref: 'v0.2.2',
    kind: ['templates'],
    enabledByDefault: false,
    description: 'AgentForge 官方模板集（templates/ 目录）',
  },
];

/** 按 id 查默认注册项（不是默认项 → undefined）。 */
export function findDefaultSource(id: string): DefaultSourceDecl | undefined {
  return DEFAULT_SOURCES.find((decl) => decl.id === id);
}

/** 该 id 是否为默认注册项（doctor / status 打「official」标记用）。 */
export function isDefaultSourceId(id: string): boolean {
  return findDefaultSource(id) !== undefined;
}

/**
 * 声明 → 待落盘的登记条目。
 *
 * 刻意**不填 `commit`**：播种时还没 clone，编一个 commit 会让 `source list` 显示一个
 * 磁盘上并不存在的 pin。首次拉取由 materializeGitSource 回写真实 commit。
 */
export function defaultSourceEntry(decl: DefaultSourceDecl, enabled?: boolean): GitSource {
  assertSourceId(decl.id);
  return {
    id: decl.id,
    type: 'git',
    url: decl.url,
    ref: decl.ref,
    enabled: enabled ?? decl.enabledByDefault,
    kind: [...decl.kind],
  };
}

/** seedDefaultSources 结果。 */
export interface SeedDefaultSourcesResult {
  /** user 层 sources.json 绝对路径（无论是否播种都回报，供 init 输出）。 */
  readonly file: string;
  /** 本次写入的源 id（未播种 → 空数组）。 */
  readonly registered: readonly string[];
  /** 未播种的原因（已播种 → null）。 */
  readonly skipped: 'registry-exists' | null;
}

/**
 * 播种默认注册项到 user 层 sources.json（**仅当该文件尚不存在**）。
 *
 * 由 `init` 调用（两条路径：静默 runInit 与交互 init 的写入确认之后）。为什么写 user 层
 * 而不是本次 init 的那一层：`sources.json` 与 `store\` 按 §3.1 恒在 user 层，项目层的
 * 登记表当前根本没有读取方——写进项目层就是个死文件。
 *
 * 幂等且不复活：见文件头「为什么只在 sources.json 不存在时播种」。
 *
 * @throws PermissionError(4) user 层不可写（调用方按需降级，见 init-scaffold）。
 */
export async function seedDefaultSources(
  ctx: SourceManagerContext,
): Promise<SeedDefaultSourcesResult> {
  const file = sourcesFilePath(ctx);
  if (await ctx.host.exists(file)) {
    return { file, registered: [], skipped: 'registry-exists' };
  }
  const entries = DEFAULT_SOURCES.map((decl) => defaultSourceEntry(decl));
  await saveSources(ctx, entries);
  return { file, registered: entries.map((entry) => entry.id), skipped: null };
}

/** setSourceEnabled 结果。 */
export interface SetSourceEnabledResult {
  readonly source: Source;
  /** sources.json 绝对路径。 */
  readonly file: string;
  /** 本次是否实际改动（已是目标状态 → false，不写盘）。 */
  readonly changed: boolean;
  /**
   * 本次是否顺带**补登记**了一个默认注册项。
   *
   * 老 SoT（本特性之前 init 过的）登记表里没有官方源条目，`enable` 时按常量表补一条
   * ——这是老 SoT 的迁移路径，也是唯一会让默认项"出现"的用户显式动作。
   */
  readonly registered: boolean;
}

/**
 * 启用 / 禁用一个登记源（只改 `enabled` 位，不动 url/ref/commit，也不碰 store 缓存）。
 *
 * 三条分支：
 * - id 已登记 → 翻位（已是目标状态则 changed:false，不写盘）；
 * - id 未登记但在 `DEFAULT_SOURCES` 中且 `enabled=true` → 按常量表补登记并启用；
 * - 其余 → ConfigError(2)。
 *
 * `disable` 刻意**不**走补登记：对一个本就不存在的条目"禁用"，写一条 disabled 记录
 * 只会让登记表长出用户没要求的东西。
 *
 * 禁用不删缓存：`store\<id>` 留着，重新 enable 时无需再联网。要回收缓存用
 * `aforge source remove`（§7.6 的既有语义）。
 *
 * @throws ConfigError(2) id 非法 / 源不存在且不是默认注册项。
 */
export async function setSourceEnabled(
  ctx: SourceManagerContext,
  id: string,
  enabled: boolean,
): Promise<SetSourceEnabledResult> {
  assertSourceId(id);
  const sources = await loadSources(ctx);
  const current = sources.find((s) => s.id === id);

  if (current !== undefined) {
    if (current.enabled === enabled) {
      return { source: current, file: sourcesFilePath(ctx), changed: false, registered: false };
    }
    // 判别联合上的 spread：分支写开，避免 TS 把两支合成一个宽对象类型
    const next: Source =
      current.type === 'local' ? { ...current, enabled } : { ...current, enabled };
    const file = await saveSources(
      ctx,
      sources.map((s) => (s.id === id ? next : s)),
    );
    return { source: next, file, changed: true, registered: false };
  }

  const decl = findDefaultSource(id);
  if (decl === undefined || !enabled) {
    throw new ConfigError(`源不存在: ${id}`, {
      hint:
        decl === undefined
          ? '运行 aforge source list 查看已登记的源；官方源用 aforge source enable official 启用'
          : `${id} 是默认注册项但当前未登记，无需禁用；如需启用请运行 aforge source enable ${id}`,
      details: { id },
    });
  }

  const entry = defaultSourceEntry(decl, true);
  const file = await saveSources(ctx, [...sources, entry]);
  return { source: entry, file, changed: true, registered: true };
}
