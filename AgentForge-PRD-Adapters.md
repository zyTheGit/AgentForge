# AgentForge — 声明式适配器扩展 PRD：Cursor / Gemini CLI / Grok Build

| 项 | 内容 |
|----|------|
| 产品名称 | AgentForge（`aforge`） |
| 文档类型 | 功能增量 PRD（母文档：`AgentForge-PRD.md` 2.0） |
| 状态 | 草案（2026-09-04 三方评审共识稿） |
| 平台优先级 | **Windows 一等公民**；macOS / Linux 同步支持 |
| 前置依赖 | Phase 3 声明式适配器（issue #53）：`Projector` 契约收口 + `adapters/<id>.yaml` 两层发现；**Phase 0 护栏 PR 先合**（见 §4） |
| 配套文档 | `docs/profile.md#声明式适配器第三方-target`、`docs/roadmap.md`、`docs/platform.md`、`docs/mcp.md`、`docs/direction-review.md` §3.1 |
| 评审记录 | 2026-09-04 三方评审（opencode `grok-4.6` / pi `deepseek-v4-pro` / codex `gpt-5.6-terra`），三轮收敛，决议 D1–D7 已并入本文（附录 §8） |

---

## 1. 概述

### 1.1 定位

在**不改核心引擎**（前置护栏修补除外，见 §4 Phase 0）的前提下，用现有两层插件机制接入三个新的 AI Coding CLI target：Cursor、Gemini CLI、Grok Build。以这三个真实样本验证声明式适配器的表达力边界，并把验证过程中发现的「需要内置 projector 才能覆盖」的差距**收敛回声明式 schema**，而不是为新工具各开一条代码通路。

### 1.2 背景与问题陈述

1. **资产落点碎片化仍在继续**（母 PRD §2.2）：新 CLI（Cursor / Gemini CLI / Grok Build）各自引入了 skills、MCP、命令的落点约定，用户手工维护多份的成本随工具数量线性增长。
2. **规则正文收敛、落点未收敛**：三家均已采纳或兼容 `AGENTS.md`（规则正文层面趋同），但 skills 目录、MCP 配置格式、命令文件格式仍各自为政——这正是 AgentForge 投影层要吸收的差异化。
3. **声明式适配器的能力边界未经过多样本校验**：issue #53 落地后只有「可声明的都是什么」的理论答案，缺一组真实 target 的实测校准。本 PRD 的三个样本恰好覆盖三种情形：**完全声明式（Cursor）、声明式 + 小 schema 扩展（Gemini CLI）、撞上 `merge_toml` 边界（Grok Build）**。

### 1.3 一句话价值

把 `adapters/*.yaml` 放进用户级 SoT 即可让三个新 CLI 获得与内置四 target 同等的投影能力（prune 记账、事务回滚、doctor 比对、`--targets` 过滤全部自动继承）；**Phase A 在一项前置护栏修补之外核心引擎零改动**，Phase B/C 只扩展通用声明式契约、不新增 target 专属 projector 分支。

---

## 2. 目标与非目标

### 2.1 目标

1. **Cursor**：纯声明式适配器（`adapters/cursor.yaml`），除 Phase 0 护栏外零代码改动即可 `sync` 全量产物；Phase A 只做 project scope（官方存在 `~/.cursor/mcp.json` 与 `~/.cursor/skills/`，user scope 实测后另开）。
2. **Gemini CLI**：声明式适配器 + 命令薄壳扩展（`format` / 扩展名 / `arguments_placeholder` / `namespace` 一组字段，见 §3.2）；MCP 先按 stdio 显式降级，探针实测后再定表达方式。
3. **Grok Build**：把 codex 已有的 TOML MCP 序列化能力下沉为具名内置 dialect `mcpServersToml`（共享序列化器 + **dialect 内建字段映射**），使 Grok 同样可声明式接入；`GROK_HOME` 进入模板环境变量白名单。
4. **能力矩阵沉淀**：PRD 新增「能力 × target × 实际行为 × sync 提示 × doctor 条目 × 验收断言」矩阵表；sync advisory / status / doctor **共用同一能力注册表**（一处定义、多处消费，warn item id 与计数口径固定）。三个 target 的 on_demand / 命令命名空间 / MCP transport 支持情况实测后进 `docs/platform.md` 已知限制与 doctor 降级提示，口径与既有四家一致（实测未知 → 显式降级 + warn，不静默失效）。
5. **文档闭环**：`docs/profile.md`（适配器写法与取值域）、`docs/skills.md`（on_demand 支持矩阵）、`docs/platform.md`（transport 探针结论行）、`docs/roadmap.md`（完成度标记）、`docs/mcp.md`（transport 矩阵证据入口）**五件套**同 PR 更新；文首引用 `docs/direction-review.md` §3.1 的解冻依据（issue 列表）。

### 2.2 非目标

1. **不引入动态代码插件**（`.agentforge/plugins/*.js` 之类）：声明式 YAML 是唯一对外扩展点，代码级新 target 走内置 projector + PR。理由见 `src/core/adapters/discovery.ts` 头注释（供应链投递面）与 `docs/roadmap.md`。
2. **不接 Cursor `.cursor/rules/*.mdc`**：Cursor 原生读 `AGENTS.md`，主规则走既有语义；`.mdc` 的 frontmatter 规则体系不属于「规则正文收敛」的范畴。
3. **不接 Grok 的 `~/.agents/commands/`**：这是 `agents.md` 生态的共享目录，被多个工具读取，写入冲突面不可控；Grok 命令投影跳过，跳过原因经 `commands.skip(+reason)` 能力字段进 doctor/status 展示（见 §3.3）。
4. **不做 MCP 进程生命周期管理**（母 PRD §3.2 延续）：只投影配置。
5. **不承诺 `skills.on_demand` 在新 target 上无损**：逐家实测后按支持矩阵落位（见 §5 风险）。声明式路径只走 frontmatter 注入（无 codex 式 sidecar），若某家需要 sidecar 机制则声明式层表达不了，须记录为已知限制。
6. **不做参数化 / 用户自声明 MCP 字段映射**：字段映射只能内建于具名 dialect。推迟到「≥2 个 target 都需要非标准 MCP 形状」时，按 `direction-review.md` §3.1 同口径再评估。
7. **不做 skills 条件投影**（「兄弟 target 启用时跳过本 target 的 skills 投影」）：本轮以「默认投影 + 文档指引 + doctor warn」处理共存重复（见 §5.6），条件投影另开 issue 评估。

---

## 3. 各 target 落点事实与适配方案

> 落点事实来源：Cursor / Gemini CLI / Grok Build 官方文档（2026-09 检索），实现前须逐条复核（复核落点 = §6.7 探针清单）。参考链接：Cursor skills <https://cursor.com/docs/skills>；Gemini skills / commands / MCP <https://geminicli.com/docs/cli/skills> · <https://geminicli.com/docs/cli/custom-commands/> · <https://geminicli.com/docs/tools/mcp-server/>；Grok settings / MCP <https://docs.x.ai/build/settings> · <https://docs.x.ai/build/features/mcp-servers>。

| 能力 | Cursor | Gemini CLI | Grok Build |
|------|--------|-----------|------------|
| 主规则 | 仓库根 `AGENTS.md`（原生读取） | 项目根 + `~/.gemini/GEMINI.md`（优先级待实测，见 §6.7） | 仓库根 `AGENTS.md`（原生读取，零配置） |
| Skills | `.cursor/skills/<name>/SKILL.md`；**上游同时扫 `.agents/skills/` 等兄弟目录**（待探针确认，口径见 §5.6） | `.gemini/skills/<name>/SKILL.md`（较新特性，递归 / user 级待实测） | `.grok/skills/<name>/SKILL.md`（项目 + 用户级），支持 `disable-model-invocation` |
| MCP | `.cursor/mcp.json`（`mcpServers`，JSON） | `.gemini/settings.json`（`command`/`url`/`httpUrl` 三种互斥入口，无 Claude `type` 判别；是否容忍 JSONC 待探针） | `.grok/config.toml`（`[mcp_servers.<name>]`，**TOML**） |
| 命令 | `.cursor/commands/*.md`（Markdown，命名空间呈现待实测） | `.gemini/commands/*.toml`（`description` + `prompt`，占位符 `{{args}}`） | `~/.agents/commands/`（共享目录，**跳过** + `commands.skip` 展示） |
| 调用前缀 | `/` | `/` | `/` |
| home 覆盖变量 | — | — | `GROK_HOME`（需进白名单，判据见 §3.3） |

### 3.1 Cursor —— 纯声明式（Phase A）

```yaml
# adapters/cursor.yaml（可过 schemas/adapter.schema.json 的完整草案）
version: 1
id: cursor
description: Cursor（project scope；user scope 实测后另开）
main_rule:
  toggle: agents_md        # 受 write_agents_md 开关控制（§8.7 语义），false 时可关掉
  action: merge_marker     # 与内置 opencode/codex/pi 共用同一对 marker，同写根 AGENTS.md 幂等共存
mcp:
  dialect: mcpServers      # .cursor/mcp.json，merge_json（claude 形状；探针结论落位前不得硬套，见下）
scopes:
  project:
    base: '{projectRoot}/.cursor'
    skills_dir: '{base}/skills'
    commands_dir: '{base}/commands'
    mcp_file: '{base}/mcp.json'
    main_rule: '{projectRoot}/AGENTS.md'
```

- **主规则口径**：Cursor/Grok 读的是仓库根 `AGENTS.md`，该文件同时是内置三家的投影产物。采取「适配器自行声明 `main_rule` + `merge_marker`」方案：marker 恒取 profile 配置的同一对，同写幂等；`toggle: agents_md` 使其与内置 target 同受 `write_agents_md` 控制。不采用「依赖内置 target 同轮写入」方案——`targets: [cursor]` 单独启用时将无人写规则文件。
- **MCP 前提探针**：`mcpServers` 是 claude 形状（`type: stdio|http|sse` + 统一 `url`）。Phase A 必须实测 Cursor 对多余 `type` 字段、对 `http`/`sse` transport、对 `~/.cursor/mcp.json` 的行为；**若被拒绝，则 A 先发不含 `mcp_file` 的 yaml 或对 MCP 显式降级，不得硬套写出错误形状**。探针结论进 `docs/platform.md` 矩阵行（字段形状归 dialect、transport 支持度归上游客户端，二者解耦；实测前由 Phase 0 的 `unmeasured` warn 占位）。
- `merge_json` 的「管理键 + 未知键保留」语义适配 `mcp.json`；`mcp.soft` 只复用引擎既有 best-effort 语义，不自定义失败行为。
- 无 user scope 声明：`~/.cursor/mcp.json` / `~/.cursor/skills/` 是否生效由实测决定后再补，官方文档已见用户级落点，**不写「无用户级」**。

### 3.2 Gemini CLI —— 声明式 + 命令格式扩展（Phase B）

- **主规则 / skills**：声明式覆盖。已知限制（三处同口径记录：`src/schema/adapter.ts` 注释、`docs/profile.md`、doctor 条目）：`main_rule.toggle` 枚举无 `GEMINI.md` 档，GEMINI.md 只能 `toggle: always` 写、不受 `write_agents_md` / `write_claude_md` 开关控制。
- **MCP（先降级）**：`settings.json` 的 `mcpServers` 形状与 claude 不同（`command`/`url`/`httpUrl` 互斥入口、无 `type` 判别，另有 `timeout`/`trust`/`cwd`/`oauth`）。Phase B 默认**只投 stdio，其余 transport 显式 warn**（D3 选项 ii）；探针实测后若可行，再以新具名 dialect（如 `geminiSettings`）落地——参数化映射不在菜单上（§2.2 目标 6）。**探针前置**：`.gemini/settings.json` 是否容忍 JSONC——现 `merge_json` 走 `JSON.parse`，带注释会 `ConflictError(3)`，不能默认当严格 JSON。它是胖配置文件（模型/主题/oauth token 路径），须写明：损坏 JSON → `ConflictError(3)`；并发被 Gemini 重写的窗口风险类比 issue #52，禁止把共享运行时文件扩面。
- **命令薄壳扩展（一组字段，缺一不可）**：`commands.format: md | toml`（缺省 `md`）+ 扩展名（`.md` / `.toml`）+ `arguments_placeholder: $ARGUMENTS | {{args}}` + `namespace: subdir | flatten | colon`（Gemini 子目录 → `/ns:name` 冒号呈现）。TOML 分支把薄壳字段序列化进 `description` / `prompt` 两键；`$1..$9` / `$ARGUMENTS` 归一化已在 SoT 侧完成，直接复用；`$` 在 TOML basic string 中的转义规则与三引号冲突、CRLF、description 缺省行为一并定义（优先复用/下沉 codex 的 TOML 序列化器，不写第三份拷贝）。
- **降级路径**：若 Phase B 排期紧张，`gemini.yaml` 先不声明 `commands_dir`（命令投影跳过），schema 扩展单独成 PR。
- **停损条件（可判定）**：B 开工前复核一次官方文档；若 Gemini CLI 已被 Antigravity CLI 取代、官方文档下架（404/归档）或配置格式作废，则停 B，不把 schema 扩展绑死在可能消失的产品上，中途命中同样停。

### 3.3 Grok Build —— TOML MCP dialect 下沉（Phase C）

- 主规则 / skills 声明式覆盖；skills 的 frontmatter 兼容度最好（支持 `disable-model-invocation`），`skills.on_demand` 预期无损（实测确认后落位）。
- **卡点**：MCP 在 `.grok/config.toml` 里是 `[mcp_servers.<name>]` TOML 表——`merge_toml` 是声明式适配器显式排除的动作（TOML 序列化无法声明式表达）。
- **方案（收敛而非绕行）**：增加具名内置 dialect `mcpServersToml`，定义 = 「TOML 标记段序列化（`# BEGIN/END AGENTFORGE MCP`，下沉 codex projector 的共享实现）+ **dialect 内建字段映射**」。映射要点：Grok 远程 MCP 头字段按官方文档为 `headers`（非 codex 的 `http_headers`），SSE/HTTP 各写一格矩阵，实机探针确认后才固化；**共享的是序列化器，不是 codex 的字段形状**。同步明确合并契约：plan item 动作、tomlMarkers 携带方式（codex 现为 plan 级）、空 server 行为、非法既有 TOML 处理、同名用户手写 `[mcp_servers.<name>]` 冲突策略、移除 server 后标记段整段重写的 prune/记账语义。
- **安全边界口径**：`merge_toml` **不**进适配器 yaml 动作域——它是「内置 dialect 消费共享序列化器」，不是开放自由 TOML。`schema/adapter.ts` 头注释、`discovery.ts`、`docs/profile.md` 边界表、`docs/mcp.md` 矩阵的「merge_toml 永不开放」文案随 PR 改写为上述口径。
- **配套**：`GROK_HOME` 加入 `ADAPTER_ENV_WHITELIST`。入选判据与 `CODEX_HOME` / `PI_CODING_AGENT_DIR` 同源——须官方文档证明 `GROK_HOME` 是 Grok 定位配置根的变量；取值守卫复用 `core/paths.resolveOverridableDir` 同款判据（`~` 展开、相对 / UNC / 越界 symlink 拒绝），不在 adapters 层另写一套。后续工具的 home 覆盖变量走同一条路（白名单 + containment），不另开门。
- **降级显式化**：`commands.skip`（带 reason）为纯展示能力字段（语义见 §2.1 目标 4），表达「Grok 命令跳过 + 原因」，schema 上与 `commands_dir` 互斥。
- 兜底：若 dialect 下沉被否决，Grok 退回内置 projector（复用 codex 的 merge_toml 机制），但这是次选——它意味着「每接一个 TOML 系工具就要一个内置 projector」的先例。

---

## 4. 分阶段路线

| 阶段 | 内容 | 出口判据 |
|------|------|----------|
| **0. 护栏（前置，独立 issue + 独立 PR）** | 修 Phase 3 遗留崩溃：`collectMcpTransportNoticesForTargets`（`src/core/project/projectors/mcp-transport.ts:150`，入口还有 `check-mcp-transport.ts:44`）把 target id 强转为四家内置联合类型后查 `MCP_TRANSPORT_MATRIX`，声明式 id + SoT ≥1 个 enabled MCP server 时 sync/doctor TypeError 崩溃。改法：`as` 强转改显式守卫；未实测/声明式 id **跳过矩阵查询 + 每 target 一条 `mcp-transport/<id>-unmeasured` warn**（实测落位前的占位，非每 server 一条）；更新 `sync-notices.ts:239` 过时注释。 | 护栏 PR 合入；单测覆盖「声明式 id + enabled MCP server 不崩溃、warn 恰一条、plan 产物不变」 |
| **A. Cursor** | `cursor.yaml` + doctor/status/status-adapters 验证。diff 仅含 `cursor.yaml` + 文档 + 测试 fixture | Windows 门禁：多 target（cursor + 内置三家）同写根 `AGENTS.md`，第一轮 ≥1 个 `written` 且无 error、第二轮全 `unchanged`；`doctor` 0 error（允许已登记矩阵 warn）；prune 记账含 cursor 产物；`--targets cursor` 生效；MCP 探针结论落 `docs/platform.md` |
| **B. Gemini CLI** | `gemini.yaml` + 命令薄壳 schema 扩展（§3.2 一组字段） | 同 A 口径 + `gemini.yaml` 声明的命令经 `/ns:name {{args}}` **实机可调用**（而非仅「合法 TOML」）；JSONC / transport 探针结论落矩阵 |
| **C. Grok Build** | `mcpServersToml` dialect 下沉 + `GROK_HOME` 白名单 + `grok.yaml` | 同 A 口径 + Grok 实机连接 MCP server 成功（含远程头字段映射验证）；schema/文档/测试同步落地 |

每阶段独立成 PR，均可单独回滚；A 完成即向用户发布「**已验证一个纯声明式样本**」的信号（不泛化为「声明式适配器已验证」——B/C 正是在验证两个关键边界），不阻塞 B / C。

**实测口径（各阶段统一）**：沿用仓库既有先例（codex 0.147.0 / opencode 1.15.13 / pi-mcp-adapter 2.32.1），把「版本号 + 实测命令 + 探针哨兵串 + 观察现象」写进 docs 作为证据；「实机可调用 / 连接成功」不作为不可复现的验收话术。

---

## 5. 风险与开放问题

1. **未公开契约风险**（同 pi `httpTransport: "sse"` 先例）：Grok 的 `[skills] paths` / `disable-model-invocation` 等行为若属未公开契约，按「已验证但依赖实现细节」记录，上游收回不算 breaking change，届时重验。
2. **on_demand 支持矩阵待实测**：Cursor / Gemini CLI 对未知 frontmatter 键（`disable-model-invocation`）的行为未知（忽略 / 生效 / 拒载），按 opencode 先例预期「键被忽略、技能仍进清单」，实测后经能力注册表落位，doctor 报 `skills-on-demand/<id>-unsupported` warn。注意声明式路径只走 frontmatter 注入，无 sidecar 机制；声明式 target 的 on_demand 支持位只驱动 warn（正文已在 SoT 侧注入）。
3. **Gemini skills 目录是较新特性**：`.gemini/skills/` 的发现规则（是否递归、是否读 user 级、与 `.agents/skills/` 的同层优先级）需实机确认后再定 `skills_dir` 模板。
4. **`merge_json` 数组语义不扩**：本次不触碰会话钩子（issue #56 的前置条件），三个新 target 的 `learning.auto_capture: hook` 档均等同 `off` + 显式降级提示，与 claude / opencode / pi 同口径。
5. **白名单扩容先例**：`GROK_HOME` 进 `ADAPTER_ENV_WHITELIST` 的判据见 §3.3；`schema/adapter.schema.json` 描述、`docs/profile.md` 白名单清单、环境诊断输出与测试同 PR 更新。
6. **skills 与兄弟目录扫描的重复投影**：Cursor/Gemini 官方会扫描 `.agents/skills/` 等兄弟目录（codex 的落点），多 target 并存时技能会在**上游清单**重复——重复来自「投影落点」与「上游扫描规则」的重叠，不是 AgentForge 写重。口径：AgentForge 自身不向共享扫描目录重复投影；上游扫描导致的重复经 doctor warn + `docs/skills.md` 已知限制处理，**不算出口失败**；「是否可关兄弟目录扫描」列入探针，条件投影（§2.2 非目标 7）另开 issue。
7. **`skills_dir` 必填 → 可缺省**（**已落地**，PR #90）：原 schema（`schemas/adapter.schema.json` 与 `docs/profile.md`）要求每个已声明 scope 的 `skills_dir` 必填，导致「与 codex 并存时删去 `skills_dir` 借道 `.agents/skills/`」这条文档推荐的做法压根写不出来。现已改为可缺省（缺省 = 不投影技能，与 `commands_dir` / `mcp_file` 同口径）；`Projector.skillDir` / `skillPath` 契约位的空值行为定为抛 `ConfigError`，调用方跳过（`skill add` / `remove` 的提示行少列一个 target，命令照常成功）。遗留：四个落点字段对「声明了但变量算不出来」的口径仍不统一（`skills_dir` 报错 → 整份适配器被拒；另三个静默跳过，而这可能是跨平台 fallback 的有意写法），另开 issue 定夺。
8. **Gemini CLI 产品存续**：已进入向 Antigravity CLI 迁移阶段（停损条件见 §3.2），B 开工前与中途各复核一次。

---

## 6. 验收标准

1. **Windows 门禁**（母 PRD §5 延续）：三个 target 的 init → sync → sync → doctor 全链路在 Windows 实机通过；第二轮 sync 全 `unchanged` 且 content hash 稳定。多 target 同写根 `AGENTS.md` 用例按 §4 Phase A 口径断言（含 `write_agents_md: false` 与 `marker_mode: none` 覆盖）。
2. **隔离性**：三个新 target 的产物全部落在 containment 允许根内；恶意适配器（落点逃逸、超深路径、超量文件）被既有校验拒绝，无需新增防御代码。`GROK_HOME` 指向相对路径 / UNC / 越界 symlink 时被 `validatePath` + containment 拒绝（合法绝对路径放行）。
3. **零内核改动验证 Phase A**：Phase 0 护栏已**单独合入**（不并入 A 的 diff）；A 的 diff 只包含 `adapters/cursor.yaml` + 文档 + 测试 fixture，不触碰 `src/`、`schemas/`——这是「两层插件机制成立」的直接证明。「内核」边界口径：`src/core/`、`src/schema/`、`schemas/` 属内核；Phase B/C 允许按 §3.2/§3.3 扩展通用声明式契约触碰这些目录，但**不新增 target 专属 projector 分支**。各阶段预期 diff 面在 PR 描述中列出。
4. **降级显式化**：每个不支持的能力（Grok 命令、on_demand 未支持项、hook 档、非 stdio transport）都有 sync 提示行 + doctor 条目 + status 展示，三者共用同一能力注册表，warn item id 与计数口径固定；「能力 × target × 行为 × 提示 × 断言」矩阵表随 PR 落地。
5. **验收断言场景化**（替代笼统的「doctor 0 error」）：实际产物精确内容断言；用户未知 JSON/TOML 键保留断言；预期 warning 的 item id 与条数断言；**反向测试**——删除 skill / command / MCP server 后 prune 干净、手改 marker 内外内容后的冲突处理、损坏 JSON/TOML 的 `ConflictError(3)`、`GROK_HOME` 切换后 re-sync 行为；`--targets` 子集 sync 不影响其他 target 产物。
6. **文档五件套更新 + 实测证据落盘**：`docs/profile.md` / `docs/skills.md` / `docs/platform.md` / `docs/roadmap.md` / `docs/mcp.md`，探针结论进 `docs/platform.md` 矩阵行；版本号 + 实测命令 + 探针哨兵 + 观察现象按 §4 实测口径写入。
7. **探针清单（实现前逐条复核，结论进矩阵）**：
   - Cursor：多余 `type` 字段 / `http` / `sse` 容忍度；`~/.cursor/mcp.json` 是否生效；skills / commands 是否递归、命名空间呈现（subdir / flatten）；是否可关兄弟目录扫描。
   - Gemini：`.gemini/settings.json` 是否容忍 JSONC；项目根规则文件（`GEMINI.md` vs `AGENTS.md`）与 `~/.gemini/GEMINI.md` 的读取优先级；`.gemini/skills/` 递归与 user 级；命令 TOML 的 `{{args}}` 展开、`$` 转义、三引号冲突、CRLF、description 缺省。
   - Grok：`[mcp_servers.<name>]` 单表 vs 数组表；远程头键名（`headers` vs `http_headers`）；`# BEGIN/END AGENTFORGE MCP` 标记段容忍度与运行时是否重写 `config.toml`；`GROK_HOME` 语义（配置根 vs 数据根）；skills 权威路径。
   - 三家：`disable-model-invocation` 实际行为（忽略 / 生效 / 拒载）；上游是否扫 `.agents/skills/` 等兄弟目录。

## 7. 成功指标

- 用户接入一个新 CLI（三家范围内）的成本从「写 TS projector + 发 PR」降为「放一份 YAML」；
- Phase A 交付「一个纯声明式样本」的直接证明（diff 不含内核）；Phase B / C 分别校准「命令薄壳跨格式」与「TOML MCP dialect」两个关键边界，`commands` 扩展组与 `mcpServersToml` 沉淀为可复用能力，后续 TOML 系 / TOML 命令系工具接入不再需要内核改动；
- Phase 3 遗留的 transport 矩阵崩溃在前置 PR 中修复并补齐类型守卫，声明式 target 的能力矩阵从此有显式落位通道（`unmeasured` 占位 → 实测行）。

## 8. 附录：评审共识记录

- 2026-09-04，三轮（独立评审 → 交叉评议 D1–D7 → 合并案表态），与会者：opencode（`opencode-go/grok-4.6`）、pi（`deepseek/deepseek-v4-pro`）、codex（`gpt-5.6-terra`）；主持：ZCode。
- 全票通过：D1 护栏前置独立 PR（采纳 pi「blocker」修正与 codex「能力注册表」措辞）、D2 根 `AGENTS.md` 由适配器声明 `main_rule` 幂等共存、D3 具名 dialect / 不做参数化映射 / Gemini 先 stdio 降级、D4 能力字段只读事实化、D6 `GROK_HOME` 白名单判据、D7 Gemini 已知限制与停损条件。
- 分歧收敛点：D5（skills 重复投影）三方一致选**乙案**——默认照常声明 `skills_dir` + 文档指引 + doctor warn，实测前置探针，条件投影另开 issue；opencode 补充 `skills_dir` 须改可缺省，pi 补充「实测结论是 warn 的触发依据」。
- 三方共同核实的实现事实（已并入正文）：transport 矩阵崩溃路径（`mcp-transport.ts:150`、`sync-notices.ts:240`、`check-mcp-transport.ts:44`）；`skills_dir` 评审当时必填（现已改为可缺省，见 §5.7）；`main_rule` 分顶层开关 / scope 落点两层；dialect 枚举现状 `mcpServers | opencode`；`ADAPTER_ALLOWED_ACTIONS = ['write','merge_marker','merge_json']`。
