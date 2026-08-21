/**
 * OpenCode Projector（Spec §8.3 / §2.3 / §2.2 / §11-2）。
 *
 * | 角色     | Project                     | User                              |
 * |----------|-----------------------------|-----------------------------------|
 * | 主规则   | `<root>\AGENTS.md`          | `%USERPROFILE%\.config\opencode\AGENTS.md` |
 * | Skills   | `.opencode\skills\<name>\SKILL.md` | `~\.config\opencode\skills\` |
 * | MCP      | `<root>\opencode.json`（merge_json） | `~\.config\opencode\opencode.json` |
 *
 * - 主规则 merge_marker：marker 外用户内容保留（Spec §8.2），
 *   区间内容为同一 SoT 渲染一次的 renderedRulesMd（Spec §8.2）；
 * - MCP 恒产出（含空 servers——写入空管理键声明"mcp 键归 AgentForge 管理"，
 *   深合并时未知键/未知 server 保留，Spec §8.2）；
 *   payload 采用 OpenCode 配置惯例：顶层 `mcp` 键，stdio →
 *   `{ type: "local", command: [...], enabled: true }`，http/sse →
 *   `{ type: "remote", url, enabled: true }`；
 * - skills：write 实体 copy（copy_mode=copy，非 symlink，Spec §7.6），
 *   M8 skill add 接入后 skillsToMaterialize 才有内容；
 * - plan 为纯函数：不做任何 IO，路径按注入 os 选择分隔符（Spec §2.1）。
 */
import path from 'node:path';
import type { McpServer } from '../../../schema';
import type { ProjectContext, Projector, ProjectionPlan, ProjectionPlanItem } from '../types';

/** Spec §2.3 / §8.3 主规则文件名（project / user 两个 scope 同名）。 */
export const OPENCODE_MAIN_RULE_FILENAME = 'AGENTS.md';

/** opencode 的项目级配置目录（skills 物化用，Spec §2.3）。 */
export const OPENCODE_DIRNAME = '.opencode';

/** opencode 的用户级全局目录段（`<home>\.config\opencode`，Spec §2.2）。 */
export const OPENCODE_USER_DIR_SEGMENTS = ['.config', 'opencode'] as const;

/** Spec §2.3 skills 子目录名。 */
export const SKILLS_DIRNAME = 'skills';

/** skills 内的单 skill 说明文件名（各 target 统一约定）。 */
export const SKILL_DOC_FILENAME = 'SKILL.md';

/** Spec §2.3 / §8.3 MCP 配置文件（project 级项目根下；user 级全局目录下）。 */
export const OPENCODE_MCP_FILENAME = 'opencode.json';

/** 按注入 os 选择路径 api（win32 / posix）。 */
function pathApi(ctx: ProjectContext): typeof path.win32 | typeof path.posix {
  return ctx.os.platform === 'win32' ? path.win32 : path.posix;
}

/**
 * user scope 的 opencode 全局目录（`<home>\.config\opencode`，
 * 与 paths.resolveTargetUserDirs().opencode 同构——rootDir 即用户目录）。
 */
function opencodeUserDir(ctx: ProjectContext): string {
  return pathApi(ctx).join(ctx.rootDir, ...OPENCODE_USER_DIR_SEGMENTS);
}

/**
 * OpenCode MCP 管理键 JSON 载荷（merge_json 的 item.content）。
 *
 * 顶层 `mcp` 键；enabled=false 的 server 不投影（Spec §4.2 语义）。
 * 空数组 → `{"mcp":{}}`（保留管理键声明）。
 */
export function opencodeMcpPayload(servers: readonly McpServer[]): string {
  const mcp: Record<string, unknown> = {};
  for (const server of servers) {
    if (server.enabled === false) {
      continue;
    }
    if (server.transport === 'stdio') {
      mcp[server.name] = {
        type: 'local',
        command: [server.command ?? '', ...(server.args ?? [])],
        enabled: true,
        ...(server.env !== undefined ? { environment: server.env } : {}),
      };
    } else {
      // http / sse → remote 形态（url + 可选 headers）
      mcp[server.name] = {
        type: 'remote',
        url: server.url ?? '',
        enabled: true,
        ...(server.headers !== undefined ? { headers: server.headers } : {}),
      };
    }
  }
  return JSON.stringify({ mcp });
}

/** 主规则绝对路径（`status` / `init` 打印"实际将写入的路径"也用它，Spec §2.2）。 */
export function opencodeMainRulePath(ctx: ProjectContext): string {
  const api = pathApi(ctx);
  const base = ctx.scope === 'project' ? ctx.rootDir : opencodeUserDir(ctx);
  return api.join(base, OPENCODE_MAIN_RULE_FILENAME);
}

/** 单个 skill 的目标 SKILL.md 路径（project / user 两个 scope 的 skills 根不同）。 */
export function opencodeSkillPath(ctx: ProjectContext, skillName: string): string {
  const api = pathApi(ctx);
  // §2.3：project = `<root>\.opencode\skills\<name>\SKILL.md`
  // §8.3：user = `~\.config\opencode\skills\<name>\SKILL.md`
  const skillsRoot =
    ctx.scope === 'project'
      ? api.join(ctx.rootDir, OPENCODE_DIRNAME, SKILLS_DIRNAME)
      : api.join(opencodeUserDir(ctx), SKILLS_DIRNAME);
  return api.join(skillsRoot, skillName, SKILL_DOC_FILENAME);
}

/** MCP 配置绝对路径（project 级项目根下 opencode.json，Spec §2.3 二选一取项目根）。 */
export function opencodeMcpPath(ctx: ProjectContext): string {
  const api = pathApi(ctx);
  const base = ctx.scope === 'project' ? ctx.rootDir : opencodeUserDir(ctx);
  return api.join(base, OPENCODE_MCP_FILENAME);
}

/** OpenCode projector 实例（纯函数 plan；apply 由引擎统一执行）。 */
export const opencodeProjector: Projector = {
  id: 'opencode',

  plan(ctx: ProjectContext): ProjectionPlan {
    const items: ProjectionPlanItem[] = [
      // 主规则：merge_marker——marker 外用户内容保留（Spec §8.2）
      {
        path: opencodeMainRulePath(ctx),
        action: 'merge_marker',
        content: ctx.renderedRulesMd,
      },
    ];

    // skills：write 实体 copy（M8 skill add 接入后非空；事务内由引擎统一备份/回滚）
    for (const skill of ctx.skillsToMaterialize) {
      items.push({
        path: opencodeSkillPath(ctx, skill.name),
        action: 'write',
        content: skill.content,
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
