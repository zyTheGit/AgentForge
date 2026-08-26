/**
 * 配置合并（Spec §4.2 合并策略语义）：纯函数，无 IO，输入为 schema 的
 * z.input 形态（字段缺省保留 undefined，见 schema/common 的双形态约定）。
 *
 * merge.strategy：
 * - overlay（默认）：project 字段覆盖 user 同名字段，未定义的字段继承 user；
 *   对象递归合并（键级覆盖）。
 * - replace：project 完全替代 user（浅替换，不递归）。
 *
 * merge.arrays（仅 overlay 下生效；replace 本身就是整体替代）：
 * - append：project 数组追加到 user 数组末尾（不去重，保持简单）；
 * - replace（默认）：project 数组完全替代 user 数组。
 *
 * 两类例外键（按 Spec §4.2 示例与 §4.1 语义确定）：
 * - "选择型"数组（targets）：表达"投影到哪些目标"的单一选择，而非内容累积——
 *   Spec 示例明确 user [opencode, codex] + project [claude] 在 overlay 与
 *   replace 下均为 [claude]。故 targets 不受 merge.arrays 控制，project 有值即覆盖。
 * - "快照型"对象（habits.detected）：探测器只读快照，键结构随版本演化，
 *   不做键级深合并——project 存在即整体取 project（"以 project 为准若存在"）。
 */
import type { HabitsInput, ProfileInput } from '../../schema';

/** Spec §4.2 merge.strategy。 */
export type MergeStrategy = 'overlay' | 'replace';

/** Spec §4.2 merge.arrays。 */
export type ArrayMergeMode = 'append' | 'replace';

/** 合并选项（通常来自 project 层 profile.merge 的声明）。 */
export interface MergeOptions {
  readonly strategy: MergeStrategy;
  readonly arrays: ArrayMergeMode;
}

/** 选择型数组键：不受 merge.arrays 控制，project 有值即整体覆盖。 */
const SELECTOR_ARRAY_KEYS = new Set(['targets']);

/** 快照型对象键：不做键级深合并，project 存在即整体取 project。 */
const SNAPSHOT_OBJECT_KEYS = new Set(['detected']);

/** 纯数据对象判断（数组 / null 排除）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 标量（含类型不匹配的兜底）：project 覆盖 user。 */
function mergeScalar(_userValue: unknown, projectValue: unknown): unknown {
  return projectValue;
}

/** 数组：targets 恒覆盖；其余按 merge.arrays。 */
function mergeArrays(
  userValue: unknown[],
  projectValue: unknown[],
  key: string,
  arrays: ArrayMergeMode,
): unknown[] {
  if (SELECTOR_ARRAY_KEYS.has(key)) {
    return [...projectValue];
  }
  return arrays === 'append' ? [...userValue, ...projectValue] : [...projectValue];
}

/** overlay 深合并的单值递归。 */
function mergeValue(
  userValue: unknown,
  projectValue: unknown,
  key: string,
  arrays: ArrayMergeMode,
): unknown {
  if (projectValue === undefined) {
    return userValue; // project 未设置 → 继承 user（§4.2 overlay 核心语义）
  }
  if (userValue === undefined) {
    return projectValue; // user 未设置 → 取 project
  }
  if (isPlainObject(userValue) && isPlainObject(projectValue)) {
    if (SNAPSHOT_OBJECT_KEYS.has(key)) {
      return { ...projectValue }; // 快照型：整体以 project 为准
    }
    const merged: Record<string, unknown> = { ...userValue };
    for (const [childKey, childProjectValue] of Object.entries(projectValue)) {
      merged[childKey] = mergeValue(merged[childKey], childProjectValue, childKey, arrays);
    }
    return merged;
  }
  if (Array.isArray(userValue) && Array.isArray(projectValue)) {
    return mergeArrays(userValue, projectValue, key, arrays);
  }
  return mergeScalar(userValue, projectValue);
}

/** 通用合并主体：null/undefined 层缺失处理 + strategy 分派。 */
function mergeObjects(
  user: Record<string, unknown> | null | undefined,
  project: Record<string, unknown> | null | undefined,
  opts: MergeOptions,
): Record<string, unknown> {
  const userObj = user ?? {};
  const projectObj = project ?? {};
  if (Object.keys(projectObj).length === 0) {
    return { ...userObj }; // project 层缺失（或为空声明）→ user 原样
  }
  if (Object.keys(userObj).length === 0) {
    return { ...projectObj }; // user 层缺失 → project 原样
  }
  if (opts.strategy === 'replace') {
    return { ...projectObj }; // 浅替换（§4.2：完全替代）
  }
  return mergeValue(userObj, projectObj, '', opts.arrays) as Record<string, unknown>;
}

/**
 * 合并 user 级与 project 级 profile（Spec §4.2）。
 *
 * @param user user 层 profile（z.input 形态；层不存在传 null）
 * @param project project 层 profile（z.input 形态；层不存在传 null）
 * @param opts 合并选项（通常取 project 层 profile.merge 的声明）
 * @returns 合并结果（z.input 形态；两层的输入都合法时结果必能通过 ProfileSchema 校验）
 */
export function mergeProfiles(
  user: ProfileInput | null | undefined,
  project: ProfileInput | null | undefined,
  opts: MergeOptions,
): ProfileInput {
  return mergeObjects(user, project, opts) as ProfileInput;
}

/**
 * 合并 user 级与 project 级 habits（与 mergeProfiles 同一语义，Spec §4.2）。
 *
 * 差异点：runtime/tools/ai 等容器照常递归深合并；
 * detected 为探测器只读快照，project 层存在时整体取 project。
 */
export function mergeHabits(
  user: HabitsInput | null | undefined,
  project: HabitsInput | null | undefined,
  opts: MergeOptions,
): HabitsInput {
  return mergeObjects(user, project, opts) as HabitsInput;
}
