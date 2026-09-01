/**
 * Projector 注册表（M6 起四件套；Phase 3 起是 target 全集的**唯一运行时事实源**）。
 *
 * 注册顺序 = Spec §4.2 targets 全集顺序（opencode → codex → claude → pi），
 * list() 的顺序即"无过滤时的默认投影顺序"（engine 事务按此逐一 apply）。
 *
 * 两个层次要分清：
 * - `BUILTIN_TARGET_IDS`：**内置** target 的编译期字面量元组（定义在叶子模块
 *   `../target-ids`，`schema/profile` 的 TargetEnum 与本文件的装配表同取一份），
 *   只用于类型窄化与 init 交互的 multiselect 选项；
 * - `registeredTargetIds()`：**运行时**已注册 id，`--targets` 校验与错误提示的基准。
 *   它是函数而非常量：常量等于「模块加载时刻的快照」，运行时后补注册的 projector
 *   永远不会被看到（Phase 3 前 `REGISTERED_PROJECTORS` 正是这个毛病）。
 */
import { Registry } from '../../registry';
import { BUILTIN_TARGET_IDS, type BuiltinTargetId } from '../target-ids';
import type { Projector } from '../types';
import { claudeProjector } from './claude';
import { codexProjector } from './codex';
import { opencodeProjector } from './opencode';
import { piProjector } from './pi';

export { BUILTIN_TARGET_IDS, type BuiltinTargetId } from '../target-ids';

/**
 * 内置 projector 的装配表（id → 工厂）。
 *
 * `satisfies Readonly<Record<BuiltinTargetId, () => Projector>>` 卡的是**全集**：
 * `BUILTIN_TARGET_IDS` 里加了 id 却没在这里给工厂 → 编译失败；反之给了表外的键
 * 也编译失败。注册顺序不取 `Object.keys`（那只是运行时插入序），而是按
 * `BUILTIN_TARGET_IDS` 元组顺序遍历，见下方 for 循环。
 */
const BUILTIN_PROJECTOR_FACTORIES = {
  opencode: () => opencodeProjector,
  codex: () => codexProjector,
  claude: () => claudeProjector,
  pi: () => piProjector,
} as const satisfies Readonly<Record<BuiltinTargetId, () => Projector>>;

/** 全局 projector 注册表（模块加载时装配内置四件套；实例经工厂惰性获取并缓存）。 */
export const projectorRegistry: Registry<Projector> = new Registry<Projector>();

for (const id of BUILTIN_TARGET_IDS) {
  projectorRegistry.register(id, BUILTIN_PROJECTOR_FACTORIES[id]);
}

/**
 * 当前已注册的 target id（按注册顺序；不触发 projector 实例化）。
 *
 * 每次调用现取——调用方不得把它存成模块级常量（见文件头注释）。
 */
export function registeredTargetIds(): readonly string[] {
  return projectorRegistry.ids();
}
