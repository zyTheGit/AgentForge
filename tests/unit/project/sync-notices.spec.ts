/**
 * sync 提示类产出的判定单测（§7.4 hook 档降级 / §8.8.4 命令薄壳跳过 /
 * Phase 2 MCP transport 落差 / issue #52 MCP 落点不可写 /
 * Phase 2 `skills.on_demand` 物化跳过）。
 *
 * 覆盖这些纯函数：
 * - `hookCapableTargetIds`：能力从 projector 读（不是外部映射表）；
 * - `partitionSessionHookTargets`：本轮 target 按"有没有钩子落点"切两半；
 * - `collectMcpScopeNotices`：user scope 的 claude MCP 整项跳过的三条判据；
 * - `collectSessionHookNotices` / `collectSyncAdvisories`：切分结果 → 提示条目，
 *   以及五类提示（命令跳过 / MCP 落差 / MCP 落点 / 钩子降级 / on_demand 跳过）走同一条
 *   通道后互不干扰。`skillSkips` 是唯一**不在本模块判定**的一类（判定在 sync-prepare），
 *   这里只断言它被原样透传、不被改写也不被丢弃。
 *
 * 全部不碰 IO、不注册任何钩子：这里只断言"该报哪几条"，产物形态见
 * projectors/codex.spec.ts，MCP 能力矩阵本身见 projectors/mcp-transport.spec.ts，
 * `skillSkips` 的判定见 sources/skill-on-demand.spec.ts，
 * 端到端见 tests/integration/learning-hook-capture.spec.ts。
 */
import { describe, expect, it } from 'vitest';
import { CODEX_PROJECT_COMMANDS_SKIP_REASON } from '../../../src/core/project/commands';
import { CLAUDE_USER_MCP_SKIP_REASON } from '../../../src/core/project/projectors/claude';
import { projectorRegistry } from '../../../src/core/project/projectors/registry';
import {
  CLAUDE_USER_MCP_NOTICE_ITEM,
  collectMcpScopeNotices,
  collectSessionHookNotices,
  collectSyncAdvisories,
  hookCapableTargetIds,
  partitionSessionHookTargets,
  SESSION_HOOK_NOTICE_ITEM,
  type SyncAdvisoryInput,
  sessionHookUnsupportedMessage,
} from '../../../src/core/project/sync-notices';
import type { SyncSkillSkip } from '../../../src/core/project/sync-types';
import type { ProjectionPlan, Projector } from '../../../src/core/project/types';
import {
  type AutoCapture,
  type McpServer,
  McpServerSchema,
  ProfileSchema,
} from '../../../src/schema';

/** 只用于查能力的 projector 桩（plan 不会被这些纯函数调用，故返回空计划）。 */
function fakeProjector(id: string, writesSessionHooks: boolean): Projector {
  return {
    id,
    skillInvokePrefix: '/',
    writesSessionHooks,
    skillDir: (ctx) => `${ctx.rootDir}\\.${id}\\skills`,
    skillPath: (ctx, name) => `${ctx.rootDir}\\.${id}\\skills\\${name}\\SKILL.md`,
    plan(): ProjectionPlan {
      return { targetId: id, items: [] };
    },
  };
}

/** 两支持两不支持的 projector 全集（顺序刻意打乱，用于验证输出是稳定排序的）。 */
const PROJECTORS: readonly Projector[] = [
  fakeProjector('zeta', false),
  fakeProjector('codex', true),
  fakeProjector('alpha', true),
  fakeProjector('claude', false),
];

function profileWith(autoCapture: AutoCapture, targets: readonly string[] = ['codex']) {
  return ProfileSchema.parse({
    version: 1,
    targets,
    learning: { auto_capture: autoCapture },
  });
}

describe('hookCapableTargetIds（能力声明来自 projector）', () => {
  it('只保留 writesSessionHooks=true 的 id，且升序稳定', () => {
    expect(hookCapableTargetIds(PROJECTORS)).toEqual(['alpha', 'codex']);
  });

  it('真实注册表：四家里只有 codex 支持声明式会话钩子（§7.4 支持矩阵）', () => {
    expect(hookCapableTargetIds(projectorRegistry.list())).toEqual(['codex']);
  });
});

describe('partitionSessionHookTargets（本轮 target 的支持度切分）', () => {
  it('hook 档：按能力切两半，各自保持传入名单的顺序', () => {
    expect(partitionSessionHookTargets(true, ['claude', 'codex', 'zeta'], PROJECTORS)).toEqual({
      capable: ['codex'],
      incapable: ['claude', 'zeta'],
    });
  });

  it('非 hook 档：两侧都空（这一档不写钩子，报支持度只是噪音）', () => {
    expect(partitionSessionHookTargets(false, ['claude', 'codex'], PROJECTORS)).toEqual({
      capable: [],
      incapable: [],
    });
  });

  it('只覆盖本轮参与的 target（--targets 过滤后的名单之外一律不出现）', () => {
    const split = partitionSessionHookTargets(true, ['codex'], PROJECTORS);
    expect(split.capable).toEqual(['codex']);
    // claude / zeta 这轮没参与投影，不该替它们报降级
    expect(split.incapable).toEqual([]);
  });

  it('全都不支持：capable 为空，incapable 为全部（status 据此说"等同 off"）', () => {
    expect(partitionSessionHookTargets(true, ['claude', 'zeta'], PROJECTORS)).toEqual({
      capable: [],
      incapable: ['claude', 'zeta'],
    });
  });
});

describe('collectSessionHookNotices（降级提示条目）', () => {
  it('每个不支持的 target 一条，item 固定、message 与 doctor 共用同一句', () => {
    expect(collectSessionHookNotices(true, ['codex', 'claude'], PROJECTORS)).toEqual([
      {
        targetId: 'claude',
        item: SESSION_HOOK_NOTICE_ITEM,
        message: sessionHookUnsupportedMessage('claude'),
      },
    ]);
  });

  it('提示 item 名与 doctor 的同名条目一致（两处输出能对上）', () => {
    expect(SESSION_HOOK_NOTICE_ITEM).toBe('learning-auto-capture-hook');
  });

  it('文案点名 target 并说明"等同 off"，不含任何本机路径', () => {
    const message = sessionHookUnsupportedMessage('pi');
    expect(message).toContain('pi');
    expect(message).toContain('learning.auto_capture: hook');
    expect(message).toContain('等同 off');
    // 不含本机路径：无盘符前缀、无路径分隔符（提示文案跨机器一致，可直接比对）
    expect(message).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(message).not.toContain('\\');
  });

  it('非 hook 档 → 空数组', () => {
    expect(collectSessionHookNotices(false, ['claude', 'zeta'], PROJECTORS)).toEqual([]);
  });

  it('全部支持 → 空数组（不产生"一切正常"的噪音行）', () => {
    expect(collectSessionHookNotices(true, ['codex', 'alpha'], PROJECTORS)).toEqual([]);
  });
});

describe('collectSyncAdvisories（五类提示汇总，dry-run 与实际写入同一份结论）', () => {
  /** 只有 codex 表达不了的 transport（矩阵判 unsupported；opencode 判 degraded）。 */
  const SSE_SERVER: McpServer = McpServerSchema.parse({
    name: 'remote-sse',
    transport: 'sse',
    url: 'https://example.test/sse',
  });

  /** on_demand 侧的跳过项样本（判定发生在 sync-prepare，这里只作为入参透传）。 */
  const SKILL_SKIP: SyncSkillSkip = {
    name: 'ghost',
    reason: 'not-installed',
    detail: 'skills/ghost/SKILL.md 不存在',
  };

  /** 入参构造：默认「无命令 / 无 MCP server / off 档 / 无技能跳过」。 */
  function input(overrides: Partial<SyncAdvisoryInput> = {}): SyncAdvisoryInput {
    return {
      profile: profileWith('off', ['codex']),
      scope: 'project',
      hasCommandsToExpose: false,
      targetIds: ['codex'],
      projectors: PROJECTORS,
      mcpServers: [],
      skillSkips: [],
      ...overrides,
    };
  }

  it('hook 档 + 混合 target：只为不支持的 target 产出提示', () => {
    const advisories = collectSyncAdvisories(
      input({
        profile: profileWith('hook', ['codex', 'claude']),
        targetIds: ['codex', 'claude'],
      }),
    );
    expect(advisories.commandSkips).toEqual([]);
    expect(advisories.sessionHookNotices.map((n) => n.targetId)).toEqual(['claude']);
  });

  it.each(['off', 'prompt'] as const)('%s 档：不产出任何钩子提示', (autoCapture) => {
    const advisories = collectSyncAdvisories(
      input({
        profile: profileWith(autoCapture, ['codex', 'claude']),
        targetIds: ['codex', 'claude'],
      }),
    );
    expect(advisories.sessionHookNotices).toEqual([]);
  });

  it('§8.8.4：project scope + codex + 有命令 → 命令薄壳整项跳过', () => {
    const advisories = collectSyncAdvisories(input({ hasCommandsToExpose: true }));
    expect(advisories.commandSkips).toEqual([
      { targetId: 'codex', reason: CODEX_PROJECT_COMMANDS_SKIP_REASON },
    ]);
  });

  it('user scope 的 codex 命令不跳过；没有命令时也不跳过', () => {
    expect(
      collectSyncAdvisories(input({ scope: 'user', hasCommandsToExpose: true })).commandSkips,
    ).toEqual([]);
    expect(collectSyncAdvisories(input({ hasCommandsToExpose: false })).commandSkips).toEqual([]);
  });

  it('codex 未参与本轮（--targets 过滤掉）→ 不报它的命令跳过', () => {
    expect(
      collectSyncAdvisories(
        input({
          profile: profileWith('off', ['codex', 'claude']),
          hasCommandsToExpose: true,
          targetIds: ['claude'],
        }),
      ).commandSkips,
    ).toEqual([]);
  });

  it('MCP transport 落差与另两类走同一条通道：codex 跳过 / opencode 降级，claude 无落差', () => {
    const advisories = collectSyncAdvisories(
      input({
        profile: profileWith('off', ['codex', 'opencode', 'claude']),
        targetIds: ['codex', 'opencode', 'claude'],
        mcpServers: [SSE_SERVER],
      }),
    );
    expect(
      advisories.mcpTransportNotices.map((n) => `${n.targetId}:${n.serverName}:${n.support}`),
    ).toEqual(['codex:remote-sse:unsupported', 'opencode:remote-sse:degraded']);
    // 结构化载荷必须保留（命令层按 support 选标签、把 hint 单独打一行；压成字符串就没了）
    for (const notice of advisories.mcpTransportNotices) {
      expect(notice.transport).toBe('sse');
      expect(notice.detail).toContain('remote-sse');
      expect(notice.hint).not.toBe('');
    }
  });

  it('没有 MCP server → 不产出落差提示（不制造"一切正常"的噪音行）', () => {
    expect(collectSyncAdvisories(input()).mcpTransportNotices).toEqual([]);
  });

  it('声明式 id + enabled server：不崩溃，落差判定跳过它、unmeasured 恰一条', () => {
    const advisories = collectSyncAdvisories(
      input({
        profile: profileWith('off', ['codex', 'claude']),
        targetIds: ['codex', 'claude', 'my-agent'],
        mcpServers: [SSE_SERVER],
      }),
    );
    // 内置 id 的落差判定不受影响（此前整个调用会 TypeError 崩掉）
    expect(advisories.mcpTransportNotices.map((n) => n.targetId)).toEqual(['codex']);
    // 每 target 一条占位，不是每 server 一条
    expect(advisories.mcpTransportUnmeasuredTargets).toEqual(['my-agent']);
  });

  it('没有 MCP server → 声明式 id 也不出 unmeasured（没内容就没得说）', () => {
    expect(
      collectSyncAdvisories(input({ targetIds: ['codex', 'my-agent'] }))
        .mcpTransportUnmeasuredTargets,
    ).toEqual([]);
  });

  it('未参与本轮的 target 不报 MCP 落差（--targets 只留 claude）', () => {
    expect(
      collectSyncAdvisories(
        input({
          profile: profileWith('off', ['codex', 'claude']),
          targetIds: ['claude'],
          mcpServers: [SSE_SERVER],
        }),
      ).mcpTransportNotices,
    ).toEqual([]);
  });

  it('skillSkips 原样透传：本模块不重算、不改写、不丢弃（判定在 sync-prepare）', () => {
    const advisories = collectSyncAdvisories(input({ skillSkips: [SKILL_SKIP] }));
    expect(advisories.skillSkips).toEqual([SKILL_SKIP]);
    // 与 target 无关的一类：不因本轮投影哪几家而增删
    expect(
      collectSyncAdvisories(
        input({
          profile: profileWith('off', ['codex', 'claude']),
          targetIds: ['claude'],
          skillSkips: [SKILL_SKIP],
        }),
      ).skillSkips,
    ).toEqual([SKILL_SKIP]);
  });

  it('没有 on_demand 跳过 → 空数组（不制造"一切正常"的噪音行）', () => {
    expect(collectSyncAdvisories(input()).skillSkips).toEqual([]);
  });

  it('四类提示可同时出现，互不干扰', () => {
    const advisories = collectSyncAdvisories(
      input({
        profile: profileWith('hook', ['codex', 'claude']),
        hasCommandsToExpose: true,
        targetIds: ['codex', 'claude'],
        mcpServers: [SSE_SERVER],
        skillSkips: [SKILL_SKIP],
      }),
    );
    expect(advisories.commandSkips.map((s) => s.targetId)).toEqual(['codex']);
    expect(advisories.mcpTransportNotices.map((n) => n.targetId)).toEqual(['codex']);
    expect(advisories.sessionHookNotices.map((n) => n.targetId)).toEqual(['claude']);
    expect(advisories.skillSkips.map((s) => s.name)).toEqual(['ghost']);
  });

  it('四类都与写入成败无关：同一份入参重复调用结果稳定（dry-run 与实写同源）', () => {
    const shared = input({
      profile: profileWith('hook', ['codex', 'claude']),
      hasCommandsToExpose: true,
      targetIds: ['codex', 'claude'],
      mcpServers: [SSE_SERVER],
      skillSkips: [SKILL_SKIP],
    });
    expect(collectSyncAdvisories(shared)).toEqual(collectSyncAdvisories(shared));
  });

  it('user scope + claude：MCP 落点提示与另四类并存，互不干扰（issue #52）', () => {
    const advisories = collectSyncAdvisories(
      input({
        profile: profileWith('hook', ['codex', 'claude']),
        scope: 'user',
        hasCommandsToExpose: true,
        targetIds: ['codex', 'claude'],
        mcpServers: [SSE_SERVER],
        skillSkips: [SKILL_SKIP],
      }),
    );
    expect(advisories.mcpScopeNotices.map((n) => n.targetId)).toEqual(['claude']);
    // 另四类不受影响（user scope 的 codex 命令不跳过，故 commandSkips 为空）
    expect(advisories.commandSkips).toEqual([]);
    expect(advisories.mcpTransportNotices.map((n) => n.targetId)).toEqual(['codex']);
    expect(advisories.sessionHookNotices.map((n) => n.targetId)).toEqual(['claude']);
    expect(advisories.skillSkips.map((s) => s.name)).toEqual(['ghost']);
  });

  it('project scope 不产出 MCP 落点提示（.mcp.json 与上游一致，照常投影）', () => {
    expect(
      collectSyncAdvisories(
        input({
          profile: profileWith('off', ['claude']),
          targetIds: ['claude'],
          mcpServers: [SSE_SERVER],
        }),
      ).mcpScopeNotices,
    ).toEqual([]);
  });
});

describe('collectMcpScopeNotices（issue #52：claude 的 user 级 MCP 整项不投影）', () => {
  const STDIO_SERVER: McpServer = McpServerSchema.parse({
    name: 'fs',
    transport: 'stdio',
    command: 'npx',
  });
  const DISABLED_SERVER: McpServer = McpServerSchema.parse({
    name: 'off-one',
    transport: 'stdio',
    command: 'npx',
    enabled: false,
  });

  function input(overrides: Partial<SyncAdvisoryInput> = {}): SyncAdvisoryInput {
    return {
      profile: profileWith('off', ['claude']),
      scope: 'user',
      hasCommandsToExpose: false,
      targetIds: ['claude'],
      projectors: PROJECTORS,
      mcpServers: [STDIO_SERVER],
      skillSkips: [],
      ...overrides,
    };
  }

  it('三条判据齐备 → 一条提示，item 与 doctor 同名、文案取自 projector 的单一事实源', () => {
    expect(collectMcpScopeNotices(input())).toEqual([
      {
        targetId: 'claude',
        item: CLAUDE_USER_MCP_NOTICE_ITEM,
        message: CLAUDE_USER_MCP_SKIP_REASON,
      },
    ]);
    expect(CLAUDE_USER_MCP_NOTICE_ITEM).toBe('mcp-scope/claude-user');
  });

  it('文案给出上游落点、拒写理由与可复制的手工命令', () => {
    expect(CLAUDE_USER_MCP_SKIP_REASON).toContain('.claude.json');
    expect(CLAUDE_USER_MCP_SKIP_REASON).toContain('claude mcp add --scope user');
  });

  it('project scope → 不报（该 scope 的 .mcp.json 照常投影）', () => {
    expect(collectMcpScopeNotices(input({ scope: 'project' }))).toEqual([]);
  });

  it('claude 未参与本轮（--targets 过滤掉）→ 不报', () => {
    expect(collectMcpScopeNotices(input({ targetIds: ['codex'] }))).toEqual([]);
  });

  it('一条 server 都没声明 → 不报（"这项没投影"是废话）', () => {
    expect(collectMcpScopeNotices(input({ mcpServers: [] }))).toEqual([]);
  });

  it('只有 enabled=false 的 server → 不报（口径与 merge_json 载荷同源）', () => {
    expect(collectMcpScopeNotices(input({ mcpServers: [DISABLED_SERVER] }))).toEqual([]);
  });
});
