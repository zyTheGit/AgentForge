/**
 * 环境变量快照（Spec §2.4）。
 *
 * readEnv 只做"读取 + 宽松解析"，不做业务校验：
 * 非法值（如 AGF_SCOPE=foo）一律降级为 undefined，由上层在具体命令中
 * 以 ConfigError(2) 报告；这样 doctor 能同时报告多个问题而非首个。
 */
import type { Host } from '../infra/host';

/** Spec §4.2 projection.line_ending。 */
export type LineEnding = 'lf' | 'crlf';

/** Spec §4.2 scope。 */
export type Scope = 'user' | 'project';

/** 进程启动时的一次性环境快照（不可变）。 */
export interface EnvSnapshot {
  /** AGF_HOME：用户级 SoT 根目录（原样字符串，规范化见 core/paths）。 */
  readonly agfHome: string | undefined;
  /** AGF_SCOPE：强制 scope（仅接受 user | project，非法值 → undefined）。 */
  readonly agfScope: Scope | undefined;
  /** AGF_OFFLINE=1 → true（严格匹配 "1"）。 */
  readonly offline: boolean;
  /** AGF_LINE_ENDING：lf | crlf（非法值 → undefined，由上层校验）。 */
  readonly lineEnding: LineEnding | undefined;
  /** CI 真值检测（Spec §10：为真时禁止写入 learnings）。 */
  readonly ci: boolean;
  /** CODEX_HOME：Codex 根目录覆盖（Spec §2.2）。 */
  readonly codexHome: string | undefined;
  /**
   * 用户目录：USERPROFILE 优先于 HOME（Windows 语义，Spec §2.4）。
   * 两者都缺失时为 undefined（路径解析层负责报 ConfigError）。
   */
  readonly userProfile: string | undefined;
}

/** 读取环境变量：全空白视为未设置。 */
function rawEnv(host: Host, key: string): string | undefined {
  const value = host.env(key);
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** CI 真值检测：undefined/空/false/0（大小写不敏感）→ false，其余 → true。 */
function isTruthyCi(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const v = value.trim().toLowerCase();
  return !(v === '' || v === 'false' || v === '0');
}

/** 读取并解析 AgentForge 关注的全部环境变量（Spec §2.4）。 */
export function readEnv(host: Host): EnvSnapshot {
  const scope = rawEnv(host, 'AGF_SCOPE');
  const lineEnding = rawEnv(host, 'AGF_LINE_ENDING');
  return {
    agfHome: rawEnv(host, 'AGF_HOME'),
    agfScope: scope === 'user' || scope === 'project' ? scope : undefined,
    offline: rawEnv(host, 'AGF_OFFLINE') === '1',
    lineEnding: lineEnding === 'lf' || lineEnding === 'crlf' ? lineEnding : undefined,
    ci: isTruthyCi(host.env('CI')),
    codexHome: rawEnv(host, 'CODEX_HOME'),
    userProfile: rawEnv(host, 'USERPROFILE') ?? rawEnv(host, 'HOME'),
  };
}
