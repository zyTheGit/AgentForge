/**
 * 外部模板包 manifest.yaml schema（Spec §4.5）。
 *
 * - min_agentforge 接受数字（如 `1`）或字符串（如 `">=0.1"`）——Spec 示例为数字，
 *   语义比较（当前版本是否满足最低要求）由 SourceManager 运行时处理；
 * - templates 每项 id/path/description；skills 每项 name（必填）+ description（可选）；
 *   mcp 元素结构与 §4.2 mcp.servers[] 一致，直接复用 McpServerSchema；
 * - 三个数组均用 z.object（非 strict）：未知键静默丢弃，保持向前兼容。
 */
import { z } from 'zod';
import { McpServerSchema } from './profile';

/** Spec §4.5 templates[] 元素。 */
export const ManifestTemplateSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  description: z.string(),
});

/**
 * Spec §4.5 skills[] 元素。
 * name 即包内 `skills/<name>/SKILL.md` 的目录名，必填非空（core/sources/skill 依赖它定位目录）。
 */
export const ManifestSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

export const ManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  min_agentforge: z.union([z.number(), z.string()]),
  templates: z.array(ManifestTemplateSchema).default([]),
  skills: z.array(ManifestSkillSchema).default([]),
  /** §4.5 mcp[]：与 §4.2 mcp.servers[] 同构，复用同一套字段与校验。 */
  mcp: z.array(McpServerSchema).default([]),
});

/** manifest.yaml 的完整形态（默认值已填充）。 */
export type Manifest = z.output<typeof ManifestSchema>;

/** manifest.yaml 的输入形态。 */
export type ManifestInput = z.input<typeof ManifestSchema>;

/** 单个模板声明。 */
export type ManifestTemplate = z.output<typeof ManifestTemplateSchema>;

/** 单个 skill 声明。 */
export type ManifestSkill = z.output<typeof ManifestSkillSchema>;
