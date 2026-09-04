/**
 * Projector 契约（Spec §8.1）：plan / apply 两段式投影 **＋ plan 侧的投影开关**。
 *
 * - plan(ctx)：纯函数，不做任何 IO——只根据上下文计算"写哪些路径、什么动作、什么内容"；
 * - M5 中 apply 由引擎统一执行（core/project/writer.applyItem），
 *   Projector 不自带 apply；M6 全事务化时如需 projector 定制再启用该入口。
 *
 * 本模块不是纯类型模块：文件末尾还导出五个**运行时**纯函数
 * （mainRuleAction / shouldWriteAgentsMd / shouldWriteClaudeMd /
 * shouldWriteOptionalClaudeMd / shouldWriteSessionHook），它们把
 * `profile.projection` 与 `profile.learning` 的开关语义收在一处，
 * 供四个 projector 共用——放在类型契约旁边是为了让"契约 + 契约的默认判据"同址可见，
 * 避免四个 projector 各写一遍判断而漂移。
 *
 * lineEnding 采用项目统一的 'lf' | 'crlf'（Spec §8.1 的 "\n" | "\r\n" 字面形态，
 * 经 infra/fsutil.normalizeLineEnding 映射，Spec §2.5）。
 */
import type { Habits, MarkerMode, McpServer, Profile } from '../../schema';
import type { EnvSnapshot, LineEnding, Scope } from '../env';
import { effectiveAutoCapture, writesSessionHooks } from '../learning/auto-capture';
import type { OsContext } from '../paths';

/** Spec §8.1 ProjectionPlan 项的动作类型。 */
export type ProjectionAction = 'write' | 'merge_marker' | 'merge_json' | 'merge_toml';

/** Spec §8.1 ProjectionPlan 项：写哪个路径、怎么做、内容是什么。 */
export interface ProjectionPlanItem {
  /** 目标绝对路径（Spec §2.1：一律规范化绝对路径）。 */
  readonly path: string;
  readonly action: ProjectionAction;
  /**
   * 动作载荷：
   * - write / merge_marker / merge_toml：要落入（或替换进标记段的）正文（LF 基准）；
   * - merge_json：AgentForge 管理键的 JSON 文本（对象，未知键由 writer 保留，Spec §8.2）。
   */
  readonly content: string;
  /**
   * M6（Spec §8.6 Pi MVP soft）：soft 项 apply 失败（目录/文件异常）时
   * 仅收集 warning，不计入失败、不触发回滚。缺省（undefined）= 硬项。
   */
  readonly soft?: boolean;
}

/** 一个 target 的完整写入计划。 */
export interface ProjectionPlan {
  readonly targetId: string;
  readonly items: readonly ProjectionPlanItem[];
  /**
   * M6（Spec §8.4）：merge_toml 动作的标记段覆盖（codex MCP 用
   * `# BEGIN AGENTFORGE MCP` / `# END AGENTFORGE MCP` 变体）。
   * 缺省用 writer 默认 TOML 标记；markdown marker 恒取 profile 配置（ctx.markerBegin/End）。
   */
  readonly tomlMarkers?: { readonly begin: string; readonly end: string };
}

/**
 * 待物化的 Skill 产物（正文 + 是否按需装载）。
 */
export interface SkillArtifact {
  /** skill 名（即目标目录名，Spec §4.3 文件名约束同样适用）。 */
  readonly name: string;
  /**
   * 要落盘的 SKILL.md 正文。
   *
   * `skills.always` 时逐字节等于 SoT 原文；`skills.on_demand` 时已由
   * core/sources/skill-materialize 在 frontmatter 里注入
   * `disable-model-invocation: true`（正文加工是 SoT 侧职责，projector 只负责落点）。
   */
  readonly content: string;
  /**
   * 来自 `profile.skills.on_demand`（Phase 2 按需装载）→ true；来自
   * `skills.always` → 缺省（undefined）。
   *
   * projector 需要这个位是因为 codex 的「不自动调用」开关不在 frontmatter 里，
   * 而在技能目录下的 sidecar `agents\openai.yaml`（`policy.allow_implicit_invocation`），
   * 只能由 codex projector 额外产出一个 write 项——其余三家靠 content 里的
   * frontmatter 键即可，故它们不读这个字段。
   */
  readonly onDemand?: boolean;
}

/**
 * 待投影的命令/prompt 薄壳（Spec §8.8）。
 *
 * 由 `skills.expose_as_command` 点名的技能派生：内容不复制技能正文，只透传
 * frontmatter 的 `description` / `argument-hint`（派生逻辑见 core/project/commands）。
 * `description` / `argumentHint` 缺省即代表技能 frontmatter 里没有该键——不造默认值。
 */
export interface CommandArtifact {
  /** 命令名（leaf）= 技能目录名（§8.8.2：expose 条目最后一段即技能名）。 */
  readonly name: string;
  /**
   * 命名空间段（§8.8.2）：`expose_as_command` 写 `review/code-review` 时的前缀部分，
   * 平铺名为空数组。claude / opencode 落成子目录；pi / codex 目录扁平 → 拼接降级。
   */
  readonly namespace: readonly string[];
  readonly description?: string;
  readonly argumentHint?: string;
  /**
   * SoT 自定义命令正文（`SKILL.md` frontmatter 的 `command-body`，§8.8.2）。
   * 缺省时用内置薄壳模板；给出时占位符已校验落在 `$ARGUMENTS` / `$1..$9` 交集内。
   */
  readonly body?: string;
}

/** Spec §8.1 ProjectContext：projector 计算投影计划所需的全部输入。 */
export interface ProjectContext {
  /** 宿主平台（路径分隔符与投影格式随平台变化，Spec §8.1 os）。 */
  readonly os: OsContext;
  /** 本次投影的作用域（决定主规则落在项目根还是用户目录，Spec §8.1 scope）。 */
  readonly scope: Scope;
  /**
   * 投影基准根目录：
   * - scope=project：项目根（主规则直接落在 rootDir 下，如 <root>\CLAUDE.md）；
   * - scope=user：用户目录（各 target 在其下拼自己的全局根，如 claude → <root>\.claude）。
   */
  readonly rootDir: string;
  /** SoT 统一渲染出的规则正文（同一份分发给各 target，Spec §8.2）。 */
  readonly renderedRulesMd: string;
  readonly habits: Habits;
  readonly profile: Profile;
  readonly skillsToMaterialize: readonly SkillArtifact[];
  /**
   * Spec §8.8：本次要额外投影成命令/prompt 薄壳的技能（`skills.expose_as_command`）。
   *
   * 与 `skillsToMaterialize` 分开传而不是让 projector 自己从 profile 里筛：名单的
   * 子集校验（点名却未装 → ConfigError(2)）与 frontmatter 派生都是 SoT 侧职责
   * （core/project/commands），projector 只负责「落到哪个目录」。
   */
  readonly commandsToExpose: readonly CommandArtifact[];
  readonly mcpServers: readonly McpServer[];
  /** M5：dry-run 语义由引擎在 apply 阶段实现，plan 始终产出完整计划。 */
  readonly dryRun: boolean;
  /** Spec §2.5 换行风格（profile.projection.line_ending 经 env 覆盖后的有效值）。 */
  readonly lineEnding: LineEnding;
  readonly markerBegin: string;
  readonly markerEnd: string;
  /**
   * Spec §4.2 projection.marker_mode（主规则写入语义）：
   * - `replace_between_markers`（默认）：替换 marker 区间，区间外用户内容保留；
   * - `append_below_marker`：在 marker_begin 之后追加新正文，原区间内容保留在其后
   *   （已包含同一正文时跳过，保证 sync 幂等——见 writer.appendBelowMarker）；
   * - `none`：不使用 marker 包裹，主规则项降级为整文件 `write`。
   *
   * 可选字段（同 env）：早期契约与只读诊断路径（core/doctor）未提供时，
   * 消费端按 `replace_between_markers` 处理——即历史默认行为。
   */
  readonly markerMode?: MarkerMode;
  /**
   * M6：投影可能需要的环境覆盖（CODEX_HOME 等，Spec §2.2/§2.4）。
   * 可选字段——早期契约（M5）无 env，plan 内以 ctx.env?.codexHome 消费。
   */
  readonly env?: EnvSnapshot;
}

/**
 * 技能调用前缀的取值域（Spec §8.8 实测表）：codex 是 `$<name>`，其余三家是 `/<name>`。
 *
 * 单独命名而不是就地写联合字面量：`aforge status` 的对外结构（含 `--json`）也要引用
 * 同一取值域，否则命令层会把它宽化成 `string`，类型契约随之丢失精度。
 */
export type SkillInvokePrefix = '/' | '$';

/** Spec §8.1 Projector。 */
export interface Projector {
  readonly id: string;
  /**
   * 该 target 里调用已装技能的前缀（Spec §8.8 实测表）：codex 是 `$`，其余三家是 `/`。
   *
   * 为什么进 Projector 契约而不是放一张外部映射表：它与"技能落在哪个目录"是同一份
   * target 知识，写在各 projector 里，新增 target 时 TS 会强制补上（漏掉即编译失败）。
   * 唯一消费方是 `aforge status`（§6.1 要求打印），不参与 plan / apply。
   */
  readonly skillInvokePrefix: SkillInvokePrefix;
  /**
   * 该 target 是否有**可声明式写入**的会话钩子落点（Spec §7.4 `hook` 档 / §12 Phase 3）。
   *
   * 与 `skillInvokePrefix` 同一处理口径：能力与"钩子落在哪个文件"是同一份 target
   * 知识，写在各 projector 里，新增 target 时 TS 会强制补上（漏掉即编译失败）。
   *
   * 判据是"能不能只靠写配置数据把钩子装上"，而不是"上游有没有会话生命周期事件"：
   * opencode / pi 的会话事件要靠投放可执行的 plugin / extension **代码**才能用，
   * claude 的钩子只能并入共享的 `.claude\settings.json` 数组（merge_json 对数组是
   * 整体替换，会吞掉用户手写的钩子）。三家因此为 false，由 sync-notices 与 doctor
   * 显式降级，不静默失效。理由与支持矩阵见 docs/learning.md。
   */
  readonly writesSessionHooks: boolean;
  /**
   * 该 target 是否有 MCP 落点（Spec §4.2 `mcp.servers` / §8.3-§8.6）。
   *
   * 同 `writesSessionHooks` 的处理口径：能力与"MCP 写进哪个文件"是同一份 target
   * 知识，写在各 projector 里，新增 target 时 TS 会强制补上（漏掉即编译失败）。
   *
   * 四家内置全为 `true`。声明式适配器按 `adapters/<id>.yaml` **是否声明了任一 scope
   * 的 `mcp_file`** 决定——只投 `main_rule` / `skills_dir` 的适配器压根没有 MCP 产物，
   * 谈它的 transport 能力落差是无意义的（否则会收到一条自己无法消除、且指向不存在
   * 产物的提示，见 `collectUnmeasuredMcpTransportTargets`）。
   *
   * **只表达"有没有落点"，不表达"本轮这个 scope 写不写"**：claude 的 user scope 不投
   * MCP 是 scope 维度的事，由 `sync-notices.collectMcpScopeNotices`（issue #52）单独
   * 说明——与 `writesSessionHooks` 把"能力"和"档位"分开的分工一致。
   */
  readonly writesMcp: boolean;
  plan(ctx: ProjectContext): ProjectionPlan;
  /**
   * 该 target 的 skills 根目录（`<...>/skills`，随 scope 变化）。
   *
   * 与 skillPath 一起进契约（Phase 3）：命令层原先 import 四个具体 projector 模块的
   * `*SkillPath` 函数来算「sync 会把技能投影到哪」，等于绕过 Projector 接口直连实现——
   * 第五个 target 出现时那四行 import 不会报错，只会**静默漏一条路径**。挂在接口上后
   * 新 target 漏实现即编译失败，命令层只认 `projectorRegistry`。
   *
   * **当前没有生产调用点**（命令层只用 `skillPath`，四个内置 projector 只做赋值）：
   * 保留它是为第三方 target 与后续 doctor 检查（「skills 根存在 / 有残留」这类需要
   * 目录本身而非单个文件的诊断）预留——不是死代码，删了第二层还得加回来。
   */
  skillDir(ctx: ProjectContext): string;
  /** 单个技能的 `SKILL.md` 绝对路径（= `<skillDir>/<name>/SKILL.md`）。 */
  skillPath(ctx: ProjectContext, skillName: string): string;
  /**
   * M5 不实现（引擎统一执行）；返回类型 never 表示当前版本调用即视为契约违规。
   * M6 全事务化（plan 全部 target → 逐一 apply → 失败回滚）时再评估是否下放。
   */
  apply?(plan: ProjectionPlan): Promise<never>;
}

// ---------------------------------------------------------------------------
// plan 侧的 profile.projection 开关（四个 projector 共用，避免四处判断漂移）
// ---------------------------------------------------------------------------

/**
 * 主规则项的写入动作（Spec §4.2 marker_mode / §8.2）：
 * - `none` → 整文件 `write`：不使用 marker 包裹，全文归 AgentForge 管理
 *   （因此也不参与 marker 区间冲突预检查与 doctor 的区间比对——文件里没有区间）；
 * - `replace_between_markers` / `append_below_marker` → `merge_marker`
 *   （区间内的替换/追加细节由 writer.computeItemContent 按 mode 分派）。
 */
export function mainRuleAction(ctx: ProjectContext): ProjectionAction {
  return ctx.markerMode === 'none' ? 'write' : 'merge_marker';
}

/**
 * 根 AGENTS.md 是否投影（Spec §4.2 projection.write_agents_md / §8.7 投影矩阵）。
 * 缺省（未声明）= 投影，保持既有行为；显式 false 才关闭。
 * 适用 target：opencode / codex / pi（claude 在 §8.7 中恒不产出 AGENTS.md）。
 */
export function shouldWriteAgentsMd(ctx: ProjectContext): boolean {
  return ctx.profile.projection.write_agents_md !== false;
}

/**
 * CLAUDE.md 是否投影（Spec §4.2 projection.write_claude_md / §8.7）。
 * claude target 的主规则：缺省 = 投影，显式 false 才关闭。
 */
export function shouldWriteClaudeMd(ctx: ProjectContext): boolean {
  return ctx.profile.projection.write_claude_md !== false;
}

/**
 * §8.7 中标记为「可选」的 CLAUDE.md（opencode target）是否投影。
 * 语义与上面相反：**必须显式** `write_claude_md: true` 才产出——缺省不产出，
 * 否则默认配置会突然多写一个 CLAUDE.md（既有行为是不产出）。
 */
export function shouldWriteOptionalClaudeMd(ctx: ProjectContext): boolean {
  return ctx.profile.projection.write_claude_md === true;
}

/**
 * 是否产出该 target 的会话钩子（Spec §4.2 learning.auto_capture / §7.4 hook 档）。
 *
 * 判据只看**声明**（经 effectiveAutoCapture 取有效档位），不看本机装了哪个 CLI：
 * 钩子写入是声明驱动的，否则同一份 SoT 在两台机器上会产出不同的投影产物。
 * 有钩子落点的 projector 用它决定要不要 push 钩子项；没有落点的 projector 不调用，
 * 由 `core/project/sync-notices` 与 doctor 显式降级说明（不静默失效）。
 */
export function shouldWriteSessionHook(ctx: ProjectContext): boolean {
  return writesSessionHooks(effectiveAutoCapture(ctx.profile));
}
