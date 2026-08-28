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

/**
 * 单个「整文件产物」的写入记录（Spec §7.6 prune 的删除白名单）。
 *
 * 只记 action=write 的项——整个文件归 AgentForge 所有，因此下一轮不再产出它时
 * 可以安全删除。merge_marker / merge_json / merge_toml 的文件与用户内容共处，
 * 永远不进这张表。
 */
export const SyncArtifactSchema = z.object({
  /** 绝对路径（跨机器 SoT 共享时路径无可比性 → 下一轮记录会自然覆盖）。 */
  path: z.string().min(1),
  contentHash: Sha256Hex,
  /** 产出该文件的 target id（子集 sync 只 prune 本次参与的 target）。 */
  targetId: z.string().min(1),
});

export const SyncMetaSchema = z.object({
  version: SchemaVersion,
  lastSyncAt: z.iso.datetime({ offset: true }),
  os: OsName,
  agentforgeVersion: z.string().min(1),
  /** 键为目标 id（opencode/codex/claude/pi），值为该 target 的写入记录。 */
  targets: z.record(z.string(), TargetSyncMetaSchema).default({}),
  /**
   * 上一轮实际落盘的整文件产物（Spec §7.6）。
   *
   * **可选且不给默认值**：字段缺席（老版本写的 sync-meta）与「记录为空数组」
   * 必须可区分——缺席时本轮只记账不 prune，否则首次升级就会把一批没有记录的
   * 既有产物当成"不该存在"而误删。
   */
  artifacts: z.array(SyncArtifactSchema).optional(),
  /**
   * 上一轮投影进各 target MCP 配置的 server 名（Spec §7.6 / §8.2）。
   *
   * merge_json 的深合并只覆盖不删键，所以 SoT 里摘掉一个 server 后，投影文件里
   * 那个键会永久留存。有了这份记录才能算出「上轮有、本轮没有」的差集去摘键。
   * 缺席语义同 artifacts。
   */
  mcpServers: z.array(z.string()).optional(),
});

/** sync-meta.json 的完整形态（默认值已填充）。 */
export type SyncMeta = z.output<typeof SyncMetaSchema>;

/** sync-meta.json 的输入形态。 */
export type SyncMetaInput = z.input<typeof SyncMetaSchema>;

/** 单个 target 的写入记录（输出形态）。 */
export type TargetSyncMeta = z.output<typeof TargetSyncMetaSchema>;

/** 单个整文件产物的写入记录（输出形态）。 */
export type SyncArtifact = z.output<typeof SyncArtifactSchema>;
