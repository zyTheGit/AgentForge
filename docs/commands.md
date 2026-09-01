# 命令速查与约定

## 命令（14 个）

| 命令 | 作用 |
|------|------|
| `aforge init [-i]` | 初始化。**终端里默认走交互五步**（scope → 探测 → 确认 → 选 target → 写入）；`-i` 强制交互——压过 `--yes` / `--json`，且非 TTY 下报退出码 2 而非静默降级 |
| `aforge init --yes` / `aforge init --json` | 静默初始化（探测快照 + 骨架落盘）：scope 默认 `project`、target 默认全部四个。非 TTY（CI / 管道）自动走这条；`--scope project\|user` 可单独指定层 |
| `aforge detect [--json]` | 探测本机工具链（node/python/java/dotnet/包管理器/rust/go/monorepo/CI/shell/已有规则文件），无副作用 |
| `aforge sync [--targets a,b] [--dry-run] [--force] [--json]` | 渲染 SoT 并投影到目标 Agent（规则 marker 区间 + 技能 / MCP / [命令薄壳](skills.md#额外投影成命令expose_as_command)整文件产物） |
| `aforge learn [--scope s] [--file f\|'-'] [--id id] [--no-auto-promote]` | 记录一条 learning（不投影；`learning.auto_promote: true` 时顺手 promote，`--no-auto-promote` 单次关掉） |
| `aforge promote <id> [--to user] [--yes]` | 将 learning 升级为 custom 规则或 skill |
| `aforge learnings list [--json]` / `show <id>` / `edit <id>` / `rm <id>` | 管理两层 SoT 的 learning 条目（`edit` 在交互终端拉起 `$EDITOR` 改条目 yaml，退出后重校验；非交互或 `--json` 时只打印路径与正文） |
| `aforge source add <path\|git-url> [--ref r] [--id id]` | 登记规则/模板/技能来源（local 或 git） |
| `aforge source list [--json]` / `remove <id>` / `update <id>` | 管理已登记来源（update 离线报错） |
| `aforge template list [--json]` / `enable <id>` / `disable <id>` | 管理规则模板 |
| `aforge skill add <name> [--from src]` / `list [--json]` / `remove <name> [--scope s]` | 安装（实体拷贝）/列出/注销技能（`remove` 只改 profile，文件保留） |
| `aforge mcp add [--scope s] [--from-json] [--json]` / `remove <name> [--scope s] [--json]` | 登记 / 移除 MCP 服务器声明（`--from-json` 从 stdin 读 JSON 声明） |
| `aforge status [--json]` | SoT 概览：scope、目标路径（含各 target 的技能调用前缀）、最近 sync、内容计数、`learning.auto_capture` 生效档位 |
| `aforge doctor [--json]` | 体检：配置合法性、投影一致性、环境问题 |
| `aforge import <path>` | 从既有规则文件（AGENTS.md / CLAUDE.md / GEMINI.md / .cursorrules / .cursor/rules/*.mdc / .windsurfrules / .github/copilot-instructions.md / opencode.md）导入工具链声明与素材 |
| `aforge bundle export --out <dir>` / `import --from <dir>` | 把一层 SoT 打包搬走 / 落回（见 [迁移 SoT](bundle.md)） |

`--json` 同时是 program 级全局标志：任何子命令都可写成 `aforge --json <cmd>`，输出为机器可读 JSON（路径一律绝对路径）。注意 `mcp add` 的**输入**标志叫 `--from-json`，`--json` 只表示输出契约。

`--no-color` / `--color` 是**位置无关**的呈现开关（写在命令前后都算），只影响人类可读输出；缺省按终端能力自动判定，也认 `NO_COLOR` / `FORCE_COLOR`。分档规则见 [平台注意事项](platform.md#windows)。

## import 可识别的文件与关键词覆盖

`aforge import <path>` 按**声明式规则表**识别文件类型（大小写不敏感）：

| 文件 | 来源工具 | 判据 |
|------|----------|------|
| `AGENTS.md` | agents.md 约定（opencode / codex / pi 等） | 文件名 |
| `CLAUDE.md` | Claude Code | 文件名 |
| `GEMINI.md` | Gemini CLI | 文件名 |
| `opencode.md` | opencode | 文件名 |
| `.cursorrules` | Cursor（旧版单文件） | 文件名 |
| `.cursor/rules/*.mdc` | Cursor（新版规则目录） | 扩展名 `.mdc` **且**位于 `.cursor/rules/` 下（允许再嵌子目录） |
| `.windsurfrules` | Windsurf | 文件名 |
| `.github/copilot-instructions.md` | GitHub Copilot | 文件名 **且**紧邻 `.github/` 之下 |

不在表内的文件 → 退出码 2，报错 hint 会列出上面这份全集。带目录判据的两项必须真的放在对应目录下：`docs/style.mdc`、仓库根的 `copilot-instructions.md` 都不算。

工具链关键词按类别写进 `habits.yaml` 的 `detected.import`（`source: import`，需人工确认后再提升为声明字段）：

| 类别 | `detected.import` 键 | 关键词 |
|------|----------------------|--------|
| Node 版本管理器 | `node.manager`（取优先级序首个） | fnm / nvm / volta / mise / nodenv / asdf |
| Python 工具链 | `python.manager`（取优先级序首个） | uv / poetry / pipenv / conda / pyenv / pdm / hatch / rye / mamba / virtualenv |
| JS 包管理器 | `package_managers`（全部命中） | pnpm / bun / npm / yarn / deno |
| Rust | `rust`（全部命中） | cargo / rustup / rustc / clippy / rustfmt |
| Go | `go`（全部命中） | golang / go.mod / go.sum / gofmt / goimports / gopls |
| Java | `java`（全部命中） | maven / gradle / mvnw / gradlew / sdkman / jdk / java |
| .NET | `dotnet`（全部命中） | dotnet / nuget / msbuild / csproj / csharp |
| Monorepo | `monorepo`（全部命中） | turborepo / turbo / nx / lerna / rush.json / rushstack / changesets / pnpm-workspace / workspaces |
| CI / 提交钩子 | `ci`（全部命中） | github actions / gitlab ci / azure pipelines / jenkins / circleci / travis / dependabot / husky / lint-staged / pre-commit / commitlint |

匹配大小写不敏感且**词边界安全**：`pnpm` 不会被算成 `npm`、`javascript` 不会被算成 `java`、`uvicorn` 不会被算成 `uv`；含空格的关键词（如 `github actions`）允许换行或多空格折断。裸 `go` 与单字符的 `n` 有意不收——在中英文散文里误报率过高，Go 项目靠 `golang` / `go.mod` 等无歧义写法识别。

## 环境变量

| 变量 | 作用 |
|------|------|
| `AGF_SCOPE` | 缺省 scope（`project` / `user`）；非法值降级为未设置 |
| `AGF_HOME` | 覆盖用户级 SoT 根目录（不支持 UNC 网络路径） |
| `AGF_LINE_ENDING` | 覆盖投影换行风格（`crlf` / `lf`），优先级高于 `profile.yaml` |
| `AGF_OFFLINE` | 设为 `1` 声明离线模式，需要网络的操作尽早失败（退出码 5） |
| `CI` | 为真时 `aforge learn` 被拒（退出码 2），learnings 恒不落盘；不影响投影正文 |
| `PI_CODING_AGENT_DIR` | 覆盖 pi 的 agent 目录：user scope 的 `AGENTS.md` / `skills/` / `mcp.json` 整体跟随；`aforge doctor` 打出生效目录 |
| `NO_COLOR` / `FORCE_COLOR` | 关闭 / 强制开启人类可读输出的颜色（`NO_COLOR` 优先）；`--no-color` / `--color` 压过两者 |

有效 scope 的解析顺序：显式 `--scope` > `AGF_SCOPE` > project 层在用 > user 层在用 > `project`。

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 2 | 配置错误（未初始化、非法参数、非 TTY 环境跑交互命令、校验失败等） |
| 3 | 冲突（marker 区间被手改、目标已存在、SoT 锁被他人持有） |
| 4 | 权限错误（目标不可写） |
| 5 | 离线（需要网络的操作在离线模式下失败） |
