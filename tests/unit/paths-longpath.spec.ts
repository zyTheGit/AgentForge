/**
 * paths.ts 长路径支持测试（Spec §2.1.1）：验证 longPathAware 在 realHost 全部
 * 路径方法（不只写入热路径）中生效，尤其是 atomicWrite 的 tmp → rename 链路。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { atomicWrite, mkdirp } from '../../src/infra/fsutil';
import { realHost } from '../../src/infra/real-host';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'agf-longpath-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('longPathAware 接入 realHost 写入热路径', () => {
  it('长路径目录创建成功（>240 字符，Windows 下加 \\\\?\\ 前缀）', async () => {
    // 构造一个超过 240 字符的路径
    const longSegment = 'a'.repeat(200);
    const targetDir = path.join(tmpRoot, longSegment, 'nested', 'deep');

    await mkdirp(realHost, targetDir);
    expect(await realHost.exists(targetDir)).toBe(true);
  });

  it('长路径文件写入成功（atomicWrite 经 realHost.writeFile）', async () => {
    const longSegment = 'b'.repeat(200);
    const targetFile = path.join(tmpRoot, longSegment, 'test.md');

    await mkdirp(realHost, path.dirname(targetFile));
    await atomicWrite(realHost, targetFile, '# 长路径测试\n');

    expect(await realHost.exists(targetFile)).toBe(true);
    expect(await realHost.readFile(targetFile)).toBe('# 长路径测试\n');
  });

  it('中文 + 空格 + 长路径组合（压力测试）', async () => {
    const longSegment = '规则目录'.repeat(50); // 200 字符
    const targetFile = path.join(tmpRoot, longSegment, 'AGENTS.md');

    await mkdirp(realHost, path.dirname(targetFile));
    await atomicWrite(realHost, targetFile, '# 规则\n');

    expect(await realHost.exists(targetFile)).toBe(true);
    expect(await realHost.readFile(targetFile)).toBe('# 规则\n');
  });
});

describe('longPathAware 覆盖 atomicWrite 的 tmp → rename 链路（回归）', () => {
  /**
   * 回归点：atomicWrite 的临时名 `<target>.agf-<12hex>.tmp` 比 target 长约 21 字符。
   * 修复前只有 writeFile/mkdirp 归一化，target 落在“自身够短、tmp 超长”的窗口时
   * tmp 写入走 `\\?\` 成功、rename/exists 用裸路径失败 —— 抛非权限类原始错误，
   * 且 `.agf-*.tmp` 永久残留。现在所有方法统一归一化，两侧一致。
   */
  it('target 自身不超 MAX_PATH 但 tmp 名超出：写入成功且不残留 .agf-*.tmp', async () => {
    const dir = path.join(tmpRoot, 'w'.repeat(120), 'w'.repeat(60));
    await mkdirp(realHost, dir);
    // 目标长度落在 240~259：tmp（+21）越过 MAX_PATH(260)，target 自身没有
    const fill = Math.max(1, 250 - dir.length - 1 - '.md'.length);
    const targetFile = path.join(dir, `${'t'.repeat(fill)}.md`);
    expect(targetFile.length).toBeGreaterThan(240);
    expect(targetFile.length).toBeLessThan(260);
    expect(`${targetFile}.agf-000000000000.tmp`.length).toBeGreaterThan(260);

    await atomicWrite(realHost, targetFile, '# rules\n');
    expect(await realHost.readFile(targetFile)).toBe('# rules\n');

    const leftovers = (await realHost.listDir(dir)).filter((name) => name.includes('.agf-'));
    expect(leftovers).toEqual([]);
  });

  it('rename / exists 在超 MAX_PATH 的路径上均经 \\\\?\\ 归一化（两端都要）', async () => {
    const dir = path.join(tmpRoot, 'r'.repeat(150), 'r'.repeat(80));
    await mkdirp(realHost, dir);
    const from = path.join(dir, `${'f'.repeat(60)}.md`);
    const to = path.join(dir, `${'g'.repeat(60)}.md`);
    expect(from.length).toBeGreaterThan(260);

    await realHost.writeFile(from, 'data');
    expect(await realHost.exists(from)).toBe(true);
    await realHost.rename(from, to);
    expect(await realHost.exists(from)).toBe(false);
    expect(await realHost.exists(to)).toBe(true);
    expect(await realHost.readFile(to)).toBe('data');
  });

  it('stat / lstat / chmod / rm 在超 MAX_PATH 的路径上可用', async () => {
    const dir = path.join(tmpRoot, 's'.repeat(150), 's'.repeat(80));
    await mkdirp(realHost, dir);
    const file = path.join(dir, `${'v'.repeat(60)}.md`);
    expect(file.length).toBeGreaterThan(260);

    await realHost.writeFile(file, '0123456789');
    expect((await realHost.stat(file)).size).toBe(10);
    expect((await realHost.lstat(file)).isFile).toBe(true);
    await expect(realHost.chmod(file, 0o666)).resolves.toBeUndefined();
    await realHost.rm(file);
    expect(await realHost.exists(file)).toBe(false);
  });
});
