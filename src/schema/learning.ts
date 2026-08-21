/**
 * learning 单条 schema（Spec §4.3）：learnings/ 目录下的学习条目。
 *
 * - id 受 Spec 正则约束：^[a-z0-9][a-z0-9_-]{1,63}$（小写字母/数字开头，
 *   总长 2–64，其余字符仅限 a-z0-9_-）；
 * - created_at/updated_at/promoted_at 为 ISO-8601 datetime 字符串；
 * - promoted/promoted_at/promote_target 有默认值（learn 创建时的初始状态），
 *   其余字段必填——learning 是数据文件而非可省略配置。
 */
import { z } from 'zod';
import { ScopeEnum } from './common';

/** Spec §4.3 id 正则（导出供 learn 生成 id 时复用）。 */
export const LearningIdPattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** Spec §4.3 id：小写字母/数字开头，总长 2–64，仅含 a-z0-9_-。 */
export const LearningId = z
  .string()
  .regex(
    LearningIdPattern,
    'learning id 必须以小写字母或数字开头，长度 2-64，仅可包含 a-z、0-9、下划线与连字符',
  );

/** Spec §4.3 category。 */
export const LearningCategory = z.enum([
  'tooling',
  'code-style',
  'architecture',
  'debugging',
  'process',
  'security',
  'other',
]);

/** category 字面量联合（与同名 zod enum 同名导出：值 + 类型）。 */
export type LearningCategory = z.infer<typeof LearningCategory>;

/** Spec §4.3 promote_target。 */
export const PromoteTarget = z.enum(['custom_rule', 'skill', 'habits_note']);

/** promote_target 字面量联合（值 + 类型同名导出）。 */
export type PromoteTarget = z.infer<typeof PromoteTarget>;

export const LearningSchema = z.object({
  id: LearningId,
  scope: ScopeEnum,
  /** 置信度 0–1（含端点）。 */
  confidence: z.number().min(0).max(1),
  trigger: z.string(),
  content: z.string(),
  category: LearningCategory,
  /** 来源标识（如对话摘要 / 文件导入）。 */
  source: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  promoted: z.boolean().default(false),
  promoted_at: z.iso.datetime({ offset: true }).nullable().default(null),
  promote_target: PromoteTarget.default('custom_rule'),
});

/** 单条 learning 的完整形态（默认值已填充）。 */
export type Learning = z.output<typeof LearningSchema>;

/** 单条 learning 的输入形态。 */
export type LearningInput = z.input<typeof LearningSchema>;
