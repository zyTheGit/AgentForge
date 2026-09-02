/**
 * Phase 3 第一层的两条「形态契约」回归守卫：
 *
 * 1. `projectedSkillDocPaths`（commands/assets/skill）—— `skill remove` 打给用户的
 *    「下次 sync 会删这几个投影副本」清单。本 PR 把它从四行硬编码 import 改成
 *    `projectorRegistry.list().map(...)`，**条数从固定 4 变成随注册表条数变化**，
 *    是整个 PR 里唯一形态真变了的地方，而它原先零断言。这里固化条数 + 顺序
 *    （顺序也是契约：用户照这几行的顺序去找文件，skill.ts 注释明写「顺序 = 注册顺序」）。
 *
 * 2. `Projector.plan()` 的产物 —— 「第一层是纯重构、投影产物逐字节不变」这个声称
 *    原先只靠一个没进 commit 的临时 sha256 脚本，下一次改动就零回归保护。这里把
 *    四个内置 target × project/user 两口径的 items（path + action + soft + 内容 sha256）
 *    落成快照，任何一处字节变化都会红。
 *
 * 两块都用注入的 os / scope / env（不落盘、不读真实环境），故在 win32 与 posix 上
 * 结果一致。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../../../src/commands/_shared/context';
import { projectedSkillDocPaths } from '../../../src/commands/assets/skill';
import { defaultHabits, windowsDefaultProfile } from '../../../src/core/config/defaults';
import type { EnvSnapshot } from '../../../src/core/env';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../../../src/core/markers';
import { projectorRegistry } from '../../../src/core/project/projectors/registry';
import { BUILTIN_TARGET_IDS } from '../../../src/core/project/target-ids';
import type { ProjectContext, Projector } from '../../../src/core/project/types';
import { realHost } from '../../../src/infra/real-host';
import { HabitsSchema, ProfileSchema } from '../../../src/schema';

const OS = { platform: 'win32' } as const;

const env: EnvSnapshot = {
  agfHome: undefined,
  agfScope: undefined,
  offline: false,
  lineEnding: undefined,
  ci: false,
  codexHome: undefined,
  piCodingAgentDir: undefined,
  userProfile: 'C:\\Users\\u',
};

// ---------------------------------------------------------------------------
// 1. skill remove 的「投影副本清单」
// ---------------------------------------------------------------------------

describe('projectedSkillDocPaths（skill remove 的清理提示）', () => {
  // host 不参与路径计算（projectedSkillDocPaths 只读 ctx.cwd / ctx.os 与传入的 env），
  // 但 CommandContext 要求它在场，故直接用 realHost：本用例不做任何 IO。
  const ctx: CommandContext = { host: realHost, cwd: 'C:\\proj', os: OS };

  it('project scope：四条路径与顺序 = 注册顺序（opencode → codex → claude → pi）', () => {
    expect(projectedSkillDocPaths(ctx, env, 'project', 'demo')).toEqual([
      'C:\\proj\\.opencode\\skills\\demo\\SKILL.md',
      'C:\\proj\\.agents\\skills\\demo\\SKILL.md',
      'C:\\proj\\.claude\\skills\\demo\\SKILL.md',
      'C:\\proj\\.pi\\skills\\demo\\SKILL.md',
    ]);
  });

  it('user scope：落各 target 的全局根（不在项目根下）', () => {
    expect(projectedSkillDocPaths(ctx, env, 'user', 'demo')).toEqual([
      'C:\\Users\\u\\.config\\opencode\\skills\\demo\\SKILL.md',
      'C:\\Users\\u\\.codex\\skills\\demo\\SKILL.md',
      'C:\\Users\\u\\.claude\\skills\\demo\\SKILL.md',
      'C:\\Users\\u\\.pi\\agent\\skills\\demo\\SKILL.md',
    ]);
  });

  it('user scope：CODEX_HOME 覆盖生效（env 必须被注入下去）', () => {
    const paths = projectedSkillDocPaths(ctx, { ...env, codexHome: 'D:\\cx' }, 'user', 'demo');
    expect(paths[1]).toBe('D:\\cx\\skills\\demo\\SKILL.md');
  });

  it('条数跟着注册表走（不是写死的 4）：每个已注册 target 恰好一条', () => {
    const ids = projectorRegistry.list().map((p) => p.id);
    expect(projectedSkillDocPaths(ctx, env, 'project', 'demo')).toHaveLength(ids.length);
    expect(ids).toEqual([...BUILTIN_TARGET_IDS]);
  });
});

// ---------------------------------------------------------------------------
// 2. plan() 产物的字节级快照
// ---------------------------------------------------------------------------

/** 固定输入的投影上下文（skills / commands / mcp 都给内容，尽量覆盖各类 item）。 */
function planCtx(scope: 'project' | 'user'): ProjectContext {
  const profile = ProfileSchema.parse({
    ...windowsDefaultProfile(),
    targets: [...BUILTIN_TARGET_IDS],
    skills: { always: ['demo'], expose_as_command: ['demo'] },
    mcp: {
      servers: [
        { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server-fs'] },
        { name: 'docs', transport: 'http', url: 'https://example.com/mcp' },
      ],
    },
  });
  return {
    os: OS,
    scope,
    rootDir: scope === 'project' ? 'C:\\proj' : 'C:\\Users\\u',
    renderedRulesMd: '# Rules\n\n- 固定正文，用于产物快照\n',
    habits: HabitsSchema.parse(defaultHabits()),
    profile,
    skillsToMaterialize: [{ name: 'demo', content: '# demo skill\n' }],
    commandsToExpose: [{ name: 'demo', namespace: [], description: 'demo 命令' }],
    mcpServers: profile.mcp.servers ?? [],
    dryRun: true,
    lineEnding: 'lf',
    markerBegin: DEFAULT_MARKER_BEGIN,
    markerEnd: DEFAULT_MARKER_END,
    markerMode: 'replace_between_markers',
    env,
  };
}

/** 一个 target 的产物指纹：路径 / 动作 / soft 标记 / 内容 sha256（内容本身不入快照，太长）。 */
function fingerprint(projector: Projector, ctx: ProjectContext): readonly string[] {
  return projector.plan(ctx).items.map((item) => {
    const hash = createHash('sha256').update(item.content, 'utf8').digest('hex').slice(0, 16);
    return `${item.action}${item.soft === true ? '(soft)' : ''} ${item.path} sha256:${hash}`;
  });
}

describe('投影产物字节级不变（四内置 target × project/user）', () => {
  for (const scope of ['project', 'user'] as const) {
    it(`${scope} scope 的 plan items 指纹`, () => {
      const ctx = planCtx(scope);
      const byTarget = Object.fromEntries(
        BUILTIN_TARGET_IDS.map((id) => {
          const projector = projectorRegistry.get(id) as Projector;
          return [id, fingerprint(projector, ctx)];
        }),
      );
      expect(byTarget).toMatchSnapshot();
    });
  }

  it('plan 是纯函数：同一 ctx 连算两次结果相同', () => {
    const ctx = planCtx('project');
    for (const id of BUILTIN_TARGET_IDS) {
      const projector = projectorRegistry.get(id) as Projector;
      expect(fingerprint(projector, ctx)).toEqual(fingerprint(projector, ctx));
    }
  });
});
