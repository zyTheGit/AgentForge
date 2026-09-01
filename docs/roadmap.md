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

## Phase 2

- **已提前落地**：Commands 命名空间 + `$1..$9` 归一化；Interactive `init` 体验
- **部分实现** — MCP 字段与上游对齐：`http` / `sse` 目前只按 `url` 形态投递，未按 transport 细分；claude 的 user scope 全局 MCP 策略沿用现有契约位
- **部分实现** — 更丰富探测器：现有能力封顶在 node/python 版本管理器、包管理器、rust/go、shell；无 java / dotnet / monorepo / CI 探测
- **未实现** — 可选官方模板仓库：内置模板只有 `base/default`，没有默认注册的官方源，需自行 `aforge source add`
- **未实现** — `import` 增强：只认 `AGENTS.md` / `CLAUDE.md` 两种文件名，工具链关键词表硬编码
- **未实现** — `skills.on_demand` 按需装载：只登记不物化，声明的 skill 名不进投影，仅由 `status` / `doctor` 列出

## Phase 3

- **未实现** — Learning 质量启发式：`confidence` 字段存在但无自动打分、衰减或去重合并，缺省固定 `0.5`
- **未实现** — `learning.auto_capture: hook`：无任何 target 侧会话钩子，行为等同 `off`，`doctor` 统一 warn。落点调研（claude 用 `settings.json` 的 `SessionEnd` / `Stop`，codex 用 `config.toml` 钩子段，opencode 需 plugin，pi 需 extension）见 [Spec §7.4](../AgentForge-Spec.md#74-learn)
- **未实现** — 适配器插件化：注册容器已就位，`Projector` 的扩展点尚未开放
- **未实现** — WSL 互通说明

## 不予实现

- **`skills.copy_mode: symlink`**：schema 保留该取值仅为兼容既有 profile，运行时恒被忽略。三条理由各自独立成立（与 prune 判据冲突、Windows 默认无创建权限、四家客户端读取行为未实测），详见 [Spec §4.2](../AgentForge-Spec.md#42-profileyaml)
- **自定义模板 helper / partial**：见 [规则正文装配](rules.md)
- **`AGF_HOME` 指向 UNC 路径**：明确拒绝，退出码 1

## 非目标

以下不在产品范围内（[PRD §3.2](../AgentForge-PRD.md#32-非目标mvp)）：实时 daemon / 文件监听同步、MCP 进程的安装与生命周期管理、云同步与多设备账号体系、图形界面、无人值守全自动晋升学习结果、内置大量第三方 Skill。

## 其他缺口

- `aforge learnings edit` 不拉起编辑器，只打印条目路径与内容供手工编辑
- `manifest` 的 schema 仍是宽松对象数组，待按需收紧
- 文档缺「在 CI 中使用 aforge」的成篇示例；相关行为散落在 [learning](learning.md) 与 [命令速查](commands.md)
