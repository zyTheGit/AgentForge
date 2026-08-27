/**
 * Host 的真实实现：node:fs / node:child_process。
 *
 * 全项目仅本文件（与 fsutil）允许 import node:fs / node:child_process；
 * 其余模块一律通过注入的 Host 接口访问副作用。
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { currentOs, longPathAware } from '../core/paths';
import { stripBom } from './fsutil';
import type { ExecOptions, ExecResult, FileStat, Host } from './host';

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
  if (typeof err.code === 'number') {
    return err.code;
  }
  if (err.killed || err.signal) {
    return 124;
  }
  return 127;
}

/**
 * 长路径归一化的唯一入口（Spec §2.1.1）：本文件所有接受路径参数的方法都必须经过它。
 *
 * 为什么“全部”而不只是写路径：atomicWrite 的临时文件名（`<target>.agf-<12hex>.tmp`）
 * 比 target 长约 21 字符。若只有 writeFile/mkdirp 归一化，target 长度落在
 * 219~240 区间时会出现「tmp 走 `\\?\` 写入成功、rename/exists 用裸路径失败」的
 * 撕裂：抛出非权限类原始错误（不映射为 PermissionError），且 `.agf-*.tmp`
 * 永久残留在用户配置目录。归一化在此统一收口，Host 接口签名不变。
 */
function n(p: string): string {
  return longPathAware(p, currentOs());
}

export const realHost: Host = {
  async readFile(path: string): Promise<string> {
    // utf8 解码 + 剥 BOM（Spec §2.1.1：统一 UTF-8 无 BOM）
    return stripBom(await fsp.readFile(n(path), 'utf8'));
  },

  async writeFile(path: string, content: string): Promise<void> {
    await fsp.writeFile(n(path), content, 'utf8');
  },

  async chmod(path: string, mode: number): Promise<void> {
    await fsp.chmod(n(path), mode);
  },

  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(n(path));
      return true;
    } catch {
      return false;
    }
  },

  async listDir(path: string): Promise<string[]> {
    return fsp.readdir(n(path));
  },

  async mkdirp(path: string): Promise<void> {
    await fsp.mkdir(n(path), { recursive: true });
  },

  async mkdirExclusive(dir: string): Promise<boolean> {
    try {
      // 非递归：recursive:true 对已存在目录不报错，会丧失互斥判定能力
      await fsp.mkdir(n(dir));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return false; // 竞态败者（或上次残留的锁目录）：由调用方决定等待还是抢占
      }
      throw err; // 权限 / 父目录缺失等：上抛给调用方按 errno 映射（不可折叠为 false）
    }
  },

  async rm(path: string): Promise<void> {
    // force：不存在不报错（清理临时文件的调用方依赖此语义）
    await fsp.rm(n(path), { recursive: true, force: true });
  },

  async stat(path: string): Promise<FileStat> {
    const s = await fsp.stat(n(path));
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  },

  async lstat(path: string): Promise<FileStat> {
    const s = await fsp.lstat(n(path));
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  },

  async readlink(path: string): Promise<string> {
    return fsp.readlink(n(path), 'utf8');
  },

  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(n(from), n(to));
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

  homedir(): string | undefined {
    // os.homedir() 在解析失败时返回空串而非抛错，统一收敛为 undefined
    const home = homedir();
    return home === '' ? undefined : home;
  },
};
