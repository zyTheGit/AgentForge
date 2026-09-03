/**
 * sync-meta 记账与磁盘的一致性检查（Spec §9 / §7.6）。
 *
 * 为什么需要它：`sync-meta.artifacts` 同时是「上一轮投影出了什么」和「下一轮 prune 的
 * 删除白名单」。这份记账一旦与磁盘脱节，两种后果都是静默的——
 * - 记着而磁盘没有：产物被删/被移走却无人提醒，`status` 与 doctor 的其他检查都只看
 *   marker 区间，整文件产物（skills / commands）压根不在它们的视野里；
 * - 另一平台形态的记账：Windows 与 WSL 交替 sync 时，本进程寻址不到对面写下的路径，
 *   prune 只能保留记录（issue #68），用户得知道那些产物还挂在账上。
 *
 * 检查只读、不修复：删掉别人的文件或替用户改记账都超出 doctor 的职责，只报事实与
 * 下一步动作。
 */
import type { Host } from '../../infra/host';
import type { SyncMeta } from '../../schema';
import { nativePathFlavor, type OsContext, pathFlavorOf } from '../paths';
import type { DoctorCheckResult } from './check-types';

/** 检查项名（测试与文档共用，避免字面量在两处漂移）。 */
export const ARTIFACTS_ITEM = 'sync-meta/artifacts';

/**
 * 记账里的整文件产物是否都还在磁盘上（§7.6）。
 *
 * `artifacts` 字段缺席（老版本 sync-meta）→ ok + 说明，不报 warn：字段可选且刻意
 * 不给默认值，存量用户升级后第一次 sync 之前拿不出这份记账，报警只是噪音。
 *
 * 缺失 → warn 而不是 error：产物残缺不影响 aforge 自身正确性，重跑 sync 即补齐；
 * 而 error 会把 `doctor` 的退出码抬起来，卡住 CI 里合法的「先 clone 再 sync」顺序。
 */
export async function checkRecordedArtifacts(
  host: Host,
  os: OsContext,
  syncMeta: SyncMeta | null,
): Promise<DoctorCheckResult[]> {
  if (syncMeta === null || syncMeta.artifacts === undefined) {
    return [
      {
        section: 'consistency',
        level: 'ok',
        item: ARTIFACTS_ITEM,
        detail: 'sync-meta 未记录整文件产物（尚未 sync 或由旧版本写入），跳过存在性核对',
      },
    ];
  }

  const native = nativePathFlavor(os);
  const missing: string[] = [];
  const foreign: string[] = [];
  for (const artifact of syncMeta.artifacts) {
    if (pathFlavorOf(artifact.path) !== native) {
      foreign.push(`${artifact.path} (${artifact.targetId})`);
      continue;
    }
    if (!(await host.exists(artifact.path))) {
      missing.push(`${artifact.path} (${artifact.targetId})`);
    }
  }

  const results: DoctorCheckResult[] = [];
  if (missing.length === 0) {
    results.push({
      section: 'consistency',
      level: 'ok',
      item: ARTIFACTS_ITEM,
      detail: `记账的 ${syncMeta.artifacts.length} 个整文件产物均存在`,
    });
  } else {
    results.push({
      section: 'consistency',
      level: 'warn',
      item: ARTIFACTS_ITEM,
      detail: `记账中有 ${missing.length} 个整文件产物在磁盘上不存在：\n  ${missing.join('\n  ')}`,
      hint: '重跑 aforge sync 重新投影；若产物是你自己删的，sync 后记账会与磁盘重新对齐',
    });
  }
  if (foreign.length > 0) {
    results.push({
      section: 'consistency',
      level: 'warn',
      item: `${ARTIFACTS_ITEM}/foreign-platform`,
      detail: `记账中有 ${foreign.length} 个产物的路径不是本平台（${native}）形态，无法核对：\n  ${foreign.join('\n  ')}`,
      hint: '这些产物由另一侧（Windows / WSL）写出：在那一侧跑 aforge sync 才能清理或核对',
    });
  }
  return results;
}
