# habits.yaml 配置参考

`habits.yaml` 是 SoT 的「数据」侧：你用什么运行时管理器、什么包管理器、希望 AI 遵守什么风格与验证步骤、禁止做什么。`profile.yaml` 决定**投影到哪里、怎么投**，`habits.yaml` 决定**投影出去的正文写什么**。规格定义见 [Spec §4.1](../AgentForge-Spec.md#41-habitsyaml)，schema 的唯一事实源是 `src/schema/habits.ts`。

## 文件位置与两层装配

- 用户级：`%USERPROFILE%\.agentforge\habits.yaml`（可用 `AGF_HOME` 改根）
- 项目级：`<项目根>\.agentforge\habits.yaml`

两层都会被加载，按 `profile.yaml` 的 `merge` 声明合并（`overlay` 深合并 / `arrays: append|replace`），再填充 schema 默认值。`runtime` / `tools` / `ai` 三个容器逐键深合并——project 层只写 `runtime.node.manager` 不会抹掉 user 层的 `runtime.python`。

例外是 `detected`：它是**快照型**键，project 层只要存在 `detected` 就整体取 project 的，不做键级合并（`src/core/config/merge.ts:39`）。

YAML 语法错误或校验失败时命令直接失败、列出出错字段路径并给出退出码 2，不会静默降级到默认值。两层都不存在时 `sync` 会要求你先跑 `aforge init`。

## 核心规则：声明字段优先于 detected

`habits.yaml` 里有两类内容：

- **声明字段**（`runtime` / `tools` / `ai` / `notes`）——你手写的意图，是渲染的唯一输入；
- **`detected`**——探测器写下的只读快照，**完全不参与渲染**，只用于 `doctor` 比对和你自己参考。

所以「装了 nvm 但想统一用 fnm」这种情况，写 `runtime.node.manager: fnm` 就行，`doctor` 会报一条 `declared-vs-detected/node` warn 提示两者不一致，但投影正文照你声明的走，不影响退出码。

## 最小可用配置

所有字段都可省，只有 `version: 1` 一行即合法（**完全空文件不行**，YAML 解析成 null 会校验失败）。只声明 `version` 时投影正文只剩标题，因为**字段为空即省略整个小节，模板不会编造默认工具、也不会输出 "Not specified"**。

`aforge init` 写下的骨架就是这样：`version: 1` + 一份 `detected` 快照，声明字段全空，等你填。交互式 `init -i` 的第 ③ 步会提示你优先确认 `runtime.node.manager` / `runtime.python.manager` / `runtime.package_managers` / `tools.shell`。

一份实际有效的配置（Spec §13.1）：

```yaml
version: 1
runtime:
  node:
    manager: fnm
    version: lts
  python:
    manager: uv
  package_managers: [pnpm, bun, npm]
tools:
  shell: powershell
  git:
    conventional_commits: true
ai:
  language: [zh-CN]
  style: 简洁、直接、给出可运行示例
  verification: [typecheck, lint, test]
  forbid:
    - 不要用 npm install 覆盖 pnpm-lock.yaml
    - 不要提交到 main 分支
```

## 顶层字段

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `version` | `1` | `1` | schema 版本，目前只接受 `1` |
| `runtime` | object | `{}` | 运行时与包管理器声明，见下 |
| `tools` | object | `{}` | shell / 编辑器 / git / 容器声明，见下 |
| `ai` | object | `{}` | 对 AI 的风格、验证、禁止项声明，见下 |
| `notes` | string[] | 无 | 自由文本沉淀 → 渲染成 `## Notes` 段。`aforge promote` 的正式落点（追加语义，不会覆盖既有条目） |
| `detected` | object | `{}` | 探测器只读快照，passthrough 不校验内部结构，**不进渲染** |
| `extensions` | object | `{}` | 用户扩展键，passthrough 不校验，**不进渲染** |

顶层未知键会被**静默丢弃**（不是报错），只有 `detected` / `extensions` 两个容器接受任意键。写错顶层字段名不会有提示，只会「配了但没生效」。

## runtime

```yaml
runtime:
  node:
    manager: fnm
    version: '22'
  python:
    manager: uv
    version: '3.12'
  package_managers: [pnpm, bun, npm]
  rust:
    manager: rustup
    toolchain: stable
  go:
    manager: mise
    version: '1.23'
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `node.manager` | `fnm` \| `nvm` \| `asdf` \| `mise` \| `n` \| `volta` \| `system` \| `none` | |
| `node.version` | string | 自由字符串，`lts` / `22` / `22.x` 都行，不做格式校验 |
| `node.notes` | string | 内置模板不渲染，自定义模板可读 |
| `python.manager` | `uv` \| `poetry` \| `pipenv` \| `conda` \| `pyenv` \| `asdf` \| `mise` \| `system` \| `none` | |
| `python.version` / `python.notes` | string | 同 node |
| `package_managers` | `(pnpm\|bun\|npm\|yarn\|yarn-berry)[]` | **按优先级排列**，第一项渲染成加粗首选。内容型数组，参与 `merge.arrays` |
| `rust.manager` | `rustup` \| `system` \| `none` | |
| `rust.toolchain` | string | 如 `stable` / `1.82` |
| `go.manager` | `goenv` \| `asdf` \| `mise` \| `system` \| `none` | |
| `go.version` | string | |

两条渲染语义值得注意：

- **`manager` 是每条 runtime 的开关。** 只写 `node.version` 不写 `node.manager`，这条整体被省略——版本偏好不会单独出现在正文里。
- **`none` 等于「不使用」，不是「用系统自带」。** 声明 `manager: none` 与压根不写效果相同（该条不渲染）；想表达「用 PATH 上的系统版本」写 `system`。

## tools

```yaml
tools:
  shell: pwsh
  editor: vscode
  git:
    conventional_commits: true
    sign_commits: false
    default_branch: main
    notes: PR 合入前 rebase
  container: docker
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `shell` | `powershell` \| `pwsh` \| `cmd` \| `zsh` \| `bash` \| `fish` \| `nushell` \| `other` | |
| `editor` | string | 自由字符串 |
| `git.conventional_commits` | boolean | |
| `git.sign_commits` | boolean | |
| `git.default_branch` | string | |
| `git.notes` | string | |
| `container` | `docker` \| `podman` \| `none` \| `other` | `none` 在渲染视图里归一为「未设置」 |

**整个 `tools` 块内置 `base/default` 模板都不渲染**——它只产出 Toolchain / Style / Verification / Forbidden 四节。这些值确实进了模板变量视图（`src/core/generate/composer.ts:106`），但要让它们出现在投影正文里，得自己写一个模板；见 [规则正文装配](rules.md#templates自定义模板)。或者干脆把这类约定写进 `notes`。

## ai

```yaml
ai:
  language: [zh-CN, en]
  style: 简洁、直接；改动前先读现有代码
  verification: [typecheck, lint, test]
  forbid:
    - 不要用 npm install 覆盖 pnpm-lock.yaml
```

| 字段 | 类型 | 渲染成 | 说明 |
| --- | --- | --- | --- |
| `language` | string[] | —— | 自由字符串（`zh-CN`）。**内置模板不渲染**，同 `tools` |
| `style` | string | `## Style` | 整段原样输出，多行可用 YAML 块标量 `\|` |
| `verification` | `(test\|lint\|typecheck\|build\|format)[]` | `## Verification` | 渲染成 `Before finishing: run typecheck, lint, and test when applicable.`，按数组顺序 |
| `forbid` | string[] | `## Forbidden` | 逐条渲染成列表项 |

`verification` 是**枚举**而非自由文本，写不进 `npm run lint:size` 这种具体命令；具体命令属于项目约定，放 `notes` 或 `custom/*.md`。

## notes 与正文装配顺序

`notes` 是唯一「你写什么就原样出现什么」的字段，渲染成 `## Notes` 段。规则正文四层的装配顺序（`src/core/generate/composer.ts:291`，Spec §5.2）：

```
custom/*.md → ## Learning Protocol → ## Learnings → ## Notes → profile.templates → 内置 base/default
```

即 `notes` 在模板渲染的正文**之前**。`aforge promote` 落下的条目形如 `<id>: <内容>`，追加到数组末尾。各层素材的完整规则见 [规则正文装配](rules.md)。

兼容说明：早期 promote 曾把条目写进 `detected.promote_notes`，渲染层现在会把这个旧键**一并读出来**渲染（正式字段在前）。这是只读兼容，不会自动迁移——`sync` 按约定不回写 SoT。想清理就手工把条目搬到顶层 `notes` 下。

## 谁会改写这个文件

`habits.yaml` 主要靠手写，但有几条命令会回写它。所有回写都经统一的 YAML 序列化，**注释会丢失**——别把重要说明只写在这个文件的注释里。

- `aforge init` / `init -i`：写初始骨架 + `detected` 快照
- `aforge promote`：往 `notes` 追加一条
- `aforge import`：只写 `detected.import`（`source` / `imported_from` / `imported_at` + 命中的 node/python/package_managers），不覆盖声明字段与既有探测快照，也不自动 sync
- `aforge bundle export`：默认剥掉 `detected` 后重新序列化（`--keep-detected` 原文直拷、保注释）
- `aforge detect`：**不写**，纯只读输出探测结果，要更新 `detected` 得自己搬

## detected 快照结构

探测器（`src/core/detector/types.ts:70`）写下的键，供参考与 `doctor` 比对：

```yaml
detected:
  node: { manager: fnm, source: path, version: '22.11.0', path: C:\Users\me\.fnm\fnm.exe }
  python: { manager: uv, source: path }
  package_managers:
    - { name: pnpm, source: package.json }
  shell: pwsh
  existing_rules: [AGENTS.md, CLAUDE.md]
  rust: { manager: rustup, source: path }
  go: { manager: none, source: none }
  java: { manager: sdkman, source: version-file, version: 21.0.2-tem }
  dotnet: { manager: system, source: version-file, version: 8.0.100 }
  monorepo: { manager: turbo, source: config-file }
  ci: { manager: github-actions, source: config-file }
```

`source` 取 `path` / `version-file` / `package.json` / `pyproject` / `config-file` / `env` / `none`。`doctor` 只比对 `node` / `python` 的 `manager`，且 detected 为 `none` 或缺失时不算不一致。

后四类的候选与判据：

- `java`：manager 候选 `sdkman` > `jenv` > `jabba` > `mise` > `asdf`；版本取 `.java-version`，回落 `.sdkmanrc` 的 `java=`。sdkman 的 `sdk` 是 shell 函数、PATH 上没有本体，只能靠 `.sdkmanrc`（→ `version-file`）或 `SDKMAN_DIR`（→ `env`）判定。
- `dotnet`：manager 只有 `system` / `none`（没有第三方版本管理器生态）；版本取 `global.json` 的 `sdk.version`。
- `monorepo`：候选 `nx` > `turbo` > `lerna` > `rush` > `pnpm-workspace`，以配置文件（`nx.json` / `turbo.json` / `lerna.json` / `rush.json` / `pnpm-workspace.yaml`）为主判据、PATH 命中为辅；多工具共存时取优先级首位。
- `ci`：候选 `github-actions` > `gitlab-ci` > `circleci` > `jenkins` > `azure-pipelines`，纯文件/目录判据（`.github/workflows/` 需含至少一个 `.yml` / `.yaml`；其余为 `.gitlab-ci.yml` / `.circleci/config.yml` / `Jenkinsfile` / `azure-pipelines.yml`），不看 PATH。

这四类目前**只出现在 `detected` 里**，声明侧（`runtime.java` 等）尚未定义，故 `habits.schema.json` 不含对应枚举。

## 校验与编辑器提示

- `npm run emit-schema` 生成的 `schemas/habits.schema.json`（JSON Schema Draft 2020-12，`$id: https://agentforge.dev/schema/habits.json`）可挂到编辑器做补全与校验。
- 投影正文的完整示例见 [Spec §13.2](../AgentForge-Spec.md)；四层素材如何拼成正文、以及 `templates/` 与 `custom/` 怎么自定义见 [规则正文装配](rules.md)；投影落点与 marker 行为见 [profile.yaml 配置参考](profile.md)。
