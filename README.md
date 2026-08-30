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

## 文档

- [命令速查与约定](docs/commands.md)——14 个命令、`--json` 契约、环境变量、退出码
- [安装与构建](docs/install.md)——三种装法、双轨构建、开发命令
- [技能](docs/skills.md)——登记来源、安装、投影落点与调用前缀
- [MCP](docs/mcp.md)——一份声明翻译成四家的原生配置
- [learning](docs/learning.md)——`learn` / `promote` 闭环与 `auto_capture`
- [迁移 SoT](docs/bundle.md)——`bundle export/import` 换机器、备份
- [平台注意事项与已知限制](docs/platform.md)——Windows 路径 / 换行 / 编码，并发与 symlink 边界，尚未实现的字段
- 规格与需求：[AgentForge-Spec.md](AgentForge-Spec.md)、[AgentForge-PRD.md](AgentForge-PRD.md)

---

*AgentForge v0.1.0 — MVP。*
