/**
 * sources manager 单测（Spec §4.4 / §7.6 / §7.8 / §11.2.7 单元部分）。
 *
 * 覆盖：deriveSourceId、addLocal 校验与登记、addGit 离线→5 / 缺 ref→2 /
 * git 失败→1 / 成功 pin（调用序列）、update 离线→5、remove 删登记+缓存、
 * manifest 解析。
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type { EnvSnapshot } from '../../../src/core/env';
import {
  addGitSource,
  addLocalSource,
  deriveSourceId,
  listSources,
  loadSourceManifest,
  removeSource,
  sourceStoreDir,
  updateSource,
  type SourceManagerContext,
} from '../../../src/core/sources/manager';
import { createDirAwareHost } from './helpers';

const USER_SOT = 'C:\\user-sot';
const CWD = 'C:\\proj';

function ctxFor(host: ReturnType<typeof createDirAwareHost>, envOverrides: Partial<EnvSnapshot> = {}): SourceManagerContext {
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

  it('不满足 id 正则（如单字符 a）→ 抛 ConfigError(2)，要求用户显式指定 --id', async () => {
    // 'a' 长度 1 不满足 {1,63} 起始后至少 1 字符 → 总长 ≥2
    expect(() => deriveSourceId('https://example.com/a.git')).toThrow();
    try {
      deriveSourceId('https://example.com/a.git');
    } catch (err) {
      expect(err).toMatchObject({ code: 2 });
      expect((err as Error).message).toContain('无法从路径派生合法的源 id');
      // hint 包含 '--id'
      expect((err as any).hint).toContain('--id');
    }
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
    await expect(
      addLocalSource(ctxFor(host), { path: 'C:\\missing' }),
    ).rejects.toMatchObject({ code: 2 });
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
    const host = createDirAwareHost({}, { clone: { stdout: '', stderr: 'fatal: not found', code: 128 } });
    await expect(
      addGitSource(ctxFor(host), { url: URL, ref: 'v1.0.0' }),
    ).rejects.toMatchObject({ code: 1, name: 'GenericError' });
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
    expect(calls[0]?.args).toEqual(['clone', '--depth', '1', URL, result.storeDir]);
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
    await expect(
      updateSource(ctxFor(host, { offline: true }), 'rules'),
    ).rejects.toMatchObject({ code: 5, name: 'OfflineError' });
  });

  it('成功：fetch pinned ref → checkout pinned commit → rev-parse 刷新 commit', async () => {
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
    expect(calls[1]?.args).toEqual(['checkout', '--detach', 'abc123def456']);
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
    const source = (await listSources(ctx))[0];
    expect(source).toBeDefined();
    expect(await loadSourceManifest(ctx, source!)).toBeNull();
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
    const source = (await listSources(ctx))[0];
    const manifest = await loadSourceManifest(ctx, source!);
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
    const source = (await listSources(ctx))[0];
    await expect(loadSourceManifest(ctx, source!)).rejects.toMatchObject({ code: 2 });
  });

  it('schema 校验失败（缺必填 name）→ ConfigError(2)', async () => {
    const host = createDirAwareHost();
    host.files.set(
      path.win32.join('C:\\proj\\vendor-src', 'manifest.yaml'),
      "version: '1.0.0'\nmin_agentforge: 1\n",
    );
    const ctx = ctxFor(host);
    await addLocalSource(ctx, { path: 'vendor-src' });
    const source = (await listSources(ctx))[0];
    await expect(loadSourceManifest(ctx, source!)).rejects.toMatchObject({ code: 2 });
  });
});
