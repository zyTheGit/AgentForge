/**
 * skill 单测（Spec §7.6 / §5.3 / §11.2.6 单元部分）。
 *
 * 覆盖：名字校验、实体 copy（非 symlink：改源不影响副本）、--from 三种
 * 定位方式、目标冲突→3、递归 copy、readSkillsToMaterialize 优先级与
 * fail-fast、listSkills 清单。
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type { EnvSnapshot } from '../../../src/core/env';
import { addSkill, listSkills, readSkillsToMaterialize, validateSkillName } from '../../../src/core/sources/skill';
import { addLocalSource, type SourceManagerContext } from '../../../src/core/sources/manager';
import type { OsContext } from '../../../src/core/paths';
import type { Profile } from '../../../src/schema';
import { ProfileSchema } from '../../../src/schema';
import { createDirAwareHost } from './helpers';

const OS: OsContext = { platform: 'win32' };
const USER_SOT = 'C:\\user-sot';
const PROJECT_ROOT = 'C:\\proj';
const PROJECT_SOT = path.win32.join(PROJECT_ROOT, '.agentforge');
const VENDOR = 'C:\\proj\\vendor-src';

function envFor(): EnvSnapshot {
  return {
    agfHome: USER_SOT,
    agfScope: undefined,
    offline: false,
    lineEnding: undefined,
    ci: false,
    codexHome: undefined,
    userProfile: 'C:\\user',
  };
}

function skillCtx(host: ReturnType<typeof createDirAwareHost>) {
  return {
    host,
    env: envFor(),
    os: OS,
    cwd: PROJECT_ROOT,
    userSoTRoot: USER_SOT,
    projectSoTRoot: PROJECT_SOT,
    targetSoTRoot: PROJECT_SOT,
  };
}

function mgrCtx(host: ReturnType<typeof createDirAwareHost>): SourceManagerContext {
  return { host, env: envFor(), userSoTRoot: USER_SOT, cwd: PROJECT_ROOT };
}

/** 源里放一个 skill：<vendorRoot>/skills/<name>/SKILL.md（+ 可选附属文件）。 */
function seedVendorSkill(
  host: ReturnType<typeof createDirAwareHost>,
  name: string,
  doc: string,
): void {
  host.files.set(path.win32.join(VENDOR, 'skills', name, 'SKILL.md'), doc);
}

describe('validateSkillName', () => {
  it('非法名 → ConfigError(2)', () => {
    for (const bad of ['', 'a/b', 'a\\b', '.hidden', '-lead', '_lead', 'x'.repeat(65)]) {
      expect(() => validateSkillName(bad)).toThrow(expect.objectContaining({ code: 2 }));
    }
  });

  it('合法名通过', () => {
    for (const ok of ['pdf', 'code-review', 'my_skill.2', 'A9']) {
      expect(() => validateSkillName(ok)).not.toThrow();
    }
  });
});

describe('addSkill', () => {
  it('--from 源根路径：copy 到目标层 skills/<name>/，实体副本（改源不影响已安装副本）', async () => {
    const host = createDirAwareHost();
    seedVendorSkill(host, 'pdf', 'V1 说明');

    const result = await addSkill(skillCtx(host), 'pdf', VENDOR);
    expect(result.targetDir).toBe(path.win32.join(PROJECT_SOT, 'skills', 'pdf'));
    expect(result.files).toEqual(['SKILL.md']);
    expect(host.files.get(path.win32.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'))).toBe('V1 说明');

    // 实体 copy（非 symlink）：修改源后目标不变
    host.files.set(path.win32.join(VENDOR, 'skills', 'pdf', 'SKILL.md'), 'V2 修改');
    expect(host.files.get(path.win32.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'))).toBe('V1 说明');
  });

  it('--from skill 目录直连（该目录含 SKILL.md）', async () => {
    const host = createDirAwareHost();
    seedVendorSkill(host, 'pdf', '说明');
    const result = await addSkill(skillCtx(host), 'pdf', path.win32.join(VENDOR, 'skills', 'pdf'));
    expect(result.files).toEqual(['SKILL.md']);
    expect(host.files.has(path.win32.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'))).toBe(true);
  });

  it('--from 登记源 id（local 源）', async () => {
    const host = createDirAwareHost();
    host.files.set(
      path.win32.join(VENDOR, 'manifest.yaml'),
      'name: v\nversion: 1.0.0\nmin_agentforge: 1\n',
    );
    seedVendorSkill(host, 'pdf', '来自源 id');
    await addLocalSource(mgrCtx(host), { path: VENDOR });

    const result = await addSkill(skillCtx(host), 'pdf', 'vendor-src');
    expect(result.fromSourceId).toBe('vendor-src');
    expect(host.files.get(path.win32.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'))).toBe('来自源 id');
  });

  it('缺省 --from：按登记顺序在源中找首个命中', async () => {
    const host = createDirAwareHost();
    seedVendorSkill(host, 'pdf', '缺省扫描');
    await addLocalSource(mgrCtx(host), { path: VENDOR });

    const result = await addSkill(skillCtx(host), 'pdf');
    expect(result.fromSourceId).toBe('vendor-src');
  });

  it('目标 skills/<name>/ 已有内容 → ConflictError(3)', async () => {
    const host = createDirAwareHost();
    seedVendorSkill(host, 'pdf', 'V1');
    host.files.set(path.win32.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'), '已存在');

    await expect(addSkill(skillCtx(host), 'pdf', VENDOR)).rejects.toMatchObject({
      code: 3,
      name: 'ConflictError',
    });
  });

  it('源中不存在该 skill → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    await expect(addSkill(skillCtx(host), 'ghost', VENDOR)).rejects.toMatchObject({ code: 2 });
  });

  it('--from 既非登记 id 也非可用路径 → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    await expect(addSkill(skillCtx(host), 'pdf', 'C:\\nowhere')).rejects.toMatchObject({ code: 2 });
  });

  it('递归 copy：源 skill 含子目录与多文件 → 全部复制（相对路径保留）', async () => {
    const host = createDirAwareHost();
    const base = path.win32.join(VENDOR, 'skills', 'big');
    host.files.set(path.win32.join(base, 'SKILL.md'), 'doc');
    host.files.set(path.win32.join(base, 'assets', 'intro.md'), 'intro');
    host.files.set(path.win32.join(base, 'assets', 'deep', 'x.md'), 'deep');

    const result = await addSkill(skillCtx(host), 'big', VENDOR);
    expect([...result.files].sort()).toEqual(['SKILL.md', 'assets\\deep\\x.md', 'assets\\intro.md'].sort());
    expect(host.files.get(path.win32.join(PROJECT_SOT, 'skills', 'big', 'assets', 'deep', 'x.md'))).toBe('deep');
  });

  it('安装到 user 层目标（targetSoTRoot = user SoT）', async () => {
    const host = createDirAwareHost();
    seedVendorSkill(host, 'pdf', 'user 层');
    const ctx = { ...skillCtx(host), targetSoTRoot: USER_SOT };
    await addSkill(ctx, 'pdf', VENDOR);
    expect(host.files.get(path.win32.join(USER_SOT, 'skills', 'pdf', 'SKILL.md'))).toBe('user 层');
  });
});

describe('readSkillsToMaterialize（§5.3 project > user）', () => {
  function profileWith(always: string[]): Profile {
    return ProfileSchema.parse({
      version: 1,
      targets: ['claude'],
      skills: { always },
    });
  }

  it('project 层 SKILL.md 优先于 user 层同名', async () => {
    const host = createDirAwareHost();
    host.files.set(path.win32.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'), '项目版');
    host.files.set(path.win32.join(USER_SOT, 'skills', 'pdf', 'SKILL.md'), '用户版');

    const artifacts = await readSkillsToMaterialize(host, USER_SOT, PROJECT_SOT, profileWith(['pdf']));
    expect(artifacts).toEqual([{ name: 'pdf', content: '项目版' }]);
  });

  it('project 层缺失时回退 user 层', async () => {
    const host = createDirAwareHost();
    host.files.set(path.win32.join(USER_SOT, 'skills', 'pdf', 'SKILL.md'), '用户版');

    const artifacts = await readSkillsToMaterialize(host, USER_SOT, PROJECT_SOT, profileWith(['pdf']));
    expect(artifacts).toEqual([{ name: 'pdf', content: '用户版' }]);
  });

  it('声明未安装 → ConfigError(2)（fail-fast，同未解析 template id 语义）', async () => {
    const host = createDirAwareHost();
    await expect(
      readSkillsToMaterialize(host, USER_SOT, PROJECT_SOT, profileWith(['ghost'])),
    ).rejects.toMatchObject({ code: 2 });
  });

  it('skills.always 为空 → []', async () => {
    const host = createDirAwareHost();
    expect(await readSkillsToMaterialize(host, USER_SOT, PROJECT_SOT, profileWith([]))).toEqual([]);
  });
});

describe('listSkills', () => {
  it('installed（两层）+ available（源 manifest 清单）', async () => {
    const host = createDirAwareHost();
    host.files.set(path.win32.join(VENDOR, 'manifest.yaml'), [
      'name: v',
      "version: '1.0.0'",
      'min_agentforge: 1',
      'skills:',
      '  - name: pdf',
      '  - name: doc',
      '',
    ].join('\n'));
    await addLocalSource(mgrCtx(host), { path: VENDOR });
    // project 层安装 pdf；user 层安装 excel
    host.files.set(path.win32.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'), 'x');
    host.files.set(path.win32.join(USER_SOT, 'skills', 'excel', 'SKILL.md'), 'y');

    const items = await listSkills(skillCtx(host));
    const pdf = items.find((i) => i.name === 'pdf' && i.status === 'installed');
    expect(pdf?.origin).toBe('project');
    const excel = items.find((i) => i.name === 'excel' && i.status === 'installed');
    expect(excel?.origin).toBe('user');
    const doc = items.find((i) => i.name === 'doc');
    expect(doc).toMatchObject({ status: 'available', origin: 'vendor-src' });
    // 源里 pdf 也声明 → available 条目同时存在
    expect(items.find((i) => i.name === 'pdf' && i.status === 'available')?.origin).toBe('vendor-src');
  });
});
