/**
 * 声明式适配器的 doctor 检查项（issue #53）。
 *
 * 三条：
 * 1. `adapters/loaded`：列出已加载的声明式适配器（id / 来源文件 / 层）；一个都没有
 *    时也报一条 ok 并说明扫过哪些目录——「我明明放了文件」的第一诊断线索就是
 *    「aforge 到底扫了哪儿」；
 * 2. `adapters/ignored/<id>`：**warn**，project 层未授权而被忽略的适配器。必须可见：
 *    默默不加载会让用户以为文件写错了，而真正的原因是安全边界（见 discovery 的说明）；
 * 3. `adapters/<id>`：**error**，加载失败。退出码归属按成因分（装配冲突 1 / 内容 2）。
 *
 * 本模块只读进程级报告（加载在 CLI 装配阶段已完成），不做任何 IO——这保证它
 * **不可能**把 doctor 报告带走，也就是 issue 里点名的那条要求。
 */
import {
  adapterFailureExitCode,
  adapterLoadReport,
  describeAdapterFailureKind,
} from '../adapters/diagnostics';
import { ADAPTER_ALLOW_PROJECT_ENV, ADAPTERS_DIRNAME } from '../adapters/limits';
import { ExitCode } from '../errors';
import type { DoctorCheckResult } from './check-types';

/** 声明式适配器的加载状态（已加载 / 被忽略 / 失败）。 */
export function checkDeclarativeAdapters(results: DoctorCheckResult[]): void {
  const report = adapterLoadReport();

  const scanned = report.scanned.length === 0 ? '(none)' : report.scanned.join('\n         ');
  results.push({
    section: 'config',
    level: 'ok',
    item: 'adapters/loaded',
    detail:
      report.loaded.length === 0
        ? `declarative adapters: none\nscanned: ${scanned}`
        : `${report.loaded.length} loaded:\n${report.loaded
            .map((entry) => `  ${entry.id} (${entry.layer}) <- ${entry.file}`)
            .join('\n')}\nscanned: ${scanned}`,
    ...(report.loaded.length === 0
      ? {
          hint: `第三方 target 需要在 user 层 SoT 建 ${ADAPTERS_DIRNAME}/ 目录并放 <id>.yaml（见 docs/profile.md）`,
        }
      : {}),
  });

  for (const ignored of report.ignored) {
    results.push({
      section: 'config',
      level: 'warn',
      item: `adapters/ignored/${ignored.id}`,
      detail: `${ignored.file}: project 层适配器默认被忽略（未授权），该 target 不会注册`,
      hint: `project 层适配器能声明往用户主目录写文件——确认该仓库可信后设 ${ADAPTER_ALLOW_PROJECT_ENV}=1 再重试；或把这份适配器搬到 user 层 SoT 的 ${ADAPTERS_DIRNAME}/ 下`,
    });
  }

  for (const failure of report.failures) {
    results.push({
      section: 'config',
      level: 'error',
      code: adapterFailureExitCode(failure.kind) === 1 ? ExitCode.Generic : ExitCode.Config,
      item: `adapters/${failure.id}`,
      detail: `${failure.file}: ${describeAdapterFailureKind(failure.kind)}——${failure.message}`,
      hint: failure.hint,
    });
  }
}
