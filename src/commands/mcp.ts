/**
 * aforge mcp 命令（Spec §6 命令表 / §4.2 mcp.servers）。
 *
 * `aforge mcp add [--scope project|user] [--from-json] [--json]`：
 * - 交互模式（TTY）：录入 name → transport（stdio/http/sse）→ 按条件录入
 *   command/args/env（stdio）或 url/headers（http/sse）；取消 → 直接退出 0；
 * - --from-json：从 stdin 读一个 JSON 对象（McpServerInput 形态）登记——
 *   非交互 / 脚本化入口；非 TTY 且无 --from-json → ConfigError(2)；
 *   （0.1.0 改名：该标志原名 --json，与 Spec §6.2 全局 `--json`「机器可读**输出**」
 *   语义相反，故输入侧统一改用 --from-json，`--json` 归还输出契约）；
 * - --json（或全局 `aforge --json mcp add`）：机器可读输出 AddMcpServerResult；
 * - 写入目标层（--scope 显式 > AGF_SCOPE > project 在用 > user 在用）
 *   profile.yaml 的 mcp.servers（同名 upsert：重复 add = 更新配置）；
 * - transport 条件校验（stdio 需 command / http(sse) 需 url）在
 *   core/sources/mcp.addMcpServer 写入前执行。
 */

import { cancel, intro, isCancel, outro, select, text } from '@clack/prompts';
import type { Command } from 'commander';
import { resolveWriteTargetLayer } from '../core/config/target-layer';
import { readEnv, type Scope } from '../core/env';
import { ConfigError } from '../core/errors';
import { type AddMcpServerResult, addMcpServer } from '../core/sources/mcp';
import { type McpServerInput, McpServerSchema } from '../schema';
import { type CommandContext, defaultCommandContext, printJson } from './context';
import { resolveJsonFlag } from './flags';
import { isInteractiveStdin, readStdinText } from './stdin';

/** 命令上下文。 */
export type McpCommandContext = CommandContext;

/** add 核心逻辑（可注入、不打印）。@see addMcpServer 异常契约。 */
export async function runMcpAdd(
  ctx: McpCommandContext,
  server: McpServerInput,
  options: { scope?: Scope } = {},
): Promise<AddMcpServerResult> {
  const env = readEnv(ctx.host);
  const targetLayer = await resolveWriteTargetLayer(ctx.host, env, ctx.os, ctx.cwd, options.scope);
  return addMcpServer(ctx.host, targetLayer, server);
}

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
async function promptServer(): Promise<McpServerInput | null> {
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

export function registerMcpCommand(program: Command): void {
  const cmd = program
    .command('mcp')
    .description('manage MCP server declarations (add writes profile.mcp.servers)');

  cmd
    .command('add')
    .description('register an MCP server (interactive prompts, or --from-json from stdin)')
    .option('--scope <scope>', 'SoT scope to write: project or user (default: effective scope)')
    .option('--from-json', 'read the server declaration as a JSON object from stdin')
    .option('--json', 'machine-readable output (absolute paths) - Spec 6.2')
    .action(async (options: { scope?: string; fromJson?: boolean; json?: boolean }, command) => {
      if (options.scope !== undefined && options.scope !== 'project' && options.scope !== 'user') {
        throw new ConfigError(`非法 scope: ${options.scope}`, {
          hint: '有效值: project, user',
        });
      }
      const scope = options.scope as Scope | undefined;
      const json = resolveJsonFlag(command, options.json);

      let server: McpServerInput | null;
      if (options.fromJson) {
        server = parseMcpServerJson(await readStdinText());
      } else if (isInteractiveStdin()) {
        intro('aforge mcp add');
        server = await promptServer();
        outro(server === null ? '' : '声明已记录');
      } else {
        throw new ConfigError('非交互终端需用 --from-json 从 stdin 提供声明', {
          hint: '示例: echo \'{"name":"fs","transport":"stdio","command":"npx"}\' | aforge mcp add --from-json',
        });
      }
      if (server === null) {
        cancel('已取消');
        return;
      }

      const result = await runMcpAdd(defaultCommandContext(), server, { scope });

      if (json) {
        // §6.2 机器可读输出（路径一律绝对路径）
        printJson(result);
        return;
      }

      console.log(
        [
          `mcp server ${result.replaced ? 'updated' : 'added'}: ${result.server.name}`,
          `  transport : ${result.server.transport}`,
          `  profile   : ${result.profileFile}`,
          `  servers   : ${result.servers.map((s) => s.name).join(', ')}`,
        ].join('\n'),
      );
    });
}
