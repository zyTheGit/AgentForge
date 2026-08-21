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
 */
import path from 'node:path';
import type { ExecOptions, ExecResult, Host } from '../../../src/infra/host';
import { createFakeHost, errnoError } from '../test-utils';

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
  const base = createFakeHost(envMap);
  const files = base.files;
  const gitCalls: GitCall[] = [];

  const prefixOf = (p: string): string => (p.endsWith(path.sep) ? p : `${p}${path.sep}`);
  const isDir = (p: string): boolean => [...files.keys()].some((k) => k.startsWith(prefixOf(p)));

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
          if (rest === '') continue;
          const sep = rest.search(/[\\/]/);
          names.add(sep === -1 ? rest : rest.slice(0, sep));
        }
      }
      return [...names].sort();
    },
    async mkdirp() {
      // 内存 fs 无目录概念，no-op
    },
    async rm(p) {
      if (files.has(p)) {
        files.delete(p);
        return;
      }
      const prefix = prefixOf(p);
      for (const key of [...files.keys()]) {
        if (key.startsWith(prefix)) {
          files.delete(key);
        }
      }
    },
    async stat(p) {
      const content = files.get(p);
      if (content !== undefined) {
        return { isFile: true, isDirectory: false, size: content.length, mtimeMs: 0 };
      }
      if (isDir(p)) {
        return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 };
      }
      throw errnoError('ENOENT', `no such file or directory: ${p}`);
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
      if (cmd !== 'git') {
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
      return envMap[key];
    },
  };

  return host;
}
