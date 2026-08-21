/**
 * AgentForge 错误体系与退出码（Spec §6.1）。
 *
 * 约定：
 * - CLI 任何失败路径最终都映射为一个退出码；AgentForgeError.code 即退出码。
 * - `hint` 必须是可操作的修复建议（一句话，告诉用户下一步做什么）。
 * - `details` 保留原始错误/结构化上下文，供 doctor / --json 诊断输出。
 */

/** 进程退出码语义（Spec §6.1）。 */
export const ExitCode = {
  /** 成功 */
  Success: 0,
  /** 通用错误（含部分投影失败回滚） */
  Generic: 1,
  /** 配置/校验错误（learning id 不存在、sources.json 损坏、init 目录非空、模板语法错误） */
  Config: 2,
  /** 投影冲突需人工处理（marker 区间被手动修改、promote 目标文件名冲突） */
  Conflict: 3,
  /** 目标路径无写权限（Windows 常见） */
  Permission: 4,
  /** 离线模式禁止操作（AGF_OFFLINE=1 时触发网络操作） */
  Offline: 5,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export interface AgentForgeErrorOptions {
  /** 可操作的修复建议（必填于用户可自行修复的场景） */
  readonly hint?: string;
  /** 原始错误或结构化上下文（诊断用，不直接打印给普通用户） */
  readonly details?: unknown;
}

/** AgentForge 全部可预期错误的基类。 */
export class AgentForgeError extends Error {
  readonly code: ExitCode;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(code: ExitCode, message: string, options: AgentForgeErrorOptions = {}) {
    super(message);
    this.name = 'AgentForgeError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
}

/** 通用错误 → 退出码 1。 */
export class GenericError extends AgentForgeError {
  constructor(message: string, options: AgentForgeErrorOptions = {}) {
    super(ExitCode.Generic, message, options);
    this.name = 'GenericError';
  }
}

/** 配置/校验错误 → 退出码 2（fail-fast：投影开始前终止整个流程）。 */
export class ConfigError extends AgentForgeError {
  constructor(message: string, options: AgentForgeErrorOptions = {}) {
    super(ExitCode.Config, message, options);
    this.name = 'ConfigError';
  }
}

/** 投影冲突需人工处理 → 退出码 3。 */
export class ConflictError extends AgentForgeError {
  constructor(message: string, options: AgentForgeErrorOptions = {}) {
    super(ExitCode.Conflict, message, options);
    this.name = 'ConflictError';
  }
}

/** 目标路径无写权限 → 退出码 4（Windows 常见：只读属性 / 文件被占用 / ACL）。 */
export class PermissionError extends AgentForgeError {
  constructor(message: string, options: AgentForgeErrorOptions = {}) {
    super(ExitCode.Permission, message, options);
    this.name = 'PermissionError';
  }
}

/** 离线模式禁止操作 → 退出码 5（AGF_OFFLINE=1 时触发网络操作）。 */
export class OfflineError extends AgentForgeError {
  constructor(message: string, options: AgentForgeErrorOptions = {}) {
    super(ExitCode.Offline, message, options);
    this.name = 'OfflineError';
  }
}

/**
 * 投影阶段失败聚合用的严重度权重（Spec §7.3：退出码取失败 target 中最高严重度）。
 *
 * 参与投影阶段比较的码（高 → 低）：
 *   Permission(4)=40 > Conflict(3)=30 > Generic(1)=10 > Success(0)=0
 *
 * 不参与投影阶段比较的码（返回负值，max() 聚合时让位给投影类错误）：
 *   - Config(2)=-1：fail-fast，校验失败在投影开始前终止整个 sync；
 *   - Offline(5)=-2：独立域，网络操作前置检查失败，与投影阶段无关。
 *
 * 未知 code 按 Generic(10) 处理（安全默认）。
 */
export function severityOf(code: number): number {
  switch (code) {
    case ExitCode.Success:
      return 0;
    case ExitCode.Generic:
      return 10;
    case ExitCode.Conflict:
      return 30;
    case ExitCode.Permission:
      return 40;
    case ExitCode.Config:
      return -1;
    case ExitCode.Offline:
      return -2;
    default:
      return 10;
  }
}

/** 将任意抛出值映射为进程退出码：AgentForgeError → 其 code；未知错误 → 1（Spec §6.1）。 */
export function toExitCode(err: unknown): number {
  if (err instanceof AgentForgeError) {
    return err.code;
  }
  return ExitCode.Generic;
}
