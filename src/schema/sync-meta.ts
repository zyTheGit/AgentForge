/**
 * sync-meta.json schema（Spec §3.3）：投影写入记录（doctor 一致性检测的基准）。
 *
 * - 用户级与项目级 SoT 均包含本文件；targets 键为目标 id；
 * - contentHash 为 LF 规范化后的 sha256 hex（与 infra/fsutil.sha256Hex 同规范）；
 * - agentforgeVersion 与 CLI 版本对应（写入方维护，读取方不强校验格式）。
 */
import { z } from 'zod';
import { SchemaVersion } from './common';

/** Spec §3.3 os。 */
export const OsName = z.enum(['win32', 'darwin', 'linux']);

/** sha256 hex（64 位小写十六进制）。 */
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, '必须是 sha256 hex（64 位小写十六进制字符串）');

/** 单个 target 的写入记录。 */
export const TargetSyncMetaSchema = z.object({
  contentHash: Sha256Hex,
  writtenAt: z.iso.datetime({ offset: true }),
});

export const SyncMetaSchema = z.object({
  version: SchemaVersion,
  lastSyncAt: z.iso.datetime({ offset: true }),
  os: OsName,
  agentforgeVersion: z.string().min(1),
  /** 键为目标 id（opencode/codex/claude/pi），值为该 target 的写入记录。 */
  targets: z.record(z.string(), TargetSyncMetaSchema).default({}),
});

/** sync-meta.json 的完整形态（默认值已填充）。 */
export type SyncMeta = z.output<typeof SyncMetaSchema>;

/** sync-meta.json 的输入形态。 */
export type SyncMetaInput = z.input<typeof SyncMetaSchema>;

/** 单个 target 的写入记录（输出形态）。 */
export type TargetSyncMeta = z.output<typeof TargetSyncMetaSchema>;
