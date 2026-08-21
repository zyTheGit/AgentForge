# AgentForge — Product Requirements Document (PRD)

| 项 | 内容 |
|----|------|
| 产品名称 | AgentForge |
| CLI | `aforge` |
| 文档版本 | 1.1 |
| 状态 | 会议审核修订 |
| 平台优先级 | **Windows 一等公民**；macOS / Linux 同步支持 |
| 最后更新 | 2026-08-21 |

---

## 1. 产品概述

### 1.1 定位

Habit-first 的 AI Agent 规则锻造与进化工具：根据个人/项目工具使用习惯，生成并维护跨多种 AI Coding CLI 的规则，并支持可审计的持续学习。

### 1.2 目标用户

在 Windows（及 macOS/Linux）上同时使用多个 AI Coding CLI（OpenCode、Codex、Claude Code、Pi 等），并有明确个人或项目工具链习惯（如 fnm、uv、pnpm）的开发者。

### 1.3 一句话价值

规则从「我怎么工作」生成，一次维护、多 Agent 一致，学习可积累、可晋升、可回滚，且不污染全局。

### 1.4 核心差异化

1. **Habit-first**：规则从探测与声明的习惯生成，而非纯静态通用模板。
2. **Learning 一等公民**：可审计的 learn → promote 闭环，默认不自动污染正式规则。
3. **真正可定制**：习惯、模板源、custom、投影目标均可扩展；个人习惯不焊死在发行包内。

---

## 2. 问题陈述

1. 多工具规则格式碎片化，维护成本高；Windows 上路径与配置目录更不统一。
2. 现有生成/同步工具多不感知个人工具链（fnm、uv、pnpm 等），Agent 仍会建议 nvm/pip。
3. 会话中的经验无法系统沉淀为可复用规则。
4. 全局与项目规则、学习结果容易互相污染。
5. 许多工具默认按 Unix 路径与 symlink 假设，在 Windows 上易失败。

---

## 3. 目标与非目标

### 3.1 目标（MVP）

- 在 **Windows** 上完成：习惯探测/声明 → Source of Truth（SoT）→ 投影到 OpenCode、Codex、Claude Code、Pi。
- 支持用户级与项目级配置；项目覆盖用户。
- 支持习惯声明、薄默认模板、可选外部模板源、`custom` 规则覆盖。
- 支持手动学习提取 → 存储 → 晋升 → 再次 sync 生效。
- 默认**离线可用**（不依赖拉取外部源即可 init → sync）。
- 不依赖符号链接（默认 copy）。
- 路径、换行、配置根目录在 Windows 上行为正确且可测。

### 3.2 非目标（MVP）

- 实时 daemon / 文件监听同步。
- MCP 进程的安装与生命周期管理（只做配置投影）。
- 云同步、多设备账号体系。
- 复杂图形界面（CLI 为主，可选简单 interactive）。
- 无人值守、全自动晋升学习结果。
- 内置大量第三方 Skill 或「个人习惯」断言（如全局默认必须用 fnm）。

---

## 4. 内容分层策略（模板 / Skill / 习惯）

**决策：混合模型 — 引擎内置 + 极薄默认模板 + 可选版本化模板源 + 本地覆盖。**

| 层级 | 内容 | 来源 |
|------|------|------|
| L0 机制 | 探测、合并、投影、learn/promote、Windows 路径 | 内置（发行包） |
| L1 默认模板 | 极薄骨架 `base/default`（结构 + 变量占位） | 内置 |
| L2 可选包 | 规则模板、Skill、MCP 描述 | 显式安装（本地路径 / git pin） |
| L3 本地覆盖 | habits、custom、promoted learnings | 仅本地 SoT |

### 4.1 产品规则

1. **习惯**：只来自 Detector 建议 + 用户编辑的 `habits.yaml`；禁止在内置模板中写死个人工具断言（变量渲染除外）。
2. **规则正文**：内置或已安装模板渲染 + `custom/*` + 已 promote 的 learnings。
3. **Skill / MCP**：MVP 不附带大型目录；通过命令装入 SoT 后再投影。
4. **Windows**：落地默认 **copy**；不依赖 symlink。
5. **离线**：无网络或 `AGF_OFFLINE=1` 时禁止拉取；已安装/已缓存内容仍可用。
6. **信任**：git 源应 pin commit/tag；不自动升级。

---

## 5. Windows 一等公民要求

| 主题 | 要求 |
|------|------|
| 安装与运行 | Windows 可用分发（如 `.exe` 或 npm/bun 全局命令）；PowerShell 5.1+ / PowerShell 7+ 与 cmd 下可运行 |
| 路径 | 规范化绝对路径；支持 `%USERPROFILE%`、`%APPDATA%`、`%LOCALAPPDATA%` |
| 配置根 | 尊重各工具在 Windows 上的实际目录；支持 `AGF_HOME`、`CODEX_HOME` 等覆盖 |
| Shell 探测 | 优先 PowerShell / pwsh / cmd；Git Bash、WSL 为附加信息 |
| 符号链接 | 默认 `skills.copy_mode: copy`；不依赖管理员或开发者模式 |
| 换行 | 默认 **LF**；可配置 `projection.line_ending` |
| 可执行检测 | 考虑 `PATHEXT` 与 `where.exe` 行为 |
| 验收 | **MVP 以 Windows 为门禁**；macOS/Linux 为回归 |

---

## 6. 用户故事

1. 作为 Windows 开发者，执行 `aforge init -i` 后自动识别 fnm/uv，规则中写明约定，避免 Agent 建议 nvm/pip。
2. 作为开发者，修改一处 SoT 后 `aforge sync`，各目标 CLI 同时更新。
3. 作为开发者，将一次调试经验 `learn` 后 `promote`，再 sync，新规则出现在投影文件中。
4. 作为团队成员，项目级规则可提交 Git；个人习惯保留在用户级目录。
5. 作为 CI 使用者（含 Windows runner），sync 只读生效，不写入 learnings。
6. 作为离线用户，不拉外部模板也能完成 init → sync。
7. 作为团队，可从私有 git（pin）添加模板源，不把个人习惯写进发行包。

---

## 7. 功能需求

### 7.1 初始化与探测

- `aforge init [--scope user|project] [-i|--interactive]`
- 探测 Node 版本管理器、Python 工具链、包管理器、现有 `AGENTS.md`/`CLAUDE.md`、Shell 等
- 生成 SoT 目录与默认 profile（Windows 友好默认值）
- 打印将写入的绝对路径列表

### 7.2 习惯与配置

- `habits.yaml`：可声明覆盖探测结果
- `profile.yaml`：目标 Agent、模板 id 列表、MCP、skills 策略、投影选项
- 合并优先级：环境变量 > 项目 > 用户 > 内置默认

### 7.3 规则生成与投影

- 从 SoT 渲染统一规则正文，再投影到各工具原生路径
- 支持 dry-run、marker 保护、幂等写入
- sync 采用全部回滚策略——任一 target 投影失败则全部回滚，保证所有工具投影一致性
- MVP 目标：`opencode` | `codex` | `claude` | `pi`

### 7.4 模板与源

- 内置 `base/default`
- `aforge source add|list|remove|update`
- `aforge template list|enable|disable`
- `aforge skill add|list`、`aforge mcp add`（配置投影）

### 7.5 定制

- `custom/*.md` 始终合并进最终规则
- 习惯与 profile 可手改后 sync

### 7.6 学习与进化

- `aforge learn`：提取候选 learning（交互或 stdin）
- 存入 `learnings/`，带 confidence、scope、source
- `aforge promote <id>`：晋升到 custom 规则或 skill
- 默认 project scope；升到 user 需显式确认
- `auto_promote: false`

### 7.7 运维

- `aforge status`：scope、目标、路径、最近 sync
- `aforge doctor`：一致性、可写性、hash、Windows 路径诊断
- `aforge import <path>`：从现有 AGENTS.md / CLAUDE.md 导入（MVP 基础版：解析 Markdown 中的工具链声明映射到 habits，其余内容归入 custom/）

---

## 8. 成功指标（MVP，Windows 门禁）

### L1 — 验收门禁（Go/No-Go）

1. 干净 Windows 环境从 init 到四工具投影可用 ≤ 5 分钟（含交互，P90，基于 10 名首次用户测试）。
2. 不依赖符号链接即可完成 skills 落地。
3. learn → promote → sync 闭环通过。
4. `doctor` 能报告 SoT 与投影不一致、目标目录不可写。
5. 无网络可走通核心路径（仅内置模板 + 本地 habits）。

### L2 — 质量指标（可自动化测量）

- 探测准确率 ≥ 90%（测试矩阵覆盖 fnm/nvm/volta/system × uv/poetry/pipenv/system × PowerShell/cmd/bash）。
- 投影幂等性：连续两次 sync 输出文件 hash 一致。
- sync 成功率（退出码 0）≥ 95%。

### L3 — 用户体验指标（需人工测试）

- 首次投影时间（Time to First Projection）：从 `aforge init -i` 到第一个投影文件生成 ≤ 3 分钟（P50）。
- 交互步骤数：`init -i` 默认路径 ≤ 5 次确认。
- 错误恢复：退出码 3/4 的错误消息包含可操作的修复建议。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 各 CLI 在 Windows 配置目录不一致 | Projector 按 OS 分支；status/doctor 打印实际路径 |
| 无 symlink 权限 | 默认 copy |
| PowerShell 执行策略 | 优先单二进制 / bunx / npx，避免必须改 ExecutionPolicy |
| 学习质量差 | 人工确认 + confidence；默认不自动进正式规则 |
| 外部模板供应链 | pin commit；显式 update；离线可用已缓存 |
| 上游工具改 schema | 适配器版本化、映射集中维护 |
| 范围膨胀 | 严格按 Phase 砍需求 |

---

## 10. 分阶段路线

### Phase 1 — MVP

- init / detect / sync
- 四 Projector（OpenCode、Codex、Claude、Pi）
- 内置 base/default + custom
- source/template/skill 基础命令（local + git pin）
- learn + promote
- status / doctor
- import 基础版（解析 Markdown 工具链声明）
- Windows 门禁验收

### Phase 2

- 更丰富探测器与可选官方模板仓库
- MCP 字段与上游对齐增强
- import 增强
- 可选 symlink 模式
- Interactive 体验改善

### Phase 3

- Learning 质量启发式
- 适配器插件化
- WSL 互通说明（非门禁）
- CI 示例与文档完善

---

## 11. 文档与交付

- README 以 **Windows PowerShell** 示例为主，旁注 macOS/Linux。
- 路径示例优先 `%USERPROFILE%` 形式。
- 明确：非 Administrator 也可完成 MVP。

---

## 12. 术语表

| 术语 | 含义 |
|------|------|
| SoT | Source of Truth，`.agentforge` 或用户级等价目录 |
| Habit | 工具链与 AI 偏好声明 |
| Profile | 投影目标、模板列表、MCP/skills 策略 |
| Projection | 将 SoT 渲染结果写入各 CLI 原生文件 |
| Learning / Instinct | 从经验提取、待确认的可复用条目 |
| Promote | 将 learning 升为正式规则或 skill |
| Marker | 投影文件中由 AgentForge 管理的可替换区块 |

---

*本文档为 AgentForge 产品需求基线，与 `AgentForge-Spec.md` 配套使用。*
