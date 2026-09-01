/**
 * projectors/mcp-payload 单测：`mcpServers` 映射构造（claude / pi 共享实现）。
 *
 * 覆盖 enabled=false 过滤、stdio 与 http/sse 两套字段形状、可选字段缺省时不产出键、
 * 空输入 → 空对象；并断言 claudeMcpPayload / piMcpPayload 产出完全一致（同为 mcpServers 键）。
 */
import { describe, expect, it } from 'vitest';
import { claudeMcpPayload } from '../../../../src/core/project/projectors/claude';
import { buildMcpServersObject } from '../../../../src/core/project/projectors/mcp-payload';
import { piMcpPayload } from '../../../../src/core/project/projectors/pi';
import { type McpServer, McpServerSchema } from '../../../../src/schema';

/** 经 schema 解析构造完整形态（enabled 默认值由 schema 填充）。 */
function server(input: unknown): McpServer {
  return McpServerSchema.parse(input);
}

describe('buildMcpServersObject', () => {
  it('空输入 → 空对象（调用方据此写出空管理键）', () => {
    expect(buildMcpServersObject([])).toEqual({});
  });

  it('stdio：command 必出，args / env 仅在提供时出现', () => {
    expect(
      buildMcpServersObject([server({ name: 'fs', transport: 'stdio', command: 'npx' })]),
    ).toEqual({ fs: { command: 'npx' } });

    expect(
      buildMcpServersObject([
        server({
          name: 'fs',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'pkg'],
          env: { TOKEN: 'x' },
        }),
      ]),
    ).toEqual({ fs: { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'x' } } });
  });

  it('stdio 缺 command → 空串占位（不产出 undefined 值）', () => {
    const built = buildMcpServersObject([server({ name: 'bare', transport: 'stdio' })]);
    expect(built).toEqual({ bare: { command: '' } });
  });

  it('http / sse：type + url（+ 可选 headers）', () => {
    expect(
      buildMcpServersObject([server({ name: 'api', transport: 'http', url: 'https://x/mcp' })]),
    ).toEqual({ api: { type: 'http', url: 'https://x/mcp' } });

    expect(
      buildMcpServersObject([
        server({
          name: 'ev',
          transport: 'sse',
          url: 'https://x/sse',
          headers: { Authorization: 'Bearer t' },
        }),
      ]),
    ).toEqual({
      ev: { type: 'sse', url: 'https://x/sse', headers: { Authorization: 'Bearer t' } },
    });
  });

  it('enabled=false 的 server 不投影', () => {
    const built = buildMcpServersObject([
      server({ name: 'on', transport: 'stdio', command: 'a' }),
      server({ name: 'off', transport: 'stdio', command: 'b', enabled: false }),
    ]);
    expect(Object.keys(built)).toEqual(['on']);
  });

  it('保持输入顺序；不改写入参数组', () => {
    const servers = [
      server({ name: 'b', transport: 'stdio', command: 'b' }),
      server({ name: 'a', transport: 'stdio', command: 'a' }),
    ];
    expect(Object.keys(buildMcpServersObject(servers))).toEqual(['b', 'a']);
    expect(servers.map((s) => s.name)).toEqual(['b', 'a']);
  });
});

describe('claude / pi 载荷复用同一实现（只差顶层键名）', () => {
  it('两者 mcpServers 内容一致（顶层键名同为 mcpServers）', () => {
    const servers = [
      server({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y'] }),
      server({ name: 'api', transport: 'http', url: 'https://x/mcp' }),
    ];
    const expected = JSON.stringify({ mcpServers: buildMcpServersObject(servers) });
    expect(claudeMcpPayload(servers)).toBe(expected);
    expect(piMcpPayload(servers)).toBe(expected);
  });

  it('空 servers → {"mcpServers":{}}（保留管理键声明）', () => {
    expect(claudeMcpPayload([])).toBe('{"mcpServers":{}}');
    expect(piMcpPayload([])).toBe('{"mcpServers":{}}');
  });
});
