/**
 * 默认注册源（官方模板仓库，Spec §4.4 / §4.6）。
 *
 * 这个模块回答三个问题，且只回答这三个：
 * 1. **官方源长什么样**：`DEFAULT_SOURCES` 是一张常量表（数据声明）；
 * 2. **它什么时候进 SoT**：只有用户显式跑 `aforge source enable official` 时——
 *    `init` **不再播种**（Spec §4.6：该能力已决议裁剪，下一 major 移除本模块）；
 * 3. **怎么开关**：`setSourceEnabled` —— 翻 `enabled` 位；对登记表里没有官方源条目的
 *    SoT，`enable` 兼作补登记，这是它唯一的入场路径。
 *
 * ## 为什么 `init` 不再播种
 *
 * 播种的持续成本（manifest 规范、缓存治理、供应链责任）对应一个从未被验证的需求，
 * 而 git pin + 本地路径已覆盖外部模板的真实场景（Spec §4.6，issue #55）。附带的一个
 * 具体代价是常量表里的 `ref` 是硬编码 pin：播种会把一个随 CLI 发版持续落后的版本号
 * 写进每台机器的 user 层登记表，而用户的 SoT 一个字节都没变。
 *
 * 停止播种不改变已登记条目的行为：`sources.json` 里已有的 `official`（老 SoT 播种下来
 * 的，或用户自己 enable 的）照旧参与解析，pin 也照旧由用户的文件说话。
 *
 * ## 零网络
 *
 * 补登记只写一个 JSON，**不做任何 git 调用**：条目带 `ref`、不带 `commit`，store 下也
 * 没有目录。内容在首次真正用到时才补（见 manager.materializeGitSource 与
 * template.listTemplates）。
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
  /** 人类可读说明（doctor / status 的展示文案）。 */
  readonly description: string;
}

/**
 * 默认注册项常量表（**唯一事实源**）。
 *
 * 官方模板仓库当前就是 AgentForge 本仓库：它的 `templates/` 目录即官方模板集。指向本
 * 仓库而不是另开一个仓库，是为了让 pin 与 CLI 版本天然同源、不必维护两套 tag 节奏。
 *
 * 这张表只在用户显式 `aforge source enable official` 时被读取（补登记的模板）——`init`
 * 不再播种，所以表里的 `ref` 落后于当前 CLI 版本不再影响任何未主动启用的用户。整个模块
 * 按 Spec §4.6 在下一 major 移除。
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
 * 刻意**不填 `commit`**：补登记时还没 clone，编一个 commit 会让 `source list` 显示一个
 * 磁盘上并不存在的 pin。首次拉取由 materializeGitSource 回写真实 commit。
 */
export function defaultSourceEntry(decl: DefaultSourceDecl, enabled: boolean): GitSource {
  assertSourceId(decl.id);
  return {
    id: decl.id,
    type: 'git',
    url: decl.url,
    ref: decl.ref,
    enabled,
    kind: [...decl.kind],
  };
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
   * `init` 不再播种（Spec §4.6），所以登记表里通常没有官方源条目；`enable` 按常量表补
   * 一条——这是该源唯一的入场路径，也是唯一会让默认项"出现"的用户显式动作。
   */
  readonly registered: boolean;
}

/**
 * 启用 / 禁用一个登记源（只改 `enabled` 位，不动 url/ref/commit，也不碰 store 缓存）。
 *
 * 三条分支：
 * - id 已登记 → 翻位（已是目标状态则 changed:false，不写盘）；
 * - id 未登记但在 `DEFAULT_SOURCES` 中且 `enabled=true` → 按常量表补登记并启用（`init`
 *   不再播种，所以这是官方源的常规入场路径）；
 * - 其余 → ConfigError(2)。
 *
 * `disable` 刻意**不**走补登记：对一个本就不存在的条目"禁用"，写一条 disabled 记录
 * 只会让登记表长出用户没要求的东西。
 *
 * 禁用不删缓存：`store\<id>` 留着，重新 enable 时无需再联网。但**禁用即不参与渲染**
 * （模板解析第 4 层只认已启用的登记项，见 `./render-scope`）：缓存只是"下次开箱即用"
 * 的资产，不是绕过 `enabled` 的后门。要连缓存一起回收用 `aforge source remove`
 * （§7.6 的既有语义）。
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
