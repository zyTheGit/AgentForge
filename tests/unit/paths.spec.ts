/**
 * paths 单测（Spec §2.1 / §2.1.1 / §2.2）：SoT 解析 / 四 target 目录 / UNC / 大小写不敏感 / 长路径 / OneDrive。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EnvSnapshot } from '../../src/core/env';
import { ConfigError, GenericError } from '../../src/core/errors';
import {
  currentOs,
  detectOneDrive,
  isWithinAnyRoot,
  longPathAware,
  resolveProjectSoT,
  resolveTargetUserDirs,
  resolveUserSoT,
  SKILL_DOC_FILENAME,
  SKILLS_DIRNAME,
  samePath,
  stripLongPathPrefix,
  toPosixSeparators,
  validatePath,
} from '../../src/core/paths';
import { createFakeHost } from './test-utils';

const WIN = { platform: 'win32' } as const;
const POSIX = { platform: 'linux' } as const;

const envOf = (patch: Partial<EnvSnapshot> = {}): EnvSnapshot => ({
  agfHome: undefined,
  agfScope: undefined,
  offline: false,
  lineEnding: undefined,
  ci: false,
  codexHome: undefined,
  userProfile: 'C:\\Users\\tester',
  ...patch,
});

describe('resolveUserSoT（Spec §2.1）', () => {
  it('默认：USERPROFILE 下 .agentforge（win32 分隔符）', () => {
    expect(resolveUserSoT(envOf(), WIN)).toBe('C:\\Users\\tester\\.agentforge');
  });

  it('默认：HOME 下 .agentforge（posix 分隔符）', () => {
    expect(resolveUserSoT(envOf({ userProfile: '/home/u' }), POSIX)).toBe('/home/u/.agentforge');
  });

  it('AGF_HOME 覆盖并规范化为绝对路径', () => {
    expect(resolveUserSoT(envOf({ agfHome: 'D:\\af-home' }), WIN)).toBe('D:\\af-home');
    expect(resolveUserSoT(envOf({ agfHome: 'D:\\af-home\\' }), WIN)).toBe('D:\\af-home');
    // 相对 AGF_HOME 也解析为绝对（path.resolve 语义）
    const rel = resolveUserSoT(envOf({ agfHome: 'af-rel' }), WIN);
    expect(path.win32.isAbsolute(rel)).toBe(true);
    expect(rel.endsWith('af-rel')).toBe(true);
  });

  it('AGF_HOME 为 UNC → GenericError(1)（Spec §2.1.1）', () => {
    expect(() => resolveUserSoT(envOf({ agfHome: '\\\\server\\share\\af' }), WIN)).toThrow(
      GenericError,
    );
  });

  it('userProfile 与 AGF_HOME 均缺失 → ConfigError(2)', () => {
    expect(() => resolveUserSoT({ ...envOf(), userProfile: undefined }, WIN)).toThrow(ConfigError);
  });
});

describe('resolveProjectSoT（Spec §2.1）', () => {
  it('<project>\\.agentforge', () => {
    expect(resolveProjectSoT('C:\\proj', WIN)).toBe('C:\\proj\\.agentforge');
  });

  it('posix 分隔符', () => {
    expect(resolveProjectSoT('/home/u/proj', POSIX)).toBe('/home/u/proj/.agentforge');
  });

  it('相对 projectRoot 绝对化', () => {
    const out = resolveProjectSoT('some/dir', POSIX);
    expect(path.posix.isAbsolute(out)).toBe(true);
    expect(out.endsWith('some/dir/.agentforge')).toBe(true);
  });
});

describe('resolveTargetUserDirs（Spec §2.2 四 target 用户级目录）', () => {
  it('win32 默认路径', () => {
    const dirs = resolveTargetUserDirs(envOf(), WIN);
    expect(dirs.opencode).toBe('C:\\Users\\tester\\.config\\opencode');
    expect(dirs.codex).toBe('C:\\Users\\tester\\.codex');
    expect(dirs.claude).toBe('C:\\Users\\tester\\.claude');
    expect(dirs.pi).toBe('C:\\Users\\tester\\.pi\\agent');
  });

  it('CODEX_HOME 覆盖 codex 目录', () => {
    const dirs = resolveTargetUserDirs(envOf({ codexHome: 'E:\\tools\\codex' }), WIN);
    expect(dirs.codex).toBe('E:\\tools\\codex');
    // 其余不受影响
    expect(dirs.claude).toBe('C:\\Users\\tester\\.claude');
  });

  it('posix 分隔符映射（~/.config/opencode 等）', () => {
    const dirs = resolveTargetUserDirs(envOf({ userProfile: '/home/u' }), POSIX);
    expect(dirs.opencode).toBe('/home/u/.config/opencode');
    expect(dirs.codex).toBe('/home/u/.codex');
    expect(dirs.claude).toBe('/home/u/.claude');
    expect(dirs.pi).toBe('/home/u/.pi/agent');
  });

  it('userProfile 缺失 → ConfigError', () => {
    expect(() => resolveTargetUserDirs({ ...envOf(), userProfile: undefined }, WIN)).toThrow(
      ConfigError,
    );
  });
});

describe('validatePath（Spec §2.1.1 UNC 拒绝）', () => {
  it('UNC 反斜杠形式 → GenericError(1) 且 hint 提示 AGF_HOME 不支持网络路径', () => {
    try {
      validatePath('\\\\server\\share\\af', WIN);
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GenericError);
      const e = err as GenericError;
      expect(e.code).toBe(1);
      expect(e.hint).toMatch(/本地磁盘|网络/);
    }
  });

  it('UNC 正斜杠形式 → GenericError(1)', () => {
    expect(() => validatePath('//server/share/af', WIN)).toThrow(GenericError);
  });

  it('posix 上 `//x` 不是 UNC：不拦，按 posix 语义折叠为 /x', () => {
    // UNC 是 Windows 概念；posix 上 `//foo` 是合法绝对路径，拦掉即误伤
    expect(validatePath('//home/u/.agentforge', POSIX)).toBe('/home/u/.agentforge');
  });

  it('正常路径返回规范化绝对路径', () => {
    expect(validatePath('C:\\Users\\u\\.agentforge', WIN)).toBe('C:\\Users\\u\\.agentforge');
    expect(validatePath('C:\\Users\\u\\.agentforge\\', WIN)).toBe('C:\\Users\\u\\.agentforge');
    const rel = validatePath('rel/path', WIN);
    expect(path.win32.isAbsolute(rel)).toBe(true);
  });
});

describe('samePath（Spec §2.1 win32 大小写不敏感）', () => {
  it('win32：大小写不同视为相同', () => {
    expect(samePath('C:\\Users\\Tester\\.agentforge', 'c:\\users\\tester\\.AGENTFORGE', WIN)).toBe(
      true,
    );
  });

  it('win32：正反斜杠混用视为相同（normalize 统一）', () => {
    expect(samePath('C:/Users/u/.agentforge', 'C:\\Users\\u\\.agentforge', WIN)).toBe(true);
  });

  it('win32：不同路径视为不同', () => {
    expect(samePath('C:\\a', 'C:\\b', WIN)).toBe(false);
  });

  it('posix：大小写敏感', () => {
    expect(samePath('/home/u/.agentforge', '/home/U/.agentforge', POSIX)).toBe(false);
    expect(samePath('/home/u/.agentforge', '/home/u/.agentforge', POSIX)).toBe(true);
  });
});

describe('longPathAware（Spec §2.1.1 长路径 >240）', () => {
  const short = 'C:\\Users\\tester\\proj\\AGENTS.md';
  // 241 字符：前缀 + 填充 + 结尾
  const long = `C:\\${'a'.repeat(241 - 'C:\\'.length - 'AGENTS.md'.length)}AGENTS.md`;

  it('短路径原样返回', () => {
    expect(longPathAware(short, WIN)).toBe(short);
  });

  it('win32 长路径加 \\\\?\\ 前缀', () => {
    expect(long.length).toBeGreaterThan(240);
    expect(longPathAware(long, WIN)).toBe(`\\\\?\\${long}`);
  });

  it('已是 \\\\?\\ 前缀不重复添加', () => {
    const prefixed = `\\\\?\\${long}`;
    expect(longPathAware(prefixed, WIN)).toBe(prefixed);
  });

  it('UNC 长路径转为 \\\\?\\UNC\\ 形式', () => {
    const uncLong = `\\\\server\\share\\${'a'.repeat(250)}`;
    expect(longPathAware(uncLong, WIN)).toBe(`\\\\?\\UNC\\server\\share\\${'a'.repeat(250)}`);
  });

  it('posix 不加前缀（即使超长）', () => {
    const posixLong = `/${'a'.repeat(250)}/AGENTS.md`;
    expect(longPathAware(posixLong, POSIX)).toBe(posixLong);
  });
});

describe('detectOneDrive（Spec §2.1.1，doctor 用 warning）', () => {
  it('路径含 OneDrive 段 → true', () => {
    expect(detectOneDrive('C:\\Users\\u\\OneDrive\\Documents', createFakeHost())).toBe(true);
  });

  it('路径含 OneDrive - <tenant> 段（商业版）→ true', () => {
    expect(detectOneDrive('C:\\Users\\u\\OneDrive - Contoso\\proj', createFakeHost())).toBe(true);
  });

  it('普通路径且无 OneDrive 环境变量 → false', () => {
    expect(detectOneDrive('C:\\Users\\u\\Documents', createFakeHost())).toBe(false);
  });

  it('路径段以 OneDrive 开头但非完整段名（如 OneDriveOld）→ false', () => {
    expect(detectOneDrive('C:\\Users\\u\\OneDriveOld\\x', createFakeHost())).toBe(false);
  });

  it('环境变量 OneDrive 指向用户目录的子目录（用户目录在 OneDrive 下）→ true', () => {
    const host = createFakeHost({ OneDrive: 'C:\\Users\\u\\OneDrive' });
    expect(detectOneDrive('C:\\Users\\u\\OneDrive\\Documents', host)).toBe(true);
  });

  it('环境变量 OneDrive 位于用户目录之内（用户目录为 OneDrive 祖先）→ true', () => {
    const host = createFakeHost({ OneDrive: 'C:\\Users\\u\\OneDrive' });
    expect(detectOneDrive('C:\\Users\\u', host)).toBe(true);
  });

  it('环境变量 OneDrive 与用户目录无关 → false', () => {
    const host = createFakeHost({ OneDrive: 'D:\\OneDrive' });
    expect(detectOneDrive('C:\\Users\\u\\Documents', host)).toBe(false);
  });

  it('冗余条件已删除：upLower === odLower 与 odLower === upLower 是同一条件，只保留一次', () => {
    // 验证逻辑正确性：相等、前缀关系都能正确判断
    const host1 = createFakeHost({ OneDrive: 'C:\\Users\\u\\OneDrive' });
    expect(detectOneDrive('C:\\Users\\u\\OneDrive', host1)).toBe(true); // 相等

    const host2 = createFakeHost({ OneDrive: 'C:\\Users\\u\\OneDrive' });
    expect(detectOneDrive('C:\\Users\\u\\OneDrive\\Documents', host2)).toBe(true); // 用户目录在 OneDrive 下

    const host3 = createFakeHost({ OneDrive: 'C:\\Users\\u\\OneDrive' });
    expect(detectOneDrive('C:\\Users\\u', host3)).toBe(true); // OneDrive 在用户目录下
  });

  it('posix 分隔符：环境变量与用户目录用 / 时前缀关系仍能命中（macOS/Linux 版 OneDrive）', () => {
    // 修复前只拼 `\\` 做前缀比较，posix 分隔符下前缀判定恒为 false（只有完全相等才命中）。
    // 这里刻意用不含 OneDrive 段名的目录，确保命中来自「环境变量前缀」判据而非段扫描。
    const host = createFakeHost({ OneDrive: '/Users/u/Library/CloudStorage/od-sync' });
    // 用户目录在 OneDrive 之下
    expect(detectOneDrive('/Users/u/Library/CloudStorage/od-sync/proj', host)).toBe(true);
    // OneDrive 在用户目录之下
    expect(detectOneDrive('/Users/u/Library', host)).toBe(true);
    // 完全相等（修复前唯一能命中的形态）
    expect(detectOneDrive('/Users/u/Library/CloudStorage/od-sync', host)).toBe(true);
    // 无关目录仍为 false
    expect(detectOneDrive('/Users/other/Documents', host)).toBe(false);
  });

  it('混用分隔符：环境变量用 / 而用户目录用 \\（或反之）也能命中', () => {
    const host = createFakeHost({ OneDrive: 'C:/Users/u/od-sync' });
    expect(detectOneDrive('C:\\Users\\u\\od-sync\\Documents', host)).toBe(true);
    expect(detectOneDrive('C:\\Users\\u', host)).toBe(true);
  });

  it('posix：非分隔符边界的同名前缀不误判（od-sync-extra 不属于 od-sync）', () => {
    const host = createFakeHost({ OneDrive: '/Users/u/od-sync' });
    expect(detectOneDrive('/Users/u/od-sync-extra', host)).toBe(false);
  });
});

describe('currentOs', () => {
  it('返回当前进程平台（win32/darwin/linux 之一）', () => {
    expect(['win32', 'darwin', 'linux']).toContain(currentOs().platform);
  });
});

describe('toPosixSeparators（逻辑路径的分隔符归一，跨平台恒为 /）', () => {
  it('空串 → 空串', () => {
    expect(toPosixSeparators('')).toBe('');
  });

  it('无分隔符原样返回', () => {
    expect(toPosixSeparators('SKILL.md')).toBe('SKILL.md');
  });

  it('win32 相对路径：每个 \\ 映射为 /', () => {
    expect(toPosixSeparators('a\\b\\c.md')).toBe('a/b/c.md');
  });

  it('已是 posix 分隔符时幂等', () => {
    expect(toPosixSeparators('a/b/c.md')).toBe('a/b/c.md');
    expect(toPosixSeparators(toPosixSeparators('a\\b'))).toBe('a/b');
  });

  it('混用分隔符统一为 /', () => {
    expect(toPosixSeparators('a\\b/c\\d')).toBe('a/b/c/d');
  });

  it('不折叠连续分隔符（与 detectOneDrive 的比较用归一化区别所在）', () => {
    expect(toPosixSeparators('a\\\\b')).toBe('a//b');
  });

  it('不 trim、不去尾部分隔符（纯字符映射）', () => {
    expect(toPosixSeparators(' a\\b\\ ')).toBe(' a/b/ ');
    expect(toPosixSeparators('a\\b\\')).toBe('a/b/');
  });

  it('win32 绝对路径（含盘符）也整体归一', () => {
    expect(toPosixSeparators('C:\\proj\\.claude\\skills')).toBe('C:/proj/.claude/skills');
  });
});

describe('skills 布局常量（Spec §2.3；projectors/shared 原样再导出）', () => {
  it('SKILLS_DIRNAME / SKILL_DOC_FILENAME 取值固定', () => {
    expect(SKILLS_DIRNAME).toBe('skills');
    expect(SKILL_DOC_FILENAME).toBe('SKILL.md');
  });
});

describe('stripLongPathPrefix', () => {
  it('剥掉 \\\\?\\ 前缀；UNC 前缀还原成 \\\\server\\share', () => {
    expect(stripLongPathPrefix('\\\\?\\C:\\proj\\a')).toBe('C:\\proj\\a');
    expect(stripLongPathPrefix('\\\\?\\UNC\\srv\\share')).toBe('\\\\srv\\share');
  });

  it('无前缀原样返回（posix 路径不受影响）', () => {
    expect(stripLongPathPrefix('C:\\proj\\a')).toBe('C:\\proj\\a');
    expect(stripLongPathPrefix('/home/u/x')).toBe('/home/u/x');
  });
});

describe('isWithinAnyRoot（§10 边界判定：恢复 journal / 锁根解析共用）', () => {
  it('root 自身与其子路径都算在内', () => {
    expect(isWithinAnyRoot('C:\\proj', ['C:\\proj'], WIN)).toBe(true);
    expect(isWithinAnyRoot('C:\\proj\\a\\b', ['C:\\proj'], WIN)).toBe(true);
  });

  it('win32 大小写折叠：盘符与目录名大小写不同仍算在内', () => {
    expect(isWithinAnyRoot('c:\\Proj\\A', ['C:\\proj'], WIN)).toBe(true);
  });

  it('posix 大小写敏感：只差大小写即视为不同根', () => {
    expect(isWithinAnyRoot('/home/U/x', ['/home/u'], POSIX)).toBe(false);
    expect(isWithinAnyRoot('/home/u/x', ['/home/u'], POSIX)).toBe(true);
  });

  it('同名前缀不算在内（字符串前缀比较会误判 C:\\a-b 在 C:\\a 内）', () => {
    expect(isWithinAnyRoot('C:\\a-b', ['C:\\a'], WIN)).toBe(false);
    expect(isWithinAnyRoot('/home/user2', ['/home/user'], POSIX)).toBe(false);
  });

  it('长路径前缀与裸根混比：两侧先剥前缀再判（边界不随路径长度漂移）', () => {
    expect(isWithinAnyRoot('\\\\?\\C:\\proj\\a', ['C:\\proj'], WIN)).toBe(true);
    expect(isWithinAnyRoot('C:\\proj\\a', ['\\\\?\\C:\\proj'], WIN)).toBe(true);
  });

  it('多根：命中任一即 true；全不命中 / 空白名单 → false', () => {
    expect(isWithinAnyRoot('D:\\other\\x', ['C:\\proj', 'D:\\other'], WIN)).toBe(true);
    expect(isWithinAnyRoot('E:\\x', ['C:\\proj', 'D:\\other'], WIN)).toBe(false);
    expect(isWithinAnyRoot('C:\\proj\\a', [], WIN)).toBe(false);
  });
});
