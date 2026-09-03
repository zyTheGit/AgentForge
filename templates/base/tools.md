{{#if tools.has_any}}
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
- Git: default branch is `{{tools.git.default_branch}}`; land changes through a branch + PR.
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
