/**
 * 投影 marker 区间一致性检查（Spec §9 第 3 条，M7 三方比对）。
 *
 * 为什么单独成模块：这是 doctor 里唯一需要同时持有「当前渲染 hash / sync-meta 记录
 * 值 / 磁盘区间实际 hash」三个基准的检查，判定表（下方 JSDoc）是行为语义最密的一段，
 * 与其他 consistency 检查项没有共享状态。独立出来后，改判定表不必在几百行的编排
 * 文件里定位，也让「只比对 merge_marker 项」这条与 sync 预检查对齐的约束显式可见。
 */

import { sha256Hex } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import type { SyncMeta } from '../../schema';
import { renderedSectionHash, splitByMarkers } from '../markers';
import { projectorRegistry } from '../project/projectors/registry';
import type { ProjectContext } from '../project/types';
import { type DoctorCheckResult, errMessage } from './check-types';

/**
 * 单个投影文件的 marker 区间一致性检查（§9 第 3 条，M7）：
 * 三方比对——当前渲染 hash（A）、sync-meta 记录值（B）、投影区间实际 hash（C）：
 * - C ≠ B：区间与上次 sync 记录不一致 → warn（可能被手动修改）；
 * - C = B ≠ A：投影未被动过但 SoT 已变更 → warn（过期，未 sync）；
 * - C = B = A：一致 → ok；
 * - 文件不存在 / 无 marker / 读取失败 → warn（漂移或不可诊断）。
 */
async function checkOneProjectionFile(
  host: Host,
  results: DoctorCheckResult[],
  targetId: string,
  filePath: string,
  recordedHash: string,
  currentHash: string,
  markerBegin: string,
  markerEnd: string,
): Promise<void> {
  const item = `projection-hash/${targetId}`;
  if (!(await host.exists(filePath))) {
    results.push({
      section: 'consistency',
      level: 'warn',
      item,
      detail: `投影文件不存在: ${filePath}`,
      hint: '执行 aforge sync 重建投影',
    });
    return;
  }
  let content: string;
  try {
    content = await host.readFile(filePath);
  } catch (err) {
    results.push({
      section: 'consistency',
      level: 'warn',
      item,
      detail: `投影文件无法读取: ${filePath}\n${errMessage(err)}`,
    });
    return;
  }
  const split = splitByMarkers(content, markerBegin, markerEnd);
  if (!split.hasMarkers) {
    results.push({
      section: 'consistency',
      level: 'warn',
      item,
      detail: `投影文件无 marker 区间（可能被移除）: ${filePath}`,
      hint: '执行 aforge sync 重新追加投影区间',
    });
    return;
  }
  const sectionHash = sha256Hex(split.inside);
  if (sectionHash !== recordedHash) {
    results.push({
      section: 'consistency',
      level: 'warn',
      item,
      detail: `hash 不一致（投影与上次 sync 记录不符，可能被手动修改）: ${filePath}`,
      hint: '确认修改无需保留后执行 aforge sync --force 覆盖；否则请先恢复区间内容',
    });
  } else if (sectionHash !== currentHash) {
    results.push({
      section: 'consistency',
      level: 'warn',
      item,
      detail: `投影可能过期或被修改（SoT 在上次 sync 后已变更）: ${filePath}`,
      hint: '执行 aforge sync 更新投影',
    });
  } else {
    results.push({
      section: 'consistency',
      level: 'ok',
      item,
      detail: `一致: ${filePath}`,
    });
  }
}

/**
 * §9 第 3 条：当前渲染 hash vs 投影 marker 区间 hash（三方比对）。
 *
 * marker 一对值只从 `ctx` 取（buildPlanCtx 已由 config.profile.projection 注入）：
 * 从 config 再取一次就有了两个来源，两侧不同源时区间切分与 plan 的 merge_marker
 * 判定会静默分叉——而 projector 的 plan 用的就是 ctx 里那一对。
 *
 * 渲染失败（rendered undefined）或尚未 sync（syncMeta null）时整体跳过：三方比对
 * 缺基准，报"不一致"只会是噪音（这两种情况各有自己的 render / sync-meta 条目）。
 */
export async function checkProjectionHashes(
  host: Host,
  results: DoctorCheckResult[],
  ctx: ProjectContext,
  rendered: string | undefined,
  syncMeta: SyncMeta | null,
): Promise<void> {
  const { markerBegin, markerEnd } = ctx;
  if (rendered === undefined || syncMeta === null) {
    return;
  }
  const currentHash = renderedSectionHash(rendered, markerBegin, markerEnd);
  const recordedIds = Object.keys(syncMeta.targets);
  if (recordedIds.length === 0) {
    results.push({
      section: 'consistency',
      level: 'ok',
      item: 'projection-hash',
      detail: 'sync-meta 无投影记录（尚无成功 sync 的 target）',
    });
  }
  for (const targetId of recordedIds) {
    const projector = projectorRegistry.get(targetId);
    const recorded = syncMeta.targets[targetId];
    if (projector === undefined || recorded === undefined) {
      results.push({
        section: 'consistency',
        level: 'warn',
        item: `projection-hash/${targetId}`,
        detail: 'sync-meta 记录了未知 target（可能由更新版本的 aforge 写入）',
      });
      continue;
    }
    for (const item of projector.plan(ctx).items) {
      if (item.action !== 'merge_marker') {
        continue; // 只比对 md marker 区间（§8.2-4 检测范围，与 sync 预检查一致）
      }
      await checkOneProjectionFile(
        host,
        results,
        targetId,
        item.path,
        recorded.contentHash,
        currentHash,
        markerBegin,
        markerEnd,
      );
    }
  }
}
