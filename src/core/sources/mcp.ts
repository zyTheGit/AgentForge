/**
 * MCP server 登记（Spec §6 命令表 aforge mcp add / §4.2 mcp.servers）。
 *
 * - addMcpServer：写入目标层 profile.yaml 的 mcp.servers（同名 upsert——
 *   重复 add 视为更新配置）；
 * - transport 条件校验（profile.ts 将该约束留给 MCP 管理层，即本模块）：
 *   stdio → command 必填；http/sse → url 必填；
 * - 编辑 z.input 原始形态往返（不展开默认值），写入前 ProfileSchema 全量校验。
 */
import type { Host } from '../../infra/host';
import type { McpServer, McpServerInput } from '../../schema';
import { editProfile } from '../config/edit-profile';
import type { TargetLayer } from '../config/target-layer';
import { ConfigError } from '../errors';

/** addMcpServer 结果。 */
export interface AddMcpServerResult {
  /** 写入后的完整 servers 列表。 */
  readonly servers: McpServer[];
  /** 被写入/替换的条目（填充默认值后的完整形态）。 */
  readonly server: McpServer;
  readonly profileFile: string;
  /** true = 替换既有同名条目；false = 新增。 */
  readonly replaced: boolean;
}

/**
 * 校验单个 MCP server 声明的 transport 条件依赖（§4.2）。
 * @throws ConfigError(2) stdio 缺 command / http(sse) 缺 url。
 */
export function validateMcpServer(server: McpServerInput, at: string): void {
  const name = server.name ?? '';
  if (server.transport === 'stdio' && (server.command === undefined || server.command === '')) {
    throw new ConfigError(`MCP server ${name}: stdio transport 需要 command${at}`, {
      hint: '补全 command（如 npx / uvx 启动命令），或改用 http/sse + url',
      details: { server },
    });
  }
  if (
    (server.transport === 'http' || server.transport === 'sse') &&
    (server.url === undefined || server.url === '')
  ) {
    throw new ConfigError(`MCP server ${name}: ${server.transport} transport 需要 url${at}`, {
      hint: '补全 url（http(s) 端点），或改用 stdio + command',
      details: { server },
    });
  }
}

/**
 * 登记（或替换）一个 MCP server 到目标层 profile.yaml 的 mcp.servers。
 *
 * @param server 已解析的输入形态（命令层负责来源：交互 / --json stdin）。
 * @throws ConfigError(2) transport 条件缺失 / 目标层 profile.yaml 损坏 /
 *         修改后整体校验失败。
 */
export async function addMcpServer(
  host: Host,
  targetLayer: TargetLayer,
  server: McpServerInput,
): Promise<AddMcpServerResult> {
  validateMcpServer(server, `（写入 ${targetLayer.profileFile} 前）`);

  let replaced = false;
  const { parsed, profileFile } = await editProfile(host, targetLayer, (profile) => {
    const current: McpServerInput[] = profile.mcp?.servers ?? [];
    replaced = current.some((s) => s.name === server.name);
    const servers = replaced
      ? current.map((s) => (s.name === server.name ? server : s))
      : [...current, server];
    return { ...profile, mcp: { ...profile.mcp, servers } };
  });

  const written = parsed.mcp.servers?.find((s) => s.name === server.name);
  if (written === undefined) {
    throw new ConfigError(`MCP server 写入后未能读回: ${server.name}`, {
      hint: '这是 AgentForge 内部错误，请提交 issue',
      details: { server },
    });
  }

  return {
    servers: parsed.mcp.servers ?? [],
    server: written,
    profileFile,
    replaced,
  };
}
