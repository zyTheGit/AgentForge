/**
 * bundle manifest schema（`aforge bundle export` 产物的自描述清单）。
 *
 * 与其它 schema 的区别：habits/profile/sources/sync-meta 都是 **SoT 内**的配置文件，
 * 这份 manifest 是 **SoT 外**的迁移产物描述，不参与两层合并、不进 §5.2 装配。
 * 因此它刻意**不**登记进 schema/emit 的 JSON Schema 工件清单——那份清单的语义是
 * 「用户需要手写/校验的配置文件」，而 manifest 恒由 export 生成、由 import 消费。
 *
 * 完整性契约：import 侧按 `files[].sha256` 逐个校验 bundle 内容，任一不符即
 * fail-fast（ConfigError(2)）且**一个字节都不落盘**。所以哈希不是可选字段，
 * 也不接受「manifest 有条目但文件缺失」的宽松形态。
 */
import { z } from 'zod';
import { SchemaVersion } from './common';
import { Sha256Hex } from './sync-meta';

/** 单个导出文件的记录。 */
export const BundleFileSchema = z.object({
  /**
   * bundle 内容根（`sot/`）下的 **posix 相对路径**（`custom/rules.md`）。
   *
   * 恒用 `/` 而非宿主分隔符：bundle 的用途就是跨机器搬运，Windows 导出的
   * `custom\rules.md` 在 posix 上会变成一个名字里带反斜杠的文件。
   * import 侧另有 assertSafeBundlePath 拒绝绝对路径 / `..` / 盘符。
   */
  path: z.string().min(1),
  sha256: Sha256Hex,
  /** 导出时被净化改写过（habits 剔 detected / profile 抹凭据）。 */
  transformed: z.boolean().default(false),
});

/** 被排除项的原因分类（人类可读输出与 --json 同源）。 */
export const BundleExcludeReason = z.enum([
  /** 本机状态：带到别处有害（sync-meta.json 的绝对路径 + prune 白名单）。 */
  'machine-state',
  /** 事务残留：锁目录与备份目录（.sync.lock / .agf-backup*）。 */
  'transient',
  /** 可重建缓存：user 层的 store\（git 源 clone，靠 source update 重建）。 */
  'cache',
  /** 不属于 SoT 约定布局的条目（不静默带走，也不静默丢弃：报出来让用户看见）。 */
  'not-part-of-sot',
]);

export const BundleExcludedSchema = z.object({
  /** SoT 根下的 posix 相对路径（目录不带尾斜杠）。 */
  path: z.string().min(1),
  reason: BundleExcludeReason,
});

export const BundleManifestSchema = z.object({
  version: SchemaVersion,
  /** 导出方 CLI 版本（诊断用，import 不做版本兼容判断）。 */
  agentforgeVersion: z.string().min(1),
  exportedAt: z.iso.datetime({ offset: true }),
  /** 导出来源层（import 时可落到另一层，故这里只是记录）。 */
  scope: z.enum(['user', 'project']),
  /** 导出来源 SoT 绝对路径（诊断用；换机器后无可比性，import 不消费）。 */
  sourceSotRoot: z.string().min(1),
  files: z.array(BundleFileSchema).default([]),
  /**
   * 被抹掉的凭据字段路径（`mcp.servers[jenkins].headers.Authorization`）。
   *
   * 非空时 import 必须把它们打给用户看——否则新机器上 MCP 静默失效，
   * 而失效原因（值是占位符）藏在 profile.yaml 里没人会去翻。
   */
  redacted: z.array(z.string()).default([]),
  excluded: z.array(BundleExcludedSchema).default([]),
  /** 导出时发现的、需要人工跟进的事项（local 源路径换机器后失效等）。 */
  warnings: z.array(z.string()).default([]),
});

/** manifest.json 解析后的完整形态。 */
export type BundleManifest = z.output<typeof BundleManifestSchema>;

/** 单个导出文件记录（输出形态）。 */
export type BundleFile = z.output<typeof BundleFileSchema>;

/** 被排除项（输出形态）。 */
export type BundleExcluded = z.output<typeof BundleExcludedSchema>;

/** 排除原因（输出形态）。 */
export type BundleExcludeReason = z.output<typeof BundleExcludeReason>;
