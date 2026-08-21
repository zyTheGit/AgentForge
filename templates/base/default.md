# AgentForge Rules
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
