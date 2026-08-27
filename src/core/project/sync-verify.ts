/**
 * 写入前的一致性预检查与写入后的记账（Spec §8.2-4 / §3.3）。
 *
 * - assertNoMarkerConflicts：apply 前读现有投影文件，marker 区间 hash 与 sync-meta
 *   记录值不一致 → ConflictError(3)（用户手改过区间内容，直接覆盖等于吞掉他的编辑）；
 *   `--force` 跳过，首次 sync（无记录）不检查；
 * - writeSyncMetaOnSuccess：只在全部硬项成功后写 sync-meta.json。soft 失败的 target
 *   不记账——contentHash 是 doctor 的一致性基准，投影不完整的 target 不该提供基准，
 *   保留上次成功记录才能让后续 doctor 识别漂移。
 */
import { isPermissionErrno } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import type { SyncMeta } from '../../schema';
import { ConflictError, PermissionError } from '../errors';
import { markerSectionHash, splitByMarkers } from '../markers';
import type { OsContext } from '../paths';
import { readSyncMeta, writeSyncMeta } from './sync-meta';
import { type PlannedTarget, resolveMarkers } from './sync-prepare';
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
    },
    lineEnding,
  );
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
      let existing: string;
      try {
        existing = await host.readFile(item.path);
      } catch (err) {
        if (isPermissionErrno(err)) {
          throw new PermissionError(`无法读取现有投影文件（冲突预检查）: ${item.path}`, {
            hint: '检查文件的读权限与所在目录 ACL（必要时以管理员身份运行）',
            details: err,
          });
        }
        throw err;
      }
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
