/**
 * `adapters/<id>.yaml` schema —— **声明式适配器**（Phase 3 第二层，issue #53）。
 *
 * 定位：让第三方 agent 成为一个 target，而**不引入代码执行**。`aforge sync` 是持锁
 * 写用户主目录的进程；支持从 SoT 加载可执行模块等于让 `git clone && aforge sync`
 * 跑仓库里的任意代码，直接跌到 RCE。所以这一层只接受**数据**：路径模板、开关、
 * 内置 dialect 枚举。
 *
 * 表达不了的能力（**明确不支持**，需要这些的 target 只能写成内置 projector）：
 * - TOML 序列化（codex 的 `config.toml` 是手写序列化：basic string 转义、bare key
 *   判定、inline table，都是代码而非数据）→ 因此 `merge_toml` 动作不开放；
 * - scope 条件产出（「project scope 整项跳过」这种条件分支）；
 * - 非标准 MCP payload 形状（只有 `mcpServers` / `opencode` 两种内置 dialect，
 *   不接受自由字段映射）；
 * - `soft` 的**行为语义**（可以标 `mcp.soft: true` 复用引擎既有的 best-effort 语义，
 *   但不能自定义「失败时怎么办」）。
 *
 * 路径一律是**模板 + 白名单变量**，不接受自由绝对路径；解析后还要过 containment
 * 校验（见 core/adapters/templates 与 core/adapters/containment）。
 *
 * 文件名即 id：`adapters/my-agent.yaml` 的 `id` 必须是 `my-agent`。发现来源要能由
 * 文件名唯一定位，否则「profile 里写的 id 找不到对应文件」就无从诊断。
 */
import { z } from 'zod';
import { ADAPTER_ENV_WHITELIST, ADAPTER_MAX_PATH_DEPTH } from '../core/adapters/limits';
import { SchemaVersion } from './common';

/**
 * 适配器 id 的取值域：小写字母 / 数字 / 连字符，首字符不是连字符，长度 1..32。
 *
 * 与文件名同形是硬约束（见文件头），所以取值域必须是**跨平台安全的文件名**：
 * 不允许大小写混用（Windows 文件系统大小写不敏感，`My-Agent.yaml` 与
 * `my-agent.yaml` 在两个平台上会解析出不同数量的适配器）。
 */
export const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * 允许出现在投影计划里的动作全集（**不含 `merge_toml`**）。
 *
 * 这是安全边界而不是待办：没有可声明的 TOML 序列化器，放开 `merge_toml` 只会让
 * 声明式适配器写出一份 codex 读不懂的 `config.toml`，把用户其他配置一起带下水。
 * core/adapters/projector 在产出每一项时对照本清单做运行时断言。
 */
export const ADAPTER_ALLOWED_ACTIONS = ['write', 'merge_marker', 'merge_json'] as const;

/**
 * 主规则项的写入动作：
 * - `merge_marker`（默认）：跟随 `profile.projection.marker_mode`（`none` 档自动
 *   降级为整文件 write，与四个内置 target 完全同一判据）；
 * - `write`：无条件整文件写（marker 语义不适用的目标，如 JSON/TOML 之外的纯生成文件）。
 *
 * `merge_json` 不在此列（主规则是 Markdown 正文，深合并没有意义），`merge_toml`
 * 不在 schema 里（见 ADAPTER_ALLOWED_ACTIONS）。
 */
export const AdapterMainRuleAction = z.enum(['write', 'merge_marker']);

/**
 * 主规则的投影开关（复用 `profile.projection` 既有语义，不新增配置面）：
 * - `always`（默认）：恒产出；
 * - `agents_md`：受 `projection.write_agents_md` 控制（缺省视为 true）；
 * - `claude_md`：受 `projection.write_claude_md` 控制（缺省视为 true）；
 * - `claude_md_optional`：**必须显式** `write_claude_md: true` 才产出（§8.7 的「可选」档）。
 */
export const AdapterMainRuleToggle = z.enum([
  'always',
  'agents_md',
  'claude_md',
  'claude_md_optional',
]);

/**
 * 命令薄壳的命名空间呈现（§8.8.2 的两档，与内置 target 同源）：
 * - `subdir`（默认）：`<commands_dir>/<ns...>/<name>.md`（目标会递归扫描子目录）；
 * - `flatten`：`<commands_dir>/<ns-name>.md`（目标只扫一层）。
 */
export const AdapterCommandNamespace = z.enum(['subdir', 'flatten']);

/**
 * MCP payload 的**内置 dialect 枚举**（不接受自由映射）：
 * - `mcpServers`：顶层 `mcpServers` 键 + 带 `type` 的条目（Claude Code `.mcp.json` 形状）；
 * - `opencode`：顶层 `mcp` 键 + `type: local|remote` 条目（OpenCode `opencode.json` 形状）。
 *
 * 为什么不开放自由映射：`{type:'local', command:[cmd, ...args]}` 是**映射逻辑**
 * （命令与参数合并成数组、env 改名 environment），不是数据；transport 能力落差
 * （codex 无 sse、opencode 无法区分 sse/http）也只能由归一化层表达。
 */
export const AdapterMcpDialect = z.enum(['mcpServers', 'opencode']);

/** 技能调用前缀（§8.8 实测表的两种取值；与 Projector.skillInvokePrefix 同域）。 */
export const AdapterSkillInvokePrefix = z.enum(['/', '$']);

/**
 * 单条路径模板的**形态**校验（语法与白名单校验在 core/adapters/templates）。
 *
 * schema 只卡长度与非空：模板语义（必须以变量开头、`..` 禁用、`{env:NAME}` 白名单、
 * 段数上限）需要与 containment 共用同一套解析器，放在 zod 的 refine 里会让错误信息
 * 失去「哪一段越界」这类定位信息。
 */
const PathTemplate = z.string().min(1).max(240);

/**
 * 一个 scope 下的落点声明。
 *
 * `base` 是**候选列表**：按顺序取第一个「全部变量都能解析」的候选。这就是环境变量
 * 覆盖的表达方式——`['{env:MY_AGENT_DIR}', '{userHome}/.my/agent']` 等价于内置
 * target 的 `CODEX_HOME ?? ~/.codex`，不需要额外的 `env_override` 字段。
 *
 * 除 `base` 外**全部可选**，缺省即该类产物不投影。`skills_dir` 也在其中：为让「与
 * codex 并存时删掉 `skills_dir`、借道上游自己的 `.agents/skills/`」成为合法配置，
 * 它与 `commands_dir` / `mcp_file` 同口径（缺省 = 不投影，不 warn 不报错）。
 * 代价是 `Projector.skillDir` / `skillPath` 这两个契约位没有值可返回——见
 * `core/adapters/projector.ts` 里 `skillDir` 的空值行为（抛 ConfigError，调用方跳过）。
 */
export const AdapterScopeSchema = z
  .object({
    base: z.union([PathTemplate, z.array(PathTemplate).min(1).max(4)]),
    /** 技能根目录（缺省 → 该 scope 不投影技能）；单个技能落在 `<skills_dir>/<name>/SKILL.md`。 */
    skills_dir: PathTemplate.optional(),
    /** 主规则文件（缺省 → 该 scope 不投影主规则）。 */
    main_rule: PathTemplate.optional(),
    /** 命令/prompt 薄壳目录（缺省 → 不投影命令薄壳）。 */
    commands_dir: PathTemplate.optional(),
    /** MCP 配置文件（缺省 → 不投影 MCP；给出时要求顶层 `mcp.dialect` 已声明）。 */
    mcp_file: PathTemplate.optional(),
  })
  .strict();

export const AdapterSchema = z
  .object({
    version: SchemaVersion,
    /** target id（= 文件名去掉扩展名；不得撞内置 id）。 */
    id: z.string().regex(ADAPTER_ID_PATTERN, {
      message: '只允许小写字母 / 数字 / 连字符，首字符非连字符，长度 1..32（id 必须与文件名一致）',
    }),
    /** 一句话说明（只进 doctor / status 展示，不参与投影）。 */
    description: z.string().max(200).optional(),
    skill_invoke_prefix: AdapterSkillInvokePrefix.default('/'),
    main_rule: z
      .object({
        toggle: AdapterMainRuleToggle.default('always'),
        action: AdapterMainRuleAction.default('merge_marker'),
      })
      .strict()
      .prefault({}),
    commands: z
      .object({ namespace: AdapterCommandNamespace.default('subdir') })
      .strict()
      .prefault({}),
    /** MCP payload dialect 与 soft 标记（缺省 → 该适配器不投影 MCP）。 */
    mcp: z
      .object({
        dialect: AdapterMcpDialect,
        /**
         * 标 soft 的 MCP 项 apply 失败时只收 warning、不回滚（§8.6 的既有语义，
         * pi 用它表达「装了 pi-mcp-adapter 才生效」）。**只能复用，不能自定义**。
         */
        soft: z.boolean().default(false),
      })
      .strict()
      .optional(),
    scopes: z
      .object({
        project: AdapterScopeSchema.optional(),
        user: AdapterScopeSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (doc.scopes.project === undefined && doc.scopes.user === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['scopes'],
        message: 'project / user 至少要声明一个 scope，否则该 target 不产出任何投影',
      });
    }
    // mcp_file 与 mcp.dialect 是一对：只写落点不写形状，投影层无从决定 payload
    for (const scope of ['project', 'user'] as const) {
      if (doc.scopes[scope]?.mcp_file !== undefined && doc.mcp === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['scopes', scope, 'mcp_file'],
          message: `声明了 MCP 落点却没有顶层 mcp.dialect（可选值: ${AdapterMcpDialect.options.join(' | ')}）`,
        });
      }
    }
  })
  .describe(
    `声明式适配器（第三方 target）。路径只接受模板 + 白名单变量（{projectRoot} / {userHome} / {env:NAME}，NAME 限 ${ADAPTER_ENV_WHITELIST.join(' | ')}），解析后强制落在 projectRoot / userHome / 白名单 env 指向的目录之下，单产物路径最多 ${ADAPTER_MAX_PATH_DEPTH} 段；动作限 ${ADAPTER_ALLOWED_ACTIONS.join(' / ')}（merge_toml 不开放）。`,
  );

/** 适配器声明的完整形态（默认值已填充）。 */
export type AdapterDoc = z.output<typeof AdapterSchema>;

/** 适配器声明的输入形态（字段可省略）。 */
export type AdapterDocInput = z.input<typeof AdapterSchema>;

/** 单 scope 落点声明的完整形态。 */
export type AdapterScope = z.output<typeof AdapterScopeSchema>;

/** MCP dialect 的类型形态（投影层的 payload 装配消费）。 */
export type AdapterMcpDialect = z.output<typeof AdapterMcpDialect>;

/** 命名空间呈现的类型形态。 */
export type AdapterCommandNamespace = z.output<typeof AdapterCommandNamespace>;

/** 主规则开关的类型形态。 */
export type AdapterMainRuleToggle = z.output<typeof AdapterMainRuleToggle>;
