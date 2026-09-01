/**
 * profile.yaml schema（Spec §4.2）：投影目标 / 模板 / MCP / 合并策略 / 投影选项。
 *
 * 默认值对齐 Spec §4.2：
 * - skills.copy_mode 默认 copy（Windows 亦然，Spec §7.6 默认不使用 symlink）；
 * - merge.strategy 默认 overlay、merge.arrays 默认 replace；
 * - projection.marker_mode 默认 replace_between_markers（Windows 安装默认值），
 *   marker_begin/marker_end 与 core/markers 常量同源（单一事实源），
 *   line_ending 默认 lf（Windows 亦然，Spec §2.5）、path_style 默认 auto；
 * - learning.default_scope 默认 project、auto_capture 默认 off、
 *   auto_promote 默认 false、include_promoted_in_sync 默认 true。
 *
 * 无默认值的字段说明：
 * - targets：Spec 要求"至少一项"且属于"选择型"数组——合并时 project 恒覆盖
 *   （§4.2 示例），给默认值会伪造用户选择，故 required；
 * - templates / mcp.servers / skills.always / skills.on_demand：内容型数组，
 *   参与继承与 append/replace 合并，缺省即"未设置"；
 * - scope：文件所属层级由加载上下文判定，缺省合法；
 * - write_agents_md / write_claude_md / gitignore_generated：Spec 未标默认，
 *   由装配层之后的消费端按 §8.7 投影矩阵决定（见下方"字段消费点"）。
 *
 * 字段消费点（避免"声明了却无人读"）：
 * - projection.marker_mode → core/project/types.ProjectContext.markerMode →
 *   core/project/writer.computeItemContent（replace / append 分派）与各 projector
 *   的主规则 action（none → 整文件 write，不使用 marker 包裹）；
 * - projection.write_agents_md / write_claude_md → 各 projector 的 plan
 *   （§8.7 投影矩阵：write_agents_md 控 opencode/codex/pi 的 AGENTS.md；
 *   write_claude_md 控 claude 的 CLAUDE.md 与 opencode 的"可选"CLAUDE.md）；
 * - projection.path_style → core/generate/composer.applyPathStyle（投影正文里的
 *   路径 token 分隔符与家目录变量）；
 * - projection.gitignore_generated → core/project/engine 的 .gitignore 标记段写入；
 * - learning.default_scope → commands/knowledge/learn 的默认落层；
 * - learning.auto_capture → core/learning/auto-capture（effectiveAutoCapture 供渲染，
 *   resolveAutoCapture 供 status / doctor 展示）
 *   → `prompt` 档由 core/generate/composer 插入 `## Learning Protocol` 段
 *   （§5.2 / §7.4）；`hook` 档由 core/learning/hook-capture 造钩子产物、各 projector
 *   决定落点（当前只有 codex 有落点，其余 target 由 sync notice 与 doctor 的
 *   learning-auto-capture-hook 条目显式降级，不静默失效）；
 * - skills.always → core/sources/skill.readSkillsToMaterialize（物化并投影）；
 * - skills.on_demand → **MVP 决定：只登记不物化**，由 aforge status 展示清单
 *   （Spec §4.2 注记）。按需装载属 Phase 2，MVP 不投影、不生成占位文件——
 *   在此登记该决定，避免字段静默无效。
 */
import { z } from 'zod';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../core/markers';
import { SchemaVersion, ScopeEnum } from './common';

/** Spec §4.2 targets 元素：四个投影目标。 */
export const TargetEnum = z.enum(['opencode', 'codex', 'claude', 'pi']);

/**
 * Spec §4.2 skills.copy_mode。
 *
 * `symlink` 恒被忽略（投影与 skill add 恒为实体 copy）且**不计划实现**；enum 保留该
 * 取值只为不让既有写了它的 profile 加载失败，doctor 报 `skills-copy-mode` warn。
 */
export const CopyMode = z.enum(['copy', 'symlink']);

/** Spec §4.2 merge.strategy。 */
export const MergeStrategy = z.enum(['overlay', 'replace']);

/** Spec §4.2 merge.arrays。 */
export const ArrayMergeMode = z.enum(['append', 'replace']);

/** Spec §4.2 projection.marker_mode。 */
export const MarkerMode = z.enum(['none', 'append_below_marker', 'replace_between_markers']);

/** marker_mode 的类型形态（投影层 ProjectContext / writer 消费，见 core/project）。 */
export type MarkerMode = z.output<typeof MarkerMode>;

/** Spec §4.2 projection.line_ending。 */
export const LineEndingEnum = z.enum(['lf', 'crlf']);

/**
 * Spec §4.2 learning.auto_capture：由谁触发 `aforge learn`（§7.4 三档）。
 *
 * - `off`（缺省）：只有人工敲命令；
 * - `prompt`：渲染正文里多一段 `## Learning Protocol`，指示 agent 自行调用
 *   `aforge learn --file -`（概率性，模型可能不执行）；
 * - `hook`：由 target 侧会话钩子在每次会话开始时注入同一份协议正文（投递是确定的，
 *   写不写条目仍由 agent 决定）。与 `prompt` **互斥**——hook 档不再往规则文件里插
 *   那一段。要求 target 支持"只靠写配置数据把钩子装上"，目前只有 codex 满足；其余
 *   target 在该档等同 `off`，由 sync notice 与 doctor 显式告警（支持矩阵与理由见
 *   docs/learning.md）。
 */
export const AutoCaptureEnum = z.enum(['off', 'prompt', 'hook']);

/** auto_capture 的类型形态（core/learning/auto-capture 与渲染层消费）。 */
export type AutoCapture = z.output<typeof AutoCaptureEnum>;

/** Spec §4.2 projection.path_style。 */
export const PathStyle = z.enum(['auto', 'windows', 'posix']);

/** path_style 的类型形态（core/generate/composer 的路径风格归一化消费）。 */
export type PathStyle = z.output<typeof PathStyle>;

/**
 * Spec §4.2 mcp.servers[].transport。
 *
 * 三个取值就是 AgentForge 侧的 transport 语义，**不随上游客户端能力变化**：
 * 各家目标格式对 `http`（streamable HTTP）与 `sse` 的表达力不同（codex 只支持
 * streamable HTTP、opencode 的 remote 形态无法区分两者），这类差异由投影层的
 * core/project/projectors/mcp-transport 归一化并显式降级，不靠往 enum 里加值解决
 * （加值是破坏性变更：老 profile 里已有的 http/sse 语义会被重新定义）。
 */
export const Transport = z.enum(['stdio', 'http', 'sse']);

/** transport 的类型形态（投影层的 transport 归一化表消费）。 */
export type Transport = z.output<typeof Transport>;

/**
 * Spec §4.2 mcp.servers[] 元素。
 * name + transport 必填；command/args/env 属 stdio、url/headers 属 http/sse，
 * 字段与 transport 的条件依赖留给 MCP 管理层（M5）校验。
 * 数组元素整组参与合并（不做元素内深合并），元素内 default 安全。
 */
export const McpServerSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  transport: Transport,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const ProfileSchema = z.object({
  version: SchemaVersion,
  /** 本文件声明的所属层级（缺省由加载上下文判定，合并后无意义——见 effectiveScope）。 */
  scope: ScopeEnum.optional(),
  /** 投影目标（至少一项；选择型数组：合并时 project 恒覆盖，Spec §4.2 示例）。 */
  targets: z.array(TargetEnum).min(1),
  /** 模板 id 列表（内容型数组：参与 merge.arrays 合并；缺省由渲染层兜底 base/default）。 */
  templates: z.array(z.string()).optional(),
  mcp: z
    .object({
      servers: z.array(McpServerSchema).optional(),
    })
    .default({}),
  skills: z
    .object({
      always: z.array(z.string()).optional(),
      on_demand: z
        .array(z.string())
        .optional()
        .describe(
          'MVP 只登记不物化：声明的 skill 名不会被 sync 物化或投影，仅由 aforge status / doctor 列出（Spec §4.2 注记）',
        ),
      copy_mode: CopyMode.default('copy'),
      expose_as_command: z
        .array(z.string())
        .optional()
        .describe(
          '额外投影成命令/prompt 薄壳的 skill 名（Spec §8.8）：必须是 skills.always 的子集，否则 sync 退出码 2；codex 的 project scope 不支持命令文件，按 skip + doctor warn 处理',
        ),
    })
    // prefault：缺省时以 {} 作为输入再解析，内层 default 自然填充（单一事实源）
    .prefault({}),
  merge: z
    .object({
      strategy: MergeStrategy.default('overlay'),
      arrays: ArrayMergeMode.default('replace'),
    })
    .prefault({}),
  projection: z
    .object({
      write_agents_md: z.boolean().optional(),
      write_claude_md: z.boolean().optional(),
      marker_mode: MarkerMode.default('replace_between_markers'),
      marker_begin: z.string().default(DEFAULT_MARKER_BEGIN),
      marker_end: z.string().default(DEFAULT_MARKER_END),
      line_ending: LineEndingEnum.default('lf'),
      path_style: PathStyle.default('auto'),
      gitignore_generated: z.boolean().optional(),
    })
    .prefault({}),
  learning: z
    .object({
      default_scope: ScopeEnum.default('project'),
      auto_capture: AutoCaptureEnum.default('off'),
      auto_promote: z.boolean().default(false),
      include_promoted_in_sync: z.boolean().default(true),
    })
    .prefault({}),
  /** 用户扩展键（Spec §4.2）：passthrough。 */
  extensions: z.looseObject({}).default({}),
});

/** profile.yaml 解析后的完整形态（默认值已填充）。 */
export type Profile = z.output<typeof ProfileSchema>;

/** profile.yaml 的输入形态（字段可省略，合并层使用）。 */
export type ProfileInput = z.input<typeof ProfileSchema>;

/** 单个 MCP server 声明（输出形态）。 */
export type McpServer = z.output<typeof McpServerSchema>;

/** 单个 MCP server 的输入形态。 */
export type McpServerInput = z.input<typeof McpServerSchema>;
