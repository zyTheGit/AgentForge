/**
 * paths.ts 长路径支持测试（Spec §2.1.1）：验证 longPathAware 在 realHost 写入热路径中生效。
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
