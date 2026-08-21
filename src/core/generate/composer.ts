/**
 * 规则正文装配（Spec §5.2 四层优先级，输出自上而下）：
 *   ① custom/*.md（按文件名序）→ ② promoted learnings（统一 ## Learnings 段）
 *   → ③ profile.templates 已解析模板（列表序）→ ④ 内置 base/default（恒渲染一次）。
 *
 * 职责边界：只产正文（renderedRulesMd 的 body）；marker 包裹由投影层负责。
 * 模板正文来自调用方先经 resolver 解析（fail-fast：缺失 id 在此抛 ConfigError(2)）；
 * 渲染前先 validateTemplate 再 renderTemplate（Spec §5.4：非法表达式 → 退出码 2）。
 *
 * 数据侧（变量视图）：habits → TemplateView（runtime.* / tools.* / ai.*）。
 * manager='none' / container='none' / 空数组统一归一化为"未设置"，模板经 #if
 * 据此省略小节——禁止编造默认工具、禁止输出 "Not specified"（Spec §5.1）。
 */
import { BASE_DEFAULT_TEMPLATE, BASE_DEFAULT_TEMPLATE_ID } from '../../assets/templates';
import type { Habits, Profile } from '../../schema';
import { ConfigError } from '../errors';
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
function visibleRuntime<T extends { readonly manager?: string }>(entry: T | undefined): T | undefined {
  if (entry === undefined) return undefined;
  if (entry.manager === undefined || entry.manager === 'none') return undefined;
  return entry;
}

/** 空数组 / 未声明归一化为 undefined（#if 空数组本为 falsy，显式省略保持视图形状一致）。 */
function visibleArray<T>(items: readonly T[] | undefined): readonly T[] | undefined {
  if (items === undefined || items.length === 0) return undefined;
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
// 装配
// ---------------------------------------------------------------------------

/** 剥掉小节首部空行与尾部全部空白（返回裸正文，不含边缘换行）。 */
function stripSection(section: string): string {
  return section
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/\s+$/, '');
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
 * @returns 规则正文（LF、单换行结尾，无 marker——包裹由投影层负责）。
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
    if (id === BASE_DEFAULT_TEMPLATE_ID) continue;
    if (!available.has(id)) {
      throw new ConfigError(`未解析的模板 id: ${id}（profile.templates 已声明但未提供内容）`, {
        hint: '检查 profile.templates 或运行 aforge template list',
        details: { id, declared },
      });
    }
  }
  for (const template of input.templateContents) {
    if (template.id === BASE_DEFAULT_TEMPLATE_ID) continue;
    sections.push(await renderValidated(template.id, template.content, view));
  }

  // ④ 内置 base/default（恒渲染，四层最低）
  sections.push(await renderValidated(BASE_DEFAULT_TEMPLATE_ID, BASE_DEFAULT_TEMPLATE, view));

  const parts = sections.filter((s) => s !== '');
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`;
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
