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

前置：Node ≥ 20.19。

```powershell
npx -y @zythegit/agentforge@latest --version   # 免安装试跑
npm i -g @zythegit/agentforge                  # 常用则全局装，命令名是 aforge
```

免 Node 的独立二进制、从源码构建、macOS / Linux 差异见 [docs/install.md](docs/install.md)。

## 快速开始

```powershell
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
- **两级合并**：user 层 SoT 与 project 层 SoT 按层合并（project 优先）；
- **环境无关**：投影正文不受 `CI` 等环境变量影响，同一份 SoT 在 CI 与本机渲染出的 `contentHash` 一致，`aforge doctor` 的 hash 比对才不会误报漂移。

## 已实现的能力

- **规则投影**：`sync` 把 SoT 渲染进四个 target 的规则文件（marker 区间 + 变更检测 + 事务回滚 + 按上一轮记账 prune 旧产物）；
- **技能**：`source add` 登记来源 → `skill add` 实体拷贝进 SoT 并登记 `skills.always` → `sync` 投影 `SKILL.md`；`status` 会打印各 target 的调用前缀（codex 是 `$<name>`，其余三家 `/<name>`）→ [docs/skills.md](docs/skills.md)；
- **MCP**：一份声明翻译成四家的原生配置（`opencode.json` / `.codex\config.toml` / `.mcp.json` / `.pi\mcp.json`），`mcp remove` + `sync` 按记账摘键 → [docs/mcp.md](docs/mcp.md)；
- **learning 沉淀**：`learn` / `learnings` / `promote` 的人工闭环；`learning.auto_capture: prompt` 会把一段 `## Learning Protocol` 渲进投影正文，让 agent 自己把达成的约定写回 SoT（CI 下不落盘，但该段照样渲染）→ [docs/learning.md](docs/learning.md)；
- **工具链探测与模板**：`detect` 无副作用探测本机工具链，`template enable/disable` 管理规则模板；
- **迁移**：`bundle export/import` 把一层 SoT 打包搬走或落回（默认抹掉 MCP 凭据、先校验 sha256 后落盘）→ [docs/bundle.md](docs/bundle.md)；
- **体检**：`doctor` 检查配置合法性、投影一致性与环境问题，并对「声明了但 MVP 未实现」的配置显式告警而不是静默失效。

尚未实现的部分（§8.8 Commands 投影、`auto_capture: hook`、symlink `copy_mode`、`skills.on_demand` 物化、`PI_CODING_AGENT_DIR`）统一记在 [已知限制](docs/platform.md#已知限制)。

## 文档

- [命令速查与约定](docs/commands.md)——14 个命令、`--json` 契约、环境变量、退出码
- [安装与构建](docs/install.md)——三种装法、双轨构建、开发命令
- [技能](docs/skills.md) / [MCP](docs/mcp.md) / [learning](docs/learning.md) / [迁移 SoT](docs/bundle.md)
- [平台注意事项与已知限制](docs/platform.md)——Windows 路径 / 换行 / 编码，并发与 symlink 边界
- 规格与需求：[AgentForge-Spec.md](AgentForge-Spec.md)、[AgentForge-PRD.md](AgentForge-PRD.md)

---

*AgentForge v0.1.0 — MVP。*
