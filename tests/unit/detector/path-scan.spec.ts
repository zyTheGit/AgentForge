/**
 * path-scan 单测：fake host（可编程 listDir / env），覆盖 PATHEXT 展开、
 * 大小写语义、PATH 分隔符、目录缺失跳过、目录优先级与引号剥离。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanPath } from '../../../src/core/detector/path-scan';
import { makeDetectHost } from './helpers';

describe('scanPath (win32)', () => {
  it('按默认 PATHEXT 命中 fnm.exe（非可执行扩展不误报）', async () => {
    const host = makeDetectHost({
      dirs: { 'C:/bin': ['fnm.exe', 'readme.txt'] },
      files: {},
      env: { PATH: 'C:/bin' },
    });
    const result = await scanPath(host, ['fnm', 'readme'], { platform: 'win32' });
    expect(result.get('fnm')).toBe(path.win32.resolve('C:/bin', 'fnm.exe'));
    expect(result.has('readme')).toBe(false);
  });

  it('命中 fnm.cmd（.CMD 在默认 PATHEXT 中）', async () => {
    const host = makeDetectHost({
      dirs: { 'C:/tools': ['fnm.cmd'] },
      files: {},
      env: { PATH: 'C:/tools' },
    });
    const result = await scanPath(host, ['fnm'], { platform: 'win32' });
    expect(result.get('fnm')).toBe(path.win32.resolve('C:/tools', 'fnm.cmd'));
  });

  it('PATHEXT 自定义扩展同样命中（含大小写差异）', async () => {
    const host = makeDetectHost({
      dirs: { 'C:/bin': ['fnm.foo'] },
      files: {},
      env: { PATH: 'C:/bin', PATHEXT: '.FOO' },
    });
    const result = await scanPath(host, ['fnm'], { platform: 'win32' });
    expect(result.get('fnm')).toBe(path.win32.resolve('C:/bin', 'fnm.foo'));
  });

  it('同目录多扩展命中时按 PATHEXT 顺序取（.EXE 先于 .CMD）', async () => {
    const host = makeDetectHost({
      dirs: { 'C:/bin': ['fnm.cmd', 'fnm.exe'] },
      files: {},
      env: { PATH: 'C:/bin' },
    });
    const result = await scanPath(host, ['fnm'], { platform: 'win32' });
    expect(result.get('fnm')).toBe(path.win32.resolve('C:/bin', 'fnm.exe'));
  });

  it('大小写不敏感匹配且路径保留磁盘上的真实文件名', async () => {
    const host = makeDetectHost({
      dirs: { 'C:/bin': ['FNM.EXE'] },
      files: {},
      env: { PATH: 'C:/bin' },
    });
    const result = await scanPath(host, ['fnm'], { platform: 'win32' });
    expect(result.get('fnm')).toBe(path.win32.resolve('C:/bin', 'FNM.EXE'));
  });

  it('PATH 以分号分隔，靠前的目录优先命中', async () => {
    const host = makeDetectHost({
      dirs: { 'C:/first': ['git.exe'], 'C:/second': ['git.exe'] },
      files: {},
      env: { PATH: 'C:/first;C:/second' },
    });
    const result = await scanPath(host, ['git'], { platform: 'win32' });
    expect(result.get('git')).toBe(path.win32.resolve('C:/first', 'git.exe'));
  });

  it('目录不存在 / 不可读时跳过（不抛错）', async () => {
    const host = makeDetectHost({
      dirs: { 'C:/bin': ['node.exe'] },
      files: {},
      env: { PATH: 'C:/missing;C:/bin' },
    });
    const result = await scanPath(host, ['node'], { platform: 'win32' });
    expect(result.get('node')).toBe(path.win32.resolve('C:/bin', 'node.exe'));
  });

  it('PATH 条目带引号时剥离后匹配', async () => {
    const host = makeDetectHost({
      dirs: { 'C:/Program Files/x': ['fnm.exe'] },
      files: {},
      env: { PATH: '"C:/Program Files/x"' },
    });
    const result = await scanPath(host, ['fnm'], { platform: 'win32' });
    expect(result.get('fnm')).toBe(path.win32.resolve('C:/Program Files/x', 'fnm.exe'));
  });

  it('空 PATH 条目跳过；末尾多余分隔符无害', async () => {
    const host = makeDetectHost({
      dirs: { 'C:/bin': ['fnm.exe'] },
      files: {},
      env: { PATH: ';C:/bin;;' },
    });
    const result = await scanPath(host, ['fnm'], { platform: 'win32' });
    expect(result.get('fnm')).toBe(path.win32.resolve('C:/bin', 'fnm.exe'));
  });

  it('相对 PATH 条目按 cwd 绝对化', async () => {
    const host = makeDetectHost({
      dirs: { 'C:/proj/bin': ['fnm.exe'] },
      files: {},
      env: { PATH: 'bin' },
    });
    const result = await scanPath(host, ['fnm'], { platform: 'win32', cwd: 'C:/proj' });
    expect(result.get('fnm')).toBe(path.win32.resolve('C:/proj/bin', 'fnm.exe'));
  });
});

describe('scanPath (posix)', () => {
  it('匹配无扩展名文件', async () => {
    const host = makeDetectHost({
      dirs: { '/usr/local/bin': ['fnm'] },
      files: {},
      env: { PATH: '/usr/local/bin' },
    });
    const result = await scanPath(host, ['fnm'], { platform: 'linux' });
    expect(result.get('fnm')).toBe('/usr/local/bin/fnm');
  });

  it('大小写敏感：FNM 不命中 fnm', async () => {
    const host = makeDetectHost({
      dirs: { '/usr/bin': ['FNM'] },
      files: {},
      env: { PATH: '/usr/bin' },
    });
    const result = await scanPath(host, ['fnm'], { platform: 'linux' });
    expect(result.has('fnm')).toBe(false);
  });

  it('PATH 以冒号分隔；空条目跳过', async () => {
    const host = makeDetectHost({
      dirs: { '/usr/bin': ['node', 'python'] },
      files: {},
      env: { PATH: ':/usr/bin:/opt/missing:' },
    });
    const result = await scanPath(host, ['node', 'python'], { platform: 'linux' });
    expect(result.get('node')).toBe('/usr/bin/node');
    expect(result.get('python')).toBe('/usr/bin/python');
  });

  it('带扩展名的文件不误报为可执行名', async () => {
    const host = makeDetectHost({
      dirs: { '/usr/bin': ['fnm.exe'] },
      files: {},
      env: { PATH: '/usr/bin' },
    });
    const result = await scanPath(host, ['fnm'], { platform: 'linux' });
    expect(result.has('fnm')).toBe(false);
  });
});

describe('scanPath 边界', () => {
  it('PATH 未设置 → 空 Map', async () => {
    const host = makeDetectHost({ dirs: { 'C:/bin': ['fnm.exe'] }, files: {}, env: {} });
    const result = await scanPath(host, ['fnm'], { platform: 'win32' });
    expect(result.size).toBe(0);
  });

  it('PATH 为空白 → 空 Map', async () => {
    const host = makeDetectHost({ dirs: {}, files: {}, env: { PATH: '   ' } });
    const result = await scanPath(host, ['fnm'], { platform: 'win32' });
    expect(result.size).toBe(0);
  });

  it('execNames 为空 → 空 Map', async () => {
    const host = makeDetectHost({ dirs: { 'C:/bin': ['fnm.exe'] }, files: {}, env: { PATH: 'C:/bin' } });
    const result = await scanPath(host, [], { platform: 'win32' });
    expect(result.size).toBe(0);
  });

  it('一次扫描多个名字，未命中的不出现', async () => {
    const host = makeDetectHost({
      dirs: { 'C:/bin': ['fnm.exe', 'uv.exe', 'pnpm.cmd'] },
      files: {},
      env: { PATH: 'C:/bin' },
    });
    const result = await scanPath(host, ['fnm', 'uv', 'pnpm', 'miss'], { platform: 'win32' });
    expect([...result.keys()].sort()).toEqual(['fnm', 'pnpm', 'uv']);
    expect(result.has('miss')).toBe(false);
  });
});
