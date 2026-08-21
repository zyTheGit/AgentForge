/**
 * detector 单测共享工具：可编程 fake host（内存文件 + 目录列表 + 环境变量）。
 *
 * - dirs：目录 → 文件名列表（未登记的目录 listDir 抛 ENOENT，模拟"目录不存在"）；
 * - files：内存文件表（版本文件 / 规则文件内容，走 createFakeHost 的 exists/readFile）；
 * - env：环境变量表（PATH / PATHEXT / PSModulePath / SHELL ...）。
 */
import type { Host } from '../../../src/infra/host';
import { createFakeHost, errnoError } from '../test-utils';

/** 目录 key 规范化：统一斜杠、去尾分隔符、小写（win32 大小写不敏感语义）。 */
export function normalizeDirKey(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export interface DetectFixture {
  /** 目录 → 文件名列表（不存在 → listDir 抛 ENOENT）。 */
  readonly dirs: Record<string, string[]>;
  /** 内存文件表（绝对路径 → 内容）。 */
  readonly files: Record<string, string>;
  /** 环境变量。 */
  readonly env: Record<string, string>;
}

/** 构造探测用 fake host：listDir 来自 dirs，exists/readFile 来自 files，env 来自 envMap。 */
export function makeDetectHost(fixture: DetectFixture): Host {
  const base = createFakeHost(fixture.env);
  for (const [file, content] of Object.entries(fixture.files)) {
    base.files.set(file, content);
  }
  const dirEntries = new Map(
    Object.entries(fixture.dirs).map(([dir, names]) => [normalizeDirKey(dir), names] as const),
  );
  return {
    ...base,
    async listDir(p: string): Promise<string[]> {
      const names = dirEntries.get(normalizeDirKey(p));
      if (names === undefined) {
        throw errnoError('ENOENT', `no such directory: ${p}`);
      }
      return [...names];
    },
  };
}
