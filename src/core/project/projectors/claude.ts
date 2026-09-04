/**
 * Claude Code Projector（Spec §8.5 / §2.3 / §11-2）。
 *
 * | 角色     | Project                     | User                          |
 * |----------|-----------------------------|-------------------------------|
 * | 主规则   | `<root>\CLAUDE.md`          | `%USERPROFILE%\.claude\CLAUDE.md` |
 * | Skills   | `.claude\skills\<name>\SKILL.md` | `%USERPROFILE%\.claude\skills\` |
 * | MCP      | `.mcp.json`（mcpServers）   | **不投影**（见 claudeMcpPath）|
 * | Commands | `.claude\commands\<name>.md` | `%USERPROFILE%\.claude\commands\` |
 *
 * M6 范围：主规则（merge_marker）+ MCP（`.mcp.json` merge_json）+ skills write 项。
 * - 主规则动作按 profile.projection.marker_mode（§4.2；merge_marker 时 marker 外
 *   用户内容保留，Spec §8.2；none 时整文件 write），区间内容为同一份 renderedRulesMd
 *   （同一 SoT 渲染一次分发，Spec §8.2）；`write_claude_md: false` 关闭该项（§8.7）；
 * - MCP：**只在 project scope 产出**（含空 servers——写入空 `mcpServers` 管理键，深
 *   合并时未知键/未知 server 保留，Spec §8.2）；条目形状由 mcp-transport 归一化层给出
 *   （`type` 取 `stdio` / `http` / `sse`，与 `claude mcp add` 写出的 `.mcp.json` 一致）；
 *   user scope **整项不产出**——上游只认 `~\.claude.json`，而那个文件不适合 merge_json，
 *   见 claudeMcpPath 的完整依据与取舍；
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

/**
 * claude 自己的 user 级配置 + 运行时状态文件名（`~\.claude.json`）。
 *
 * 导出只为让 doctor / 命令层的**提示文案**能拼出这条绝对路径。AgentForge 不写它，
 * 理由见 claudeMcpPath。
 */
export const CLAUDE_USER_CONFIG_FILENAME = '.claude.json';

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
 * MCP 配置绝对路径：project scope = `<root>\.mcp.json`；**user scope = null（不投影）**。
 *
 * ## 上游事实（实机验证：Claude Code 2.1.220 / Windows，临时目录重定向
 * `USERPROFILE`+`HOME` 后跑 `claude mcp add` 与 `claude mcp list`）
 *
 * - `--scope project` → `<root>\.mcp.json` 的顶层 `mcpServers`（首次使用要在交互里
 *   approve，`claude mcp list` 显示 "Pending approval"）；
 * - `--scope user` → `~\.claude.json` 的**顶层** `mcpServers`；
 * - `--scope local` → 同一文件的 `projects.<绝对路径>.mcpServers`；
 * - `~\.claude\settings.json` 里写 `mcpServers` **不被读取**：只在那儿声明的 server
 *   经 `claude mcp get <name>` 报 `No MCP server named ...`（settings.json 只有
 *   `enableAllProjectMcpServers` / `enabledMcpjsonServers` 这类"是否放行"的开关）；
 * - `~\.mcp.json`（本函数改之前的 user scope 落点）**不是** user 级来源：cwd 在用户
 *   目录**之下**时它会被 `.mcp.json` 的逐层向上查找当成 *project* 配置捞到，cwd 在别处
 *   时 `claude mcp list` 报 "No MCP servers configured"。所以旧落点对 claude 基本无效
 *   —— issue #52 的现象成立。
 *
 * ## 为什么不改成写 `~\.claude.json`
 *
 * 那个文件不是配置文件，是 claude 的**运行时状态转储**：实测本机 42 个顶层键里只有
 * `mcpServers` 一个属于配置，其余是 `numStartups` / `tipsHistory` / `seenNotifications`
 * 以及 `projects.<路径>` 下的会话历史、成本与 token 统计、`hasTrustDialogAccepted`
 * 信任标记、`--scope local` 的 MCP 声明。claude 每次启动 / 结束都重写它，并且在写之前
 * 自己先存一份 `~\.claude\backups\.claude.json.backup.<epoch>`。
 *
 * 而 §8.2 的 merge_json 是**整文件**读 → 解析 → 序列化 → 原子改名：只要在我们读到写
 * 之间 claude 写过一次（用户日常必然有 claude 在跑），那次写入就被整份丢弃——丢的是
 * 会话状态、信任标记、以及用户用 `--scope local` 加的 MCP 声明。AgentForge 与 claude
 * 之间没有共享的锁协议，这个窗口在投影层关不掉。
 *
 * 「只碰顶层 `mcpServers`、其余键逐字保留」这一条 merge_json 已经做到（未知键保留、
 * 键序保留），但它挡不住上面的丢失更新。所以取舍是：**宁可不写**，如实降级 + 给手工
 * 指引（`claude mcp add --scope user`），同 `writesSessionHooks: false` 的口径——
 * 不静默、不猜、不替用户动他的运行时状态。
 *
 * project scope 不受影响：`<root>\.mcp.json` 与上游完全一致，是 claude 官方推荐的
 * 可入库共享位。`local` scope 也不进 AgentForge 的 scope 模型——它落在同一个
 * `~\.claude.json` 里，风险与 user scope 完全相同。
 *
 * @returns project scope 的绝对路径；user scope 恒为 `null`（调用方据此整项不产出）。
 */
export function claudeMcpPath(ctx: ProjectContext): string | null {
  if (ctx.scope !== 'project') {
    return null;
  }
  return pathApiFor(ctx.os).join(ctx.rootDir, CLAUDE_MCP_FILENAME);
}

/**
 * user scope 下 claude MCP 整项跳过的原因（sync notice / doctor / `mcp remove`
 * 提示共用一句——三处措辞分叉会让用户以为是三件事）。
 *
 * 判据与理由的单一事实源是 claudeMcpPath 的 JSDoc；这里只负责"说给用户听"。
 */
export const CLAUDE_USER_MCP_SKIP_REASON =
  'claude 的 user 级 MCP 只认 ~\\.claude.json 顶层 mcpServers，而该文件同时存放 claude 自己的运行时状态（会话历史 / 信任标记 / local scope 的 MCP 声明）并被 claude 持续重写；AgentForge 的 merge_json 是整文件读改写，会吞掉 claude 并发写入的内容，因此**不投影**该项。请手工登记：claude mcp add --scope user <name> -- <command>（project scope 的 .mcp.json 不受影响）';

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

  /**
   * `.mcp.json` 的 `mcpServers` 键。
   *
   * 恒 `true`：这是「有没有落点」的能力位。user scope 不投影是 scope 维度的取舍
   * （见 `claudeMcpPath` 与 issue #52），由 `sync-notices.collectMcpScopeNotices`
   * 单独说明，不在这里表达。
   */
  writesMcp: true,

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

    // MCP：merge_json（AgentForge 管理 `mcpServers` 键，未知键保留，Spec §8.2）。
    // user scope 整项不产出——上游只认 `~\.claude.json`，那是 claude 的运行时状态
    // 转储，不能拿整文件读改写去碰（依据与取舍见 claudeMcpPath）。降级由
    // sync-notices / doctor 明说，不静默
    const mcpPath = claudeMcpPath(ctx);
    if (mcpPath !== null) {
      items.push({
        path: mcpPath,
        action: 'merge_json',
        content: claudeMcpPayload(ctx.mcpServers),
      });
    }

    return { targetId: 'claude', items };
  },
};
