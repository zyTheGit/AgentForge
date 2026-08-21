/**
 * 单测共享工具：内存版 fake Host（无任何真实 IO）。
 *
 * - files：内存文件表（path → content），测试可直接读写断言；
 * - chmodCalls：记录 chmod 调用的路径（断言"只读属性去除"路径用）。
 */
import type { Host } from '../../src/infra/host';

export interface FakeHost extends Host {
  readonly files: Map<string, string>;
  readonly chmodCalls: string[];
}

export function createFakeHost(envMap: Readonly<Record<string, string>> = {}): FakeHost {
  const files = new Map<string, string>();
  const chmodCalls: string[] = [];

  const host: FakeHost = {
    files,
    chmodCalls,
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
    async chmod(p, _mode) {
      chmodCalls.push(p);
    },
    async exists(p) {
      return files.has(p);
    },
    async listDir(p) {
      const prefix = p.endsWith('/') ? p : `${p}/`;
      return [...files.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .sort();
    },
    async mkdirp(_p) {
      // 内存 fs 无目录概念，no-op
    },
    async rm(p) {
      files.delete(p);
    },
    async stat(p) {
      const content = files.get(p);
      if (content === undefined) {
        throw errnoError('ENOENT', `no such file: ${p}`);
      }
      return { isFile: true, isDirectory: false, size: content.length, mtimeMs: 0 };
    },
    async rename(from, to) {
      const content = files.get(from);
      if (content === undefined) {
        throw errnoError('ENOENT', `no such file: ${from}`);
      }
      files.delete(from);
      files.set(to, content);
    },
    async exec() {
      return { stdout: '', stderr: '', code: 0 };
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

/** 构造带 errno 的错误对象（模拟 node:fs 抛出的 EPERM/EACCES 等）。 */
export function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}
