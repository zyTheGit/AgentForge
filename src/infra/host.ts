/**
 * Host：全项目唯一的副作用窄接口（文件系统 / 子进程 / 时钟 / 环境变量）。
 *
 * - core 层只依赖此接口（依赖注入），不直接触碰 node:fs / node:child_process，
 *   从而保证单测可注入 fake host（内存 fs / 假时钟 / 假 env）。
 * - 真实实现见 real-host.ts；除 real-host / fsutil / shell 外，
 *   全项目其他文件禁止 import node:fs / node:child_process。
 */

/** stat 的窄化结果（避免 core 层接触 node:fs 的 Stats 类型）。 */
export interface FileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ExecOptions {
  /** 子进程工作目录 */
  readonly cwd?: string;
  /** 超时（毫秒）；到期杀掉子进程并以 code=124 返回 */
  readonly timeoutMs?: number;
  /** 追加/覆盖的环境变量（与当前进程 env 浅合并） */
  readonly env?: Readonly<Record<string, string>>;
}

/** exec 的结果：不抛异常，失败以非零 code 表达（约定：超时 124、无法启动 127）。 */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface Host {
  /** 读文本文件：UTF-8 解码并剥离 BOM（Spec §2.1.1）。不存在时 reject。 */
  readFile(path: string): Promise<string>;
  /** 写文本文件（UTF-8、无 BOM）。 */
  writeFile(path: string, content: string): Promise<void>;
  /** 修改文件权限位；Windows 上用于清除只读属性（0o666）。 */
  chmod(path: string, mode: number): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** 列出目录下的直接子项名（不含 `.` / `..`）。 */
  listDir(path: string): Promise<string[]>;
  /** mkdir -p 语义：已存在不报错，递归创建。 */
  mkdirp(path: string): Promise<void>;
  /** 删除文件或目录（recursive + force：不存在也不报错）。 */
  rm(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  rename(from: string, to: string): Promise<void>;
  /** 执行外部命令（有超时保护，永不 reject；失败看 code/stderr）。 */
  exec(cmd: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
  /** 当前时间（注入以便测试冻结时钟）。 */
  now(): Date;
  /** 读取环境变量（不存在 → undefined；不 trim）。 */
  env(key: string): string | undefined;
}
