/**
 * 渲染时的源作用域（issue #55：`disable` 必须挡住 `resolveTemplate`）。
 *
 * 这个模块只回答一个问题：**这次渲染允许从哪些源里解析模板**。
 *
 * ## 语义：`disable` = 该源完全不参与渲染
 *
 * `docs/commands.md`「官方模板源（默认注册、默认禁用）」把禁用态写成"不联网、
 * 不进 `template list`、**不参与渲染**"，这就是设计意图；旧实现里
 * `resolveTemplate` 的第 4 层按 `store\` 下的**目录名**扫描、根本不读登记表，
 * 于是"enable → 拉取 → disable"之后缓存里的模板仍会被 `sync` 渲染，与文档相反。
 * 修的是实现：`enabled` 是**唯一**的参与判据，缓存留着只是为了重新 enable 时
 * 不必再联网（`aforge source remove` 才回收缓存）。
 *
 * 这样一来三处口径同源：`template list`（sources/template.ts）、渲染
 * （generate/resolver 第 4 层）、`doctor` 的 `template/<id>` 检查项都以登记表为准，
 * 不会再出现「列不出来却渲染得出」或「列得出来却解析不到」。
 *
 * ## 为什么把 disabled 的源也带出来
 *
 * 命中一个已禁用源的模板时，用户需要的不是"未解析的模板 id"这句含糊话，而是
 * 「这个 id 来自源 X，要么 `aforge source enable X`、要么把它从 `profile.templates`
 * 里去掉」。所以清单里**保留** disabled 条目，由 resolver 在报错时用它拼提示。
 *
 * ## 懒求值：登记表损坏不该拖垮不相干的 sync
 *
 * 渲染链路一旦无条件读 `sources.json`，登记表损坏就会让任何 `sync` 以
 * ConfigError(2) 失败——即使这次渲染的模板全都来自内置 / 两层 SoT。`providerFor`
 * 返回的是**记忆化的惰性函数**：resolver 只在前 3 层都未命中时才调用它，一次渲染
 * 里多个模板 id 也只读一次表。于是"依赖登记表"的范围被收窄到"这个 id 确实只能从
 * 源里解析"这一种情况——而那时读表本来就是必要的。
 */
import type { Host } from '../../infra/host';
import { loadSources, type SourceRegistryContext, sourceRootDir } from './store';

/**
 * 一条参与（或被排除于）模板解析的源。
 *
 * `root` 是源内容的磁盘根：git → `<userSoT>\store\<id>`，local → 登记的 path。
 * 模板文件位置按 §4.5 布局固定为 `<root>\templates\<id>.md`。
 */
export interface TemplateSourceEntry {
  readonly id: string;
  readonly root: string;
  /** 登记表里的 `enabled`；false 的条目只用于错误提示，不参与解析。 */
  readonly enabled: boolean;
}

/**
 * 读登记表 → 模板解析用的源清单（按 id 字典序，与旧实现的"按目录名字典序取首个"
 * 命中顺序一致）。
 *
 * @throws ConfigError(2) sources.json 损坏 / 含越界 id（loadSources 的既有契约）。
 */
export async function listTemplateSources(
  ctx: SourceRegistryContext,
): Promise<TemplateSourceEntry[]> {
  const sources = await loadSources(ctx);
  return sources
    .map((source) => ({
      id: source.id,
      root: sourceRootDir(ctx, source),
      enabled: source.enabled,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 注入给 `ResolveContext.sources` 的惰性 provider（同一次渲染内只读一次登记表）。
 *
 * 失败也记忆化：读表抛错时后续调用会拿到同一个 rejected promise，因此一次 sync 里
 * 不会对着同一个坏文件反复读盘、也不会出现"第一个模板报登记表损坏、第二个报未解析"
 * 这种自相矛盾的输出。
 */
export function templateSourcesProvider(
  host: Host,
  userSoTRoot: string,
): () => Promise<readonly TemplateSourceEntry[]> {
  let cached: Promise<readonly TemplateSourceEntry[]> | undefined;
  return () => {
    cached ??= listTemplateSources({ host, userSoTRoot });
    return cached;
  };
}
