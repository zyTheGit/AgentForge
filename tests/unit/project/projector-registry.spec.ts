/**
 * Projector 注册表的扩展点语义（Phase 3「适配器插件化」第一层）：
 *
 * 1. target 全集只有**一个**运行时事实源 = 注册表。`--targets` 校验走
 *    `registeredTargetIds()`，后补注册的 projector 立刻被认；
 * 2. `BUILTIN_TARGET_IDS` 只描述"CLI 自带哪几个"（类型窄化用），不参与运行时校验；
 * 3. `Projector.skillDir` / `skillPath` 进契约后，四个内置 target 的路径必须与
 *    重构前**逐字符相等**——这是「第一层是纯重构、产物不变」的守卫。
 *
 * 本文件会往全局 `projectorRegistry` 里注册一个 fake target：vitest 按文件隔离模块图，
 * 不会污染其他 spec。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { EnvSnapshot } from '../../../src/core/env';
import { ConfigError } from '../../../src/core/errors';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../../../src/core/markers';
import { filterTargets } from '../../../src/core/project/engine';
import {
  BUILTIN_TARGET_IDS,
  projectorRegistry,
  registeredTargetIds,
} from '../../../src/core/project/projectors/registry';
import type { ProjectContext, ProjectionPlan, Projector } from '../../../src/core/project/types';
import { HabitsSchema, ProfileSchema } from '../../../src/schema';

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

function buildCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    os: { platform: 'win32' },
    scope: 'project',
    rootDir: 'C:\\proj',
    renderedRulesMd: '',
    habits: HabitsSchema.parse({ version: 1 }),
    profile: ProfileSchema.parse({ version: 1, targets: ['claude'] }),
    skillsToMaterialize: [],
    commandsToExpose: [],
    mcpServers: [],
    dryRun: true,
    lineEnding: 'lf',
    markerBegin: DEFAULT_MARKER_BEGIN,
    markerEnd: DEFAULT_MARKER_END,
    markerMode: 'replace_between_markers',
    env,
    ...overrides,
  };
}

/** 第三方 target 的最小实现（只走接口，不碰内置模块）。 */
const fakeProjector: Projector = {
  id: 'fake-agent',
  skillInvokePrefix: '/',
  skillDir: (ctx) => `${ctx.rootDir}\\.fake\\skills`,
  skillPath: (ctx, name) => `${ctx.rootDir}\\.fake\\skills\\${name}\\SKILL.md`,
  plan: (ctx): ProjectionPlan => ({
    targetId: 'fake-agent',
    items: [{ path: `${ctx.rootDir}\\FAKE.md`, action: 'write', content: '' }],
  }),
};

describe('内置 target 与注册表的关系', () => {
  it('BUILTIN_TARGET_IDS 按装配顺序，且是注册表的子集', () => {
    expect([...BUILTIN_TARGET_IDS]).toEqual(['opencode', 'codex', 'claude', 'pi']);
    for (const id of BUILTIN_TARGET_IDS) {
      expect(projectorRegistry.has(id)).toBe(true);
    }
  });

  it('registeredTargetIds 与 list() 的 id 同序同源', () => {
    expect(registeredTargetIds()).toEqual(projectorRegistry.list().map((p) => p.id));
  });
});

/** 本文件永不注册的 id：用来断言「注册表不认的 id」，不依赖任何执行顺序。 */
const NEVER_REGISTERED_ID = 'never-registered-agent';

describe('--targets 校验与注册表同源（后补注册可用）', () => {
  // 注册挪到 beforeAll：原先「注册前不认 fake-agent」与「注册 fake-agent」是两个 it，
  // 前者只在跑在后者之前才成立（用例间靠执行顺序耦合全局单例），单跑第二个用例或
  // 开 sequence.shuffle 就红。改成 beforeAll 后本 describe 内每条用例看到的注册表状态
  // 恒定 = 内置四个 + fake-agent。
  //
  // 「后补注册可见」这条语义仍被覆盖：beforeAll 发生在模块加载**之后**，
  // registeredTargetIds() 能看到它，就说明链路上没有模块级快照。
  beforeAll(() => {
    projectorRegistry.register(fakeProjector.id, () => fakeProjector);
  });

  it('注册表不认的 id → ConfigError(2)', () => {
    expect(() => filterTargets([NEVER_REGISTERED_ID], [NEVER_REGISTERED_ID])).toThrow(ConfigError);
    expect(() => filterTargets([NEVER_REGISTERED_ID], [NEVER_REGISTERED_ID])).toThrow(
      new RegExp(`未知 target: ${NEVER_REGISTERED_ID}`),
    );
  });

  it('后补注册立刻可见：registeredTargetIds / get 反映新项', () => {
    expect(registeredTargetIds()).toEqual([...BUILTIN_TARGET_IDS, 'fake-agent']);
    expect(projectorRegistry.get('fake-agent')).toBe(fakeProjector);
    expect(projectorRegistry.has('fake-agent')).toBe(true);
  });

  it('注册后 --targets 认它（profile.targets 里启用）', () => {
    // 注意：这条覆盖的是**生产上到不了**的路径——`profile.targets` 一定过
    // `ProfileSchema.parse`，而 TargetEnum 只认四个内置 id，第三方 target 永远进不了
    // profile.targets（下面那条用例固化了这个当前真实行为）。这里断言的是
    // 「Phase 3 第二层放开 TargetEnum 之后」filterTargets 该有的语义：只要 id 在注册表里
    // 且在 profile.targets 里启用，就该被选中。
    expect(filterTargets(['claude', 'fake-agent'], ['fake-agent'])).toEqual(['fake-agent']);
    // 未启用仍是「未在 profile.targets 中启用」而不是「未知 target」
    expect(() => filterTargets(['claude'], ['fake-agent'])).toThrow(/未在 profile.targets 中启用/);
  });

  it('当前真实行为：第三方 target 写不进 profile.targets（TargetEnum 只认内置四个）', () => {
    // 与上一条配对：注册表认了 fake-agent，profile schema 仍不认——这正是
    // 「运行时集合」与「profile 取值域」当前的分层，第二层放开时这条会需要改。
    expect(() => ProfileSchema.parse({ version: 1, targets: ['fake-agent'] })).toThrow();
    expect(() =>
      ProfileSchema.parse({ version: 1, targets: [...BUILTIN_TARGET_IDS] }),
    ).not.toThrow();
  });

  it('注册后仍未知的 id → ConfigError，且 hint 列出注册表内容（含 fake）', () => {
    let hint: string | undefined;
    try {
      filterTargets(['claude'], ['nope']);
    } catch (err) {
      hint = err instanceof ConfigError ? err.hint : undefined;
    }
    expect(hint).toBe('有效值: opencode, codex, claude, pi, fake-agent');
  });

  it('重复注册同一 id → GenericError(1)（后补注册不放宽冲突检测）', () => {
    expect(() => projectorRegistry.register('claude', () => fakeProjector)).toThrow(
      /id 已注册: claude/,
    );
  });
});

/**
 * 产物守卫：四个内置 target 经 `Projector.skillDir` / `skillPath` 得到的路径，
 * 与 Phase 3 重构前命令层四行硬编码 import 的结果逐字符相等（含 scope / 平台 /
 * CODEX_HOME / PI_CODING_AGENT_DIR 覆盖四种口径）。
 *
 * 遍历用 `BUILTIN_TARGET_IDS` 而不是 `registeredTargetIds().slice(0, 4)`：后者假设
 * 内置四个恒在注册表最前，而本文件已经往表尾塞了第五项 fake-agent——那个假设一旦
 * 因注册顺序调整而不成立，断言会以「路径不匹配」的形式误报到 projector 上。
 */
describe('skillDir / skillPath 走接口后路径逐字符不变', () => {
  const byId = (id: string): Projector => projectorRegistry.get(id) as Projector;

  it('project scope（win32）', () => {
    const ctx = buildCtx();
    expect(BUILTIN_TARGET_IDS.map((id) => byId(id).skillPath(ctx, 'demo'))).toEqual([
      'C:\\proj\\.opencode\\skills\\demo\\SKILL.md',
      'C:\\proj\\.agents\\skills\\demo\\SKILL.md',
      'C:\\proj\\.claude\\skills\\demo\\SKILL.md',
      'C:\\proj\\.pi\\skills\\demo\\SKILL.md',
    ]);
    expect(BUILTIN_TARGET_IDS.map((id) => byId(id).skillDir(ctx))).toEqual([
      'C:\\proj\\.opencode\\skills',
      'C:\\proj\\.agents\\skills',
      'C:\\proj\\.claude\\skills',
      'C:\\proj\\.pi\\skills',
    ]);
  });

  it('user scope（win32，无环境变量覆盖）', () => {
    const ctx = buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' });
    expect(BUILTIN_TARGET_IDS.map((id) => byId(id).skillPath(ctx, 'demo'))).toEqual([
      'C:\\Users\\u\\.config\\opencode\\skills\\demo\\SKILL.md',
      'C:\\Users\\u\\.codex\\skills\\demo\\SKILL.md',
      'C:\\Users\\u\\.claude\\skills\\demo\\SKILL.md',
      'C:\\Users\\u\\.pi\\agent\\skills\\demo\\SKILL.md',
    ]);
  });

  it('user scope：CODEX_HOME / PI_CODING_AGENT_DIR 覆盖仍生效', () => {
    const ctx = buildCtx({
      scope: 'user',
      rootDir: 'C:\\Users\\u',
      env: { ...env, codexHome: 'D:\\cx', piCodingAgentDir: 'D:\\pi-agent' },
    });
    expect(BUILTIN_TARGET_IDS.map((id) => byId(id).skillPath(ctx, 'demo'))).toEqual([
      'C:\\Users\\u\\.config\\opencode\\skills\\demo\\SKILL.md',
      'D:\\cx\\skills\\demo\\SKILL.md',
      'C:\\Users\\u\\.claude\\skills\\demo\\SKILL.md',
      'D:\\pi-agent\\skills\\demo\\SKILL.md',
    ]);
  });

  it('posix 平台：分隔符随注入 os（Spec §2.1）', () => {
    const ctx = buildCtx({ os: { platform: 'linux' }, scope: 'user', rootDir: '/home/u' });
    expect(BUILTIN_TARGET_IDS.map((id) => byId(id).skillPath(ctx, 'demo'))).toEqual([
      '/home/u/.config/opencode/skills/demo/SKILL.md',
      '/home/u/.codex/skills/demo/SKILL.md',
      '/home/u/.claude/skills/demo/SKILL.md',
      '/home/u/.pi/agent/skills/demo/SKILL.md',
    ]);
  });

  it('skillPath = <skillDir>\\<name>\\SKILL.md（四个内置 target 一致）', () => {
    const ctx = buildCtx();
    for (const id of BUILTIN_TARGET_IDS) {
      const projector = byId(id);
      expect(projector.skillPath(ctx, 'demo')).toBe(`${projector.skillDir(ctx)}\\demo\\SKILL.md`);
    }
  });
});
