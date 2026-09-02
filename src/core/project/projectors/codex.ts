/**
 * Codex Projector（Spec §8.4 / §2.3 / §2.2 / §11-2）。
 *
 * | 角色     | Project                          | User                                   |
 * |----------|----------------------------------|----------------------------------------|
 * | 主规则   | `<root>\AGENTS.md`               | `CODEX_HOME` 或 `%USERPROFILE%\.codex\AGENTS.md` |
 * | Skills   | `.agents\skills\<name>\SKILL.md` | `CODEX_HOME\skills\` 或 `~\.codex\skills\` |
 * | MCP      | `.codex\config.toml` 中 `# BEGIN AGENTFORGE MCP` 标记段 | 全局 config.toml |
 * | 会话钩子 | `.codex\hooks.json`（整文件）    | `CODEX_HOME\hooks.json` 或 `~\.codex\hooks.json` |
 *
 * - 主规则动作按 profile.projection.marker_mode（§4.2；merge_marker 时 marker 外
 *   保留，Spec §8.2；none 时整文件 write）；`write_agents_md: false` 关闭该项；
 * - MCP 用 merge_toml：只替换 `# BEGIN AGENTFORGE MCP` / `# END AGENTFORGE MCP`
 *   标记段（标记段外用户 TOML 与注释原样保留，Spec §8.4 / §8.2）；
 *   片段为 `[mcp_servers.<name>]` **单表**（不是 `[[...]]` 数组表——codex 的
 *   `mcp_servers` 是 name → table 的映射，写成数组表会让整个 config.toml 加载失败）；
 *   字段名与跳过判据由 projectors/mcp-transport 给出，本文件只负责 TOML 文本化
 *   （手写序列化，无 TOML 库依赖：basic string 转义 / bare key 判定 / inline table / 数组）；
 * - **会话钩子（§7.4 hook 档 / §12 Phase 3）**：`learning.auto_capture: hook` 时
 *   额外产出 `hooks.json`。四家里只有 codex 支持"独立文件 + 纯配置数据"的钩子
 *   声明（实测 codex 0.147.0：合法 hooks.json 下 `codex doctor` 正常，结构非法时
 *   报 "config could not be loaded"），因此只有它 `writesSessionHooks: true`；
 * - skills：write 实体 copy（Spec §7.6 默认不使用 symlink）；`skills.on_demand`
 *   的技能额外产出 `<name>\agents\openai.yaml`（`policy.allow_implicit_invocation:
 *   false`）——codex 不认 frontmatter 的 `disable-model-invocation`，按需语义只能
 *   走这个 sidecar（见 codexSkillPolicyPath）；
 * - plan 为纯函数：不做任何 IO，路径按注入 os 选择分隔符（Spec §2.1）；
 *   CODEX_HOME 经 ctx.env（engine 注入，Spec §2.4）覆盖。
 */
import type { McpServer } from '../../../schema';
import { codexSessionHooksJson } from '../../learning/hook-capture';
import { CODEX_HOME_ENV, pathApiFor, resolveOverridableDir } from '../../paths';
import { renderCommandShell } from '../commands';
import {
  type CommandArtifact,
  mainRuleAction,
  type ProjectContext,
  type ProjectionPlan,
  type ProjectionPlanItem,
  type Projector,
  shouldWriteAgentsMd,
  shouldWriteSessionHook,
} from '../types';
import { type CodexMcpEntry, codexMcpEntries } from './mcp-transport';
import { flatCommandFilePath, SKILLS_DIRNAME, skillDocPath } from './shared';

/** Spec §2.3 / §8.4 主规则文件名（project / user 两个 scope 同名）。 */
export const CODEX_MAIN_RULE_FILENAME = 'AGENTS.md';

/** codex 的配置目录（project 级 `.codex\`；user 级为 CODEX_HOME 或 `~\.codex\`）。 */
export const CODEX_DIRNAME = '.codex';

/** Spec §2.3：codex project 级 skills 目录（`.agents\skills\`）。 */
export const CODEX_PROJECT_SKILLS_DIRNAME = '.agents';

/**
 * codex 技能 sidecar 的目录名与文件名（`agents\openai.yaml`）。
 *
 * **实测 codex 0.147.0**（隔离的 `CODEX_HOME` + 与家目录不相干的 CWD，用
 * `codex debug prompt-input` 直接读「模型可见的提示词」）：
 * - 只有 `SKILL.md` → 技能出现在模型可见的清单里；
 * - 加上本 sidecar（`policy.allow_implicit_invocation: false`）→ **从清单中消失**；
 * - 只在 frontmatter 写 `disable-model-invocation: true`、不给 sidecar → 仍在清单里
 *   （codex 确实不认这个键，也不因它拒绝加载技能）；
 * - sidecar 里多一个 codex 不认识的字段 → 依旧从清单消失（未知字段被忽略，已知
 *   字段照样生效）；sidecar 是**非法 YAML** → 整份 sidecar 被忽略（codex 内部口径
 *   `ignoring <path>: invalid ...`），技能仍加载、仍进清单。
 *
 * 即最坏情况只退化成「和 always 一样」，不会让技能加载失败；`/skills` 与
 * doctor 的 skills-on-demand 条目都能看出来。
 */
export const CODEX_SKILL_AGENTS_DIRNAME = 'agents';
export const CODEX_SKILL_POLICY_FILENAME = 'openai.yaml';

/**
 * 按需装载技能的 codex sidecar 正文（`skills.on_demand`）。
 *
 * `allow_implicit_invocation: false` = 不按用户 prompt 隐式触发，显式 `$name`
 * 仍然可用。只写这一个键：sidecar 的其余字段（display_name / icon / dependencies）
 * 是技能作者的事，AgentForge 无从代填，多写一个空壳只会覆盖不掉的噪音。
 */
export const CODEX_SKILL_ON_DEMAND_POLICY = 'policy:\n  allow_implicit_invocation: false\n';

/** Spec §2.3 / §8.4 MCP 配置文件（config.toml）。 */
export const CODEX_CONFIG_FILENAME = 'config.toml';

/**
 * 会话钩子文件（§7.4 hook 档）：codex 在每个 config 层旁同时读 `hooks.json` 与
 * inline `[hooks]`，这里取独立文件。
 *
 * 为什么不写进 config.toml 的标记段：一个 `ProjectionPlan` 只带**一对**
 * `tomlMarkers`（plan 级，非 item 级），而 MCP 段已经占用了它；再塞一对要么改
 * 契约，要么与 MCP 段混在一起（语义错乱）。取独立文件后该文件由 AgentForge 独占，
 * 于是可以用 `write` 动作 → 直接落进 §7.6 的 `artifacts` 记账 → `auto_capture`
 * 改回 `off` / `prompt` 时被 prune 整文件删掉，不需要任何新的清理路径。
 *
 * 代价：codex 在同一层同时存在 `hooks.json` 与 inline `[hooks]` 时会启动告警
 * （上游文档："Prefer one representation per layer"）。除 docs/learning.md 写明外，
 * doctor 的 `learning-auto-capture-hook-inline` 会在真的撞上时报 warn
 * （判定用本文件的 `codexTomlHasInlineHooks`；sync 侧不拦——plan 是纯函数，不读目标文件）。
 */
export const CODEX_HOOKS_FILENAME = 'hooks.json';

/**
 * Spec §8.4 Commands 目录名（§8.8）：codex 用 `prompts`，且**只有 user 级生效**。
 * §8.8.5 实测项目级 `.codex\prompts\` 不展开，故 project scope 不产出该项。
 */
export const CODEX_PROMPTS_DIRNAME = 'prompts';

/** Spec §8.4：codex MCP 标记段（writer 默认 `# BEGIN AGENTFORGE` 的 MCP 变体）。 */
export const CODEX_MCP_TOML_BEGIN = '# BEGIN AGENTFORGE MCP';
export const CODEX_MCP_TOML_END = '# END AGENTFORGE MCP';

/**
 * codex 全局根目录（user scope）：CODEX_HOME 覆盖，否则 `<home>\.codex`（Spec §2.2）。
 *
 * 覆盖值过 core/paths 的统一守卫（`~` 展开 + UNC / 无盘符绝对路径拒绝）：本目录同时是
 * `config.toml`（merge_toml）与 `hooks.json`（整文件 write）的落点，未校验的取值等于
 * 把一次整文件覆盖导向任意目录。
 */
function codexUserDir(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  return resolveOverridableDir(
    ctx.env?.codexHome,
    api.join(ctx.rootDir, CODEX_DIRNAME),
    CODEX_HOME_ENV,
    ctx.rootDir,
    ctx.os,
  );
}

// ---------------------------------------------------------------------------
// TOML 手写序列化（无 TOML 库依赖；仅覆盖 MCP 片段所需的字面子集）
// ---------------------------------------------------------------------------

/** TOML bare key（A-Za-z0-9_-；长度 ≥1）；否则需用 basic string 引号包裹。 */
function isBareKey(key: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(key);
}

/**
 * TOML basic string（双引号 + 转义）：`"`、`\`、控制字符（\b \t \n \f \r、
 * \uXXXX）。其余字符（含中文 / Unicode）原样输出（TOML 允许非 ASCII 字面量）。
 */
export function tomlBasicString(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\b':
        out += '\\b';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\f':
        out += '\\f';
        break;
      case '\r':
        out += '\\r';
        break;
      default: {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) {
          out += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          out += ch;
        }
      }
    }
  }
  return `${out}"`;
}

/** TOML 键：bare key 原样，否则 quoted（basic string）。 */
function tomlKey(key: string): string {
  return isBareKey(key) ? key : tomlBasicString(key);
}

/** TOML 字符串数组：`["a", "b"]`。 */
function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((v) => tomlBasicString(v)).join(', ')}]`;
}

/** TOML inline table（string 值）：`{ KEY = "v", K2 = "v2" }`。 */
function tomlInlineTable(values: Readonly<Record<string, string>>): string {
  const entries = Object.entries(values).map(([k, v]) => `${tomlKey(k)} = ${tomlBasicString(v)}`);
  return `{ ${entries.join(', ')} }`;
}

/**
 * MCP servers → TOML 片段（merge_toml 的 item.content，标记段内正文）。
 *
 * 条目模型（含 enabled=false 过滤、transport 字段名、sse 跳过）来自
 * projectors/mcp-transport.codexMcpEntries；本函数只做 TOML 文本化：
 * - 每个 server 一个 `[mcp_servers.<name>]` **单表**（codex 的 `mcp_servers` 是
 *   name → table 映射；写成 `[[...]]` 数组表会让 codex 整份 config.toml 报
 *   "invalid type: map, expected a string" 而拒绝加载）；
 * - stdio → command / args / env；streamable HTTP → url / http_headers；
 * - 空 entries → 空字符串（标记段为空块 `BEGIN\nEND`，保留管理段声明）；
 * - 多个 server 的表块之间以空行分隔。
 */
export function serializeMcpServersToml(servers: readonly McpServer[]): string {
  return codexMcpEntries(servers)
    .map((entry) => codexEntryBlock(entry))
    .join('\n\n');
}

/** 单个 `[mcp_servers.<name>]` 表块（键序固定，保证 sync 幂等）。 */
function codexEntryBlock(entry: CodexMcpEntry): string {
  const lines: string[] = [`[mcp_servers.${tomlKey(entry.name)}]`];
  if (entry.command !== undefined) {
    lines.push(`command = ${tomlBasicString(entry.command)}`);
  }
  if (entry.args !== undefined && entry.args.length > 0) {
    lines.push(`args = ${tomlStringArray(entry.args)}`);
  }
  if (entry.env !== undefined && Object.keys(entry.env).length > 0) {
    lines.push(`env = ${tomlInlineTable(entry.env)}`);
  }
  if (entry.url !== undefined) {
    lines.push(`url = ${tomlBasicString(entry.url)}`);
  }
  if (entry.httpHeaders !== undefined && Object.keys(entry.httpHeaders).length > 0) {
    lines.push(`http_headers = ${tomlInlineTable(entry.httpHeaders)}`);
  }
  return lines.join('\n');
}

/** 主规则绝对路径（`status` / `init` 打印"实际将写入的路径"也用它，Spec §2.2）。 */
export function codexMainRulePath(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  const base = ctx.scope === 'project' ? ctx.rootDir : codexUserDir(ctx);
  return api.join(base, CODEX_MAIN_RULE_FILENAME);
}

/** skills 根目录（project / user 两个 scope 不同）。 */
export function codexSkillsDir(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  // §2.3：project = `<root>\.agents\skills\<name>\SKILL.md`
  // §8.4：user = `CODEX_HOME\skills\` 或 `~\.codex\skills\`
  return ctx.scope === 'project'
    ? api.join(ctx.rootDir, CODEX_PROJECT_SKILLS_DIRNAME, SKILLS_DIRNAME)
    : api.join(codexUserDir(ctx), SKILLS_DIRNAME);
}

/** 单个 skill 的目标 SKILL.md 路径（project / user 两个 scope 的 skills 根不同）。 */
export function codexSkillPath(ctx: ProjectContext, skillName: string): string {
  return skillDocPath(pathApiFor(ctx.os), codexSkillsDir(ctx), skillName);
}

/**
 * 按需装载技能的 codex sidecar 路径：`<skills 根>\<name>\agents\openai.yaml`。
 *
 * codex 是四家里唯一**不认** frontmatter 的 `disable-model-invocation` 的（实测
 * 0.147.0：只写该键的技能照样进模型清单）：它的调用策略写在技能目录下的
 * `agents\openai.yaml`，`policy.allow_implicit_invocation: false` 表示「不按用户
 * prompt 隐式触发，显式 `$name` 仍可用」——正是 `skills.on_demand` 要的语义。
 * 实测口径与失效时的退化行为见 `CODEX_SKILL_AGENTS_DIRNAME`。故 on_demand 技能在
 * codex 侧多一个 write 项（§7.6 记账与 prune 自动覆盖：它就是个整文件产物）。
 *
 * 只在 `skill.onDemand === true` 时产出：`always` 的产物集合因此完全不变。
 */
export function codexSkillPolicyPath(ctx: ProjectContext, skillName: string): string {
  const api = pathApiFor(ctx.os);
  return api.join(
    codexSkillsDir(ctx),
    skillName,
    CODEX_SKILL_AGENTS_DIRNAME,
    CODEX_SKILL_POLICY_FILENAME,
  );
}

/**
 * 单个命令薄壳的目标路径（§8.8 / §8.4 Commands 行）——**仅 user scope 有意义**。
 *
 * §8.8.5 实测：codex 的自定义 prompt 只读 `$CODEX_HOME\prompts\`，项目级
 * `.codex\prompts\` 放进去 `/name` 不展开，`codex app-server` 协议里也没有任何
 * custom prompt 方法。因此 project scope 由 plan 整项跳过（§8.8.4），不写
 * `%USERPROFILE%`——那会把项目级配置泄漏成全局配置。
 *
 * 调用方须自行保证 `ctx.scope === 'user'`；project scope 下调用只会得到一个
 * 不生效的路径（保留可计算性，便于 doctor 在提示里说明「本该落在哪」）。
 */
export function codexCommandPath(ctx: ProjectContext, command: CommandArtifact): string {
  const api = pathApiFor(ctx.os);
  // prompts\ 是平铺目录（codex 无命名空间概念），命名空间拼进文件名（§8.8.2 降级）
  return flatCommandFilePath(api, api.join(codexUserDir(ctx), CODEX_PROMPTS_DIRNAME), command);
}

/** MCP 配置绝对路径（project 级 `<root>\.codex\config.toml`；user 级全局 config.toml）。 */
export function codexConfigPath(ctx: ProjectContext): string {
  return pathApiFor(ctx.os).join(codexConfigDir(ctx), CODEX_CONFIG_FILENAME);
}

/**
 * 会话钩子文件绝对路径（§7.4 hook 档）：与 config.toml 同目录——codex 只在
 * **config 层旁**发现 hooks（project 层要求该 `.codex\` 已被信任）。
 */
export function codexHooksPath(ctx: ProjectContext): string {
  return pathApiFor(ctx.os).join(codexConfigDir(ctx), CODEX_HOOKS_FILENAME);
}

/** config 层目录（project = `<root>\.codex`；user = CODEX_HOME 或 `~\.codex`）。 */
function codexConfigDir(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  return ctx.scope === 'project' ? api.join(ctx.rootDir, CODEX_DIRNAME) : codexUserDir(ctx);
}

/**
 * config.toml 文本里是否有 inline `[hooks]` 表（纯函数；调用方负责读文件）。
 *
 * 判定只认**表头行**：`[hooks]` / `[hooks.X]` / `[[hooks.X]]`，行首允许缩进，
 * `#` 开头的注释行不算。不引 TOML parser：这里只需要一个「有没有」的判断，
 * 而 config.toml 可能因用户的其他语法错误解析失败——那种情况下报不出这条提示
 * 反而更糟（解析失败另有 codex 自己的报错）。
 *
 * 用途：hook 档投出 `hooks.json` 后，codex 在同一 config 层同时看到两种钩子表示
 * 会每次启动告警；由 doctor 读文件后调本函数出 warn（sync 侧的 plan 是纯函数，
 * 不能看目标文件内容）。
 */
export function codexTomlHasInlineHooks(toml: string): boolean {
  return toml.split('\n').some((line) => /^\s*\[\[?hooks(\]|\.)/.test(line) && !/^\s*#/.test(line));
}

/** Codex projector 实例（纯函数 plan；apply 由引擎统一执行）。 */
export const codexProjector: Projector = {
  id: 'codex',

  /**
   * §8.8 实测：codex 是四家里唯一用 `$<name>` 调技能的（`codex exec` 下同样生效），
   * `/<name>` 不展开。status 必须显式提示，否则用户会以为 codex 没生效。
   */
  skillInvokePrefix: '$',

  skillDir: codexSkillsDir,
  skillPath: codexSkillPath,

  /**
   * 四家里唯一支持"独立文件 + 纯配置数据"的会话钩子声明（§7.4 hook 档）。
   * 落点与形状见 CODEX_HOOKS_FILENAME 与 learning/hook-capture.codexSessionHooksJson。
   */
  writesSessionHooks: true,

  plan(ctx: ProjectContext): ProjectionPlan {
    const items: ProjectionPlanItem[] = [];

    // 主规则（§8.7 ✅）：动作与 marker 语义按 projection.marker_mode（§4.2）；
    // projection.write_agents_md=false 时整项不产出
    if (shouldWriteAgentsMd(ctx)) {
      items.push({
        path: codexMainRulePath(ctx),
        action: mainRuleAction(ctx),
        content: ctx.renderedRulesMd,
      });
    }

    // skills：write 实体 copy（M8 skill add 接入后非空；事务内由引擎统一备份/回滚）。
    // on_demand 的技能额外产出 sidecar：codex 的「不隐式调用」开关在
    // agents\openai.yaml 而不是 frontmatter（见 codexSkillPolicyPath）
    for (const skill of ctx.skillsToMaterialize) {
      items.push({
        path: codexSkillPath(ctx, skill.name),
        action: 'write',
        content: skill.content,
      });
      if (skill.onDemand === true) {
        items.push({
          path: codexSkillPolicyPath(ctx, skill.name),
          action: 'write',
          content: CODEX_SKILL_ON_DEMAND_POLICY,
        });
      }
    }

    // Commands 薄壳（§8.8）：**只在 user scope 产出**。project scope 整项跳过
    // （§8.8.4：codex 只读 $CODEX_HOME\prompts\，写 %USERPROFILE% 会把项目级配置
    // 泄漏成全局配置）；跳过原因由 doctor 的 commands/codex-project-unsupported 说明，
    // codex 侧用 `$<skill-name>` 即可，无需命令文件
    if (ctx.scope === 'user') {
      for (const command of ctx.commandsToExpose) {
        items.push({
          path: codexCommandPath(ctx, command),
          action: 'write',
          content: renderCommandShell(command),
        });
      }
    }

    // MCP：merge_toml——只替换 `# BEGIN AGENTFORGE MCP` 标记段（§8.4）
    items.push({
      path: codexConfigPath(ctx),
      action: 'merge_toml',
      content: serializeMcpServersToml(ctx.mcpServers),
    });

    // 会话钩子（§7.4 hook 档）：整文件 write → 走 §7.6 artifacts 记账 + prune，
    // `auto_capture` 改回 off / prompt 后该项不再产出，下一轮 sync 把文件删掉
    if (shouldWriteSessionHook(ctx)) {
      items.push({
        path: codexHooksPath(ctx),
        action: 'write',
        content: codexSessionHooksJson(),
      });
    }

    return {
      targetId: 'codex',
      items,
      tomlMarkers: { begin: CODEX_MCP_TOML_BEGIN, end: CODEX_MCP_TOML_END },
    };
  },
};
