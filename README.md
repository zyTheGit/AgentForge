# AgentForge

用一份事实源（SoT）统一管理你的 AI 编码助手规则，一键投影到 opencode / codex / claude / pi 四个目标 Agent——改一处，处处最新，且不碰你在投影文件里手写的内容。

## 是什么

你是否在 `AGENTS.md`、`CLAUDE.md` 等多个规则文件里重复维护同一套工具链约定？AgentForge 把这些收进项目（或用户级）的 `.agentforge` 目录：

- **habits.yaml**：声明你的工具链与 AI 偏好（node 用 fnm、python 用 uv、包管理器优先 pnpm……）；
- **custom/*.md**：自由格式的规则素材；
- **learnings/**：从实战经验沉淀、待确认的条目（`aforge learn`）；
- **templates/、skills/、mcp/**：可复用模板、技能与 MCP 服务器声明。

执行 `aforge sync` 后，以上内容被渲染并写入各 Agent 的原生规则文件。AgentForge 只管理文件中的 marker 区间，区间外你的手写内容原样保留。规则正文之外，同一次 `sync` 还会投影技能目录、MCP 配置，以及（按需开启的）命令薄壳。

## 安装

前置：Node ≥ 20.19。

```powershell
npx -y @zythegit/agentforge@latest --version   # 免安装试跑
npm i -g @zythegit/agentforge                  # 常用则全局装，命令名是 aforge
```

免 Node 的独立二进制、从源码构建、macOS / Linux 差异见 [docs/install.md](docs/install.md)。

## 快速开始

```powershell
cd C:\path\to\your-project

# ① 初始化：终端里默认走交互五步——选 scope → 自动探测工具链 → 确认 → 选目标 Agent → 写入（可选立即 sync）
aforge init

# ② 之后每次修改 .agentforge 内的任意内容，同步到四个目标
aforge sync
```

不想交互？`--yes` 走全默认（scope=project、四个 target 全装），CI / 管道里自动就是这条路：

```powershell
aforge init --yes            # 或 aforge init --yes --scope user 单独指定层
aforge sync
```

从既有规则文件搬家？把工具链声明直接导入：

```powershell
aforge import AGENTS.md    # 或 CLAUDE.md：识别工具链关键词 → habits 建议字段 + custom 素材
```

## 常用指令

```powershell
aforge status              # SoT 概览：scope、各 target 落点与技能调用前缀、最近一次 sync
aforge doctor              # 体检：配置合法性、投影一致性、环境问题
aforge sync --dry-run      # 只看会写哪些文件，不落盘
aforge learn               # 记一条 learning（不投影，promote 后才进规则）
aforge learn --file -      # 从 stdin 读正文（管道 / agent 调用；非交互终端必须走这条）
aforge learn --file notes.md   # 从文件读正文
aforge skill add <name>    # 装技能进 SoT 并登记，sync 后投影到四家
aforge mcp add             # 登记 MCP 服务器，sync 时翻译成各 Agent 的原生配置
```

让 agent 自己沉淀经验：把 `learning.auto_capture` 设为 `prompt`（投影正文里多一段协议）或 `hook`（codex 侧会话钩子注入）。没有钩子落点的三家可以手工挂载同一份协议，写法见 [learning](docs/learning.md#手工挂载把协议塞进没有落点的三家)。

任何子命令都可加 `--json` 拿机器可读输出（路径一律绝对路径）。完整 14 个命令、参数与退出码见 [命令速查](docs/commands.md)。

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

规则文件之外，同一次 `sync` 还落三类**整文件产物**（不用 marker，改名/摘名后由下一次 `sync` prune）：

- **技能**：`skills/<name>/SKILL.md` 投影到四家各自的技能目录，`status` 会打出每家的调用前缀；
- **MCP**：一份 `profile.mcp.servers` 翻译成 opencode / codex / claude / pi 的原生配置；
- **命令薄壳**：`skills.expose_as_command` 点名的技能额外落一份命令/prompt，支持 `ns/name` 命名空间与 `$1..$9` 位置参数（见 [技能](docs/skills.md#额外投影成命令expose_as_command)）。

每个投影的**规则文件**中，AgentForge 只管理 marker 区间：

```markdown
<!-- BEGIN AGENTFORGE -->
（AgentForge 渲染内容——sync 时整体替换）
<!-- END AGENTFORGE -->

（marker 之外的内容属于你，sync 永不触碰）
```

- **变更检测**：sync 前对比 marker 区间指纹，发现你手改过区间内容 → 拒绝写入（退出码 3），`--force` 可覆盖；
- **事务化写入**：多 target 投影失败自动回滚已写文件；
- **两级合并**：user 层 SoT 与 project 层 SoT 按层合并（project 优先）；
- **环境无关**：投影正文不受 `CI` 等环境变量影响，同一份 SoT 在 CI 与本机渲染出的 `contentHash` 一致，`aforge doctor` 的 hash 比对才不会误报漂移。

## 文档

- [命令速查与约定](docs/commands.md)——14 个命令、`--json` 契约、环境变量、退出码
- [profile.yaml 配置参考](docs/profile.md)——全字段类型/默认值、两层合并语义、投影开关
- [habits.yaml 配置参考](docs/habits.md)——运行时/工具/AI 习惯声明，以及哪些字段真正进投影正文
- [规则正文装配](docs/rules.md)——四层顺序，`custom/` 逐字规则与 `templates/` 自定义模板
- [安装与构建](docs/install.md)——三种装法、双轨构建、开发命令
- [技能](docs/skills.md)——登记来源、安装、投影落点与调用前缀，以及 `expose_as_command` 命令薄壳（命名空间、`$1..$9`）
- [MCP](docs/mcp.md)——一份声明翻译成四家的原生配置
- [learning](docs/learning.md)——`learn` / `promote` 闭环与 `auto_capture`
- [迁移 SoT](docs/bundle.md)——`bundle export/import` 换机器、备份
- [平台注意事项与已知限制](docs/platform.md)——Windows 路径 / 换行 / 编码，并发与 symlink 边界，尚未实现的字段
- [在 CI 中使用 aforge](docs/ci.md)——CI 里能做什么、漂移门禁 workflow、退出码排障与串行约束
- [路线图与实现状态](docs/roadmap.md)——各 Phase 的完成度、不予实现的决策与非目标
- 规格与需求：[AgentForge-Spec.md](AgentForge-Spec.md)、[AgentForge-PRD.md](AgentForge-PRD.md)

---

*版本以 git tag 为唯一来源（`v*` tag → npm 包版本 + Release 资产），本机版本用 `aforge --version` 查。*
