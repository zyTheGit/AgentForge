{{#if detected.has_any}}
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
