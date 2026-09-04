/**
 * 声明式适配器 → `Projector`（issue #53）：把 yaml 里的落点声明翻译成 ProjectionPlan。
 *
 * 这里是「第一层接口收口是够的」那句结论的验证点：一个 target 只要能产出
 * `ProjectionPlanItem[]` + `skillDir` / `skillPath`，prune / artifacts 记账、
 * doctor marker 比对、事务回滚、`--targets` 过滤全都自动可用，声明式 target
 * 一行都不用为它们操心。
 *
 * 与内置 projector 共用的判据（**刻意复用而不是抄一遍**）：
 * - 主规则动作：`types.mainRuleAction`（`marker_mode: none` → 整文件 write）；
 * - 主规则开关：`shouldWriteAgentsMd` / `shouldWriteClaudeMd` /
 *   `shouldWriteOptionalClaudeMd`（§8.7 投影矩阵的三种语义）；
 * - 技能落点末两段：`projectors/shared.skillDocPath`；
 * - 命令薄壳路径与命名空间降级：`commandFilePath` / `flatCommandFilePath`；
 * - 命令薄壳正文：`project/commands.renderCommandShell`（`$1..$9` / `$ARGUMENTS`
 *   归一化已在 SoT 侧做完，声明式 target 免费继承）；
 * - MCP payload：`projectors/mcp-transport` 的两个内置 dialect。**能力落差判定不继承**
 *   ——声明式 id 不在 `MCP_TRANSPORT_MATRIX` 里（矩阵只装四个内置 target 的实测结论），
 *   由 `collectUnmeasuredMcpTransportTargets` 出 unmeasured 占位，不猜默认值。
 *
 * 每一项产出都过两道校验：动作在 `ADAPTER_ALLOWED_ACTIONS` 内（`merge_toml` 永不
 * 出现），路径过 containment（plan 是热路径也照跑——纯字符串运算，代价可忽略，
 * 而漏跑一次就等于这层护栏在 sync 的真实调用路径上不存在）。
 */

import type { McpServer } from '../../schema';
import { ADAPTER_ALLOWED_ACTIONS, type AdapterMcpDialect } from '../../schema/adapter';
import { ConfigError } from '../errors';
import { pathApiFor } from '../paths';
import { renderCommandShell } from '../project/commands';
import { claudeMcpServersObject, opencodeMcpObject } from '../project/projectors/mcp-transport';
import { commandFilePath, flatCommandFilePath, skillDocPath } from '../project/projectors/shared';
import {
  mainRuleAction,
  type ProjectContext,
  type ProjectionAction,
  type ProjectionPlan,
  type ProjectionPlanItem,
  type Projector,
  shouldWriteAgentsMd,
  shouldWriteClaudeMd,
  shouldWriteOptionalClaudeMd,
} from '../project/types';
import { assertWithinAllowedRoots } from './containment';
import { ADAPTER_MAX_PLAN_ITEMS } from './limits';
import { type AdapterRuntime, type ResolvedAdapterScope, resolveAdapterScope } from './resolve';

/**
 * MCP payload 装配（内置 dialect 枚举；不接受自由映射，见 schema/adapter 的理由）。
 *
 * - `mcpServers`：`{"mcpServers": {...}}`，条目带 `type`（Claude Code `.mcp.json` 形状）；
 * - `opencode`：`{"mcp": {...}}`，条目 `type: local|remote`（OpenCode 形状）。
 */
export function adapterMcpPayload(
  dialect: AdapterMcpDialect,
  servers: readonly McpServer[],
): string {
  return dialect === 'opencode'
    ? JSON.stringify({ mcp: opencodeMcpObject(servers) })
    : JSON.stringify({ mcpServers: claudeMcpServersObject(servers) });
}

/** 主规则开关：把声明的 toggle 映射到 §8.7 的三种既有语义。 */
function mainRuleEnabled(runtime: AdapterRuntime, ctx: ProjectContext): boolean {
  switch (runtime.doc.main_rule.toggle) {
    case 'agents_md':
      return shouldWriteAgentsMd(ctx);
    case 'claude_md':
      return shouldWriteClaudeMd(ctx);
    case 'claude_md_optional':
      return shouldWriteOptionalClaudeMd(ctx);
    default:
      return true;
  }
}

/** 断言动作在允许集合内（`merge_toml` 没有可声明的序列化器，永不放行）。 */
function assertAllowedAction(action: ProjectionAction, what: string): ProjectionAction {
  if (!(ADAPTER_ALLOWED_ACTIONS as readonly string[]).includes(action)) {
    throw new ConfigError(`${what}: 动作 ${action} 不在声明式适配器的允许集合内`, {
      hint: `允许的动作: ${ADAPTER_ALLOWED_ACTIONS.join(' / ')}——TOML 序列化无法声明式表达，需要它的 target 必须写成内置 projector`,
    });
  }
  return action;
}

/** 产出一个 scope 的全部 plan 项（顺序：主规则 → skills → commands → MCP）。 */
function planItems(
  runtime: AdapterRuntime,
  ctx: ProjectContext,
  resolved: ResolvedAdapterScope,
): ProjectionPlanItem[] {
  const api = pathApiFor(ctx.os);
  const id = runtime.doc.id;
  const items: ProjectionPlanItem[] = [];

  if (resolved.mainRule !== undefined && mainRuleEnabled(runtime, ctx)) {
    // `merge_marker` 声明 = 跟随 marker_mode（none 档自动降级为整文件 write）
    const action = runtime.doc.main_rule.action === 'write' ? 'write' : mainRuleAction(ctx);
    items.push({
      path: resolved.mainRule,
      action: assertAllowedAction(action, `${id}.main_rule`),
      content: ctx.renderedRulesMd,
    });
  }

  // skills_dir 缺省 → 本 scope 不投影技能（与 commands_dir / mcp_file 同口径）。
  // 「与 codex 并存时删掉 skills_dir、借道上游自己的 .agents/skills/」就靠这条成立
  if (resolved.skillsDir !== undefined) {
    for (const skill of ctx.skillsToMaterialize) {
      items.push({
        path: skillDocPath(api, resolved.skillsDir, skill.name),
        action: 'write',
        content: skill.content,
      });
    }
  }

  if (resolved.commandsDir !== undefined) {
    const flatten = runtime.doc.commands.namespace === 'flatten';
    for (const command of ctx.commandsToExpose) {
      items.push({
        path: flatten
          ? flatCommandFilePath(api, resolved.commandsDir, command)
          : commandFilePath(api, resolved.commandsDir, command),
        action: 'write',
        content: renderCommandShell(command),
      });
    }
  }

  const mcp = runtime.doc.mcp;
  if (resolved.mcpFile !== undefined && mcp !== undefined) {
    items.push({
      path: resolved.mcpFile,
      action: assertAllowedAction('merge_json', `${id}.mcp`),
      content: adapterMcpPayload(mcp.dialect, ctx.mcpServers),
      // §8.6 的既有 soft 语义（失败只 warning、不回滚）；声明式只能复用不能自定义
      ...(mcp.soft ? { soft: true } : {}),
    });
  }

  return items;
}

/**
 * 由一份已解析的适配器造出 `Projector`。
 *
 * plan 保持**纯函数**：环境变量取值与另一侧的根目录都在 `runtime` 里（加载时刻
 * 的快照），不在 plan 里读环境——否则同一份 SoT 在两次调用间会产出不同落点。
 */
export function buildDeclarativeProjector(runtime: AdapterRuntime): Projector {
  const id = runtime.doc.id;

  const resolveScope = (ctx: ProjectContext): ResolvedAdapterScope | undefined =>
    resolveAdapterScope(runtime, ctx.scope, ctx.rootDir, ctx.os, pathApiFor(ctx.os));

  /**
   * skills 根目录（契约位；命令层实际用的是 `skillPath`，保留给后续 doctor 的 skills
   * 根检查，见 `Projector.skillDir` 的接口注释）。
   *
   * 两种情况都抛 ConfigError 而不是编一个路径：该 scope 未声明、或声明了但没给
   * `skills_dir`（缺省 = 不投影技能，是**合法配置**）。编出来的路径 sync 永远不会写，
   * 打给用户等于假信息。调用方（命令层的路径清单）对失败的 target 跳过即可。
   */
  const skillDir = (ctx: ProjectContext): string => {
    const resolved = resolveScope(ctx);
    if (resolved?.skillsDir !== undefined) {
      return resolved.skillsDir;
    }
    // hint 必须分两句：缺省 skills_dir 是本适配器有意的选择（借道上游自己的技能目录），
    // 对这种用户还劝他「补上或去掉该 target」等于劝他改回一个本就合法的配置
    const [reason, hint] =
      resolved === undefined
        ? [
            `未声明 ${ctx.scope} scope 的落点`,
            `在 ${runtime.file} 的 scopes.${ctx.scope} 下声明 base 与 skills_dir，或把该 target 从 profile.targets 里去掉`,
          ]
        : [
            `未声明 ${ctx.scope} 的技能落点`,
            `该 scope 没声明 skills_dir，按设计不投影技能（合法配置，本行提示已跳过该 target）；确实想投就在 ${runtime.file} 的 scopes.${ctx.scope} 下补 skills_dir`,
          ];
    throw new ConfigError(`${id}: ${reason}`, { hint });
  };

  return {
    id,
    skillInvokePrefix: runtime.doc.skill_invoke_prefix,

    /**
     * 声明式 target 一律 `false`：装会话钩子要么改共享 JSON 数组、要么投放可执行
     * 代码，两者都超出「只写声明的落点」这条边界。sync-notices 与 doctor 会为
     * `learning.auto_capture: hook` 档如实降级说明，不静默失效。
     */
    writesSessionHooks: false,

    /**
     * 按 yaml **是否声明了任一 scope 的 `mcp_file`** 决定（schema 保证声明它就有
     * 顶层 `mcp.dialect`，见 adapter.ts 的 refine）。
     *
     * 只投 `main_rule` / `skills_dir` 的适配器压根没有 MCP 产物，报它的 transport
     * 能力落差（或"未实测"）等于给用户一条**指向不存在产物**、且他无法消除的提示。
     */
    writesMcp: (['project', 'user'] as const).some(
      (scope) => runtime.doc.scopes[scope]?.mcp_file !== undefined,
    ),

    skillDir,

    skillPath(ctx: ProjectContext, skillName: string): string {
      return skillDocPath(pathApiFor(ctx.os), skillDir(ctx), skillName);
    },

    plan(ctx: ProjectContext): ProjectionPlan {
      const resolved = resolveScope(ctx);
      if (resolved === undefined) {
        // 该 scope 未声明 → 本轮不产出任何东西（引擎按空 plan 处理，不算失败）
        return { targetId: id, items: [] };
      }
      const items = planItems(runtime, ctx, resolved);
      if (items.length > ADAPTER_MAX_PLAN_ITEMS) {
        throw new ConfigError(
          `${id}: 单次投影产物 ${items.length} 项超过上限 ${ADAPTER_MAX_PLAN_ITEMS}`,
          {
            hint: '减少 skills.always / skills.expose_as_command 的条目数；上限用来挡「一份声明把 sync 变成写盘炸弹」',
            details: { targetId: id, itemCount: items.length },
          },
        );
      }
      // 每一项都再过一次 containment：落点由「已校验的目录 + 技能名/命令名」拼成，
      // 而技能名来自 SoT 目录名——它不该越界，但这层护栏的成本只有几次字符串比较
      const api = pathApiFor(ctx.os);
      for (const item of items) {
        assertWithinAllowedRoots(item.path, resolved.allowed, ctx.os, api, `${id}.item`);
      }
      return { targetId: id, items };
    },
  };
}
