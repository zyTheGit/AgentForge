/**
 * Claude Code Projector（Spec §8.5 / §2.3 / §11-2）。
 *
 * | 角色     | Project                     | User                          |
 * |----------|-----------------------------|-------------------------------|
 * | 主规则   | `<root>\CLAUDE.md`          | `%USERPROFILE%\.claude\CLAUDE.md` |
 * | Skills   | `.claude\skills\<name>\SKILL.md` | `%USERPROFILE%\.claude\skills\` |
 * | MCP      | `.mcp.json`（mcpServers）   | 对应全局配置                  |
 *
 * M5 范围：仅主规则（merge_marker，§8.2 同一 SoT 渲染一次分发）。
 * - skills：路径常量已定义（§8.5），物化在 M8（skill add / copy_mode）接入；
 * - MCP：`.mcp.json`（merge_json）留待 M6/M8，ProjectContext.mcpServers 契约已就位。
 *
 * plan 为纯函数：不做任何 IO，路径按注入 os 选择分隔符（Spec §2.1）。
 */
import path from 'node:path';
import type { ProjectContext, Projector, ProjectionPlan } from '../types';

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

/** MCP 配置绝对路径（M5 仅定义契约；M6/M8 以 merge_json 产出投影项）。 */
export function claudeMcpPath(ctx: ProjectContext): string {
  return pathApi(ctx).join(ctx.rootDir, CLAUDE_MCP_FILENAME);
}

/** Claude Code projector 实例（纯函数 plan；apply 由引擎统一执行）。 */
export const claudeProjector: Projector = {
  id: 'claude',

  plan(ctx: ProjectContext): ProjectionPlan {
    // 主规则：merge_marker——marker 外用户内容保留（Spec §8.2），
    // 区间内容为同一份 renderedRulesMd（同一 SoT 渲染一次，§8.2）
    return {
      targetId: 'claude',
      items: [
        {
          path: claudeMainRulePath(ctx),
          action: 'merge_marker',
          content: ctx.renderedRulesMd,
        },
      ],
    };
  },
};
