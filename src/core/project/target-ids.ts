/**
 * 内置 target id 元组（Spec §4.2）——**编译期字面量的唯一事实源**。
 *
 * 为什么单独成一个叶子模块（只有常量、零 import）：
 * `projectors/registry` 与 `schema/profile` 都需要这份 id 全集，但让
 * `schema/profile` 去 import registry 会成环
 * （registry → projectors/* → project/types → schema/profile → registry）。
 * 放在无依赖的叶子上，两侧都能取，且不引入任何运行时耦合。
 *
 * 两处消费点：
 * - `projectors/registry`：装配表以此为键的全集校验（漏一个内置 projector 即编译失败），
 *   注册顺序也按本元组的顺序（不依赖 `Object.keys` 的运行时插入序）；
 * - `schema/profile.TargetEnum`：`profile.yaml` 的 targets 取值域。
 *
 * 注意它**不是**运行时可用集合：运行时后补注册的第三方 target 不在此列，
 * `--targets` 校验一律走 `registeredTargetIds()`。
 */

/** 内置 target 全集（顺序 = 默认投影顺序 = Spec §4.2）。 */
export const BUILTIN_TARGET_IDS = ['opencode', 'codex', 'claude', 'pi'] as const;

/** 内置 target id 的字面量联合（`profile.targets` 与 init 选项的类型来源）。 */
export type BuiltinTargetId = (typeof BUILTIN_TARGET_IDS)[number];
