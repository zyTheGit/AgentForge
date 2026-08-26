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

| Target | 主规则 | Skills | MCP / 配置 |
|--------|--------|--------|------------|
| opencode | `AGENTS.md` | `.opencode\skills\<name>\SKILL.md` | `opencode.json` 或 `.opencode\opencode.json` |
| codex | `AGENTS.md` | `.agents\skills\<name>\SKILL.md` | `.codex\config.toml` |
| claude | `CLAUDE.md` | `.claude\skills\<name>\SKILL.md` | `.mcp.json` |
| pi | `AGENTS.md` | `.pi\skills\<name>\SKILL.md` | `.pi\settings.json`（MVP soft） |

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
  }
}
```

- 用户级与项目级 SoT 均包含 `sync-meta.json`。
- `doctor` 通过比较 `contentHash` 与当前 SoT 渲染结果的 hash 来判断投影一致性。

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
detected: object          # 探测器只读快照
extensions: object        # 用户扩展键
```

**规则：** 声明字段优先于 `detected`。生成规则时不得在模板中硬编码个人工具名，只能通过变量注入。

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

**`skills.on_demand`（MVP 决定）：** 只登记不物化——`sync` 仅投影 `skills.always`；`on_demand` 清单由 `aforge status` 展示并标注"declared only - not projected in MVP"。按需装载属 Phase 2。

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

### 5.3 Skill 同名优先级

项目 SoT > 用户 SoT > 源 store（安装时已 copy，以 SoT 为准）。

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
| `aforge skill add\|list` | Skill |
| `aforge mcp add` | MCP 描述加入 SoT（交互录入，或 `--from-json` 从 stdin 读 JSON 声明） |
| `aforge status` | 状态与路径 |
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
  - 覆盖命令（当前实际）：`init`、`sync`、`status`、`doctor`、`detect`、`learn`、`learnings list|show|edit|rm`、`promote`、`import`、`source add|list|remove|update`、`template list|enable|disable`、`skill add|list`、`mcp add`。
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

### 7.5 Promote

1. 校验 id。
2. 写入 `custom/` 或 `skills/`（按 `promote_target`）。
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
| skill add | **copy** 到 SoT skills 目录 |
| template enable | 只改 profile.templates |
| 默认 | 不使用 symlink |

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
| `doctor` | 正常执行（本地诊断） |

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
| MCP | `opencode.json` 合并 | 全局 opencode.json |

### 8.4 Codex

| 角色 | Project | User |
|------|---------|------|
| 主规则 | `AGENTS.md` | `%USERPROFILE%\.codex\AGENTS.md` |
| Skills | `.agents\skills\<name>\SKILL.md` | `%USERPROFILE%\.codex\skills\` 等 |
| MCP | `.codex\config.toml` 中 `# BEGIN AGENTFORGE MCP` 段 | 全局 config.toml |

### 8.5 Claude Code

| 角色 | Project | User |
|------|---------|------|
| 主规则 | `CLAUDE.md` | `%USERPROFILE%\.claude\CLAUDE.md` |
| Skills | `.claude\skills\<name>\SKILL.md` | `%USERPROFILE%\.claude\skills\` |
| MCP | `.mcp.json`（`mcpServers`） | 对应全局配置 |

### 8.6 Pi

| 角色 | Project | User |
|------|---------|------|
| 主规则 | `AGENTS.md` | `%USERPROFILE%\.pi\agent\AGENTS.md` |
| Skills | `.pi\skills\<name>\SKILL.md` | `%USERPROFILE%\.pi\agent\skills\` |
| Settings/MCP | `.pi\settings.json`（MVP soft） | 全局 settings |

**MVP soft 定义**：Pi 的 MCP/Settings 投影采用 best-effort 策略——尝试写入 `.pi/settings.json` 的约定字段；文件不存在则跳过并输出 warning，不阻塞 sync 流程。

### 8.7 投影矩阵（MVP）

| 产物 | opencode | codex | claude | pi |
|------|----------|-------|--------|-----|
| 根 AGENTS.md | ✅ | ✅ | ❌ | ✅ |
| CLAUDE.md | 可选 | ❌ | ✅ | ❌ |
| Skills copy | ✅ | ✅ | ✅ | ✅ |
| MCP 配置 | ✅ | ✅ | ✅ | soft |

开关对应（§4.2）：标 ✅ 的根 `AGENTS.md` 受 `projection.write_agents_md` 控制（`false` → 三个 target 均不写）；claude 的 `CLAUDE.md` 受 `projection.write_claude_md` 控制；opencode 的"可选" `CLAUDE.md` 仅在 `projection.write_claude_md: true` 时投影（缺省不写）。`marker_mode: none` 时上述主规则项由 `merge_marker` 降级为整文件 `write`。

---

## 9. Doctor（Windows 增强）

- 打印各 target 解析后的绝对路径。
- 检查目录可写；不可写 → 退出码 4。
- 比较 SoT content hash 与投影 marker 内 hash。
- 检测 symlink 失败记录，提示改用 copy。
- 报告未解析的 template id、损坏的 YAML。

---

## 10. 安全

- MVP 模板仅为 Markdown，不执行模板内脚本。
- Skill 中含可执行文件时文档警告；投影只 copy，不自动执行。
- git URL 支持 https/ssh；默认不跟踪浮动 `main`（要求 ref/pin）。
- 不在 CI 中写入 learnings。
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

---

## 12. 分阶段（技术）

| 阶段 | 范围 |
|------|------|
| Phase 1 | 本文档 MVP：四投影、源 local/git、learn/promote、Windows 门禁 |
| Phase 2 | MCP 对齐、import 增强、可选 symlink、更多模板 |
| Phase 3 | Learning 启发式、适配器插件化、WSL 说明 |

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
