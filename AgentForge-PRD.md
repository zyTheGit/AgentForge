# AgentForge — Product Requirements Document (PRD)

| 项 | 内容 |
|----|------|
| 产品名称 | AgentForge |
| CLI | `aforge` |
| 文档版本 | 2.0 |
| 状态 | 方向评审后重写（问题陈述、成功指标、分阶段路线） |
| 平台优先级 | **Windows 一等公民**；macOS / Linux 同步支持 |
| 最后更新 | 2026-09-03 |
| 配套修订 | 本版与 `AgentForge-Spec.md` **1.2** 同 PR、同 commit 落地（见 §10 权威声明） |

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

**核心问题：Agent 的项目知识无法沉淀、复用和治理。**

v1.1 把「多工具规则格式碎片化」列为首要问题。AGENTS.md 正在成为跨 CLI 的事实标准（Codex、Gemini CLI、Cursor 等均已采纳），该问题会随标准收敛**部分**自我消解——只投影规则正文的工具终将失去存在理由。因此 2.0 把问题陈述重排为：

1. **会话中的经验无法系统沉淀为可复用、可审计、可回滚的项目知识**（核心，不随标准收敛贬值）。
2. **资产落点仍然碎片化**：规则正文在收敛，但 skills 物化、MCP transport 配置、命令落点、会话钩子在各 CLI 各自为政，一份资产要手工适配多处。口径是「中短期尚无跨 CLI 收敛信号」，非「不会收敛」——详见 [方向评审](docs/direction-review.md) §1。
3. **全局与项目规则、学习结果容易互相污染**，缺少分层治理与漂移检测。
4. 现有生成/同步工具多不感知个人工具链（fnm、uv、pnpm 等），Agent 仍会建议 nvm/pip。
5. 许多工具默认按 Unix 路径与 symlink 假设，在 Windows 上易失败；路径与配置目录尤其不统一。

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

1. 干净 Windows 环境从 init 到四工具投影可用：**主证据是入库 `scripts/` 的自动计时脚本**（干净环境重复采集），**≥ 3 名独立 dogfood 参与者只作佐证**；判据为**全员 ≤ 5 分钟且 P50 ≤ 3 分钟**（含交互）。P50 值与 §8 L3 的 TTFP 同口径，两处须保持一致。
   > **样本量口径变更注记（2026-09-03，非门禁缩水）**：v1.1 写的是「P90 ≤ 5 分钟，基于 10 名首次用户测试」，该测试自始无执行记录、无计划书与计时脚本。3–5 人样本下 P90 ≈ 最慢单人，一人环境异常即判死，无统计意义；且「全员 ≤ 5min」本质仍是 max 判据，同样脆弱。故把**主证据改为可重复执行的自动计时脚本**，人数下调为佐证（用于暴露交互卡点）。门禁值 5 分钟本身未放宽，并额外增加了 P50 ≤ 3 分钟这一更强约束。裁决过程见 [方向评审](docs/direction-review.md) §3.1。
2. 不依赖符号链接即可完成 skills 落地。
3. learn → promote → sync 闭环通过。
4. `doctor` 能报告 SoT 与投影不一致、目标目录不可写。
5. 无网络可走通核心路径（仅内置模板 + 本地 habits）。
6. **无实证不宣称**：任何在 README / 文档中以「主打」或「已支持」表述的能力，必须先补齐它自己列出的实机验证缺口；未补齐时只能写「主路径可用、待实证」。

### L2 — 质量指标（可自动化测量）

- 探测准确率 ≥ 90%（测试矩阵覆盖 fnm/nvm/volta/system × uv/poetry/pipenv/system × PowerShell/cmd/bash）。
- 投影幂等性：连续两次 sync 输出文件 hash 一致。
- sync 成功率（退出码 0）≥ 95%。

### L3 — 用户体验指标（需人工测试）

- 首次投影时间（Time to First Projection）：从 `aforge init -i` 到第一个投影文件生成 ≤ 3 分钟（P50）。**与 §8 L1 第 1 条的 P50 同一口径与同一采集脚本，改一处必须改两处。**
- 交互步骤数：`init -i` 默认路径 ≤ 5 次确认。
- 错误恢复：退出码 3/4 的错误消息包含可操作的修复建议。

### L4 — 路线触发信号（决定是否解冻 target 扩展）

新 target（Cursor / Copilot / Gemini 等）的投入分两级解冻，避免产品方向被第一个提需求的用户绑架，也避免有场景的请求被无限搁置：

- **单个**附带完整使用场景说明的 issue/反馈 → 只解冻**调研**（读上游配置格式、评估数据-only 声明式适配器可行性，不写实现）；
- **≥ 2 个独立来源**的同类请求 → 解冻**实现**。

未达门槛时，声明式适配器维持「机制保留、能力面不扩」（见 [方向评审](docs/direction-review.md) §2.2）。

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

> **权威声明：本节是 Phase 划分的唯一权威。** `AgentForge-Spec.md` §12 只做「阶段名 → 技术项」的映射，不再自带独立阶段清单；`docs/roadmap.md` 记录实现状态，同样以本节为准。**阶段划分或阶段名变更须与 Spec §12 在同一 PR 内联改**，禁止单侧修改。

### Phase 1 — MVP（已完成）

- init / detect / sync
- 四 Projector（OpenCode、Codex、Claude、Pi）
- 内置 base/default + custom
- source/template/skill 基础命令（local + git pin）
- learn + promote
- status / doctor
- import 基础版（解析 Markdown 工具链声明）
- Windows 门禁验收

### Phase 2（已完成）

- 更丰富探测器与可选官方模板仓库
- MCP 字段与上游对齐增强
- import 增强
- Interactive 体验改善

> `skills.copy_mode: symlink` 已决定**不予实现**，不列入任何 Phase（与 prune 判据冲突、Windows 默认无创建权限、四家客户端读取行为未实测），理由见 Spec §4.2。

### Phase 3（已完成）

- Learning 质量启发式
- 适配器插件化
- WSL 互通说明（非门禁）
- CI 示例与文档完善

### Phase 4 — Learning 捕获（当前阶段）

问题陈述 §2 第 1 条对应的阶段，也是下一阶段**唯一集中投入**的方向。待验证假设：闭环的瓶颈在**捕获**而非管理。

- 捕获路径可发现性：`learn --print-protocol` 接 `learn --file -` 的衔接示例、`prompt` 档协议正文打磨、无钩子能力的三家的手工挂载写法文档化
- `scripts/` 计时脚本入库（供 §8 L1 主证据使用）
- **不含** claude 侧 `auto_capture: hook` 落点：已随 issue #56 决议不做，重启需先推翻 `docs/learning.md` 记录的四条安全前提

### Phase 5 — Skills 主打（准入前置：实机验证）

- 对外叙事从「附属功能」升为主打：Skills 跨 CLI 分发
- **准入前置**：issue #54 中 codex 显式 `$name` 调用的实机验证完成后才可宣称（§8 L1 第 6 条）
- MCP transport 归属「交付保障」，只做维护，不与 Skills 合并宣称「均已验证」

### Phase 6 — target 扩展（条件解冻）

- 触发条件见 §8 L4 的两级门槛（单个带完整场景 → 解冻调研；≥ 2 个独立来源 → 解冻实现）
- 解冻后用数据-only 声明式适配器扩 target，不为此开放可执行代码投放

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
| Learning | 从经验提取、待确认的可复用条目（早期文档曾并称 Instinct，现已不使用该词） |
| Promote | 将 learning 升为正式规则或 skill |
| Marker | 投影文件中由 AgentForge 管理的可替换区块 |

---

*本文档为 AgentForge 产品需求基线，与 `AgentForge-Spec.md` 配套使用。*
