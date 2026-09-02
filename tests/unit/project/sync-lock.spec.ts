/**
 * 事务锁的「同 pid 空间」判据单测（Issue #51 第 3 条）。
 *
 * 为什么单独一个文件：这条判据决定 acquireSyncLock 敢不敢对持有者做 `kill(pid, 0)`
 * 探针，两个方向的错都会丢数据或永久误拒（见 sameProcessSpace 的 JSDoc），值得脱离
 * 完整 sync 流程单独钉住每一个分支——尤其是老锁文件缺字段时的降级方向。
 */
import { describe, expect, it } from 'vitest';
import { pidSpaceIdOf, sameProcessSpace } from '../../../src/core/project/sync-identity';
import { createFakeHost } from '../test-utils';

const WIN = { platform: 'win32' } as const;
const LINUX = { platform: 'linux' } as const;

/** 锁持有者元数据的形状（与 sync-lock 内部的 SyncLockRecord 同构；该 interface 不导出）。 */
interface Holder {
  readonly pid: number;
  readonly acquiredAt: string;
  readonly token: string;
  readonly machine: string;
  readonly user: string;
  readonly pidSpace: string;
}

/** 一份完整的锁持有者元数据（各用例只改关心的字段）。 */
function holderOf(patch: Partial<Holder> = {}): Holder {
  return {
    pid: 4242,
    acquiredAt: new Date(0).toISOString(),
    token: 'deadbeef',
    machine: 'DEV-BOX',
    user: 'dev',
    pidSpace: 'native:win32',
    ...patch,
  };
}

describe('pidSpaceIdOf（Issue #51：WSL 边界上的 pid 空间标识）', () => {
  it('WSL_DISTRO_NAME 置位 → wsl:<发行版>（不同发行版彼此不等）', () => {
    const ubuntu = createFakeHost({ WSL_DISTRO_NAME: 'Ubuntu' });
    const debian = createFakeHost({ WSL_DISTRO_NAME: 'Debian' });
    expect(pidSpaceIdOf(ubuntu, LINUX)).toBe('wsl:Ubuntu');
    expect(pidSpaceIdOf(debian, LINUX)).toBe('wsl:Debian');
    expect(pidSpaceIdOf(ubuntu, LINUX)).not.toBe(pidSpaceIdOf(debian, LINUX));
  });

  it('检出 WSL 但读不到发行版名 → 空串（未知，调用方按不同 pid 空间处理）', () => {
    const host = createFakeHost({ WSL_INTEROP: '/run/WSL/8_interop' });
    expect(pidSpaceIdOf(host, LINUX)).toBe('');
  });

  it('非 WSL → native:<platform>（Windows 侧与任何 wsl:* 都不相等）', () => {
    const host = createFakeHost({});
    expect(pidSpaceIdOf(host, WIN)).toBe('native:win32');
    expect(pidSpaceIdOf(host, LINUX)).toBe('native:linux');
    expect(pidSpaceIdOf(host, WIN)).not.toBe(pidSpaceIdOf(host, LINUX));
  });
});

describe('sameProcessSpace（pid 探针是否可信）', () => {
  const host = createFakeHost({ COMPUTERNAME: 'DEV-BOX', USERNAME: 'dev' });

  it('机器 / 用户 / pid 空间全部相等且非空 → true', () => {
    expect(sameProcessSpace(holderOf(), host, WIN)).toBe(true);
  });

  it('持有者为 null（元数据不可读）→ false', () => {
    expect(sameProcessSpace(null, host, WIN)).toBe(false);
  });

  it('WSL 边界：机器名与用户名相同、pid 空间不同 → false（不做 pid 探针）', () => {
    // WSL 的 hostname 默认就是 Windows 计算机名，两侧用户名也常相同——这正是 #51 第 3 条
    const wslHolder = holderOf({ pidSpace: 'wsl:Ubuntu' });
    expect(wslHolder.machine).toBe('DEV-BOX');
    expect(sameProcessSpace(wslHolder, host, WIN)).toBe(false);
  });

  it('老版本写的锁文件（无 pidSpace 字段 → 空串）→ false（保守降级：只走超时路径）', () => {
    expect(sameProcessSpace(holderOf({ pidSpace: '' }), host, WIN)).toBe(false);
  });

  it('机器 / 用户标识两侧都取不到 → false（空串不算相等，避免判据凭空为真）', () => {
    const blank = createFakeHost({});
    expect(sameProcessSpace(holderOf({ machine: '', user: '' }), blank, WIN)).toBe(false);
  });

  it('本进程侧检出 WSL 但读不到发行版名 → false（宁缺勿滥）', () => {
    const unknownWsl = createFakeHost({
      COMPUTERNAME: 'DEV-BOX',
      USERNAME: 'dev',
      WSL_INTEROP: '/run/WSL/8_interop',
    });
    expect(sameProcessSpace(holderOf({ pidSpace: '' }), unknownWsl, LINUX)).toBe(false);
  });

  it('同机器不同用户 → false（原有判据保留）', () => {
    expect(sameProcessSpace(holderOf({ user: 'other' }), host, WIN)).toBe(false);
  });
});
