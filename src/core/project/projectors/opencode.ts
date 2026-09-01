/**
 * OpenCode Projector（Spec §8.3 / §2.3 / §2.2 / §11-2）。
 *
 * | 角色     | Project                     | User                              |
 * |----------|-----------------------------|-----------------------------------|
 * | 主规则   | `<root>\AGENTS.md`          | `%USERPROFILE%\.config\opencode\AGENTS.md` |
 * | CLAUDE.md（§8.7 可选） | `<root>\CLAUDE.md` | `~\.config\opencode\CLAUDE.md` |
 * | Skills   | `.opencode\skills\<name>\SKILL.md` | `~\.config\opencode\skills\` |
 * | MCP      | `<root>\opencode.json`（merge_json） | `~\.config\opencode\opencode.json` |
 * | Commands | `.opencode\command\<name>.md` | `~\.config\opencode\command\` |
 *
 * - 主规则动作按 profile.projection.marker_mode（§4.2）：merge_marker 时 marker 外
 *   用户内容保留（§8.2），none 时整文件 write；区间内容为同一 SoT 渲染一次的
 *   renderedRulesMd（Spec §8.2）；
 * - `projection.write_agents_md: false` 关闭 AGENTS.md；`write_claude_md: true`
 *   额外产出 §8.7 标记为「可选」的 CLAUDE.md（缺省不产出）；
 * - MCP 恒产出（含空 servers——写入空管理键声明"mcp 键归 AgentForge 管理"，
 *   深合并时未知键/未知 server 保留，Spec §8.2）；
 *   payload 采用 OpenCode 配置惯例：顶层 `mcp` 键，条目形状由 mcp-transport
 *   归一化层给出（stdio → `type: "local"`；http / sse 均 → `type: "remote"`——
 *   上游远端形态无法区分 SSE，sse 由 doctor / sync 报 degraded 而非硬造字段）；
 * - skills：write 实体 copy（copy_mode=copy，非 symlink，Spec §7.6），
 *   M8 skill add 接入后 skillsToMaterialize 才有内容；
 * - plan 为纯函数：不做任何 IO，路径按注入 os 选择分隔符（Spec §2.1）。
 */
import type { McpServer } from '../../../schema';
import { pathApiFor } from '../../paths';
import { renderCommandShell } from '../commands';
import {
  type CommandArtifact,
  mainRuleAction,
  type ProjectContext,
  type ProjectionPlan,
  type ProjectionPlanItem,
  type Projector,
  shouldWriteAgentsMd,
  shouldWriteOptionalClaudeMd,
} from '../types';
import { opencodeMcpObject } from './mcp-transport';
import { commandFilePath, SKILLS_DIRNAME, skillDocPath } from './shared';

/** Spec §2.3 / §8.3 主规则文件名（project / user 两个 scope 同名）。 */
export const OPENCODE_MAIN_RULE_FILENAME = 'AGENTS.md';

/** §8.7 中标记为「可选」的 CLAUDE.md 文件名（write_claude_md=true 时才产出）。 */
export const OPENCODE_CLAUDE_RULE_FILENAME = 'CLAUDE.md';

/** opencode 的项目级配置目录（skills 物化用，Spec §2.3）。 */
export const OPENCODE_DIRNAME = '.opencode';

/** opencode 的用户级全局目录段（`<home>\.config\opencode`，Spec §2.2）。 */
export const OPENCODE_USER_DIR_SEGMENTS = ['.config', 'opencode'] as const;

/** Spec §2.3 / §8.3 MCP 配置文件（project 级项目根下；user 级全局目录下）。 */
export const OPENCODE_MCP_FILENAME = 'opencode.json';

/**
 * Spec §8.3 Commands 目录名（§8.8）：取**单数** `command`。
 * §8.8.5 实测 `command\` 与 `commands\` 均生效，取单数与上游文档一致。
 */
export const OPENCODE_COMMANDS_DIRNAME = 'command';

/**
 * user scope 的 opencode 全局目录（`<home>\.config\opencode`，
 * 与 paths.resolveTargetUserDirs().opencode 同构——rootDir 即用户目录）。
 */
function opencodeUserDir(ctx: ProjectContext): string {
  return pathApiFor(ctx.os).join(ctx.rootDir, ...OPENCODE_USER_DIR_SEGMENTS);
}

/**
 * OpenCode MCP 管理键 JSON 载荷（merge_json 的 item.content）。
 *
 * 顶层 `mcp` 键；条目形状由 mcp-transport 归一化层给出，enabled=false 的 server
 * 不投影（Spec §4.2 语义）。空数组 → `{"mcp":{}}`（保留管理键声明）。
 */
export function opencodeMcpPayload(servers: readonly McpServer[]): string {
  return JSON.stringify({ mcp: opencodeMcpObject(servers) });
}

/** 主规则绝对路径（`status` / `init` 打印"实际将写入的路径"也用它，Spec §2.2）。 */
export function opencodeMainRulePath(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  const base = ctx.scope === 'project' ? ctx.rootDir : opencodeUserDir(ctx);
  return api.join(base, OPENCODE_MAIN_RULE_FILENAME);
}

/**
 * §8.7「可选」CLAUDE.md 的绝对路径（与主规则同目录）。
 * project scope 下与 claude target 的 `<root>\CLAUDE.md` 是同一路径——两者内容
 * 同为 renderedRulesMd，引擎按路径去重备份、写入幂等，同时启用不会互相打架。
 */
export function opencodeClaudeRulePath(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  const base = ctx.scope === 'project' ? ctx.rootDir : opencodeUserDir(ctx);
  return api.join(base, OPENCODE_CLAUDE_RULE_FILENAME);
}

/** 单个 skill 的目标 SKILL.md 路径（project / user 两个 scope 的 skills 根不同）。 */
export function opencodeSkillPath(ctx: ProjectContext, skillName: string): string {
  const api = pathApiFor(ctx.os);
  // §2.3：project = `<root>\.opencode\skills\<name>\SKILL.md`
  // §8.3：user = `~\.config\opencode\skills\<name>\SKILL.md`
  const skillsRoot =
    ctx.scope === 'project'
      ? api.join(ctx.rootDir, OPENCODE_DIRNAME, SKILLS_DIRNAME)
      : api.join(opencodeUserDir(ctx), SKILLS_DIRNAME);
  return skillDocPath(api, skillsRoot, skillName);
}

/** MCP 配置绝对路径（project 级项目根下 opencode.json，Spec §2.3 二选一取项目根）。 */
export function opencodeMcpPath(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  const base = ctx.scope === 'project' ? ctx.rootDir : opencodeUserDir(ctx);
  return api.join(base, OPENCODE_MCP_FILENAME);
}

/**
 * 单个命令薄壳的目标路径（§8.8 / §8.3 Commands 行）。
 *
 * 目录名取**单数** `command\`：§8.8.5 实测 `command\` 与 `commands\` 均生效，
 * 取单数与上游文档一致，避免同一技能在两个目录下各留一份。
 * 命名空间落成子目录（§8.8.2）：opencode 的 `/ns/name` 调用语法由目录层级派生。
 */
export function opencodeCommandPath(ctx: ProjectContext, command: CommandArtifact): string {
  const api = pathApiFor(ctx.os);
  const commandsRoot =
    ctx.scope === 'project'
      ? api.join(ctx.rootDir, OPENCODE_DIRNAME, OPENCODE_COMMANDS_DIRNAME)
      : api.join(opencodeUserDir(ctx), OPENCODE_COMMANDS_DIRNAME);
  return commandFilePath(api, commandsRoot, command);
}

/** OpenCode projector 实例（纯函数 plan；apply 由引擎统一执行）。 */
export const opencodeProjector: Projector = {
  id: 'opencode',

  /** §8.8 实测：`GET /command` 里技能以 `source: "skill"` 出现，按 `/<name>` 调用。 */
  skillInvokePrefix: '/',

  plan(ctx: ProjectContext): ProjectionPlan {
    const items: ProjectionPlanItem[] = [];

    // 主规则 AGENTS.md（§8.7 ✅）：动作与 marker 语义按 projection.marker_mode；
    // projection.write_agents_md=false 时整项不产出
    if (shouldWriteAgentsMd(ctx)) {
      items.push({
        path: opencodeMainRulePath(ctx),
        action: mainRuleAction(ctx),
        content: ctx.renderedRulesMd,
      });
    }

    // CLAUDE.md（§8.7「可选」）：仅 projection.write_claude_md=true 时产出
    if (shouldWriteOptionalClaudeMd(ctx)) {
      items.push({
        path: opencodeClaudeRulePath(ctx),
        action: mainRuleAction(ctx),
        content: ctx.renderedRulesMd,
      });
    }

    // skills：write 实体 copy（M8 skill add 接入后非空；事务内由引擎统一备份/回滚）
    for (const skill of ctx.skillsToMaterialize) {
      items.push({
        path: opencodeSkillPath(ctx, skill.name),
        action: 'write',
        content: skill.content,
      });
    }

    // Commands 薄壳（§8.8）：expose_as_command 点名时才产出；整文件 write，
    // 走 §7.6 artifacts 记账 + prune（不用 marker）
    for (const command of ctx.commandsToExpose) {
      items.push({
        path: opencodeCommandPath(ctx, command),
        action: 'write',
        content: renderCommandShell(command),
      });
    }

    // MCP：merge_json（AgentForge 管理 `mcp` 键，未知键保留，Spec §8.2）
    items.push({
      path: opencodeMcpPath(ctx),
      action: 'merge_json',
      content: opencodeMcpPayload(ctx.mcpServers),
    });

    return { targetId: 'opencode', items };
  },
};
