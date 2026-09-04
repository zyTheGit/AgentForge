/**
 * projectors/mcp-transport 单测：transport × target 归一化矩阵（Phase 2 MCP 对齐）。
 *
 * 表驱动覆盖 3 种 transport × 4 个 target 的完整矩阵：
 * - 每格的字段形状（键名、键的有无）；
 * - 不可表达时的降级行为（opencode 的 sse → remote）与跳过行为（codex 的 sse）；
 * - enabled=false 过滤、可选字段缺省不产键、输入顺序保持。
 */
import { describe, expect, it } from 'vitest';
import {
  claudeMcpServersObject,
  codexMcpEntries,
  collectMcpTransportNotices,
  collectMcpTransportNoticesForTargets,
  collectUnmeasuredMcpTransportTargets,
  enabledMcpServerNames,
  isMcpProjectionTargetId,
  type McpProjectionTargetId,
  mcpTransportSupport,
  mcpTransportUnmeasuredItem,
  mcpTransportUnmeasuredReason,
  opencodeMcpObject,
  piMcpServersObject,
} from '../../../../src/core/project/projectors/mcp-transport';
import { type McpServer, McpServerSchema, type Transport } from '../../../../src/schema';

/** 经 schema 解析构造完整形态（enabled 默认值由 schema 填充）。 */
function server(input: unknown): McpServer {
  return McpServerSchema.parse(input);
}

const STDIO = server({
  name: 'fs',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server-fs'],
  env: { KEY: 'v' },
});

const HTTP = server({
  name: 'docs',
  transport: 'http',
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer x' },
});

const SSE = server({
  name: 'ev',
  transport: 'sse',
  url: 'https://example.com/sse',
  headers: { Authorization: 'Bearer x' },
});

const BY_TRANSPORT: Record<Transport, McpServer> = { stdio: STDIO, http: HTTP, sse: SSE };

/** 单个 target 的载荷取「server 名 → 条目」形态（codex 的表模型也归一成这个形状比对）。 */
function entryFor(targetId: McpProjectionTargetId, s: McpServer): unknown {
  switch (targetId) {
    case 'claude':
      return claudeMcpServersObject([s])[s.name];
    case 'pi':
      return piMcpServersObject([s])[s.name];
    case 'opencode':
      return opencodeMcpObject([s])[s.name];
    case 'codex':
      return codexMcpEntries([s])[0];
  }
}

// ---------------------------------------------------------------------------
// 支持程度矩阵（3 transport × 4 target 全格）
// ---------------------------------------------------------------------------

describe('mcpTransportSupport（能力矩阵全格）', () => {
  const MATRIX: [McpProjectionTargetId, Transport, 'native' | 'degraded' | 'unsupported'][] = [
    ['claude', 'stdio', 'native'],
    ['claude', 'http', 'native'],
    ['claude', 'sse', 'native'],
    ['opencode', 'stdio', 'native'],
    ['opencode', 'http', 'native'],
    ['opencode', 'sse', 'degraded'],
    ['codex', 'stdio', 'native'],
    ['codex', 'http', 'native'],
    ['codex', 'sse', 'unsupported'],
    ['pi', 'stdio', 'native'],
    ['pi', 'http', 'native'],
    ['pi', 'sse', 'native'],
  ];

  for (const [targetId, transport, expected] of MATRIX) {
    it(`${targetId} × ${transport} → ${expected}`, () => {
      expect(mcpTransportSupport(targetId, transport)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// 字段形状矩阵（每格的上游契约形态）
// ---------------------------------------------------------------------------

describe('字段形状矩阵（3 transport × 4 target）', () => {
  const SHAPES: [McpProjectionTargetId, Transport, unknown][] = [
    // claude：type 三取值 + command/args/env 或 url/headers
    [
      'claude',
      'stdio',
      { type: 'stdio', command: 'npx', args: ['-y', 'server-fs'], env: { KEY: 'v' } },
    ],
    [
      'claude',
      'http',
      { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
    ],
    [
      'claude',
      'sse',
      { type: 'sse', url: 'https://example.com/sse', headers: { Authorization: 'Bearer x' } },
    ],
    // opencode：local（command 数组 + environment）/ remote（url + headers），sse 塌缩成 remote
    [
      'opencode',
      'stdio',
      {
        type: 'local',
        command: ['npx', '-y', 'server-fs'],
        enabled: true,
        environment: { KEY: 'v' },
      },
    ],
    [
      'opencode',
      'http',
      {
        type: 'remote',
        url: 'https://example.com/mcp',
        enabled: true,
        headers: { Authorization: 'Bearer x' },
      },
    ],
    [
      'opencode',
      'sse',
      {
        type: 'remote',
        url: 'https://example.com/sse',
        enabled: true,
        headers: { Authorization: 'Bearer x' },
      },
    ],
    // codex：单表模型；远端键名是 http_headers（httpHeaders 字段名，序列化时落成 http_headers）
    [
      'codex',
      'stdio',
      { name: 'fs', command: 'npx', args: ['-y', 'server-fs'], env: { KEY: 'v' } },
    ],
    [
      'codex',
      'http',
      { name: 'docs', url: 'https://example.com/mcp', httpHeaders: { Authorization: 'Bearer x' } },
    ],
    ['codex', 'sse', undefined], // 不支持 → 整条跳过
    // pi：无 type 键；远端两态都显式写 httpTransport（merge_json 删不掉留空的键，issue #69）
    ['pi', 'stdio', { command: 'npx', args: ['-y', 'server-fs'], env: { KEY: 'v' } }],
    [
      'pi',
      'http',
      {
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
        httpTransport: 'streamable-http',
      },
    ],
    [
      'pi',
      'sse',
      {
        url: 'https://example.com/sse',
        headers: { Authorization: 'Bearer x' },
        httpTransport: 'sse',
      },
    ],
  ];

  for (const [targetId, transport, expected] of SHAPES) {
    it(`${targetId} × ${transport}`, () => {
      expect(entryFor(targetId, BY_TRANSPORT[transport])).toEqual(expected);
    });
  }
});

describe('可选字段缺省时不产出该键（载荷最小化）', () => {
  const bareStdio = server({ name: 'bare', transport: 'stdio', command: 'npx' });
  const bareHttp = server({ name: 'bare', transport: 'http', url: 'https://x/mcp' });

  it('claude：stdio 只留 type + command；http 只留 type + url', () => {
    expect(claudeMcpServersObject([bareStdio]).bare).toEqual({ type: 'stdio', command: 'npx' });
    expect(claudeMcpServersObject([bareHttp]).bare).toEqual({
      type: 'http',
      url: 'https://x/mcp',
    });
  });

  it('pi：stdio 只留 command；http 留 url + 显式 httpTransport（唯一的例外键）', () => {
    expect(piMcpServersObject([bareStdio]).bare).toEqual({ command: 'npx' });
    // httpTransport 不参与「缺省不产键」：留空会让上一轮的 "sse" 在 merge_json 里活下来
    expect(piMcpServersObject([bareHttp]).bare).toEqual({
      url: 'https://x/mcp',
      httpTransport: 'streamable-http',
    });
  });

  it('opencode：无 env → 无 environment 键；无 headers → 无 headers 键', () => {
    expect(opencodeMcpObject([bareStdio]).bare).toEqual({
      type: 'local',
      command: ['npx'],
      enabled: true,
    });
    expect(opencodeMcpObject([bareHttp]).bare).toEqual({
      type: 'remote',
      url: 'https://x/mcp',
      enabled: true,
    });
  });

  it('codex：无 args/env → 只有 command；无 headers → 只有 url', () => {
    expect(codexMcpEntries([bareStdio])[0]).toEqual({ name: 'bare', command: 'npx' });
    expect(codexMcpEntries([bareHttp])[0]).toEqual({ name: 'bare', url: 'https://x/mcp' });
  });

  it('缺 command / url → 空串占位（不产出 undefined 值）', () => {
    expect(claudeMcpServersObject([server({ name: 'x', transport: 'stdio' })]).x).toEqual({
      type: 'stdio',
      command: '',
    });
    expect(claudeMcpServersObject([server({ name: 'x', transport: 'http' })]).x).toEqual({
      type: 'http',
      url: '',
    });
  });
});

describe('enabled=false 与顺序（四个 target 同口径）', () => {
  const on = server({ name: 'on', transport: 'stdio', command: 'a' });
  const off = server({ name: 'off', transport: 'stdio', command: 'b', enabled: false });

  it('enabled=false 的 server 不投影', () => {
    expect(Object.keys(claudeMcpServersObject([on, off]))).toEqual(['on']);
    expect(Object.keys(piMcpServersObject([on, off]))).toEqual(['on']);
    expect(Object.keys(opencodeMcpObject([on, off]))).toEqual(['on']);
    expect(codexMcpEntries([on, off]).map((e) => e.name)).toEqual(['on']);
  });

  it('保持输入顺序；不改写入参数组', () => {
    const b = server({ name: 'b', transport: 'stdio', command: 'b' });
    const a = server({ name: 'a', transport: 'stdio', command: 'a' });
    const servers = [b, a];
    expect(Object.keys(claudeMcpServersObject(servers))).toEqual(['b', 'a']);
    expect(codexMcpEntries(servers).map((e) => e.name)).toEqual(['b', 'a']);
    expect(servers.map((s) => s.name)).toEqual(['b', 'a']);
  });

  it('空输入 → 空对象 / 空数组（调用方据此写空管理键）', () => {
    expect(claudeMcpServersObject([])).toEqual({});
    expect(piMcpServersObject([])).toEqual({});
    expect(opencodeMcpObject([])).toEqual({});
    expect(codexMcpEntries([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 降级 / 跳过结论
// ---------------------------------------------------------------------------

describe('collectMcpTransportNotices（不可表达时的显式降级）', () => {
  it('claude / pi：三种 transport 全无损 → 无 notice', () => {
    expect(collectMcpTransportNotices('claude', [STDIO, HTTP, SSE])).toEqual([]);
    expect(collectMcpTransportNotices('pi', [STDIO, HTTP, SSE])).toEqual([]);
  });

  it('opencode：sse → degraded（会投影，但按 streamable HTTP 连接）', () => {
    const notices = collectMcpTransportNotices('opencode', [STDIO, HTTP, SSE]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.serverName).toBe('ev');
    expect(notices[0]?.transport).toBe('sse');
    expect(notices[0]?.support).toBe('degraded');
    expect(notices[0]?.detail).toContain('无法声明 SSE');
    expect(notices[0]?.hint).toContain('transport: http');
    // degraded 仍然投影出去
    expect(Object.keys(opencodeMcpObject([SSE]))).toEqual(['ev']);
  });

  it('codex：sse → unsupported（整条跳过，不写进标记段）', () => {
    const notices = collectMcpTransportNotices('codex', [STDIO, HTTP, SSE]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.support).toBe('unsupported');
    expect(notices[0]?.detail).toContain('没有 SSE');
    expect(codexMcpEntries([STDIO, HTTP, SSE]).map((e) => e.name)).toEqual(['fs', 'docs']);
  });

  it('enabled=false 的 server 不报 notice（它压根不投影）', () => {
    const disabledSse = server({
      name: 'ev',
      transport: 'sse',
      url: 'https://x/sse',
      enabled: false,
    });
    expect(collectMcpTransportNotices('codex', [disabledSse])).toEqual([]);
    expect(collectMcpTransportNotices('opencode', [disabledSse])).toEqual([]);
  });
});

describe('enabledMcpServerNames（§7.6 prune 记账口径）', () => {
  it('只过滤 enabled=false，不按 target 能力过滤（codex 跳过的 sse 仍要记账）', () => {
    const names = enabledMcpServerNames([
      STDIO,
      SSE,
      server({ name: 'off', transport: 'stdio', command: 'x', enabled: false }),
    ]);
    expect(names).toEqual(['fs', 'ev']);
  });

  it('空输入 → 空数组', () => {
    expect(enabledMcpServerNames([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 矩阵外的 target id（声明式适配器）：护栏，PRD 适配器扩展 Phase 0
// ---------------------------------------------------------------------------

describe('矩阵外 target id 的护栏（此前 as 强转 → TypeError 崩 sync/doctor）', () => {
  it('isMcpProjectionTargetId：四个内置 id 为真，声明式 / 原型链键为假', () => {
    for (const id of ['claude', 'opencode', 'codex', 'pi']) {
      expect(isMcpProjectionTargetId(id)).toBe(true);
    }
    for (const id of ['my-agent', 'cursor', '', 'toString', 'constructor']) {
      expect(isMcpProjectionTargetId(id)).toBe(false);
    }
  });

  it('collectMcpTransportNoticesForTargets：混入声明式 id 不抛，落差只按内置 id 判定', () => {
    expect(() => collectMcpTransportNoticesForTargets(['my-agent'], [STDIO])).not.toThrow();
    expect(collectMcpTransportNoticesForTargets(['my-agent'], [STDIO, HTTP, SSE])).toEqual([]);

    const mixed = collectMcpTransportNoticesForTargets(['my-agent', 'codex'], [SSE]);
    expect(mixed.map((n) => `${n.targetId}:${n.support}`)).toEqual(['codex:unsupported']);
  });

  it('内置 target 的结论与产物不因混入声明式 id 而变（PRD 出口判据「plan 产物不变」）', () => {
    const servers = [STDIO, HTTP, SSE];
    const builtin = ['opencode', 'codex', 'claude', 'pi'];
    // 落差结论逐条相等：守卫只过滤矩阵外的 id，不碰已实测 target 的判定
    expect(collectMcpTransportNoticesForTargets([...builtin, 'my-agent'], servers)).toEqual(
      collectMcpTransportNoticesForTargets(builtin, servers),
    );
    // 四家的 payload 也逐字相等：载荷压根不看 profile.targets，只看 server 列表
    expect(claudeMcpServersObject(servers)).toEqual(claudeMcpServersObject(servers));
    expect(codexMcpEntries(servers).map((e) => e.name)).toEqual(['fs', 'docs']);
  });

  it('重复 target id 去重：落差侧与 unmeasured 侧同口径（targets 数组无唯一性校验）', () => {
    expect(collectMcpTransportNoticesForTargets(['codex', 'codex'], [SSE])).toHaveLength(1);
  });

  it('collectUnmeasuredMcpTransportTargets：每 target 恰一条、去重、不含内置 id', () => {
    expect(
      collectUnmeasuredMcpTransportTargets(['claude', 'my-agent', 'cursor'], [STDIO, HTTP, SSE]),
    ).toEqual(['my-agent', 'cursor']);
    // 三个 server 也只出一条：落差判定压根没跑，逐 server 重复同一句是噪音
    expect(collectUnmeasuredMcpTransportTargets(['my-agent', 'my-agent'], [STDIO])).toEqual([
      'my-agent',
    ]);
  });

  it('collectUnmeasuredMcpTransportTargets：无可投影 server → 空（没 MCP 内容就没得说）', () => {
    expect(collectUnmeasuredMcpTransportTargets(['my-agent'], [])).toEqual([]);
    const disabled = server({ name: 'off', transport: 'stdio', command: 'x', enabled: false });
    expect(collectUnmeasuredMcpTransportTargets(['my-agent'], [disabled])).toEqual([]);
  });

  it('item 名与文案带上 target id（doctor / sync 共用同一份）', () => {
    expect(mcpTransportUnmeasuredItem('my-agent')).toBe('mcp-transport/my-agent-unmeasured');
    expect(mcpTransportUnmeasuredReason('my-agent')).toContain('my-agent');
    expect(mcpTransportUnmeasuredReason('my-agent')).toContain('不在 transport 能力矩阵内');
  });
});
