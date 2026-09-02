/**
 * 声明式适配器的 fail-fast 闸门（issue #53）。
 *
 * 为什么加载阶段不直接抛、要单独有个闸门：加载发生在 CLI 装配阶段（任何命令之前），
 * 在那里抛异常会让 **`aforge doctor` 整份报告消失**——而适配器坏掉正是最需要
 * doctor 的时刻（PR #59 踩过同一个坑：`checkTargetPaths` 的 ConfigError 一路冒到
 * `runDoctorChecks` 之外，把几十项检查一起带走）。所以加载只收集，处置分两条：
 *
 * - `aforge doctor`：把每条失败报成一条 error 条目（`core/doctor/check-adapters`），
 *   继续跑完其余检查；
 * - `aforge sync`：调用本模块的闸门。
 *
 * 闸门只拦**装配冲突**（`builtin-id` / `duplicate-id`）→ GenericError(1)，复用
 * Registry 对重复 id 的现有语义。内容类失败（yaml / schema / template / containment）
 * 不在这里拦，因为它们有更精准的出口：
 * - 该 target 写在 `profile.targets` 里 → `schema/profile.TargetEnum` 拒收，报的是
 *   「适配器 X 加载失败：<具体成因>」（见 core/adapters/diagnostics）；
 * - 没写在 profile 里 → 它压根不参与本次投影，为它中断 sync 只是误伤。
 */
import { GenericError } from '../errors';
import { adapterFailureExitCode, adapterLoadReport } from './diagnostics';

/**
 * sync 前置：适配器装配冲突 → GenericError(1)。
 *
 * @throws GenericError(1) 有适配器 id 撞内置 id 或撞另一个已加载的适配器。
 */
export function assertNoAdapterAssemblyConflicts(): void {
  const conflicts = adapterLoadReport().failures.filter(
    (failure) => adapterFailureExitCode(failure.kind) === 1,
  );
  if (conflicts.length === 0) {
    return;
  }
  const lines = conflicts.map((c) => `  - ${c.file}: ${c.message}`);
  throw new GenericError(`声明式适配器 id 冲突，共 ${conflicts.length} 处:\n${lines.join('\n')}`, {
    hint: conflicts[0]?.hint ?? '给冲突的适配器换一个 id',
    details: { conflicts },
  });
}
