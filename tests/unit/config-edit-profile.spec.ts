/**
 * config/edit-profile 单测（Spec §7.6 / §4.2）。
 *
 * editProfile 收敛了 mcp / template 管理器共用的写盘序列：
 * 读目标层 profile.yaml（缺失 → 最小缺省）→ mutate → 全量校验 → YAML
 * （lineWidth:0）→ 补尾换行 → 原子写入；整段持 SoT 事务锁（并发不丢写）。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { editProfile, newProfileDefaults } from '../../src/core/config/edit-profile';
import { loadProfile } from '../../src/core/config/load';
import type { TargetLayer } from '../../src/core/config/target-layer';
import type { OsContext } from '../../src/core/paths';
import type { ProfileInput } from '../../src/schema';
import { createDirAwareHost } from './sources/helpers';

const SOT = 'C:\\proj\\.agentforge';
const PROFILE_FILE_PATH = path.win32.join(SOT, 'profile.yaml');

function layer(): TargetLayer {
  return { scope: 'project', sotRoot: SOT, profileFile: PROFILE_FILE_PATH };
}

describe('newProfileDefaults', () => {
  it('最小缺省 = version 1 + opencode', () => {
    expect(newProfileDefaults()).toEqual({ version: 1, targets: ['opencode'] });
  });

  it('每次返回新对象（避免调用方共享同一数组引用）', () => {
    const a = newProfileDefaults();
    const b = newProfileDefaults();
    expect(a).not.toBe(b);
    expect(a.targets).not.toBe(b.targets);
  });
});

describe('editProfile', () => {
  it('profile.yaml 缺失：以最小缺省为基础落盘，mutate 收到该缺省', async () => {
    const host = createDirAwareHost();
    let seen: unknown;
    const result = await editProfile(host, layer(), (profile) => {
      seen = { ...profile };
      return { ...profile, templates: ['t1'] };
    });

    expect(seen).toEqual({ version: 1, targets: ['opencode'] });
    expect(result.profileFile).toBe(PROFILE_FILE_PATH);
    expect(result.written).toEqual({ version: 1, targets: ['opencode'], templates: ['t1'] });
    expect(parseYaml(host.files.get(PROFILE_FILE_PATH) ?? '')).toEqual({
      version: 1,
      targets: ['opencode'],
      templates: ['t1'],
    });
  });

  it('已有 profile.yaml：mutate 收到 z.input 原始形态，未涉及的键原样保留', async () => {
    const host = createDirAwareHost();
    host.files.set(PROFILE_FILE_PATH, 'version: 1\ntargets:\n  - claude\ntemplates:\n  - keep\n');

    await editProfile(host, layer(), (profile) => {
      // 关键：不展开默认值——原始形态里没有 projection / merge / skills 等键
      expect(Object.keys(profile).sort()).toEqual(['targets', 'templates', 'version']);
      return { ...profile, templates: [...(profile.templates ?? []), 'added'] };
    });

    expect(parseYaml(host.files.get(PROFILE_FILE_PATH) ?? '')).toEqual({
      version: 1,
      targets: ['claude'],
      templates: ['keep', 'added'],
    });
  });

  it('落盘的是 mutate 返回的原始形态，而不是 parse 后填充默认值的形态', async () => {
    const host = createDirAwareHost();
    const result = await editProfile(host, layer(), (p) => p);

    // parsed 含 schema 默认值；written / 磁盘内容不含
    expect(result.parsed.projection.marker_mode).toBeTruthy();
    expect(result.parsed.skills.copy_mode).toBe('copy');
    expect(result.written).toEqual({ version: 1, targets: ['opencode'] });
    expect(host.files.get(PROFILE_FILE_PATH)).not.toContain('marker_mode');
  });

  it('写盘内容以换行结尾（复用 fsutil.ensureTrailingNewline）', async () => {
    const host = createDirAwareHost();
    await editProfile(host, layer(), (p) => p);
    expect(host.files.get(PROFILE_FILE_PATH)?.endsWith('\n')).toBe(true);
  });

  it('长字符串不被 YAML 折行（lineWidth: 0）', async () => {
    const host = createDirAwareHost();
    const longId = `t-${'x'.repeat(200)}`;
    await editProfile(host, layer(), (p) => ({ ...p, templates: [longId] }));
    expect(host.files.get(PROFILE_FILE_PATH)).toContain(longId);
  });

  it('mutate 结果非法 → 抛错且**不写盘**（写入前全量校验）', async () => {
    const host = createDirAwareHost();
    await expect(
      // targets 至少一项：空数组不合法
      editProfile(host, layer(), (p) => ({ ...p, targets: [] })),
    ).rejects.toThrow();
    expect(host.files.has(PROFILE_FILE_PATH)).toBe(false);
  });

  it('目标层 profile.yaml 损坏 → ConfigError(2)（loadProfile 契约透传）', async () => {
    const host = createDirAwareHost();
    host.files.set(PROFILE_FILE_PATH, 'version: [not-a-number\n');
    await expect(editProfile(host, layer(), (p) => p)).rejects.toThrow(
      expect.objectContaining({ code: 2 }),
    );
  });

  it('写入结果可被 loadProfile 读回（往返一致）', async () => {
    const host = createDirAwareHost();
    await editProfile(host, layer(), (p) => ({
      ...p,
      mcp: { servers: [{ name: 'fs', transport: 'stdio', command: 'npx' }] },
    }));
    const reloaded = await loadProfile(host, SOT);
    expect(reloaded?.mcp?.servers?.[0]?.name).toBe('fs');
  });
});

describe('editProfile 并发（SoT 事务锁：读-改-写不被覆盖）', () => {
  const OS: OsContext = { platform: 'win32' };

  it('两个并发 editProfile：后者拿不到锁（ConflictError(3)），重试后两次修改都在', async () => {
    const host = createDirAwareHost();
    host.files.set(PROFILE_FILE_PATH, 'version: 1\ntargets:\n  - claude\n');

    const addTemplate = (id: string) => (p: ProfileInput) => ({
      ...p,
      templates: [...(p.templates ?? []), id],
    });

    const [first, second] = await Promise.allSettled([
      editProfile(host, layer(), addTemplate('t-a'), OS),
      editProfile(host, layer(), addTemplate('t-b'), OS),
    ]);

    // 恰好一个成功；失败者是"锁被占用"的 ConflictError(3)，不是静默覆盖
    const settled = [first, second];
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
      code: 3,
      name: 'ConflictError',
    });

    // 不丢写：失败者重试后，两次修改都落在同一份 profile 上
    const winner = settled.find((r) => r.status === 'fulfilled');
    const wonId = (winner?.status === 'fulfilled' ? winner.value.written.templates : [])?.[0];
    const loserId = wonId === 't-a' ? 't-b' : 't-a';
    await editProfile(host, layer(), addTemplate(loserId), OS);
    expect(parseYaml(host.files.get(PROFILE_FILE_PATH) ?? '').templates).toEqual([wonId, loserId]);
  });

  it('锁在成功与失败路径上都被释放（后续调用不被自己的残留锁挡住）', async () => {
    const host = createDirAwareHost();
    await expect(editProfile(host, layer(), (p) => ({ ...p, targets: [] }), OS)).rejects.toThrow();
    // 上一次因校验失败抛出，锁必须已在 finally 中释放
    await expect(editProfile(host, layer(), (p) => p, OS)).resolves.toMatchObject({
      profileFile: PROFILE_FILE_PATH,
    });
  });
});
