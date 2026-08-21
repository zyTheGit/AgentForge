/**
 * Projector 契约（Spec §8.1）：plan / apply 两段式投影。
 *
 * - plan(ctx)：纯函数，不做任何 IO——只根据上下文计算"写哪些路径、什么动作、什么内容"；
 * - M5 中 apply 由引擎统一执行（core/project/writer.applyItem），
 *   Projector 不自带 apply；M6 全事务化时如需 projector 定制再启用该入口。
 *
 * lineEnding 采用项目统一的 'lf' | 'crlf'（Spec §8.1 的 "\n" | "\r\n" 字面形态，
 * 经 infra/fsutil.normalizeLineEnding 映射，Spec §2.5）。
 */
import type { Habits, McpServer, Profile } from '../../schema';
import type { EnvSnapshot, LineEnding, Scope } from '../env';
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
 * 待物化的 Skill 产物（M5 最小结构，M8 扩展附属文件 / 来源等）。
 * M5 不投影 skills，仅保留契约位。
 */
export interface SkillArtifact {
  /** skill 名（即目标目录名，Spec §4.3 文件名约束同样适用）。 */
  readonly name: string;
  /** SKILL.md 正文。 */
  readonly content: string;
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
  readonly mcpServers: readonly McpServer[];
  /** M5：dry-run 语义由引擎在 apply 阶段实现，plan 始终产出完整计划。 */
  readonly dryRun: boolean;
  /** Spec §2.5 换行风格（profile.projection.line_ending 经 env 覆盖后的有效值）。 */
  readonly lineEnding: LineEnding;
  readonly markerBegin: string;
  readonly markerEnd: string;
  /**
   * M6：投影可能需要的环境覆盖（CODEX_HOME 等，Spec §2.2/§2.4）。
   * 可选字段——早期契约（M5）无 env，plan 内以 ctx.env?.codexHome 消费。
   */
  readonly env?: EnvSnapshot;
}

/** Spec §8.1 Projector。 */
export interface Projector {
  readonly id: string;
  plan(ctx: ProjectContext): ProjectionPlan;
  /**
   * M5 不实现（引擎统一执行）；返回类型 never 表示当前版本调用即视为契约违规。
   * M6 全事务化（plan 全部 target → 逐一 apply → 失败回滚）时再评估是否下放。
   */
  apply?(plan: ProjectionPlan): Promise<never>;
}
