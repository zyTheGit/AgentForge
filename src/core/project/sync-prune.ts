/**
 * 上一轮投影产物的差集清理（Spec §7.6 prune）。
 *
 * 缺口背景：投影只写「本轮应有的产物」，从不比对上一轮。于是 `aforge skill remove`
 * 之后 SoT 已摘除该 skill，但各 agent 侧的 `skills\<name>\SKILL.md` 永久残留；
 * `aforge mcp remove` 之后 merge_json 的深合并只覆盖不删键，被摘掉的 server 也
 * 永久留在投影文件里（§8.2「未知键一律保留」）。
 *
 * 清理口径（三条硬约束）：
 * 1. **只删记账里有的东西**：删除白名单来自上一轮 sync-meta 的 `artifacts` /
 *    `mcpServers`，不扫描目录、不按通配符猜产物。没记过的文件一律不碰——用户
 *    自己在 `.claude\skills\` 下放的东西不该被 aforge 收走；
 * 2. **改过的不删**：删文件前比对当前内容 hash 与记账值，不等则跳过并告警。
 *    手工编辑过的产物宁可残留，也不能静默吞掉；
 * 3. **子集 sync 只管本次的 target**：`--targets claude` 不该清理 opencode 的
 *    产物（它们本轮没重写，差集算出来必然"多余"）。未参与的 target 记账原样保留。
 *
 * `artifacts` / `mcpServers` 字段缺席（老版本写的 sync-meta）→ 本轮只记账不删，
 * 首次升级不会把一批没有记录的既有产物当成"不该存在"。
 *
 * 空目录不回收：删掉 `skills\pdf\SKILL.md` 后留下的空 `skills\pdf\` 无害，而
 * 回滚路径的 atomicWrite 不建目录——顺手删目录会让「先 prune 再回滚」变成写不回去。
 *
 * 事务：本模块的删除 / 改写全部走 backupTarget + recordDelete/recordWrite，
 * 与投影产物同一份备份与 journal；调用点在 syncOnce 的锁与事务作用域内。
 */
import { atomicWrite, normalizeLineEnding, sha256Hex } from '../../infra/fsutil';
import type { SyncArtifact, SyncMeta } from '../../schema';
import { buildMcpServersObject } from './projectors/mcp-payload';
import type { PlannedTarget } from './sync-prepare';
import { backupTarget, recordDelete, recordWrite, type SyncTransaction } from './sync-transaction';
import type { ProjectContext } from './types';

/** 被清理掉的一项。 */
export interface SyncPrunedEntry {
  /** artifact = 整个文件被删；mcp-server = 从 JSON 配置里摘掉一个 server 键。 */
  readonly kind: 'artifact' | 'mcp-server';
  readonly path: string;
  /** kind='mcp-server' 时为被摘掉的 server 名。 */
  readonly name?: string;
}

/** 该清理但被跳过的一项（连同原因，命令层原样呈现）。 */
export interface SyncPruneSkip {
  readonly kind: 'artifact' | 'mcp-server';
  readonly path: string;
  readonly reason: string;
  readonly name?: string;
}

/** 本轮记账（写进 sync-meta，作为下一轮的删除白名单）。 */
export interface SyncPruneAccounting {
  /** sync-meta.artifacts：整文件产物（含未参与本次 sync 的 target）。 */
  readonly artifacts: readonly SyncArtifact[];
  /** sync-meta.mcpServers：本轮投影出的 server 名。 */
  readonly mcpServers: readonly string[];
}

/** prune 的执行结果 + 本轮记账（由调用方写进 sync-meta）。 */
export interface SyncPruneResult extends SyncPruneAccounting {
  readonly pruned: readonly SyncPrunedEntry[];
  readonly skipped: readonly SyncPruneSkip[];
}

/**
 * 本轮的整文件产物记账：只取 action='write' 的项。
 *
 * merge_* 系动作的文件与用户内容共处（marker 区间外的正文、JSON 未知键、TOML
 * 其他表），整文件删除永远不成立，因此不进这张表。
 *
 * contentHash 直接由 item.content 算，不读回落盘内容：sha256Hex 是 LF 规范化的，
 * 与 `line_ending` 无关，而 write 项的落盘内容就是 item.content 的换行规范化形态。
 */
export function accountArtifacts(planned: readonly PlannedTarget[]): SyncArtifact[] {
  const artifacts: SyncArtifact[] = [];
  for (const target of planned) {
    for (const item of target.plan.items) {
      if (item.action === 'write') {
        artifacts.push({
          path: item.path,
          contentHash: sha256Hex(item.content),
          targetId: target.targetId,
        });
      }
    }
  }
  return artifacts;
}

/** 本轮投影出的 MCP server 名（口径与 merge_json 载荷同源：enabled=false 不投影）。 */
export function accountMcpServers(ctx: ProjectContext): string[] {
  return Object.keys(buildMcpServersObject(ctx.mcpServers));
}

/**
 * 执行差集清理并返回本轮记账（Spec §7.6）。
 *
 * 调用时机：全部 target apply 成功之后、journal 提交与写 sync-meta 之前——此刻
 * 磁盘上已是本轮的最终形态，差集才有意义；且仍在事务内，中途被强杀可由下次 sync
 * 按 journal 还原。
 *
 * @param previous 上一轮 sync-meta（null = 首次 sync，只记账）。
 */
export async function pruneStaleProjections(
  tx: SyncTransaction,
  previous: SyncMeta | null,
  planned: readonly PlannedTarget[],
  ctx: ProjectContext,
): Promise<SyncPruneResult> {
  const currentArtifacts = accountArtifacts(planned);
  const currentServers = accountMcpServers(ctx);
  const plannedTargetIds = new Set(planned.map((t) => t.targetId));

  const pruned: SyncPrunedEntry[] = [];
  const skipped: SyncPruneSkip[] = [];

  await pruneArtifacts(
    tx,
    previous?.artifacts,
    currentArtifacts,
    plannedTargetIds,
    pruned,
    skipped,
  );
  await pruneMcpServers(tx, previous?.mcpServers, currentServers, planned, ctx, pruned, skipped);

  return {
    pruned,
    skipped,
    // 未参与本次 sync 的 target 记账原样保留（子集 sync 不得把别人的产物记丢，
    // 否则下一轮全量 sync 会因为"没记过"而永远不清理它们）
    artifacts: [
      ...(previous?.artifacts ?? []).filter((a) => !plannedTargetIds.has(a.targetId)),
      ...currentArtifacts,
    ],
    mcpServers: currentServers,
  };
}

/**
 * 整文件产物的差集删除：记账里有、本轮不再产出的 write 项。
 *
 * `recorded === undefined`（老版本 sync-meta 无该字段）→ 整段跳过，只记账。
 */
async function pruneArtifacts(
  tx: SyncTransaction,
  recorded: readonly SyncArtifact[] | undefined,
  current: readonly SyncArtifact[],
  plannedTargetIds: ReadonlySet<string>,
  pruned: SyncPrunedEntry[],
  skipped: SyncPruneSkip[],
): Promise<void> {
  if (recorded === undefined) {
    return;
  }
  const keep = new Set(current.map((a) => a.path));
  for (const artifact of recorded) {
    if (keep.has(artifact.path) || !plannedTargetIds.has(artifact.targetId)) {
      continue;
    }
    if (!(await tx.host.exists(artifact.path))) {
      continue; // 早已不在（用户手删 / 上次已清）：无事可做，也不必报
    }
    let currentHash: string;
    try {
      currentHash = sha256Hex(await tx.host.readFile(artifact.path));
    } catch (err) {
      skipped.push({
        kind: 'artifact',
        path: artifact.path,
        reason: `无法读取以核对内容：${messageOf(err)}`,
      });
      continue;
    }
    if (currentHash !== artifact.contentHash) {
      skipped.push({
        kind: 'artifact',
        path: artifact.path,
        reason: '内容与上次投影记录不一致（疑似手工修改），已保留',
      });
      continue;
    }
    try {
      await backupTarget(tx, artifact.path);
      await tx.host.rm(artifact.path);
      await recordDelete(tx, artifact.path);
      pruned.push({ kind: 'artifact', path: artifact.path });
    } catch (err) {
      skipped.push({
        kind: 'artifact',
        path: artifact.path,
        reason: `删除失败：${messageOf(err)}`,
      });
    }
  }
}

/**
 * MCP server 键的差集摘除：上轮投影过、本轮 SoT 里已没有的 server 名。
 *
 * 只动 merge_json 项（opencode.json 的 `mcp`、`.mcp.json` / `.pi\mcp.json` 的
 * `mcpServers`）。codex 走 merge_toml——标记段每轮整段重写，被摘掉的
 * `[[mcp_servers.*]]` 表本来就不会残留，不需要 prune。
 *
 * 要摘哪个键不额外声明，从**本项的管理载荷**现算：载荷的顶层对象键就是该 target
 * 存放 server 映射的位置（opencode `mcp` / 其余 `mcpServers`）。这样新增 target
 * 只要沿用 merge_json 契约就自动被覆盖，不必在两处维护键名表。
 */
async function pruneMcpServers(
  tx: SyncTransaction,
  recorded: readonly string[] | undefined,
  current: readonly string[],
  planned: readonly PlannedTarget[],
  ctx: ProjectContext,
  pruned: SyncPrunedEntry[],
  skipped: SyncPruneSkip[],
): Promise<void> {
  if (recorded === undefined) {
    return;
  }
  const keep = new Set(current);
  const stale = recorded.filter((name) => !keep.has(name));
  if (stale.length === 0) {
    return;
  }

  for (const target of planned) {
    for (const item of target.plan.items) {
      if (item.action !== 'merge_json' || !(await tx.host.exists(item.path))) {
        continue;
      }
      let updated: { text: string; removed: string[] } | null;
      try {
        updated = stripServerKeys(await tx.host.readFile(item.path), item.content, stale);
      } catch (err) {
        skipped.push({
          kind: 'mcp-server',
          path: item.path,
          reason: `无法读取或解析该配置文件：${messageOf(err)}`,
        });
        continue;
      }
      if (updated === null) {
        continue; // 这些 server 键本来就不在该文件里
      }
      try {
        await backupTarget(tx, item.path);
        await atomicWrite(tx.host, item.path, normalizeLineEnding(updated.text, ctx.lineEnding));
        await recordWrite(tx, item.path);
        for (const name of updated.removed) {
          pruned.push({ kind: 'mcp-server', path: item.path, name });
        }
      } catch (err) {
        skipped.push({
          kind: 'mcp-server',
          path: item.path,
          reason: `摘除 server 键失败：${messageOf(err)}`,
        });
      }
    }
  }
}

/**
 * 从 JSON 文本里摘掉指定 server 名（纯函数）。
 *
 * 作用范围严格限定在**管理载荷声明的顶层键**之下：`managedJson` 的每个顶层对象键
 * 就是该 target 的 server 映射位置，只在那里面按名字删。文件其余部分（未知键、
 * 用户自己的配置）逐字不动。
 *
 * @returns 摘除后的 JSON 文本 + 实际摘掉的名字；一个都没命中 → null（不重写文件）。
 * @throws SyntaxError JSON 解析失败（调用方转成 skip 原因，绝不覆盖坏文件）。
 */
export function stripServerKeys(
  existing: string,
  managedJson: string,
  stale: readonly string[],
): { text: string; removed: string[] } | null {
  const current: unknown = JSON.parse(existing);
  const managed: unknown = JSON.parse(managedJson);
  if (!isPlainObject(current) || !isPlainObject(managed)) {
    return null;
  }

  const removed: string[] = [];
  for (const key of Object.keys(managed)) {
    const section = current[key];
    if (!isPlainObject(section)) {
      continue;
    }
    for (const name of stale) {
      if (Object.hasOwn(section, name)) {
        delete section[name];
        removed.push(name);
      }
    }
  }
  return removed.length === 0 ? null : { text: `${JSON.stringify(current, null, 2)}\n`, removed };
}

/** 纯数据对象判断（数组 / null 排除；与 writer.isPlainObject 同口径）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 异常的人类可读说明（skip 原因里原样呈现）。 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
