/**
 * Codex Projector（Spec §8.4 / §2.3 / §2.2 / §11-2）。
 *
 * | 角色     | Project                          | User                                   |
 * |----------|----------------------------------|----------------------------------------|
 * | 主规则   | `<root>\AGENTS.md`               | `CODEX_HOME` 或 `%USERPROFILE%\.codex\AGENTS.md` |
 * | Skills   | `.agents\skills\<name>\SKILL.md` | `CODEX_HOME\skills\` 或 `~\.codex\skills\` |
 * | MCP      | `.codex\config.toml` 中 `# BEGIN AGENTFORGE MCP` 标记段 | 全局 config.toml |
 *
 * - 主规则 merge_marker（marker 外保留，Spec §8.2）；
 * - MCP 用 merge_toml：只替换 `# BEGIN AGENTFORGE MCP` / `# END AGENTFORGE MCP`
 *   标记段（标记段外用户 TOML 与注释原样保留，Spec §8.4 / §8.2）；
 *   片段为 `[[mcp_servers.<name>]]` 表 + stdio（command/args/env）或
 *   http/sse（url/headers）键值文本——手写序列化，无 TOML 库依赖
 *   （含 basic string 转义 / bare key 判定 / inline table / 数组）；
 * - skills：write 实体 copy（Spec §7.6 默认不使用 symlink）；
 * - plan 为纯函数：不做任何 IO，路径按注入 os 选择分隔符（Spec §2.1）；
 *   CODEX_HOME 经 ctx.env（engine 注入，Spec §2.4）覆盖。
 */
import path from 'node:path';
import type { McpServer } from '../../../schema';
import type { ProjectContext, Projector, ProjectionPlan, ProjectionPlanItem } from '../types';

/** Spec §2.3 / §8.4 主规则文件名（project / user 两个 scope 同名）。 */
export const CODEX_MAIN_RULE_FILENAME = 'AGENTS.md';

/** codex 的配置目录（project 级 `.codex\`；user 级为 CODEX_HOME 或 `~\.codex\`）。 */
export const CODEX_DIRNAME = '.codex';

/** Spec §2.3：codex project 级 skills 目录（`.agents\skills\`）。 */
export const CODEX_PROJECT_SKILLS_DIRNAME = '.agents';

/** Spec §2.3 skills 子目录名。 */
export const SKILLS_DIRNAME = 'skills';

/** skills 内的单 skill 说明文件名（各 target 统一约定）。 */
export const SKILL_DOC_FILENAME = 'SKILL.md';

/** Spec §2.3 / §8.4 MCP 配置文件（config.toml）。 */
export const CODEX_CONFIG_FILENAME = 'config.toml';

/** Spec §8.4：codex MCP 标记段（writer 默认 `# BEGIN AGENTFORGE` 的 MCP 变体）。 */
export const CODEX_MCP_TOML_BEGIN = '# BEGIN AGENTFORGE MCP';
export const CODEX_MCP_TOML_END = '# END AGENTFORGE MCP';

/** 按注入 os 选择路径 api（win32 / posix）。 */
function pathApi(ctx: ProjectContext): typeof path.win32 | typeof path.posix {
  return ctx.os.platform === 'win32' ? path.win32 : path.posix;
}

/** codex 全局根目录（user scope）：CODEX_HOME 覆盖，否则 `<home>\.codex`（Spec §2.2）。 */
function codexUserDir(ctx: ProjectContext): string {
  const api = pathApi(ctx);
  return ctx.env?.codexHome !== undefined && ctx.env.codexHome !== ''
    ? api.resolve(ctx.env.codexHome)
    : api.join(ctx.rootDir, CODEX_DIRNAME);
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
 * - enabled=false 的 server 不投影（Spec §4.2 语义）；
 * - stdio → `[[mcp_servers.<name>]]` + command / args / env；
 * - http / sse → `[[mcp_servers.<name>]]` + url / headers；
 * - 空 servers → 空字符串（标记段为空块 `BEGIN\nEND`，保留管理段声明）；
 * - 多个 server 的表块之间以空行分隔。
 */
export function serializeMcpServersToml(servers: readonly McpServer[]): string {
  const blocks: string[] = [];
  for (const server of servers) {
    if (server.enabled === false) {
      continue;
    }
    const lines: string[] = [`[[mcp_servers.${tomlKey(server.name)}]]`];
    if (server.transport === 'stdio') {
      lines.push(`command = ${tomlBasicString(server.command ?? '')}`);
      if (server.args !== undefined && server.args.length > 0) {
        lines.push(`args = ${tomlStringArray(server.args)}`);
      }
      if (server.env !== undefined) {
        const entries = Object.entries(server.env);
        if (entries.length > 0) {
          lines.push(`env = ${tomlInlineTable(server.env)}`);
        }
      }
    } else {
      // http / sse → url 形态（transport 差异由工具端按 url 识别，Phase 2 MCP 对齐）
      lines.push(`url = ${tomlBasicString(server.url ?? '')}`);
      if (server.headers !== undefined) {
        const entries = Object.entries(server.headers);
        if (entries.length > 0) {
          lines.push(`headers = ${tomlInlineTable(server.headers)}`);
        }
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/** 主规则绝对路径（`status` / `init` 打印"实际将写入的路径"也用它，Spec §2.2）。 */
export function codexMainRulePath(ctx: ProjectContext): string {
  const api = pathApi(ctx);
  const base = ctx.scope === 'project' ? ctx.rootDir : codexUserDir(ctx);
  return api.join(base, CODEX_MAIN_RULE_FILENAME);
}

/** 单个 skill 的目标 SKILL.md 路径（project / user 两个 scope 的 skills 根不同）。 */
export function codexSkillPath(ctx: ProjectContext, skillName: string): string {
  const api = pathApi(ctx);
  // §2.3：project = `<root>\.agents\skills\<name>\SKILL.md`
  // §8.4：user = `CODEX_HOME\skills\` 或 `~\.codex\skills\`
  const skillsRoot =
    ctx.scope === 'project'
      ? api.join(ctx.rootDir, CODEX_PROJECT_SKILLS_DIRNAME, SKILLS_DIRNAME)
      : api.join(codexUserDir(ctx), SKILLS_DIRNAME);
  return api.join(skillsRoot, skillName, SKILL_DOC_FILENAME);
}

/** MCP 配置绝对路径（project 级 `<root>\.codex\config.toml`；user 级全局 config.toml）。 */
export function codexConfigPath(ctx: ProjectContext): string {
  const api = pathApi(ctx);
  const base = ctx.scope === 'project' ? api.join(ctx.rootDir, CODEX_DIRNAME) : codexUserDir(ctx);
  return api.join(base, CODEX_CONFIG_FILENAME);
}

/** Codex projector 实例（纯函数 plan；apply 由引擎统一执行）。 */
export const codexProjector: Projector = {
  id: 'codex',

  plan(ctx: ProjectContext): ProjectionPlan {
    const items: ProjectionPlanItem[] = [
      // 主规则：merge_marker——marker 外用户内容保留（Spec §8.2）
      {
        path: codexMainRulePath(ctx),
        action: 'merge_marker',
        content: ctx.renderedRulesMd,
      },
    ];

    // skills：write 实体 copy（M8 skill add 接入后非空；事务内由引擎统一备份/回滚）
    for (const skill of ctx.skillsToMaterialize) {
      items.push({
        path: codexSkillPath(ctx, skill.name),
        action: 'write',
        content: skill.content,
      });
    }

    // MCP：merge_toml——只替换 `# BEGIN AGENTFORGE MCP` 标记段（§8.4）
    items.push({
      path: codexConfigPath(ctx),
      action: 'merge_toml',
      content: serializeMcpServersToml(ctx.mcpServers),
    });

    return {
      targetId: 'codex',
      items,
      tomlMarkers: { begin: CODEX_MCP_TOML_BEGIN, end: CODEX_MCP_TOML_END },
    };
  },
};
