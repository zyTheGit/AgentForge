/**
 * containment 校验的**攻击面**用例（issue #53 安全边界 3）。
 *
 * 这一层是声明式适配器最关键的护栏：`adapters/<id>.yaml` 可以被 `git clone` 带进
 * 一个仓库，而 `aforge sync` 持锁并往用户主目录写文件。落点越界就等于「clone 一个
 * 仓库就能往任意位置写文件」。因此本文件按**绕过尝试**组织，而不是按函数组织——
 * 每条用例都是一种具体的逃逸手法，删掉任何一条都等于放开一个入口。
 *
 * 覆盖的绕过尝试（逐条对应下方 it）：
 *  1. `..\..\..\Windows` 目录穿越（路径里带 `..`，靠 relative 判据而非字符串前缀）
 *  2. `C:\` 直接指定（落在盘根，不在任何允许根内）
 *  3. UNC `\\server\share`（唯一能把网络位置带进落点的形态）
 *  4. `//server/share` 正斜杠写法的 UNC（同上，换个写法）
 *  5. `\\?\UNC\server\share` 长路径前缀包装的 UNC（剥前缀后仍是 UNC）
 *  6. 盘符跳变 `D:\...`（vs `C:\` 上的允许根）
 *  7. 前缀相似的兄弟目录 `C:\Users\user2`（字符串前缀判据会漏，relative 不会）
 *  8. `C:\repo-evil` vs 允许根 `C:\repo`（同 7，连字符版）
 *  9. 相对路径落点（模板层已拦，这里是第二道）
 * 10. 一个允许根都没有（USERPROFILE / HOME 全缺）→ 不许「无根即通过」
 * 11. 未置位的白名单环境变量不进允许根（`CODEX_HOME` 没设时不能凭空多个根）
 * 12. 白名单环境变量取值是 UNC → 落点仍被拒（取值本身归 core/paths.validatePath 摘掉，
 *     对应断言在 loader.spec.ts；containment 不重判形态，见该文件顶部的分工表）
 * 13. 白名单环境变量取值是相对路径 → 该根被丢弃
 * 14. symlink 落点逃逸：`~/.my` → `C:\Windows`
 * 15. symlink 相对目标逃逸：`~/.my` → `..\..\Windows`
 * 16. symlink 环 → 跳数上限（不许把加载卡死）
 * 17. 落点自身就是 symlink（最后一段，不是祖先目录）
 *
 * 另有三条**不能误报**的反向用例（14/17 的对照）：根自身是 symlink、无 symlink、
 * 落在 `CODEX_HOME` 内。安全边界只在「该拦的拦住 + 该放的放过」都成立时才有用。
 *
 * 全部用 win32 语义（`path.win32` + `platform: 'win32'`）：盘符、UNC、大小写不敏感
 * 这三件事只在 win32 上有意义，也正是绕过手法最多的地方。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AdapterContainmentError,
  assertNoSymlinkEscape,
  assertWithinAllowedRoots,
  buildAllowedRoots,
} from '../../../src/core/adapters/containment';
import type { OsContext } from '../../../src/core/paths';
import type { FileStat, Host } from '../../../src/infra/host';
import { createFakeHost, errnoError } from '../test-utils';

const WIN: OsContext = { platform: 'win32' };
const api = path.win32;

const PROJECT = 'C:\\repo';
const HOME = 'C:\\Users\\user';

/** 默认允许根：projectRoot + userHome（无白名单环境变量置位）。 */
function roots(envValues: Readonly<Record<string, string>> = {}) {
  return buildAllowedRoots(PROJECT, HOME, envValues, api);
}

/** 断言落点被 containment 拦下（错误类型固定为 ConfigError(2) 的子类）。 */
function expectRejected(target: string, envValues?: Readonly<Record<string, string>>): Error {
  let caught: unknown;
  try {
    assertWithinAllowedRoots(target, roots(envValues), WIN, api, 'my-agent.user.main_rule');
  } catch (err) {
    caught = err;
  }
  expect(caught, `落点 ${target} 应被拒绝`).toBeInstanceOf(AdapterContainmentError);
  const error = caught as AdapterContainmentError;
  // 提示必须带上落点名，否则用户不知道是哪条声明出的问题
  expect(error.message).toContain('my-agent.user.main_rule');
  return error;
}

describe('assertWithinAllowedRoots — 纯路径绕过尝试', () => {
  it('1. `..` 目录穿越（..\\..\\..\\Windows）→ 拒', () => {
    // 注意 target 未预先规范化：判据必须自己 normalize，否则 `..` 段能骗过前缀比较
    expectRejected('C:\\Users\\user\\..\\..\\Windows\\System32\\evil.md');
  });

  it('2. 盘根直接指定（C:\\evil.md）→ 拒', () => {
    expectRejected('C:\\evil.md');
  });

  it('3. UNC（\\\\server\\share\\x）→ 拒，且报的是 UNC 而不是笼统的越界', () => {
    const err = expectRejected('\\\\server\\share\\evil.md');
    expect(err.message).toContain('网络路径');
  });

  it('4. 正斜杠写法的 UNC（//server/share/x）→ 同样拒', () => {
    const err = expectRejected('//server/share/evil.md');
    expect(err.message).toContain('网络路径');
  });

  it('5. 长路径前缀包装的 UNC（\\\\?\\UNC\\server\\share）→ 剥前缀后仍拒', () => {
    const err = expectRejected('\\\\?\\UNC\\server\\share\\evil.md');
    expect(err.message).toContain('网络路径');
  });

  it('6. 盘符跳变（D:\\evil）→ 拒', () => {
    expectRejected('D:\\evil\\notes.md');
  });

  it('7. 前缀相似的兄弟目录（C:\\Users\\user2）→ 拒（字符串前缀判据会漏这条）', () => {
    expectRejected('C:\\Users\\user2\\stolen.md');
  });

  it('8. 连字符兄弟目录（C:\\repo-evil vs 根 C:\\repo）→ 拒', () => {
    expectRejected('C:\\repo-evil\\notes.md');
  });

  it('9. 相对路径落点 → 拒（模板层之外的第二道）', () => {
    const err = expectRejected('..\\..\\Windows\\evil.md');
    expect(err.message).toContain('不是绝对路径');
  });

  it('10. 一个允许根都没有（无 projectRoot / userHome / env）→ 拒，不许"无根即通过"', () => {
    const empty = buildAllowedRoots('', undefined, {}, api);
    expect(empty.roots).toEqual([]);
    expect(() =>
      assertWithinAllowedRoots(
        'C:\\Users\\user\\x.md',
        empty,
        WIN,
        api,
        'my-agent.user.skills_dir',
      ),
    ).toThrow(/没有任何可用的允许根/);
  });

  it('11. 未置位的白名单环境变量不进允许根（不能凭空多一个根）', () => {
    expect(roots().roots).toEqual([PROJECT, HOME]);
    expectRejected('C:\\codex-home\\skills\\x\\SKILL.md');
  });

  it('12. 白名单环境变量取值是 UNC → 落点仍被拒（取值本身由统一守卫在 loader 处摘掉）', () => {
    // 这里刻意**不**断言「UNC 取值不进 allowed.roots」：那是 core/paths.validatePath
    // （PR #59 统一守卫）的职责，调用点在 loader.readWhitelistedEnv，对应断言在
    // loader.spec.ts。containment 只保证「即使一个 UNC 根混了进来，落点也出不去」——
    // 同一件事只留一份判据，见 containment.ts 顶部的分工表。
    const allowed = roots({ CODEX_HOME: '\\\\attacker\\share' });
    expect(allowed.roots).toContain(PROJECT);
    expect(allowed.roots).toContain(HOME);
    const err = expectRejected('\\\\attacker\\share\\skills\\x\\SKILL.md', {
      CODEX_HOME: '\\\\attacker\\share',
    });
    expect(err.message).toContain('网络路径');
    // 反向：UNC 根混进来也不会把一个盘内落点“洗”成合法（relative 判据）
    expectRejected('C:\\evil.md', { CODEX_HOME: '\\\\attacker\\share' });
  });

  it('13. 白名单环境变量取值是相对路径 → 该根被丢弃', () => {
    const allowed = roots({ CODEX_HOME: '..\\elsewhere' });
    expect(allowed.roots).toEqual([PROJECT, HOME]);
  });

  it('置位的白名单环境变量指向的目录**是**合法根（反向用例：该放的要放过）', () => {
    const env = { CODEX_HOME: 'D:\\codex' };
    const allowed = roots(env);
    expect(allowed.roots).toEqual([PROJECT, HOME, 'D:\\codex']);
    expect(() =>
      assertWithinAllowedRoots(
        'D:\\codex\\skills\\demo\\SKILL.md',
        allowed,
        WIN,
        api,
        'my-agent.user.skills_dir',
      ),
    ).not.toThrow();
  });

  it('落在根内的正常落点放过；大小写不同也算落在根内（win32 语义）', () => {
    const allowed = roots();
    expect(() =>
      assertWithinAllowedRoots(`${HOME}\\.my\\AGENTS.md`, allowed, WIN, api, 'x'),
    ).not.toThrow();
    expect(() =>
      assertWithinAllowedRoots('c:\\users\\USER\\.my\\AGENTS.md', allowed, WIN, api, 'x'),
    ).not.toThrow();
    // 长路径前缀（非 UNC）剥掉后仍在根内 → 不能因为路径长了就判越界
    expect(() =>
      assertWithinAllowedRoots(`\\\\?\\${HOME}\\.my\\AGENTS.md`, allowed, WIN, api, 'x'),
    ).not.toThrow();
  });

  it('允许根集合带来源标注，越界提示里逐条列出（用户要能看出比对的是哪些根）', () => {
    const err = expectRejected('C:\\evil.md');
    expect(err.message).toContain(`projectRoot=${PROJECT}`);
    expect(err.message).toContain(`userHome=${HOME}`);
  });
});

// ---------------------------------------------------------------------------
// symlink 逃逸：纯路径运算看不出来，必须读 fs
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

/**
 * 带 symlink 的 fake host。
 *
 * 为什么不改 test-utils 的 createFakeHost：它的 `readlink` 恒抛、`lstat` 只认文件键，
 * 改它会波及几十个已通过的 spec。这里只覆盖 `lstat` / `readlink` 两个方法。
 *
 * 每个 link 键的**全部祖先**自动登记为目录——`firstSymlinkPrefix` 是逐层 lstat 往下
 * 走的，中间层 lstat 抛错就会提前认定「路径上没有 symlink」，祖先不登记则永远走不到
 * 那个 link。
 */
function createLinkHost(links: Readonly<Record<string, string>>): Host {
  const linkMap = new Map(Object.entries(links));
  const dirs = new Set<string>();
  for (const key of linkMap.keys()) {
    let current = key;
    for (;;) {
      const parent = api.dirname(current);
      dirs.add(parent);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return {
    ...createFakeHost(),
    async lstat(p: string): Promise<FileStat> {
      if (linkMap.has(p)) {
        return LINK_STAT;
      }
      if (dirs.has(p)) {
        return DIR_STAT;
      }
      throw errnoError('ENOENT', `no such path: ${p}`);
    },
    async readlink(p: string): Promise<string> {
      const target = linkMap.get(p);
      if (target === undefined) {
        throw errnoError('EINVAL', `not a symlink: ${p}`);
      }
      return target;
    },
  };
}

describe('assertNoSymlinkEscape — symlink 逃逸绕过尝试', () => {
  it('14. 祖先目录是指向根外的 symlink（~/.my → C:\\Windows）→ 拒', async () => {
    const host = createLinkHost({ [`${HOME}\\.my`]: 'C:\\Windows' });
    await expect(
      assertNoSymlinkEscape(
        host,
        `${HOME}\\.my\\skills\\demo\\SKILL.md`,
        roots(),
        WIN,
        api,
        'my-agent.user.skills_dir',
      ),
    ).rejects.toThrow(/symlink 解析后指向 C:\\Windows/);
  });

  it('15. symlink 目标是相对路径（..\\..\\Windows）→ 按 link 所在目录解析后仍拒', async () => {
    const host = createLinkHost({ [`${HOME}\\.my`]: '..\\..\\Windows' });
    await expect(
      assertNoSymlinkEscape(host, `${HOME}\\.my\\AGENTS.md`, roots(), WIN, api, 'x'),
    ).rejects.toBeInstanceOf(AdapterContainmentError);
  });

  it('16. symlink 环 → 报跳数超限（不许把加载卡死在无限展开里）', async () => {
    const host = createLinkHost({
      [`${HOME}\\a`]: `${HOME}\\b`,
      [`${HOME}\\b`]: `${HOME}\\a`,
    });
    await expect(
      assertNoSymlinkEscape(host, `${HOME}\\a\\AGENTS.md`, roots(), WIN, api, 'x'),
    ).rejects.toThrow(/symlink 环/);
  });

  it('17. 落点自身（最后一段）就是越界 symlink → 拒', async () => {
    const host = createLinkHost({ [`${HOME}\\AGENTS.md`]: 'C:\\Windows\\evil.md' });
    await expect(
      assertNoSymlinkEscape(host, `${HOME}\\AGENTS.md`, roots(), WIN, api, 'x'),
    ).rejects.toBeInstanceOf(AdapterContainmentError);
  });

  it('反向：symlink 指向根内 → 放过（不能一见 symlink 就拒）', async () => {
    const host = createLinkHost({ [`${HOME}\\.my`]: `${HOME}\\.config\\my` });
    await expect(
      assertNoSymlinkEscape(host, `${HOME}\\.my\\AGENTS.md`, roots(), WIN, api, 'x'),
    ).resolves.toBeUndefined();
  });

  it('反向：允许根**自身**是 symlink（家目录被重定向）→ 落点不得误判越界', async () => {
    // 家目录是 symlink 的环境很常见（企业环境把 profile 挪到别的盘）。允许根若不
    // 一并展开，这类环境下**每一个**落点都会被判越界——护栏就变成了坏功能。
    const host = createLinkHost({ [HOME]: 'D:\\real\\home' });
    await expect(
      assertNoSymlinkEscape(host, `${HOME}\\.my\\AGENTS.md`, roots(), WIN, api, 'x'),
    ).resolves.toBeUndefined();
  });

  it('反向：路径上完全没有 symlink（lstat 全 ENOENT）→ 放过', async () => {
    await expect(
      assertNoSymlinkEscape(createFakeHost(), `${HOME}\\.my\\AGENTS.md`, roots(), WIN, api, 'x'),
    ).resolves.toBeUndefined();
  });
});
