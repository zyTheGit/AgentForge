/**
 * Claude Code Projector（Spec §8.5 / §2.3 / §11-2）。
 *
 * | 角色     | Project                     | User                          |
 * |----------|-----------------------------|-------------------------------|
 * | 主规则   | `<root>\CLAUDE.md`          | `%USERPROFILE%\.claude\CLAUDE.md` |
 * | Skills   | `.claude\skills\<name>\SKILL.md` | `%USERPROFILE%\.claude\skills\` |
 * | MCP      | `.mcp.json`（mcpServers）   | 对应全局配置                  |
 *
 * M6 范围：主规则（merge_marker）+ MCP（`.mcp.json` merge_json）+ skills write 项。
 * - 主规则：marker 外用户内容保留（Spec §8.2），区间内容为同一份 renderedRulesMd
 *   （同一 SoT 渲染一次分发，Spec §8.2）；
 * - MCP 恒产出（含空 servers——写入空 `mcpServers` 管理键，深合并时未知键/未知
 *   server 保留，Spec §8.2）；payload 采用 Claude Code `.mcp.json` 惯例：
 *   stdio → `{ command, args?, env? }`，http/sse → `{ type, url, headers? }`；
 *   user scope 的全局 MCP 策略沿用 M5 契约位（rootDir 基准，Phase 2 MCP 对齐）；
 * - skills：write 实体 copy（copy_mode=copy，非 symlink，Spec §7.6），
 *   M8 skill add 接入后 skillsToMaterialize 才有内容。
 *
 * plan 为纯函数：不做任何 IO，路径按注入 os 选择分隔符（Spec §2.1）。
 */
import path from 'node:path';
import type { McpServer } from '../../../schema';
import type { ProjectContext, Projector, ProjectionPlan, ProjectionPlanItem } from '../types';

/** Spec §8.5 主规则文件名（project / user 两个 scope 同名）。 */
export const CLAUDE_MAIN_RULE_FILENAME = 'CLAUDE.md';

/** claude 的配置目录名（project 级 `.claude\` 与 user 级 `~\.claude\` 同名）。 */
export const CLAUDE_DIRNAME = '.claude';

/** Spec §8.5 skills 相对目录（主规则根下的 `<skillsDir>\<name>\SKILL.md`）。 */
export const CLAUDE_SKILLS_DIRNAME = 'skills';

/** skills 内的单 skill 说明文件名（各 target 统一约定）。 */
export const SKILL_DOC_FILENAME = 'SKILL.md';

/** Spec §8.5 MCP 配置文件（project 级根下）。 */
export const CLAUDE_MCP_FILENAME = '.mcp.json';

/** 按注入 os 选择路径 api（win32 / posix）。 */
function pathApi(ctx: ProjectContext): typeof path.win32 | typeof path.posix {
  return ctx.os.platform === 'win32' ? path.win32 : path.posix;
}

/** 主规则投影根：project → 项目根；user → `<userHome>\.claude`（Spec §8.5）。 */
function claudeBaseDir(ctx: ProjectContext): string {
  const api = pathApi(ctx);
  return ctx.scope === 'project' ? ctx.rootDir : api.join(ctx.rootDir, CLAUDE_DIRNAME);
}

/** 主规则绝对路径（`status` / `init` 打印"实际将写入的路径"也用它，Spec §2.2）。 */
export function claudeMainRulePath(ctx: ProjectContext): string {
  return pathApi(ctx).join(claudeBaseDir(ctx), CLAUDE_MAIN_RULE_FILENAME);
}

/** 单个 skill 的目标路径（M5 仅定义契约；M8 物化时由 projector 产出 write 项）。 */
export function claudeSkillPath(ctx: ProjectContext, skillName: string): string {
  // §8.5：project = `<root>\.claude\skills\<name>\SKILL.md`；user = `<home>\.claude\skills\...`
  // 两个 scope 同构（rootDir 分别为项目根 / 用户目录）
  return pathApi(ctx).join(ctx.rootDir, CLAUDE_DIRNAME, CLAUDE_SKILLS_DIRNAME, skillName, SKILL_DOC_FILENAME);
}

/** MCP 配置绝对路径（project 根下 .mcp.json；user scope 同样落在 rootDir 基准，全局策略 Phase 2 对齐）。 */
export function claudeMcpPath(ctx: ProjectContext): string {
  return pathApi(ctx).join(ctx.rootDir, CLAUDE_MCP_FILENAME);
}

/**
 * Claude MCP 管理键 JSON 载荷（merge_json 的 item.content）。
 *
 * 顶层 `mcpServers` 键（Claude Code `.mcp.json` 惯例）；enabled=false 的
 * server 不投影（Spec §4.2 语义）。空数组 → `{"mcpServers":{}}`（保留管理键声明）。
 */
export function claudeMcpPayload(servers: readonly McpServer[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    if (server.enabled === false) {
      continue;
    }
    if (server.transport === 'stdio') {
      mcpServers[server.name] = {
        command: server.command ?? '',
        ...(server.args !== undefined ? { args: server.args } : {}),
        ...(server.env !== undefined ? { env: server.env } : {}),
      };
    } else {
      // http / sse → type + url（+ 可选 headers）
      mcpServers[server.name] = {
        type: server.transport,
        url: server.url ?? '',
        ...(server.headers !== undefined ? { headers: server.headers } : {}),
      };
    }
  }
  return JSON.stringify({ mcpServers });
}

/** Claude Code projector 实例（纯函数 plan；apply 由引擎统一执行）。 */
export const claudeProjector: Projector = {
  id: 'claude',

  plan(ctx: ProjectContext): ProjectionPlan {
    const items: ProjectionPlanItem[] = [
      // 主规则：merge_marker——marker 外用户内容保留（Spec §8.2），
      // 区间内容为同一份 renderedRulesMd（同一 SoT 渲染一次，§8.2）
      {
        path: claudeMainRulePath(ctx),
        action: 'merge_marker',
        content: ctx.renderedRulesMd,
      },
    ];

    // skills：write 实体 copy（M8 skill add 接入后非空；事务内由引擎统一备份/回滚）
    for (const skill of ctx.skillsToMaterialize) {
      items.push({
        path: claudeSkillPath(ctx, skill.name),
        action: 'write',
        content: skill.content,
      });
    }

    // MCP：merge_json（AgentForge 管理 `mcpServers` 键，未知键保留，Spec §8.2）
    items.push({
      path: claudeMcpPath(ctx),
      action: 'merge_json',
      content: claudeMcpPayload(ctx.mcpServers),
    });

    return { targetId: 'claude', items };
  },
};
