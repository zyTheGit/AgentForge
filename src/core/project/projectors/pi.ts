/**
 * Pi Projector（Spec §8.6 / §2.3 / §2.2 / §11-2，MVP soft）。
 *
 * | 角色          | Project                     | User                            |
 * |---------------|-----------------------------|---------------------------------|
 * | 主规则        | `<root>\AGENTS.md`          | `%USERPROFILE%\.pi\agent\AGENTS.md` |
 * | Skills        | `.pi\skills\<name>\SKILL.md` | `~\.pi\agent\skills\`          |
 * | MCP           | `.pi\mcp.json`（soft）       | `~\.pi\agent\mcp.json`（soft）  |
 *
 * - 主规则动作按 profile.projection.marker_mode（§4.2；merge_marker 时 marker 外
 *   保留，Spec §8.2；none 时整文件 write）；`write_agents_md: false` 关闭该项；
 * - **MCP 前置依赖**：pi 本体不内建 MCP，需先装适配扩展
 *   `pi install npm:pi-mcp-adapter`（https://pi.dev/packages/pi-mcp-adapter）。
 *   适配器的读取优先级（高 → 低）：`.pi\mcp.json`（项目级 pi 覆盖）>
 *   `.mcp.json`（项目共享）> `<Pi agent dir>\mcp.json`（user 级 pi 覆盖）>
 *   `~\.config\mcp\mcp.json` / `~\.agents\mcp.json`（全局共享）。注意 user 级 pi
 *   覆盖排在项目级 `.mcp.json` **之后**（上游：项目文件同时盖过 user 全局共享配置
 *   与 pi 全局覆盖），所以"pi 私有位一定生效"不成立。这里选 pi 私有位的理由是避免
 *   与 claude projector 争用根 `.mcp.json`——同一事务里两个 projector 写同一路径
 *   会互相覆盖；
 * - **MVP soft 语义（Spec §8.6）**：mcp.json 项在 plan 中标记 soft——
 *   引擎 apply 失败（目录/文件异常）时仅收集 warning，不计入失败、不触发回滚，
 *   sync 整体仍算成功（best-effort，扩展没装时这份配置只是躺着不生效）。soft 项
 *   恒产出（含空 servers），payload 为 `{"mcpServers":{...}}`；
 * - skills：write 实体 copy（Spec §7.6 默认不使用 symlink）；
 * - plan 为纯函数：不做任何 IO，路径按注入 os 选择分隔符（Spec §2.1）。
 */
import type { McpServer } from '../../../schema';
import { pathApiFor } from '../../paths';
import {
  mainRuleAction,
  type ProjectContext,
  type ProjectionPlan,
  type ProjectionPlanItem,
  type Projector,
  shouldWriteAgentsMd,
} from '../types';
import { buildMcpServersObject } from './mcp-payload';
import { SKILLS_DIRNAME, skillDocPath } from './shared';

/** Spec §2.3 / §8.6 主规则文件名（project / user 两个 scope 同名）。 */
export const PI_MAIN_RULE_FILENAME = 'AGENTS.md';

/** pi 的项目级配置目录（`.pi\`，Spec §2.3）。 */
export const PI_DIRNAME = '.pi';

/** pi 的用户级全局目录段（`<home>\.pi\agent`，Spec §2.2）。 */
export const PI_USER_DIR_SEGMENTS = ['.pi', 'agent'] as const;

/** Spec §2.3 / §8.6 MCP 配置文件（pi 私有覆盖位，由 pi-mcp-adapter 读取）。 */
export const PI_MCP_FILENAME = 'mcp.json';

/** user scope 的 pi 全局目录（`<home>\.pi\agent`，与 paths.resolveTargetUserDirs().pi 同构）。 */
function piUserDir(ctx: ProjectContext): string {
  return pathApiFor(ctx.os).join(ctx.rootDir, ...PI_USER_DIR_SEGMENTS);
}

/**
 * Pi MCP 管理键 JSON 载荷（merge_json 的 item.content）。
 *
 * 顶层 `mcpServers` 键（pi-mcp-adapter 与 Claude Code 同构）；enabled=false 的
 * server 不投影。空数组 → `{"mcpServers":{}}`（保留管理键声明，深合并时未知键保留）。
 */
export function piMcpPayload(servers: readonly McpServer[]): string {
  return JSON.stringify({ mcpServers: buildMcpServersObject(servers) });
}

/** 主规则绝对路径（`status` / `init` 打印"实际将写入的路径"也用它，Spec §2.2）。 */
export function piMainRulePath(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  const base = ctx.scope === 'project' ? ctx.rootDir : piUserDir(ctx);
  return api.join(base, PI_MAIN_RULE_FILENAME);
}

/** 单个 skill 的目标 SKILL.md 路径（project / user 两个 scope 的 skills 根不同）。 */
export function piSkillPath(ctx: ProjectContext, skillName: string): string {
  const api = pathApiFor(ctx.os);
  // §2.3：project = `<root>\.pi\skills\<name>\SKILL.md`
  // §8.6：user = `~\.pi\agent\skills\<name>\SKILL.md`
  const skillsRoot =
    ctx.scope === 'project'
      ? api.join(ctx.rootDir, PI_DIRNAME, SKILLS_DIRNAME)
      : api.join(piUserDir(ctx), SKILLS_DIRNAME);
  return skillDocPath(api, skillsRoot, skillName);
}

/**
 * MCP 配置绝对路径（project 级 `<root>\.pi\mcp.json`；user 级 `~\.pi\agent\mcp.json`）。
 *
 * **已知限制**：user 级目录段硬编码为 `.pi\agent`，当前不支持 `PI_CODING_AGENT_DIR`
 * （上游 pi-mcp-adapter 在该变量置位时改读它指向的目录）。置位该变量时 user scope 的
 * 投影会落在 pi 不读的路径上，且 MCP 项是 soft、写成功即静默，用户拿不到"这份配置不
 * 生效"的信号。对比 `CODEX_HOME` 已由 paths 层的 `env.codexHome` 认掉。
 */
export function piMcpPath(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  const base = ctx.scope === 'project' ? api.join(ctx.rootDir, PI_DIRNAME) : piUserDir(ctx);
  return api.join(base, PI_MCP_FILENAME);
}

/** Pi projector 实例（纯函数 plan；apply 由引擎统一执行）。 */
export const piProjector: Projector = {
  id: 'pi',

  plan(ctx: ProjectContext): ProjectionPlan {
    const items: ProjectionPlanItem[] = [];

    // 主规则（§8.7 ✅）：动作与 marker 语义按 projection.marker_mode（§4.2）；
    // projection.write_agents_md=false 时整项不产出
    if (shouldWriteAgentsMd(ctx)) {
      items.push({
        path: piMainRulePath(ctx),
        action: mainRuleAction(ctx),
        content: ctx.renderedRulesMd,
      });
    }

    // skills：write 实体 copy（M8 skill add 接入后非空；事务内由引擎统一备份/回滚）
    for (const skill of ctx.skillsToMaterialize) {
      items.push({
        path: piSkillPath(ctx, skill.name),
        action: 'write',
        content: skill.content,
      });
    }

    // MCP：merge_json + soft（Spec §8.6 MVP best-effort——失败仅 warning）；
    // 生效前提是 pi 侧已装 pi-mcp-adapter 扩展
    items.push({
      path: piMcpPath(ctx),
      action: 'merge_json',
      content: piMcpPayload(ctx.mcpServers),
      soft: true,
    });

    return { targetId: 'pi', items };
  },
};
