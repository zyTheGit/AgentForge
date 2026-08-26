/**
 * opencode projector 单测（Spec §8.3 / §2.3）：plan 纯函数（路径 / 动作 / 内容 /
 * 平台分隔符）、MCP payload 序列化、enabled 过滤、skills write 项。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../../../../src/core/markers';
import {
  opencodeClaudeRulePath,
  opencodeMainRulePath,
  opencodeMcpPath,
  opencodeMcpPayload,
  opencodeProjector,
  opencodeSkillPath,
} from '../../../../src/core/project/projectors/opencode';
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
    profile: ProfileSchema.parse({ version: 1, targets: ['opencode'] }),
    skillsToMaterialize: [],
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

describe('opencodeProjector.plan（Spec §8.3 主规则 / MCP / skills）', () => {
  it('project scope：主规则 = <root>\\AGENTS.md，merge_marker，内容为统一渲染结果；MCP = 根 opencode.json', () => {
    const ctx = buildCtx();
    const plan = opencodeProjector.plan(ctx);
    expect(plan.targetId).toBe('opencode');
    expect(plan.items).toEqual([
      {
        path: 'C:\\proj\\AGENTS.md',
        action: 'merge_marker',
        content: ctx.renderedRulesMd,
      },
      {
        path: 'C:\\proj\\opencode.json',
        action: 'merge_json',
        content: '{"mcp":{}}',
      },
    ]);
  });

  it('user scope：主规则 = <home>\\.config\\opencode\\AGENTS.md，MCP = 同目录 opencode.json', () => {
    const ctx = buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' });
    const plan = opencodeProjector.plan(ctx);
    expect(plan.items[0]?.path).toBe('C:\\Users\\u\\.config\\opencode\\AGENTS.md');
    expect(plan.items[1]?.path).toBe('C:\\Users\\u\\.config\\opencode\\opencode.json');
  });

  it('posix os：分隔符为 /（Spec §2.1 路径随平台）', () => {
    const ctx = buildCtx({ os: { platform: 'linux' }, rootDir: '/home/u/proj' });
    const plan = opencodeProjector.plan(ctx);
    expect(plan.items[0]?.path).toBe('/home/u/proj/AGENTS.md');
    expect(plan.items[1]?.path).toBe('/home/u/proj/opencode.json');
  });

  it('skills：write 实体 copy 项落在 .opencode\\skills\\<name>\\SKILL.md（project）', () => {
    const ctx = buildCtx({
      skillsToMaterialize: [
        { name: 'my-skill', content: '# My Skill\n' },
        { name: 'other', content: '# Other\n' },
      ],
    });
    const plan = opencodeProjector.plan(ctx);
    expect(plan.items[1]).toEqual({
      path: 'C:\\proj\\.opencode\\skills\\my-skill\\SKILL.md',
      action: 'write',
      content: '# My Skill\n',
    });
    expect(plan.items[2]?.path).toBe('C:\\proj\\.opencode\\skills\\other\\SKILL.md');
  });

  it('skills（user scope）：落在 .config\\opencode\\skills\\<name>\\SKILL.md', () => {
    const ctx = buildCtx({
      scope: 'user',
      rootDir: 'C:\\Users\\u',
      skillsToMaterialize: [{ name: 's1', content: 'x' }],
    });
    const plan = opencodeProjector.plan(ctx);
    expect(plan.items[1]?.path).toBe('C:\\Users\\u\\.config\\opencode\\skills\\s1\\SKILL.md');
  });

  it('plan 为纯函数：同一 ctx 多次调用结果一致，不改写 ctx', () => {
    const ctx = buildCtx();
    const first = opencodeProjector.plan(ctx);
    expect(opencodeProjector.plan(ctx)).toEqual(first);
    expect(ctx.renderedRulesMd).toBe('# AgentForge Rules\n- use fnm\n');
  });
});

describe('opencodeMcpPayload（OpenCode mcp 键惯例）', () => {
  it('空 servers → {"mcp":{}}（管理键声明保留）', () => {
    expect(opencodeMcpPayload([])).toBe('{"mcp":{}}');
  });

  it('stdio → local 形态：command 数组（command + args）+ environment', () => {
    const payload = JSON.parse(opencodeMcpPayload([stdioServer()])) as {
      mcp: Record<string, unknown>;
    };
    expect(payload.mcp.fs).toEqual({
      type: 'local',
      command: ['npx', '-y', 'server-fs'],
      enabled: true,
    });
  });

  it('stdio + env → environment 键', () => {
    const server = stdioServer({ env: { KEY: 'v' } });
    const payload = JSON.parse(opencodeMcpPayload([server])) as {
      mcp: { fs: { environment?: Record<string, string> } };
    };
    expect(payload.mcp.fs.environment).toEqual({ KEY: 'v' });
  });

  it('http → remote 形态：url + enabled（+ headers）', () => {
    const server = McpServerSchema.parse({
      name: 'docs',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
    const payload = JSON.parse(opencodeMcpPayload([server])) as {
      mcp: Record<string, unknown>;
    };
    expect(payload.mcp.docs).toEqual({
      type: 'remote',
      url: 'https://example.com/mcp',
      enabled: true,
      headers: { Authorization: 'Bearer x' },
    });
  });

  it('enabled=false 的 server 不投影', () => {
    const payload = JSON.parse(
      opencodeMcpPayload([stdioServer({ enabled: false }), stdioServer()]),
    ) as { mcp: Record<string, unknown> };
    expect(Object.keys(payload.mcp)).toEqual(['fs']);
  });
});

describe('opencodeProjector.plan — profile.projection 开关（Spec §4.2 / §8.7）', () => {
  it('write_agents_md=false → 不再产出 AGENTS.md 项（其余项不变）', () => {
    const ctx = buildCtx({
      profile: ProfileSchema.parse({
        version: 1,
        targets: ['opencode'],
        projection: { write_agents_md: false },
      }),
    });
    const plan = opencodeProjector.plan(ctx);
    expect(plan.items.map((i) => i.path)).toEqual(['C:\\proj\\opencode.json']);
  });

  it('write_claude_md=true → 追加 §8.7「可选」的 CLAUDE.md 项，与 AGENTS.md 同内容', () => {
    const ctx = buildCtx({
      profile: ProfileSchema.parse({
        version: 1,
        targets: ['opencode'],
        projection: { write_claude_md: true },
      }),
    });
    const plan = opencodeProjector.plan(ctx);
    expect(plan.items.slice(0, 2)).toEqual([
      { path: 'C:\\proj\\AGENTS.md', action: 'merge_marker', content: ctx.renderedRulesMd },
      { path: 'C:\\proj\\CLAUDE.md', action: 'merge_marker', content: ctx.renderedRulesMd },
    ]);
    expect(opencodeClaudeRulePath(ctx)).toBe('C:\\proj\\CLAUDE.md');
  });

  it('默认（未显式配置）→ 只有 AGENTS.md，CLAUDE.md 不投影（保持既有行为）', () => {
    const plan = opencodeProjector.plan(buildCtx());
    expect(plan.items.some((i) => i.path.endsWith('CLAUDE.md'))).toBe(false);
  });

  it('marker_mode=none → 主规则项动作降级为 write（不做 marker 包裹）', () => {
    const plan = opencodeProjector.plan(buildCtx({ markerMode: 'none' }));
    expect(plan.items[0]).toEqual({
      path: 'C:\\proj\\AGENTS.md',
      action: 'write',
      content: '# AgentForge Rules\n- use fnm\n',
    });
  });

  it('marker_mode=append_below_marker / 缺省 → 仍为 merge_marker（语义差异在 writer 层）', () => {
    expect(
      opencodeProjector.plan(buildCtx({ markerMode: 'append_below_marker' })).items[0]?.action,
    ).toBe('merge_marker');
    expect(opencodeProjector.plan(buildCtx()).items[0]?.action).toBe('merge_marker');
  });
});

describe('opencode 路径函数（status/init 打印共用）', () => {
  it('opencodeMainRulePath 与 plan 产出的路径一致', () => {
    const ctx = buildCtx({ os: { platform: 'linux' }, rootDir: '/proj' });
    expect(opencodeMainRulePath(ctx)).toBe(opencodeProjector.plan(ctx).items[0]?.path);
  });

  it('opencodeMcpPath 与 plan 产出的路径一致', () => {
    const ctx = buildCtx({ os: { platform: 'linux' }, rootDir: '/proj' });
    expect(opencodeMcpPath(ctx)).toBe(opencodeProjector.plan(ctx).items.at(-1)?.path);
  });

  it('opencodeSkillPath：project / user 两态', () => {
    expect(opencodeSkillPath(buildCtx(), 's')).toBe('C:\\proj\\.opencode\\skills\\s\\SKILL.md');
    expect(opencodeSkillPath(buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' }), 's')).toBe(
      'C:\\Users\\u\\.config\\opencode\\skills\\s\\SKILL.md',
    );
  });
});
