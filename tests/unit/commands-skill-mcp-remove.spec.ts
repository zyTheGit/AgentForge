/**
 * `aforge skill remove` / `aforge mcp remove` 命令层单测（Spec §6 命令表 / §7.6）。
 *
 * 覆盖两条 remove 的退出码矩阵与不变量：
 * - 0：只改目标层 profile.yaml；`skill remove` **不碰** `skills\<name>\`；
 * - 2：名字非法 / 该层未登记该名字 / 目标层未 init / --scope 非法；
 * - 3：SoT 事务锁被他人持有时 profile 一字未改（remove 全程在锁内改写）；
 * - --scope project|user 只动指定那一层（两层同名可各删一次）；
 * - JSON 结果形态（changed/skillDirKept 恒 true、路径一律绝对）与 `(none)` 渲染。
 *
 * 锁占用构造与 abs() 用法同 commands-init-skill-tx.spec.ts；host helper 用
 * sources/helpers 的目录感知 fake host（remove 的 hint 分支要判目录存在性）。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScopeOption, renderList } from '../../src/commands/_shared';
import { runMcpAdd, runMcpRemove, runSkillRemove } from '../../src/commands/assets';
import { loadProfile } from '../../src/core/config/load';
import { currentOs } from '../../src/core/paths';
import { SYNC_LOCK_DIRNAME, SYNC_LOCK_META_FILE } from '../../src/core/project/sync-lock';
import { createDirAwareHost, type DirAwareHost } from './sources/helpers';
import { abs, errnoError } from './test-utils';

const OS = currentOs();
const HOME = abs('home', 'u');
const PROJECT_ROOT = abs('proj');
const PROJECT_SOT = path.join(PROJECT_ROOT, '.agentforge');
const USER_SOT = path.join(HOME, '.agentforge');
const PROJECT_PROFILE = path.join(PROJECT_SOT, 'profile.yaml');
const USER_PROFILE = path.join(USER_SOT, 'profile.yaml');
const PROJECT_LOCK = path.join(PROJECT_SOT, SYNC_LOCK_DIRNAME);
const PDF_DIR = path.join(PROJECT_SOT, 'skills', 'pdf');

function ctxFor(host: DirAwareHost) {
  return { host, cwd: PROJECT_ROOT, os: OS };
}

/** project 层 profile：两个 always + 两个 mcp server；pdf 已实体安装。 */
const PROJECT_YAML = [
  'version: 1',
  'targets: [claude]',
  'skills:',
  '  always:',
  '    - pdf',
  '    - xlsx',
  'mcp:',
  '  servers:',
  '    - name: fs',
  '      transport: stdio',
  '      command: npx',
  '    - name: web',
  '      transport: http',
  '      url: https://x',
  '',
].join('\n');

/** user 层 profile：同名 pdf + 同名 server fs（验证「只动指定层」）。 */
const USER_YAML = [
  'version: 1',
  'targets: [claude]',
  'skills:',
  '  always:',
  '    - pdf',
  'mcp:',
  '  servers:',
  '    - name: fs',
  '      transport: stdio',
  '      command: npx',
  '',
].join('\n');

function seed(): DirAwareHost {
  const host = createDirAwareHost({ USERPROFILE: HOME });
  host.files.set(PROJECT_PROFILE, PROJECT_YAML);
  host.files.set(USER_PROFILE, USER_YAML);
  host.files.set(path.join(PDF_DIR, 'SKILL.md'), '# pdf\n');
  return host;
}

/** 模拟"另一个进程正持有 project 层 SoT 锁"（acquiredAt 取 host.now() → 恒新鲜）。 */
function seedForeignLock(host: DirAwareHost): void {
  host.files.set(
    path.join(PROJECT_LOCK, SYNC_LOCK_META_FILE),
    JSON.stringify({
      pid: 999_999,
      acquiredAt: host.now().toISOString(),
      token: 'someone-else',
      machine: 'other-machine',
      user: 'other-user',
    }),
  );
}

describe('runSkillRemove（profile-only：磁盘目录保留）', () => {
  it('命中：只摘 skills.always，skills\\<name>\\ 仍在盘上，锁已释放', async () => {
    const host = seed();

    const result = await runSkillRemove(ctxFor(host), 'pdf');

    expect(result).toMatchObject({
      name: 'pdf',
      scope: 'project',
      profileFile: PROJECT_PROFILE,
      always: ['xlsx'],
      changed: true,
      skillDir: PDF_DIR,
      skillDirKept: true,
    });
    expect((await loadProfile(host, PROJECT_SOT))?.skills?.always).toEqual(['xlsx']);
    // 红线：remove 路径不引入任何删除 API
    expect(host.files.has(path.join(PDF_DIR, 'SKILL.md'))).toBe(true);
    expect(await host.exists(PROJECT_LOCK)).toBe(false);
  });

  it('JSON 字段形态：changed/skillDirKept 恒 true，路径一律绝对（§6.2）', async () => {
    const host = seed();

    const result = await runSkillRemove(ctxFor(host), 'pdf');

    expect(result.changed).toBe(true);
    expect(result.skillDirKept).toBe(true);
    expect(path.isAbsolute(result.profileFile)).toBe(true);
    expect(path.isAbsolute(result.skillDir)).toBe(true);
  });

  it('--scope user：只动 user 层；两层同名可各删一次', async () => {
    const host = seed();

    const userResult = await runSkillRemove(ctxFor(host), 'pdf', { scope: 'user' });
    expect(userResult.scope).toBe('user');
    expect(userResult.profileFile).toBe(USER_PROFILE);
    expect((await loadProfile(host, USER_SOT))?.skills?.always).toEqual([]);
    // project 层未受影响
    expect((await loadProfile(host, PROJECT_SOT))?.skills?.always).toEqual(['pdf', 'xlsx']);

    await runSkillRemove(ctxFor(host), 'pdf', { scope: 'project' });
    expect((await loadProfile(host, PROJECT_SOT))?.skills?.always).toEqual(['xlsx']);
  });

  it('该层未登记但目录在盘上 → ConfigError(2)，hint 指向手动删目录', async () => {
    const host = seed();
    // pdf 只在 project 层登记；user 层用同名但未登记的 skill 目录构造 D4 分支
    host.files.set(path.join(USER_SOT, 'skills', 'ppt', 'SKILL.md'), '# ppt\n');

    const rejected = await runSkillRemove(ctxFor(host), 'ppt', { scope: 'user' }).catch(
      (err: unknown) => err,
    );

    expect(rejected).toMatchObject({ code: 2, name: 'ConfigError' });
    expect((rejected as { hint: string }).hint).toContain(path.join(USER_SOT, 'skills', 'ppt'));
    expect((rejected as { hint: string }).hint).toContain('ConflictError(3)');
    expect((rejected as { details: { skillDirExists: boolean } }).details.skillDirExists).toBe(
      true,
    );
  });

  it('该层未登记且目录也不在 → ConfigError(2)，hint 指向 skill list', async () => {
    const host = seed();

    const rejected = await runSkillRemove(ctxFor(host), 'ghost').catch((err: unknown) => err);

    expect(rejected).toMatchObject({ code: 2, name: 'ConfigError' });
    expect((rejected as { hint: string }).hint).toContain('aforge skill list');
    expect((rejected as { details: { skillDirExists: boolean } }).details.skillDirExists).toBe(
      false,
    );
    // 幂等分支不写盘：profile 一字未改
    expect(host.files.get(PROJECT_PROFILE)).toBe(PROJECT_YAML);
  });

  it('非法 skill 名 → ConfigError(2)，且不被锁冲突的 3 抢先（校验在锁外）', async () => {
    const host = seed();
    seedForeignLock(host);

    await expect(runSkillRemove(ctxFor(host), '../evil')).rejects.toMatchObject({ code: 2 });
  });

  it('锁被他人持有 → ConflictError(3)，profile 一字未改', async () => {
    const host = seed();
    seedForeignLock(host);

    await expect(runSkillRemove(ctxFor(host), 'pdf')).rejects.toMatchObject({
      code: 3,
      name: 'ConflictError',
    });
    expect(host.files.get(PROJECT_PROFILE)).toBe(PROJECT_YAML);
  });

  it('目标层未 init（无 profile.yaml）→ ConfigError(2)', async () => {
    const host = createDirAwareHost({ USERPROFILE: HOME });

    await expect(runSkillRemove(ctxFor(host), 'pdf', { scope: 'project' })).rejects.toMatchObject({
      code: 2,
    });
  });
});

describe('runMcpRemove', () => {
  it('命中：摘掉该 server，返回被删条目与该层剩余清单，锁已释放', async () => {
    const host = seed();

    const result = await runMcpRemove(ctxFor(host), 'fs');

    expect(result.scope).toBe('project');
    expect(result.removed).toEqual({
      name: 'fs',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
    });
    expect(result.servers.map((s) => s.name)).toEqual(['web']);
    expect(path.isAbsolute(result.profileFile)).toBe(true);
    expect((await loadProfile(host, PROJECT_SOT))?.mcp?.servers?.map((s) => s.name)).toEqual([
      'web',
    ]);
    expect(await host.exists(PROJECT_LOCK)).toBe(false);
  });

  it('--scope user：只动 user 层；两层同名各删一次', async () => {
    const host = seed();

    const userResult = await runMcpRemove(ctxFor(host), 'fs', { scope: 'user' });
    expect(userResult.scope).toBe('user');
    expect(userResult.servers).toEqual([]);
    expect((await loadProfile(host, PROJECT_SOT))?.mcp?.servers).toHaveLength(2);

    await runMcpRemove(ctxFor(host), 'fs', { scope: 'project' });
    expect((await loadProfile(host, PROJECT_SOT))?.mcp?.servers?.map((s) => s.name)).toEqual([
      'web',
    ]);
  });

  it('该层未登记该名字 → ConfigError(2)，profile 一字未改', async () => {
    const host = seed();

    await expect(runMcpRemove(ctxFor(host), 'ghost')).rejects.toMatchObject({
      code: 2,
      name: 'ConfigError',
    });
    expect(host.files.get(PROJECT_PROFILE)).toBe(PROJECT_YAML);
  });

  it('锁被他人持有 → ConflictError(3)，profile 一字未改', async () => {
    const host = seed();
    seedForeignLock(host);

    await expect(runMcpRemove(ctxFor(host), 'fs')).rejects.toMatchObject({
      code: 3,
      name: 'ConflictError',
    });
    expect(host.files.get(PROJECT_PROFILE)).toBe(PROJECT_YAML);
  });

  it('目标层未 init → ConfigError(2)', async () => {
    const host = createDirAwareHost({ USERPROFILE: HOME });

    await expect(runMcpRemove(ctxFor(host), 'fs', { scope: 'project' })).rejects.toMatchObject({
      code: 2,
    });
  });
});

describe('parseScopeOption（--scope 三态；mcp add 抽取后的回归）', () => {
  it('合法值原样收窄', () => {
    expect(parseScopeOption('project')).toBe('project');
    expect(parseScopeOption('user')).toBe('user');
  });

  it('缺省 → undefined（交由有效 scope 语义解析）', () => {
    expect(parseScopeOption(undefined)).toBeUndefined();
  });

  it('非法值 → ConfigError(2)，绝不静默退化', () => {
    expect(() => parseScopeOption('bogus')).toThrow(expect.objectContaining({ code: 2 }));
    expect(() => parseScopeOption('')).toThrow(expect.objectContaining({ code: 2 }));
    expect(() => parseScopeOption('Project')).toThrow(expect.objectContaining({ code: 2 }));
  });

  it('mcp add 仍按 --scope 写对应层（抽取未改行为）', async () => {
    const host = seed();

    await runMcpAdd(
      ctxFor(host),
      { name: 'extra', transport: 'stdio', command: 'npx' },
      { scope: parseScopeOption('user') },
    );

    expect((await loadProfile(host, USER_SOT))?.mcp?.servers?.map((s) => s.name)).toEqual([
      'fs',
      'extra',
    ]);
    expect((await loadProfile(host, PROJECT_SOT))?.mcp?.servers).toHaveLength(2);
  });
});

describe('renderList（名字列表渲染）', () => {
  it('空列表 → (none)（删空后那一行不会看起来像被截断）', () => {
    expect(renderList([])).toBe('(none)');
  });

  it('非空 → ", " 连接', () => {
    expect(renderList(['a', 'b'])).toBe('a, b');
  });
});

// ---------------------------------------------------------------------------
// D-05：「解析层无、另一层有」时 hint 给出可直接复制的 --scope 值
// ---------------------------------------------------------------------------

describe('层选错了 → hint 给出具体 --scope 值（不是泛化措辞）', () => {
  /** 名字只登记在一层：project 层空壳、user 层有 only-in-user。 */
  function seedOneSided(): DirAwareHost {
    const host = createDirAwareHost({ USERPROFILE: HOME });
    host.files.set(PROJECT_PROFILE, 'version: 1\ntargets: [claude]\n');
    host.files.set(
      USER_PROFILE,
      [
        'version: 1',
        'targets: [claude]',
        'skills:',
        '  always:',
        '    - only-in-user',
        'mcp:',
        '  servers:',
        '    - name: only-in-user',
        '      transport: stdio',
        '      command: npx',
        '',
      ].join('\n'),
    );
    return host;
  }

  it('skill remove：project 层无、user 层有 → hint 含 `--scope user`', async () => {
    const host = seedOneSided();

    const rejected = await runSkillRemove(ctxFor(host), 'only-in-user', {
      scope: 'project',
    }).catch((err: unknown) => err);

    expect(rejected).toMatchObject({ code: 2, name: 'ConfigError' });
    expect((rejected as { hint: string }).hint).toContain('--scope user');
    expect(
      (rejected as { details: { otherScopeHasSkill: boolean } }).details.otherScopeHasSkill,
    ).toBe(true);
  });

  it('skill remove：user 层无、project 层有 → hint 含 `--scope project`（方向对称）', async () => {
    const host = seed(); // project: pdf/xlsx；user: pdf
    // 让 user 层只剩空 always，构造「user 无、project 有 xlsx」
    host.files.set(USER_PROFILE, 'version: 1\ntargets: [claude]\n');

    const rejected = await runSkillRemove(ctxFor(host), 'xlsx', { scope: 'user' }).catch(
      (err: unknown) => err,
    );

    expect((rejected as { hint: string }).hint).toContain('--scope project');
  });

  it('两层都没有 → 退回泛化 hint（不谎报另一层有）', async () => {
    const host = seedOneSided();

    const rejected = await runSkillRemove(ctxFor(host), 'ghost', { scope: 'project' }).catch(
      (err: unknown) => err,
    );

    expect((rejected as { hint: string }).hint).not.toContain('--scope');
    expect((rejected as { hint: string }).hint).toContain('aforge skill list');
  });

  it('mcp remove：project 层无、user 层有 → hint 含 `--scope user`', async () => {
    const host = seedOneSided();

    const rejected = await runMcpRemove(ctxFor(host), 'only-in-user', { scope: 'project' }).catch(
      (err: unknown) => err,
    );

    expect(rejected).toMatchObject({ code: 2, name: 'ConfigError' });
    expect((rejected as { hint: string }).hint).toContain('--scope user');
  });

  it('mcp remove：user 层无、project 层有 → hint 含 `--scope project`（方向对称）', async () => {
    const host = seed(); // project: fs/web；user: fs
    // 让 user 层不再有任何 server，构造「user 无、project 有 web」
    host.files.set(USER_PROFILE, 'version: 1\ntargets: [claude]\n');

    const rejected = await runMcpRemove(ctxFor(host), 'web', { scope: 'user' }).catch(
      (err: unknown) => err,
    );

    expect(rejected).toMatchObject({ code: 2, name: 'ConfigError' });
    expect((rejected as { hint: string }).hint).toContain('--scope project');
  });

  it('mcp remove：两层都没有 → 退回 aforge status 的泛化 hint', async () => {
    const host = seedOneSided();

    const rejected = await runMcpRemove(ctxFor(host), 'ghost', { scope: 'project' }).catch(
      (err: unknown) => err,
    );

    expect((rejected as { hint: string }).hint).toContain('aforge status');
    expect((rejected as { hint: string }).hint).not.toContain('--scope');
  });
});

// ---------------------------------------------------------------------------
// D-04：profile.yaml 打不开 → PermissionError(4)（此前是裸 errno + 退出码 1）
// ---------------------------------------------------------------------------

describe('目标层 profile.yaml 被独占打开 → 退出码 4', () => {
  /**
   * 只对目标 profile.yaml 抛 EBUSY 的 host。
   *
   * 不能无脑让所有 readFile 抛：SoT 事务锁的元数据回读也走 host.readFile，
   * 一并失败会让 acquireSyncLock 先抛 ConflictError(3)，测不到读配置这一段。
   */
  function busyProfileHost(): DirAwareHost {
    const base = seed();
    return {
      ...base,
      async readFile(p: string): Promise<string> {
        if (p === PROJECT_PROFILE) {
          throw errnoError('EBUSY', `EBUSY: resource busy or locked, open '${p}'`);
        }
        return base.readFile(p);
      },
    };
  }

  it('skill remove → PermissionError(4)（JSDoc 的 @throws 契约成立）', async () => {
    await expect(runSkillRemove(ctxFor(busyProfileHost()), 'pdf')).rejects.toMatchObject({
      code: 4,
      name: 'PermissionError',
    });
  });

  it('mcp remove → PermissionError(4)', async () => {
    await expect(runMcpRemove(ctxFor(busyProfileHost()), 'fs')).rejects.toMatchObject({
      code: 4,
      name: 'PermissionError',
    });
  });
});
