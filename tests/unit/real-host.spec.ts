/**
 * real-host 单测：node:fs / node:child_process 真实实现（UTF-8 剥 BOM / exec 超时 /
 * 长路径归一化经 longPathAware 等）。
 */
import { promises as fsp, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { realHost } from '../../src/infra/real-host';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'agf-host-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('文件操作（真实 fs）', () => {
  it('mkdirp → writeFile → readFile：中文 + 空格路径，UTF-8 往返', async () => {
    const file = path.join(tmpRoot, '目录 带空格', '笔记.md');
    await realHost.mkdirp(path.dirname(file));
    await realHost.writeFile(file, '# 中文标题\n- fnm / uv\n');
    expect(await realHost.readFile(file)).toBe('# 中文标题\n- fnm / uv\n');
  });

  it('readFile 剥离 UTF-8 BOM（Spec §2.1.1）', async () => {
    const file = path.join(tmpRoot, 'bom.md');
    writeFileSync(file, '\ufeffcontent with bom', 'utf8');
    expect(await realHost.readFile(file)).toBe('content with bom');
  });

  it('readFile 不存在 → reject', async () => {
    await expect(realHost.readFile(path.join(tmpRoot, 'no-such-file'))).rejects.toThrow();
  });

  it('exists：存在 true / 不存在 false', async () => {
    const file = path.join(tmpRoot, 'exists.txt');
    await realHost.writeFile(file, 'x');
    expect(await realHost.exists(file)).toBe(true);
    expect(await realHost.exists(path.join(tmpRoot, 'missing.txt'))).toBe(false);
  });

  it('listDir：返回直接子项名', async () => {
    const dir = path.join(tmpRoot, 'listdir');
    await realHost.mkdirp(dir);
    await realHost.writeFile(path.join(dir, 'a.md'), 'a');
    await realHost.writeFile(path.join(dir, 'b.md'), 'b');
    expect(await realHost.listDir(dir)).toEqual(['a.md', 'b.md']);
  });

  it('stat：文件元数据', async () => {
    const file = path.join(tmpRoot, 'stat.txt');
    await realHost.writeFile(file, '0123456789');
    const stat = await realHost.stat(file);
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBe(10);
    expect(stat.mtimeMs).toBeGreaterThan(0);
  });

  it('rename：移动后原路径消失', async () => {
    const from = path.join(tmpRoot, 'rename-from.md');
    const to = path.join(tmpRoot, 'rename-to.md');
    await realHost.writeFile(from, 'data');
    await realHost.rename(from, to);
    expect(await realHost.exists(from)).toBe(false);
    expect(await realHost.readFile(to)).toBe('data');
  });

  it('rm：删除后不存在；rm 不存在不抛（force 语义）', async () => {
    const file = path.join(tmpRoot, 'rm-me.md');
    await realHost.writeFile(file, 'x');
    await realHost.rm(file);
    expect(await realHost.exists(file)).toBe(false);
    await expect(realHost.rm(file)).resolves.toBeUndefined();
  });

  it('clearReadonly：可执行且不报错（win32 清只读属性，posix no-op）', async () => {
    const file = path.join(tmpRoot, 'readonly.txt');
    await realHost.writeFile(file, 'x');
    await expect(realHost.clearReadonly(file)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('copyMode：POSIX 上把源权限位复制到目标', async () => {
    const from = path.join(tmpRoot, 'mode-src.txt');
    const to = path.join(tmpRoot, 'mode-dst.txt');
    await realHost.writeFile(from, 'x');
    await realHost.writeFile(to, 'y');
    await fsp.chmod(from, 0o600);
    await fsp.chmod(to, 0o644);

    await realHost.copyMode(from, to);

    expect((await fsp.stat(to)).mode & 0o777).toBe(0o600);
  });
});

describe('exec（真实子进程）', () => {
  it('stdout 与退出码 0', async () => {
    const result = await realHost.exec(process.execPath, ['-e', 'console.log("hi")']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hi\n');
    expect(result.stderr).toBe('');
  });

  it('stderr 与非零退出码原样返回（不 reject）', async () => {
    const result = await realHost.exec(process.execPath, [
      '-e',
      'console.error("bad"); process.exit(3)',
    ]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('bad');
  });

  it('超时：杀掉子进程并返回约定码 124', async () => {
    const start = Date.now();
    const result = await realHost.exec(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      timeoutMs: 200,
    });
    const elapsed = Date.now() - start;
    expect(result.code).toBe(124);
    expect(elapsed).toBeLessThan(10_000); // 未等满 30s 即返回
  });

  it('env 注入：覆盖/追加环境变量', async () => {
    const result = await realHost.exec(
      process.execPath,
      ['-e', 'console.log(process.env.AGF_TEST_VAR)'],
      { env: { AGF_TEST_VAR: 'xyz-from-test' } },
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('xyz-from-test');
  });

  it('cwd：在指定目录执行', async () => {
    const result = await realHost.exec(process.execPath, ['-e', 'console.log(process.cwd())'], {
      cwd: tmpRoot,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim().toLowerCase()).toBe(path.resolve(tmpRoot).toLowerCase());
  });

  it('命令不存在 → 127（约定：无法启动）', async () => {
    const result = await realHost.exec('aforge-no-such-command-xyz', ['--version']);
    expect(result.code).toBe(127);
  });
});

describe('长路径归一化（Spec §2.1.1：所有接受路径参数的方法都经 longPathAware）', () => {
  /**
   * 白盒断言：spy 住 fs.promises，检查实现真正传下去的路径字符串。
   *
   * 为什么不用“黑盒地看能否成功读写”：libuv 内部对超长绝对路径也会自行加
   * `\\?\`，功能性用例在现代 Node 上无论归一化与否都会通过（长路径的功能覆盖见
   * paths-longpath.spec.ts）。要证明「每个方法都经过归一化」只能看调用参数。
   */
  const long = path.join(tmpRoot, 'n'.repeat(150), 'n'.repeat(80), 'missing.md');
  const long2 = path.join(tmpRoot, 'n'.repeat(150), 'n'.repeat(80), 'missing2.md');
  const norm = (p: string): string => (process.platform === 'win32' ? `\\\\?\\${p}` : p);
  const stub = (): Error => new Error('stub');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('长路径样本确实越过 240 阈值（前置条件）', () => {
    expect(long.length).toBeGreaterThan(240);
  });

  it('readFile / listDir / readlink 传归一化路径', async () => {
    const readFile = vi.spyOn(fsp, 'readFile').mockRejectedValue(stub());
    await realHost.readFile(long).catch(() => undefined);
    expect(readFile).toHaveBeenCalledWith(norm(long), 'utf8');

    const readdir = vi.spyOn(fsp, 'readdir').mockRejectedValue(stub());
    await realHost.listDir(long).catch(() => undefined);
    expect(readdir).toHaveBeenCalledWith(norm(long));

    const readlink = vi.spyOn(fsp, 'readlink').mockRejectedValue(stub());
    await realHost.readlink(long).catch(() => undefined);
    expect(readlink).toHaveBeenCalledWith(norm(long), 'utf8');
  });

  it('writeFile / mkdirp / rm / 权限位方法传归一化路径', async () => {
    const writeFile = vi.spyOn(fsp, 'writeFile').mockRejectedValue(stub());
    await realHost.writeFile(long, 'x').catch(() => undefined);
    expect(writeFile).toHaveBeenCalledWith(norm(long), 'x', 'utf8');

    const mkdir = vi.spyOn(fsp, 'mkdir').mockRejectedValue(stub());
    await realHost.mkdirp(long).catch(() => undefined);
    expect(mkdir).toHaveBeenCalledWith(norm(long), { recursive: true });

    const rm = vi.spyOn(fsp, 'rm').mockRejectedValue(stub());
    await realHost.rm(long).catch(() => undefined);
    expect(rm).toHaveBeenCalledWith(norm(long), { recursive: true, force: true });

    const chmod = vi.spyOn(fsp, 'chmod').mockRejectedValue(stub());
    if (process.platform === 'win32') {
      await realHost.clearReadonly(long).catch(() => undefined);
      expect(chmod).toHaveBeenCalledWith(norm(long), 0o666);
    } else {
      // posix 上 clearReadonly 是 no-op（0o666 会真实放宽权限），改由 copyMode 覆盖
      vi.spyOn(fsp, 'stat').mockResolvedValue({ mode: 0o100600 } as never);
      await realHost.copyMode(long, long2).catch(() => undefined);
      expect(chmod).toHaveBeenCalledWith(norm(long2), 0o600);
    }
  });

  it('exists / stat / lstat 传归一化路径', async () => {
    const access = vi.spyOn(fsp, 'access').mockRejectedValue(stub());
    expect(await realHost.exists(long)).toBe(false);
    expect(access).toHaveBeenCalledWith(norm(long));

    const stat = vi.spyOn(fsp, 'stat').mockRejectedValue(stub());
    await realHost.stat(long).catch(() => undefined);
    expect(stat).toHaveBeenCalledWith(norm(long));

    const lstat = vi.spyOn(fsp, 'lstat').mockRejectedValue(stub());
    await realHost.lstat(long).catch(() => undefined);
    expect(lstat).toHaveBeenCalledWith(norm(long));
  });

  it('rename 的 from 与 to 都归一化（回归：只归一化一端会撕裂 atomicWrite）', async () => {
    const rename = vi.spyOn(fsp, 'rename').mockRejectedValue(stub());
    await realHost.rename(long, long2).catch(() => undefined);
    expect(rename).toHaveBeenCalledWith(norm(long), norm(long2));
  });

  it('短路径原样传递（不加前缀）', async () => {
    const short = path.join(tmpRoot, 'short.md');
    const readFile = vi.spyOn(fsp, 'readFile').mockRejectedValue(stub());
    await realHost.readFile(short).catch(() => undefined);
    expect(readFile).toHaveBeenCalledWith(short, 'utf8');
  });
});

describe('now / env', () => {
  it('now 返回当前时间附近的 Date', () => {
    const before = Date.now();
    const now = realHost.now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('env 读取进程环境变量', () => {
    // PATH 在三大平台均为关键环境变量，必然存在
    expect(realHost.env('PATH')).toBeTruthy();
    expect(realHost.env('AGF_ENV_DEFINITELY_NOT_SET_12345')).toBeUndefined();
  });
});
