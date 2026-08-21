/**
 * 发行包内置模板资产（Spec §3.4 / §5.1）。
 *
 * 以本文件的 TS 常量为单一事实源（构建步骤暂不读取 .md）；项目根
 * `templates/base/default.md` 是同步副本，由单测
 * （tests/unit/generate/composer.spec.ts）断言两者逐字一致，防止漂移。
 *
 * base/design 约束（Spec §5.1 / §4.1 规则）：
 * - 极薄骨架：仅章节结构 + Handlebars 变量占位，禁止写死任何个人工具名；
 * - 字段为空时省略小节（#if 包裹），禁止编造默认工具、禁止输出 "Not specified"；
 * - 仅使用内置 helpers（#if / #each 与 {{else}} 分支），无自定义 helper；
 * - 章节结构对齐 Spec §13.2 投影示例（Toolchain / Style / Verification / Forbidden）；
 * - `runtime.has_toolchain` 为渲染层变量视图（core/generate/composer）派生的
 *   节可见性布尔，用于五条目全空时整节省略。
 */

/** 内置模板 id（profile.templates 的默认项；resolver 对它恒返回内置内容）。 */
export const BASE_DEFAULT_TEMPLATE_ID = 'base/default';

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
