/**
 * Host 的真实实现：node:fs / node:child_process。
 *
 * 全项目仅本文件（与 fsutil）允许 import node:fs / node:child_process；
 * 其余模块一律通过注入的 Host 接口访问副作用。
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import type { ExecOptions, ExecResult, FileStat, Host } from './host';
import { stripBom } from './fsutil';
import { longPathAware, currentOs } from '../core/paths';

/** execFile 超时上限：防挂死（约定到期 code=124）。 */
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
/** execFile 输出缓冲上限：10 MiB，防探测命令刷屏爆缓冲。 */
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

interface ExecCallbackError extends Error {
  code?: unknown;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

/** 把 execFile 的回调错误映射为约定退出码：数字 code 原样；被 kill(超时) → 124；无法启动 → 127。 */
function execErrorCode(err: ExecCallbackError): number {
  if (typeof err.code === 'number') return err.code;
  if (err.killed || err.signal) return 124;
  return 127;
}

export const realHost: Host = {
  async readFile(path: string): Promise<string> {
    // utf8 解码 + 剥 BOM（Spec §2.1.1：统一 UTF-8 无 BOM）
    return stripBom(await fsp.readFile(path, 'utf8'));
  },

  async writeFile(path: string, content: string): Promise<void> {
    const normalized = longPathAware(path, currentOs());
    await fsp.writeFile(normalized, content, 'utf8');
  },

  async chmod(path: string, mode: number): Promise<void> {
    await fsp.chmod(path, mode);
  },

  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  },

  async listDir(path: string): Promise<string[]> {
    return fsp.readdir(path);
  },

  async mkdirp(path: string): Promise<void> {
    const normalized = longPathAware(path, currentOs());
    await fsp.mkdir(normalized, { recursive: true });
  },

  async rm(path: string): Promise<void> {
    // force：不存在不报错（清理临时文件的调用方依赖此语义）
    await fsp.rm(path, { recursive: true, force: true });
  },

  async stat(path: string): Promise<FileStat> {
    const s = await fsp.stat(path);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  },

  async lstat(path: string): Promise<FileStat> {
    const s = await fsp.lstat(path);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  },

  async readlink(path: string): Promise<string> {
    return fsp.readlink(path, 'utf8');
  },

  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(from, to);
  },

  exec(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve) => {
      execFile(
        cmd,
        args,
        {
          cwd: opts.cwd,
          timeout: opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
          maxBuffer: EXEC_MAX_BUFFER,
          windowsHide: true,
          encoding: 'utf8',
          env: opts.env ? { ...process.env, ...opts.env } : process.env,
        },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as ExecCallbackError;
            resolve({
              stdout: stdout ?? '',
              stderr: stderr ?? '',
              code: execErrorCode(e),
            });
            return;
          }
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: 0 });
        },
      );
    });
  },

  now(): Date {
    return new Date();
  },

  env(key: string): string | undefined {
    return process.env[key];
  },
};
