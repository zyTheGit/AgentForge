# AgentForge — Technical Specification (Spec)

| 项 | 内容 |
|----|------|
| 产品名称 | AgentForge |
| CLI | `aforge` |
| 文档版本 | 1.1 |
| 状态 | 会议审核修订 |
| 平台优先级 | **Windows 一等公民** |
| 配套文档 | `AgentForge-PRD.md` |
| 最后更新 | 2026-08-21 |

---

## 1. 系统架构

```
CLI (aforge)
    │
    ▼
Core
  ├── Detector        # 习惯探测
  ├── Profile         # 加载/合并配置
  ├── Generator       # SoT 规则渲染
  ├── Projector[]     # opencode / codex / claude / pi
  ├── SourceManager   # 模板/skill 源（local/git）
  ├── Learning        # 提取/存储/晋升
  └── Doctor          # 一致性与路径诊断

Storage
  ├── Global: %USERPROFILE%\.agentforge  (AGF_HOME 可覆盖)
  └── Project: <repo>\.agentforge
```

### 1.1 技术选型

| 层 | 选择 |
|----|------|
| 语言 | TypeScript |
| 运行时/构建 | Bun（可打包 Windows x64 / 可选 arm64 单文件） |
| 配置 | YAML + JSON Schema 校验 |
| 模板变量 | Handlebars（Mustache 超集，支持 #if/#each 条件渲染） |
| 存储 | 本地文件；无强制 DB |
| 网络 | 默认不需要；仅 source add/update git 时需要 |
| 分发 | npm 包 `@zythegit/agentforge`（命令名 `aforge`，`npx` 主通道，产物为 esbuild 单文件 bundle、依赖已内联）；GitHub Release 的 Windows 单文件 exe 作为免 Node 兜底。版本唯一来源是 git tag |

### 1.2 主闭环

```
Detect/Declare Habits → Profile → Generate Rules (SoT)
  → Project to Agents → (optional) Learn → Promote → Sync
```

---

## 2. 路径与环境

### 2.1 AgentForge 自身

| 用途 | Windows 默认 | 覆盖 |
|------|----------------|------|
| User SoT | `%USERPROFILE%\.agentforge` | `AGF_HOME` |
| Project SoT | `<project>\.agentforge` | — |
| Cache / git store | `%AGF_HOME%\store` 或 `%LOCALAPPDATA%\AgentForge\cache` | — |

- 路径一律规范化为绝对路径。
- Windows 上路径比较采用大小写不敏感。
- 实现使用 `path.join` / `path.resolve`，禁止手写假设只有 `/`。

### 2.1.1 Windows 路径特殊场景

| 场景 | 处理方式 |
|------|----------|
| 长路径（>260 字符） | 启用长路径支持（`\\?\` 前缀或 application manifest 声明） |
| 中文 / Unicode 路径 | 所有文件读写统一 UTF-8（无 BOM）；路径拼接使用 `path.resolve` |
| 空格路径 | 路径拼接一律用 `path.resolve`；Shell 调用时引号包裹 |
| OneDrive 同步目录 | `aforge doctor` 检测 `%USERPROFILE%` 是否在 OneDrive 下，若是则输出 warning |
| 网络驱动器 / UNC 路径 | `AGF_HOME` 不支持 UNC 路径；检测到时报错退出码 1 |

### 2.2 各工具 User 级目录（投影用）

| Target | Windows 默认全局路径 |
|--------|----------------------|
| OpenCode | `%USERPROFILE%\.config\opencode\`（适配器需探测候选目录并在 doctor 中说明） |
| Codex | `%USERPROFILE%\.codex\`（`CODEX_HOME` 可覆盖） |
| Claude Code | `%USERPROFILE%\.claude\` |
| Pi | `%USERPROFILE%\.pi\agent\` |

每个 Projector 实现 `resolveUserDirs(env, os)`；`aforge status` 必须打印实际将写入的绝对路径。

### 2.3 项目级投影路径

| Target | 主规则 | Skills | MCP / 配置 | Commands（§8.8，可选） |
|--------|--------|--------|------------|------------------------|
| opencode | `AGENTS.md` | `.opencode\skills\<name>\SKILL.md` | `opencode.json` 或 `.opencode\opencode.json` | `.opencode\command\<name>.md` |
| codex | `AGENTS.md` | `.agents\skills\<name>\SKILL.md` | `.codex\config.toml` | 项目级不支持（见 §8.8） |
| claude | `CLAUDE.md` | `.claude\skills\<name>\SKILL.md` | `.mcp.json` | `.claude\commands\<name>.md` |
| pi | `AGENTS.md` | `.pi\skills\<name>\SKILL.md` | `.pi\mcp.json`（MVP soft） | `.pi\prompts\<name>.md` |

### 2.4 环境变量

| 变量 | 含义 |
|------|------|
| `AGF_HOME` | 用户级 SoT 根目录 |
| `AGF_SCOPE` | 强制 `user` 或 `project` |
| `AGF_OFFLINE=1` | 禁止网络（git 拉取/更新失败） |
| `AGF_LINE_ENDING` | `lf` 或 `crlf` |
| `CI` | 为真时禁止写入 learnings |
| `CODEX_HOME` | Codex 根目录覆盖 |
| `USERPROFILE` | Windows 用户目录（优先于 `HOME`） |

### 2.5 换行与文件写入

- 默认 `line_ending: lf`（Windows 亦然）。
- 原子写入：临时文件 + rename；处理 Windows 下目标只读属性错误。
- Markdown / JSON / TOML 均按 profile 换行设置写出。

---

## 3. 目录结构

### 3.1 用户级

```
%USERPROFILE%\.agentforge\
  profile.yaml
  habits.yaml
  sources.json
  templates\           # 用户级启用/缓存的模板文件（按需）
  skills\
  mcp\
  custom\
  learnings\
  store\               # git 源缓存
  cache\
  .sync.lock\          # 运行时：sync 排他锁目录（含 meta.json；§10）
  .agf-backup\         # 运行时：sync 事务备份基准 + journal.json（§7.3）
```

### 3.2 项目级

```
<project>\.agentforge\
  profile.yaml
  habits.yaml
  sources.json         # 可选
  templates\
  skills\
  mcp\
  custom\
  learnings\
  rules\               # 可选中间渲染产物
  sync-meta.json
  .sync.lock\          # 运行时：sync 排他锁目录（含 meta.json；§10）
  .agf-backup\         # 运行时：sync 事务备份基准 + journal.json（§7.3）
```

**运行时产物（`.sync.lock` / `.agf-backup`）：** 两者都只在 sync 期间存在，正常结束即删除；进程被强杀会留下残留。`.sync.lock` 是**目录**（非文件），锁语义与陈旧判定见 §10。`.agf-backup\journal.json` 是崩溃恢复日志：记录本次事务已备份/已写入的每个目标路径与来源（SoT / 机器 / 用户），下次 sync 启动时据此回滚被中断的写入；回滚未能全部完成时，备份基准另存为 SoT 根下的 `.agf-backup-failed-<时间戳>\` 并退出码 6（§6.1），不自动清理。**这三项属于本机运行时状态，不应提交版本库**——`projection.gitignore_generated=true` 且 effective scope 为 `project` 时，标记段除投影产物外还会写入 `.sync.lock/`、`.agf-backup/`、`.agf-backup-failed-*/` 三条根锚定目录模式（SoT 根落在项目根之外时不写，判据与投影产物共用）。`doctor` 的 `consistency` 段会诊断残留：锁被持有中报 `ok`（另一个 sync 正在写，不提示删除）；心跳停摆超过陈旧阈值报 `warn` 并给出清理提示；`committed != true` 的 journal 报 `warn` 并说明下次 sync 会崩溃恢复；`.agf-backup-failed-*` 报 `warn`，提示**先与当前投影逐一核对再自行删除**——doctor 只读，绝不销毁这份唯一副本。

### 3.3 sync-meta.json

```json
{
  "version": 1,
  "lastSyncAt": "ISO-8601 datetime",
  "os": "win32 | darwin | linux",
  "agentforgeVersion": "string",
  "targets": {
    "<targetId>": {
      "contentHash": "sha256 hex",
      "writtenAt": "ISO-8601 datetime"
    }
  },
  "artifacts": [
    { "path": "绝对路径", "contentHash": "sha256 hex", "targetId": "<targetId>" }
  ],
  "mcpServers": ["<serverName>"]
}
```

- 用户级与项目级 SoT 均包含 `sync-meta.json`。
- `doctor` 通过比较 `contentHash` 与当前 SoT 渲染结果的 hash 来判断投影一致性。
- `artifacts` / `mcpServers` 是 §7.6 prune 的删除白名单：前者记上一轮实际落盘的**整文件产物**（`write` 动作项，如各 target 的 `skills\<name>\SKILL.md`），后者记上一轮投影进各 MCP 配置的 server 名。两者**可选**：字段缺席（旧版本写的记录）与「记录为空数组」语义不同——缺席时该轮只记账、不清理。

### 3.4 发行包内置

```
<install>\templates\
  base\
    default.md         # 极薄骨架，只读
```

---

## 4. 配置 Schema

配置文件为 YAML；校验时转换为 JSON，按 JSON Schema Draft 2020-12 验证。  
命名空间：`https://agentforge.dev/schema/`（实现可本地加载）。

### 4.1 habits.yaml

```yaml
version: 1
runtime:
  node:
    manager: fnm | nvm | asdf | mise | n | volta | system | none
    version: string
    notes: string
  python:
    manager: uv | poetry | pipenv | conda | pyenv | asdf | mise | system | none
    version: string
    notes: string
  package_managers: [pnpm, bun, npm, yarn, yarn-berry]  # 优先级
  rust:
    toolchain: string
    manager: rustup | system | none
  go:
    version: string
    manager: goenv | asdf | mise | system | none
tools:
  shell: powershell | pwsh | cmd | zsh | bash | fish | nushell | other
  editor: string
  git:
    conventional_commits: boolean
    sign_commits: boolean
    default_branch: string
    notes: string
  container: docker | podman | none | other
ai:
  language: [string]
  style: string
  verification: [test, lint, typecheck, build, format]
  forbid: [string]
notes: [string]           # 自由文本沉淀（promote habits_note 的落点，渲染为 ## Notes 段）
detected: object          # 探测器只读快照
extensions: object        # 用户扩展键
```

**规则：** 声明字段优先于 `detected`。生成规则时不得在模板中硬编码个人工具名，只能通过变量注入。

**`notes`：** `aforge promote <id>` 在 `promote_target: habits_note` 时追加到此数组（§7.5），投影时渲染成 `## Notes` 段，紧随 `## Learnings` 之后。属内容型数组，两层合并走 `merge.arrays`（§4.2）。早期版本曾写 `detected.promote_notes` 自由键且渲染层不消费（等于 promote 完永远进不了投影）；现在正式落点是 `notes`，旧键只做**读兼容**（一并渲染）而不自动搬迁——迁移是显式动作，把旧键内容挪进 `notes` 后该兼容分支自然失效。

### 4.2 profile.yaml

```yaml
version: 1
scope: user | project
targets: [opencode, codex, claude, pi]   # 至少一项
templates: [base/default, ...]           # 模板 id 列表
mcp:
  servers:
    - name: string
      enabled: boolean
      transport: stdio | http | sse
      command: string
      args: [string]
      env: { string: string }
      url: string
      headers: { string: string }
skills:
  always: [string]
  on_demand: [string]
  copy_mode: copy | symlink              # Windows 默认 copy
  expose_as_command: [string]            # 额外投影成命令/prompt 的技能名（§8.8，缺省空）
merge:
  strategy: overlay | replace
  arrays: append | replace
projection:
  write_agents_md: boolean
  write_claude_md: boolean
  marker_mode: none | append_below_marker | replace_between_markers
  marker_begin: "<!-- BEGIN AGENTFORGE -->"
  marker_end: "<!-- END AGENTFORGE -->"
  line_ending: lf | crlf
  path_style: auto | windows | posix
  gitignore_generated: boolean
learning:
  default_scope: project | user
  auto_capture: off | prompt | hook      # 缺省 off（§7.4）
  auto_promote: false
  include_promoted_in_sync: true
extensions: object
```

**合并策略语义：**

`merge.strategy` 控制 user 级与 project 级 profile/habits 的合并行为：

- `overlay`（默认）：project 级字段覆盖 user 级同名字段（深合并）。未定义的字段继承 user 级值。
- `replace`：project 级 profile 完全替代 user 级 profile（浅替换）。

`merge.arrays` 控制数组合并行为：

- `append`：project 数组追加到 user 数组末尾。
- `replace`（默认）：project 数组完全替代 user 数组。

示例：user 级 `targets: [opencode, codex]`，project 级 `targets: [claude]`：
- `overlay` → 最终 `targets: [claude]`（project 覆盖 user）
- `replace` → 最终 `targets: [claude]`（同上，此字段行为一致）

示例：user 级 `ai.verification: [test, lint]`，project 级 `ai.verification: [typecheck]`：
- `arrays: append` → 最终 `[test, lint, typecheck]`
- `arrays: replace` → 最终 `[typecheck]`

`projection.path_style` 控制投影文件中出现的路径格式：`auto` 根据当前 OS 自动选择；`windows` 强制使用 `\` 分隔符和 `%USERPROFILE%` 变量；`posix` 强制使用 `/` 分隔符和 `$HOME` 变量。归一化只作用于被识别为路径 token 的片段（以 `%USERPROFILE%` / `$HOME` / `${HOME}` / `~` / 盘符开头且后接分隔符），散文中的斜杠（如 `pnpm/bun`）不受影响；`.gitignore` 的条目恒用 `/`，与本项无关。

**`projection.marker_mode` 语义：**

- `replace_between_markers`（默认）：替换 marker 区间内容，区间外的用户内容原样保留；区间被手工改动时 `sync` 报 ConflictError(3)（§8.2-4）。
- `append_below_marker`：新正文插入在 `marker_begin` 之后，原区间内容保留在其下方；同一正文已存在时跳过追加，保证重复 `sync` 幂等（区间不会无界增长）。
- `none`：不使用 marker 包裹，主规则项降级为整文件 `write`（marker 外的手写内容会被覆盖，冲突预检查与 `--force` 对该模式无意义）。

**`projection.write_agents_md` / `write_claude_md`：** 控制主规则文件是否投影，与 §8.7 矩阵配合——`write_agents_md: false` 时 opencode / codex / pi 不再写根 `AGENTS.md`；`write_claude_md: false` 时 claude 不再写 `CLAUDE.md`；`write_claude_md: true` 额外启用 opencode 的可选 `CLAUDE.md`（矩阵中标注"可选"的那一项）。两项缺省时保持既有行为。

**`projection.gitignore_generated`：** `true` 且 effective scope 为 `project` 时，`sync` 成功后把全部落在项目根内的投影产物写入项目 `.gitignore`，包在 `# BEGIN AGENTFORGE` / `# END AGENTFORGE` 标记段内（`.gitignore` 不支持 HTML 注释，故不复用 `marker_begin/end`）；段外用户条目原样保留，段内每次全量重算 → 幂等。项目根之外的产物（user scope 投影、`CODEX_HOME` 覆盖）不写入。该写入与投影产物同属一个事务（同一 `.sync.lock` + 备份/回滚），失败按硬项处理；不计入 `sync-meta.targets`。

**`skills.copy_mode`（MVP 决定）：** `symlink` 属 Phase 2（§12）——schema 仍接受该取值（避免既有 profile 直接加载失败），但 MVP **忽略它、恒为实体 copy**：`skill add` 与四个 projector 都只做实体拷贝。声明 `symlink` 时 `aforge doctor` 报 `skills-copy-mode` warn（仅提示，不影响退出码与投影结果），改回 `copy` 即可消除该告警。

**`skills.on_demand`（MVP 决定）：** 只登记不物化——`sync` 仅投影 `skills.always`；`on_demand` 清单由 `aforge status` 展示并标注"declared only - not projected in MVP"。按需装载属 Phase 2。

**`skills.always` 的维护方：** 除手写外，`aforge skill add` 会把装入的技能名自动登记进**同一层** `profile.yaml` 的 `skills.always`（幂等，`--no-register` 关闭，见 §7.6）；`aforge skill remove <name>` 是其逆操作，只把名字从**同一层**的 `skills.always` 摘掉（profile-only：`skills\<name>\` 目录与已投影产物都不动，见 §7.6）。两者的回写都会重排整份 `profile.yaml` 的格式并丢弃注释（§7.6"写 `profile.yaml` 的副作用"）。

**`skills.expose_as_command`（缺省空数组）：** 列出的技能名在 skill 投影之外**额外**投影一份命令/prompt 薄壳（落点与语义见 §8.8）。名单是 `skills.always` 的子集——点了名却不在 `skills.always` 里 → `sync` 报退出码 2（与"`skills.always` 点名却没装"同一口径）。默认空的理由见 §8.8：四个 target 都已把技能本身暴露成用户可调用入口，这份薄壳只为"强制调用"与"位置参数"两个额外能力存在。

**`learning.auto_capture`（缺省 `off`）：** 控制"由谁触发 `aforge learn`"，三档语义见 §7.4。`off` 时行为与现状完全一致（只有人工敲命令）。该项与 `auto_promote` 正交：`auto_capture` 决定条目怎么产生，`auto_promote` 决定条目产生后是否顺手 promote，两者都为真时仍不投影（§7.4）。

**Windows 安装默认值：**

```yaml
version: 1
scope: project
targets: [opencode, codex, claude, pi]
templates: [base/default]
skills:
  copy_mode: copy
projection:
  marker_mode: replace_between_markers
  line_ending: lf
learning:
  default_scope: project
  auto_capture: off
  auto_promote: false
```

### 4.3 learning（单条）

```yaml
id: string                 # ^[a-z0-9][a-z0-9_-]{1,63}$
scope: project | user
confidence: number         # 0–1
trigger: string
content: string
category: tooling | code-style | architecture | debugging | process | security | other
source: string
created_at: datetime
updated_at: datetime
promoted: boolean
promoted_at: datetime | null
promote_target: custom_rule | skill | habits_note
```

文件名不得包含 Windows 非法字符：`<>:"/\|?*`。

**字段的投影口径：** `content` 与 `trigger` 进投影——`trigger` 非空时在该条正文前渲染一行 `**When:** <trigger>`（§5.2 第 ② 层的 `## Learnings` 段内）。`confidence` 与 `category` 是**管理维度**，供 `aforge learnings list` 展示与人工判断，不参与投影，也不做阈值过滤。

### 4.4 sources.json

```json
{
  "version": 1,
  "sources": [
    {
      "id": "string",
      "type": "local | git",
      "path": "string",
      "url": "string",
      "ref": "string",
      "commit": "string",
      "enabled": true,
      "kind": ["templates", "skills", "mcp"]
    }
  ]
}
```

- `git` 源应记录 `commit`；默认要求显式 `--ref`。
- `AGF_OFFLINE=1` 时禁止 `source add git` 与 `source update`。
- `local` 类型使用 `path` 字段，`git` 类型使用 `url`/`ref`/`commit` 字段。两种类型的字段互斥，schema 通过 `oneOf` 约束。

### 4.5 外部模板包布局

```
<template-root>/
  manifest.yaml
  templates/...
  skills/<name>/SKILL.md
  mcp/...
```

```yaml
# manifest.yaml
name: string
version: string
min_agentforge: 1
templates:
  - id: tools/modern-js
    path: templates/tools/modern-js.md
    description: string
skills: []
mcp: []
```

---

## 5. 模板与合并

### 5.1 内置 base/default

- 仅章节结构 + 变量占位。
- 变量示例：`{{runtime.node.manager}}`、`{{runtime.python.manager}}`、`{{runtime.package_managers}}`、`{{ai.style}}`、`{{ai.verification}}`、`{{ai.forbid}}`。
- 字段为空时：省略小节或输出 “Not specified”，**禁止编造**默认工具。

### 5.2 规则正文合并优先级（高 → 低）

1. `custom/*.md`
2. 已 promote 的 learnings 注入段
3. `profile.templates` 中已解析模板（列表顺序）
4. 内置 `base/default`

未解析的 template id → sync 失败，退出码 2。

`learning.auto_capture: prompt`（§7.4）时，在第 ② 层之前额外插入一段固定的 `## Learning Protocol`，位置固定、内容不受 SoT 影响；它随 marker 区间整体替换，不产生独立产物、不进 §3.3 记账。`off` / `hook` 两档不插入该段。

### 5.3 Skill 同名优先级

项目 SoT > 用户 SoT > 源 store（安装时已 copy，以 SoT 为准）。

**与 `skills.always` 合并的交互**：`merge.arrays: replace`（缺省）下 project 层的 `skills.always` 整体覆盖 user 层。因此把 project 层 `always` 里最后一个名字 `aforge skill remove` 掉之后，该数组变为空数组 `[]`——它仍然**参与并覆盖**合并，user 层的同名 skill 不会因此重新生效；要让 user 层重新生效，需从 project 层 `profile.yaml` 里删掉整个 `skills.always` 键（手工编辑）。

### 5.4 Handlebars 模板规则

- 使用 Handlebars（Mustache 超集），支持 `#if`、`#each`、`#unless` 等条件/遍历语法。
- 变量为空时的行为：**省略该小节**（通过 `#if variable.../if` 包裹），不输出 "Not specified"。
- 禁止在模板中注册或使用自定义 helpers——模板仅使用内置 helpers 和变量。
- 外部模板（git 源）中的 Handlebars 表达式在渲染前进行语法校验，非法表达式 → sync 失败退出码 2。

---

## 6. CLI

| 命令 | 说明 |
|------|------|
| `aforge init [--scope user\|project] [-i]` | 初始化 |
| `aforge detect` | 仅探测 |
| `aforge sync [--targets ...] [--dry-run]` | 渲染并投影 |
| `aforge learn [--scope project\|user]` | 学习提取 |
| `aforge promote <id> [--to user]` | 晋升 |
| `aforge learnings list\|show\|edit\|rm` | 管理 learnings |
| `aforge source add\|list\|remove\|update` | 模板/skill 源 |
| `aforge template list\|enable\|disable` | 模板 |
| `aforge skill add [--from <源名\|路径>] [--no-register]\|list\|remove <name> [--scope project\|user]` | Skill（`add` 默认登记进 `skills.always`，`--no-register` 关闭；`remove` **只**摘 `skills.always`，磁盘目录保留，见 §7.6） |
| `aforge mcp add\|remove <name> [--scope project\|user]` | MCP 描述加入 / 移出 SoT（`add` 交互录入，或 `--from-json` 从 stdin 读 JSON 声明；`remove` 从目标层 `mcp.servers` 摘掉该名字，不存在 → 退出码 2） |
| `aforge status` | 状态与路径（含各 target 的技能调用前缀：codex 为 `$<name>`，其余为 `/<name>`，见 §8.8） |
| `aforge doctor` | 诊断 |
| `aforge import <path>` | 导入现有规则（MVP 基础版） |

### 6.1 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 1 | 通用错误（含部分投影失败回滚） |
| 2 | 配置/校验错误（含 learning id 不存在、sources.json 损坏、init 目录非空、模板语法错误） |
| 3 | 投影冲突需人工处理（含 marker 区间被手动修改、promote 目标文件名冲突） |
| 4 | 目标路径无写权限（Windows 常见） |
| 5 | 离线模式禁止操作（AGF_OFFLINE=1 时触发网络操作） |
| 6 | 回滚不完整：sync 失败后回滚未能恢复全部已写文件，备份基准被保留到 `<sotRoot>\.agf-backup-failed-<时间戳>\` 并列入失败汇总（比 1 更严重：磁盘上仍有非预期内容） |
| 130 | 被中断：交互提示被取消（Ctrl-C / Esc）或进程收到 SIGINT / SIGTERM；进行中的 sync 事务先同步回滚再退出（130 = 128 + SIGINT） |

"init 目录非空"的判定：SoT 根（`<root>/.agentforge`）已存在且目录内有任何条目即触发——包含"已初始化"（存在 `profile.yaml`）与"半初始化"（只手工建了 `custom/` 等子目录）两种情形，两者错误措辞不同以便定位。

### 6.2 全局标志

- `--json`：机器可读输出（路径为绝对路径字符串）。注册在 program 级，`aforge --json <cmd>` 与 `aforge <cmd> --json` 等价（各子命令同时保留自己的 `--json` 以兼容既有用法）。
  - 覆盖命令（当前实际）：`init`、`sync`、`status`、`doctor`、`detect`、`learn`、`learnings list|show|edit|rm`、`promote`、`import`、`source add|list|remove|update`、`template list|enable|disable`、`skill add|list|remove`、`mcp add|remove`。
  - `learnings show|edit` 的 JSON 体在条目字段之外另带 `scope`、`file` 与 `content`（条目 YAML 原文）；`learnings rm` 为 `{ id, file, scope }`。
  - `mcp add` 的**输入**标志为 `--from-json`（从 stdin 读 JSON 声明）；`--json` 在该命令下与全局契约一致，表示机器可读**输出**。


---

## 7. 核心流程

### 7.1 Init

1. 确定 scope 与根目录。
2. Detector 运行 → 候选 habits（写入 `detected`，交互可确认到声明字段）。
3. 写入默认 `habits.yaml`、`profile.yaml`（Windows：`copy_mode=copy`，`line_ending=lf`）。
4. 可选执行一次 sync。
5. 打印各 target 绝对路径。

### 7.1.1 Init 交互流程（-i 模式）

1. **Scope 选择**：默认 project，可选 user。
2. **Detector 运行**：打印探测结果（Node manager、Python manager、包管理器、Shell、已有规则文件）。
3. **确认探测结果**：Y（确认）/ n（重新探测）/ edit（打开 habits.yaml 编辑器手动修改）。
4. **目标 Agent 选择**：默认全选四个 target，空格切换，显示各 target 将写入的绝对路径。
5. **写入确认**：显示将创建/修改的文件列表，Y 确认 / n 取消。
6. **可选立即 sync**：Y（立即执行 sync）/ n（稍后手动执行）。

默认路径 ≤ 5 次确认（scope → 探测确认 → target 选择 → 写入确认 → sync）。

### 7.2 Detect（Windows 顺序）

1. 已有 `habits.yaml` 声明（生成时优先）。
2. `where.exe` / PATHEXT 探测 fnm、uv 等。
3. 版本文件：`.node-version`、`.python-version`、`package.json#packageManager`、`pyproject.toml`。
4. 现有 `AGENTS.md`、`CLAUDE.md`。
5. Shell 启发式（PowerShell / cmd 等）写入 `detected`。

### 7.3 Sync

1. 合并 user + project 的 profile/habits。
2. 解析 templates，注入变量，合并 custom 与 promoted learnings。
3. 得到统一 `renderedRulesMd`。
4. 对每个 target：`plan` → `apply`。
5. 写入 `sync-meta.json`（时间、os、targets、content hash）。
6. **全部回滚策略**：Sync 采用事务性写入。所有 target 先 plan 生成写入计划，逐一 apply 时若任一 target 失败，则回滚所有已写入的 target（恢复为 sync 前状态），输出失败汇总报告。退出码取失败 target 中最高严重度。
7. **目录自动创建**：若目标目录不存在，自动创建（mkdir -p 语义）；创建失败（权限不足）→ 退出码 4。
8. **可选 `.gitignore` 写入**：`projection.gitignore_generated: true` 且 scope=project 时，在全部 target 成功后（写 `sync-meta.json` 前）把项目内投影产物写入 `.gitignore` 标记段——同一事务、同一回滚（详见 §4.2）。

### 7.4 Learn

1. 输入：粘贴摘要 / 文件 / stdin。
2. 结构化为 learning 条目。
3. 写入 `learnings/`，**不**自动进入投影。
4. 提示可 `promote`。

写入层由 scope 决定，优先级：`--scope` > `profile.learning.default_scope`（§4.2，缺省 `project`）。

**`learning.auto_promote`（§4.2，缺省 `false`）**：为真时第 3 步落盘后立刻在同一次命令内跑一遍 §7.5 promote（产物写入条目所在层，等价于不带 `--to` 的 `aforge promote <id>`），第 4 步的提示改为提示 `aforge sync`。三点边界：

- **仍不投影**：promote 只写 SoT 的 `custom/` 或 `skills/`，进 agent 侧投影依旧要 `aforge sync`——第 3 条"不自动进入投影"不受影响；
- **不回滚 learn**：promote 失败（目标文件已存在 → 3 / 无写权限 → 4）时条目**保留**且仍为 `promoted: false`，命令先打印 `learning created` 再按 promote 的退出码失败，用户处理掉冲突后 `aforge promote <id>` 续跑即可；
- `aforge learn --no-auto-promote` 单次关掉（不改配置）。

**`learning.auto_capture`（§4.2，缺省 `off`）**：决定第 1 步的输入由谁触发。三档：

| 取值 | 触发方式 | 确定性 | 新增机制 |
|------|----------|--------|----------|
| `off` | 只有人工敲 `aforge learn` | — | 无 |
| `prompt` | 渲染正文里多一段 learning protocol，指示 agent 自行调用 `aforge learn --file -` | 概率性（模型可能不执行） | 无（复用 §5.2 正文合并） |
| `hook` | 由 target 侧会话钩子在结束时调用抽取器 → `aforge learn` | 确定性 | 每个 target 一套钩子适配 |

`prompt` 档的实现口径：在 §5.2 第 ② 层（`## Learnings` 段）之前插入一段固定的 `## Learning Protocol`，内容含触发条件与可复制的命令行，随 marker 区间整体替换，因此不新增产物、不新增记账。

`hook` 档的落点与限制：

- claude → `settings.json` 的 `hooks`（`SessionEnd` / `Stop`）；codex → `config.toml` 的钩子段（上游事件含 `SessionStart` / `SessionEnd` / `UserPromptSubmit` / `SubagentStart` / `SubagentStop` / `Stop`）。这两家可落地；
- opencode 需 plugin、pi 需 extension，两者都要求在 target 侧先装扩展，MVP 内按 **soft** 处理（不写、只在 `aforge status` 标注 "hook not supported - install adapter"），与 §8.6 pi MCP 的 soft 口径一致；
- **claude 的 `settings.json` 可能存有明文凭据**（`env.ANTHROPIC_AUTH_TOKEN` 等）。写入必须走 §8.2 的 `merge_json`（未知键一律保留），且失败信息与 `--json` 输出**不得回显文件内容**，只报路径与键名。

四条护栏（三档共用）：

1. **只写 SoT，绝不自动 sync**：非 dry-run 的 `sync` 要取 `.sync.lock`（§11），会话中途触发会与人工 `sync` 撞锁，且 marker 指纹校验可能直接判 3。`auto_capture` 的终点是 `learnings/` 落盘（`auto_promote` 为真时再多一步 promote），进投影恒由人工 `aforge sync`；
2. **不隐含晋升**：`auto_capture` 不改变 `auto_promote` 的缺省 `false`；
3. **CI 禁写**：沿用 §11「不在 CI 中写入 learnings」——`CI` 为真时任何档位都不得产生 `learnings/` 写入，且不算错误（静默跳过，`status` 里标注原因）。**约束对象是写入，不是渲染**：`prompt` 档的 `## Learning Protocol` 段在 CI 下照样渲染，否则同一份 SoT 在 CI 与本机会产出不同的 marker 区间（`contentHash` 不同），§9 的 hash 比对与 §3.3 记账都会跨环境失真；
4. **不落原始会话记录**：抽取器只允许写结构化的 `content` / `trigger`，禁止把 transcript 原文塞进条目（凭据泄漏面 + 条目体积）。


### 7.5 Promote

1. 校验 id。
2. 写入 `custom/`、`skills/` 或 `habits.yaml` 的 `notes`（按 `promote_target`，§4.1）。
3. 标记 `promoted: true`。
4. 可选立即 sync。

- promote 后 learning 条目保留（标记 `promoted: true`），不自动删除。
- learning id 由系统自动生成（符合 §4.3 正则），用户可通过 `aforge learn` 交互时自定义。
- 重复 learn 相同内容时创建新条目，但输出 warning 提示可能存在重复。

### 7.6 Source / Skill 安装（Windows）

| 操作 | 行为 |
|------|------|
| source add local | 登记路径 |
| source add git | clone 到 store，检出 pin，记录 commit |
| skill add | **copy** 到 SoT skills 目录 + 登记进目标层 `profile.yaml` 的 `skills.always`（幂等，`--no-register` 关闭） |
| skill remove | **只**从目标层 `profile.yaml` 的 `skills.always` 摘掉该名字（profile-only）；`skills\<name>\` **保留在磁盘上**，要重装先手工删目录（否则 `skill add` 撞「目标已存在」→ 退出码 3）；各 target 已投影的 `skills\<name>\SKILL.md` 由下一次 `sync` 清理（见下「prune」）。该层未登记该名字 → 退出码 2 |
| template enable | 只改 profile.templates |
| 默认 | 不使用 symlink |

**写 `profile.yaml` 的副作用**：`skill add`、`skill remove`、`mcp add`、`mcp remove`、`template enable` 均经 `editProfile` 回写整份文档（`stringifyYaml(整个对象)`），YAML 注释、空行与行内数组风格（`targets: [claude]`）会丢失，键顺序变为对象插入顺序。手写的 `profile.yaml` 在被这些命令改过后需按重排后的形态阅读。

**prune：上一轮投影产物的差集清理。** 两条 remove 都**只改 SoT**，投影侧的清理由**下一次 `aforge sync`** 完成：在全部 target 落定之后、写 `sync-meta.json` 之前，按上一轮记账（`sync-meta.json` 的 `artifacts` / `mcpServers`，见 §3.3）算差集：

- `skill remove <name>` 后，各 target 目录下的 `skills\<name>\SKILL.md`（`.claude` / `.opencode` / `.agents` / `.pi`）被**删除**——它们是 `write` 动作产出的整文件产物，整份归 AgentForge 所有；
- `mcp remove <name>` 后，`opencode.json` / `.mcp.json` / `.pi\mcp.json` 里那条 server 键被**摘除**（文件本身与其余键保留）。这不违背 §8.2「未知键一律保留」：摘的只是记账里认领过的键；codex 的 `.codex\config.toml` 走 marker 段整段重写，本来就不残留。

三条硬约束：

1. **只删记账里有的东西**：删除白名单来自上一轮记账，不扫描目录、不按通配符猜产物——用户自己放在 `.claude\skills\` 下的文件永不被碰；
2. **改过的不删**：删文件前比对当前内容 hash 与记账值，不等则跳过并报进 `prune skipped`（人类输出与 `--json` 都有），不影响退出码。宁可残留，也不静默吞掉手工编辑；
3. **子集 sync 只管本次的 target**：`--targets claude` 不清理 opencode 的产物，未参与 target 的记账原样保留。

`artifacts` / `mcpServers` 字段缺席（旧版本写的 `sync-meta.json`）→ 该轮只记账不删，升级不会误删既有产物。`--dry-run` 不报 prune 候选（差集要在本轮产物落定后才成立）。清理在同一 `.sync.lock` 事务内执行，删除前先进备份，中途被强杀由下次 sync 按 journal 还原；删空的目录不回收。

### 7.7 Import（MVP 基础版）

1. 接收 `<path>` 参数，验证文件存在且可读。
2. 识别文件类型（AGENTS.md / CLAUDE.md）。
3. 解析文件内容：
   - 按 `##` 标题分块提取章节。
   - 识别已知工具链模式（如 "fnm"、"uv"、"pnpm"、"nvm" 等关键词）。
4. 生成映射：
   - 工具链声明 → `habits.yaml` 的 `detected` 字段（标记为 suggested，需用户确认）。
   - 风格/规范/其他声明 → `custom/imported-<timestamp>.md`。
5. 写入 SoT，打印映射摘要，提示用户检查 `habits.yaml`。
6. 不自动 sync，提示用户执行 `aforge sync`。
7. 如果导入文件包含 AgentForge marker 区间，跳过 marker 区间内容。

### 7.8 Offline 降级矩阵

| 命令 | AGF_OFFLINE=1 行为 |
|------|-------------------|
| `init` | 正常执行（仅用内置模板 + 本地 habits） |
| `detect` | 正常执行（本地探测） |
| `sync` | 正常执行（仅用已安装/已缓存内容） |
| `learn` | 正常执行（纯本地操作） |
| `promote` | 正常执行（纯本地操作） |
| `source add git` | **失败**，退出码 5 |
| `source add local` | 正常执行（纯本地操作） |
| `source update` | **失败**，退出码 5 |
| `template enable` | 正常执行（仅改 profile） |
| `skill add` | 正常执行（从已缓存内容 copy） |
| `import` | 正常执行（纯本地操作） |
| `bundle export` | 正常执行（纯本地操作） |
| `bundle import` | 正常执行（纯本地操作） |
| `doctor` | 正常执行（本地诊断） |

### 7.9 Bundle Export / Import（SoT 迁移）

把**一层** SoT 打成可搬走的目录再落回另一层。与 §7.7 的 `import <path>`（从既有 AGENTS.md 抽工具链声明）是两条命令，语义不同，刻意分开命名。

**产物布局**：`<out>\manifest.json`（自描述清单，schema 见 §4）+ `<out>\sot\...`（内容副本，路径与 SoT 内一一对应）。内容放在 `sot\` 子目录而非平铺，是为了让 manifest 与 SoT 里可能的同名文件不争位，且 import 侧能用整棵 `sot\` 树比对出「manifest 未登记的多余文件」。

**Export 流程**

1. 解析目标层（缺省按有效 scope，要求该层已 init，否则退出码 2）；守卫 `--out`：不得位于 SoT 内（2）、不得非空（3）。
2. 顶层条目按名字分三类，**只看名字，名字即契约**：
   - 带走：`habits.yaml` / `profile.yaml` / `sources.json` + `custom\` / `learnings\` / `templates\` / `skills\` / `mcp\`；
   - 剔除并记入 `manifest.excluded`：`sync-meta.json`（`machine-state`）、`.sync.lock` 与 `.agf-backup*`（`transient`）、`store\`（`cache`）；
   - 其余：报 `not-part-of-sot`，**既不带走也不静默丢弃**。
3. 净化（只改内存里的解析对象，原 SoT 一字不动）：`habits.detected` 剔除（`--keep-detected` 保留）；`profile.mcp.servers[].env` / `.headers` 的**值**换成占位符，字段路径记入 `manifest.redacted`（`--no-redact` 原样导出）。被改写的文件在 manifest 里标 `transformed: true`。
4. 落盘并逐个记 sha256（LF 规范化后计算，见 §3.3 同一规范），bundle 常经 git / 压缩包 / 网盘搬运，CRLF 被改写不该判成内容损坏。
5. **symlink 一律不跟随**：遍历中遇到的 symlink 与目录环路记入 `skipped` 并产出 warning；顶层带走目录**自身**是 symlink 时同样跳过（否则链接目标整棵会被打进 bundle 搬到别的机器）。
6. 非事务：写到一半失败会留下半个 bundle 目录。它是可丢弃产物（不是 SoT、不是投影），删掉重跑即可。

**Import 流程（先全量校验，再一次性落盘）**

1. 读 `manifest.json`：缺失 / 损坏 / schema 校验失败 → 2。
2. 逐条校验 `files[].path`，两道守卫都针对**不可信** manifest（它是可手工编辑的普通文件，路径直接参与 `path.join`）：
   - 形态：拒绝空段、`.`、`..`、绝对路径（含盘符与 UNC）；
   - 布局：首段必须属于第 2 步的「带走」集合，且文件 / 目录角色不错位。被 export 剔除的条目**不接受反向导入**——`sync-meta.json` 记着另一台机器的绝对路径与 §7.6 prune 删除白名单，导进去会让下一次 sync 照着别人的账删本机文件。
3. 逐个比对 sha256。问题一次性收集完再抛（坏包往往不止一处），任一条不通过 → 2 且**一个字节都没写**。
4. 目标层不要求已 init（迁移的典型场景就是新机器上什么都没有），SoT 目录按需创建。若先 init 再 import，骨架 `profile.yaml` 会让 `skip` 策略把 bundle 里那份真配置挡在门外，那是更坏的默认。
5. 持 SoT 事务锁（与 sync 同一把 `.sync.lock`）后、写第一个字节之前，再确认 `sotRoot` 到每个目标文件之间的每一段都不是 symlink，否则 → 2（与 export 的不跟随口径对称：目标磁盘上已有的 symlink 会让合法相对路径穿透写到链接目标）。
6. 冲突策略（目标已存在同名文件）：缺省 `skip`（不动既有文件）；`overwrite` 替换；`rename` 把**来料**另存为 `<name>.imported`（被占用则 `.imported-2`…，上限 100 个后缀，耗尽 → 3）。`--on-conflict` 取值非法 → 2，绝不静默退化成 `skip`。
7. manifest 未登记但存在于 `sot\` 的文件不导入，报进 `unlisted` 供核对。
8. **不自动 sync**：填 SoT 与写别人的文件是两件风险等级不同的事，只提示下一步 `aforge detect && aforge sync`。
9. 非事务：写入阶段失败（磁盘满 / 权限）会留下部分文件。校验前置已排掉「内容不对」这类可预见失败，重跑同一条命令即可续写。

**已知取舍**：`habits.yaml` / `profile.yaml` 经「解析 → 改写 → 重新序列化」往返，**YAML 注释会丢**（同 §7.6 `skill add` 写 profile 的代价）；`--no-redact --keep-detected` 时两份走原文直拷，注释保留。内容一律按 UTF-8 文本处理（同 §7.6 skill copy 约定），二进制附属文件不在支持范围内。redact 只覆盖 §4.2 约定承载密钥的 `env` / `headers` 两处，`command` / `args` / `url` 里的内联凭据形状不可知、不做猜测抹除，改为在 warnings 里提示人工复核。

---

## 8. Projector 规格

### 8.1 接口

```ts
interface ProjectContext {
  os: "win32" | "darwin" | "linux";
  scope: "user" | "project";
  rootDir: string;
  renderedRulesMd: string;
  habits: Habits;
  profile: Profile;
  skillsToMaterialize: SkillArtifact[];
  mcpServers: McpServer[];
  dryRun: boolean;
  lineEnding: "\n" | "\r\n";
}

interface Projector {
  id: "opencode" | "codex" | "claude" | "pi";
  plan(ctx: ProjectContext): ProjectionPlan;
  apply(plan: ProjectionPlan): Promise<ApplyResult>;
}
```

`ProjectionPlan` 项：`path`、`action: write | merge_marker | merge_json | merge_toml`、`content`。

### 8.2 共用规则

- **同一 SoT 渲染一次 Markdown**，分发到 AGENTS.md / CLAUDE.md，避免文案漂移。
- Marker 默认 `replace_between_markers`；marker 外用户内容不得删除。
- JSON/TOML 合并只改 AgentForge 管理的键或标记段；未知键保留。
- **Marker 区间修改检测**：sync 前检查 marker 区间 content hash 与 sync-meta.json 中记录的 hash 是否一致。不一致时退出码 3，提示 "marker 区间可能被手动修改，请执行 `aforge doctor` 查看详情"。用户可通过 `--force` 标志强制覆盖（跳过检查）。

### 8.3 OpenCode

| 角色 | Project | User |
|------|---------|------|
| 主规则 | `AGENTS.md` | `%USERPROFILE%\.config\opencode\AGENTS.md` |
| Skills | `.opencode\skills\<name>\SKILL.md` | 全局 skills 目录 |
| Commands（§8.8） | `.opencode\command\<name>.md` | `%USERPROFILE%\.config\opencode\command\<name>.md` |
| MCP | `opencode.json` 合并 | 全局 opencode.json |

**命令目录（实测 opencode 1.18.4）**：`command\`（单数）与 `commands\`（复数）**两者都会被扫描**，AgentForge 恒写单数形式；子目录会成为命令名的一部分，分隔符为 `/`（`command\ns\foo.md` → `/ns/foo`）。

### 8.4 Codex

| 角色 | Project | User |
|------|---------|------|
| 主规则 | `AGENTS.md` | `%USERPROFILE%\.codex\AGENTS.md` |
| Skills | `.agents\skills\<name>\SKILL.md` | `%USERPROFILE%\.codex\skills\` 等 |
| Commands（§8.8） | **不支持** | `%USERPROFILE%\.codex\prompts\<name>.md`（= `$CODEX_HOME\prompts`） |
| MCP | `.codex\config.toml` 中 `# BEGIN AGENTFORGE MCP` 段 | 全局 config.toml |

**自定义 prompt 只有 user 级（实测）**：项目级 `.codex\prompts\<name>.md` 放好后 `/name` **不展开**；`codex app-server` 协议（`generate-json-schema --experimental` 全量导出）里没有任何 custom prompt 方法，配合二进制里的 `tui/src/bottom_pane/custom_prompt_view.rs`，判定它是纯 TUI 特性、只读 `$CODEX_HOME\prompts`。因此 project scope 的 Commands 项按 **skip + doctor warning** 处理（§8.8 / §9），不静默写一个不生效的文件。

**技能调用前缀是 `$` 而非 `/`（实测）**：`.agents\skills\<name>\SKILL.md` 放在项目里即可被发现，用 `$<name>` 调用（`codex exec` 下同样生效）。这是 codex 与其余三家唯一的语法差异，`aforge status` 必须显式提示。

### 8.5 Claude Code

| 角色 | Project | User |
|------|---------|------|
| 主规则 | `CLAUDE.md` | `%USERPROFILE%\.claude\CLAUDE.md` |
| Skills | `.claude\skills\<name>\SKILL.md` | `%USERPROFILE%\.claude\skills\` |
| Commands（§8.8） | `.claude\commands\<name>.md` | `%USERPROFILE%\.claude\commands\<name>.md` |
| MCP | `.mcp.json`（`mcpServers`） | 对应全局配置 |

**命名空间分隔符是 `:`（实测 Claude Code 2.1.238）**：`commands\ns\foo.md` → `/ns:foo`（与 opencode 的 `/` 不同）。`SKILL.md` 正文里的 `$ARGUMENTS` 同样会被替换，因此 claude 侧"skill 直接当命令用"已能带参数。

### 8.6 Pi

| 角色 | Project | User |
|------|---------|------|
| 主规则 | `AGENTS.md` | `%USERPROFILE%\.pi\agent\AGENTS.md` |
| Skills | `.pi\skills\<name>\SKILL.md` | `%USERPROFILE%\.pi\agent\skills\` |
| Commands（§8.8） | `.pi\prompts\<name>.md` | `%USERPROFILE%\.pi\agent\prompts\<name>.md` |
| MCP | `.pi\mcp.json`（MVP soft） | `%USERPROFILE%\.pi\agent\mcp.json`（MVP soft） |

**目录名是 `prompts` 而非 `commands`**：pi 启动时会把遗留的 `commands\` 自动 `rename` 成 `prompts\`（`dist/migrations.js` 的 `migrateCommandsToPrompts`），AgentForge 只写 `prompts\`。扫描**非递归**、只认 `.md`，命令名 = 文件名（无命名空间概念）；占位符除 `$ARGUMENTS` 外还支持 `$@` / `$1..$N` / `${N:-默认值}` / `${@:N:L}`（`dist/core/prompt-templates.js` 的 `substituteArgs`）。

**MCP 前置依赖**：pi 本体不内建 MCP，需先在 pi 侧安装适配扩展 `pi install npm:pi-mcp-adapter`（<https://pi.dev/packages/pi-mcp-adapter>）。适配器读取优先级（高 → 低）为 `.pi\mcp.json`（项目级 pi 覆盖）> `.mcp.json`（项目共享）> `<Pi agent dir>\mcp.json`（user 级 pi 覆盖，缺省 `%USERPROFILE%\.pi\agent\mcp.json`）> `~\.config\mcp\mcp.json` / `~\.agents\mcp.json`（全局共享）。注意 user 级 pi 覆盖排在项目级 `.mcp.json` **之后**——上游明确项目文件同时盖过 user 全局共享配置与 pi 全局覆盖，因此不能假定"pi 私有位一定生效"。AgentForge 写 pi 私有位的理由是避免与 claude projector 争用根 `.mcp.json`：同一事务里两个 projector 写同一路径会互相覆盖；扩展未安装时该文件只是躺着不生效。

**已知限制（`PI_CODING_AGENT_DIR`）**：user scope 的落点硬编码为 `%USERPROFILE%\.pi\agent`，当前不支持 `PI_CODING_AGENT_DIR`（上游适配器在该变量置位时改读它指向的目录）。置位该变量时 user scope 的 MCP 投影会落在 pi 不读的路径上；又因该项是 MVP soft、写成功即静默，用户拿不到"这份配置不生效"的信号。对比 §2.2 的 `CODEX_HOME` 已被 paths 层认掉，此项属待补的对称支持。

**MVP soft 定义**：Pi 的 MCP 投影采用 best-effort 策略——尝试写入 `.pi\mcp.json` 的 `mcpServers` 管理键；目录/文件异常则跳过并输出 warning，不阻塞 sync 流程。

**升级说明（旧落点 `.pi\settings.json`）**：早期版本把 pi 的 MCP 投影写在 `.pi\settings.json`（user 级同理 `%USERPROFILE%\.pi\agent\settings.json`）。现落点为同目录的 `mcp.json`，**旧文件不会被自动迁移或删除**——请在确认新 `mcp.json` 生效后**手工删除**旧文件里的 `mcpServers` 键（若该文件没有你自己的 pi 设置，可整份删除）。`aforge doctor` 会把"含 `mcpServers` 键的 `settings.json`"报为一条 `residual/pi-legacy-mcp` warning（只诊断不删，§9），据它定位即可。

### 8.7 投影矩阵（MVP）

| 产物 | opencode | codex | claude | pi |
|------|----------|-------|--------|-----|
| 根 AGENTS.md | ✅ | ✅ | ❌ | ✅ |
| CLAUDE.md | 可选 | ❌ | ✅ | ❌ |
| Skills copy | ✅ | ✅ | ✅ | ✅ |
| Commands（§8.8，可选） | ✅ | 仅 user | ✅ | ✅ |
| MCP 配置 | ✅ | ✅ | ✅ | soft |

开关对应（§4.2）：标 ✅ 的根 `AGENTS.md` 受 `projection.write_agents_md` 控制（`false` → 三个 target 均不写）；claude 的 `CLAUDE.md` 受 `projection.write_claude_md` 控制；opencode 的"可选" `CLAUDE.md` 仅在 `projection.write_claude_md: true` 时投影（缺省不写）。`marker_mode: none` 时上述主规则项由 `merge_marker` 降级为整文件 `write`。Commands 行受 `skills.expose_as_command` 控制（缺省空 → 该行整体不投影）。

### 8.8 Commands（用户可调用入口）

**先明确一件事：这一层不是必需的。** 四个 target 都已把安装好的技能本身暴露成用户可直接调用的入口，`skills.always` + `aforge sync` 就足够让 `/<skill-name>` 可用：

| target | 调用语法 | 依据 |
|--------|----------|------|
| claude | `/<name>` | `claude --help` 明写 "Skills still resolve via /skill-name"；项目级 `.claude\skills\` 实测通过 |
| opencode | `/<name>` | `GET /command` 返回的条目带 `source: "skill"`；项目级 `.opencode\skills\` 探针实测出现在列表里 |
| pi | `/<name>` | `dist/modes/interactive/interactive-mode.js` 把 `skillCommandList` 并入补全候选 |
| codex | **`$<name>`** | `.agents\skills\` 项目级探针 + `$<name>` 实测生效（含 `codex exec`） |

所以 §7 的默认路径不变：装技能 → sync → 直接用。**codex 前缀是 `$`**，`aforge status` 与 `skill add` 的成功提示必须写清这一差异，否则用户会以为 codex 没生效。

**这一层解决的是另外两件事**，需要时才通过 `skills.expose_as_command`（§4.2）开启：

1. **强制调用**：命令/prompt 是确定性的文本展开，不经模型裁量；技能触发依赖 description 匹配；
2. **位置参数**：技能正文只有 `$ARGUMENTS` 一档（claude 实测支持，其余三家不保证），命令层可用 `$1..$N`。

#### 8.8.1 产物形态

薄壳 Markdown，一名一文件，正文只做"加载技能 X，按其工作流执行，用户输入见 `$ARGUMENTS`"，不复制技能正文（避免两份内容漂移）。落点见 §2.3 与 §8.3–8.6 各表的 Commands 行。

SoT 侧不新增目录：内容由 `skills\<name>\SKILL.md` 的 frontmatter 派生（`description` 直接透传，`argument-hint` 有则透传）。

#### 8.8.2 跨 target 归一化

| 维度 | 归一化口径 |
|------|------------|
| 占位符 | SoT 只允许 `$ARGUMENTS` 与 `$1..$9`（四家交集）；`${N:-默认值}` 等 pi 专有语法不进 SoT |
| frontmatter | 只写 `description` 与 `argument-hint`；opencode 的 `agent` / `model` / `subtask`、claude 的 `allowed-tools` 由各 projector 按需补 |
| 命名空间 | opencode `/`、claude `:`、pi 无（不投影带命名空间的名字）、codex 不适用。MVP **只投影平铺名**，不产生子目录 |
| 命令名 | 取技能目录名。中文名四家实测均可用；但 GBK 代码页下终端输入困难，建议 SoT 侧用 ASCII 名，中文别名由用户自行追加（AgentForge 不自动生成别名文件） |

#### 8.8.3 记账与清理

命令文件是**整文件产物**（与 `skills\<name>\SKILL.md` 同类），走 §7.6 的 `artifacts` 记账 + prune：不用 marker，从 `expose_as_command` 摘名后由下一次 `sync` 删除，内容被手工改过则跳过并报进 `prune skipped`。

#### 8.8.4 codex 的降级

codex 只有 user 级 `$CODEX_HOME\prompts\`（§8.4 实测结论）。effective scope 为 `project` 时：

- **不写**任何 codex 命令文件（不写进 `%USERPROFILE%`——那会让项目级配置泄漏成全局配置）；
- `sync` 输出与 `--json` 里列一条 `skipped`，`aforge doctor` 报 `commands/codex-project-unsupported` warning（只提示，不影响退出码）；
- 提示文案要给出替代方案：codex 侧用 `$<skill-name>` 即可，无需命令文件。

#### 8.8.5 验证记录（2026-08-28）

本节所有落点与语法差异均为真机实测，非文档推断。复现方式记录在此，便于上游变更后重跑：

| target | 版本 | 验证手段 | 结论 |
|--------|------|----------|------|
| opencode | 1.18.4（Linux/WSL） | `opencode serve` + `GET /command` / `GET /skill`，探针放在项目 `.opencode\` 下 | `command\` 与 `commands\` 均生效；子目录名带 `/`；技能以 `source: "skill"` 出现在命令列表 |
| claude | 2.1.238（Linux/WSL） | `claude -p "/<name> <args>"`，探针放在项目 `.claude\` 下 | 项目级 commands 生效、`$ARGUMENTS` 替换生效、命名空间为 `:`、项目级 skill 可 `/name` 调用 |
| pi | 0.84.x（Windows） | `pi -p "/<name> <args>"`，探针放在项目 `.pi\prompts\` 下 | 项目级 prompts 生效、`$ARGUMENTS` 替换生效 |
| codex | 0.5x（Windows，`@openai/codex`） | `codex exec '$<name>'` / `codex exec '/<name>'`；`codex app-server generate-json-schema --experimental` | `.agents\skills\` 项目级 + `$` 前缀生效；项目级 `.codex\prompts\` **不生效**，协议里无 custom prompt 方法 |

四家的中文命令名（如 `/软件架构师`）均实测可用，因此 §8.8.2 不强制 ASCII，只把它降级为可读性建议。

---

## 9. Doctor（Windows 增强）

- 打印各 target 解析后的绝对路径。
- 检查目录可写；不可写 → 退出码 4。
- 比较 SoT content hash 与投影 marker 内 hash。
- 检测 `skills/` 下断开的 symlink（MVP 投影恒为实体 copy，此类 symlink 来自手工创建或历史遗留 → warn）。
- `profile.skills.copy_mode` 声明 `symlink` 时告警（已声明未实现，见 §4.2 / §12 Phase 2 → warn）。
- 报告未解析的 template id、损坏的 YAML。
- `skills.expose_as_command` 里的名字不在 `skills.always` 中 → 与"点名未装"同口径报错（§4.2）；project scope 且 target 含 codex 时报 `commands/codex-project-unsupported` warning（§8.8.4 → warn）。
- `learning.auto_capture`（§7.4）报一条 `learning-auto-capture`：声明 `hook` → warn（**MVP 未实现任何 target 侧钩子写入**，行为等同 `off`；等 hook 落地后再按 target 细分成 `learning/hook-unsupported`）；`prompt` → `ok` 并说明投影正文含 `## Learning Protocol` 段；`CI` 为真 → 仍报 `ok`，附一句"本次运行不会写入任何 learnings"（护栏 3 只约束**写入**，不改变生效档位与渲染正文——否则同一份 SoT 在 CI 与本机的 `contentHash` 不同，跨环境 hash 比对全部失真）。

---

## 10. 安全

- MVP 模板仅为 Markdown，不执行模板内脚本。
- Skill 中含可执行文件时文档警告；投影只 copy，不自动执行。
- git URL 支持 https/ssh；默认不跟踪浮动 `main`（要求 ref/pin）。
- 不在 CI 中写入 learnings（`learning.auto_capture` 三档在 `CI` 为真时一律降级为 `off`，§7.4）。
- `learning.auto_capture: hook` 写 target 侧钩子配置时，claude 的 `settings.json` 可能存有明文凭据：必须走 §8.2 的 `merge_json`（未知键一律保留），错误信息与 `--json` 输出只报路径与键名，**不回显文件内容**。
- Commands 薄壳（§8.8）与技能一样只投影文本，不含可执行内容；`skills.expose_as_command` 不改变"投影只 copy、不自动执行"的口径。
- 并发安全：非 dry-run 的 `sync` 在 SoT 根取进程级排他锁 `<sotRoot>\.sync.lock\`（**目录**，用非递归 `mkdir` 原子创建——Windows 与 POSIX 均原子，`EEXIST` 即败者，直接失败退出而不等待）。锁目录内 `meta.json` 记录持有者来源（pid / 机器 / 用户）与心跳时刻；心跳每 30 秒刷新，仅当心跳停摆超过 5 分钟**且**持有者进程已不存活时才判定陈旧并允许抢占（只看时间会误杀慢 sync）。投影产物落在 SoT 之外（user scope 投影、`CODEX_HOME` 覆盖）时额外取用户级 SoT 根的锁，按路径序加锁防死锁。`aforge source add` 等其他写命令暂未纳入锁保护。

---

## 11. 测试与验收

### 11.1 测试

- 单元：合并逻辑、探测器、路径解析（win32）。
- 集成：临时目录投影快照。
- **CI 含 Windows runner** 作为门禁。

### 11.2 MVP 验收（必须在 Windows 上执行）

1. `aforge init -i` 在存在 fnm、uv 的环境生成正确 habits，投影文件含对应约定（由变量渲染，非内置写死）。
2. 修改 `custom\*.md` 后 sync，启用的 target 均更新且 marker 外保留。
3. learn → promote → sync 后新规则出现在投影中。
4. doctor 在脏投影时发现 hash 不一致；只读目录返回退出码 4。
5. 断网下仅用 `base/default` + 本地 habits 可走通 init/sync。
6. skill add 落地为实体文件 copy，非 symlink。
7. `AGF_OFFLINE=1` 时 source update 失败；已有内容仍可 sync。
8. 用户级和项目级 SoT 同时存在时，合并行为符合 §4.2 定义的合并策略。
9. marker 区间被手动修改后 sync，返回退出码 3 并提示用户确认。
10. 在包含中文和空格的路径下完成 init → sync 全流程。
11. 多个 template 启用时，合并输出符合 §5.2 优先级。
12. sync 任一 target 失败时，所有 target 回滚到 sync 前状态。
13. `aforge import` 从 AGENTS.md 导入工具链声明，映射到 habits detected 字段。
14. `skills.expose_as_command` 点名一个已装技能后 sync，opencode / claude / pi 各落一份命令文件、codex 报 skip；从名单摘掉后再 sync，三份产物被 prune 删除，手工改过的那份保留并进 `prune skipped`（§8.8.3）。
15. `learning.auto_capture: prompt` 时投影正文含 `## Learning Protocol` 段且位置固定；置 `off` 后该段消失，marker 外内容不受影响（§5.2）。
16. `CI=1` 环境下 `auto_capture` 任意取值都不写 `learnings/`，且不以错误退出（§10）。

---

### 11.3 代码组织门禁

- **`src\` 下单个 `.ts` 文件不得超过 500 行**，由 `npm run lint:size`（`scripts\check-file-size.mjs`）在 `npm run lint` 与 CI 主 job 中强制。
- 超标即视为该文件承担了多个职责，处理方式是按职责拆模块并保持对外导出面不变；不接受删注释/压行来凑数。
- 只约束 `src\`：`tests\` 里一个 spec 对应一个被测模块，长度来自用例堆叠而非职责不清。

---

## 12. 分阶段（技术）

| 阶段 | 范围 |
|------|------|
| Phase 1 | 本文档 MVP：四投影、源 local/git、learn/promote、Windows 门禁 |
| Phase 2 | MCP 对齐、import 增强、可选 symlink、更多模板、Commands 投影（§8.8）、`learning.auto_capture: prompt`（§7.4） |
| Phase 3 | Learning 启发式、`auto_capture: hook`（含 opencode plugin / pi extension 适配）、适配器插件化、WSL 说明 |

---

## 13. 示例

### 13.1 habits.yaml

```yaml
version: 1
runtime:
  node:
    manager: fnm
    version: "lts"
  python:
    manager: uv
    version: "3.12+"
  package_managers: [pnpm, bun, npm]
tools:
  shell: powershell
  git:
    conventional_commits: true
ai:
  language: [zh-CN, en]
  style: "concise, surgical changes, no speculative features"
  verification: [test, lint, typecheck]
  forbid:
    - "Do not suggest nvm when fnm is available"
    - "Do not use pip install for project deps when uv is configured"
```

### 13.2 投影片段（AGENTS.md）

```markdown
<!-- BEGIN AGENTFORGE -->
# AgentForge Rules

## Toolchain
- Node: use **fnm** only (version preference: lts).
- Python: use **uv** for envs and dependencies (3.12+).
- JS packages: prefer **pnpm**, then bun, then npm.

## Style
concise, surgical changes, no speculative features

## Verification
Before finishing: run test, lint, and typecheck when applicable.

## Forbidden
- Do not suggest nvm when fnm is available
- Do not use pip install for project deps when uv is configured
<!-- END AGENTFORGE -->
```

---

*本文档为 AgentForge 技术规格基线，与 `AgentForge-PRD.md` 配套使用。实现应以本 Spec 为准；产品范围以 PRD 为准。*
