/**
 * claude projector 单测（Spec §8.5）：plan 纯函数（路径 / 动作 / 内容 / 平台分隔符）
 * 与路径常量（skills / MCP 的 M8 契约位）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../../../../src/core/markers';
import {
  CLAUDE_MAIN_RULE_FILENAME,
  claudeMainRulePath,
  claudeMcpPath,
  claudeProjector,
  claudeSkillPath,
} from '../../../../src/core/project/projectors/claude';
import type { ProjectContext } from '../../../../src/core/project/types';
import { HabitsSchema, ProfileSchema } from '../../../../src/schema';

function buildCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    os: { platform: 'win32' },
    scope: 'project',
    rootDir: 'C:\\proj',
    renderedRulesMd: '# AgentForge Rules\n- use fnm\n',
    habits: HabitsSchema.parse({ version: 1 }),
    profile: ProfileSchema.parse({ version: 1, targets: ['claude'] }),
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

describe('claudeProjector.plan（Spec §8.5 主规则）', () => {
  it('project scope：主规则 = <root>CLAUDE.md，merge_marker，内容为统一渲染结果；MCP 项恒产出（空 servers → 空 mcpServers）', () => {
    const ctx = buildCtx();
    const plan = claudeProjector.plan(ctx);
    expect(plan.targetId).toBe('claude');
    expect(plan.items).toEqual([
      {
        path: 'C:\\proj\\CLAUDE.md',
        action: 'merge_marker',
        content: ctx.renderedRulesMd,
      },
      {
        path: 'C:\\proj\\.mcp.json',
        action: 'merge_json',
        content: '{"mcpServers":{}}',
      },
    ]);
  });

  it('user scope：主规则 = <userHome>\\.claude\\CLAUDE.md', () => {
    const ctx = buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' });
    const plan = claudeProjector.plan(ctx);
    expect(plan.items[0]?.path).toBe('C:\\Users\\u\\.claude\\CLAUDE.md');
  });

  it('posix os：分隔符为 /（Spec §2.1 路径随平台）', () => {
    const ctx = buildCtx({ os: { platform: 'linux' }, rootDir: '/home/u/proj' });
    const plan = claudeProjector.plan(ctx);
    expect(plan.items[0]?.path).toBe('/home/u/proj/CLAUDE.md');
  });

  it('plan 为纯函数：同一 ctx 多次调用结果一致，不改写 ctx', () => {
    const ctx = buildCtx();
    const first = claudeProjector.plan(ctx);
    expect(claudeProjector.plan(ctx)).toEqual(first);
    expect(ctx.renderedRulesMd).toBe('# AgentForge Rules\n- use fnm\n');
  });
});

describe('claudeProjector.plan — profile.projection 开关（Spec §4.2 / §8.7）', () => {
  it('write_claude_md=false → 不产出 CLAUDE.md 项（MCP 项不受影响）', () => {
    const ctx = buildCtx({
      profile: ProfileSchema.parse({
        version: 1,
        targets: ['claude'],
        projection: { write_claude_md: false },
      }),
    });
    expect(claudeProjector.plan(ctx).items.map((i) => i.path)).toEqual(['C:\\proj\\.mcp.json']);
  });

  it('marker_mode=none → CLAUDE.md 动作降级为 write', () => {
    const plan = claudeProjector.plan(buildCtx({ markerMode: 'none' }));
    expect(plan.items[0]?.action).toBe('write');
  });
});

describe('claude 路径常量（§8.5 skills / MCP 契约位）', () => {
  it('主规则文件名', () => {
    expect(CLAUDE_MAIN_RULE_FILENAME).toBe('CLAUDE.md');
  });

  it('skills 路径：project = <root>\\.claude\\skills\\<name>\\SKILL.md；user = <home>\\.claude\\skills\\...', () => {
    expect(claudeSkillPath(buildCtx(), 'my-skill')).toBe(
      'C:\\proj\\.claude\\skills\\my-skill\\SKILL.md',
    );
    expect(claudeSkillPath(buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' }), 'my-skill')).toBe(
      'C:\\Users\\u\\.claude\\skills\\my-skill\\SKILL.md',
    );
  });

  it('MCP 路径：project 根下 .mcp.json（user scope 同样落在 rootDir 基准，M6/M8 决定全局策略）', () => {
    expect(claudeMcpPath(buildCtx())).toBe('C:\\proj\\.mcp.json');
  });

  it('claudeMainRulePath 与 plan 产出的路径一致（status/init 打印共用）', () => {
    const ctx = buildCtx({ os: { platform: 'linux' }, rootDir: '/proj' });
    expect(claudeMainRulePath(ctx)).toBe(claudeProjector.plan(ctx).items[0]?.path);
  });
});
