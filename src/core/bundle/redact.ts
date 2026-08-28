/**
 * 导出前的净化改写（`aforge bundle export` 的 transform 阶段）。
 *
 * 两条改写都发生在**内存里的解析对象**上，原 SoT 文件一字不动——export 是只读操作。
 *
 * - stripDetected：剔掉 `habits.detected`（本机探测快照：工具版本与可执行文件路径）。
 *   带到新机器只会是过期信息，而 doctor 会拿它报环境类 warning，import 后一条
 *   `aforge detect` 就能重建，没有保留价值。
 * - redactProfileSecrets：把 `mcp.servers[].env` / `.headers` 的**值**换成显式占位符，
 *   键名与路径记进 manifest.redacted。占位符刻意写成一眼假的字符串而不是空串或
 *   `${VAR}`：空串会让 server 看起来配好了却静默鉴权失败，`${VAR}` 会被误当成
 *   AgentForge 支持变量展开（并不支持）。
 *
 * 副作用契约：两个函数都返回**新对象**，不改入参（调用方拿到的解析结果还要用于
 * 判断 sources 的 local 路径等，不能被悄悄改掉）。
 */
import type { HabitsInput, McpServerInput, ProfileInput } from '../../schema';

/** 被抹掉的凭据值在导出产物里的占位符（一眼可辨、绝不可能误当成真值）。 */
export const REDACTED_PLACEHOLDER = '<redacted-by-aforge-bundle-export>';

/** 剔除 `detected` 后的 habits（其余键原样保留，含用户扩展键）。 */
export function stripDetected(habits: HabitsInput): {
  readonly habits: HabitsInput;
  readonly changed: boolean;
} {
  if (habits.detected === undefined) {
    return { habits, changed: false };
  }
  const { detected: _detected, ...rest } = habits;
  return { habits: rest, changed: true };
}

/** redactProfileSecrets 结果。 */
export interface RedactResult {
  readonly profile: ProfileInput;
  /** 被抹掉的字段路径（`mcp.servers[jenkins].headers.Authorization`），已排序。 */
  readonly redacted: string[];
}

/** 抹掉一个 record 的全部值，返回新 record 与命中的字段路径。 */
function redactRecord(
  record: Readonly<Record<string, string>> | undefined,
  pathPrefix: string,
  hits: string[],
): Record<string, string> | undefined {
  if (record === undefined) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const key of Object.keys(record)) {
    out[key] = REDACTED_PLACEHOLDER;
    hits.push(`${pathPrefix}.${key}`);
  }
  return out;
}

/** 单个 server 的净化（env / headers 两处凭据面）。 */
function redactServer(server: McpServerInput, index: number, hits: string[]): McpServerInput {
  // 路径里优先用 name（用户在 profile.yaml 里认得出来），缺名时退回下标
  const label = server.name === '' ? `#${index}` : server.name;
  const prefix = `mcp.servers[${label}]`;
  const env = redactRecord(server.env, `${prefix}.env`, hits);
  const headers = redactRecord(server.headers, `${prefix}.headers`, hits);
  const next: McpServerInput = { ...server };
  if (env !== undefined) {
    next.env = env;
  }
  if (headers !== undefined) {
    next.headers = headers;
  }
  return next;
}

/**
 * 抹掉 profile 里的 MCP 凭据。
 *
 * 只动 `mcp.servers[].env` / `.headers`——这是 §4.2 里唯一约定承载密钥的两处。
 * `extensions` 等自由键不碰：那里的内容 AgentForge 不认识形状，猜着抹既可能漏
 * （嵌套结构）又可能毁掉正常配置，不如原样带走并由 warning 提醒用户自己过一遍。
 */
export function redactProfileSecrets(profile: ProfileInput): RedactResult {
  const servers = profile.mcp?.servers;
  if (servers === undefined || servers.length === 0) {
    return { profile, redacted: [] };
  }
  const hits: string[] = [];
  const nextServers = servers.map((server, index) => redactServer(server, index, hits));
  if (hits.length === 0) {
    return { profile, redacted: [] };
  }
  return {
    profile: { ...profile, mcp: { ...profile.mcp, servers: nextServers } },
    redacted: hits.sort(),
  };
}
