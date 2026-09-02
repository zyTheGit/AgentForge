/**
 * Claude Code Projector（Spec §8.5 / §2.3 / §11-2）。
 *
 * | 角色     | Project                     | User                          |
 * |----------|-----------------------------|-------------------------------|
 * | 主规则   | `<root>\CLAUDE.md`          | `%USERPROFILE%\.claude\CLAUDE.md` |
 * | Skills   | `.claude\skills\<name>\SKILL.md` | `%USERPROFILE%\.claude\skills\` |
 * | MCP      | `.mcp.json`（mcpServers）   | 对应全局配置                  |
 * | Commands | `.claude\commands\<name>.md` | `%USERPROFILE%\.claude\commands\` |
 *
 * M6 范围：主规则（merge_marker）+ MCP（`.mcp.json` merge_json）+ skills write 项。
 * - 主规则动作按 profile.projection.marker_mode（§4.2；merge_marker 时 marker 外
 *   用户内容保留，Spec §8.2；none 时整文件 write），区间内容为同一份 renderedRulesMd
 *   （同一 SoT 渲染一次分发，Spec §8.2）；`write_claude_md: false` 关闭该项（§8.7）；
 * - MCP 恒产出（含空 servers——写入空 `mcpServers` 管理键，深合并时未知键/未知
 *   server 保留，Spec §8.2）；条目形状由 mcp-transport 归一化层给出（`type` 取
 *   `stdio` / `http` / `sse`，与 `claude mcp add` 写出的 `.mcp.json` 一致）；
 *   user scope 的全局 MCP 策略沿用 M5 契约位（rootDir 基准，见 claudeMcpPath）；
 * - skills：write 实体 copy（copy_mode=copy，非 symlink，Spec §7.6），
 *   M8 skill add 接入后 skillsToMaterialize 才有内容。
 *
 * plan 为纯函数：不做任何 IO，路径按注入 os 选择分隔符（Spec §2.1）。
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
  shouldWriteClaudeMd,
} from '../types';
import { claudeMcpServersObject } from './mcp-transport';
import { commandFilePath, SKILLS_DIRNAME, skillDocPath } from './shared';

/** Spec §8.5 主规则文件名（project / user 两个 scope 同名）。 */
export const CLAUDE_MAIN_RULE_FILENAME = 'CLAUDE.md';

/** claude 的配置目录名（project 级 `.claude\` 与 user 级 `~\.claude\` 同名）。 */
export const CLAUDE_DIRNAME = '.claude';

/** Spec §8.5 MCP 配置文件（project 级根下）。 */
export const CLAUDE_MCP_FILENAME = '.mcp.json';

/** Spec §8.5 Commands 目录名（§8.8：claude 用复数 `commands`）。 */
export const CLAUDE_COMMANDS_DIRNAME = 'commands';

/** 主规则投影根：project → 项目根；user → `<userHome>\.claude`（Spec §8.5）。 */
function claudeBaseDir(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  return ctx.scope === 'project' ? ctx.rootDir : api.join(ctx.rootDir, CLAUDE_DIRNAME);
}

/** 主规则绝对路径（`status` / `init` 打印"实际将写入的路径"也用它，Spec §2.2）。 */
export function claudeMainRulePath(ctx: ProjectContext): string {
  return pathApiFor(ctx.os).join(claudeBaseDir(ctx), CLAUDE_MAIN_RULE_FILENAME);
}

/** skills 根目录：`<rootDir>\.claude\skills`（project / user 两个 scope 同构）。 */
export function claudeSkillsDir(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  // §8.5：project = `<root>\.claude\skills`；user = `<home>\.claude\skills`
  // 两个 scope 同构（rootDir 分别为项目根 / 用户目录）
  return api.join(ctx.rootDir, CLAUDE_DIRNAME, SKILLS_DIRNAME);
}

/** 单个 skill 的目标路径（M5 仅定义契约；M8 物化时由 projector 产出 write 项）。 */
export function claudeSkillPath(ctx: ProjectContext, skillName: string): string {
  return skillDocPath(pathApiFor(ctx.os), claudeSkillsDir(ctx), skillName);
}

/**
 * MCP 配置绝对路径（project 根下 .mcp.json）。
 *
 * **user scope 沿用同一 rootDir 基准**（`<userHome>\.mcp.json`）——这是 M5 起的契约位，
 * Phase 2 未改动。实测 `claude mcp add --scope user` 写的是 `~\.claude.json` 的顶层
 * `mcpServers`、`--scope local` 写的是同一文件里 `projects.<路径>.mcpServers`；换落点
 * 会连带改 §7.6 prune 判据与 sync-meta 记账（同一文件里还混着 claude 自己的大量会话
 * 状态），风险等级与本次「字段对齐」不同，须单独决策。
 */
export function claudeMcpPath(ctx: ProjectContext): string {
  return pathApiFor(ctx.os).join(ctx.rootDir, CLAUDE_MCP_FILENAME);
}

/**
 * 单个命令薄壳的目标路径（§8.8 / §8.5 Commands 行）。
 *
 * 两个 scope 同构：project = `<root>\.claude\commands\<ns...>\<name>.md`；
 * user = `%USERPROFILE%\.claude\commands\<ns...>\<name>.md`（rootDir 分别为项目根 /
 * 用户目录）。命名空间落成子目录——claude 的 `/ns:name` 调用语法由目录层级派生（§8.8.2）。
 */
export function claudeCommandPath(ctx: ProjectContext, command: CommandArtifact): string {
  const api = pathApiFor(ctx.os);
  return commandFilePath(
    api,
    api.join(ctx.rootDir, CLAUDE_DIRNAME, CLAUDE_COMMANDS_DIRNAME),
    command,
  );
}

/**
 * Claude MCP 管理键 JSON 载荷（merge_json 的 item.content）。
 *
 * 顶层 `mcpServers` 键（Claude Code `.mcp.json` 惯例），条目形状由 mcp-transport
 * 归一化层给出；enabled=false 的 server 不投影（Spec §4.2 语义）。
 * 空数组 → `{"mcpServers":{}}`（保留管理键声明）。
 */
export function claudeMcpPayload(servers: readonly McpServer[]): string {
  return JSON.stringify({ mcpServers: claudeMcpServersObject(servers) });
}

/** Claude Code projector 实例（纯函数 plan；apply 由引擎统一执行）。 */
export const claudeProjector: Projector = {
  id: 'claude',

  /** §8.8 实测：`claude --help` 明写 "Skills still resolve via /skill-name"。 */
  skillInvokePrefix: '/',

  skillDir: claudeSkillsDir,
  skillPath: claudeSkillPath,

  /**
   * `false`——**不是**因为 Claude Code 没有会话钩子（实测 2.1.220 的二进制里
   * `SessionEnd` / `SubagentStop` / `PreCompact` / `hook_event_name` 都在，
   * 落点是 `settings.json` / `.claude\settings.json` / `settings.local.json`），
   * 而是因为它的钩子只能并入 `hooks.<Event>` 这个**数组**，而 §8.2 的 merge_json
   * 对数组是整体替换（writer.deepMergeValue）——投影会吞掉用户手写的同事件钩子。
   * 让 AgentForge 安全落地 claude 钩子需要给 merge_json 加"数组按标识合并"语义，
   * 属独立议题；在那之前如实降级（sync notice + doctor warn），不静默覆盖。
   */
  writesSessionHooks: false,

  plan(ctx: ProjectContext): ProjectionPlan {
    const items: ProjectionPlanItem[] = [];

    // 主规则 CLAUDE.md（§8.7 ✅）：动作按 projection.marker_mode（§4.2）——
    // merge_marker 时 marker 外用户内容保留（§8.2）、none 时整文件 write；
    // 区间内容为同一份 renderedRulesMd（同一 SoT 渲染一次，§8.2）；
    // projection.write_claude_md=false 时整项不产出
    if (shouldWriteClaudeMd(ctx)) {
      items.push({
        path: claudeMainRulePath(ctx),
        action: mainRuleAction(ctx),
        content: ctx.renderedRulesMd,
      });
    }

    // skills：write 实体 copy（M8 skill add 接入后非空；事务内由引擎统一备份/回滚）
    for (const skill of ctx.skillsToMaterialize) {
      items.push({
        path: claudeSkillPath(ctx, skill.name),
        action: 'write',
        content: skill.content,
      });
    }

    // Commands 薄壳（§8.8）：expose_as_command 点名时才产出；整文件 write，
    // 走 §7.6 artifacts 记账 + prune（不用 marker）
    for (const command of ctx.commandsToExpose) {
      items.push({
        path: claudeCommandPath(ctx, command),
        action: 'write',
        content: renderCommandShell(command),
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
