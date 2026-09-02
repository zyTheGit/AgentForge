/**
 * target id 的两层事实源（Spec §4.2）——**零 import 的叶子模块**。
 *
 * 为什么单独成一个叶子（只有常量与一个小状态表、零 import）：
 * `projectors/registry` 与 `schema/profile` 都需要 target id 全集，但让
 * `schema/profile` 去 import registry 会成环
 * （registry → projectors/* → project/types → schema/profile → registry）。
 * 放在无依赖的叶子上，两侧都能取，且不引入任何运行时耦合。
 *
 * 三个层次要分清：
 * - `BUILTIN_TARGET_IDS`：**编译期字面量**元组，CLI 自带的四个 target。用于类型
 *   窄化与「内置 projector 装配表的全集校验」；
 * - `declarativeTargetIds()`：Phase 3 第二层由 `adapters/<id>.yaml` 注册进来的
 *   **第三方** target id（注册路径只有 `core/adapters/loader` 一处）；
 * - `knownTargetIds()` = 前两者之和 = **`profile.yaml` 的 targets 取值域**
 *   （`schema/profile.TargetEnum` 现读它）。
 *
 * 与「运行时可用集合」（`projectors/registry.registeredTargetIds()`）的关系：
 * 生产路径上两者相等——声明式适配器的注册是**一次调用写两边**（见 loader）。
 * 裸调 `projectorRegistry.register()`（只有测试会这么做）只进运行时集合、不进
 * profile 取值域：程序性注册没有可供诊断的来源文件，让它能写进用户的 profile.yaml
 * 反而会造出「profile 里有个 id，但谁都说不出它从哪来」的状态。
 */

/** 内置 target 全集（顺序 = 默认投影顺序 = Spec §4.2）。 */
export const BUILTIN_TARGET_IDS = ['opencode', 'codex', 'claude', 'pi'] as const;

/** 内置 target id 的字面量联合（`init` 选项的类型来源）。 */
export type BuiltinTargetId = (typeof BUILTIN_TARGET_IDS)[number];

/**
 * 声明式适配器注册进来的 id（顺序 = 注册顺序）。
 *
 * 刻意是模块级可变状态而不是「加载时算好的常量」：加载发生在 CLI 装配阶段，
 * 而 `schema/profile` 的模块初始化可能更早——`TargetEnum` 因此必须在**每次校验时**
 * 现读这张表，不能在模块加载时把它快照成一个 z.enum。
 */
const declarativeIds: string[] = [];

/** 登记一个声明式适配器 id（只由 core/adapters/loader 调用）。 */
export function registerDeclarativeTargetId(id: string): void {
  if (!declarativeIds.includes(id)) {
    declarativeIds.push(id);
  }
}

/** 当前已登记的声明式 target id（按注册顺序）。 */
export function declarativeTargetIds(): readonly string[] {
  return [...declarativeIds];
}

/** 复位（测试用；生产路径只在进程启动时写一次）。 */
export function resetDeclarativeTargetIds(): void {
  declarativeIds.length = 0;
}

/**
 * `profile.yaml` 的 targets 取值域：内置 + 已加载的声明式适配器。
 *
 * 每次调用现取——调用方不得把结果存成模块级常量（那等于把快照搬到模块加载时刻，
 * 声明式适配器永远不会出现在里面）。
 */
export function knownTargetIds(): readonly string[] {
  return [...BUILTIN_TARGET_IDS, ...declarativeIds];
}
