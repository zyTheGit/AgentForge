/**
 * 子进程探测工具：where/which 查询与 git 调用（Spec §7.2 Detect 顺序第 2 步）。
 *
 * - 全部经注入的 Host.exec（可 mock，不直接触碰 node:child_process）；
 * - whereExe：Windows 用 where.exe、类 Unix 用 which -a，返回命中路径数组（未命中 → 空数组）；
 * - gitExec：spawn git，默认超时 30s；git 不存在（无法启动）时 Host.exec 按约定
 *   返回 code=127（real-host 对 ENOENT 的映射），调用方以 code 判定，无需 try/catch。
 */
import type { ExecOptions, ExecResult, Host } from './host';

/** where/which 查询默认超时（探测类命令应快速失败）。 */
const WHERE_TIMEOUT_MS = 10_000;

/** git 调用默认超时：git 偶尔弹凭证交互/慢仓库，30s 兜底（到期 code=124）。 */
export const GIT_TIMEOUT_MS = 30_000;

export interface WhereExeOptions {
  /** 平台（process.platform 值）；win32 → where.exe，其余 → which。 */
  readonly platform?: string;
  /** 超时毫秒（默认 10s）。 */
  readonly timeoutMs?: number;
}

/**
 * 在 PATH 上查找可执行文件：返回全部命中路径（按输出顺序），未命中返回空数组。
 * 失败永不抛出（Host.exec 约定：非零 code 表达失败）。
 */
export async function whereExe(host: Host, name: string, opts: WhereExeOptions = {}): Promise<string[]> {
  const win32 = (opts.platform ?? process.platform) === 'win32';
  const cmd = win32 ? 'where.exe' : 'which';
  const args = win32 ? [name] : ['-a', name];
  const result = await host.exec(cmd, args, { timeoutMs: opts.timeoutMs ?? WHERE_TIMEOUT_MS });
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * 执行 git 子命令：默认 30s 超时；cwd/env 透传 Host.exec。
 * git 不存在（无法启动）→ code=127；超时 → code=124（Host.exec 约定）。
 */
export async function gitExec(
  host: Host,
  args: readonly string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return host.exec('git', args, { ...opts, timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS });
}
