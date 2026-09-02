/**
 * 写入前的一致性预检查与写入后的记账（Spec §8.2-4 / §3.3 / §7.6）。
 *
 * - assertNoMarkerConflicts：apply 前读现有投影文件，marker 区间 hash 与 sync-meta
 *   记录值不一致 → ConflictError(3)（用户手改过区间内容，直接覆盖等于吞掉他的编辑）；
 *   `--force` 跳过，首次 sync（无记录）不检查；
 * - assertNoWriteConflicts：整文件 `write` 项的同款保护，但只管**本轮新进记账**的路径
 *   （上一轮 `artifacts` 里没有、磁盘上却已存在）——`write` 是整文件替换，这类路径上
 *   的既有文件必然是 AgentForge 从未认领过的用户内容；
 * - writeSyncMetaOnSuccess：只在全部硬项成功后写 sync-meta.json。soft 失败的 target
 *   不记账——contentHash 是 doctor 的一致性基准，投影不完整的 target 不该提供基准，
 *   保留上次成功记录才能让后续 doctor 识别漂移。
 */
import { isPermissionErrno, sha256Hex } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import type { SyncMeta } from '../../schema';
import { ConflictError, PermissionError } from '../errors';
import { markerSectionHash, splitByMarkers } from '../markers';
import type { OsContext } from '../paths';
import { readSyncMeta, writeSyncMeta } from './sync-meta';
import { type PlannedTarget, resolveMarkers } from './sync-prepare';
import type { SyncPruneAccounting } from './sync-prune';
import type { SyncOptions, SyncWarning } from './sync-types';
import type { ProjectContext } from './types';
import type { ProjectionMarkers } from './writer';

/**
 * soft 项与 sync-meta（M6 决策，Spec §8.6 / §3.3）：
 * soft 项（pi `.pi\mcp.json`）失败的 target **不写入** sync-meta 的该 target 记录
 * （另一可选方案为标记 skipped，但会改动 §3.3 schema）。理由：contentHash 是
 * doctor 一致性检测（M7）的基准，投影不完整的 target 不应提供基准，保留上次
 * 成功记录可让后续 doctor 识别漂移。
 *
 * 并发：此处的读-改-写（保留其他 target 既有记录）必须在 SoT 事务锁内执行，
 * 否则并发的子集 sync（--targets）会互相丢记录——调用点在 syncOnce 的锁作用域内。
 *
 * contentHash 取 `target.contentHash`（本次实际落盘的区间形态）而非渲染正文的区间
 * hash：`marker_mode: append_below_marker` 下落盘区间是「新正文 + 空行 + 旧内容」，
 * 记录渲染正文会让下一次 sync 的区间比对必然不等 → 该模式在其唯一有意义的场景下
 * 恒定误报 ConflictError(3)。读回失败时才退回渲染值（两者在 replace 模式下相等）。
 */
export async function writeSyncMetaOnSuccess(
  host: Host,
  opts: SyncOptions,
  os: OsContext,
  sotRoot: string,
  contentHash: string,
  planned: readonly PlannedTarget[],
  warnings: readonly SyncWarning[],
  lineEnding: ProjectContext['lineEnding'],
  accounting: SyncPruneAccounting,
): Promise<void> {
  const warnedTargets = new Set(warnings.map((w) => w.targetId));
  const existing = await readSyncMeta(host, sotRoot);
  const now = host.now().toISOString();
  const targetsMeta = { ...(existing?.targets ?? {}) };
  for (const target of planned) {
    if (!warnedTargets.has(target.targetId)) {
      targetsMeta[target.targetId] = {
        contentHash: target.contentHash ?? contentHash,
        writtenAt: now,
      };
    }
  }
  await writeSyncMeta(
    host,
    sotRoot,
    {
      version: 1,
      lastSyncAt: now,
      os: os.platform,
      agentforgeVersion: opts.agentforgeVersion,
      targets: targetsMeta,
      artifacts: [...accounting.artifacts],
      mcpServers: [...accounting.mcpServers],
    },
    lineEnding,
  );
}

/**
 * 读取上一轮记账（marker 冲突预检查与 §7.6 prune 共用同一份，只读一次）。
 *
 * `--force` 下 sync-meta 损坏按「无基准」处理：该开关的既有语义就是跳过基准比对，
 * 不该因为记账文件坏了而堵住用户的强制覆盖。非 force 路径仍照 sync-meta.ts 的契约
 * fail-fast（ConfigError(2)，不静默丢基准）。
 */
export async function readSyncMetaBaseline(
  host: Host,
  sotRoot: string,
  force: boolean,
): Promise<SyncMeta | null> {
  if (!force) {
    return readSyncMeta(host, sotRoot);
  }
  try {
    return await readSyncMeta(host, sotRoot);
  } catch {
    return null;
  }
}

/**
 * apply 之后读回投影文件，取本次实际落盘的 marker 区间 hash 作为该 target 的
 * sync-meta 基准（与 assertNoMarkerConflicts / doctor 读回投影后的算法同构）。
 *
 * 只看该 target 的 merge_marker 项（四个 projector 各恰有一个主规则项）；
 * `marker_mode: none` 的整文件 write 没有区间可比 → 返回 undefined 沿用渲染值。
 */
export async function readBackSectionHash(
  host: Host,
  target: PlannedTarget,
  markers: ProjectionMarkers,
): Promise<string | undefined> {
  const item = target.plan.items.find((i) => i.action === 'merge_marker');
  if (item === undefined) {
    return undefined;
  }
  try {
    const content = await host.readFile(item.path);
    const split = splitByMarkers(content, markers.begin, markers.end);
    return split.hasMarkers ? markerSectionHash(content, markers.begin, markers.end) : undefined;
  } catch {
    return undefined; // 读不回（权限 / 已被并发删除）：退回渲染正文的区间 hash
  }
}

/**
 * marker 区间冲突预检查（Spec §8.2-4，M7；在备份 / mkdirp 之前执行——
 * 冲突时零副作用，进零目录都不创建）：
 *
 * - 逐个 merge_marker 项：读现有投影文件 → splitByMarkers 判定有区间 → 用
 *   markerSectionHash(现有文件) 与 sync-meta 记录的 contentHash 比对；
 * - 比对基准自洽：sync 记录的 contentHash 就是**上次实际落盘的区间** hash
 *   （writeSyncMetaOnSuccess 读回投影文件计算），与此处的 markerSectionHash 同构，
 *   因此 replace / append 两种 marker_mode 下都不会误报；
 * - 跳过：无 sync-meta / 该 target 无记录（首次或子集 sync）/ 文件不存在 /
 *   文件无 marker（用户已移除区间 → replaceBetween 走 EOF 追加，非冲突）；
 * - 读现有文件权限失败 → PermissionError(4)（与备份阶段同语义）。
 *
 * @throws ConflictError(3) 任一区间 hash 与记录不一致（details.conflicts 列出全部路径）。
 */
export async function assertNoMarkerConflicts(
  host: Host,
  planned: readonly PlannedTarget[],
  syncMeta: SyncMeta | null,
  ctx: ProjectContext,
): Promise<void> {
  if (syncMeta === null) {
    return; // 首次 sync（或 sync-meta 尚不存在）：无基准，不检查
  }
  const conflicts: string[] = [];
  for (const target of planned) {
    const recorded = syncMeta.targets[target.targetId];
    if (recorded === undefined) {
      continue; // 该 target 无上次记录（如上次 --targets 子集 sync）
    }
    const markers = resolveMarkers(target.plan, ctx);
    for (const item of target.plan.items) {
      if (item.action !== 'merge_marker') {
        continue; // 只检查 md marker 区间（§8.2-4；merge_toml/json 不在本检测范围）
      }
      if (!(await host.exists(item.path))) {
        continue; // 投影文件不存在：sync 将新建，无区间可比
      }
      const existing = await readExistingProjection(host, item.path);
      const split = splitByMarkers(existing, markers.begin, markers.end);
      if (!split.hasMarkers) {
        continue;
      }
      if (markerSectionHash(existing, markers.begin, markers.end) !== recorded.contentHash) {
        conflicts.push(item.path);
      }
    }
  }
  if (conflicts.length > 0) {
    throw new ConflictError('marker 区间可能被手动修改，请执行 aforge doctor 查看详情', {
      hint: '确认修改无需保留后执行 aforge sync --force 强制覆盖；否则请先恢复区间内容',
      details: { conflicts },
    });
  }
}

/**
 * 整文件 `write` 项的冲突预检查（与 assertNoMarkerConflicts 同出口、同时机——
 * 备份 / mkdirp 之前，冲突时零副作用）。
 *
 * 为什么需要它：`write` 是**整文件替换**，而既有的两道保护都盖不住第一次写入——
 * marker 预检查只看 `merge_marker` 项，§7.6 prune 的「改过的不删」只作用于上一轮
 * `artifacts` 里**已有**的路径。于是任何一条 `write` 项第一次进记账时，落点上用户
 * 手写的同名文件会被静默整文件替换（`learning.auto_capture: hook` 首次投出
 * `hooks.json` 是最容易撞上的一例，事务备份在 apply 成功后即丢弃 → 找不回）。
 *
 * **检查范围刻意收窄为「本轮新进记账的路径」**：上一轮 `artifacts` 里已有该路径 →
 * 跳过。理由是这类路径已经由 AgentForge 认领，其磁盘内容与本轮渲染结果不同是
 * SoT 正常演进（改了 skill 正文、换了模板）的常态，对它们比对会让每次 SoT 变更都
 * 报冲突；手工改动这类**已认领**产物的风险由 §7.6 prune 的 hash 比对与 doctor 兜。
 * 反过来，「记账里没有、磁盘上却已存在」只有一种解释：那是 AgentForge 从未写过的
 * 用户文件。
 *
 * 三条跳过（合起来保证存量用户不会在升级后被大面积 ConflictError 拦住）：
 * - `syncMeta.artifacts === undefined`（老版本 sync-meta 没有这张记账表）→ 整段跳过，
 *   口径同 sync-prune.pruneArtifacts：此时磁盘上的产物极可能就是上几轮 sync 自己写的，
 *   缺记账不等于是用户文件；
 * - 路径已在上一轮 `artifacts` 里 → 跳过（见上）；
 * - 磁盘上的内容 hash **等于**本轮将写入的内容 → 跳过（幂等重跑 / 用户把文件写成了
 *   同样的内容，覆盖不丢任何东西）。
 *
 * `syncMeta === null`（从未 sync 过）**不跳过**：此时记账表为空，全部 `write` 落点
 * 都算「新进记账」，而这正是风险最高的一刻——首次 sync 把用户既有文件整份换掉。
 * 存量用户不受影响（他们有 sync-meta 且路径都已记账）。
 *
 * @throws ConflictError(3) 任一新进记账的落点上已有内容不同的文件（details.conflicts
 *   只列路径，不回显文件内容——§11.2 凭据不外泄）。
 */
export async function assertNoWriteConflicts(
  host: Host,
  planned: readonly PlannedTarget[],
  syncMeta: SyncMeta | null,
): Promise<void> {
  if (syncMeta !== null && syncMeta.artifacts === undefined) {
    return; // 老版本记账：无这张表，按「没有基准可比」处理（同 prune）
  }
  const recordedPaths = new Set((syncMeta?.artifacts ?? []).map((a) => a.path));
  const conflicts: string[] = [];
  for (const target of planned) {
    for (const item of target.plan.items) {
      if (item.action !== 'write' || recordedPaths.has(item.path)) {
        continue;
      }
      if (!(await host.exists(item.path))) {
        continue; // 落点为空：新建，没有任何东西会被覆盖
      }
      const existing = await readExistingProjection(host, item.path);
      // sha256Hex 为 LF 规范化（同 accountArtifacts），因此 line_ending 差异不误报
      if (sha256Hex(existing) !== sha256Hex(item.content)) {
        conflicts.push(item.path);
      }
    }
  }
  if (conflicts.length > 0) {
    throw new ConflictError(
      '目标位置已有 AgentForge 未记账的文件，整文件写入会覆盖它，请执行 aforge doctor 查看详情',
      {
        hint: '确认这些文件无需保留后执行 aforge sync --force 强制覆盖；否则请先把它们移走或改名',
        details: { conflicts },
      },
    );
  }
}

/** 读现有投影文件（权限失败 → PermissionError(4)，与备份阶段同语义）。 */
async function readExistingProjection(host: Host, filePath: string): Promise<string> {
  try {
    return await host.readFile(filePath);
  } catch (err) {
    if (isPermissionErrno(err)) {
      throw new PermissionError(`无法读取现有投影文件（冲突预检查）: ${filePath}`, {
        hint: '检查文件的读权限与所在目录 ACL（必要时以管理员身份运行）',
        details: err,
      });
    }
    throw err;
  }
}
