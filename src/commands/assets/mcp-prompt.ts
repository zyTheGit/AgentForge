/**
 * `aforge mcp add` 的输入采集：交互问答（TTY）与 stdin JSON 解析。
 *
 * 从 commands/assets/mcp.ts 抽出成独立模块：这里全是「怎么把用户/管道里的东西变成一个
 * McpServerInput」的知识——@clack 问答流程、取消语义、`KEY=VAL` 列表的土办法解析、
 * zod 校验失败时逐条 issue 的错误文案；它与 add/remove 的写入逻辑（目标层解析、
 * SoT 锁、profile 编辑）没有任何耦合，是原文件里最自然的一道缝。分开后 mcp.ts 只剩
 * 「解析结果 → 写 SoT → 渲染输出」，也不再逼近 500 行卡口（AGENTS.md / Spec §11.3）。
 *
 * 采集失败一律抛 ConfigError(2)；用户主动取消交互 → 返回 null，由调用方决定退出 0。
 */

import { isCancel, select, text } from '@clack/prompts';
import { ConfigError } from '../../core/errors';
import { type McpServerInput, McpServerSchema } from '../../schema';

/** "K=V,K=V" → record（空段忽略；M8 简单实现：不支持值内逗号/引号转义）。 */
function parseKvList(raw: string): Record<string, string> | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const pair of trimmed
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new ConfigError(`KEY=VAL 形式不合法: ${pair}`, {
        hint: '示例: FOO=bar,BAZ=qux（键非空、含一个 =）',
        details: { pair },
      });
    }
    record[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return record;
}

/** 解析 --from-json stdin 的原始文本 → McpServerInput。@throws ConfigError(2)。 */
export function parseMcpServerJson(raw: string): McpServerInput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`--from-json 输入不是合法 JSON: ${(err as Error).message}`, {
      hint: '示例: {"name":"fs","transport":"stdio","command":"npx","args":["-y","mcp-fs"]}',
    });
  }
  const result = McpServerSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues;
    const lines = issues.map(
      (i) =>
        `  - ${i.path.filter((p) => typeof p !== 'symbol').join('.') || '(root)'}: ${i.message}`,
    );
    throw new ConfigError(
      `--from-json 输入不符合 MCP server 声明（§4.2），共 ${issues.length} 处问题:\n${lines.join('\n')}`,
      {
        hint: '必填 name/transport；stdio 需 command，http/sse 需 url',
        details: { issues },
      },
    );
  }
  return result.data;
}

/** 交互采集（TTY）。取消 → null。 */
export async function promptServer(): Promise<McpServerInput | null> {
  const name = await text({ message: 'MCP server name（profile.mcp.servers 中的键）' });
  if (isCancel(name) || name.trim() === '') {
    return null;
  }
  const transport = await select({
    message: 'Transport',
    options: [
      { value: 'stdio' as const, label: 'stdio（command + args）' },
      { value: 'http' as const, label: 'http（url）' },
      { value: 'sse' as const, label: 'sse（url）' },
    ],
  });
  if (isCancel(transport)) {
    return null;
  }

  const server: McpServerInput = { name: name.trim(), transport };
  if (transport === 'stdio') {
    const command = await text({ message: 'Command（如 npx / uvx / node）' });
    if (isCancel(command) || command.trim() === '') {
      return null;
    }
    server.command = command.trim();
    const argsRaw = await text({ message: 'Args（空格分隔，可留空）', placeholder: '-y mcp-fs' });
    if (isCancel(argsRaw)) {
      return null;
    }
    const args = argsRaw
      .trim()
      .split(/\s+/)
      .filter((a) => a !== '');
    if (args.length > 0) {
      server.args = args;
    }
    const envRaw = await text({
      message: 'Env（KEY=VAL 逗号分隔，可留空）',
      placeholder: 'FOO=bar',
    });
    if (isCancel(envRaw)) {
      return null;
    }
    const env = parseKvList(envRaw);
    if (env !== undefined) {
      server.env = env;
    }
  } else {
    const url = await text({ message: 'URL（http(s) 端点）' });
    if (isCancel(url) || url.trim() === '') {
      return null;
    }
    server.url = url.trim();
    const headersRaw = await text({ message: 'Headers（KEY=VAL 逗号分隔，可留空）' });
    if (isCancel(headersRaw)) {
      return null;
    }
    const headers = parseKvList(headersRaw);
    if (headers !== undefined) {
      server.headers = headers;
    }
  }
  return server;
}
