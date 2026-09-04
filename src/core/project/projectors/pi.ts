/**
 * Pi Projector（Spec §8.6 / §2.3 / §2.2 / §11-2，MVP soft）。
 *
 * | 角色          | Project                     | User                            |
 * |---------------|-----------------------------|---------------------------------|
 * | 主规则        | `<root>\AGENTS.md`          | `<pi agent dir>\AGENTS.md`      |
 * | Skills        | `.pi\skills\<name>\SKILL.md` | `<pi agent dir>\skills\`       |
 * | MCP           | `.pi\mcp.json`（soft）       | `<pi agent dir>\mcp.json`（soft）|
 * | Commands      | `.pi\prompts\<name>.md`      | `<pi agent dir>\prompts\`      |
 *
 * user 级的 `<pi agent dir>` = `PI_CODING_AGENT_DIR` 覆盖，否则 `%USERPROFILE%\.pi\agent`
 * （Spec §2.2，同 codex 的 `CODEX_HOME`）。
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
 *   恒产出（含空 servers），payload 为 `{"mcpServers":{...}}`；条目形状由
 *   mcp-transport 归一化层给出——顶层键与 Claude Code 同名，但**条目形状不同构**
 *   （适配器没有 `type` 字段，按 command / url / socket 互斥判定 transport）；
 * - skills：write 实体 copy（Spec §7.6 默认不使用 symlink）；
 * - plan 为纯函数：不做任何 IO，路径按注入 os 选择分隔符（Spec §2.1）。
 */
import type { McpServer } from '../../../schema';
import { type OsContext, PI_AGENT_DIR_ENV, pathApiFor, resolveOverridableDir } from '../../paths';
import { renderCommandShell } from '../commands';
import {
  type CommandArtifact,
  mainRuleAction,
  type ProjectContext,
  type ProjectionPlan,
  type ProjectionPlanItem,
  type Projector,
  shouldWriteAgentsMd,
} from '../types';
import { piMcpServersObject } from './mcp-transport';
import { flatCommandFilePath, SKILLS_DIRNAME, skillDocPath } from './shared';

/** Spec §2.3 / §8.6 主规则文件名（project / user 两个 scope 同名）。 */
export const PI_MAIN_RULE_FILENAME = 'AGENTS.md';

/** pi 的项目级配置目录（`.pi\`，Spec §2.3）。 */
export const PI_DIRNAME = '.pi';

/** pi 的用户级全局目录段（`<home>\.pi\agent`，Spec §2.2 缺省值）。 */
export const PI_USER_DIR_SEGMENTS = ['.pi', 'agent'] as const;

/** Spec §2.3 / §8.6 MCP 配置文件（pi 私有覆盖位，由 pi-mcp-adapter 读取）。 */
export const PI_MCP_FILENAME = 'mcp.json';

/**
 * Spec §8.6 Commands 目录名（§8.8）：pi 用 `prompts` 而非 `commands`。
 * 上游启动时会把遗留的 `commands\` 自动 rename 成 `prompts\`（§8.6 实测）。
 */
export const PI_PROMPTS_DIRNAME = 'prompts';

/**
 * user scope 的 pi agent 目录：`PI_CODING_AGENT_DIR` 覆盖，否则 `<home>\.pi\agent`
 * （Spec §2.2，与 paths.resolveTargetUserDirs().pi 同构）。
 *
 * 与 codexUserDir 的 `CODEX_HOME` 分支同构：该变量置位时上游 pi 与 pi-mcp-adapter
 * 都改从它指向的目录读 agent 配置，所以这一层的三个落点（AGENTS.md / skills /
 * mcp.json）必须整体跟着走——只跟一个会让同一目录下的产物半新半旧。
 *
 * 入参是 `(home, override)` 而非 ProjectContext：命令层（`aforge mcp remove` 的提示
 * 文案）也要算这个目录，但它手里只有基准根与 env，造一个假 ctx 不值得。
 *
 * 覆盖值过 core/paths 的统一守卫（`~` 展开 + UNC / 无盘符绝对路径拒绝）——与
 * CODEX_HOME 同一处判据，两个变量不该有两套宽严标准。
 */
export function piUserAgentDir(home: string, override: string | undefined, os: OsContext): string {
  const api = pathApiFor(os);
  return resolveOverridableDir(
    override,
    api.join(home, ...PI_USER_DIR_SEGMENTS),
    PI_AGENT_DIR_ENV,
    home,
    os,
  );
}

function piUserDir(ctx: ProjectContext): string {
  return piUserAgentDir(ctx.rootDir, ctx.env?.piCodingAgentDir, ctx.os);
}

/**
 * Pi MCP 管理键 JSON 载荷（merge_json 的 item.content）。
 *
 * 顶层 `mcpServers` 键（与 Claude Code 同名），条目形状由 mcp-transport 归一化层
 * 给出（无 `type` 键；远端两态都显式写 `httpTransport`：`sse` → `"sse"`、`http` →
 * `"streamable-http"`，理由见该层 JSDoc 与 issue #69）；enabled=false 的
 * server 不投影。空数组 → `{"mcpServers":{}}`（保留管理键声明，深合并时未知键保留）。
 */
export function piMcpPayload(servers: readonly McpServer[]): string {
  return JSON.stringify({ mcpServers: piMcpServersObject(servers) });
}

/** 主规则绝对路径（`status` / `init` 打印"实际将写入的路径"也用它，Spec §2.2）。 */
export function piMainRulePath(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  const base = ctx.scope === 'project' ? ctx.rootDir : piUserDir(ctx);
  return api.join(base, PI_MAIN_RULE_FILENAME);
}

/** skills 根目录（project / user 两个 scope 不同）。 */
export function piSkillsDir(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  // §2.3：project = `<root>\.pi\skills`
  // §8.6：user = `~\.pi\agent\skills`
  return ctx.scope === 'project'
    ? api.join(ctx.rootDir, PI_DIRNAME, SKILLS_DIRNAME)
    : api.join(piUserDir(ctx), SKILLS_DIRNAME);
}

/** 单个 skill 的目标 SKILL.md 路径（project / user 两个 scope 的 skills 根不同）。 */
export function piSkillPath(ctx: ProjectContext, skillName: string): string {
  return skillDocPath(pathApiFor(ctx.os), piSkillsDir(ctx), skillName);
}

/**
 * MCP 配置绝对路径（project 级 `<root>\.pi\mcp.json`；user 级 `<pi agent dir>\mcp.json`）。
 *
 * user 级目录由 piUserDir 解析（`PI_CODING_AGENT_DIR` 覆盖，否则 `.pi\agent`）。
 */
export function piMcpPath(ctx: ProjectContext): string {
  const api = pathApiFor(ctx.os);
  const base = ctx.scope === 'project' ? api.join(ctx.rootDir, PI_DIRNAME) : piUserDir(ctx);
  return api.join(base, PI_MCP_FILENAME);
}

/**
 * 单个命令薄壳的目标路径（§8.8 / §8.6 Commands 行）。
 *
 * 目录名是 `prompts` 而非 `commands`：pi 启动时会把遗留的 `commands\` 自动 rename
 * 成 `prompts\`（`dist/migrations.js` 的 migrateCommandsToPrompts），写 `commands\`
 * 等于把产物交给上游迁移逻辑搬家，记账路径随即失真。
 * project = `<root>\.pi\prompts\<name>.md`；user = `<pi agent dir>\prompts\<name>.md`。
 * pi 只扫一层 prompts\，故命名空间拼进文件名（§8.8.2 降级）而不建子目录。
 */
export function piCommandPath(ctx: ProjectContext, command: CommandArtifact): string {
  const api = pathApiFor(ctx.os);
  const base = ctx.scope === 'project' ? api.join(ctx.rootDir, PI_DIRNAME) : piUserDir(ctx);
  return flatCommandFilePath(api, api.join(base, PI_PROMPTS_DIRNAME), command);
}

/** Pi projector 实例（纯函数 plan；apply 由引擎统一执行）。 */
export const piProjector: Projector = {
  id: 'pi',

  /** §8.8 实测：交互模式把 skillCommandList 并入补全候选，按 `/<name>` 调用。 */
  skillInvokePrefix: '/',

  skillDir: piSkillsDir,
  skillPath: piSkillPath,

  /**
   * `false`——pi 的会话生命周期事件（`session_start` / `session_shutdown`，实测见
   * 上游 `docs/extensions.md`）只对 **extension** 开放，extension 是放在
   * `.pi\extensions\*.ts` / `~\.pi\agent\extensions\` 里的 TypeScript 模块
   * （上游文档自己标注 "Extensions run with your full system permissions"）。
   * 同 opencode 的理由：那是投放可执行代码而非写配置数据，超出投影层的边界。
   * hook 档对 pi 等同 off，由 sync notice 与 doctor warn 说明。
   */
  writesSessionHooks: false,

  /** pi-mcp-adapter 的 `mcp.json`（无 `type` 键、`httpTransport` 显式声明）。 */
  writesMcp: true,

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

    // Commands 薄壳（§8.8）：expose_as_command 点名时才产出；整文件 write，
    // 走 §7.6 artifacts 记账 + prune（不用 marker）。
    // 不标 soft：命令文件是普通 Markdown，pi 原生扫描 prompts\ 即可，
    // 不依赖 pi-mcp-adapter 那类扩展，因此没有 MCP 项那种「装了才生效」的前提
    for (const command of ctx.commandsToExpose) {
      items.push({
        path: piCommandPath(ctx, command),
        action: 'write',
        content: renderCommandShell(command),
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
