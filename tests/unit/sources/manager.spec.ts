/**
 * sources manager 单测（Spec §4.4 / §7.6 / §7.8 / §11.2.7 单元部分）。
 *
 * 覆盖：deriveSourceId、addLocal 校验与登记、addGit 离线→5 / 缺 ref→2 /
 * git 失败→1 / 成功 pin（调用序列）、update 离线→5、remove 删登记+缓存、
 * manifest 解析；以及安全边界（§10）：显式 --id 与 sources.json 读入项的
 * 越界 id 拒绝、store 边界断言、git url/ref 参数注入拒绝。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EnvSnapshot } from '../../../src/core/env';
import { ConfigError } from '../../../src/core/errors';
import {
  addGitSource,
  addLocalSource,
  assertGitRef,
  assertGitUrl,
  assertNotOptionLike,
  assertSourceId,
  assertWithinStore,
  deriveSourceId,
  listSources,
  loadSourceManifest,
  removeSource,
  type SourceManagerContext,
  sourceStoreDir,
  updateSource,
} from '../../../src/core/sources/manager';
import type { Source } from '../../../src/schema';
import { createDirAwareHost } from './helpers';

const USER_SOT = 'C:\\user-sot';
const CWD = 'C:\\proj';

function ctxFor(
  host: ReturnType<typeof createDirAwareHost>,
  envOverrides: Partial<EnvSnapshot> = {},
): SourceManagerContext {
  return {
    host,
    env: {
      agfHome: USER_SOT,
      agfScope: undefined,
      offline: false,
      lineEnding: undefined,
      ci: false,
      codexHome: undefined,
      userProfile: 'C:\\user',
      ...envOverrides,
    },
    userSoTRoot: USER_SOT,
    cwd: CWD,
  };
}

/**
 * 取登记表首项（缺失 → 显式失败）。
 *
 * 用于替代 `(await listSources(ctx))[0]!`：非空断言会让"登记表意外为空"退化成
 * 后续断言的空指针错误，这里先 toBeDefined 断言再收窄类型，失败信息可读。
 */
async function firstSource(ctx: SourceManagerContext): Promise<Source> {
  const first = (await listSources(ctx))[0];
  expect(first).toBeDefined();
  if (first === undefined) {
    throw new Error('sources.json 应至少登记一项源');
  }
  return first;
}

describe('deriveSourceId', () => {
  it('url basename 去 .git 后小写化；非法字符（含 .）压成 -', () => {
    expect(deriveSourceId('https://github.com/User/Repo.git')).toBe('repo');
    expect(deriveSourceId('https://example.com/Pkg.A')).toBe('pkg-a');
  });

  it('非法字符压缩为 -，前后缀 - 剥离', () => {
    expect(deriveSourceId('https://example.com/My Fancy Repo')).toBe('my-fancy-repo');
  });

  it('本地 Windows 路径取末段', () => {
    expect(deriveSourceId('C:\\sources\\My Source')).toBe('my-source');
  });

  it('不满足 id 正则（如单字符 a）→ 抛 ConfigError(2)，要求用户显式指定 --id', () => {
    // 'a' 长度 1 不满足 {1,63} 起始后至少 1 字符 → 总长 ≥2
    const derive = (): string => deriveSourceId('https://example.com/a.git');
    expect(derive).toThrow(ConfigError);

    let caught: unknown;
    try {
      derive();
    } catch (err) {
      caught = err;
    }
    // instanceof 收窄（不用 as any）：code / message / hint 三项断言强度不变
    expect(caught).toBeInstanceOf(ConfigError);
    if (!(caught instanceof ConfigError)) {
      throw new Error('deriveSourceId 应抛出 ConfigError');
    }
    expect(caught.code).toBe(2);
    expect(caught.message).toContain('无法从路径派生合法的源 id');
    expect(caught.hint).toContain('--id');
  });

  it('同一 URL 多次调用产生相同 id（确定性，非随机）', () => {
    const url = 'https://github.com/user/repo.git';
    const id1 = deriveSourceId(url);
    const id2 = deriveSourceId(url);
    expect(id1).toBe(id2);
    expect(id1).toBe('repo');
  });
});

describe('addLocalSource', () => {
  it('路径不存在 → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    await expect(addLocalSource(ctxFor(host), { path: 'C:\\missing' })).rejects.toMatchObject({
      code: 2,
    });
  });

  it('登记 {type:"local", path 绝对化} 到 user 层 sources.json（相对路径按 cwd 解析）', async () => {
    const host = createDirAwareHost();
    host.files.set('C:\\proj\\vendor-src\\manifest.yaml', 'version: 1\n');
    const result = await addLocalSource(ctxFor(host), { path: 'vendor-src' });

    expect(result.source).toMatchObject({
      id: 'vendor-src',
      type: 'local',
      path: 'C:\\proj\\vendor-src',
      enabled: true,
      kind: [],
    });
    expect(result.file).toBe(path.win32.join(USER_SOT, 'sources.json'));
    const registry = JSON.parse(host.files.get(result.file) ?? '');
    expect(registry.version).toBe(1);
    expect(registry.sources).toHaveLength(1);
  });

  it('id 重复 → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    host.files.set('C:\\proj\\vendor-src\\manifest.yaml', 'version: 1\n');
    await addLocalSource(ctxFor(host), { path: 'vendor-src' });
    await expect(addLocalSource(ctxFor(host), { path: 'vendor-src' })).rejects.toMatchObject({
      code: 2,
    });
  });
});

describe('addGitSource', () => {
  const URL = 'https://example.com/team/rules.git';

  it('AGF_OFFLINE=1 → OfflineError(5)（§7.8 / §11.2.7）', async () => {
    const host = createDirAwareHost({ AGF_OFFLINE: '1' });
    await expect(
      addGitSource(ctxFor(host, { offline: true }), { url: URL, ref: 'v1.0.0' }),
    ).rejects.toMatchObject({ code: 5, name: 'OfflineError' });
  });

  it('缺 --ref → ConfigError(2)（§4.4 默认要求显式 ref）', async () => {
    const host = createDirAwareHost();
    await expect(addGitSource(ctxFor(host), { url: URL })).rejects.toMatchObject({ code: 2 });
    await expect(addGitSource(ctxFor(host), { url: URL, ref: '  ' })).rejects.toMatchObject({
      code: 2,
    });
  });

  it('git clone 失败 → GenericError(1)', async () => {
    const host = createDirAwareHost(
      {},
      { clone: { stdout: '', stderr: 'fatal: not found', code: 128 } },
    );
    await expect(addGitSource(ctxFor(host), { url: URL, ref: 'v1.0.0' })).rejects.toMatchObject({
      code: 1,
      name: 'GenericError',
    });
  });

  it('成功：clone→fetch ref→checkout FETCH_HEAD→rev-parse 序列 + commit 记录 pin', async () => {
    const host = createDirAwareHost();
    const result = await addGitSource(ctxFor(host), { url: URL, ref: 'v1.2.0' });

    expect(result.source).toMatchObject({
      id: 'rules',
      type: 'git',
      url: URL,
      ref: 'v1.2.0',
      commit: 'abc123def456',
      enabled: true,
    });
    expect(result.storeDir).toBe(sourceStoreDir(ctxFor(host), 'rules'));

    // git 调用序列（§7.6 pin 流程）
    const calls = host.gitCalls;
    expect(calls.map((c) => c.args[0])).toEqual(['clone', 'fetch', 'checkout', 'rev-parse']);
    // 位置参数前的 `--` 为参数注入纵深防御（§10）
    expect(calls[0]?.args).toEqual(['clone', '--depth', '1', '--', URL, result.storeDir]);
    expect(calls[1]?.args).toEqual(['fetch', '--depth', '1', 'origin', 'v1.2.0']);
    expect(calls[1]?.cwd).toBe(result.storeDir);
    expect(calls[2]?.args).toEqual(['checkout', '--detach', 'FETCH_HEAD']);
    expect(calls[3]?.args).toEqual(['rev-parse', 'HEAD']);

    // sources.json 登记
    const registry = JSON.parse(host.files.get(path.win32.join(USER_SOT, 'sources.json')) ?? '');
    expect(registry.sources[0]).toMatchObject({ id: 'rules', type: 'git', ref: 'v1.2.0' });
  });

  it('id 重复 → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    await addGitSource(ctxFor(host), { url: URL, ref: 'v1.0.0' });
    await expect(
      addGitSource(ctxFor(host), { url: 'https://example.com/other/rules.git', ref: 'v2' }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it('孤儿缓存清理：store/<id> 下残留文件在重新 add 前被删除', async () => {
    const host = createDirAwareHost();
    const stale = path.win32.join(sourceStoreDir(ctxFor(host), 'rules'), 'stale.txt');
    host.files.set(stale, '旧缓存');
    await addGitSource(ctxFor(host), { url: URL, ref: 'v1.0.0' });
    expect(host.files.has(stale)).toBe(false);
  });
});

describe('updateSource', () => {
  it('id 不存在 → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    await expect(updateSource(ctxFor(host), 'nope')).rejects.toMatchObject({ code: 2 });
  });

  it('local 源无远端可更新 → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    host.files.set('C:\\proj\\vendor-src\\manifest.yaml', 'version: 1\n');
    await addLocalSource(ctxFor(host), { path: 'vendor-src' });
    await expect(updateSource(ctxFor(host), 'vendor-src')).rejects.toMatchObject({ code: 2 });
  });

  it('AGF_OFFLINE=1 → OfflineError(5)（§7.8 source update 失败码 5）', async () => {
    const host = createDirAwareHost();
    await addGitSource(ctxFor(host), { url: 'https://example.com/rules.git', ref: 'v1' });
    await expect(updateSource(ctxFor(host, { offline: true }), 'rules')).rejects.toMatchObject({
      code: 5,
      name: 'OfflineError',
    });
  });

  it('成功：fetch pinned ref → checkout FETCH_HEAD（前进语义）→ rev-parse 刷新 commit', async () => {
    const host = createDirAwareHost();
    const ctx = ctxFor(host);
    await addGitSource(ctx, { url: 'https://example.com/rules.git', ref: 'v1' });
    // fake exec 不产生 clone 产物——补一个 store 文件模拟 clone 结果
    host.files.set(path.win32.join(sourceStoreDir(ctx, 'rules'), '.git', 'HEAD'), 'ref: main\n');
    host.gitCalls.length = 0;

    const result = await updateSource(ctx, 'rules');
    expect(result.commit).toBe('abc123def456');
    const calls = host.gitCalls;
    expect(calls.map((c) => c.args[0])).toEqual(['fetch', 'checkout', 'rev-parse']);
    expect(calls[0]?.args).toEqual(['fetch', '--depth', '1', 'origin', 'v1']);
    expect(calls[1]?.args).toEqual(['checkout', '--detach', 'FETCH_HEAD']);
  });

  it('store 缓存缺失 → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    const ctx = ctxFor(host);
    await addGitSource(ctx, { url: 'https://example.com/rules.git', ref: 'v1' });
    // 手工清空 store（模拟缓存丢失；fake exec 本就不产生 clone 产物）
    const storePrefix = path.win32.join(USER_SOT, 'store');
    for (const key of [...host.files.keys()]) {
      if (key.startsWith(storePrefix)) {
        host.files.delete(key);
      }
    }
    await expect(updateSource(ctx, 'rules')).rejects.toMatchObject({ code: 2 });
  });
});

describe('removeSource', () => {
  it('id 不存在 → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    await expect(removeSource(ctxFor(host), 'nope')).rejects.toMatchObject({ code: 2 });
  });

  it('git 源：删登记 + 删除 store/<id> 缓存（M8 决策：缓存随登记回收）', async () => {
    const host = createDirAwareHost();
    await addGitSource(ctxFor(host), { url: 'https://example.com/rules.git', ref: 'v1' });
    const cached = path.win32.join(sourceStoreDir(ctxFor(host), 'rules'), 'templates', 'a.md');
    host.files.set(cached, '模板内容');

    const result = await removeSource(ctxFor(host), 'rules');
    expect(result.removed.type).toBe('git');
    expect(result.storeDir).toBe(sourceStoreDir(ctxFor(host), 'rules'));
    expect(host.files.has(cached)).toBe(false);

    // 登记已清空
    expect(await listSources(ctxFor(host))).toEqual([]);
  });

  it('local 源：仅删登记，不动源目录文件', async () => {
    const host = createDirAwareHost();
    host.files.set('C:\\proj\\vendor-src\\manifest.yaml', 'version: 1\n');
    await addLocalSource(ctxFor(host), { path: 'vendor-src' });
    await removeSource(ctxFor(host), 'vendor-src');
    expect(host.files.has('C:\\proj\\vendor-src\\manifest.yaml')).toBe(true);
    expect(await listSources(ctxFor(host))).toEqual([]);
  });
});

describe('loadSourceManifest', () => {
  it('源无 manifest.yaml → null（非错误）', async () => {
    const host = createDirAwareHost();
    host.files.set('C:\\proj\\vendor-src\\skill.txt', 'x');
    const ctx = ctxFor(host);
    await addLocalSource(ctx, { path: 'vendor-src' });
    const source = await firstSource(ctx);
    expect(await loadSourceManifest(ctx, source)).toBeNull();
  });

  it('合法 manifest（§4.5：name/version/min_agentforge/templates/skills）→ 解析为对象', async () => {
    const host = createDirAwareHost();
    host.files.set(
      path.win32.join('C:\\proj\\vendor-src', 'manifest.yaml'),
      [
        'name: vendor-pack',
        "version: '1.0.0'",
        'min_agentforge: 1',
        'templates:',
        '  - id: team/review',
        '    path: templates/review.md',
        '    description: review rules',
        'skills:',
        '  - name: pdf',
        '    description: pdf skill',
        '',
      ].join('\n'),
    );
    const ctx = ctxFor(host);
    await addLocalSource(ctx, { path: 'vendor-src' });
    const source = await firstSource(ctx);
    const manifest = await loadSourceManifest(ctx, source);
    expect(manifest?.name).toBe('vendor-pack');
    expect(manifest?.version).toBe('1.0.0');
    expect(manifest?.templates).toEqual([
      { id: 'team/review', path: 'templates/review.md', description: 'review rules' },
    ]);
    expect(manifest?.skills).toEqual([{ name: 'pdf', description: 'pdf skill' }]);
  });

  it('非法 YAML → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    host.files.set(path.win32.join('C:\\proj\\vendor-src', 'manifest.yaml'), 'name: [unclosed');
    const ctx = ctxFor(host);
    await addLocalSource(ctx, { path: 'vendor-src' });
    const source = await firstSource(ctx);
    await expect(loadSourceManifest(ctx, source)).rejects.toMatchObject({ code: 2 });
  });

  it('schema 校验失败（缺必填 name）→ ConfigError(2)', async () => {
    const host = createDirAwareHost();
    host.files.set(
      path.win32.join('C:\\proj\\vendor-src', 'manifest.yaml'),
      "version: '1.0.0'\nmin_agentforge: 1\n",
    );
    const ctx = ctxFor(host);
    await addLocalSource(ctx, { path: 'vendor-src' });
    const source = await firstSource(ctx);
    await expect(loadSourceManifest(ctx, source)).rejects.toMatchObject({ code: 2 });
  });
});

// ---------------------------------------------------------------------------
// 安全边界（§10）：越界 id / 参数注入
// ---------------------------------------------------------------------------

describe('assertSourceId', () => {
  it('合法 id 通过', () => {
    for (const ok of ['rules', 'my-source', 'a1_b-c', 'x9']) {
      expect(() => assertSourceId(ok)).not.toThrow();
    }
  });

  it('路径穿越 / 分隔符 / 大写 / 单字符 / 前导连字符 → ConfigError(2)', () => {
    for (const bad of [
      '../../evil',
      '..\\..\\evil',
      'a/b',
      'a\\b',
      '..',
      'Rules',
      'x',
      '-lead',
      '_lead',
      '',
      `${'a'.repeat(65)}`,
    ]) {
      expect(() => assertSourceId(bad)).toThrow(expect.objectContaining({ code: 2 }));
    }
  });
});

describe('assertWithinStore / assertNotOptionLike / assertGitUrl / assertGitRef（统一导出后直测）', () => {
  const ctx = (): SourceManagerContext => ctxFor(createDirAwareHost());
  const storeRoot = path.win32.join(USER_SOT, 'store');

  it('assertWithinStore：store 内子目录通过；根本身 / 兄弟前缀目录 / 越界 → ConfigError(2)', () => {
    expect(() => assertWithinStore(ctx(), path.win32.join(storeRoot, 'rules'))).not.toThrow();
    expect(() =>
      assertWithinStore(ctx(), path.win32.join(storeRoot, 'rules', 'nested')),
    ).not.toThrow();
    for (const bad of [
      storeRoot, // 不允许整体回收
      `${storeRoot}-evil`, // 裸 startsWith 会放过的兄弟目录
      path.win32.join(storeRoot, '..', 'evil'),
      'C:\\evil',
    ]) {
      expect(() => assertWithinStore(ctx(), bad)).toThrow(expect.objectContaining({ code: 2 }));
    }
  });

  it('assertNotOptionLike：`-` 前缀 → ConfigError(2)（git 在位置参数后仍解析选项）', () => {
    expect(() => assertNotOptionLike('v1.2.0', 'git ref')).not.toThrow();
    expect(() => assertNotOptionLike('--upload-pack=calc.exe', 'git ref')).toThrow(
      expect.objectContaining({ code: 2 }),
    );
  });

  it('assertGitUrl：空 / `-` 前缀 → ConfigError(2)', () => {
    expect(() => assertGitUrl('https://example.com/repo.git')).not.toThrow();
    for (const bad of ['', '   ', '--upload-pack=calc.exe', '-x']) {
      expect(() => assertGitUrl(bad)).toThrow(expect.objectContaining({ code: 2 }));
    }
  });

  it('assertGitRef：白名单外字符（空格 / : / ^ / ~）与 `-` 前缀 → ConfigError(2)', () => {
    for (const ok of ['main', 'v1.2.0', 'release/1.x', 'a'.repeat(255)]) {
      expect(() => assertGitRef(ok)).not.toThrow();
    }
    for (const bad of ['-x', 'a b', 'HEAD^', 'HEAD~1', 'refs:x', '', 'a'.repeat(256)]) {
      expect(() => assertGitRef(bad)).toThrow(expect.objectContaining({ code: 2 }));
    }
  });
});

describe('显式 --id 不绕过 id 校验（越界删除 / 越界写入防线）', () => {
  it('addLocalSource --id ../../evil → ConfigError(2)，不产生登记', async () => {
    const host = createDirAwareHost();
    host.files.set('C:\\proj\\vendor-src\\manifest.yaml', 'version: 1\n');
    await expect(
      addLocalSource(ctxFor(host), { path: 'vendor-src', id: '../../evil' }),
    ).rejects.toMatchObject({ code: 2 });
    expect(host.files.has(path.win32.join(USER_SOT, 'sources.json'))).toBe(false);
  });

  it('addGitSource --id ..\\..\\evil → ConfigError(2)，不发起任何 git 调用（不越界 clone/删除）', async () => {
    const host = createDirAwareHost();
    const outsider = 'C:\\evil\\keep.txt';
    host.files.set(outsider, '不该被删');
    await expect(
      addGitSource(ctxFor(host), {
        url: 'https://example.com/rules.git',
        ref: 'v1',
        id: '..\\..\\evil',
      }),
    ).rejects.toMatchObject({ code: 2 });
    expect(host.gitCalls).toHaveLength(0);
    expect(host.files.has(outsider)).toBe(true);
  });

  it('sourceStoreDir 对越界 id 直接抛 ConfigError(2)（路径计算入口即拦截）', () => {
    const host = createDirAwareHost();
    expect(() => sourceStoreDir(ctxFor(host), '../../evil')).toThrow(
      expect.objectContaining({ code: 2 }),
    );
  });
});

describe('sources.json 读入项逐项校验（手工编辑 / 恶意登记表）', () => {
  /** 手工写入一张含越界 id 的登记表。 */
  function seedTamperedRegistry(host: ReturnType<typeof createDirAwareHost>, id: string): void {
    host.files.set(
      path.win32.join(USER_SOT, 'sources.json'),
      `${JSON.stringify(
        {
          version: 1,
          sources: [
            { id, type: 'git', url: 'https://example.com/x.git', ref: 'v1', commit: 'abc' },
          ],
        },
        null,
        2,
      )}\n`,
    );
  }

  it('listSources 读到越界 id → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    seedTamperedRegistry(host, '../../evil');
    await expect(listSources(ctxFor(host))).rejects.toMatchObject({ code: 2 });
  });

  it('removeSource 在越界 id 上不执行任何删除（store 外文件保留）', async () => {
    const host = createDirAwareHost();
    const outsider = 'C:\\evil\\keep.txt';
    host.files.set(outsider, '不该被删');
    seedTamperedRegistry(host, '..\\..\\evil');
    await expect(removeSource(ctxFor(host), '..\\..\\evil')).rejects.toMatchObject({ code: 2 });
    expect(host.files.has(outsider)).toBe(true);
  });

  it('updateSource 在越界 id 上不发起 git 调用', async () => {
    const host = createDirAwareHost();
    seedTamperedRegistry(host, '../../evil');
    await expect(updateSource(ctxFor(host), '../../evil')).rejects.toMatchObject({ code: 2 });
    expect(host.gitCalls).toHaveLength(0);
  });
});

describe('git 参数注入防护（§10）', () => {
  const URL = 'https://example.com/team/rules.git';

  it('--ref 以 - 开头（--upload-pack=<cmd>）→ ConfigError(2)，不发起任何 git 调用', async () => {
    const host = createDirAwareHost();
    await expect(
      addGitSource(ctxFor(host), { url: URL, ref: '--upload-pack=calc.exe' }),
    ).rejects.toMatchObject({ code: 2 });
    expect(host.gitCalls).toHaveLength(0);
  });

  it('ref 含白名单外字符（空格 / : / ^）→ ConfigError(2)', async () => {
    const host = createDirAwareHost();
    for (const ref of ['v1 v2', 'refs/heads/main:evil', 'HEAD^{}', 'a"b']) {
      await expect(addGitSource(ctxFor(host), { url: URL, ref })).rejects.toMatchObject({
        code: 2,
      });
    }
    expect(host.gitCalls).toHaveLength(0);
  });

  it('合法 ref（tag / 分支路径 / sha）通过白名单', async () => {
    for (const ref of ['v1.2.0', 'refs/heads/main', 'a1b2c3d4e5f6', 'feature/x-y_z']) {
      const host = createDirAwareHost();
      await expect(
        addGitSource(ctxFor(host), { url: URL, ref, id: 'rules' }),
      ).resolves.toMatchObject({ source: { ref } });
    }
  });

  it('url 以 - 开头 → ConfigError(2)，不发起任何 git 调用', async () => {
    const host = createDirAwareHost();
    await expect(
      addGitSource(ctxFor(host), { url: '--upload-pack=calc.exe', ref: 'v1', id: 'rules' }),
    ).rejects.toMatchObject({ code: 2 });
    expect(host.gitCalls).toHaveLength(0);
  });

  it('update：sources.json 中被篡改成 - 开头的 ref → ConfigError(2)，不发起 git 调用', async () => {
    const host = createDirAwareHost();
    host.files.set(
      path.win32.join(USER_SOT, 'sources.json'),
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: 'rules',
            type: 'git',
            url: URL,
            ref: '--upload-pack=calc.exe',
            commit: 'abc123def456',
          },
        ],
      })}\n`,
    );
    host.files.set(path.win32.join(sourceStoreDir(ctxFor(host), 'rules'), '.git', 'HEAD'), 'x');
    await expect(updateSource(ctxFor(host), 'rules')).rejects.toMatchObject({ code: 2 });
    expect(host.gitCalls).toHaveLength(0);
  });
});
