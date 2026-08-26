/**
 * shell 单测：whereExe / gitExec 经 fake host（可编程 exec）验证命令拼装与结果解析；
 * 另含一条真实 git 调用（CI 与开发机均预装 git）。
 *
 * 另覆盖 §10 安全边界：resolveExecutable 只在 PATH 的**绝对**目录里找可执行文件
 * （不搜索 cwd），gitExec / whereExe 在 win32 解析不到时 fail-closed（127 / []），
 * 包括 PATH 不可读的情形——绝不退回裸命令名。
 */
import { describe, expect, it } from 'vitest';
import type { ExecOptions, ExecResult } from '../../src/infra/host';
import { realHost } from '../../src/infra/real-host';
import { GIT_TIMEOUT_MS, gitExec, resolveExecutable, whereExe } from '../../src/infra/shell';
import { createFakeHost, type FakeHost } from './test-utils';

interface ExecCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly opts: ExecOptions | undefined;
}

/** fake host + 可编程 exec（记录调用，返回预设结果）。 */
function hostWithExec(
  result: ExecResult,
  env: Record<string, string> = {},
): { host: FakeHost; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const base = createFakeHost(env);
  const host: FakeHost = {
    ...base,
    exec(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      return Promise.resolve(result);
    },
  };
  return { host, calls };
}

/** win32 PATH 上的可执行文件（gitExec / whereExe 只 spawn 解析出的绝对路径）。 */
const BIN_DIR = 'C:\\tools\\bin';
const GIT_ABS = `${BIN_DIR}\\git.exe`;
const WHERE_ABS = `${BIN_DIR}\\where.exe`;

/** fake host，PATH 上备好 git.exe 与 where.exe（win32 路径可解析）。 */
function win32HostWithTools(result: ExecResult): { host: FakeHost; calls: ExecCall[] } {
  const made = hostWithExec(result, { PATH: BIN_DIR, PATHEXT: '.exe' });
  made.host.files.set(GIT_ABS, 'binary');
  made.host.files.set(WHERE_ABS, 'binary');
  return made;
}

describe('whereExe', () => {
  it('win32：调 where.exe <name>（PATH 解析出的绝对路径），解析多行输出（CRLF/LF 混合并去空行）', async () => {
    const { host, calls } = win32HostWithTools({
      stdout: 'C:\\a\\git.exe\r\nC:\\b\\git.exe\n\r\n',
      stderr: '',
      code: 0,
    });
    const hits = await whereExe(host, 'git', { platform: 'win32' });
    expect(hits).toEqual(['C:\\a\\git.exe', 'C:\\b\\git.exe']);
    expect(calls[0]?.cmd).toBe(WHERE_ABS);
    expect(calls[0]?.args).toEqual(['git']);
  });

  it('win32：未命中（code 1）→ 空数组', async () => {
    const { host } = win32HostWithTools({
      stdout: '',
      stderr: 'INFO: Could not find files',
      code: 1,
    });
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
    const { host, calls } = win32HostWithTools({ stdout: '', stderr: '', code: 0 });
    await whereExe(host, 'git', { platform: 'win32' });
    expect(calls[0]?.opts?.timeoutMs).toBe(10_000);
  });
});

describe('gitExec', () => {
  it('透传 args 与 cwd，默认超时 30s（GIT_TIMEOUT_MS）', async () => {
    const { host, calls } = win32HostWithTools({
      stdout: 'git version 2.44.0\n',
      stderr: '',
      code: 0,
    });
    const result = await gitExec(host, ['--version'], { cwd: 'C:/repo', platform: 'win32' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('git version');
    expect(calls[0]?.cmd).toBe(GIT_ABS);
    expect(calls[0]?.args).toEqual(['--version']);
    expect(calls[0]?.opts?.timeoutMs).toBe(GIT_TIMEOUT_MS);
    expect(calls[0]?.opts?.cwd).toBe('C:/repo');
  });

  it('git 无法启动（exec 报 code 127）→ 原样返回 127，不抛错', async () => {
    const { host } = win32HostWithTools({ stdout: '', stderr: 'spawn git ENOENT', code: 127 });
    const result = await gitExec(host, ['status'], { platform: 'win32' });
    expect(result.code).toBe(127);
  });

  it('超时（code 124）原样返回', async () => {
    const { host } = win32HostWithTools({ stdout: '', stderr: '', code: 124 });
    const result = await gitExec(host, ['fetch', '--all'], { platform: 'win32' });
    expect(result.code).toBe(124);
  });

  it('真实环境：git --version 成功（CI 与开发机预装 git）', async () => {
    const result = await gitExec(realHost, ['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/git version/);
  });
});

describe('resolveExecutable（§10：不在 cwd 搜索可执行文件）', () => {
  it('win32：按 PATHEXT 展开并返回 PATH 中的绝对路径', async () => {
    // fake host 的内存 fs 区分大小写，PATHEXT 显式给小写以对齐键名（真实 NTFS 不敏感）
    const { host } = hostWithExec(
      { stdout: '', stderr: '', code: 0 },
      { PATH: 'C:\\tools\\bin', PATHEXT: '.com;.exe' },
    );
    host.files.set('C:\\tools\\bin\\git.exe', 'binary');
    expect(await resolveExecutable(host, 'git', { platform: 'win32' })).toBe(
      'C:\\tools\\bin\\git.exe',
    );
  });

  it('win32：PATH 中的相对项（. / 空 / 相对目录）被丢弃——不接受 cwd 里的 git.exe', async () => {
    const { host } = hostWithExec(
      { stdout: '', stderr: '', code: 0 },
      { PATH: '.;;bin;C:\\tools\\bin', PATHEXT: '.exe' },
    );
    // cwd 相对项对应的候选存在也不能命中
    host.files.set('git.exe', 'evil');
    host.files.set('.\\git.exe', 'evil');
    host.files.set('bin\\git.exe', 'evil');
    host.files.set('C:\\tools\\bin\\git.exe', 'binary');
    expect(await resolveExecutable(host, 'git', { platform: 'win32' })).toBe(
      'C:\\tools\\bin\\git.exe',
    );
  });

  it('win32：PATH 引号剥离；PATHEXT 自定义顺序生效', async () => {
    const { host } = hostWithExec(
      { stdout: '', stderr: '', code: 0 },
      { PATH: '"C:\\Program Files\\Git\\cmd"', PATHEXT: '.cmd;.exe' },
    );
    host.files.set('C:\\Program Files\\Git\\cmd\\git.cmd', 'shim');
    expect(await resolveExecutable(host, 'git', { platform: 'win32' })).toBe(
      'C:\\Program Files\\Git\\cmd\\git.cmd',
    );
  });

  it('posix：不展开后缀，命中 PATH 绝对目录', async () => {
    const { host } = hostWithExec({ stdout: '', stderr: '', code: 0 }, { PATH: 'rel:/usr/bin' });
    host.files.set('rel/git', 'evil');
    host.files.set('/usr/bin/git', 'binary');
    expect(await resolveExecutable(host, 'git', { platform: 'linux' })).toBe('/usr/bin/git');
  });

  it('PATH 不可读 → undefined（win32 调用方据此 fail-closed，posix 退回裸命令名）', async () => {
    const { host } = hostWithExec({ stdout: '', stderr: '', code: 0 });
    expect(await resolveExecutable(host, 'git', { platform: 'win32' })).toBeUndefined();
  });

  it('name 含分隔符：绝对路径原样返回，相对路径拒绝', async () => {
    const { host } = hostWithExec({ stdout: '', stderr: '', code: 0 }, { PATH: 'C:\\tools' });
    expect(await resolveExecutable(host, 'C:\\git\\git.exe', { platform: 'win32' })).toBe(
      'C:\\git\\git.exe',
    );
    expect(await resolveExecutable(host, '.\\git.exe', { platform: 'win32' })).toBeUndefined();
  });
});

describe('gitExec 可执行文件解析（§10）', () => {
  it('win32：spawn 的是 PATH 里解析出的绝对路径，而非裸 "git"', async () => {
    const { host, calls } = hostWithExec(
      { stdout: '', stderr: '', code: 0 },
      { PATH: 'C:\\tools\\bin', PATHEXT: '.exe' },
    );
    host.files.set('C:\\tools\\bin\\git.exe', 'binary');
    await gitExec(host, ['status'], { platform: 'win32' });
    expect(calls[0]?.cmd).toBe('C:\\tools\\bin\\git.exe');
    expect(calls[0]?.args).toEqual(['status']);
    expect(calls[0]?.opts?.timeoutMs).toBe(GIT_TIMEOUT_MS);
  });

  it('win32：PATH 可读但解析不到 git → code 127，且不 spawn 裸命令名（避免 cwd 里的 git.exe）', async () => {
    const { host, calls } = hostWithExec(
      { stdout: '', stderr: '', code: 0 },
      { PATH: 'C:\\tools\\bin' },
    );
    const result = await gitExec(host, ['status'], { platform: 'win32' });
    expect(result.code).toBe(127);
    expect(calls).toHaveLength(0);
  });

  it('win32：PATH 完全不可读 → 同样 fail-closed（127 / []），不退回裸命令名', async () => {
    // 回归：旧实现在 PATH 读不到时退回裸 `git` / `where.exe`，这恰是 round-1 修掉的
    // Windows cwd 劫持路径——"读不到 PATH"不是放宽边界的理由。
    const { host, calls } = hostWithExec({ stdout: '', stderr: '', code: 0 });
    const result = await gitExec(host, ['status'], { platform: 'win32' });
    expect(result.code).toBe(127);
    expect(await whereExe(host, 'git', { platform: 'win32' })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('posix：解析不到时退回裸命令名（execFile 不经 shell，posix 不搜索 cwd）', async () => {
    const { host, calls } = hostWithExec({ stdout: '', stderr: '', code: 0 }, { PATH: '/usr/bin' });
    await gitExec(host, ['status'], { platform: 'linux' });
    expect(calls[0]?.cmd).toBe('git');
  });

  it('platform 选项不透传给 Host.exec（仅内部使用）', async () => {
    const { host, calls } = hostWithExec({ stdout: '', stderr: '', code: 0 });
    await gitExec(host, ['status'], { platform: 'linux', cwd: '/repo' });
    expect(calls[0]?.opts).toEqual({ cwd: '/repo', timeoutMs: GIT_TIMEOUT_MS });
  });
});
