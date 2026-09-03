/**
 * 发行包内置模板资产（Spec §3.4 / §5.1）。
 *
 * 以本文件的 TS 常量为单一事实源（构建步骤暂不读取 .md）；项目根
 * `templates/base/<id>.md` 是同步副本，由单测
 * （tests/unit/generate/composer.spec.ts）遍历 BUILTIN_TEMPLATES 断言逐字一致，
 * 防止漂移。
 *
 * 三个内置模板的分工与投影层级：
 * - `base/default`：**恒渲染**（§5.2 第 ④ 层，最低优先级），骨架 + Toolchain /
 *   Style / Verification / Forbidden；
 * - `base/tools`：**opt-in**（第 ③ 层，需登记进 profile.templates），渲染视图里
 *   本来就有、但 base/default 不管的 `tools.*`；
 * - `base/context`：**opt-in**，把 `habits.detected` 快照渲染成「仅供参考」的
 *   项目上下文节——它是「探测 → 渲染」这条链路的收口（见 docs/direction-review.md
 *   §2.1 / §2.2：四类冻结探测器此前只写 detected、无人渲染）。
 *
 * 为什么后两个不恒渲染：默认投影必须保持极薄，且 `base/context` 输出的是探测结论
 * 而非用户声明，塞进默认投影等于替用户默认接受一段他没写过的正文。
 *
 * 共同约束（Spec §5.1 / §4.1 规则 1 的「变量渲染除外」边界）：
 * - 极薄骨架：仅章节结构 + Handlebars 变量占位，禁止写死任何个人工具名；
 * - 字段为空时省略小节（#if 包裹），禁止编造默认工具、禁止输出 "Not specified"；
 * - 仅使用内置 helpers（#if / #each 与 {{else}} 分支），无自定义 helper；
 * - 章节结构对齐 Spec §13.2 投影示例（Toolchain / Style / Verification / Forbidden）；
 * - `runtime.has_toolchain` / `tools.has_any` / `detected.has_any` 为渲染层变量视图
 *   （core/generate/composer）派生的节可见性布尔，用于条目全空时整节省略；
 * - **改这里的措辞 = 全用户投影变更**（发行包常量，随版本一起生效）。
 */

/** 内置模板 id（profile.templates 的默认项；resolver 对它恒返回内置内容）。 */
export const BASE_DEFAULT_TEMPLATE_ID = 'base/default';

/** 内置模板 id：`tools.*` 补缺（opt-in，需登记进 profile.templates）。 */
export const BASE_TOOLS_TEMPLATE_ID = 'base/tools';

/** 内置模板 id：`habits.detected` 快照补缺（opt-in，需登记进 profile.templates）。 */
export const BASE_CONTEXT_TEMPLATE_ID = 'base/context';

/**
 * 内置 base/default 模板正文（LF 结尾）。
 * 变量视图形状见 core/generate/composer.ts 的 TemplateView。
 */
export const BASE_DEFAULT_TEMPLATE = `# AgentForge Rules
{{#if runtime.has_toolchain}}

## Toolchain
{{#if runtime.node.manager}}
- Node: use **{{runtime.node.manager}}** only{{#if runtime.node.version}} (version preference: {{runtime.node.version}}){{/if}}.
{{/if}}
{{#if runtime.python.manager}}
- Python: use **{{runtime.python.manager}}** for envs and dependencies{{#if runtime.python.version}} ({{runtime.python.version}}){{/if}}.
{{/if}}
{{#if runtime.package_managers}}
- JS packages: prefer {{#each runtime.package_managers}}{{#if @first}}**{{this}}**{{else}}, then {{this}}{{/if}}{{/each}}.
{{/if}}
{{#if runtime.rust.manager}}
- Rust: use **{{runtime.rust.manager}}**{{#if runtime.rust.toolchain}} (toolchain: {{runtime.rust.toolchain}}){{/if}}.
{{/if}}
{{#if runtime.go.manager}}
- Go: use **{{runtime.go.manager}}**{{#if runtime.go.version}} (version preference: {{runtime.go.version}}){{/if}}.
{{/if}}
{{/if}}
{{#if ai.style}}

## Style
{{ai.style}}
{{/if}}
{{#if ai.verification}}

## Verification
Before finishing: run {{#each ai.verification}}{{#if @first}}{{this}}{{else if @last}}, and {{this}}{{else}}, {{this}}{{/if}}{{/each}} when applicable.
{{/if}}
{{#if ai.forbid}}

## Forbidden
{{#each ai.forbid}}
- {{this}}
{{/each}}
{{/if}}
`;

/**
 * 内置 base/tools 模板正文（LF 结尾）：`tools.*` 的声明侧渲染。
 *
 * 只消费 habits 的**声明**字段（`tools.shell` / `editor` / `container` / `git.*`）。
 * `tools.git` 四个子字段全空时视图会把整条归一为 undefined（见 buildTemplateView），
 * 所以这里不需要再判「git 是否有内容」。
 */
export const BASE_TOOLS_TEMPLATE = `{{#if tools.has_any}}
## Tools
{{#if tools.shell}}
- Shell: write commands in **{{tools.shell}}** syntax.
{{/if}}
{{#if tools.editor}}
- Editor: **{{tools.editor}}**.
{{/if}}
{{#if tools.container}}
- Containers: use **{{tools.container}}**.
{{/if}}
{{#if tools.git.default_branch}}
- Git: default branch is \`{{tools.git.default_branch}}\`; land changes through a branch + PR.
{{/if}}
{{#if tools.git.conventional_commits}}
- Git: commit messages follow Conventional Commits.
{{/if}}
{{#if tools.git.sign_commits}}
- Git: sign every commit.
{{/if}}
{{#if tools.git.notes}}
- Git: {{tools.git.notes}}
{{/if}}
{{/if}}
`;

/**
 * 内置 base/context 模板正文（LF 结尾）：`habits.detected` 快照的参考渲染。
 *
 * 措辞是**「检测到，仅供参考」**而不是规则：detected 是探测器的只读结论，按 §4.1
 * 「声明字段优先于 detected」，它不能以规则口吻压过用户声明。首句显式写明这一点，
 * 免得模型把探测结论当成硬约束。
 */
export const BASE_CONTEXT_TEMPLATE = `{{#if detected.has_any}}
## Project Context (detected)

Detected by AgentForge, **for reference only — not rules**. Declared habits above win on conflict.
{{#each detected.runtimes}}
- {{this.label}}: {{this.manager}}{{#if this.version}} ({{this.version}}){{/if}}{{#if this.source}} — from {{this.source}}{{/if}}
{{/each}}
{{#if detected.package_managers}}
- JS package managers: {{#each detected.package_managers}}{{#if @first}}{{this}}{{else}}, {{this}}{{/if}}{{/each}}
{{/if}}
{{#if detected.monorepo}}
- Monorepo tooling: {{detected.monorepo.manager}}{{#if detected.monorepo.source}} — from {{detected.monorepo.source}}{{/if}}
{{/if}}
{{#if detected.ci}}
- CI: {{detected.ci.manager}}{{#if detected.ci.source}} — from {{detected.ci.source}}{{/if}}
{{/if}}
{{/if}}
`;

/** 内置模板登记项（resolver 第 1 层与 template list 的 builtin 项共用同一份）。 */
export interface BuiltinTemplate {
  readonly id: string;
  /** 模板正文（Handlebars 源码，LF 结尾）。 */
  readonly content: string;
  /** `template list` 展示用的一句话说明。 */
  readonly description: string;
  /**
   * 是否**恒渲染**（§5.2 第 ④ 层）。
   *
   * `false` 表示 opt-in：与外部模板同层（第 ③ 层）按 profile.templates 顺序渲染，
   * 没登记就一个字都不产出。
   */
  readonly alwaysRendered: boolean;
}

/** 内置模板登记表（**数量封顶 3 个**：每个都是发行包常量，改措辞 = 全用户投影变更）。 */
export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  {
    id: BASE_DEFAULT_TEMPLATE_ID,
    content: BASE_DEFAULT_TEMPLATE,
    description: 'skeleton: Toolchain / Style / Verification / Forbidden',
    alwaysRendered: true,
  },
  {
    id: BASE_TOOLS_TEMPLATE_ID,
    content: BASE_TOOLS_TEMPLATE,
    description: 'tools.* (shell / editor / container / git) — opt-in',
    alwaysRendered: false,
  },
  {
    id: BASE_CONTEXT_TEMPLATE_ID,
    content: BASE_CONTEXT_TEMPLATE,
    description: 'habits.detected snapshot as reference context — opt-in',
    alwaysRendered: false,
  },
];

/** 按 id 查内置模板（未命中 → undefined，由调用方继续往 SoT / 源里找）。 */
export function findBuiltinTemplate(id: string): BuiltinTemplate | undefined {
  return BUILTIN_TEMPLATES.find((tpl) => tpl.id === id);
}

/**
 * 该 id 是否为**恒渲染**的内置模板（第 ④ 层）。
 *
 * 装配层用它把「已在 ④ 层渲染过」的 id 从 ③ 层剔除；opt-in 的内置模板不在此列——
 * 它们本来就该走 ③ 层，剔掉就等于登记了也不生效。
 */
export function isAlwaysRenderedTemplate(id: string): boolean {
  return findBuiltinTemplate(id)?.alwaysRendered === true;
}
