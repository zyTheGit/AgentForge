/**
 * skill 单测（Spec §7.6 / §5.3 / §11.2.6）。
 *
 * 覆盖：名字校验、实体 copy（非 symlink：改源不影响副本）、--from 三种
 * 定位方式、目标冲突→3、递归 copy、readSkillsToMaterialize 优先级与
 * fail-fast、listSkills 清单；以及安全边界（§10）：symlink 跳过、环路基准、
 * 深度上限、copy 中途失败回滚。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EnvSnapshot } from '../../../src/core/env';
import { currentOs } from '../../../src/core/paths';
import { addLocalSource, type SourceManagerContext } from '../../../src/core/sources/manager';
import {
  addSkill,
  listSkills,
  MAX_COPY_DEPTH,
  readSkillsToMaterialize,
  validateSkillName,
} from '../../../src/core/sources/skill';
import type { FileStat } from '../../../src/infra/host';
import type { Profile } from '../../../src/schema';
import { ProfileSchema } from '../../../src/schema';
import { abs } from '../test-utils';
import { createDirAwareHost, type DirAwareHost } from './helpers';

// 夹具走宿主平台语义：被测代码（skill / manager）用宿主 path.join / path.resolve 拼
// 内存 fs 的键，夹具必须同语义，否则 posix 上键错位（见 test-utils.abs）。
const USER_SOT = abs('user-sot');
const PROJECT_ROOT = abs('proj');
const PROJECT_SOT = path.join(PROJECT_ROOT, '.agentforge');
const VENDOR = path.join(PROJECT_ROOT, 'vendor-src');

function envFor(): EnvSnapshot {
  return {
    agfHome: USER_SOT,
    agfScope: undefined,
    offline: false,
    lineEnding: undefined,
    ci: false,
    codexHome: undefined,
    userProfile: abs('user'),
  };
}

function skillCtx(host: ReturnType<typeof createDirAwareHost>) {
  return {
    host,
    env: envFor(),
    os: currentOs(),
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
  host.files.set(path.join(VENDOR, 'skills', name, 'SKILL.md'), doc);
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
    expect(result.targetDir).toBe(path.join(PROJECT_SOT, 'skills', 'pdf'));
    expect(result.files).toEqual(['SKILL.md']);
    expect(host.files.get(path.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'))).toBe('V1 说明');

    // 实体 copy（非 symlink）：修改源后目标不变
    host.files.set(path.join(VENDOR, 'skills', 'pdf', 'SKILL.md'), 'V2 修改');
    expect(host.files.get(path.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'))).toBe('V1 说明');
  });

  it('--from skill 目录直连（该目录含 SKILL.md）', async () => {
    const host = createDirAwareHost();
    seedVendorSkill(host, 'pdf', '说明');
    const result = await addSkill(skillCtx(host), 'pdf', path.join(VENDOR, 'skills', 'pdf'));
    expect(result.files).toEqual(['SKILL.md']);
    expect(host.files.has(path.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'))).toBe(true);
  });

  it('--from 登记源 id（local 源）', async () => {
    const host = createDirAwareHost();
    host.files.set(
      path.join(VENDOR, 'manifest.yaml'),
      'name: v\nversion: 1.0.0\nmin_agentforge: 1\n',
    );
    seedVendorSkill(host, 'pdf', '来自源 id');
    await addLocalSource(mgrCtx(host), { path: VENDOR });

    const result = await addSkill(skillCtx(host), 'pdf', 'vendor-src');
    expect(result.fromSourceId).toBe('vendor-src');
    expect(host.files.get(path.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'))).toBe('来自源 id');
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
    host.files.set(path.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'), '已存在');

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
    await expect(addSkill(skillCtx(host), 'pdf', abs('nowhere'))).rejects.toMatchObject({
      code: 2,
    });
  });

  it('递归 copy：源 skill 含子目录与多文件 → 全部复制（相对路径保留）', async () => {
    const host = createDirAwareHost();
    const base = path.join(VENDOR, 'skills', 'big');
    host.files.set(path.join(base, 'SKILL.md'), 'doc');
    host.files.set(path.join(base, 'assets', 'intro.md'), 'intro');
    host.files.set(path.join(base, 'assets', 'deep', 'x.md'), 'deep');

    const result = await addSkill(skillCtx(host), 'big', VENDOR);
    expect([...result.files].sort()).toEqual(
      ['SKILL.md', path.join('assets', 'deep', 'x.md'), path.join('assets', 'intro.md')].sort(),
    );
    expect(host.files.get(path.join(PROJECT_SOT, 'skills', 'big', 'assets', 'deep', 'x.md'))).toBe(
      'deep',
    );
  });

  it('安装到 user 层目标（targetSoTRoot = user SoT）', async () => {
    const host = createDirAwareHost();
    seedVendorSkill(host, 'pdf', 'user 层');
    const ctx = { ...skillCtx(host), targetSoTRoot: USER_SOT };
    await addSkill(ctx, 'pdf', VENDOR);
    expect(host.files.get(path.join(USER_SOT, 'skills', 'pdf', 'SKILL.md'))).toBe('user 层');
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
    host.files.set(path.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'), '项目版');
    host.files.set(path.join(USER_SOT, 'skills', 'pdf', 'SKILL.md'), '用户版');

    const artifacts = await readSkillsToMaterialize(
      host,
      USER_SOT,
      PROJECT_SOT,
      profileWith(['pdf']),
    );
    expect(artifacts).toEqual([{ name: 'pdf', content: '项目版' }]);
  });

  it('project 层缺失时回退 user 层', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(USER_SOT, 'skills', 'pdf', 'SKILL.md'), '用户版');

    const artifacts = await readSkillsToMaterialize(
      host,
      USER_SOT,
      PROJECT_SOT,
      profileWith(['pdf']),
    );
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
    host.files.set(
      path.join(VENDOR, 'manifest.yaml'),
      [
        'name: v',
        "version: '1.0.0'",
        'min_agentforge: 1',
        'skills:',
        '  - name: pdf',
        '  - name: doc',
        '',
      ].join('\n'),
    );
    await addLocalSource(mgrCtx(host), { path: VENDOR });
    // project 层安装 pdf；user 层安装 excel
    host.files.set(path.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'), 'x');
    host.files.set(path.join(USER_SOT, 'skills', 'excel', 'SKILL.md'), 'y');

    const items = await listSkills(skillCtx(host));
    const pdf = items.find((i) => i.name === 'pdf' && i.status === 'installed');
    expect(pdf?.origin).toBe('project');
    const excel = items.find((i) => i.name === 'excel' && i.status === 'installed');
    expect(excel?.origin).toBe('user');
    const doc = items.find((i) => i.name === 'doc');
    expect(doc).toMatchObject({ status: 'available', origin: 'vendor-src' });
    // 源里 pdf 也声明 → available 条目同时存在
    expect(items.find((i) => i.name === 'pdf' && i.status === 'available')?.origin).toBe(
      'vendor-src',
    );
  });
});

// ---------------------------------------------------------------------------
// 安全边界（§10）：symlink 跳过 / 环路基准 / 深度上限 / 失败回滚
// ---------------------------------------------------------------------------

const DIR_STAT: FileStat = {
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
  size: 0,
  mtimeMs: 0,
};

const LINK_STAT: FileStat = {
  isFile: false,
  isDirectory: false,
  isSymbolicLink: true,
  size: 0,
  mtimeMs: 0,
};

/** 包一层 symlink 感知：links 中的路径 lstat 报 isSymbolicLink（stat 仍跟随）。 */
function withSymlinks(host: DirAwareHost, links: readonly string[]): DirAwareHost {
  const linkSet = new Set(links.map((p) => p.toLowerCase()));
  return {
    ...host,
    async lstat(p: string): Promise<FileStat> {
      if (linkSet.has(p.toLowerCase())) {
        return LINK_STAT;
      }
      return host.lstat(p);
    },
  };
}

describe('addSkill 安全边界：symlink / 环路 / 深度', () => {
  it('symlink 项被跳过且不读取内容，作为 skipped 返回（不跟随到 ~/.ssh/id_rsa 之类目标）', async () => {
    const base = createDirAwareHost();
    const skillDir = path.join(VENDOR, 'skills', 'pdf');
    base.files.set(path.join(skillDir, 'SKILL.md'), '正文');
    // 恶意源里的链接项（内容模拟"跟随后会读到的私钥"）
    const link = path.join(skillDir, 'id_rsa-link');
    base.files.set(link, 'PRIVATE KEY');
    const host = withSymlinks(base, [link]);

    const result = await addSkill(skillCtx(host), 'pdf', VENDOR);
    expect(result.files).toEqual(['SKILL.md']);
    expect(result.skipped).toEqual([{ path: link, reason: 'symlink' }]);
    expect(host.files.has(path.join(PROJECT_SOT, 'skills', 'pdf', 'id_rsa-link'))).toBe(false);
  });

  it('目录型 symlink（Windows junction 同）被跳过，不递归进去', async () => {
    const base = createDirAwareHost();
    const skillDir = path.join(VENDOR, 'skills', 'pdf');
    base.files.set(path.join(skillDir, 'SKILL.md'), '正文');
    const linkDir = path.join(skillDir, 'loop');
    base.files.set(path.join(linkDir, 'inner.md'), '不该被复制');
    const host = withSymlinks(base, [linkDir]);

    const result = await addSkill(skillCtx(host), 'pdf', VENDOR);
    expect(result.files).toEqual(['SKILL.md']);
    expect(result.skipped).toEqual([{ path: linkDir, reason: 'symlink' }]);
    expect(host.files.has(path.join(PROJECT_SOT, 'skills', 'pdf', 'loop', 'inner.md'))).toBe(false);
  });

  it('环路基准：子项解析回已访问目录（非 symlink 路径）→ 记为 cycle 并跳过', async () => {
    const base = createDirAwareHost();
    const skillDir = path.join(VENDOR, 'skills', 'pdf');
    const sub = path.join(skillDir, 'sub');
    base.files.set(path.join(skillDir, 'SKILL.md'), '正文');
    base.files.set(path.join(sub, 'a.md'), 'a');
    const norm = (p: string): string => path.normalize(p).toLowerCase();
    const host: DirAwareHost = {
      ...base,
      async listDir(p: string): Promise<string[]> {
        // sub 目录里多出一个指回父目录的项（path.join 后规范化回 skillDir）
        return norm(p) === norm(sub) ? ['a.md', '..'] : base.listDir(p);
      },
      async lstat(p: string): Promise<FileStat> {
        return norm(p) === norm(skillDir) ? DIR_STAT : base.lstat(p);
      },
    };

    const result = await addSkill(skillCtx(host), 'pdf', VENDOR);
    expect(result.files.sort()).toEqual(['SKILL.md', path.join('sub', 'a.md')]);
    expect(result.skipped).toEqual([{ path: skillDir, reason: 'cycle' }]);
  });

  it(`深度超过 ${MAX_COPY_DEPTH} 层 → ConfigError(2)，并回滚本次新建的目标目录`, async () => {
    const host = createDirAwareHost();
    const segments = Array.from({ length: MAX_COPY_DEPTH + 2 }, (_, i) => `d${i}`);
    host.files.set(path.join(VENDOR, 'skills', 'deep', ...segments, 'SKILL.md'), '深处的文件');

    await expect(addSkill(skillCtx(host), 'deep', VENDOR)).rejects.toMatchObject({ code: 2 });
    const targetPrefix = path.join(PROJECT_SOT, 'skills', 'deep');
    expect([...host.files.keys()].filter((k) => k.startsWith(targetPrefix))).toEqual([]);
  });
});

describe('addSkill 失败清理（不留残骸挡死下次安装）', () => {
  /** 写入指定文件名时失败一次的 host（模拟 copy 中途 IO 失败）。 */
  function createFlakyHost(failOnce: { file: string }): DirAwareHost {
    const base = createDirAwareHost();
    let armed = true;
    return {
      ...base,
      async writeFile(p: string, content: string): Promise<void> {
        if (armed && p.includes(failOnce.file)) {
          armed = false;
          throw new Error(`模拟写入失败: ${p}`);
        }
        return base.writeFile(p, content);
      },
    };
  }

  it('copy 中途失败 → 目标目录整体回滚，重试 skill add 不再被 ConflictError(3) 拦死', async () => {
    const host = createFlakyHost({ file: 'b.md' });
    const skillDir = path.join(VENDOR, 'skills', 'pdf');
    host.files.set(path.join(skillDir, 'a.md'), 'a');
    host.files.set(path.join(skillDir, 'b.md'), 'b');
    host.files.set(path.join(skillDir, 'SKILL.md'), 'doc');

    await expect(addSkill(skillCtx(host), 'pdf', VENDOR)).rejects.toThrow(/模拟写入失败/);
    const targetPrefix = path.join(PROJECT_SOT, 'skills', 'pdf');
    expect([...host.files.keys()].filter((k) => k.startsWith(targetPrefix))).toEqual([]);

    // 残留已清理 → 重试成功（修复前这里会因目标非空抛 ConflictError(3)）
    const retry = await addSkill(skillCtx(host), 'pdf', VENDOR);
    expect(retry.files).toEqual(['SKILL.md', 'a.md', 'b.md'].sort());
  });

  it('目标目录已存在但为空：失败仍清空内容（冲突判据与回滚判据同源）', async () => {
    // 回归：冲突判定用 listDirSafe().length（空目录放行），回滚却用 exists()
    // （空目录为真 → 跳过回滚），半装内容留在原地把下次 skill add 永久挡死。
    const host = createFlakyHost({ file: 'b.md' });
    const skillDir = path.join(VENDOR, 'skills', 'pdf');
    host.files.set(path.join(skillDir, 'a.md'), 'a');
    host.files.set(path.join(skillDir, 'b.md'), 'b');
    host.files.set(path.join(skillDir, 'SKILL.md'), 'doc');

    const targetDir = path.join(PROJECT_SOT, 'skills', 'pdf');
    expect(await host.mkdirExclusive(targetDir)).toBe(true); // 预先存在的空目录
    expect(await host.exists(targetDir)).toBe(true);

    await expect(addSkill(skillCtx(host), 'pdf', VENDOR)).rejects.toThrow(/模拟写入失败/);
    expect([...host.files.keys()].filter((k) => k.startsWith(targetDir))).toEqual([]);

    const retry = await addSkill(skillCtx(host), 'pdf', VENDOR);
    expect(retry.files).toEqual(['SKILL.md', 'a.md', 'b.md'].sort());
  });
});
