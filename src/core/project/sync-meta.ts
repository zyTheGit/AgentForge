/**
 * sync-meta.json 读写（Spec §3.3）：投影写入记录，doctor 一致性检测的基准。
 *
 * - contentHash 由调用方计算（fsutil.sha256Hex，LF 规范化基准），本层只存取；
 * - 读取：不存在 → null；JSON 损坏 / 结构不符 → ConfigError(2)（fail-fast，
 *   不静默丢弃记录——否则 §8.2 的 marker 区间冲突检测会失去基准）；
 * - 写入：atomicWrite + 2 空格缩进 JSON + 末尾换行；换行风格按 profile
 *   （Spec §2.5：JSON 同样按 line_ending 写出），默认 LF。
 */
import path from 'node:path';
import { SyncMetaSchema } from '../../schema';
import type { SyncMeta, SyncMetaInput } from '../../schema';
import type { LineEnding } from '../env';
import { ConfigError } from '../errors';
import { atomicWrite, mkdirp, normalizeLineEnding } from '../../infra/fsutil';
import type { Host } from '../../infra/host';

/** Spec §3.3 / §3.1 / §3.2：SoT 根目录内的元数据文件名。 */
export const SYNC_META_FILE = 'sync-meta.json';

/** sync-meta.json 在 SoT 根目录下的绝对路径。 */
export function syncMetaPath(sotRoot: string): string {
  return path.join(sotRoot, SYNC_META_FILE);
}

/**
 * 读取并校验 sync-meta.json。
 *
 * @returns 完整形态（默认值已填充）；文件不存在 → null。
 * @throws ConfigError(2) JSON 语法错误或结构不符合 §3.3。
 */
export async function readSyncMeta(host: Host, sotRoot: string): Promise<SyncMeta | null> {
  const file = syncMetaPath(sotRoot);
  if (!(await host.exists(file))) {
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(await host.readFile(file));
  } catch (err) {
    throw new ConfigError(`sync-meta.json 不是合法的 JSON：${file}`, {
      hint: '检查该文件是否被手动改坏；确认无误后可删除它（下次 sync 会重建），但会丢失 marker 冲突检测基准',
      details: { file, error: err },
    });
  }

  const parsed = SyncMetaSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`sync-meta.json 结构不符合 Spec §3.3：${file}\n${issues.join('\n')}`, {
      hint: '该文件由 aforge 维护，通常无需手改；确认无误后可删除它（下次 sync 会重建）',
      details: { file, issues },
    });
  }
  return parsed.data;
}

/**
 * 写入 sync-meta.json（原子写）。
 *
 * 输入为 SyncMetaInput（targets 可缺省），出口统一 Schema.parse 填充默认值后
 * 序列化——保证落盘形态完整、读取方无需判空。
 */
export async function writeSyncMeta(
  host: Host,
  sotRoot: string,
  meta: SyncMetaInput,
  lineEnding: LineEnding = 'lf',
): Promise<void> {
  const full = SyncMetaSchema.parse(meta);
  const json = `${JSON.stringify(full, null, 2)}\n`;
  await mkdirp(host, sotRoot);
  await atomicWrite(host, syncMetaPath(sotRoot), normalizeLineEnding(json, lineEnding));
}
