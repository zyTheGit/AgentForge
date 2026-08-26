/**
 * 规则正文装配（Spec §5.2 四层优先级，输出自上而下）：
 *   ① custom/*.md（按文件名序）→ ② promoted learnings（统一 ## Learnings 段）
 *   → ③ profile.templates 已解析模板（列表序）→ ④ 内置 base/default（恒渲染一次）。
 *
 * 职责边界：只产正文（renderedRulesMd 的 body）；marker 包裹由投影层负责。
 * 装配出口按 profile.projection.path_style 归一正文里的路径 token（§4.2，
 * 见 applyPathStyle）。
 * 模板正文来自调用方先经 resolver 解析（fail-fast：缺失 id 在此抛 ConfigError(2)）；
 * 渲染前先 validateTemplate 再 renderTemplate（Spec §5.4：非法表达式 → 退出码 2）。
 *
 * 数据侧（变量视图）：habits → TemplateView（runtime.* / tools.* / ai.*）。
 * manager='none' / container='none' / 空数组统一归一化为"未设置"，模板经 #if
 * 据此省略小节——禁止编造默认工具、禁止输出 "Not specified"（Spec §5.1）。
 */
import { BASE_DEFAULT_TEMPLATE, BASE_DEFAULT_TEMPLATE_ID } from '../../assets/templates';
import type { Habits, PathStyle, Profile } from '../../schema';
import { ConfigError } from '../errors';
import type { OsContext } from '../paths';
import { renderTemplate, validateTemplate } from './renderer';

/** 已解析模板正文（resolver 的输出形态；composer 只消费、不再做 IO 解析）。 */
export interface TemplateContent {
  readonly id: string;
  readonly content: string;
}

/** composeRules 输入：装配所需的四层素材（顺序契约见各字段注释）。 */
export interface ComposeInput {
  readonly habits: Habits;
  readonly profile: Profile;
  /** custom/*.md 正文（调用方已按文件名排序），§5.2 第 ① 层。 */
  readonly customContents: readonly string[];
  /** 已 promote 的 learning content 列表，§5.2 第 ② 层（统一 ## Learnings 段）。 */
  readonly promotedLearnings: readonly string[];
  /** 已解析模板（按 profile.templates 顺序；可含 base/default，第 ④ 层恒用内置版）。 */
  readonly templateContents: readonly TemplateContent[];
  /**
   * 宿主平台（`projection.path_style: auto` 的判据，Spec §4.2）。
   * 缺省按 posix 解释 auto——纯函数不去读 process，调用方（engine / doctor）注入。
   */
  readonly os?: OsContext;
}

// ---------------------------------------------------------------------------
// 变量视图（Spec §5.1：模板变量契约）
// ---------------------------------------------------------------------------

export interface RuntimeNodeView {
  /** 使用中的 Node 版本管理器（条目存在 ⇔ manager 已声明且不为 'none'）。 */
  readonly manager?: string;
  readonly version?: string;
  readonly notes?: string;
}

export interface RuntimePythonView {
  /** 使用中的 Python 环境管理器（条目存在 ⇔ manager 已声明且不为 'none'）。 */
  readonly manager?: string;
  readonly version?: string;
  readonly notes?: string;
}

export interface RuntimeRustView {
  readonly manager?: string;
  readonly toolchain?: string;
}

export interface RuntimeGoView {
  readonly manager?: string;
  readonly version?: string;
}

/** 渲染变量视图：模板可直接消费的 habits 投影（runtime.* / tools.* / ai.*）。 */
export interface TemplateView {
  readonly runtime: {
    readonly node?: RuntimeNodeView;
    readonly python?: RuntimePythonView;
    readonly package_managers?: readonly string[];
    readonly rust?: RuntimeRustView;
    readonly go?: RuntimeGoView;
    /** 派生：Toolchain 节可见性（五个条目任一存在）。 */
    readonly has_toolchain: boolean;
  };
  readonly tools: {
    readonly shell?: string;
    readonly editor?: string;
    readonly git?: {
      readonly conventional_commits?: boolean;
      readonly sign_commits?: boolean;
      readonly default_branch?: string;
      readonly notes?: string;
    };
    readonly container?: string;
  };
  readonly ai: {
    readonly language?: readonly string[];
    readonly style?: string;
    readonly verification?: readonly string[];
    readonly forbid?: readonly string[];
  };
}

/** manager 未声明或为 'none' 的 runtime 条目视为"不使用"，整条省略（Spec §4.1 枚举含 none）。 */
function visibleRuntime<T extends { readonly manager?: string }>(
  entry: T | undefined,
): T | undefined {
  if (entry === undefined) {
    return undefined;
  }
  if (entry.manager === undefined || entry.manager === 'none') {
    return undefined;
  }
  return entry;
}

/** 空数组 / 未声明归一化为 undefined（#if 空数组本为 falsy，显式省略保持视图形状一致）。 */
function visibleArray<T>(items: readonly T[] | undefined): readonly T[] | undefined {
  if (items === undefined || items.length === 0) {
    return undefined;
  }
  return items;
}

/** habits → 变量视图（内置 base/default 与外部模板共用同一形状）。 */
export function buildTemplateView(habits: Habits): TemplateView {
  const node = visibleRuntime(habits.runtime.node);
  const python = visibleRuntime(habits.runtime.python);
  const packageManagers = visibleArray(habits.runtime.package_managers);
  const rust = visibleRuntime(habits.runtime.rust);
  const go = visibleRuntime(habits.runtime.go);
  return {
    runtime: {
      node,
      python,
      package_managers: packageManagers,
      rust,
      go,
      has_toolchain:
        node !== undefined ||
        python !== undefined ||
        packageManagers !== undefined ||
        rust !== undefined ||
        go !== undefined,
    },
    tools: {
      shell: habits.tools.shell,
      editor: habits.tools.editor,
      git: habits.tools.git,
      container: habits.tools.container === 'none' ? undefined : habits.tools.container,
    },
    ai: {
      language: visibleArray(habits.ai.language),
      style: habits.ai.style,
      verification: visibleArray(habits.ai.verification),
      forbid: visibleArray(habits.ai.forbid),
    },
  };
}

// ---------------------------------------------------------------------------
// 路径风格归一化（Spec §4.2 projection.path_style）
// ---------------------------------------------------------------------------

/**
 * 路径 token 匹配器：以「家目录变量 / `~` / 盘符」开头，后接至少一段分隔符 + 路径段。
 *
 * 为什么不全文替换分隔符：规则正文里绝大多数 `/` 与 `\` 属于散文与代码片段
 * （`rm -rf /`、`and/or`、正则转义），无差别替换会破坏用户内容。只在能确认是
 * 路径的 token 内部改写，才既满足 §4.2 又不误伤正文。
 *
 * 结束边界排除空白与常见标点（引号 / 反引号 / 逗号 / 分号 / 括号），使
 * `见 %USERPROFILE%\.codex\AGENTS.md，` 这类中文语境也能正确收边。
 *
 * 盘符分支必须**左边界锚定**：裸 `[A-Za-z]:` 会在 `https://example.com/repo` 里
 * 命中 `s://example.com/repo`，windows 风格下把 URL 改写成 `https:\\example.com\repo`
 * （`auto` 在 Windows 宿主上即 windows，属默认路径）。因此盘符要求
 * ①左侧不是字母数字（排除 `http` / `file` / `git+ssh` 等 scheme 的末字符）、
 * ②左侧不是分隔符（排除 `file:///C:/...` 里 URL 内部的盘符）、
 * ③右侧不是 `//`（排除单字母 scheme）。家目录变量分支无此风险，保持原样。
 */
const PATH_TOKEN_RE =
  /(?:%USERPROFILE%|\$\{HOME\}|\$HOME|~|(?<![A-Za-z0-9\\/])[A-Za-z]:(?!\/\/))(?:[\\/][^\s"'`,;)\]}，、。]*)+/g;

/** 有效路径风格：auto → 按宿主平台展开（win32 → windows，其余 → posix）。 */
function effectivePathStyle(style: PathStyle, os: OsContext | undefined): 'windows' | 'posix' {
  if (style === 'windows' || style === 'posix') {
    return style;
  }
  return os?.platform === 'win32' ? 'windows' : 'posix';
}

/**
 * 把投影正文里的路径 token 归一到目标风格（Spec §4.2 projection.path_style）：
 * - `windows`：分隔符 `\`，家目录变量 `%USERPROFILE%`（`$HOME` / `${HOME}` / 前导 `~` 均转换）；
 * - `posix`：分隔符 `/`，家目录变量 `$HOME`（`%USERPROFILE%` / `${HOME}` / 前导 `~` 均转换）；
 * - `auto`：按注入的宿主平台选上面之一。
 *
 * 两分支的家目录前缀集合对称（含 `${HOME}`）：任一分支漏一种写法，同一段正文在
 * 两种 path_style 下就会出现"一边归一、一边残留"的不一致。
 *
 * 只改写 PATH_TOKEN_RE 命中的 token 内部，其余正文（含散文里的斜杠与 URL）原样保留。
 *
 * @returns 归一后的正文（不改变换行；换行风格由投影落盘层统一，§2.5）。
 */
export function applyPathStyle(text: string, style: PathStyle, os?: OsContext): string {
  const target = effectivePathStyle(style, os);
  return text.replace(PATH_TOKEN_RE, (token) => {
    if (target === 'windows') {
      return token.replace(/^(?:\$\{HOME\}|\$HOME|~)/, '%USERPROFILE%').replace(/\//g, '\\');
    }
    return token.replace(/^(?:%USERPROFILE%|\$\{HOME\}|~)/, '$HOME').replace(/\\/g, '/');
  });
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

/** 剥掉小节首部空行与尾部全部空白（返回裸正文，不含边缘换行）。 */
function stripSection(section: string): string {
  return section.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
}

/** 先校验后渲染一个模板，返回规范化正文（语法错误 → ConfigError(2)，message 带 id）。 */
async function renderValidated(id: string, source: string, view: TemplateView): Promise<string> {
  await validateTemplate(source, `模板 ${id} `);
  return stripSection(await renderTemplate(source, view));
}

/**
 * 装配规则正文（§5.2 四层优先级）。
 *
 * - ③ 层按 templateContents 顺序（调用方按 profile.templates 顺序提供），
 *   其中 base/default 跳过——④ 层恒用内置常量渲染一次，避免重复；
 * - profile.templates 声明的非内置 id 缺失于 templateContents → ConfigError(2)
 *   （调用方应先 resolve；此处 fail-fast 兜底，Spec §5.2 未解析 id → sync 失败）；
 * - 全空输入输出最小骨架（base/default 渲染出的 `# AgentForge Rules` 标题）。
 *
 * @returns 规则正文（LF、单换行结尾，无 marker——包裹由投影层负责；
 *   路径 token 已按 profile.projection.path_style 归一）。
 */
export async function composeRules(input: ComposeInput): Promise<string> {
  const view = buildTemplateView(input.habits);

  const sections: string[] = [];

  // ① custom/*.md（按序；每文件一个小节）
  for (const content of input.customContents) {
    sections.push(stripSection(content));
  }

  // ② promoted learnings → 统一 ## Learnings 段（条目间空行分隔）
  const learned = input.promotedLearnings.map(stripSection).filter((s) => s !== '');
  if (learned.length > 0) {
    sections.push(stripSection(`## Learnings\n\n${learned.join('\n\n')}`));
  }

  // ③ 已解析模板（列表序）：缺失的非内置 id → fail-fast
  const declared = input.profile.templates ?? [];
  const available = new Set(input.templateContents.map((t) => t.id));
  for (const id of declared) {
    if (id === BASE_DEFAULT_TEMPLATE_ID) {
      continue;
    }
    if (!available.has(id)) {
      throw new ConfigError(`未解析的模板 id: ${id}（profile.templates 已声明但未提供内容）`, {
        hint: '检查 profile.templates 或运行 aforge template list',
        details: { id, declared },
      });
    }
  }
  for (const template of input.templateContents) {
    if (template.id === BASE_DEFAULT_TEMPLATE_ID) {
      continue;
    }
    sections.push(await renderValidated(template.id, template.content, view));
  }

  // ④ 内置 base/default（恒渲染，四层最低）
  sections.push(await renderValidated(BASE_DEFAULT_TEMPLATE_ID, BASE_DEFAULT_TEMPLATE, view));

  const parts = sections.filter((s) => s !== '');
  if (parts.length === 0) {
    return '';
  }
  // 出口统一做路径风格归一（§4.2 path_style）：四层素材（custom / learnings /
  // 模板 / 内置）都可能写路径，放在装配出口是唯一不漏项的位置。
  return applyPathStyle(`${parts.join('\n\n')}\n`, input.profile.projection.path_style, input.os);
}

/**
 * 便捷渲染：仅 base/default（内置模板 + 变量视图），返回正文（LF、单换行结尾，
 * 不含 marker）。供最小场景与诊断使用；完整装配（custom/learnings/templates）
 * 请走 composeRules。
 */
export async function renderRules(habits: Habits): Promise<string> {
  const view = buildTemplateView(habits);
  await validateTemplate(BASE_DEFAULT_TEMPLATE, `模板 ${BASE_DEFAULT_TEMPLATE_ID} `);
  return renderTemplate(BASE_DEFAULT_TEMPLATE, view);
}
