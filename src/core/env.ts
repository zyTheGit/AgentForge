/**
 * 环境变量快照（Spec §2.4）。
 *
 * readEnv 只做"读取 + 宽松解析"，不做业务校验：
 * 非法值（如 AGF_SCOPE=foo）一律降级为 undefined，由上层在具体命令中
 * 以 ConfigError(2) 报告；这样 doctor 能同时报告多个问题而非首个。
 */
import type { Host } from '../infra/host';
import { currentOs, type OsContext } from './paths';

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
   * PI_CODING_AGENT_DIR：pi 的 agent 目录覆盖（Spec §2.2）。
   *
   * 与 `codexHome` 同构：置位时 pi 的 user scope 落点（AGENTS.md / skills / mcp.json）
   * 整体改到它指向的目录——上游 pi 与 pi-mcp-adapter 也是按这个变量找 agent 目录的。
   */
  readonly piCodingAgentDir: string | undefined;
  /**
   * 用户目录（Spec §2.4）：win32 上 USERPROFILE 优先、类 Unix 上 HOME 优先；
   * 两者皆缺时退回 host.homedir()。全都取不到才是 undefined（路径解析层报
   * ConfigError）。
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

/**
 * 家目录解析（Spec §2.4）：按平台决定 USERPROFILE 与 HOME 的优先级。
 *
 * 为什么必须平台化而不能固定 `USERPROFILE ?? HOME`：WSL 互操作会把 Windows 侧
 * 的 USERPROFILE（`C:\Users\x`）带进 Linux 进程，部分 CI 镜像与 Wine 也如此。
 * 固定优先 USERPROFILE 会让 posix 上的用户级 SoT 落到一个不存在的盘符路径下。
 *
 * 两个变量都缺时退回 host.homedir()：POSIX 上 HOME 未导出（`sh -c`、部分容器）
 * 时它仍能从 passwd 拿到，比直接报 ConfigError 更可用。
 */
function resolveUserProfile(host: Host, os: OsContext): string | undefined {
  const fromEnv =
    os.platform === 'win32'
      ? (rawEnv(host, 'USERPROFILE') ?? rawEnv(host, 'HOME'))
      : (rawEnv(host, 'HOME') ?? rawEnv(host, 'USERPROFILE'));
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const home = host.homedir()?.trim();
  return home === undefined || home === '' ? undefined : home;
}

/**
 * 读取并解析 AgentForge 关注的全部环境变量（Spec §2.4）。
 *
 * @param os 宿主平台（决定 USERPROFILE / HOME 优先级）；缺省取当前进程平台，
 *        测试请显式注入。
 */
export function readEnv(host: Host, os: OsContext = currentOs()): EnvSnapshot {
  const scope = rawEnv(host, 'AGF_SCOPE');
  const lineEnding = rawEnv(host, 'AGF_LINE_ENDING');
  return {
    agfHome: rawEnv(host, 'AGF_HOME'),
    agfScope: scope === 'user' || scope === 'project' ? scope : undefined,
    offline: rawEnv(host, 'AGF_OFFLINE') === '1',
    lineEnding: lineEnding === 'lf' || lineEnding === 'crlf' ? lineEnding : undefined,
    ci: isTruthyCi(host.env('CI')),
    codexHome: rawEnv(host, 'CODEX_HOME'),
    piCodingAgentDir: rawEnv(host, 'PI_CODING_AGENT_DIR'),
    userProfile: resolveUserProfile(host, os),
  };
}
