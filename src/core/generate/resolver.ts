/**
 * 模板解析（Spec §5.2 / §3.4 / §4.5）：模板 id → 模板正文。
 *
 * 查找优先级（高 → 低）：
 * 1. 内置模板（发行包只读骨架，恒可用；不可被 SoT 覆盖，Spec §3.4）——登记表见
 *    assets/templates.BUILTIN_TEMPLATES（`base/default` / `base/tools` / `base/context`）；
 * 2. 项目 SoT `<project>\.agentforge\templates\<id>.md`;
 * 3. 用户 SoT `<user>\templates\<id>.md`；
 * 4. **已登记且已启用**的源：`<源根>\templates\<id>.md`（§4.5 外部模板包布局；
 *    源根由 core/sources/render-scope 按 sources.json 推导——git 源为
 *    `store\<id>`，local 源为登记的 path）。
 *
 * 全部未命中 → ConfigError(2)（Spec §5.2：未解析的 template id → sync 失败）。
 * 所有文件访问经注入的 Host；路径拼接一律 path.join（Spec §2.1）。
 */
import path from 'node:path';
import { findBuiltinTemplate } from '../../assets/templates';
import type { Host } from '../../infra/host';
import { ConfigError } from '../errors';
import type { TemplateSourceEntry } from '../sources/render-scope';

/**
 * 模板解析上下文：路径由调用方经 core/paths 解析后注入。
 *
 * `sources` 是**惰性**的第 4 层清单提供者（见 render-scope.templateSourcesProvider）：
 * 只有前 3 层都未命中时才会被调用，因此登记表损坏不会牵连"模板全在 SoT 里"的渲染。
 * 类型从 sources 层引入但**只在类型位置**（无运行时依赖）：第 4 层的数据形态归源域
 * 定义，resolver 不该自己复制一份同构接口。
 */
export interface ResolveContext {
  readonly host: Host;
  readonly userSoTRoot: string;
  readonly projectSoTRoot: string;
  readonly sources: () => Promise<readonly TemplateSourceEntry[]>;
}

/** 解析结果：模板 id 与其正文（UTF-8 已由 Host 解码剥 BOM）。 */
export interface ResolvedTemplate {
  readonly id: string;
  readonly content: string;
}

const TEMPLATE_LIST_HINT = '检查 profile.templates 或运行 aforge template list';

/** 校验模板 id：`/` 分隔的相对 id；拒绝空段 / `.`、`..` 段 / 反斜杠 / 绝对路径（防逃逸）。 */
function validateTemplateId(id: string): void {
  const segments = id.split('/');
  const invalid =
    id === '' ||
    id.includes('\\') ||
    path.isAbsolute(id) ||
    segments.some((seg) => seg === '' || seg === '.' || seg === '..');
  if (invalid) {
    throw new ConfigError(`非法模板 id: "${id}"`, {
      hint: '模板 id 形如 base/default（以 / 分隔的相对路径，不含扩展名）',
      details: { id },
    });
  }
}

/** SoT 内模板文件路径：`<root>\templates\<id>.md`。 */
function sotTemplateFile(soTRoot: string, id: string): string {
  return path.join(soTRoot, 'templates', `${id}.md`);
}

/** 源侧查找结果：命中正文，或"只有已禁用的源有这份模板"（用于错误提示）。 */
interface SourceLookup {
  readonly content?: string;
  /** 拥有该模板但当前被禁用的源 id（按 id 序）。 */
  readonly disabledOwners: readonly string[];
}

/**
 * 第 4 层查找：已登记源的 `<源根>\templates\<id>.md`，按源 id 字典序取首个**已启用**的。
 *
 * 禁用的源不参与解析（issue #55；语义与理由见 core/sources/render-scope），但会被
 * 记进 `disabledOwners`：命中它才知道该给"启用该源"这条提示，而不是干巴巴地说
 * "未解析的模板 id"。
 */
async function lookupSources(id: string, ctx: ResolveContext): Promise<SourceLookup> {
  const disabledOwners: string[] = [];
  for (const source of await ctx.sources()) {
    const candidate = path.join(source.root, 'templates', `${id}.md`);
    if (!(await ctx.host.exists(candidate))) {
      continue;
    }
    if (!source.enabled) {
      disabledOwners.push(source.id);
      continue;
    }
    return { content: await ctx.host.readFile(candidate), disabledOwners };
  }
  return { disabledOwners };
}

/**
 * 按优先级解析模板 id（见文件头）。
 *
 * @throws ConfigError(2) id 非法 / 命中的源已被禁用 / 四处均未命中。
 */
export async function resolveTemplate(id: string, ctx: ResolveContext): Promise<ResolvedTemplate> {
  validateTemplateId(id);

  // 1. 内置模板（恒优先，Spec §3.4 只读）
  const builtin = findBuiltinTemplate(id);
  if (builtin !== undefined) {
    return { id, content: builtin.content };
  }

  // 2. 项目 SoT
  const projectFile = sotTemplateFile(ctx.projectSoTRoot, id);
  if (await ctx.host.exists(projectFile)) {
    return { id, content: await ctx.host.readFile(projectFile) };
  }

  // 3. 用户 SoT
  const userFile = sotTemplateFile(ctx.userSoTRoot, id);
  if (await ctx.host.exists(userFile)) {
    return { id, content: await ctx.host.readFile(userFile) };
  }

  // 4. 已登记且已启用的源（此处才读登记表，见 ResolveContext.sources）
  const fromSources = await lookupSources(id, ctx);
  if (fromSources.content !== undefined) {
    return { id, content: fromSources.content };
  }

  // 只存在于已禁用的源 → 单独一条错误：两个修复动作都得说出来，用户才知道
  // 「启用该源」与「不再引用这个模板」是等价可选的
  if (fromSources.disabledOwners.length > 0) {
    const owners = fromSources.disabledOwners.join(', ');
    throw new ConfigError(`模板 id 只存在于已禁用的源: ${id}（来自 ${owners}）`, {
      hint: `启用它：aforge source enable ${fromSources.disabledOwners[0]}；或不再引用该模板：aforge template disable ${id}`,
      details: { id, disabledOwners: fromSources.disabledOwners },
    });
  }

  throw new ConfigError(`未解析的模板 id: ${id}`, {
    hint: TEMPLATE_LIST_HINT,
    details: {
      id,
      projectSoTRoot: ctx.projectSoTRoot,
      userSoTRoot: ctx.userSoTRoot,
    },
  });
}
