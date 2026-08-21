/**
 * fsutil 单测（Spec §2.5）：原子写入（含只读目标）/ 换行规范化 / BOM / sha256 / mkdirp。
 * 真实 IO 用 realHost + 系统临时目录；权限失败分支用 fake host 注入。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PermissionError } from '../../src/core/errors';
import { atomicWrite, mkdirp, normalizeLineEnding, sha256Hex, stripBom } from '../../src/infra/fsutil';
import { realHost } from '../../src/infra/real-host';
import type { Host } from '../../src/infra/host';
import { createFakeHost, errnoError } from './test-utils';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'agf-fsutil-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('stripBom', () => {
  it('剥离 UTF-8 BOM', () => {
    expect(stripBom('\ufeffhello')).toBe('hello');
    expect(stripBom('\ufeff中文内容')).toBe('中文内容');
  });

  it('无 BOM 原样返回', () => {
    expect(stripBom('hello')).toBe('hello');
  });

  it('仅 BOM → 空串', () => {
    expect(stripBom('\ufeff')).toBe('');
  });

  it('BOM 只在开头剥一次（正文中的 U+FEFF 不受影响）', () => {
    expect(stripBom('\ufeffa\ufeffb')).toBe('a\ufeffb');
  });
});

describe('normalizeLineEnding（Spec §2.5 LF/CRLF 往返）', () => {
  it('CRLF/孤立 CR → LF', () => {
    expect(normalizeLineEnding('a\r\nb\nc', 'lf')).toBe('a\nb\nc');
    expect(normalizeLineEnding('a\rb', 'lf')).toBe('a\nb');
  });

  it('LF → CRLF', () => {
    expect(normalizeLineEnding('a\nb\nc', 'crlf')).toBe('a\r\nb\r\nc');
  });

  it('混合内容 → CRLF 全展开', () => {
    expect(normalizeLineEnding('a\r\nb\nc\rd', 'crlf')).toBe('a\r\nb\r\nc\r\nd');
  });

  it('往返：crlf → lf 恢复为纯 LF 形态', () => {
    const mixed = 'a\r\nb\nc';
    expect(normalizeLineEnding(normalizeLineEnding(mixed, 'crlf'), 'lf')).toBe(
      normalizeLineEnding(mixed, 'lf'),
    );
  });

  it('空串与无换行内容不受影响', () => {
    expect(normalizeLineEnding('', 'crlf')).toBe('');
    expect(normalizeLineEnding('abc', 'crlf')).toBe('abc');
  });
});

describe('sha256Hex（contentHash 基准，Spec §3.3）', () => {
  it('已知向量：sha256("")', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('已知向量：sha256("a")（LF 内容）', () => {
    expect(sha256Hex('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });

  it('换行风格不敏感：LF 与 CRLF 同内容同 hash', () => {
    expect(sha256Hex('# Rules\n- a\n- b\n')).toBe(sha256Hex('# Rules\r\n- a\r\n- b\r\n'));
  });

  it('内容不同 → hash 不同（hex 小写 64 位）', () => {
    const h1 = sha256Hex('v1');
    const h2 = sha256Hex('v2');
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('atomicWrite + realHost（真实临时目录）', () => {
  it('写入新文件且无临时文件残留', async () => {
    const target = path.join(tmpRoot, 'plain', 'AGENTS.md');
    await mkdirp(realHost, path.dirname(target));
    await atomicWrite(realHost, target, '# hello\n');

    expect(await realHost.readFile(target)).toBe('# hello\n');
    const leftovers = (await realHost.listDir(path.dirname(target))).filter((f) =>
      f.includes('.agf-'),
    );
    expect(leftovers).toEqual([]);
  });

  it('覆盖已有文件（旧内容被完全替换）', async () => {
    const target = path.join(tmpRoot, 'overwrite', 'AGENTS.md');
    await mkdirp(realHost, path.dirname(target));
    await atomicWrite(realHost, target, 'old content\n');
    await atomicWrite(realHost, target, 'new content\n');
    expect(await realHost.readFile(target)).toBe('new content\n');
  });

  it('中文 + 空格路径与中文内容（Spec §2.1.1 / §11.2-10）', async () => {
    const target = path.join(tmpRoot, '规则 目录 带空格', 'AGENTS.md');
    await mkdirp(realHost, path.dirname(target));
    const content = '# 规则\n- Node 用 fnm 管理\n- Python 用 uv\n';
    await atomicWrite(realHost, target, content);
    expect(await realHost.readFile(target)).toBe(content);
  });

  it('只读目标文件：写入前自动去除只读属性，写入成功（Spec §2.5）', async () => {
    const target = path.join(tmpRoot, 'readonly', 'AGENTS.md');
    await mkdirp(realHost, path.dirname(target));
    writeFileSync(target, 'old\n', 'utf8');
    chmodSync(target, 0o444); // Windows：设置只读属性；POSIX：去除写位

    await atomicWrite(realHost, target, 'fresh\n');

    expect(await realHost.readFile(target)).toBe('fresh\n');
    // Windows：只读属性应已被去除（0o444 会阻断后续 append/rewrite）
    chmodSync(target, 0o666);
  });
});

describe('atomicWrite + fake host（权限失败分支）', () => {
  it('rename 遇 EPERM → PermissionError(4)，hint 可操作，临时文件被清理', async () => {
    const base = createFakeHost();
    const failing: Host = {
      ...base,
      rename: async () => {
        throw errnoError('EPERM', 'operation not permitted');
      },
    };
    const target = 'C:\\proj\\AGENTS.md';
    await failing.writeFile(target, 'old\n');

    let caught: unknown;
    try {
      await atomicWrite(failing, target, 'new\n');
      expect.unreachable('should throw');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PermissionError);
    const permErr = caught as PermissionError;
    expect(permErr.code).toBe(4);
    expect(permErr.hint).toMatch(/占用|只读|权限/);
    expect(permErr.message).toContain(target);
    // 临时文件已清理，且目标原内容未被破坏
    expect([...base.files.keys()].some((k) => k.includes('.agf-'))).toBe(false);
    expect(base.files.get(target)).toBe('old\n');
  });

  it('rename 遇 EACCES → PermissionError(4)', async () => {
    const base = createFakeHost();
    const failing: Host = {
      ...base,
      rename: async () => {
        throw errnoError('EACCES', 'permission denied');
      },
    };
    await expect(atomicWrite(failing, 'C:\\x\\AGENTS.md', 'new\n')).rejects.toBeInstanceOf(
      PermissionError,
    );
  });

  it('目标已存在时写入前会尝试 chmod 去只读（Spec §2.5 Windows 细节）', async () => {
    const host = createFakeHost();
    const target = 'C:\\proj\\AGENTS.md';
    await host.writeFile(target, 'old\n');
    await atomicWrite(host, target, 'new\n');
    expect(host.chmodCalls).toContain(target);
  });

  it('目标不存在时不调用 chmod', async () => {
    const host = createFakeHost();
    await atomicWrite(host, 'C:\\proj\\AGENTS.md', 'new\n');
    expect(host.chmodCalls).toEqual([]);
  });

  it('rename 非 errno 错误原样抛出（不吞异常）', async () => {
    const base = createFakeHost();
    const failing: Host = {
      ...base,
      rename: async () => {
        throw new Error('boom');
      },
    };
    await expect(atomicWrite(failing, 'C:\\x\\AGENTS.md', 'new\n')).rejects.toThrow('boom');
  });
});

describe('mkdirp', () => {
  it('真实目录：递归创建嵌套目录', async () => {
    const dir = path.join(tmpRoot, 'a', 'b', 'c');
    await mkdirp(realHost, dir);
    expect(await realHost.exists(dir)).toBe(true);
    // 幂等：已存在不报错
    await mkdirp(realHost, dir);
  });

  it('fake host：mkdirp 抛 EACCES → PermissionError(4)', async () => {
    const base = createFakeHost();
    const failing: Host = {
      ...base,
      mkdirp: async () => {
        throw errnoError('EACCES', 'permission denied');
      },
    };
    let caught: unknown;
    try {
      await mkdirp(failing, 'C:\\locked\\dir');
      expect.unreachable('should throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PermissionError);
    expect((caught as PermissionError).code).toBe(4);
    expect((caught as PermissionError).hint).toBeTruthy();
  });
});
