# 命令速查与约定

## 命令（14 个）

| 命令 | 作用 |
|------|------|
| `aforge init -i` | 交互式五步初始化（scope → 探测 → 确认 → 选 target → 写入） |
| `aforge init [--scope project\|user] [--json]` | 非交互初始化（探测快照 + 骨架落盘） |
| `aforge detect [--json]` | 探测本机工具链（node/python/包管理器/shell/已有规则文件），无副作用 |
| `aforge sync [--targets a,b] [--dry-run] [--force] [--json]` | 渲染 SoT 并投影到目标 Agent |
| `aforge learn [--scope s] [--file f\|'-'] [--id id] [--no-auto-promote]` | 记录一条 learning（不投影；`learning.auto_promote: true` 时顺手 promote，`--no-auto-promote` 单次关掉） |
| `aforge promote <id> [--to user] [--yes]` | 将 learning 升级为 custom 规则或 skill |
| `aforge learnings list [--json]` / `show <id>` / `edit <id>` / `rm <id>` | 管理两层 SoT 的 learning 条目 |
| `aforge source add <path\|git-url> [--ref r] [--id id]` | 登记规则/模板/技能来源（local 或 git） |
| `aforge source list [--json]` / `remove <id>` / `update <id>` | 管理已登记来源（update 离线报错） |
| `aforge template list [--json]` / `enable <id>` / `disable <id>` | 管理规则模板 |
| `aforge skill add <name> [--from src]` / `list [--json]` / `remove <name> [--scope s]` | 安装（实体拷贝）/列出/注销技能（`remove` 只改 profile，文件保留） |
| `aforge mcp add [--scope s] [--from-json] [--json]` / `remove <name> [--scope s] [--json]` | 登记 / 移除 MCP 服务器声明（`--from-json` 从 stdin 读 JSON 声明） |
| `aforge status [--json]` | SoT 概览：scope、目标路径（含各 target 的技能调用前缀）、最近 sync、内容计数、`learning.auto_capture` 生效档位 |
| `aforge doctor [--json]` | 体检：配置合法性、投影一致性、环境问题 |
| `aforge import <path>` | 从既有 AGENTS.md / CLAUDE.md 导入工具链声明与素材 |
| `aforge bundle export --out <dir>` / `import --from <dir>` | 把一层 SoT 打包搬走 / 落回（见 [迁移 SoT](bundle.md)） |

`--json` 同时是 program 级全局标志：任何子命令都可写成 `aforge --json <cmd>`，输出为机器可读 JSON（路径一律绝对路径）。注意 `mcp add` 的**输入**标志叫 `--from-json`，`--json` 只表示输出契约。

## 环境变量

| 变量 | 作用 |
|------|------|
| `AGF_SCOPE` | 缺省 scope（`project` / `user`）；非法值降级为未设置 |
| `AGF_HOME` | 覆盖用户级 SoT 根目录（不支持 UNC 网络路径） |
| `AGF_LINE_ENDING` | 覆盖投影换行风格（`crlf` / `lf`），优先级高于 `profile.yaml` |
| `AGF_OFFLINE` | 设为 `1` 声明离线模式，需要网络的操作尽早失败（退出码 5） |
| `CI` | 为真时 `aforge learn` 被拒（退出码 2），learnings 恒不落盘；不影响投影正文 |
| `PI_CODING_AGENT_DIR` | 覆盖 pi 的 agent 目录：user scope 的 `AGENTS.md` / `skills/` / `mcp.json` 整体跟随；`aforge doctor` 打出生效目录 |

有效 scope 的解析顺序：显式 `--scope` > `AGF_SCOPE` > project 层在用 > user 层在用 > `project`。

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 2 | 配置错误（未初始化、非法参数、非 TTY 环境跑交互命令、校验失败等） |
| 3 | 冲突（marker 区间被手改、目标已存在、SoT 锁被他人持有） |
| 4 | 权限错误（目标不可写） |
| 5 | 离线（需要网络的操作在离线模式下失败） |
