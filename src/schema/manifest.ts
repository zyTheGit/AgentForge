/**
 * 外部模板包 manifest.yaml schema（Spec §4.5）。
 *
 * - min_agentforge 接受数字（如 `1`）或字符串（如 `">=0.1"`）——Spec 示例为数字，
 *   语义比较（当前版本是否满足最低要求）由 SourceManager 运行时处理；
 * - templates 每项 id/path/description；skills/mcp 的元素结构 Spec 未定义，
 *   仅约束为对象数组（loose），由后续里程碑按需收紧。
 */
import { z } from 'zod';

/** Spec §4.5 templates[] 元素。 */
export const ManifestTemplateSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  description: z.string(),
});

export const ManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  min_agentforge: z.union([z.number(), z.string()]),
  templates: z.array(ManifestTemplateSchema).default([]),
  skills: z.array(z.looseObject({})).default([]),
  mcp: z.array(z.looseObject({})).default([]),
});

/** manifest.yaml 的完整形态（默认值已填充）。 */
export type Manifest = z.output<typeof ManifestSchema>;

/** manifest.yaml 的输入形态。 */
export type ManifestInput = z.input<typeof ManifestSchema>;

/** 单个模板声明。 */
export type ManifestTemplate = z.output<typeof ManifestTemplateSchema>;
