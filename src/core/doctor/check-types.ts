/**
 * Doctor 检查的对外数据契约与错误归属（Spec §9）。
 *
 * 为什么单独成模块：这些类型是 `--json` 输出的稳定结构（DoctorCheckResult /
 * DoctorReport），被全部检查项模块与命令层同时消费。放在最底层且**不 import 任何
 * 检查项模块**，是各检查项模块能单向依赖、彼此不成环的前提；退出码聚合
 * （doctorExitCode）与「任意错误 → 退出码 / message / hint」三个映射同样只依赖
 * errors，与具体检查项无关，放在这里让检查项模块无需互相 import 就能复用。
 */
import { AgentForgeError, ExitCode } from '../errors';

/** 单项检查结果级别（人类可读输出映射为 OK / WARN / FAIL，纯 ASCII）。 */
export type DoctorLevel = 'ok' | 'warn' | 'error';

/** 报告分组（人类可读输出按此分节）。 */
export type DoctorSection = 'config' | 'paths' | 'consistency' | 'environment';

/** 单项检查结果（--json 输出的原子单元；路径一律绝对路径字符串，§6.2）。 */
export interface DoctorCheckResult {
  readonly section: DoctorSection;
  readonly level: DoctorLevel;
  /** 检查项标识（如 initialization / yaml/user.profile.yaml / path/claude）。 */
  readonly item: string;
  /** 详情（可含 \n 多行）。 */
  readonly detail: string;
  /** error 级的退出码归属（2=配置 / 3=冲突 / 4=权限 / 1=UNC 等）；ok/warn 不设。 */
  readonly code?: ExitCode;
  /** 修复建议（error/warn 级附操作指引）。 */
  readonly hint?: string;
}

/** doctor 诊断报告：全部检查项 + 聚合退出码。 */
export interface DoctorReport {
  readonly results: readonly DoctorCheckResult[];
  readonly exitCode: number;
}

/**
 * 聚合退出码（Spec §6.1 语义在 doctor 的映射，M7 任务定义）：
 * - 任一 error 级 Permission 类（code 4）→ 4；
 * - 否则任一 error 级 Conflict 类（code 3）→ 3；
 * - 否则任一其他 error（code 2 配置 / 1 UNC 等）→ 取最大值；
 * - 仅 warn / ok → 0。
 */
export function doctorExitCode(results: readonly DoctorCheckResult[]): number {
  let code: number = ExitCode.Success;
  for (const result of results) {
    if (result.level === 'error') {
      const candidate = result.code ?? ExitCode.Config;
      if (candidate > code) {
        code = candidate;
      }
    }
  }
  return code;
}

/** 任意错误的退出码归属：AgentForgeError → 其 code；未知 → 2（配置域安全默认）。 */
export function toDoctorCode(err: unknown): ExitCode {
  return err instanceof AgentForgeError ? err.code : ExitCode.Config;
}

/** 任意错误的 message（诊断条目 detail 用）。 */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** AgentForgeError 的 hint（有则透传给检查条目）。 */
export function errHint(err: unknown): string | undefined {
  return err instanceof AgentForgeError ? err.hint : undefined;
}
