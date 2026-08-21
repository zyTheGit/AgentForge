/**
 * 配置合并单测（Spec §4.2 合并策略语义）：
 * - Spec 两个示例逐字断言（targets / ai.verification）；
 * - strategy(overlay|replace) × arrays(append|replace) 全组合表驱动；
 * - habits 深合并 / detected 快照替换 / 输入不可变。
 */
import { describe, expect, it } from 'vitest';
import { mergeHabits, mergeProfiles } from '../../src/core/config/merge';
import type { ArrayMergeMode, MergeStrategy } from '../../src/core/config/merge';
import type { HabitsInput, ProfileInput } from '../../src/schema';

describe('Spec §4.2 示例（逐字断言）', () => {
  it('示例 1：user targets [opencode, codex] + project [claude] → 均为 [claude]', () => {
    const user: ProfileInput = { version: 1, scope: 'user', targets: ['opencode', 'codex'] };
    const project: ProfileInput = { version: 1, scope: 'project', targets: ['claude'] };
    // targets 为"选择型"数组：不受 merge.arrays 影响，project 有值即覆盖
    expect(
      mergeProfiles(user, project, { strategy: 'overlay', arrays: 'replace' }).targets,
    ).toEqual(['claude']);
    expect(mergeProfiles(user, project, { strategy: 'overlay', arrays: 'append' }).targets).toEqual(
      ['claude'],
    );
    expect(
      mergeProfiles(user, project, { strategy: 'replace', arrays: 'replace' }).targets,
    ).toEqual(['claude']);
    expect(mergeProfiles(user, project, { strategy: 'replace', arrays: 'append' }).targets).toEqual(
      ['claude'],
    );
  });

  it('示例 2：user ai.verification [test, lint] + project [typecheck]（habits）', () => {
    const user: HabitsInput = { version: 1, ai: { verification: ['test', 'lint'] } };
    const project: HabitsInput = { version: 1, ai: { verification: ['typecheck'] } };
    expect(
      mergeHabits(user, project, { strategy: 'overlay', arrays: 'append' }).ai?.verification,
    ).toEqual(['test', 'lint', 'typecheck']);
    expect(
      mergeHabits(user, project, { strategy: 'overlay', arrays: 'replace' }).ai?.verification,
    ).toEqual(['typecheck']);
  });
});

describe('strategy × arrays 全组合（表驱动）', () => {
  const strategies: MergeStrategy[] = ['overlay', 'replace'];
  const arrayModes: ArrayMergeMode[] = ['append', 'replace'];

  /** profile 场景：内容型数组 templates + 继承字段 projection.marker_mode + 覆盖字段 skills.copy_mode */
  it.each(strategies.flatMap((strategy) =>
    arrayModes.map((arrays) => ({ strategy, arrays })),
  ))('profile：strategy=$strategy arrays=$arrays', ({ strategy, arrays }) => {
    const user: ProfileInput = {
      version: 1,
      targets: ['opencode'],
      templates: ['base/default'],
      skills: { copy_mode: 'symlink' },
      projection: { marker_mode: 'append_below_marker', line_ending: 'crlf' },
    };
    const project: ProfileInput = {
      version: 1,
      targets: ['claude'],
      templates: ['custom/strict'],
      projection: { line_ending: 'lf' },
    };
    const merged = mergeProfiles(user, project, { strategy, arrays });

    // 内容型数组：overlay+append 追加；其余组合 project 替代
    if (strategy === 'overlay' && arrays === 'append') {
      expect(merged.templates).toEqual(['base/default', 'custom/strict']);
    } else {
      expect(merged.templates).toEqual(['custom/strict']);
    }

    if (strategy === 'overlay') {
      // 深合并：未声明字段继承 user，声明字段被 project 覆盖
      expect(merged.projection?.marker_mode).toBe('append_below_marker');
      expect(merged.projection?.line_ending).toBe('lf');
      expect(merged.skills?.copy_mode).toBe('symlink'); // project 未声明 → 继承
    } else {
      // 浅替换：只保留 project 的键
      expect(merged.projection).toEqual({ line_ending: 'lf' });
      expect(merged.skills).toBeUndefined();
      expect(merged.templates).toEqual(['custom/strict']);
    }
  });

  /** habits 场景：package_managers（内容型数组） + tools.shell（标量覆盖） */
  it.each(strategies.flatMap((strategy) =>
    arrayModes.map((arrays) => ({ strategy, arrays })),
  ))('habits：strategy=$strategy arrays=$arrays', ({ strategy, arrays }) => {
    const user: HabitsInput = {
      version: 1,
      runtime: { package_managers: ['pnpm', 'npm'] },
      tools: { shell: 'powershell', editor: 'code' },
    };
    const project: HabitsInput = {
      version: 1,
      runtime: { package_managers: ['bun'] },
      tools: { shell: 'pwsh' },
    };
    const merged = mergeHabits(user, project, { strategy, arrays });

    if (strategy === 'overlay' && arrays === 'append') {
      expect(merged.runtime?.package_managers).toEqual(['pnpm', 'npm', 'bun']);
    } else {
      expect(merged.runtime?.package_managers).toEqual(['bun']);
    }

    if (strategy === 'overlay') {
      expect(merged.tools).toEqual({ shell: 'pwsh', editor: 'code' }); // 覆盖 + 继承
    } else {
      expect(merged.tools).toEqual({ shell: 'pwsh' }); // 浅替换
    }
  });
});

describe('mergeProfiles 行为细节', () => {
  it('层缺失：project null → user 原样；user null → project 原样；双 null → 空对象', () => {
    const user: ProfileInput = { version: 1, targets: ['claude'], scope: 'user' };
    const project: ProfileInput = { version: 1, targets: ['pi'], scope: 'project' };
    const opts = { strategy: 'overlay', arrays: 'replace' } as const;

    expect(mergeProfiles(user, null, opts)).toEqual(user);
    expect(mergeProfiles(null, project, opts)).toEqual(project);
    expect(mergeProfiles(null, null, opts)).toEqual({});
    expect(mergeProfiles(undefined, undefined, opts)).toEqual({});
  });

  it('mcp.servers：append 串联、replace 替代（内容型数组）', () => {
    const user: ProfileInput = {
      version: 1,
      targets: ['claude'],
      mcp: { servers: [{ name: 'fs', transport: 'stdio' }] },
    };
    const project: ProfileInput = {
      version: 1,
      targets: ['claude'],
      mcp: { servers: [{ name: 'remote', transport: 'http' }] },
    };
    expect(
      mergeProfiles(user, project, { strategy: 'overlay', arrays: 'append' }).mcp.servers?.map(
        (s) => s.name,
      ),
    ).toEqual(['fs', 'remote']);
    expect(
      mergeProfiles(user, project, { strategy: 'overlay', arrays: 'replace' }).mcp.servers?.map(
        (s) => s.name,
      ),
    ).toEqual(['remote']);
  });

  it('skills.always / on_demand 同样受 arrays 控制', () => {
    const user: ProfileInput = {
      version: 1,
      targets: ['claude'],
      skills: { always: ['git'], on_demand: ['docker'] },
    };
    const project: ProfileInput = {
      version: 1,
      targets: ['claude'],
      skills: { always: ['review'] },
    };
    const merged = mergeProfiles(user, project, { strategy: 'overlay', arrays: 'append' });
    expect(merged.skills?.always).toEqual(['git', 'review']);
    expect(merged.skills?.on_demand).toEqual(['docker']); // project 未声明 → 继承
  });

  it('append 不去重（Spec：保持简单）', () => {
    const user: ProfileInput = { version: 1, targets: ['claude'], templates: ['t1'] };
    const project: ProfileInput = { version: 1, targets: ['claude'], templates: ['t1'] };
    expect(
      mergeProfiles(user, project, { strategy: 'overlay', arrays: 'append' }).templates,
    ).toEqual(['t1', 't1']);
  });

  it('嵌套对象逐级递归（tools.git 与 runtime.node 键级合并）', () => {
    const user: ProfileInput = {
      version: 1,
      targets: ['claude'],
      projection: { write_agents_md: true },
    };
    const project: ProfileInput = {
      version: 1,
      targets: ['claude'],
      projection: { write_claude_md: true },
    };
    expect(
      mergeProfiles(user, project, { strategy: 'overlay', arrays: 'replace' }).projection,
    ).toEqual({ write_agents_md: true, write_claude_md: true });
  });

  it('extensions 深合并（用户扩展键逐键覆盖）', () => {
    const user: ProfileInput = {
      version: 1,
      targets: ['claude'],
      extensions: { team: { size: 3 }, org: 'x' },
    };
    const project: ProfileInput = {
      version: 1,
      targets: ['claude'],
      extensions: { team: { size: 5 } },
    };
    expect(
      mergeProfiles(user, project, { strategy: 'overlay', arrays: 'replace' }).extensions,
    ).toEqual({ team: { size: 5 }, org: 'x' });
  });

  it('输入不可变：合并不修改 user / project 原对象', () => {
    const user: ProfileInput = {
      version: 1,
      targets: ['claude'],
      templates: ['u'],
      projection: { marker_mode: 'none' },
    };
    const project: ProfileInput = { version: 1, targets: ['pi'], templates: ['p'] };
    const userSnapshot = structuredClone(user);
    const projectSnapshot = structuredClone(project);

    mergeProfiles(user, project, { strategy: 'overlay', arrays: 'append' });
    mergeProfiles(user, project, { strategy: 'replace', arrays: 'replace' });

    expect(user).toEqual(userSnapshot);
    expect(project).toEqual(projectSnapshot);
  });
});

describe('mergeHabits 行为细节', () => {
  it('runtime 深合并：user 的 node 与 project 的 python 共存', () => {
    const user: HabitsInput = {
      version: 1,
      runtime: { node: { manager: 'fnm', version: 'lts' } },
    };
    const project: HabitsInput = {
      version: 1,
      runtime: { python: { manager: 'uv' } },
    };
    const merged = mergeHabits(user, project, { strategy: 'overlay', arrays: 'replace' });
    expect(merged.runtime).toEqual({
      node: { manager: 'fnm', version: 'lts' },
      python: { manager: 'uv' },
    });
  });

  it('runtime.node 键级覆盖：project 的 version 覆盖，user 的 notes 继承', () => {
    const user: HabitsInput = {
      version: 1,
      runtime: { node: { manager: 'fnm', notes: '团队统一' } },
    };
    const project: HabitsInput = {
      version: 1,
      runtime: { node: { manager: 'fnm', version: '22' } },
    };
    expect(
      mergeHabits(user, project, { strategy: 'overlay', arrays: 'replace' }).runtime?.node,
    ).toEqual({ manager: 'fnm', notes: '团队统一', version: '22' });
  });

  it('detected 快照：project 存在 → 整体以 project 为准（不深合并）', () => {
    const user: HabitsInput = {
      version: 1,
      detected: { node: { manager: 'nvm' }, editor: 'vim' },
    };
    const project: HabitsInput = {
      version: 1,
      detected: { node: { manager: 'fnm' } },
    };
    expect(
      mergeHabits(user, project, { strategy: 'overlay', arrays: 'replace' }).detected,
    ).toEqual({ node: { manager: 'fnm' } });
  });

  it('detected：project 未声明 → 继承 user 快照', () => {
    const user: HabitsInput = { version: 1, detected: { node: { manager: 'nvm' } } };
    const project: HabitsInput = { version: 1, ai: { style: 'concise' } };
    expect(
      mergeHabits(user, project, { strategy: 'overlay', arrays: 'replace' }).detected,
    ).toEqual({ node: { manager: 'nvm' } });
  });

  it('ai.forbid / ai.language 内容型数组合并', () => {
    const user: HabitsInput = {
      version: 1,
      ai: { forbid: ['no-nvm'], language: ['zh-CN'] },
    };
    const project: HabitsInput = { version: 1, ai: { forbid: ['no-pip'], language: ['en'] } };
    const merged = mergeHabits(user, project, { strategy: 'overlay', arrays: 'append' });
    expect(merged.ai?.forbid).toEqual(['no-nvm', 'no-pip']);
    expect(merged.ai?.language).toEqual(['zh-CN', 'en']);
  });

  it('层缺失：project null → user 原样', () => {
    const user: HabitsInput = { version: 1, tools: { shell: 'bash' } };
    expect(mergeHabits(user, null, { strategy: 'overlay', arrays: 'append' })).toEqual(user);
  });
});
