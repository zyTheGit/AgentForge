/**
 * pi projector 单测（Spec §8.6 / §2.3 / §2.2，MVP soft）：plan 纯函数（路径 /
 * 动作 / soft 标记）、MCP payload 序列化（mcpServers 键）、skills write 项。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../../../../src/core/markers';
import {
  piMainRulePath,
  piMcpPath,
  piMcpPayload,
  piProjector,
  piSkillPath,
} from '../../../../src/core/project/projectors/pi';
import type { ProjectContext } from '../../../../src/core/project/types';
import {
  HabitsSchema,
  type McpServer,
  McpServerSchema,
  ProfileSchema,
} from '../../../../src/schema';

function buildCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    os: { platform: 'win32' },
    scope: 'project',
    rootDir: 'C:\\proj',
    renderedRulesMd: '# AgentForge Rules\n- use fnm\n',
    habits: HabitsSchema.parse({ version: 1 }),
    profile: ProfileSchema.parse({ version: 1, targets: ['pi'] }),
    skillsToMaterialize: [],
    commandsToExpose: [],
    mcpServers: [],
    dryRun: false,
    lineEnding: 'lf',
    markerBegin: DEFAULT_MARKER_BEGIN,
    markerEnd: DEFAULT_MARKER_END,
    ...overrides,
  };
}

function stdioServer(overrides: Partial<McpServer> = {}): McpServer {
  return McpServerSchema.parse({
    name: 'fs',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'server-fs'],
    ...overrides,
  });
}

describe('piProjector.plan（Spec §8.6 主规则 / MCP soft / skills）', () => {
  it('project scope：主规则 = <root>\\AGENTS.md（merge_marker）；MCP = .pi\\mcp.json（merge_json + soft）', () => {
    const ctx = buildCtx();
    const plan = piProjector.plan(ctx);
    expect(plan.targetId).toBe('pi');
    expect(plan.items).toEqual([
      {
        path: 'C:\\proj\\AGENTS.md',
        action: 'merge_marker',
        content: ctx.renderedRulesMd,
      },
      {
        path: 'C:\\proj\\.pi\\mcp.json',
        action: 'merge_json',
        content: '{"mcpServers":{}}',
        soft: true, // §8.6 MVP：apply 失败仅 warning，不触发回滚
      },
    ]);
    expect(plan.tomlMarkers).toBeUndefined(); // pi 无 merge_toml 动作
  });

  it('user scope：主规则与 mcp.json 均落 <home>\\.pi\\agent\\（Spec §2.2）', () => {
    const ctx = buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' });
    const plan = piProjector.plan(ctx);
    expect(plan.items[0]?.path).toBe('C:\\Users\\u\\.pi\\agent\\AGENTS.md');
    expect(plan.items[1]?.path).toBe('C:\\Users\\u\\.pi\\agent\\mcp.json');
  });

  it('user scope + PI_CODING_AGENT_DIR：三个落点整体改到覆盖目录（Spec §2.2 env 覆盖）', () => {
    const ctx = buildCtx({
      scope: 'user',
      rootDir: 'C:\\Users\\u',
      skillsToMaterialize: [{ name: 's1', content: 'x' }],
      env: {
        agfHome: undefined,
        agfScope: undefined,
        offline: false,
        lineEnding: undefined,
        ci: false,
        codexHome: undefined,
        piCodingAgentDir: 'D:\\pi-agent',
        userProfile: 'C:\\Users\\u',
      },
    });
    const plan = piProjector.plan(ctx);
    expect(plan.items[0]?.path).toBe('D:\\pi-agent\\AGENTS.md');
    expect(plan.items[1]?.path).toBe('D:\\pi-agent\\skills\\s1\\SKILL.md');
    expect(plan.items.at(-1)?.path).toBe('D:\\pi-agent\\mcp.json');
  });

  it('project scope 不受 PI_CODING_AGENT_DIR 影响（覆盖只针对 user 级 agent 目录）', () => {
    const ctx = buildCtx({
      env: {
        agfHome: undefined,
        agfScope: undefined,
        offline: false,
        lineEnding: undefined,
        ci: false,
        codexHome: undefined,
        piCodingAgentDir: 'D:\\pi-agent',
        userProfile: 'C:\\Users\\u',
      },
    });
    const plan = piProjector.plan(ctx);
    expect(plan.items[0]?.path).toBe('C:\\proj\\AGENTS.md');
    expect(plan.items.at(-1)?.path).toBe('C:\\proj\\.pi\\mcp.json');
  });

  it('posix os：分隔符为 /（Spec §2.1 路径随平台）', () => {
    const ctx = buildCtx({ os: { platform: 'linux' }, rootDir: '/home/u/proj' });
    const plan = piProjector.plan(ctx);
    expect(plan.items[0]?.path).toBe('/home/u/proj/AGENTS.md');
    expect(plan.items[1]?.path).toBe('/home/u/proj/.pi/mcp.json');
  });

  it('skills：write 实体 copy 项落在 .pi\\skills\\<name>\\SKILL.md（project）', () => {
    const ctx = buildCtx({
      skillsToMaterialize: [
        { name: 'my-skill', content: '# My Skill\n' },
        { name: 'other', content: '# Other\n' },
      ],
    });
    const plan = piProjector.plan(ctx);
    expect(plan.items[1]).toEqual({
      path: 'C:\\proj\\.pi\\skills\\my-skill\\SKILL.md',
      action: 'write',
      content: '# My Skill\n',
    });
    expect(plan.items[2]?.path).toBe('C:\\proj\\.pi\\skills\\other\\SKILL.md');
    // MCP 仍是末项（soft）
    expect(plan.items.at(-1)).toEqual({
      path: 'C:\\proj\\.pi\\mcp.json',
      action: 'merge_json',
      content: '{"mcpServers":{}}',
      soft: true,
    });
  });

  it('skills（user scope）：落 <home>\\.pi\\agent\\skills\\<name>\\SKILL.md', () => {
    const ctx = buildCtx({
      scope: 'user',
      rootDir: 'C:\\Users\\u',
      skillsToMaterialize: [{ name: 's1', content: 'x' }],
    });
    const plan = piProjector.plan(ctx);
    expect(plan.items[1]?.path).toBe('C:\\Users\\u\\.pi\\agent\\skills\\s1\\SKILL.md');
  });

  it('plan 为纯函数：同一 ctx 多次调用结果一致，不改写 ctx', () => {
    const ctx = buildCtx();
    const first = piProjector.plan(ctx);
    expect(piProjector.plan(ctx)).toEqual(first);
    expect(ctx.renderedRulesMd).toBe('# AgentForge Rules\n- use fnm\n');
  });
});

describe('piMcpPayload（mcpServers 管理键，pi-mcp-adapter 与 Claude Code 同构）', () => {
  it('空 servers → {"mcpServers":{}}（管理键声明保留）', () => {
    expect(piMcpPayload([])).toBe('{"mcpServers":{}}');
  });

  it('stdio → command / args / env 键', () => {
    const server = stdioServer({ env: { KEY: 'v' } });
    const payload = JSON.parse(piMcpPayload([server])) as {
      mcpServers: Record<string, unknown>;
    };
    expect(payload.mcpServers.fs).toEqual({
      command: 'npx',
      args: ['-y', 'server-fs'],
      env: { KEY: 'v' },
    });
  });

  it('stdio 无 args/env → 仅 command 键（载荷最小化）', () => {
    const payload = JSON.parse(piMcpPayload([stdioServer({ args: undefined })])) as {
      mcpServers: Record<string, unknown>;
    };
    expect(payload.mcpServers.fs).toEqual({ command: 'npx' });
  });

  it('http → type / url / headers 键', () => {
    const server = McpServerSchema.parse({
      name: 'docs',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
    const payload = JSON.parse(piMcpPayload([server])) as {
      mcpServers: Record<string, unknown>;
    };
    expect(payload.mcpServers.docs).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
  });

  it('enabled=false 的 server 不投影', () => {
    const payload = JSON.parse(piMcpPayload([stdioServer({ enabled: false }), stdioServer()])) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(payload.mcpServers)).toEqual(['fs']);
  });
});

describe('pi 路径函数（status/init 打印共用）', () => {
  it('piMainRulePath / piMcpPath 与 plan 产出的路径一致', () => {
    const ctx = buildCtx({ os: { platform: 'linux' }, rootDir: '/proj' });
    const plan = piProjector.plan(ctx);
    expect(piMainRulePath(ctx)).toBe(plan.items[0]?.path);
    expect(piMcpPath(ctx)).toBe(plan.items.at(-1)?.path);
  });

  it('piMainRulePath：project / user 两态', () => {
    expect(piMainRulePath(buildCtx())).toBe('C:\\proj\\AGENTS.md');
    expect(piMainRulePath(buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' }))).toBe(
      'C:\\Users\\u\\.pi\\agent\\AGENTS.md',
    );
  });

  it('piSkillPath：project / user 两态', () => {
    expect(piSkillPath(buildCtx(), 's')).toBe('C:\\proj\\.pi\\skills\\s\\SKILL.md');
    expect(piSkillPath(buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' }), 's')).toBe(
      'C:\\Users\\u\\.pi\\agent\\skills\\s\\SKILL.md',
    );
  });
});
