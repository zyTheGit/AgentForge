/**
 * shell 单测：whereExe / gitExec 经 fake host（可编程 exec）验证命令拼装与结果解析；
 * 另含一条真实 git 调用（CI 与开发机均预装 git）。
 */
import { describe, expect, it } from 'vitest';
import type { ExecOptions, ExecResult, Host } from '../../src/infra/host';
import { realHost } from '../../src/infra/real-host';
import { GIT_TIMEOUT_MS, gitExec, whereExe } from '../../src/infra/shell';
import { createFakeHost } from './test-utils';

interface ExecCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly opts: ExecOptions | undefined;
}

/** fake host + 可编程 exec（记录调用，返回预设结果）。 */
function hostWithExec(
  result: ExecResult,
  env: Record<string, string> = {},
): { host: Host; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const base = createFakeHost(env);
  const host: Host = {
    ...base,
    exec(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      return Promise.resolve(result);
    },
  };
  return { host, calls };
}

describe('whereExe', () => {
  it('win32：调 where.exe <name>，解析多行输出（CRLF/LF 混合并去空行）', async () => {
    const { host, calls } = hostWithExec({
      stdout: 'C:\\a\\git.exe\r\nC:\\b\\git.exe\n\r\n',
      stderr: '',
      code: 0,
    });
    const hits = await whereExe(host, 'git', { platform: 'win32' });
    expect(hits).toEqual(['C:\\a\\git.exe', 'C:\\b\\git.exe']);
    expect(calls[0]?.cmd).toBe('where.exe');
    expect(calls[0]?.args).toEqual(['git']);
  });

  it('win32：未命中（code 1）→ 空数组', async () => {
    const { host } = hostWithExec({ stdout: '', stderr: 'INFO: Could not find files', code: 1 });
    expect(await whereExe(host, 'git', { platform: 'win32' })).toEqual([]);
  });

  it('posix：调 which -a <name>', async () => {
    const { host, calls } = hostWithExec({ stdout: '/usr/bin/git\n', stderr: '', code: 0 });
    const hits = await whereExe(host, 'git', { platform: 'linux' });
    expect(hits).toEqual(['/usr/bin/git']);
    expect(calls[0]?.cmd).toBe('which');
    expect(calls[0]?.args).toEqual(['-a', 'git']);
  });

  it('posix：未命中（code 1）→ 空数组', async () => {
    const { host } = hostWithExec({ stdout: '', stderr: '', code: 1 });
    expect(await whereExe(host, 'git', { platform: 'darwin' })).toEqual([]);
  });

  it('默认超时 10s 传入 exec', async () => {
    const { host, calls } = hostWithExec({ stdout: '', stderr: '', code: 0 });
    await whereExe(host, 'git', { platform: 'win32' });
    expect(calls[0]?.opts?.timeoutMs).toBe(10_000);
  });
});

describe('gitExec', () => {
  it('透传 args 与 cwd，默认超时 30s（GIT_TIMEOUT_MS）', async () => {
    const { host, calls } = hostWithExec({ stdout: 'git version 2.44.0\n', stderr: '', code: 0 });
    const result = await gitExec(host, ['--version'], { cwd: 'C:/repo' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('git version');
    expect(calls[0]?.cmd).toBe('git');
    expect(calls[0]?.args).toEqual(['--version']);
    expect(calls[0]?.opts?.timeoutMs).toBe(GIT_TIMEOUT_MS);
    expect(calls[0]?.opts?.cwd).toBe('C:/repo');
  });

  it('git 不存在（无法启动，code 127）→ 原样返回 127，不抛错', async () => {
    const { host } = hostWithExec({ stdout: '', stderr: 'spawn git ENOENT', code: 127 });
    const result = await gitExec(host, ['status']);
    expect(result.code).toBe(127);
  });

  it('超时（code 124）原样返回', async () => {
    const { host } = hostWithExec({ stdout: '', stderr: '', code: 124 });
    const result = await gitExec(host, ['fetch', '--all']);
    expect(result.code).toBe(124);
  });

  it('真实环境：git --version 成功（CI 与开发机预装 git）', async () => {
    const result = await gitExec(realHost, ['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/git version/);
  });
});
