/**
 * init / skill add 的写盘事务性单测（round-3 修复，Spec §7.1 / §7.3 / §7.6）。
 *
 * 覆盖三条不变量：
 * - materializeSoT 部分写入失败 → 逆序清理本次产物并重抛**原**错误（否则残骸与
 *   resolveFreshSoTRoot 的「目录非空即拒」撞死，重跑 init 必得 ConfigError(2)）；
 * - runInit 的「判空 → 写入」整段持 SoT 事务锁（并发 init 不再互相覆盖）；
 * - runSkillAdd 的 copy 也在锁内（含 `--no-register` 路径），锁被他人持有时
 *   一个文件都不写。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSkillAdd } from '../../src/commands/assets';
import { runInit } from '../../src/commands/lifecycle';
import { materializeSoT, SOT_SUBDIRS } from '../../src/commands/lifecycle/init-scaffold';
import { loadProfile } from '../../src/core/config/load';
import { currentOs } from '../../src/core/paths';
import { SYNC_LOCK_DIRNAME, SYNC_LOCK_META_FILE } from '../../src/core/project/sync-lock';
import { createDirAwareHost, type DirAwareHost } from './sources/helpers';
import { abs } from './test-utils';

const OS = currentOs();
const HOME = abs('home', 'u');
const PROJECT_ROOT = abs('proj');
const PROJECT_SOT = path.join(PROJECT_ROOT, '.agentforge');
const LOCK_DIR = path.join(PROJECT_SOT, SYNC_LOCK_DIRNAME);
const VENDOR = path.join(PROJECT_ROOT, 'vendor-src');

function hostFor(): DirAwareHost {
  return createDirAwareHost({ USERPROFILE: HOME });
}

function ctxFor(host: DirAwareHost) {
  return { host, cwd: PROJECT_ROOT, os: OS };
}

/** 写入指定文件名时恒失败的 host（模拟 PermissionError(4) 那类中途失败）。 */
function failingWriteHost(base: DirAwareHost, failOn: string): DirAwareHost {
  return {
    ...base,
    async writeFile(p: string, content: string): Promise<void> {
      if (p.includes(failOn)) {
        throw new Error(`模拟写入失败: ${p}`);
      }
      return base.writeFile(p, content);
    },
  };
}

describe('materializeSoT 部分写入回滚', () => {
  it('第二个文件写失败 → 原错误重抛，已写文件与新建目录全部清理', async () => {
    const base = hostFor();
    const host = failingWriteHost(base, 'profile.yaml');
    const files = [
      { path: path.join(PROJECT_SOT, 'habits.yaml'), content: 'version: 1\n' },
      { path: path.join(PROJECT_SOT, 'profile.yaml'), content: 'version: 1\n' },
    ];

    await expect(materializeSoT(ctxFor(host), PROJECT_SOT, files)).rejects.toThrow(/模拟写入失败/);

    // 修复前：habits.yaml 与 5 个子目录留在盘上，重跑 init 撞「SoT 目录非空」(2)
    expect([...base.files.keys()].filter((k) => k.startsWith(PROJECT_SOT))).toEqual([]);
    expect(await host.exists(PROJECT_SOT)).toBe(false);
  });

  it('成功路径：根 + 5 个子目录 + 文件清单原样返回（回滚改造不影响正常语义）', async () => {
    const host = hostFor();
    const file = { path: path.join(PROJECT_SOT, 'habits.yaml'), content: 'version: 1\n' };

    const created = await materializeSoT(ctxFor(host), PROJECT_SOT, [file]);

    expect(created.createdFiles).toEqual([file.path]);
    expect(created.createdDirs).toEqual(SOT_SUBDIRS.map((d) => path.join(PROJECT_SOT, d)));
    expect(host.files.get(file.path)).toBe('version: 1\n');
  });
});

describe('runInit 并发（SoT 事务锁串行化）', () => {
  it('两个并发 init：恰好一个成功，另一个 ConflictError(3)（不再互相覆盖）', async () => {
    const host = hostFor();

    const settled = await Promise.allSettled([
      runInit(ctxFor(host), { scope: 'project' }),
      runInit(ctxFor(host), { scope: 'project' }),
    ]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
      code: 3,
      name: 'ConflictError',
    });
  });

  it('单次 init：锁目录用完即释放，产物齐全（锁目录不计入「目录非空」判据）', async () => {
    const host = hostFor();

    const result = await runInit(ctxFor(host), { scope: 'project' });

    expect(result.sotRoot).toBe(PROJECT_SOT);
    expect(host.files.has(path.join(PROJECT_SOT, 'profile.yaml'))).toBe(true);
    expect(host.files.has(path.join(PROJECT_SOT, 'habits.yaml'))).toBe(true);
    expect(await host.exists(LOCK_DIR)).toBe(false);
  });
});

describe('runSkillAdd 的 copy 也在 SoT 事务锁内', () => {
  /** 已初始化的 project 层 + 源里的一个 skill。 */
  function seed(host: DirAwareHost): void {
    host.files.set(path.join(PROJECT_SOT, 'profile.yaml'), 'version: 1\ntargets: [claude]\n');
    host.files.set(path.join(VENDOR, 'skills', 'pdf', 'SKILL.md'), '# pdf\n');
  }

  /** 模拟"另一个进程正持有 SoT 锁"（meta 的 acquiredAt 取 host.now() → 恒新鲜）。 */
  function seedForeignLock(host: DirAwareHost): void {
    host.files.set(
      path.join(LOCK_DIR, SYNC_LOCK_META_FILE),
      JSON.stringify({
        pid: 999_999,
        acquiredAt: host.now().toISOString(),
        token: 'someone-else',
        machine: 'other-machine',
        user: 'other-user',
      }),
    );
  }

  it('--no-register：锁被他人持有 → ConflictError(3)，且一个文件都没 copy', async () => {
    const host = hostFor();
    seed(host);
    seedForeignLock(host);

    await expect(runSkillAdd(ctxFor(host), 'pdf', VENDOR, false)).rejects.toMatchObject({
      code: 3,
      name: 'ConflictError',
    });
    // 修复前：copy 在锁外，--no-register 路径完全无锁 → 半装内容照样落进 SoT
    expect(host.files.has(path.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'))).toBe(false);
  });

  it('正常路径：copy + 登记在同一把锁内完成，结束后锁已释放', async () => {
    const host = hostFor();
    seed(host);

    const result = await runSkillAdd(ctxFor(host), 'pdf', VENDOR);

    expect(result.files).toEqual(['SKILL.md']);
    expect(result.registered?.always).toEqual(['pdf']);
    expect((await loadProfile(host, PROJECT_SOT))?.skills?.always).toEqual(['pdf']);
    expect(await host.exists(LOCK_DIR)).toBe(false);
  });
});
