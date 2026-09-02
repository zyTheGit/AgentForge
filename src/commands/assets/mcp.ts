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
 *
 * `aforge mcp remove <name> [--scope project|user] [--json]`：
 * - 从目标层 profile.yaml 的 mcp.servers 摘掉该名字（**只改 SoT**）；
 * - 投影侧清理：被摘掉的 server 键由**下一次 `aforge sync`** 从 opencode / claude /
 *   pi 的 MCP 配置里摘除（Spec §7.6 prune，按 sync-meta 上一轮记账做差集），命令
 *   输出按本次写入的层（project / user 落点不同）逐条给出绝对路径；codex 走 marker
 *   段整段重写、本来就不会残留，故不列；
 * - 目标层没有该名字 → ConfigError(2)（不当成幂等成功：用户多半选错了层，
 *   另一层有同名时 hint 直接给出可复制的 `--scope <另一层>`）；
 * - 无 --force/--yes：本命令只改一行声明，且改动可由 profile.yaml 的 git 历史找回。
 *
 * 拆分后的模块清单（对外导出面不变，采集侧的符号在文件末尾原样 re-export）：
 * - 本文件：add / remove 的核心逻辑 + 两个子命令的注册与输出渲染；
 * - commands/assets/mcp-prompt.ts：交互问答与 --from-json 的 stdin 解析（输入采集）。
 */

import { cancel, intro, outro } from '@clack/prompts';
import type { Command } from 'commander';
import { loadProfile } from '../../core/config/load';
import { resolveWriteTargetLayer } from '../../core/config/target-layer';
import { type EnvSnapshot, readEnv, type Scope } from '../../core/env';
import { ConfigError } from '../../core/errors';
import { pathApiFor } from '../../core/paths';
import { CLAUDE_MCP_FILENAME } from '../../core/project/projectors/claude';
import {
  OPENCODE_MCP_FILENAME,
  OPENCODE_USER_DIR_SEGMENTS,
} from '../../core/project/projectors/opencode';
import { PI_DIRNAME, PI_MCP_FILENAME, piUserAgentDir } from '../../core/project/projectors/pi';
import { withSotLock } from '../../core/project/sync-lock';
import {
  type AddMcpServerResult,
  addMcpServer,
  type RemoveMcpServerResult,
  removeMcpServerLocked,
} from '../../core/sources/mcp';
import { getUi } from '../../infra/ui';
import type { McpServerInput } from '../../schema';
import {
  type CommandContext,
  defaultCommandContext,
  otherScope,
  printJson,
  projectionRootFor,
  renderList,
  sotRootFor,
} from '../_shared/context';
import { parseScopeOption, resolveJsonFlag } from '../_shared/flags';
import { isInteractiveStdin, readStdinText } from '../_shared/stdin';
import { parseMcpServerJson, promptServer } from './mcp-prompt';

/** 详情行的 label 宽度（`transport` 最长，冒号同列）。 */
const MCP_LABEL_WIDTH = 9;

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

/** remove 结果：core 的摘除结果 + 实际写入的那一层（供输出与脚本判层）。 */
export interface McpRemoveResult extends RemoveMcpServerResult {
  readonly scope: Scope;
}

/**
 * 另一层的 mcp.servers 里是否有这个名字（供「层选错了」的 hint 给出具体 --scope 值）。
 *
 * 只读探测，任何失败一律按 false：另一层 profile.yaml 损坏 / 不可读**不该**让本层
 * 一次合法的 remove 失败，最坏结果只是 hint 退化成泛化措辞。
 */
async function otherLayerHasServer(
  ctx: McpCommandContext,
  otherSotRoot: string,
  name: string,
): Promise<boolean> {
  try {
    const servers = (await loadProfile(ctx.host, otherSotRoot))?.mcp?.servers ?? [];
    return servers.some((s) => s.name === name);
  } catch {
    return false;
  }
}

/**
 * remove 核心逻辑（可注入、不打印）。
 *
 * 目标层解析与「另一层是否有同名」的探测都在锁外（只读），「读 profile → 判存在 →
 * 改 → 校验 → 写」整段在一次 withSotLock 内，因此锁内调用的是 removeMcpServerLocked
 * （自取锁的变体会撞自己刚建的锁目录，`.sync.lock` 是非递归目录锁）。
 *
 * 另一层的探测是**无条件**做的（哪怕本次会成功）：它的唯一用途是失败分支的 hint，
 * 而失败判据在锁内的 mutate 里才知道，那里是同步纯函数、不能 await。代价是一次小
 * 文件读，换来「层选错了」这个最常见误用能直接给出可复制的 `--scope` 值。
 *
 * 空名判据落在**取锁之前**（与 runSkillRemove 先 validateSkillName 再 withSotLock 同位）：
 * 非法名恒得退出码 2（Spec §6.1「配置校验 → 2」），不会被锁冲突的 ConflictError(3)
 * 抢先，也不为一次必然失败的调用先建一遍锁目录。core 的 removeMcpServerLocked 里
 * 同一判据保留作兜底——绕过命令层直接调 core 的调用方仍受保护，分工见该函数 JSDoc。
 *
 * @throws ConfigError(2) 名字为空（锁外判定，恒优先于 3）/ scope 层未 init /
 *         该层未登记该名字 / profile.yaml 损坏。
 * @throws ConflictError(3) 取不到 SoT 事务锁（另一个 aforge 正在写同一 SoT）。
 * @throws PermissionError(4) SoT 根不可写（锁目录建不出来）/ profile.yaml 读不出来。
 */
export async function runMcpRemove(
  ctx: McpCommandContext,
  name: string,
  options: { scope?: Scope } = {},
): Promise<McpRemoveResult> {
  if (name.trim() === '') {
    throw new ConfigError('MCP server 名不能为空', {
      hint: '用法: aforge mcp remove <name>；运行 aforge status 查看已登记的 server',
      details: { name },
    });
  }

  const env = readEnv(ctx.host);
  const targetLayer = await resolveWriteTargetLayer(ctx.host, env, ctx.os, ctx.cwd, options.scope);
  const otherSotRoot = sotRootFor(ctx, env, otherScope(targetLayer.scope));
  const otherScopeHasServer = await otherLayerHasServer(ctx, otherSotRoot, name);
  return withSotLock(ctx.host, targetLayer.sotRoot, ctx.os, async () => ({
    ...(await removeMcpServerLocked(ctx.host, targetLayer, name, { otherScopeHasServer })),
    scope: targetLayer.scope,
  }));
}

/**
 * 本次写入层对应的、需要手工清理 MCP 键的投影文件绝对路径（逐条列给用户）。
 *
 * 为什么不像 skill remove 那样直接调 projector（那边走 `Projector.skillPath` 接口）：
 * MCP 侧的落点判定只有「基准根 + 目录段 + 文件名」三段，projector 的
 * opencodeMcpPath / claudeMcpPath / piMcpPath 里除此之外没有别的逻辑，而它们的入参是
 * 完整 ProjectContext（profile / habits / renderedRulesMd / marker 等）——为三个常量拼接
 * 造一个假 ctx 得不偿失。文件名与 opencode 的目录段取自 projector 导出的常量
 * （OPENCODE_USER_DIR_SEGMENTS / *_MCP_FILENAME），而 opencodeUserDir 本身就是
 * `join(rootDir, ...同一常量)`，所以两边同源。
 *
 * **同源约束**：user scope 的 pi 目录必须走 projector 导出的 `piUserAgentDir`——它认
 * `PI_CODING_AGENT_DIR`（同 codex 认 `CODEX_HOME`），在这里重新 join 目录段会在该变量
 * 置位时打印出一条 pi 根本不读的路径。其余两家目前无环境变量覆盖，仍按常量拼接。
 *
 * codex 不列：其 MCP 走 merge_toml 的 `# BEGIN/END AGENTFORGE MCP` 标记段**整段重写**，
 * 下次 sync 按 SoT 重算该段，摘掉的 server 自动消失，不需要用户动手。
 *
 * 基准根走 context.projectionRootFor（与 skill remove 同一口径）：用户目录取不到时退化成
 * `~` 占位，这一行只是提示文案，不该让一次已经写盘成功的 remove 因为算不出提示而失败。
 */
function mcpProjectionFiles(ctx: McpCommandContext, env: EnvSnapshot, scope: Scope): string[] {
  const api = pathApiFor(ctx.os);
  // 基准根与 skill remove 共用 projectionRootFor（project → 项目根 / user → 用户目录）
  const root = projectionRootFor(ctx, env, scope);
  if (scope === 'project') {
    return [
      api.join(root, OPENCODE_MCP_FILENAME),
      api.join(root, CLAUDE_MCP_FILENAME),
      api.join(root, PI_DIRNAME, PI_MCP_FILENAME),
    ];
  }
  return [
    api.join(root, ...OPENCODE_USER_DIR_SEGMENTS, OPENCODE_MCP_FILENAME),
    api.join(root, CLAUDE_MCP_FILENAME),
    api.join(piUserAgentDir(root, env.piCodingAgentDir, ctx.os), PI_MCP_FILENAME),
  ];
}

/**
 * 输入采集侧的导出面 re-export：`parseMcpServerJson` 实现已搬到
 * commands/assets/mcp-prompt.ts，这里保证调用方与测试仍能从 `commands/assets/mcp` 原路径拿到。
 */
export { parseMcpServerJson } from './mcp-prompt';

export function registerMcpCommand(program: Command): void {
  const cmd = program
    .command('mcp')
    .description('manage MCP server declarations (add | remove writes profile.mcp.servers)');

  cmd
    .command('add')
    .description('register an MCP server (interactive prompts, or --from-json from stdin)')
    .option('--scope <scope>', 'SoT scope to write: project or user (default: effective scope)')
    .option('--from-json', 'read the server declaration as a JSON object from stdin')
    .option('--json', 'machine-readable output (absolute paths) - Spec 6.2')
    .action(async (options: { scope?: string; fromJson?: boolean; json?: boolean }, command) => {
      const scope = parseScopeOption(options.scope);
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

      const ui = getUi();
      console.log(
        [
          `${ui.green(`mcp server ${result.replaced ? 'updated' : 'added'}`)}: ${ui.bold(result.server.name)}`,
          ui.kv('transport', result.server.transport, MCP_LABEL_WIDTH),
          ui.kv('profile', ui.path(result.profileFile), MCP_LABEL_WIDTH),
          ui.kv('servers', renderList(result.servers.map((s) => s.name)), MCP_LABEL_WIDTH),
        ].join('\n'),
      );
    });

  cmd
    .command('remove <name>')
    .description(
      'unregister an MCP server from profile.mcp.servers (SoT only - see the note in the output)',
    )
    .option('--scope <scope>', 'SoT scope to write: project or user (default: effective scope)')
    .option('--json', 'machine-readable output (absolute paths) - Spec 6.2')
    .action(async (name: string, options: { scope?: string; json?: boolean }, command) => {
      const ctx = defaultCommandContext();
      const result = await runMcpRemove(ctx, name, {
        scope: parseScopeOption(options.scope),
      });
      if (resolveJsonFlag(command, options.json)) {
        // §6.2 机器可读输出（路径一律绝对路径）
        printJson(result);
        return;
      }
      const ui = getUi();
      console.log(
        [
          `${ui.green('mcp server removed')}: ${ui.bold(result.removed.name)}`,
          ui.kv('transport', result.removed.transport, MCP_LABEL_WIDTH),
          ui.kv('scope', ui.cyan(result.scope), MCP_LABEL_WIDTH),
          ui.kv('profile', ui.path(result.profileFile), MCP_LABEL_WIDTH),
          ui.kv('servers', renderList(result.servers.map((s) => s.name)), MCP_LABEL_WIDTH),
          '',
          // prune 已落地（Spec §7.6）：下次 sync 按 sync-meta 上一轮记账摘掉该 server
          // 键。文件清单按本次写入的层解析（project / user 落点不同，见 mcpProjectionFiles）
          ui.yellow('note: removed from profile.mcp.servers only. run `aforge sync` to drop the'),
          ui.yellow(`      "${result.removed.name}" entry from these ${result.scope}-level files:`),
          ...mcpProjectionFiles(ctx, readEnv(ctx.host), result.scope).map(
            (f) => `        ${ui.path(f)}`,
          ),
        ].join('\n'),
      );
    });
}
