/**
 * 声明式适配器 → ProjectionPlan（issue #53）。
 *
 * 这个文件同时是「第一层接口收口是够的」那句结论的验证：一份 yaml 声明能产出
 * 与内置 projector 同形的 plan（主规则 / skills / commands / MCP），而 prune 记账、
 * marker 语义、事务回滚全都靠 `Projector` 接口自动生效，声明式侧一行都没写。
 *
 * 重点断言：
 * - 落点顺序与形状（主规则 → skills → commands → MCP）；
 * - `merge_marker` 跟随 `marker_mode`（none 档降级为整文件 write）；
 * - 主规则 toggle 复用 §8.7 的三种既有语义；
 * - commands 的 subdir / flatten 两档；
 * - MCP 的两种内置 dialect payload + soft 标记；
 * - `skillDir` / `skillPath` 是真值（不是编出来的路径）；未声明该 scope → 抛 ConfigError；
 * - `writesSessionHooks` 恒 false（声明式装不了会话钩子）；
 * - plan 是纯函数；产物数量上限；每一项都过 containment。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDeclarativeProjector } from '../../../src/core/adapters/projector';
import { type AdapterRuntime, parseAdapterScopes } from '../../../src/core/adapters/resolve';
import { ConfigError } from '../../../src/core/errors';
import type { ProjectContext } from '../../../src/core/project/types';
import { HabitsSchema, ProfileSchema } from '../../../src/schema';
import { type AdapterDocInput, AdapterSchema } from '../../../src/schema/adapter';

const PROJECT = 'C:\\proj';
const HOME = 'C:\\Users\\u';

/** 造一份 runtime（doc 过 schema，模板过 parse——与生产路径同一条）。 */
function runtimeOf(overrides: Partial<AdapterDocInput> = {}): AdapterRuntime {
  const doc = AdapterSchema.parse({
    version: 1,
    id: 'my-agent',
    scopes: {
      project: {
        base: '{projectRoot}/.my',
        skills_dir: '{base}/skills',
        main_rule: '{base}/AGENTS.md',
        commands_dir: '{base}/commands',
      },
    },
    ...overrides,
  } as AdapterDocInput);
  return {
    doc,
    file: `${HOME}\\.agentforge\\adapters\\my-agent.yaml`,
    layer: 'user',
    projectRoot: PROJECT,
    userHome: HOME,
    envValues: {},
    scopes: parseAdapterScopes(doc),
  };
}

function buildCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    os: { platform: 'win32' },
    scope: 'project',
    rootDir: PROJECT,
    renderedRulesMd: '# AgentForge Rules\n',
    habits: HabitsSchema.parse({ version: 1 }),
    // profile.targets 用内置 id：本文件不走 loader，声明式 id 没进 knownTargetIds
    profile: ProfileSchema.parse({ version: 1, targets: ['claude'] }),
    skillsToMaterialize: [],
    commandsToExpose: [],
    mcpServers: [],
    dryRun: true,
    lineEnding: 'lf',
    markerBegin: '<!-- BEGIN AGENTFORGE -->',
    markerEnd: '<!-- END AGENTFORGE -->',
    ...overrides,
  };
}

describe('buildDeclarativeProjector — 落点与动作', () => {
  it('主规则 + skills + commands 按序产出，路径由 base 拼出', () => {
    const projector = buildDeclarativeProjector(runtimeOf());
    const plan = projector.plan(
      buildCtx({
        skillsToMaterialize: [{ name: 'code-review', content: 'body' }],
        commandsToExpose: [{ name: 'code-review', namespace: ['review'] }],
      }),
    );
    expect(plan.targetId).toBe('my-agent');
    expect(plan.items).toEqual([
      {
        path: 'C:\\proj\\.my\\AGENTS.md',
        action: 'merge_marker',
        content: '# AgentForge Rules\n',
      },
      {
        path: 'C:\\proj\\.my\\skills\\code-review\\SKILL.md',
        action: 'write',
        content: 'body',
      },
      {
        path: 'C:\\proj\\.my\\commands\\review\\code-review.md',
        action: 'write',
        content: expect.any(String),
      },
    ]);
  });

  it('marker_mode=none → 主规则动作降级为整文件 write（与内置四家同一判据）', () => {
    const projector = buildDeclarativeProjector(runtimeOf());
    expect(projector.plan(buildCtx({ markerMode: 'none' })).items[0]?.action).toBe('write');
  });

  it('action: write 声明 → 无条件整文件写（不看 marker_mode）', () => {
    const projector = buildDeclarativeProjector(runtimeOf({ main_rule: { action: 'write' } }));
    expect(projector.plan(buildCtx()).items[0]?.action).toBe('write');
  });

  it('main_rule.toggle 复用 §8.7 语义：claude_md_optional 需显式开启才产出', () => {
    const projector = buildDeclarativeProjector(
      runtimeOf({ main_rule: { toggle: 'claude_md_optional' } }),
    );
    expect(projector.plan(buildCtx()).items).toEqual([]);
    const on = buildCtx({
      profile: ProfileSchema.parse({
        version: 1,
        targets: ['claude'],
        projection: { write_claude_md: true },
      }),
    });
    expect(projector.plan(on).items[0]?.path).toBe('C:\\proj\\.my\\AGENTS.md');
  });

  it('main_rule.toggle=agents_md 受 write_agents_md 控制', () => {
    const projector = buildDeclarativeProjector(runtimeOf({ main_rule: { toggle: 'agents_md' } }));
    const off = buildCtx({
      profile: ProfileSchema.parse({
        version: 1,
        targets: ['claude'],
        projection: { write_agents_md: false },
      }),
    });
    expect(projector.plan(off).items).toEqual([]);
    expect(projector.plan(buildCtx()).items).toHaveLength(1);
  });

  it('commands.namespace=flatten → 命名空间拼进文件名而不是落子目录', () => {
    const projector = buildDeclarativeProjector(runtimeOf({ commands: { namespace: 'flatten' } }));
    const plan = projector.plan(
      buildCtx({ commandsToExpose: [{ name: 'code-review', namespace: ['review'] }] }),
    );
    expect(plan.items.map((i) => i.path)).toContain(
      'C:\\proj\\.my\\commands\\review-code-review.md',
    );
  });

  it('未声明 commands_dir → 不产出命令薄壳（缺省即不投影该类产物）', () => {
    const projector = buildDeclarativeProjector(
      runtimeOf({
        scopes: {
          project: {
            base: '{projectRoot}/.my',
            skills_dir: '{base}/skills',
            main_rule: '{base}/AGENTS.md',
          },
        },
      }),
    );
    const plan = projector.plan(buildCtx({ commandsToExpose: [{ name: 'x', namespace: [] }] }));
    expect(plan.items).toHaveLength(1);
  });

  it('posix 平台 → 分隔符为 /', () => {
    const projector = buildDeclarativeProjector({
      ...runtimeOf(),
      projectRoot: '/home/u/proj',
    });
    const plan = projector.plan(buildCtx({ os: { platform: 'linux' }, rootDir: '/home/u/proj' }));
    expect(plan.items[0]?.path).toBe('/home/u/proj/.my/AGENTS.md');
  });

  it('plan 是纯函数：多次调用结果一致（环境取值来自加载快照，不在 plan 里读）', () => {
    const projector = buildDeclarativeProjector(runtimeOf());
    const ctx = buildCtx();
    expect(projector.plan(ctx)).toEqual(projector.plan(ctx));
  });
});

describe('buildDeclarativeProjector — MCP dialect', () => {
  function mcpRuntime(dialect: 'mcpServers' | 'opencode', soft = false) {
    return runtimeOf({
      mcp: { dialect, soft },
      scopes: {
        project: {
          base: '{projectRoot}/.my',
          skills_dir: '{base}/skills',
          mcp_file: '{base}/mcp.json',
        },
      },
    });
  }

  // transport 显式给出：ctx.mcpServers 在生产上来自 ProfileSchema（transport 有默认
  // 值 stdio），手搓字面量绕过 schema 会让 transport 能力矩阵查表拿到 undefined
  const servers = [
    { name: 'fs', transport: 'stdio' as const, command: 'npx', args: ['-y', 'srv'] },
  ];

  it('dialect=mcpServers → {"mcpServers":{...}}（Claude 形状）', () => {
    const plan = buildDeclarativeProjector(mcpRuntime('mcpServers')).plan(
      buildCtx({ mcpServers: servers }),
    );
    const item = plan.items[0];
    expect(item?.path).toBe('C:\\proj\\.my\\mcp.json');
    expect(item?.action).toBe('merge_json');
    expect(JSON.parse(item?.content as string)).toHaveProperty('mcpServers.fs');
  });

  it('dialect=opencode → {"mcp":{...}}（OpenCode 形状）', () => {
    const plan = buildDeclarativeProjector(mcpRuntime('opencode')).plan(
      buildCtx({ mcpServers: servers }),
    );
    expect(JSON.parse(plan.items[0]?.content as string)).toHaveProperty('mcp.fs');
  });

  it('soft: true → 项上带 soft 标记（复用 §8.6 既有 best-effort 语义）', () => {
    const soft = buildDeclarativeProjector(mcpRuntime('opencode', true)).plan(buildCtx());
    expect(soft.items[0]?.soft).toBe(true);
    const hard = buildDeclarativeProjector(mcpRuntime('opencode', false)).plan(buildCtx());
    expect(hard.items[0]?.soft).toBeUndefined();
  });
});

describe('buildDeclarativeProjector — 接口契约位', () => {
  it('skillDir / skillPath 给出真实落点（skills_dir 必填，故不存在"编一个路径"）', () => {
    const projector = buildDeclarativeProjector(runtimeOf());
    const ctx = buildCtx();
    expect(projector.skillDir(ctx)).toBe('C:\\proj\\.my\\skills');
    expect(projector.skillPath(ctx, 'demo')).toBe(
      path.win32.join('C:\\proj\\.my\\skills', 'demo', 'SKILL.md'),
    );
  });

  it('未声明的 scope：plan 返回空 items，skillDir 抛 ConfigError(2) 并指向适配器文件', () => {
    const projector = buildDeclarativeProjector(runtimeOf());
    const userCtx = buildCtx({ scope: 'user', rootDir: HOME });
    expect(projector.plan(userCtx)).toEqual({ targetId: 'my-agent', items: [] });
    // 编一个 sync 永远不会写的路径打给用户等于假信息 → 抛错，调用方跳过
    let caught: unknown;
    try {
      projector.skillDir(userCtx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).hint).toContain('my-agent.yaml');
  });

  it('writesSessionHooks 恒 false（声明式装不了会话钩子，不能假装能）', () => {
    expect(buildDeclarativeProjector(runtimeOf()).writesSessionHooks).toBe(false);
  });

  it('skill_invoke_prefix 透传（$ 档的 target 也能声明）', () => {
    expect(buildDeclarativeProjector(runtimeOf()).skillInvokePrefix).toBe('/');
    expect(
      buildDeclarativeProjector(runtimeOf({ skill_invoke_prefix: '$' })).skillInvokePrefix,
    ).toBe('$');
  });
});

describe('buildDeclarativeProjector — 上限与 containment', () => {
  it('产物数超过上限 → ConfigError(2)（挡写盘炸弹）', () => {
    const projector = buildDeclarativeProjector(runtimeOf());
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `s${i}`, content: '' }));
    expect(() => projector.plan(buildCtx({ skillsToMaterialize: many }))).toThrow(/超过上限/);
  });

  it('每一项都过 containment：技能名带 .. 时被拦（落点由目录 + 名字拼成）', () => {
    const projector = buildDeclarativeProjector(runtimeOf());
    expect(() =>
      projector.plan(
        buildCtx({ skillsToMaterialize: [{ name: '..\\..\\..\\Windows', content: '' }] }),
      ),
    ).toThrow(/越出允许的根目录/);
  });
});
