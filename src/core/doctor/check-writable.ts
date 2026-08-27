/**
 * 目录可写性检查（Spec §9 第 2 条）：SoT 根与投影目标目录。
 *
 * 为什么单独成模块：这是 doctor 里**唯一有写副作用**的检查（mkdirp + 探针文件 +
 * 删除），风险与清理语义集中一处便于审计。两个导出入口只负责「dirs 从哪来 + 不可写
 * 时该建议移动什么」，探测与结果构造由 probeWritable / pushWritableResult 独占——
 * 入口不合并是因为 dirs 的来源本就不同（调用方筛好的 SoT 层 vs 从 plan 推导的目标
 * 目录），但结果构造只允许有一份，抄两遍会让两侧的 level / code / detail 悄悄分叉。
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Host } from '../../infra/host';
import { ExitCode } from '../errors';
import type { EnabledPlan } from './check-paths';
import { type DoctorCheckResult, errMessage } from './check-types';

interface ProbeResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * 目录可写性探测：mkdirp（§7.3-7 目录自动创建语义——sync 同样会创建）→
 * 写入探针文件 → 删除。任何**写入**失败均视为不可写（探针写入失败的场景，
 * 实际投影写入同样会失败）。
 *
 * 两处清理与命名上的取舍：
 * - 探针删除放进 finally——rm 失败或写入抛错时都不留残留文件；且 rm 自身失败
 *   不再改变可写判定（能写入即证明可写，清理失败只是垃圾文件）；
 * - 文件名加随机后缀（参照 fsutil.atomicWrite 的 randomBytes 做法）：仅用毫秒
 *   时间戳时并发 doctor 会撞名并互删对方探针，导致误判不可写。
 */
async function probeWritable(host: Host, dir: string): Promise<ProbeResult> {
  let probe: string | undefined;
  try {
    await host.mkdirp(dir);
    probe = path.join(
      dir,
      `.agf-doctor-probe-${host.now().getTime()}-${randomBytes(6).toString('hex')}`,
    );
    await host.writeFile(probe, '');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  } finally {
    if (probe !== undefined) {
      try {
        await host.rm(probe);
      } catch {
        // 清理失败不改变可写判定（随机后缀保证不会误伤并发 doctor 的探针）
      }
    }
  }
}

/**
 * 探测结果 → 诊断结果（两个入口共用；hint 尾句由调用方给）。
 *
 * 逐字节搬自原先两处相同的 push 分支：level / code / item / detail 必须一致，
 * 否则同一类失败在 SoT 与目标目录两侧会给出不同级别与退出码。
 */
function pushWritableResult(
  results: DoctorCheckResult[],
  dir: string,
  probe: ProbeResult,
  hint: string,
): void {
  results.push(
    probe.ok
      ? { section: 'paths', level: 'ok', item: 'writable', detail: `可写: ${dir}` }
      : {
          section: 'paths',
          level: 'error',
          code: ExitCode.Permission,
          item: 'writable',
          detail: `不可写: ${dir}${probe.error ? `（${probe.error}）` : ''}`,
          hint,
        },
  );
}

/** SoT 根可写性（只探测实际存在的层；不创建未初始化层——由调用方筛好 dirs）。 */
export async function checkSotWritable(
  host: Host,
  results: DoctorCheckResult[],
  sotDirs: readonly string[],
): Promise<void> {
  for (const dir of sotDirs) {
    pushWritableResult(
      results,
      dir,
      await probeWritable(host, dir),
      '检查目录写权限（必要时以管理员身份运行），或把 SoT 移到用户可写位置',
    );
  }
}

/** §9 第 2 条：目标目录可写性（mkdirp + 探针；不可写 → error(4)）。 */
export async function checkTargetDirsWritable(
  host: Host,
  results: DoctorCheckResult[],
  enabledPlans: readonly EnabledPlan[],
): Promise<void> {
  const targetDirs = new Set<string>();
  for (const { plan } of enabledPlans) {
    for (const item of plan.items) {
      targetDirs.add(path.dirname(item.path));
    }
  }
  for (const dir of [...targetDirs].sort()) {
    pushWritableResult(
      results,
      dir,
      await probeWritable(host, dir),
      '检查目录写权限（必要时以管理员身份运行），或把项目移到用户可写位置',
    );
  }
}
