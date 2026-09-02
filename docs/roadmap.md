# 路线图与实现状态

这份文档是「哪些能力已经能用、哪些还没有」的单一入口。分阶段规划的权威来源是 [Spec §12](../AgentForge-Spec.md#12-分阶段技术) 与 [PRD §10](../AgentForge-PRD.md#10-分阶段路线)；字段级的行为边界见 [平台注意事项与已知限制](platform.md#已知限制)。

约定：**已实现** = 有代码且有测试覆盖；**部分实现** = 主路径可用，留有明确的契约位；**未实现** = schema/文档已登记，运行时无行为；**不予实现** = 已决策放弃，不列入任何 Phase。

## Phase 1 — MVP（已完成）

- `init` / `detect` / `sync` / `status` / `doctor`
- 四 Projector：opencode、codex、claude、pi
- 内置 `base/default` 模板 + `custom/` 逐字规则
- `source` / `template` / `skill` 基础命令（local + git pin）
- `learn` + `promote` 闭环、`learning.auto_capture: prompt`
- Commands 投影（含命名空间与 `$1..$9`，见 [技能](skills.md#额外投影成命令expose_as_command)）
- `import` 基础版、`bundle export/import`
- Windows 门禁验收（[Spec §11.2](../AgentForge-Spec.md#112-mvp-验收必须在-windows-上执行)，16 条）

## Phase 2（已完成）

- **已实现** — Commands 命名空间 + `$1..$9` 归一化；Interactive `init` 体验（提前落地）
- **已实现** — MCP 字段与上游对齐：`stdio` / `http` / `sse` 三态按 target 逐格归一化，能力矩阵是 `src/core/project/projectors/mcp-transport.ts` 的 `MCP_TRANSPORT_MATRIX`（单一事实源）。上游表达不了的两格显式降级而非静默：opencode × `sse` 降级为 streamable HTTP、codex × `sse` 整条跳过，`sync` 与 `doctor` 各报一条。用法与矩阵见 [MCP](mcp.md#transport--target-支持矩阵)
- **已实现** — 更丰富探测器：在 node/python/包管理器/rust/go/shell 之外新增 java（`sdkman` > `jenv` > `jabba` > `mise` > `asdf`）、dotnet（只有 `system` / `none`）、monorepo（`nx` > `turbo` > `lerna` > `rush` > `pnpm-workspace`）、CI（`github-actions` > `gitlab-ci` > `circleci` > `jenkins` > `azure-pipelines`）。**边界**：这四类只写进 `habits.detected`，声明侧字段（`runtime.java` 等）尚未定义、不参与渲染，判据见 [habits.yaml](habits.md#detected-快照结构)
- **已实现** — 可选官方模板仓库：`init` 往 user 层 `sources.json` 播种一条 `official`（pin 到 tag，**默认禁用**、零网络），`aforge source enable official` 才启用。**边界**：官方仓库当前没有 `manifest.yaml`（走目录扫描回落），且 `disable` 挡不住已拉取缓存被 `resolveTemplate` 渲染——这两项收在 issue [#55](https://github.com/zyTheGit/AgentForge/issues/55)，行为与规避方式见 [命令速查](commands.md#官方模板源默认注册默认禁用)
- **已实现** — `import` 增强：文件识别改为声明式规则表（8 种，含 `.cursor/rules/*.mdc` 与 `.github/copilot-instructions.md` 的目录判据），工具链关键词扩到 9 类且词边界安全，见 [命令速查](commands.md#import-可识别的文件与关键词覆盖)
- **已实现** — `skills.on_demand` 按需装载：正文照常物化投影，区别是**不进模型的自动路由清单**（claude / pi 注入 frontmatter `disable-model-invocation: true`，codex 写 sidecar `agents\openai.yaml`）。**边界**：opencode 无对应开关——实测确认注入那一行对它是真正的空操作（未知 frontmatter 键被忽略，技能仍进模型清单），`doctor` 显式告警；codex sidecar 的字段路径 `policy.allow_implicit_invocation` 已实机验证正确。仍未验证的只剩 codex 侧 on_demand 技能的显式 `$name` 调用（见下「已知遗留」）。验证方法与观察到的现象见 [技能](skills.md#按需装载on_demand)

## Phase 3（已完成）

- **已实现** — Learning 质量启发式：省略 `--confidence` 时按六个信号加权自动打分（落在 `[0.2, 0.9]`），读时做时间衰减（宽限 30 天 / 半衰期 90 天 / 地板 `base x 0.25` / 180 天标 stale），判重换成字符 trigram Jaccard 两档阈值（`>= 0.92` 重复、`0.65-0.92` 建议合并）。**边界**：只给提示，不做自动静默合并（属「非目标」）。见 [learning](learning.md#confidence自动打分时间衰减相似度判重)
- **已实现** — `learning.auto_capture: hook`：codex 侧产出 `hooks.json`（`SessionStart` 钩子调只读的 `aforge learn --print-protocol`）。**边界**：判据是"能不能只靠写配置数据把钩子装上"，claude（钩子并入共享 `settings.json` 数组）/ opencode（需 plugin 代码）/ pi（需 extension 代码）三家**仍无落点**，该档等同 `off` 并由 `sync` + `doctor` 显式降级。三家的取舍、用户看到什么、以及将来要支持的前置条件（claude 需 `merge_json` 数组级合并语义；opencode / pi 需先回答与声明式适配器同一批安全问题）已记入 [learning](learning.md#另外三家将来要支持的前置条件)，issue [#56](https://github.com/zyTheGit/AgentForge/issues/56) 据此关闭
- **已实现（两层）** — 适配器插件化：第一层是 `Projector` 契约收口（补齐 `skillDir` / `skillPath` / `writesSessionHooks`，新 target 漏实现即编译失败）与 target 全集的两个事实源（编译期 `src/core/project/target-ids.ts`、运行时 `projectorRegistry`），命令层不再直连具体 projector 模块；第二层是**声明式适配器**——user 层 SoT 放一份 `adapters/<id>.yaml` 即可新增 target，`profile.targets` 除四个内置 id 外也接受已加载的适配器 id（`TargetEnum` 每次校验现读 `knownTargetIds()`）。**边界**：只接受数据、不接受代码——`merge_toml`、scope 条件产出、自由 MCP 字段映射、自定义 `soft` 语义、会话钩子（`writesSessionHooks` 恒 `false`）一律不开放，需要这些的 target 仍得写成内置 projector；project 层的 `adapters/*.yaml` 默认忽略，需 `AGF_ALLOW_PROJECT_ADAPTERS=1` 显式授权；`schemas/profile.schema.json` 里 `targets[]` 只能是 `string`（静态 schema 枚举不了运行时才知道的 id），编辑器补全对第三方 id 无效、写错靠 `aforge doctor` 兜。取值域、安全边界与写法见 [profile.yaml](profile.md#声明式适配器第三方-target)
- **已实现** — WSL 互通说明：见 [平台注意事项](platform.md#wsl-互通)。AgentForge 仍然几乎不检测 WSL，唯一例外是锁元数据里的 pid 空间标识。**边界**：该章节原先标「未实测」的几条已在 Windows 11 + WSL2（`/mnt/c` 为 9p、**不带 `metadata`**）上实测——`/mnt/c` 上两侧 `mkdir` 互斥成立（20000 次对抗，双方赢下的名字互不相交）、跨边界 `sameProcessSpace` 恒为 `false`（PR #59 加了 pid 空间一项，与计算机名大小写无关）、`chmod` 在该挂载下是 no-op、`/mnt/c` 大小写不敏感（同一项目两种写法 → 两个根 → 两把锁，互斥失效）、WSL 侧不受 260 字符限制、UNC 落点物理上写得进去。**仍未实测**：在 WSL 侧跑一轮完整 `aforge sync`（验证用的发行版里没有 node / bun 运行时），以及带 `metadata` 挂载选项时的权限行为

## 已知遗留

不阻塞 Phase 2 / Phase 3 收尾，但会影响特定场景（有 issue 跟踪的注明编号）：

- **两处仍未实机验证的上游行为**（issue [#54](https://github.com/zyTheGit/AgentForge/issues/54)，已收窄）：codex 侧 on_demand 技能的**显式 `$name` 调用**（`codex debug prompt-input` 只渲染提示词、不展开技能正文，要确认得开一次真会话），以及**在 WSL 侧跑一轮完整 `aforge sync`**。原先同列的两项已实测通过：codex sidecar 的字段路径 `policy.allow_implicit_invocation` 正确（codex 0.147.0）、opencode 对未知 frontmatter 键一律忽略（1.15.13，注入那一行是真空操作），结论见 [技能](skills.md#按需装载on_demand) 与 [平台注意事项](platform.md#wsl-互通)
- **pi 侧 `httpTransport: "sse"` 的实际连接行为**：能力矩阵把 pi × `sse` 判为无损（`src/core/project/projectors/mcp-transport.ts` 的 `MCP_TRANSPORT_MATRIX`），依据是 pi-mcp-adapter 的文档而非实机连接测试。若与上游不符，症状是「SSE 锁定不生效、回落成 streamable HTTP」而非报错。**目前没有单独的 issue 跟踪**，见 [MCP](mcp.md#transport--target-支持矩阵)

## 不予实现

- **`skills.copy_mode: symlink`**：schema 保留该取值仅为兼容既有 profile，运行时恒被忽略。三条理由各自独立成立（与 prune 判据冲突、Windows 默认无创建权限、四家客户端读取行为未实测），详见 [Spec §4.2](../AgentForge-Spec.md#42-profileyaml)
- **自定义模板 helper / partial**：见 [规则正文装配](rules.md)
- **`AGF_HOME` 指向 UNC 路径**：明确拒绝，退出码 1

## 非目标

以下不在产品范围内（[PRD §3.2](../AgentForge-PRD.md#32-非目标mvp)）：实时 daemon / 文件监听同步、MCP 进程的安装与生命周期管理、云同步与多设备账号体系、图形界面、无人值守全自动晋升学习结果、内置大量第三方 Skill。

