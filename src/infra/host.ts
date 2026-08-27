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
  readonly isSymbolicLink: boolean;
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
  /**
   * 清除文件的只读属性（Windows 的 FILE_ATTRIBUTE_READONLY，git clone 常见）。
   *
   * 只在 win32 上有动作（chmod 0o666）；POSIX 上是 no-op——那里 0o666 不是
   * 「去只读」而是真实的权限放宽，会把 `0600` 的配置文件放开给同组与其他用户。
   * 平台分支放在 real-host（平台已知处），调用方按意图调用即可。
   */
  clearReadonly(path: string): Promise<void>;
  /**
   * 把 `from` 的权限位复制到 `to`（POSIX 语义；win32 上 no-op）。
   *
   * atomicWrite 用它保住目标文件原有的 mode：`rename(tmp, target)` 后目标继承的是
   * **临时文件**的权限（`0o666 & ~umask`，通常 0644），不复制的话每次 sync 都会把
   * `0600` 的文件放宽到 0644。`from` 不存在时 reject，由调用方决定是否忽略。
   */
  copyMode(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** 列出目录下的直接子项名（不含 `.` / `..`）。 */
  listDir(path: string): Promise<string[]>;
  /** mkdir -p 语义：已存在不报错，递归创建。 */
  mkdirp(path: string): Promise<void>;
  /**
   * **原子**创建单个目录（非递归 `mkdir`），用作跨进程互斥原语。
   *
   * 原子性契约：Windows 与 POSIX 的 `mkdir` 系统调用均保证「创建成功」与
   * 「已存在（EEXIST）」二者不可分割地判定——并发调用者中至多一个得到 `true`。
   * 因此调用方可用它实现进程级排他锁（`exists` 探测 + `writeFile` 的组合做不到：
   * 两个进程可以都探测为不存在、都写入、都回读到自己的内容）。
   *
   * 失败语义：
   * - 目录已存在 → 返回 `false`（**不抛错**，这是竞态的正常败者路径）；
   * - 父目录不存在（ENOENT）/ 权限不足（EPERM/EACCES/EROFS）/ 其他错误 →
   *   原样 reject，由调用方按 errno 映射为 PermissionError 等。**不得**把这些
   *   错误折叠成 `false`：否则「锁写不进去」会被误解为「锁已被他人持有」。
   *
   * @param dir 要创建的目录绝对路径（父目录必须已存在）。
   * @returns `true` = 本次调用创建了该目录（互斥胜者）；`false` = 目录已存在（败者）。
   */
  mkdirExclusive(dir: string): Promise<boolean>;
  /** 删除文件或目录（recursive + force：不存在也不报错）。 */
  rm(path: string): Promise<void>;
  /** stat（跟随 symlink）；不存在时 reject。 */
  stat(path: string): Promise<FileStat>;
  /** lstat（不跟随 symlink）；不存在时 reject。用于检测 symlink 本身。 */
  lstat(path: string): Promise<FileStat>;
  /** 读 symlink 目标路径；非 symlink 时 reject。 */
  readlink(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  /** 执行外部命令（有超时保护，永不 reject；失败看 code/stderr）。 */
  exec(cmd: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
  /** 当前时间（注入以便测试冻结时钟）。 */
  now(): Date;
  /** 读取环境变量（不存在 → undefined；不 trim）。 */
  env(key: string): string | undefined;
  /**
   * 当前用户的家目录（node `os.homedir()`；解析不到 → undefined）。
   *
   * 与 `env('HOME')` 不是一回事：POSIX 上 HOME 未导出时 os.homedir() 仍能从
   * passwd 拿到；Windows 上它综合 USERPROFILE 与注册表。core 层只在环境变量
   * 都缺失时用它兜底（见 core/env.readEnv）。
   */
  homedir(): string | undefined;
}
