/**
 * 跨 schema 共享的基础定义（Spec §4 配置 Schema 公共部分）。
 *
 * 双形态约定（全部配置 schema 遵守）：
 * - 输出形态（z.output，如 Habits/Profile）：`.default()` 已填充的完整对象，
 *   供装配层（core/config/defaults.resolveEffectiveConfig）之后的消费端直接使用；
 * - 输入形态（z.input，如 HabitsInput/ProfileInput）：字段可省略的原始对象，
 *   加载层（core/config/load）与合并层（core/config/merge）在此形态流转，
 *   以区分"用户显式设置"与"未设置"——这是 §4.2 overlay 继承语义的前提。
 */
import { z } from 'zod';

/**
 * 配置文件格式版本：当前唯一支持 1。
 * z.input 为 `1 | undefined`（缺省 → 默认 1）；z.output 恒为 1。
 */
export const SchemaVersion = z.literal(1).default(1);

/** Spec §4.2 scope / §4.3 learning.scope：配置或数据所属层级。 */
export const ScopeEnum = z.enum(['user', 'project']);
