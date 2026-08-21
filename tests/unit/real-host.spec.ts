/**
 * real-host 单测：node:fs / node:child_process 真实实现（UTF-8 剥 BOM / exec 超时等）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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

  it('chmod：可执行且不报错（0o666）', async () => {
    const file = path.join(tmpRoot, 'chmod.txt');
    await realHost.writeFile(file, 'x');
    await expect(realHost.chmod(file, 0o666)).resolves.toBeUndefined();
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
