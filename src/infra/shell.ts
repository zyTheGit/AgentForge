/**
 * 子进程探测工具：where/which 查询与 git 调用（Spec §7.2 Detect 顺序第 2 步）。
 *
 * - 全部经注入的 Host.exec（可 mock，不直接触碰 node:child_process）；
 * - whereExe：Windows 用 where.exe、类 Unix 用 which -a，返回命中路径数组（未命中 → 空数组）；
 * - gitExec：spawn git，默认超时 30s；git 不存在（无法启动）时 Host.exec 按约定
 *   返回 code=127（real-host 对 ENOENT 的映射），调用方以 code 判定，无需 try/catch。
 *
 * 安全边界（§10）：Windows 的 CreateProcess 在解析裸命令名（`git`）时**先搜索
 * 当前工作目录**，在含恶意 `git.exe` 的目录里运行 aforge 会执行该文件。因此本
 * 模块统一先用 resolveExecutable 在 PATH 上解析出**绝对路径**再 spawn：
 * - PATH 中的相对项（`''` / `.` / 相对目录）一律丢弃——它们等价于 cwd 搜索；
 * - **win32 解析不到绝对路径即失败**（gitExec → code=127，whereExe → `[]`），
 *   无论 PATH 是否可读：PATH 读不到时退回裸命令名恰好又落回 cwd 劫持路径，
 *   "读不到 PATH"不是放宽边界的理由（fail-closed）；
 * - 非 win32 解析不到时才退回裸命令名——execFile 不经 shell，POSIX 的 PATH
 *   解析不含 cwd，无同类劫持面。
 * spawn 侧恒不经 shell（real-host 用 execFile，无 shell 选项）。
 */
import path from 'node:path';
import type { ExecOptions, ExecResult, Host } from './host';

/** where/which 查询默认超时（探测类命令应快速失败）。 */
const WHERE_TIMEOUT_MS = 10_000;

/** git 调用默认超时：git 偶尔弹凭证交互/慢仓库，30s 兜底（到期 code=124）。 */
export const GIT_TIMEOUT_MS = 30_000;

/** Windows PATHEXT 缺失时的兜底可执行后缀集合。 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** git 可执行文件名（PATH 解析的输入）。 */
const GIT_EXE = 'git';

export interface WhereExeOptions {
  /** 平台（process.platform 值）；win32 → where.exe，其余 → which。 */
  readonly platform?: string;
  /** 超时毫秒（默认 10s）。 */
  readonly timeoutMs?: number;
}

export interface ResolveExecutableOptions {
  /** 平台（默认 process.platform）；决定 PATH 分隔符与 PATHEXT 语义。 */
  readonly platform?: string;
}

/** 读 PATH（Windows 环境变量大小写不敏感，逐个候选键尝试）。 */
function pathEnvOf(host: Host): string | undefined {
  const raw = host.env('PATH') ?? host.env('Path') ?? host.env('path');
  return raw === undefined || raw.trim() === '' ? undefined : raw;
}

/** Windows 候选文件名：name 已带 PATHEXT 后缀则原样，否则逐个后缀展开。 */
function windowsCandidates(host: Host, name: string): string[] {
  const exts = (host.env('PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext !== '');
  const lower = name.toLowerCase();
  if (exts.some((ext) => lower.endsWith(ext.toLowerCase()))) {
    return [name];
  }
  return exts.map((ext) => `${name}${ext}`);
}

/**
 * 在 PATH 上解析可执行文件的**绝对路径**（不搜索 cwd，不经 shell）。
 *
 * @param name 裸命令名（`git`）或已带后缀的名字（`where.exe`）；含分隔符时视为
 *        调用方给定的路径——绝对路径原样返回，相对路径拒绝（避免 cwd 相对解析）。
 * @returns 命中的绝对路径；PATH 不可读或全部候选不存在 → undefined。
 */
export async function resolveExecutable(
  host: Host,
  name: string,
  opts: ResolveExecutableOptions = {},
): Promise<string | undefined> {
  const win32 = (opts.platform ?? process.platform) === 'win32';
  const api = win32 ? path.win32 : path.posix;

  if (name.includes('/') || (win32 && name.includes('\\'))) {
    return api.isAbsolute(name) ? name : undefined;
  }

  const rawPath = pathEnvOf(host);
  if (rawPath === undefined) {
    return undefined;
  }
  const dirs = rawPath
    .split(win32 ? ';' : ':')
    .map((entry) => entry.trim().replace(/^"+|"+$/g, ''))
    // 相对项（含空项与 '.'）等价于"按 cwd 搜索"，必须丢弃
    .filter((entry) => entry !== '' && api.isAbsolute(entry));

  const candidates = win32 ? windowsCandidates(host, name) : [name];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = api.join(dir, candidate);
      if (await host.exists(full)) {
        return full;
      }
    }
  }
  return undefined;
}

/**
 * 在 PATH 上查找可执行文件：返回全部命中路径（按输出顺序），未命中返回空数组。
 * 失败永不抛出（Host.exec 约定：非零 code 表达失败）。
 *
 * where.exe / which 自身也先经 resolveExecutable 解析绝对路径（避免 cwd 内的
 * 同名可执行文件被优先启动）；win32 解析不到 where.exe → `[]`（不 spawn 裸名）。
 */
export async function whereExe(
  host: Host,
  name: string,
  opts: WhereExeOptions = {},
): Promise<string[]> {
  const platform = opts.platform ?? process.platform;
  const win32 = platform === 'win32';
  const cmd = win32 ? 'where.exe' : 'which';
  const args = win32 ? [name] : ['-a', name];

  const resolved = await resolveExecutable(host, cmd, { platform });
  if (resolved === undefined && win32) {
    return [];
  }

  const result = await host.exec(resolved ?? cmd, args, {
    timeoutMs: opts.timeoutMs ?? WHERE_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export interface GitExecOptions extends ExecOptions {
  /** 平台（默认 process.platform）；win32 下拒绝以裸命令名 spawn。 */
  readonly platform?: string;
}

/**
 * 执行 git 子命令：默认 30s 超时；cwd/env 透传 Host.exec。
 * git 不存在（无法启动）→ code=127；超时 → code=124（Host.exec 约定）。
 *
 * git 可执行文件先经 resolveExecutable 解析为绝对路径（不搜索 cwd）；win32 解析
 * 不到时直接返回 code=127，不退回裸命令名（§10 安全边界，PATH 不可读时同样如此）。
 */
export async function gitExec(
  host: Host,
  args: readonly string[],
  opts: GitExecOptions = {},
): Promise<ExecResult> {
  const { platform: platformOpt, ...execOpts } = opts;
  const platform = platformOpt ?? process.platform;
  const execOptions: ExecOptions = { ...execOpts, timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS };

  const resolved = await resolveExecutable(host, GIT_EXE, { platform });
  if (resolved !== undefined) {
    return host.exec(resolved, args, execOptions);
  }
  if (platform === 'win32') {
    return {
      stdout: '',
      stderr:
        'git 未在 PATH 中找到（或 PATH 不可读）；拒绝以裸命令名 spawn（Windows CreateProcess 会先搜索当前目录）',
      code: 127,
    };
  }
  return host.exec(GIT_EXE, args, execOptions);
}
