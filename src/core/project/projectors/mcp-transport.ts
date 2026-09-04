/**
 * MCP transport 归一化层（Spec §4.2 / §8.3-§8.6，Phase 2「MCP 字段与上游对齐」）。
 *
 * 唯一职责：把 **AgentForge 的 transport 语义**（`stdio` / `http` / `sse`）翻译成
 * **每家上游客户端真正读得懂的字段**，并在某家表达不了某种 transport 时给出可见的
 * 降级/跳过结论。四个 projector 只负责「落哪个路径、顶层键叫什么、什么动作」，
 * 不再各写一遍 if/else——此前三处映射并存（claude+pi 一份、opencode 一份、codex 一份）
 * 是这块最大的维护风险，也正是三处形状与上游实际契约各自漂移的原因。
 *
 * 上游能力矩阵（2026-09 实测，见 docs/mcp.md 的来源与命令记录）：
 *
 * | transport | claude `.mcp.json` | opencode `opencode.json` | codex `config.toml` | pi `mcp.json` |
 * |-----------|--------------------|--------------------------|---------------------|---------------|
 * | stdio     | `type:"stdio"` + command/args/env | `type:"local"` + command[] / environment | `[mcp_servers.N]` command/args/env | command/args/env |
 * | http      | `type:"http"` + url/headers | `type:"remote"` + url/headers | `url` + `http_headers` | `url` + `headers` + `httpTransport:"streamable-http"` |
 * | sse       | `type:"sse"` + url/headers | **表达不了** → 按 remote 投，实际走 streamable HTTP | **不支持** → 跳过 | `url` + `headers` + `httpTransport:"sse"` |
 *
 * 三条硬约束：
 * - `enabled === false` 的 server 一律不投影（Spec §4.2 语义，四个 target 同口径）；
 * - 可选字段 undefined 时**不产出该键**（载荷最小，便于 merge_json 的深合并比较）；
 * - 只写上游认得的键：codex 的 header 键是 `http_headers`（`headers` 会被静默忽略），
 *   pi 的原生 server 条目**没有** `type` 字段（写了也只是死键）。写死键等于让用户
 *   以为配置生效——比不写更糟。
 *
 * 矩阵只覆盖这四个内置 id，而 `profile.targets` 还能填声明式适配器 id。矩阵外的 id
 * 一律**跳过落差判定**，由 `collectUnmeasuredMcpTransportTargets` 单独收集，doctor / sync
 * 各出一条占位 warn，不猜默认值（论证见
 * `collectMcpTransportNoticesForTargets` 与 `isMcpProjectionTargetId` 的注释）。
 *
 * 本模块为纯函数集合：不做 IO、不读环境、不改写入参。
 */
import type { McpServer, Transport } from '../../../schema';
import type { BuiltinTargetId } from '../target-ids';

/**
 * 有 MCP 投影的 target = 内置 target 全集（`target-ids.ts` 的单一事实源）。
 *
 * 刻意取别名而不是另写一遍四个字面量：矩阵是 `Record<McpProjectionTargetId, …>`，
 * 与 `BUILTIN_TARGET_IDS` 挂上之后「新增内置 target 却漏填矩阵」才会编译失败。
 * 手写联合的话新 target 会被 `isMcpProjectionTargetId` 判成矩阵外，**静默**降级成
 * unmeasured warn——本模块新增的那条通路恰好会把这类漏填从崩溃变成静默。
 */
export type McpProjectionTargetId = BuiltinTargetId;

/**
 * 某个 target 对某种 transport 的支持程度。
 *
 * - `native`：上游有对应字段，语义无损；
 * - `degraded`：会投影出去，但上游表达不了该 transport 的**区分**，实际连接行为
 *   退化成另一种（目前只有 opencode 的 sse → streamable HTTP）；
 * - `unsupported`：上游根本没有这种 transport，该 server 在此 target **整条跳过**
 *   （目前只有 codex 的 sse）。跳过而不是硬写一张 codex 读不懂的表——后者会让
 *   整个 `config.toml` 加载失败，把用户的其他配置一起带下水。
 */
export type McpTransportSupport = 'native' | 'degraded' | 'unsupported';

/** 单条降级/跳过结论（doctor warn 与 sync 输出共用同一份文案，避免两处口径分叉）。 */
export interface McpTransportNotice {
  readonly targetId: McpProjectionTargetId;
  readonly serverName: string;
  readonly transport: Transport;
  readonly support: 'degraded' | 'unsupported';
  /** 发生了什么（人类可读，已含 target / server / transport 三要素）。 */
  readonly detail: string;
  /** 怎么消除（可直接照做的动作）。 */
  readonly hint: string;
}

/** 能力矩阵里一格的内容：支持程度 + 非 native 时的说明与建议。 */
interface TransportRule {
  readonly support: McpTransportSupport;
  /** support !== 'native' 时必填：不带 server 名的原因描述（调用方前置 server 名）。 */
  readonly reason?: string;
  readonly hint?: string;
}

const NATIVE: TransportRule = { support: 'native' };

/**
 * transport × target 能力矩阵（**单一事实源**）。
 *
 * 写成显式的四×三而不是「除了特例都 native」：新增 target 或上游放开某种 transport
 * 时，TS 会强制把每一格都填上，漏掉即编译失败——这正是先前三处映射能各自漂移的
 * 反面。每一格的结论都要在 docs/mcp.md 里能找到对应的实测来源。
 */
const MCP_TRANSPORT_MATRIX: Readonly<
  Record<McpProjectionTargetId, Readonly<Record<Transport, TransportRule>>>
> = {
  // Claude Code 三种 transport 全支持，`type` 取值就是 stdio / http / sse
  claude: { stdio: NATIVE, http: NATIVE, sse: NATIVE },
  // OpenCode 的 remote 形态只有 url，没有任何字段能声明 SSE
  opencode: {
    stdio: NATIVE,
    http: NATIVE,
    sse: {
      support: 'degraded',
      reason:
        'opencode 的远端 server 只有 type: "remote" 一种形态（字段仅 url / headers / oauth），无法声明 SSE——该 server 会按 streamable HTTP 连接',
      hint: '端点同时支持 streamable HTTP 时改用 transport: http（语义一致且无告警）；只支持 SSE 的端点请从 opencode 的 targets 里去掉，或改用 claude / pi',
    },
  },
  // Codex 只支持 STDIO 与 Streamable HTTP，没有 SSE 传输
  codex: {
    stdio: NATIVE,
    http: NATIVE,
    sse: {
      support: 'unsupported',
      reason:
        'codex 只支持 STDIO 与 Streamable HTTP 两种 transport，没有 SSE——该 server 不会写进 .codex/config.toml 的 AgentForge 标记段',
      hint: '端点同时支持 streamable HTTP 时改用 transport: http；否则该 server 只能在 claude / pi / opencode 侧使用',
    },
  },
  // pi-mcp-adapter 默认 streamable HTTP 并可回退 SSE，httpTransport 能强制指定
  pi: { stdio: NATIVE, http: NATIVE, sse: NATIVE },
};

/**
 * 该 target id 是否在能力矩阵里有一格（矩阵查询的唯一准入判据）。
 *
 * 存在的理由：`profile.targets` 的取值域是「四个内置 id + 已加载的声明式适配器 id」
 * （`target-ids.ts` 的 `knownTargetIds()`），而矩阵只覆盖四个内置 id。此前调用方用
 * `as McpProjectionTargetId` 把 string 强转进来，声明式 id 会让
 * `MCP_TRANSPORT_MATRIX[id]` 取到 undefined，下一跳 `[transport]` 直接 TypeError
 * ——`sync` 与 `doctor` 双双崩在退出码 1。强转掩盖的正是这个真实的取值域落差。
 */
export function isMcpProjectionTargetId(targetId: string): targetId is McpProjectionTargetId {
  return Object.hasOwn(MCP_TRANSPORT_MATRIX, targetId);
}

/** 查某个 target 对某种 transport 的支持程度（能力矩阵的唯一读取入口）。 */
export function mcpTransportSupport(
  targetId: McpProjectionTargetId,
  transport: Transport,
): McpTransportSupport {
  return MCP_TRANSPORT_MATRIX[targetId][transport].support;
}

/**
 * 收集某个 target 本轮的降级/跳过结论（纯函数）。
 *
 * `enabled === false` 的 server 不参与——它压根不投影，为它报降级只是噪音。
 */
export function collectMcpTransportNotices(
  targetId: McpProjectionTargetId,
  servers: readonly McpServer[],
): McpTransportNotice[] {
  const notices: McpTransportNotice[] = [];
  for (const server of servers) {
    if (server.enabled === false) {
      continue;
    }
    const rule = MCP_TRANSPORT_MATRIX[targetId][server.transport];
    if (rule.support === 'native') {
      continue;
    }
    notices.push({
      targetId,
      serverName: server.name,
      transport: server.transport,
      support: rule.support,
      detail: `MCP server ${server.name}（transport: ${server.transport}）: ${rule.reason ?? ''}`,
      hint: rule.hint ?? '',
    });
  }
  return notices;
}

/**
 * 一次投影里全部**已实测** target 的降级/跳过结论（sync 引擎与 doctor 的共同入口）。
 *
 * 结论只取决于「SoT 里有哪些 server」×「投影哪些 target」，与写入成败无关，
 * 因此 sync 的 dry-run 也照样给（用户在真写之前就该看到 codex 会跳掉哪条）。
 *
 * `targetIds` 收 `string[]`：调用方拿到的是 profile.targets / PlannedTarget 的 targetId，
 * 取值域含声明式适配器 id（`knownTargetIds()`），**不止四个内置 id**。矩阵里没有那一格的
 * id 在此**跳过**，由 `collectUnmeasuredMcpTransportTargets` 单独出一条占位 warn——
 * 跳过而不是猜一格默认值：猜 native 等于替第三方 target 打包票，猜 unsupported 会
 * 无声吞掉本该投影的 server。
 */
export function collectMcpTransportNoticesForTargets(
  targetIds: readonly string[],
  servers: readonly McpServer[],
): McpTransportNotice[] {
  // 先去重：profile.targets 是 z.array(TargetEnum).min(1)，**不做唯一性校验**，
  // 同一 id 写两遍会产出两条 item 名完全相同的结论（口径同 unmeasured 侧的 Set）
  return [...new Set(targetIds)]
    .filter(isMcpProjectionTargetId)
    .flatMap((targetId) => collectMcpTransportNotices(targetId, servers));
}

/** 未实测 target 的 doctor item 名（`<id>` 为 target id；sync 侧只打文案不打 item 名）。 */
export function mcpTransportUnmeasuredItem(targetId: string): string {
  return `mcp-transport/${targetId}-unmeasured`;
}

/** 未实测 target 的占位说明（doctor warn 与 sync 输出共用同一份文案）。 */
export function mcpTransportUnmeasuredReason(targetId: string): string {
  return `${targetId} 不在 transport 能力矩阵内（矩阵只覆盖四个内置 target 的实测结论），本轮跳过该 target 的 transport 落差判定`;
}

/** 未实测 target 的消除建议。 */
export const MCP_TRANSPORT_UNMEASURED_HINT =
  '投影照常进行，但该 target 对 stdio / http / sse 的实际支持程度未经实测：连接失败时先手工核对产物字段是否为上游认得的形状';

/**
 * 本轮投影里**不在能力矩阵内**的 target（声明式适配器 id）。
 *
 * 每个 target 恰一条，**不是每个 server 一条**：落差判定压根没跑，逐 server 重复同一句
 * 「未实测」只是噪音。没有**启用**的 server 时返回空数组——没有可投影的 MCP 内容就没有
 * 可说的事（口径同 `collectMcpScopeNotices` 的 `enabledMcpServerNames(...) > 0`）。
 */
export function collectUnmeasuredMcpTransportTargets(
  targetIds: readonly string[],
  servers: readonly McpServer[],
): string[] {
  if (enabledMcpServerNames(servers).length === 0) {
    return [];
  }
  return [...new Set(targetIds.filter((targetId) => !isMcpProjectionTargetId(targetId)))];
}

/**
 * 本轮会被投影的 server 名（enabled=false 已过滤）。
 *
 * 给 §7.6 prune 记账用：记账口径是「SoT 里启用的 server」而**不是**某个 target 实际
 * 写出去的键——差集清理只在 merge_json 的三个 target 上跑（codex 走 merge_toml 整段
 * 重写，不需要 prune），而那三家对三种 transport 都会产出键。用 target 相关的口径
 * 记账反而会把 codex 跳过的 sse server 从记账里抹掉，下一轮就永远清不掉它。
 */
export function enabledMcpServerNames(servers: readonly McpServer[]): string[] {
  return servers.filter((server) => server.enabled !== false).map((server) => server.name);
}

/** 遍历「会落到该 target 的」server（enabled + transport 双重过滤后的可迭代序列）。 */
function projectableServers(
  targetId: McpProjectionTargetId,
  servers: readonly McpServer[],
): McpServer[] {
  return servers.filter(
    (server) =>
      server.enabled !== false && mcpTransportSupport(targetId, server.transport) !== 'unsupported',
  );
}

// ---------------------------------------------------------------------------
// claude：`.mcp.json` 的 mcpServers 条目（type = stdio / http / sse）
// ---------------------------------------------------------------------------

/**
 * Claude Code `.mcp.json` 的 `mcpServers` 映射（server 名 → 条目）。
 *
 * `type` 三种 transport 都显式写出（含 stdio）：`claude mcp add` 自己也这么写，
 * 显式声明比依赖「缺省即 stdio」更能防止后续上游改默认值时静默漂移。
 */
export function claudeMcpServersObject(
  servers: readonly McpServer[],
): Record<string, Record<string, unknown>> {
  const entries: Record<string, Record<string, unknown>> = {};
  for (const server of projectableServers('claude', servers)) {
    entries[server.name] =
      server.transport === 'stdio'
        ? { type: 'stdio', ...stdioFields(server) }
        : { type: server.transport, ...remoteFields(server, 'headers') };
  }
  return entries;
}

// ---------------------------------------------------------------------------
// pi：pi-mcp-adapter 的 mcp.json 条目（无 type 字段；sse 用 httpTransport 强制）
// ---------------------------------------------------------------------------

/**
 * pi-mcp-adapter `mcp.json` 的 `mcpServers` 映射。
 *
 * 与 claude **不同构**（此前两者共用一份载荷是错的）：适配器的原生 server 条目按
 * `command` / `url` / `socket` 三者互斥来判定 transport，没有 `type` 字段——它只在
 * Agent Plugins 的清单里出现。远端条目默认走 streamable HTTP 并在端点确实不兼容时
 * 回退 SSE；`httpTransport: "sse"` 可强制 SSE 且禁用回退，因此 AgentForge 的
 * `transport: sse` 在 pi 侧是**无损**的。
 *
 * 该判定已实机验证（issue #66，pi-mcp-adapter 2.32.1）：上游 `server-manager.ts` 里
 * 首选 transport 取 `definition.httpTransport ?? 'streamable-http'`，而回退分支的第一个
 * 前置条件是 `definition.httpTransport === undefined`——写了该键就选 SSE 且不回落。
 * 本地探针实测：写该键时传输层第一个请求就是 `GET` + `Accept: text/event-stream`、
 * 全程零 streamable-HTTP POST；不写时第一个请求是 POST、失败后才回落 SSE。
 *
 * **稳定性风险**：`httpTransport` 在适配器 README 里零提及，只出现在源码与类型定义中
 * （注释写着 "Used by Agent Plugins"），属于**未公开契约**。上游把它改成 Agent Plugin
 * 专用不算 breaking change，届时本行判定要重新验证。
 *
 * ## 为什么 `http` 也**显式**写这个键
 *
 * 投影走 `merge_json` + `soft`（保留用户手工加的其他 server），而深合并**删不掉**自己
 * 不再产出的键。若 `http` 分支留空，用户把 `transport` 从 `sse` 改回 `http` 再 sync 后，
 * 上一轮写下的 `httpTransport: "sse"` 会留在 `.pi\mcp.json` 里——用户改了声明，pi 却仍被
 * 锁在 SSE 且禁用回退，且 `sync` 报 unchanged、`doctor` 看不出异常（issue #69）。因此两个
 * 分支都写显式取值，让声明与产物一一对应。
 *
 * **代价**：写了该键就关掉适配器的自动回退（回退前置是该键为 `undefined`）。于是
 * `transport: http` 的端点若只会说 SSE，不再被静默救回，而是连接失败——这与「SoT 是唯一
 * 事实源」一致：想要 SSE 就把 SoT 里的 `transport` 声明成 `sse`，不靠运行时猜。
 */
export function piMcpServersObject(
  servers: readonly McpServer[],
): Record<string, Record<string, unknown>> {
  const entries: Record<string, Record<string, unknown>> = {};
  for (const server of projectableServers('pi', servers)) {
    if (server.transport === 'stdio') {
      entries[server.name] = stdioFields(server);
      continue;
    }
    entries[server.name] = {
      ...remoteFields(server, 'headers'),
      // 两个分支都显式写：merge_json 删不掉留空的键（见上「为什么 http 也显式写」）
      httpTransport: server.transport === 'sse' ? 'sse' : 'streamable-http',
    };
  }
  return entries;
}

// ---------------------------------------------------------------------------
// opencode：opencode.json 的 mcp 条目（type = local / remote）
// ---------------------------------------------------------------------------

/**
 * OpenCode `opencode.json` 的 `mcp` 映射。
 *
 * 两处与其他家不同的字段名是上游契约，不是笔误：`command` 是**数组**（命令与参数
 * 合成一项），env 的键名叫 `environment`。`enabled: true` 显式写出（上游 schema 里
 * 该键控制启动时是否连接）。sse 与 http 都塌缩成 `remote`——上游确实无法区分，
 * 由 collectMcpTransportNotices 报 degraded，不硬造字段。
 */
export function opencodeMcpObject(
  servers: readonly McpServer[],
): Record<string, Record<string, unknown>> {
  const entries: Record<string, Record<string, unknown>> = {};
  for (const server of projectableServers('opencode', servers)) {
    if (server.transport === 'stdio') {
      entries[server.name] = {
        type: 'local',
        command: [server.command ?? '', ...(server.args ?? [])],
        enabled: true,
        ...(server.env !== undefined ? { environment: server.env } : {}),
      };
      continue;
    }
    entries[server.name] = {
      type: 'remote',
      url: server.url ?? '',
      enabled: true,
      ...(server.headers !== undefined ? { headers: server.headers } : {}),
    };
  }
  return entries;
}

// ---------------------------------------------------------------------------
// codex：config.toml 的 [mcp_servers.<name>] 条目（键值模型，TOML 文本化在 codex.ts）
// ---------------------------------------------------------------------------

/** codex 的单个 `[mcp_servers.<name>]` 表（键序即 TOML 输出顺序）。 */
export interface CodexMcpEntry {
  readonly name: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  /** codex 的静态 HTTP 头键名就是 `http_headers`（写 `headers` 会被静默忽略）。 */
  readonly httpHeaders?: Readonly<Record<string, string>>;
}

/**
 * codex `config.toml` 的 `mcp_servers` 条目模型。
 *
 * 只产出模型不产出文本：TOML 的转义 / bare key 判定 / inline table 属 codex.ts 的
 * 手写序列化职责（无 TOML 库依赖），能力矩阵与字段名归属这里。
 *
 * sse 的 server 不出现在结果里（矩阵判 unsupported）。
 */
export function codexMcpEntries(servers: readonly McpServer[]): CodexMcpEntry[] {
  return projectableServers('codex', servers).map((server) =>
    server.transport === 'stdio'
      ? {
          name: server.name,
          command: server.command ?? '',
          ...(server.args !== undefined ? { args: server.args } : {}),
          ...(server.env !== undefined ? { env: server.env } : {}),
        }
      : {
          name: server.name,
          url: server.url ?? '',
          ...(server.headers !== undefined ? { httpHeaders: server.headers } : {}),
        },
  );
}

// ---------------------------------------------------------------------------
// 字段片段（三家 JSON 目标共用；键名差异由调用方指定）
// ---------------------------------------------------------------------------

/** stdio 条目的公共字段：command 必出（缺省空串占位），args / env 仅在提供时出现。 */
function stdioFields(server: McpServer): Record<string, unknown> {
  return {
    command: server.command ?? '',
    ...(server.args !== undefined ? { args: server.args } : {}),
    ...(server.env !== undefined ? { env: server.env } : {}),
  };
}

/** 远端条目的公共字段：url 必出（缺省空串占位），header 键名由调用方给（各家不同）。 */
function remoteFields(server: McpServer, headerKey: string): Record<string, unknown> {
  return {
    url: server.url ?? '',
    ...(server.headers !== undefined ? { [headerKey]: server.headers } : {}),
  };
}
