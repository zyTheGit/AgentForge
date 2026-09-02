/**
 * `skills.on_demand` 的 sync 端行为（Phase 2，Spec §4.2 / §7.6 / §8.3-8.6）。
 *
 * 三件必须钉住的事：
 * 1) 四家 target 的产物形态：`SKILL.md` 落各自的 skills 根、正文带
 *    `disable-model-invocation: true`；codex 额外一个 `agents\openai.yaml` sidecar；
 * 2) **always 逐字节回归守卫**：同一个 SoT 只在 `always` 名单里时，四家的产物内容
 *    与 SoT 原文完全一致（本功能不得渗进 always 的产物）；
 * 3) prune 记账：`always` ↔ `on_demand` 迁移与两张名单都摘掉时，§7.6 的路径口径
 *    能自洽——SKILL.md 路径不变（内容覆盖）、sidecar 该建的建该删的删。
 *
 * 路径一律经 node:path 动态构造（Windows / POSIX CI 均可跑，同 engine.spec）。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEnv } from '../../../src/core/env';
import { currentOs } from '../../../src/core/paths';
import { syncOnce } from '../../../src/core/project/engine';
import { CODEX_SKILL_ON_DEMAND_POLICY } from '../../../src/core/project/projectors/codex';
import { syncMetaPath } from '../../../src/core/project/sync-meta';
import { ON_DEMAND_FRONTMATTER_LINE } from '../../../src/core/sources/skill';
import { createFakeHost, type FakeHost } from '../test-utils';

const OS = currentOs();
const HOME = path.resolve('/home/u');
const CWD = path.resolve('/proj');
const PROJECT_SOT = path.join(CWD, '.agentforge');

/** SoT 里的 SKILL.md 原文（带 frontmatter，四家客户端的最低要求）。 */
const SKILL_DOC = ['---', 'name: lazy', 'description: 备货技能', '---', '', '# Lazy', ''].join(
  '\n',
);

/** 注入按需标记后的期望正文（单一事实源取自实现常量）。 */
const SKILL_DOC_ON_DEMAND = [
  '---',
  'name: lazy',
  'description: 备货技能',
  ON_DEMAND_FRONTMATTER_LINE,
  '---',
  '',
  '# Lazy',
  '',
].join('\n');

/** 四家 target 的 `<name>\SKILL.md` 落点（§2.3 / §8.3-8.6，project scope）。 */
function skillPaths(name: string): Record<string, string> {
  return {
    claude: path.join(CWD, '.claude', 'skills', name, 'SKILL.md'),
    codex: path.join(CWD, '.agents', 'skills', name, 'SKILL.md'),
    opencode: path.join(CWD, '.opencode', 'skills', name, 'SKILL.md'),
    pi: path.join(CWD, '.pi', 'skills', name, 'SKILL.md'),
  };
}

/** codex 的按需 sidecar 落点（其开关不在 frontmatter 而在这里）。 */
function codexPolicyPath(name: string): string {
  return path.join(CWD, '.agents', 'skills', name, 'agents', 'openai.yaml');
}

function createSyncHost(): FakeHost {
  const base = createFakeHost({ USERPROFILE: HOME });
  return {
    ...base,
    async listDir(p) {
      const prefix = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
      const names = new Set<string>();
      for (const key of base.files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (rest === '') {
            continue;
          }
          const sep = rest.search(/[\\/]/);
          names.add(sep === -1 ? rest : rest.slice(0, sep));
        }
      }
      return [...names].sort();
    },
  };
}

/** 写 profile（四家全开）+ habits，并按需布置一个已安装的 skill。 */
async function seed(
  host: FakeHost,
  skills: string,
  options: { readonly install?: boolean } = {},
): Promise<void> {
  await host.writeFile(
    path.join(PROJECT_SOT, 'profile.yaml'),
    ['version: 1', 'scope: project', 'targets: [claude, codex, opencode, pi]', skills, ''].join(
      '\n',
    ),
  );
  await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), 'version: 1\n');
  if (options.install !== false) {
    await host.writeFile(path.join(PROJECT_SOT, 'skills', 'lazy', 'SKILL.md'), SKILL_DOC);
  }
}

function syncOptions(host: FakeHost) {
  return {
    host,
    env: readEnv(host),
    os: OS,
    cwd: CWD,
    agentforgeVersion: 'test-0.1.0',
    dryRun: false,
  };
}

/** 上一轮 sync 记账下来的 write 产物路径集合（§7.6 prune 的输入）。 */
async function recordedArtifacts(host: FakeHost, sotRoot: string = PROJECT_SOT): Promise<string[]> {
  const meta = JSON.parse(await host.readFile(syncMetaPath(sotRoot))) as {
    artifacts?: { path: string }[];
  };
  return (meta.artifacts ?? []).map((item) => item.path).sort();
}

/** 本轮被删掉的整文件产物路径（§7.6 pruned 里 kind=artifact 的那部分）。 */
function prunedArtifacts(result: { pruned: readonly { kind: string; path: string }[] }): string[] {
  return result.pruned.filter((entry) => entry.kind === 'artifact').map((entry) => entry.path);
}

describe('sync × skills.on_demand — 四家 target 的产物形态', () => {
  it('四家都投影正文；正文带按需标记；只有 codex 多一个 sidecar', async () => {
    const host = createSyncHost();
    await seed(host, 'skills:\n  on_demand: [lazy]');

    const result = await syncOnce(syncOptions(host));
    expect(result.skillSkips).toEqual([]);

    for (const file of Object.values(skillPaths('lazy'))) {
      expect(host.files.get(file)).toBe(SKILL_DOC_ON_DEMAND);
    }
    // codex 的开关在 sidecar，其余三家靠 frontmatter（opencode 忽略该键 → doctor 告警）
    expect(host.files.get(codexPolicyPath('lazy'))).toBe(CODEX_SKILL_ON_DEMAND_POLICY);
    expect(
      host.files.has(path.join(CWD, '.claude', 'skills', 'lazy', 'agents', 'openai.yaml')),
    ).toBe(false);

    // 五个 write 产物（四份 SKILL.md + 一个 sidecar）全部进记账，才谈得上后续 prune
    expect(await recordedArtifacts(host)).toEqual(
      [...Object.values(skillPaths('lazy')), codexPolicyPath('lazy')].sort(),
    );
  });

  it('always 回归守卫：同一 SoT 走 always 时，四家产物逐字节等于原文、无 sidecar', async () => {
    const host = createSyncHost();
    await seed(host, 'skills:\n  always: [lazy]');

    await syncOnce(syncOptions(host));

    for (const file of Object.values(skillPaths('lazy'))) {
      expect(host.files.get(file)).toBe(SKILL_DOC);
    }
    expect(host.files.has(codexPolicyPath('lazy'))).toBe(false);
    expect(await recordedArtifacts(host)).toEqual(Object.values(skillPaths('lazy')).sort());
  });

  it('声明但未安装 → sync 成功（不像 always 那样 fail-fast），只记一条 skip', async () => {
    const host = createSyncHost();
    await seed(host, 'skills:\n  on_demand: [lazy]', { install: false });

    const result = await syncOnce(syncOptions(host));
    expect(result.skillSkips).toEqual([
      {
        name: 'lazy',
        reason: 'not-installed',
        detail: [
          path.join(PROJECT_SOT, 'skills', 'lazy', 'SKILL.md'),
          path.join(HOME, '.agentforge', 'skills', 'lazy', 'SKILL.md'),
        ].join(' / '),
      },
    ]);
    expect(host.files.has(skillPaths('lazy').claude ?? '')).toBe(false);
    // 投影本身照常完成（主规则写进去了），skip 不降级为失败
    expect(host.files.has(path.join(CWD, 'CLAUDE.md'))).toBe(true);
  });

  it('on_demand 不进命令薄壳（expose_as_command 的判据仍只认 always）', async () => {
    const host = createSyncHost();
    await seed(host, 'skills:\n  on_demand: [lazy]\n  expose_as_command: [lazy]');

    // expose_as_command 点名的不在 always → 与既有语义一致地 ConfigError(2)
    await expect(syncOnce(syncOptions(host))).rejects.toMatchObject({ code: 2 });
  });
});

describe('sync × skills.on_demand — always ↔ on_demand 迁移的 prune 口径（§7.6）', () => {
  it('always → on_demand：SKILL.md 路径不变（内容被覆盖），sidecar 新建并进记账', async () => {
    const host = createSyncHost();
    await seed(host, 'skills:\n  always: [lazy]');
    await syncOnce(syncOptions(host));
    expect(host.files.get(skillPaths('lazy').codex ?? '')).toBe(SKILL_DOC);

    await seed(host, 'skills:\n  on_demand: [lazy]');
    await syncOnce(syncOptions(host));

    // 同一条路径 → prune 的 keep 集合命中，不会被当成 stale 删掉
    for (const file of Object.values(skillPaths('lazy'))) {
      expect(host.files.get(file)).toBe(SKILL_DOC_ON_DEMAND);
    }
    expect(host.files.get(codexPolicyPath('lazy'))).toBe(CODEX_SKILL_ON_DEMAND_POLICY);
    expect(await recordedArtifacts(host)).toContain(codexPolicyPath('lazy'));
  });

  it('on_demand → always：sidecar 被 prune 删除，SKILL.md 恢复原文', async () => {
    const host = createSyncHost();
    await seed(host, 'skills:\n  on_demand: [lazy]');
    await syncOnce(syncOptions(host));
    expect(host.files.has(codexPolicyPath('lazy'))).toBe(true);

    await seed(host, 'skills:\n  always: [lazy]');
    const result = await syncOnce(syncOptions(host));

    // 上一轮记账里有、本轮 plan 里没有 → §7.6 删除
    expect(host.files.has(codexPolicyPath('lazy'))).toBe(false);
    expect(prunedArtifacts(result)).toContain(codexPolicyPath('lazy'));
    for (const file of Object.values(skillPaths('lazy'))) {
      expect(host.files.get(file)).toBe(SKILL_DOC);
    }
  });

  it('两张名单都摘掉 → 四份 SKILL.md 与 sidecar 全部被 prune', async () => {
    const host = createSyncHost();
    await seed(host, 'skills:\n  on_demand: [lazy]');
    await syncOnce(syncOptions(host));

    await seed(host, 'skills: {}');
    const result = await syncOnce(syncOptions(host));

    for (const file of [...Object.values(skillPaths('lazy')), codexPolicyPath('lazy')]) {
      expect(host.files.has(file)).toBe(false);
      expect(prunedArtifacts(result)).toContain(file);
    }
    expect(await recordedArtifacts(host)).toEqual([]);
  });
});

describe('sync × skills.on_demand — SoT 显式声明非 true 的取值（三态的第三态）', () => {
  it('SKILL.md 里写了 disable-model-invocation: false → 四家都不启用按需，codex 无 sidecar', async () => {
    const host = createSyncHost();
    await seed(host, 'skills:\n  on_demand: [lazy]', { install: false });
    const doc = [
      '---',
      'name: lazy',
      'disable-model-invocation: false',
      '---',
      '',
      '# Lazy',
      '',
    ].join('\n');
    await host.writeFile(path.join(PROJECT_SOT, 'skills', 'lazy', 'SKILL.md'), doc);

    const result = await syncOnce(syncOptions(host));

    // 正文逐字节原样（不覆盖用户的显式取值）
    for (const file of Object.values(skillPaths('lazy'))) {
      expect(host.files.get(file)).toBe(doc);
    }
    // 关键：codex 侧也不能偷偷关掉——否则「claude 仍自动路由 / codex 已关闭」自相矛盾
    expect(host.files.has(codexPolicyPath('lazy'))).toBe(false);
    // 且必须有信号，不能静默
    expect(result.skillSkips).toEqual([
      {
        name: 'lazy',
        reason: 'declared-false',
        detail: path.join(PROJECT_SOT, 'skills', 'lazy', 'SKILL.md'),
      },
    ]);
  });

  it('frontmatter 非法（正文以 --- 水平线开头）→ 正文原样投影并记一条 skip', async () => {
    const host = createSyncHost();
    await seed(host, 'skills:\n  on_demand: [lazy]', { install: false });
    const doc = ['---', '# 标题', '---', '', '正文 key: value', ''].join('\n');
    await host.writeFile(path.join(PROJECT_SOT, 'skills', 'lazy', 'SKILL.md'), doc);

    const result = await syncOnce(syncOptions(host));

    for (const file of Object.values(skillPaths('lazy'))) {
      expect(host.files.get(file)).toBe(doc);
    }
    expect(result.skillSkips[0]?.reason).toBe('invalid-frontmatter');
    // codex 的开关与 frontmatter 无关 → sidecar 照写（按需在 codex 侧仍生效）
    expect(host.files.get(codexPolicyPath('lazy'))).toBe(CODEX_SKILL_ON_DEMAND_POLICY);
  });
});

// ---------------------------------------------------------------------------
// user scope（§2.2 / §8.4-8.6）：落点与 project scope 完全不同，且 codexSkillsRoot
// 的 user 分支只有 plan 层单测碰过 —— sidecar 落点与 prune 迁移需要端到端守卫
// ---------------------------------------------------------------------------

/** user 层 SoT 根（AGF_HOME 未设 → `<home>\.agentforge`）。 */
const USER_SOT = path.join(HOME, '.agentforge');

/** codex 的 user 级根（CODEX_HOME 未设 → `<home>\.codex`）。 */
const CODEX_USER_DIR = path.join(HOME, '.codex');

/** 四家 target 的 user scope `<name>\SKILL.md` 落点（§8.3-8.6）。 */
function userSkillPaths(name: string): Record<string, string> {
  return {
    claude: path.join(HOME, '.claude', 'skills', name, 'SKILL.md'),
    codex: path.join(CODEX_USER_DIR, 'skills', name, 'SKILL.md'),
    opencode: path.join(HOME, '.config', 'opencode', 'skills', name, 'SKILL.md'),
    pi: path.join(HOME, '.pi', 'agent', 'skills', name, 'SKILL.md'),
  };
}

/** user scope 下 codex 的按需 sidecar 落点（`CODEX_HOME\skills\<name>\agents\openai.yaml`）。 */
function userCodexPolicyPath(name: string): string {
  return path.join(CODEX_USER_DIR, 'skills', name, 'agents', 'openai.yaml');
}

/** 只写 user 层（project 层缺席 → effectiveScope 落到 user）。 */
async function seedUser(
  host: FakeHost,
  skills: string,
  options: { readonly install?: boolean } = {},
): Promise<void> {
  await host.writeFile(
    path.join(USER_SOT, 'profile.yaml'),
    ['version: 1', 'scope: user', 'targets: [claude, codex, opencode, pi]', skills, ''].join('\n'),
  );
  await host.writeFile(path.join(USER_SOT, 'habits.yaml'), 'version: 1\n');
  if (options.install !== false) {
    await host.writeFile(path.join(USER_SOT, 'skills', 'lazy', 'SKILL.md'), SKILL_DOC);
  }
}

describe('sync × skills.on_demand — user scope 的落点与逐字节守卫', () => {
  it('effectiveScope=user：四家产物落 user 目录、正文带按需标记、codex sidecar 在 CODEX_HOME 下', async () => {
    const host = createSyncHost();
    await seedUser(host, 'skills:\n  on_demand: [lazy]');

    const result = await syncOnce(syncOptions(host));
    expect(result.scope).toBe('user');
    expect(result.skillSkips).toEqual([]);

    for (const file of Object.values(userSkillPaths('lazy'))) {
      expect(host.files.get(file)).toBe(SKILL_DOC_ON_DEMAND);
    }
    expect(host.files.get(userCodexPolicyPath('lazy'))).toBe(CODEX_SKILL_ON_DEMAND_POLICY);
    // project scope 的落点一个都不该出现（不能把 user 配置写进项目目录，反之亦然）
    for (const file of Object.values(skillPaths('lazy'))) {
      expect(host.files.has(file)).toBe(false);
    }
    expect(await recordedArtifacts(host, USER_SOT)).toEqual(
      expect.arrayContaining([
        ...Object.values(userSkillPaths('lazy')),
        userCodexPolicyPath('lazy'),
      ]),
    );
  });

  it('user scope 的 always 逐字节守卫：四家产物等于 SoT 原文、无 sidecar', async () => {
    const host = createSyncHost();
    await seedUser(host, 'skills:\n  always: [lazy]');

    await syncOnce(syncOptions(host));

    for (const file of Object.values(userSkillPaths('lazy'))) {
      expect(host.files.get(file)).toBe(SKILL_DOC);
    }
    expect(host.files.has(userCodexPolicyPath('lazy'))).toBe(false);
    expect(await recordedArtifacts(host, USER_SOT)).not.toContain(userCodexPolicyPath('lazy'));
  });

  it('user scope 的 on_demand → always 迁移：sidecar 被 prune 删除，SKILL.md 恢复原文', async () => {
    const host = createSyncHost();
    await seedUser(host, 'skills:\n  on_demand: [lazy]');
    await syncOnce(syncOptions(host));
    expect(host.files.has(userCodexPolicyPath('lazy'))).toBe(true);

    await seedUser(host, 'skills:\n  always: [lazy]');
    const result = await syncOnce(syncOptions(host));

    expect(host.files.has(userCodexPolicyPath('lazy'))).toBe(false);
    expect(prunedArtifacts(result)).toContain(userCodexPolicyPath('lazy'));
    for (const file of Object.values(userSkillPaths('lazy'))) {
      expect(host.files.get(file)).toBe(SKILL_DOC);
    }
  });

  it('user scope 未安装 → 只记一条 skip，路径口径为 user 层（不失败）', async () => {
    const host = createSyncHost();
    await seedUser(host, 'skills:\n  on_demand: [lazy]', { install: false });

    const result = await syncOnce(syncOptions(host));
    expect(result.skillSkips).toHaveLength(1);
    expect(result.skillSkips[0]?.reason).toBe('not-installed');
    expect(result.skillSkips[0]?.detail).toContain(
      path.join(USER_SOT, 'skills', 'lazy', 'SKILL.md'),
    );
  });
});
