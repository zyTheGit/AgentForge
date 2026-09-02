/**
 * 命令层对声明式 target 的容错（issue #53 第一层耦合点）。
 *
 * 命令层原先假设「每个已注册 projector 都能算出任意 scope 的落点」——内置四家确实
 * 如此。声明式适配器打破了这个假设：`scopes` 里可以只声明 project，此时 user scope
 * 的 `skillPath` 会抛 ConfigError（编一个 sync 永远不会写的路径打给用户是假信息）。
 *
 * 于是「装完/删完去哪儿看」这类清单必须逐项容错，不能让一份写错的第三方 yaml 把
 * `aforge skill remove` 整条命令打挂。本文件用全局注册表验证这一点——`Registry`
 * 没有 unregister，所以放在独立 spec 文件里（vitest 按文件隔离模块状态）。
 */
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../../../src/commands/_shared/context';
import { projectedSkillDocPaths } from '../../../src/commands/assets/skill';
import { buildDeclarativeProjector } from '../../../src/core/adapters/projector';
import { parseAdapterScopes } from '../../../src/core/adapters/resolve';
import type { EnvSnapshot } from '../../../src/core/env';
import { projectorRegistry } from '../../../src/core/project/projectors/registry';
import { BUILTIN_TARGET_IDS } from '../../../src/core/project/target-ids';
import { realHost } from '../../../src/infra/real-host';
import { AdapterSchema } from '../../../src/schema/adapter';

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

/** host 不参与路径计算（本用例零 IO），但 CommandContext 要求它在场。 */
const ctx: CommandContext = { host: realHost, cwd: 'C:\\proj', os: OS };

/** 只声明 project scope 的声明式 target（user scope 的 skillPath 必然抛错）。 */
const doc = AdapterSchema.parse({
  version: 1,
  id: 'project-only',
  scopes: {
    project: { base: '{projectRoot}/.my', skills_dir: '{base}/skills' },
  },
});

projectorRegistry.register('project-only', () =>
  buildDeclarativeProjector({
    doc,
    file: 'C:\\Users\\u\\.agentforge\\adapters\\project-only.yaml',
    layer: 'user',
    projectRoot: 'C:\\proj',
    userHome: 'C:\\Users\\u',
    envValues: {},
    scopes: parseAdapterScopes(doc),
  }),
);

describe('projectedSkillDocPaths — 声明式 target 的容错', () => {
  it('project scope：声明式 target 的落点跟在内置四条之后（注册顺序）', () => {
    expect(projectedSkillDocPaths(ctx, env, 'project', 'demo')).toEqual([
      'C:\\proj\\.opencode\\skills\\demo\\SKILL.md',
      'C:\\proj\\.agents\\skills\\demo\\SKILL.md',
      'C:\\proj\\.claude\\skills\\demo\\SKILL.md',
      'C:\\proj\\.pi\\skills\\demo\\SKILL.md',
      'C:\\proj\\.my\\skills\\demo\\SKILL.md',
    ]);
  });

  it('user scope：该 target 算不出落点 → **跳过它**，内置四条逐字不变', () => {
    // 关键：不是抛异常、也不是打一条编出来的假路径
    expect(projectedSkillDocPaths(ctx, env, 'user', 'demo')).toEqual([
      'C:\\Users\\u\\.config\\opencode\\skills\\demo\\SKILL.md',
      'C:\\Users\\u\\.codex\\skills\\demo\\SKILL.md',
      'C:\\Users\\u\\.claude\\skills\\demo\\SKILL.md',
      'C:\\Users\\u\\.pi\\agent\\skills\\demo\\SKILL.md',
    ]);
  });

  it('注册表里确实多了那一项（上一条的"跳过"不是因为没注册上）', () => {
    expect(projectorRegistry.ids()).toEqual([...BUILTIN_TARGET_IDS, 'project-only']);
  });
});
