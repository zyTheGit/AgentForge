/**
 * sources.json schema（Spec §4.4）：模板 / skill / MCP 源登记表。
 *
 * 类型互斥（Spec §4.4）：
 * - local 只允许 path（出现 url/ref/commit 之一即校验失败）；
 * - git 只允许 url/ref/commit（出现 path 即校验失败）。
 * 实现方式：z.discriminatedUnion('type', [...]) + z.strictObject 分支——
 * 未知键（越界字段）直接报错，达到与 oneOf 等价的互斥校验效果
 * （strict 分支下 anyOf 恰好只有一个能匹配）。
 *
 * - git 源应记录 commit、默认要求显式 --ref（Spec §4.4）：这是 source add 的
 *   业务规则，schema 层保持 url 必填、ref/commit 可选；
 * - enabled 默认 true、kind 默认 []（登记即生效，未限定 kind）。
 */
import { z } from 'zod';
import { SchemaVersion } from './common';

/** Spec §4.4 kind 元素：源提供的内容类别。 */
export const SourceKind = z.enum(['templates', 'skills', 'mcp']);

/** local 源：仅 path，禁止携带 git 字段（strict）。 */
export const LocalSourceSchema = z.strictObject({
  id: z.string().min(1),
  type: z.literal('local'),
  path: z.string().min(1),
  enabled: z.boolean().default(true),
  kind: z.array(SourceKind).default([]),
});

/** git 源：url 必填，ref/commit 可选，禁止携带 path（strict）。 */
export const GitSourceSchema = z.strictObject({
  id: z.string().min(1),
  type: z.literal('git'),
  url: z.string().min(1),
  ref: z.string().optional(),
  commit: z.string().optional(),
  enabled: z.boolean().default(true),
  kind: z.array(SourceKind).default([]),
});

/** 单个源声明（local | git 互斥）。 */
export const SourceSchema = z.discriminatedUnion('type', [LocalSourceSchema, GitSourceSchema]);

export const SourcesFileSchema = z.object({
  version: SchemaVersion,
  sources: z.array(SourceSchema).default([]),
});

/** sources.json 解析后的完整形态（默认值已填充）。 */
export type SourcesFile = z.output<typeof SourcesFileSchema>;

/** sources.json 的输入形态。 */
export type SourcesFileInput = z.input<typeof SourcesFileSchema>;

/** local 源（输出形态）。 */
export type LocalSource = z.output<typeof LocalSourceSchema>;

/** git 源（输出形态）。 */
export type GitSource = z.output<typeof GitSourceSchema>;

/** 单个源（输出形态）。 */
export type Source = z.output<typeof SourceSchema>;
