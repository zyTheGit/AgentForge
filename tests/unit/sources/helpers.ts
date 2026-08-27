/**
 * sources 系列单测共享 helper：目录感知 fake host + 可编程 git mock。
 *
 * test-utils 原版 fake host 无目录概念（exists 精确键匹配 / rm 不递归 /
 * listDir `/` 前缀扫描），与 path.join（win32 `\`）产物及"目录存在性"语义
 * 不一致；本 helper 对齐真实 host：
 * - exists：文件键存在 **或** 目录下有任意文件；
 * - listDir：返回直接子项名（文件或目录，对齐 readdir）；
 * - rm：递归删除（目录 → 删全部前缀键）；
 * - stat：文件键 → isFile；目录（有子项）→ isDirectory；否则 ENOENT；
 * - exec：非 git 命令恒成功；git 命令记录调用，rev-parse 返回固定 commit，
 *   可按子命令注入失败结果。
 *
 * PATH 与 git 可执行文件：shell.gitExec 在 win32 上只 spawn 从 PATH 解析出的
 * **绝对路径**（§10，解析不到即 code=127，不退回裸 `git`）。因此本 helper 默认
 * 往 env 里放一个 PATH 并在内存 fs 里放 `<FAKE_GIT_DIR>/git[.exe]`（后缀随宿主
 * 平台，posix 候选无 PATHEXT 展开）；exec 侧按 basename 判定"这是不是 git"，
 * 从而同时兼容 win32（绝对路径）与 posix（裸名）。
 *
 * 路径夹具一律走 test-utils.abs（宿主平台语义）：内存 fs 以路径字符串为键，
 * 而被测代码用宿主 path.join 拼键，硬编码 `C:\` 在 posix 上会双向错位。
 */
import path from 'node:path';
import type { ExecOptions, ExecResult, Host } from '../../../src/infra/host';
import { abs, createFakeHost, errnoError } from '../test-utils';

/** fake PATH 目录与其中的 git（供 resolveExecutable 命中）。 */
export const FAKE_GIT_DIR = abs('fake', 'bin');
export const FAKE_GIT_EXE = path.join(
  FAKE_GIT_DIR,
  process.platform === 'win32' ? 'git.exe' : 'git',
);

/** 命令是否为 git（裸名 / PATH 解析出的绝对路径 + PATHEXT 后缀都算）。 */
function isGitCommand(cmd: string): boolean {
  const base = path.win32.basename(cmd).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com)$/, '') === 'git';
}

export interface GitCall {
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly opts: ExecOptions | undefined;
}

export interface DirAwareHost extends Host {
  readonly files: Map<string, string>;
  readonly gitCalls: GitCall[];
}

export function createDirAwareHost(
  envMap: Record<string, string> = {},
  gitFailures: Record<string, ExecResult> = {},
): DirAwareHost {
  // PATH/PATHEXT 可被调用方覆盖；默认值让 win32 的 gitExec 能解析出绝对路径
  const env: Record<string, string> = { PATH: FAKE_GIT_DIR, PATHEXT: '.exe', ...envMap };
  const base = createFakeHost(env);
  const files = base.files;
  const dirs = base.dirs;
  const gitCalls: GitCall[] = [];
  files.set(FAKE_GIT_EXE, 'binary');

  const prefixOf = (p: string): string => (p.endsWith(path.sep) ? p : `${p}${path.sep}`);
  const isDir = (p: string): boolean =>
    dirs.has(p) || [...files.keys()].some((k) => k.startsWith(prefixOf(p)));

  const host: DirAwareHost = {
    files,
    gitCalls,
    async readFile(p) {
      const content = files.get(p);
      if (content === undefined) {
        throw errnoError('ENOENT', `no such file: ${p}`);
      }
      return content;
    },
    async writeFile(p, content) {
      files.set(p, content);
    },
    async chmod() {
      // 目录感知测试不关心 chmod
    },
    async exists(p) {
      return files.has(p) || isDir(p);
    },
    async listDir(p) {
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefixOf(p))) {
          const rest = key.slice(prefixOf(p).length);
          if (rest === '') {
            continue;
          }
          const sep = rest.search(/[\\/]/);
          names.add(sep === -1 ? rest : rest.slice(0, sep));
        }
      }
      return [...names].sort();
    },
    async mkdirp() {
      // 内存 fs 无目录概念，no-op
    },
    async mkdirExclusive(p) {
      if (isDir(p) || files.has(p)) {
        return false; // 已存在 → 互斥败者
      }
      dirs.add(p);
      return true;
    },
    async rm(p) {
      if (files.has(p)) {
        files.delete(p);
        return;
      }
      dirs.delete(p);
      const prefix = prefixOf(p);
      for (const key of [...files.keys()]) {
        if (key.startsWith(prefix)) {
          files.delete(key);
        }
      }
      for (const dir of [...dirs]) {
        if (dir.startsWith(prefix)) {
          dirs.delete(dir);
        }
      }
    },
    async stat(p) {
      const content = files.get(p);
      if (content !== undefined) {
        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          size: content.length,
          mtimeMs: 0,
        };
      }
      if (isDir(p)) {
        return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0, mtimeMs: 0 };
      }
      throw errnoError('ENOENT', `no such file or directory: ${p}`);
    },
    async lstat(p) {
      return this.stat(p);
    },
    async readlink(p) {
      throw errnoError('EINVAL', `not a symlink: ${p}`);
    },
    async rename(from, to) {
      const content = files.get(from);
      if (content === undefined) {
        throw errnoError('ENOENT', `no such file: ${from}`);
      }
      files.delete(from);
      files.set(to, content);
    },
    exec(cmd, args, opts) {
      if (!isGitCommand(cmd)) {
        return Promise.resolve({ stdout: '', stderr: '', code: 0 });
      }
      gitCalls.push({ args, cwd: opts?.cwd, opts });
      const sub = args[0] ?? '';
      const failure = gitFailures[sub];
      if (failure !== undefined) {
        return Promise.resolve(failure);
      }
      if (sub === 'rev-parse') {
        return Promise.resolve({ stdout: 'abc123def456\n', stderr: '', code: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    },
    now() {
      return new Date(0);
    },
    env(key) {
      return env[key];
    },
    homedir() {
      return undefined;
    },
  };

  return host;
}
