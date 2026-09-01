/**
 * MCP `mcpServers` 载荷构造（claude `.mcp.json` 与 pi `.pi\mcp.json` 共享）。
 *
 * 两个 target 的 MCP 声明恰好同构（顶层键名相同、server 对象形状相同——pi 侧由
 * pi-mcp-adapter 沿用 Claude Code 的 `mcpServers` 形状），故把「servers 数组 →
 * mcpServers 对象」这一段提取为单一实现；
 * 顶层键名与 JSON.stringify 仍由各 projector 自己负责（键名是 target 契约）。
 *
 * 规则（Spec §4.2 / §8.5 / §8.6）：
 * - `enabled === false` 的 server 不投影；
 * - stdio → `{ command, args?, env? }`；http / sse → `{ type, url, headers? }`；
 * - 可选字段 undefined 时**不产出该键**（保持载荷最小、便于深合并比较）；
 * - 空输入 → 空对象（调用方据此写出空管理键，未知键在深合并时保留，§8.2）。
 */
import type { McpServer } from '../../../schema';

/**
 * 构造 `mcpServers` 映射（server name → server 声明对象）。
 *
 * 纯函数：不做 IO、不读环境；同名 server 后者覆盖前者（沿用对象赋值语义）。
 */
export function buildMcpServersObject(servers: readonly McpServer[]): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    if (server.enabled === false) {
      continue;
    }
    if (server.transport === 'stdio') {
      mcpServers[server.name] = {
        command: server.command ?? '',
        ...(server.args !== undefined ? { args: server.args } : {}),
        ...(server.env !== undefined ? { env: server.env } : {}),
      };
    } else {
      // http / sse → type + url（+ 可选 headers）
      mcpServers[server.name] = {
        type: server.transport,
        url: server.url ?? '',
        ...(server.headers !== undefined ? { headers: server.headers } : {}),
      };
    }
  }
  return mcpServers;
}
