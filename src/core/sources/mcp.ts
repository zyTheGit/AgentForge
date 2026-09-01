/**
 * MCP server 登记与摘除（Spec §6 命令表 aforge mcp add|remove / §4.2 mcp.servers）。
 *
 * - addMcpServer：写入目标层 profile.yaml 的 mcp.servers（同名 upsert——
 *   重复 add 视为更新配置）；
 * - removeMcpServerLocked：从目标层 mcp.servers 摘掉一条（调用方须已持 SoT 锁）；
 * - transport 条件校验（profile.ts 将该约束留给 MCP 管理层，即本模块）：
 *   stdio → command 必填；http/sse → url 必填；
 * - 编辑 z.input 原始形态往返（不展开默认值），写入前 ProfileSchema 全量校验。
 */
import type { Host } from '../../infra/host';
import { type McpServer, type McpServerInput, McpServerSchema } from '../../schema';
import { editProfile, editProfileLocked } from '../config/edit-profile';
import { issuePath } from '../config/load';
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
 * @param server 已解析的输入形态（命令层负责来源：交互 / --from-json stdin）。
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

/** removeMcpServerLocked 结果。 */
export interface RemoveMcpServerResult {
  /** 被移除的条目（移除前的记录，经 McpServerSchema.parse 填充默认值）。 */
  readonly removed: McpServer;
  /** 移除后的完整 servers 列表。 */
  readonly servers: McpServer[];
  readonly profileFile: string;
}

/**
 * 「目标层没有这个 server」→ ConfigError(2)。
 *
 * 消息里带该层现有名单：`mcp remove` 最常见的误用是名字打对了但层选错了
 * （project 层删 user 层登记的 server），只报「不存在」会让用户以为记错了名字。
 *
 * `otherScopeHasServer=true`（另一层确实登记了同名）时给出**可直接复制**的
 * `--scope <另一层>`，而不是泛化的「加 --scope 指定」——那等于让用户自己再推一次。
 */
function mcpServerNotFoundError(
  targetLayer: TargetLayer,
  name: string,
  current: readonly McpServerInput[],
  otherScopeHasServer: boolean,
): ConfigError {
  const names = current.map((s) => s.name ?? '');
  const otherScope = targetLayer.scope === 'project' ? 'user' : 'project';
  return new ConfigError(
    `该层 profile.yaml 未登记 MCP server: ${name}（${targetLayer.profileFile}）；现有: ${
      names.length === 0 ? '(无)' : names.join(', ')
    }`,
    {
      hint: otherScopeHasServer
        ? `该 server 登记在 ${otherScope} 层而不是 ${targetLayer.scope} 层：改用 aforge mcp remove ${name} --scope ${otherScope}`
        : '运行 aforge status 查看生效的 MCP server 及其所在层',
      details: {
        name,
        profileFile: targetLayer.profileFile,
        scope: targetLayer.scope,
        servers: names,
        otherScope,
        otherScopeHasServer,
      },
    },
  );
}

/**
 * 被移除条目的完整形态（填充 enabled 等默认值，与 addMcpServer 的 `server` 同形态）。
 *
 * 为什么要单独 parse：editProfileLocked 回给调用方的 `parsed` 是**移除后**的 profile，
 * 里面已经没有这条记录了；而结果契约要求返回移除前那条的输出形态。
 * 这条记录本身不合法（手工改坏了 profile.yaml 里的这一项）时必须报 ConfigError(2)
 * 而不是静默降级——否则用户拿到的 `removed` 会缺字段，脚本据此回滚就写错配置。
 * 校验放在 mutate 内部执行，失败即在 atomicWrite 之前中止，profile 不被改写。
 */
function parseRemovedServer(entry: McpServerInput, profileFile: string): McpServer {
  const result = McpServerSchema.safeParse(entry);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  - ${issuePath(issue)}: ${issue.message}`);
    throw new ConfigError(
      `待移除的 MCP server 声明不合法（${profileFile}）:\n${lines.join('\n')}`,
      {
        hint: '先手工修正 profile.yaml 里 mcp.servers 下该条目的字段，再执行 aforge mcp remove',
        details: { entry, profileFile, issues: result.error.issues },
      },
    );
  }
  return result.data;
}

/**
 * 从目标层 profile.yaml 的 mcp.servers 摘掉一条声明（**调用方须已持 SoT 事务锁**）。
 *
 * 走 editProfileLocked 而非 editProfile：`.sync.lock` 是非递归目录锁，命令层已把
 * 「解析目标层 → 摘除」整段包进一次 withSotLock（见 commands/assets/mcp.runMcpRemove），
 * 内层再自取锁会撞自己刚建的锁目录而抛 ConflictError(3)。
 *
 * 存在性判据落在 mutate 内部：命中即必然改动（无幂等分支），未命中则在写盘前抛
 * ConfigError(2)——`mcp remove` 一个不存在的名字是用户输入错误，不是空操作成功。
 *
 * 空名判据在本函数里是**兜底**：命令层 runMcpRemove 已在取锁前拦掉同一判据，保证
 * 非法名恒得退出码 2、不被锁冲突的 ConflictError(3) 抢先（Spec §6.1）。这里再拦一次
 * 是为了绕过命令层直接调 core 的场景（其他核心模块 / 单测）也拿到同一契约——两处同义，
 * 谁都不能只留一份：只留命令层则 core 契约破口，只留 core 则退出码被锁冲突抢先。
 *
 * **投影侧的清理时机**：本函数只改 SoT。被摘掉的 server 键由**下一次 `aforge sync`**
 * 从 `opencode.json` / `.mcp.json` / `.pi\mcp.json` 里摘除——sync 按 sync-meta 上一轮
 * 记账的 `mcpServers` 做差集（Spec §7.6 prune），§8.2「未知键一律保留」仍然成立：
 * 摘的只是记账里认领过的键。命令层输出据此指向 sync，并列出会被清理的文件。
 *
 * @param options.otherScopeHasServer 另一层是否登记了同名（命令层在**锁外**只读探测
 *        后传入）。仅用于「该层没登记」时把 hint 升级成可直接复制的 `--scope <另一层>`；
 *        缺省 false → 退回泛化 hint。核心层自己不做这次探测：那要读另一层的 SoT，
 *        属命令层的层解析职责，且 mutate 回调是纯同步函数、内部不能 await。
 * @throws ConfigError(2) 名字为空（命令层已在锁外先拦，此处为兜底）/ 该层未登记该名字 /
 *         待移除条目声明不合法 /
 *         profile.yaml 损坏 / 修改后整体校验失败。
 * @throws PermissionError(4) profile.yaml 读不出来（被独占打开 / 无读权限）。
 */
export async function removeMcpServerLocked(
  host: Host,
  targetLayer: TargetLayer,
  name: string,
  options: { otherScopeHasServer?: boolean } = {},
): Promise<RemoveMcpServerResult> {
  if (name.trim() === '') {
    throw new ConfigError('MCP server 名不能为空', {
      hint: '用法: aforge mcp remove <name>；运行 aforge status 查看已登记的 server',
      details: { name },
    });
  }

  // mutate 须为纯函数，但被移除的条目要回给调用方，故用闭包带出来
  let removed: McpServer | undefined;
  const { parsed, profileFile } = await editProfileLocked(host, targetLayer, (profile) => {
    const current: McpServerInput[] = profile.mcp?.servers ?? [];
    const hit = current.find((s) => s.name === name);
    if (hit === undefined) {
      throw mcpServerNotFoundError(
        targetLayer,
        name,
        current,
        options.otherScopeHasServer === true,
      );
    }
    removed = parseRemovedServer(hit, targetLayer.profileFile);
    const servers = current.filter((s) => s.name !== name);
    return { ...profile, mcp: { ...profile.mcp, servers } };
  });

  if (removed === undefined) {
    // 到不了这里：mutate 必然已赋值或抛出（编译期收窄用）
    throw new ConfigError(`MCP server 移除后未能读回被删条目: ${name}`, {
      hint: '这是 AgentForge 内部错误，请提交 issue',
      details: { name, profileFile },
    });
  }

  return { removed, servers: parsed.mcp.servers ?? [], profileFile };
}
