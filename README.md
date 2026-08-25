# AgentForge

用一份事实源（SoT）统一管理你的 AI 编码助手规则，一键投影到 opencode / codex / claude / pi 四个目标 Agent——改一处，处处最新，且不碰你在投影文件里手写的内容。

## 是什么

你是否在 `AGENTS.md`、`CLAUDE.md` 等多个规则文件里重复维护同一套工具链约定？AgentForge 把这些收进项目（或用户级）的 `.agentforge` 目录：

- **habits.yaml**：声明你的工具链与 AI 偏好（node 用 fnm、python 用 uv、包管理器优先 pnpm……）；
- **custom/*.md**：自由格式的规则素材；
- **learnings/**：从实战经验沉淀、待确认的条目（`aforge learn`）；
- **templates/、skills/、mcp/**：可复用模板、技能与 MCP 服务器声明。

执行 `aforge sync` 后，以上内容被渲染并写入各 Agent 的原生规则文件。AgentForge 只管理文件中的 marker 区间，区间外你的手写内容原样保留。

## 安装

### 方式一：bun 全局安装（推荐）

前置：安装 [bun](https://bun.sh/) 与 [fnm](https://github.com/Schniz/fnm)（或任意 Node 版本管理器）。

```powershell
# 每个新终端先激活 Node 环境（fnm）
fnm env --shell power-shell | Out-String -Stream | Invoke-Expression
fnm use 22

# 从源码全局安装（克隆后）
git clone <repo-url> AgentForge
cd AgentForge
npm install
bun link   # 之后任意目录可用 aforge 命令
```

### 方式二：源码构建独立 exe（免运行时依赖）

```powershell
fnm env --shell power-shell | Out-String -Stream | Invoke-Expression
fnm use 22
npm install
npm run build:bun    # 产出 dist\aforge.exe（Windows 独立可执行）
```

或构建 Node 版产物（需目标机器有 Node ≥ 20.19）：

```powershell
npm run build:node   # 产出 dist\aforge.js（esbuild 打包）
node dist\aforge.js --version
```

两条构建轨道产物等价：`aforge.exe` 零依赖可直接分发；`aforge.js` 适合已有 Node 环境的机器。

## 快速开始（Windows PowerShell）

```powershell
# 进入你的项目
cd C:\path\to\your-project

# ① 交互式初始化：选 scope → 自动探测工具链 → 确认 → 选目标 Agent → 写入（可选立即 sync）
aforge init -i

# ② 之后每次修改 .agentforge 内的任意内容，同步到四个目标
aforge sync
```

不想交互？全部可用参数表达（CI / 脚本友好）：

```powershell
aforge init --scope project
aforge sync
```

从既有规则文件搬家？把工具链声明直接导入：

```powershell
aforge import AGENTS.md    # 或 CLAUDE.md：识别工具链关键词 → habits 建议字段 + custom 素材
```

## 命令速查（13 个）

| 命令 | 作用 |
|------|------|
| `aforge init -i` | 交互式五步初始化（scope → 探测 → 确认 → 选 target → 写入） |
| `aforge init [--scope project\|user]` | 非交互初始化（探测快照 + 骨架落盘） |
| `aforge detect [--json]` | 探测本机工具链（node/python/包管理器/shell/已有规则文件），无副作用 |
| `aforge sync [--targets a,b] [--dry-run] [--force]` | 渲染 SoT 并投影到目标 Agent |
| `aforge learn [--scope s] [--file f\|'-'] [--id id]` | 记录一条 learning（不投影） |
| `aforge promote <id> [--to user] [--yes]` | 将 learning 升级为 custom 规则或 skill |
| `aforge learnings [--json]` | 列出两层 SoT 的全部 learning |
| `aforge source add <path\|git-url> [--ref r] [--id id]` | 登记规则/模板/技能来源（local 或 git） |
| `aforge source list [--json]` / `remove <id>` / `update <id>` | 管理已登记来源（update 离线报错） |
| `aforge template list [--json]` / `enable <id>` / `disable <id>` | 管理规则模板 |
| `aforge skill add <name> [--from src]` / `list [--json]` | 安装（实体拷贝）/列出技能 |
| `aforge mcp add [--scope s] [--json]` | 登记 MCP 服务器声明 |
| `aforge status [--json]` | SoT 概览：scope、目标路径、最近 sync、内容计数 |
| `aforge doctor [--json]` | 体检：配置合法性、投影一致性、环境问题 |
| `aforge import <path>` | 从既有 AGENTS.md / CLAUDE.md 导入工具链声明与素材 |

## 工作原理

```
                .agentforge/ (SoT)                          Agent 原生规则文件
        ┌────────────────────────────┐
        │ habits.yaml   (工具链声明) │      render        ┌─ AGENTS.md  (opencode)
        │ custom/*.md   (自由素材)   │  ─────────────►    ├─ AGENTS.md  (codex)
        │ learnings/    (经验沉淀)   │     (sync)         ├─ CLAUDE.md  (claude)
        │ templates/    (规则模板)   │                    └─ AGENTS.md  (pi)
        │ skills/  mcp/              │
        └────────────────────────────┘
```

每个投影文件中，AgentForge 只管理 marker 区间：

```markdown
<!-- BEGIN AGENTFORGE -->
（AgentForge 渲染内容——sync 时整体替换）
<!-- END AGENTFORGE -->

（marker 之外的内容属于你，sync 永不触碰）
```

- **变更检测**：sync 前对比 marker 区间指纹，发现你手改过区间内容 → 拒绝写入（退出码 3），`--force` 可覆盖；
- **事务化写入**：多 target 投影失败自动回滚已写文件；
- **两级合并**：user 层 SoT 与 project 层 SoT 按层合并（project 优先）。

## Windows 注意事项

- **路径**：统一使用绝对路径输出；用户级 SoT 默认在 `%USERPROFILE%\.agentforge`，项目级在 `<项目根>\.agentforge`。含中文与空格的路径已受测试覆盖，可放心使用。
- **换行**：投影文件默认 LF（可通过 `profile.yaml` 的 `projection.line_ending: crlf` 修改）；SoT 内部素材统一 LF，换行差异由投影层吸收，不会造成虚假 diff。
- **离线**：无网络环境完全可用（init/sync/template/skill 等纯本地操作）。git 源的 `source update` 需要网络，离线时明确报错（退出码 5）。也可设 `AGF_OFFLINE=1` 显式声明离线意图，让需要网络的操作尽早失败。
- **权限**：**无需 Administrator**。全部文件读写都在你的用户目录与项目目录内；写失败时给出可操作的修复提示（退出码 4）。
- **控制台编码**：非交互命令输出为纯 ASCII（GBK 代码页 `chcp 936` 下不乱码）；`init -i` 的交互 UI 需要真实终端（TTY）。

### 环境变量

| 变量 | 作用 |
|------|------|
| `AGF_SCOPE` | 缺省 scope（`project` / `user`） |
| `AGF_HOME` | 覆盖用户级 SoT 根目录 |
| `AGF_LINE_ENDING` | 覆盖投影换行风格（`crlf` / `lf`） |
| `AGF_OFFLINE` | 设为 `1` 声明离线模式 |

## 退出码约定

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 2 | 配置错误（未初始化、非法参数、非 TTY 环境跑交互命令等） |
| 3 | 冲突（marker 区间被手改，拒绝覆盖） |
| 4 | 权限错误（目标不可写） |
| 5 | 离线（需要网络的操作在离线模式下失败） |

## 已知限制

- **并发安全**：多进程并发执行 `aforge sync` 或 `aforge source add` 等行为未定义。建议避免并发操作同一 SoT 目录（`.agentforge/`）。如需自动化调度，请确保串行执行。
- **Symlink 支持**：`skills/` 目录默认使用实体拷贝（`copy_mode: copy`），不使用 symlink。跨平台场景（尤其 Windows）symlink 可能失败，doctor 会检测并提示。

## macOS / Linux 旁注

- 安装与用法一致：`fnm env --shell bash | source -`（或 zsh）后 `npm install` + `npm run build:node`；
- 用户级 SoT 在 `$HOME/.agentforge`；投影换行默认规则同 Windows（profile 可配置）；
- `build:bun` 的 `--target=bun-windows-x64` 需按平台改为 `bun-linux-x64` / `bun-darwin-arm64`。

## 开发

```powershell
fnm env --shell power-shell | Out-String -Stream | Invoke-Expression
fnm use 22
npm install
npm test           # 全量测试（vitest）
npm run typecheck  # tsc --noEmit
npm run build      # 双轨构建（node + bun）
```

验收清单见 [tests/e2e/ACCEPTANCE.md](tests/e2e/ACCEPTANCE.md)。

---

*AgentForge v0.1.0 — MVP。规格详见 [AgentForge-Spec.md](AgentForge-Spec.md) 与 [AgentForge-PRD.md](AgentForge-PRD.md)。*
