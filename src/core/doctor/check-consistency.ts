/**
 * 一致性检查（Spec §9 第 5/8 条与 sync-meta / 渲染 / on_demand 信息项）。
 *
 * 为什么单独成模块：这几项共享同一个前提——EffectiveConfig 已装配成功——且都在回答
 * 「这次 sync 会不会失败、上次 sync 留下的基准是什么」。渲染基准（renderForDoctor）
 * 必须与 sync 共用 sync-prepare.renderRulesMd 这一单一事实源（直接指实现模块，不经
 * engine 门面——那会把整个 sync 引擎图拖进 doctor），放在同一文件里让"doctor 不
 * 得自己拼渲染"这条约束有个明确落点；marker 区间三方比对因判定表独立，另置
 * check-projection-hash。
 */
import path from 'node:path';
import type { Host } from '../../infra/host';
import type { SyncMeta } from '../../schema';
import type { EffectiveConfig } from '../config/defaults';
import type { EnvSnapshot } from '../env';
import { ExitCode } from '../errors';
import { resolveTemplate } from '../generate/resolver';
import { resolveAutoCapture } from '../learning/auto-capture';
import { readSyncMeta, SYNC_META_FILE } from '../project/sync-meta';
import { renderRulesMd } from '../project/sync-prepare';
import type { DoctorRoots } from './check-config';
import type { EnabledPlan } from './check-paths';
import { type DoctorCheckResult, errHint, errMessage, toDoctorCode } from './check-types';

/**
 * 当前 SoT 渲染（hash 基准；与 sync 共用 sync-prepare.renderRulesMd）。失败 → error 并返回 undefined。
 *
 * 不传 EnvSnapshot：渲染正文与环境无关（`learning.auto_capture` 只经
 * effectiveAutoCapture），CI 与本地渲染同一份 SoT 得到同一个 contentHash。
 */
export async function renderForDoctor(
  host: Host,
  results: DoctorCheckResult[],
  roots: DoctorRoots,
  config: EffectiveConfig,
): Promise<string | undefined> {
  try {
    return await renderRulesMd(
      host,
      roots.userRootForLoad,
      roots.projectSoTRoot,
      config.habits,
      config.profile,
    );
  } catch (err) {
    results.push({
      section: 'consistency',
      level: 'error',
      code: toDoctorCode(err),
      item: 'render',
      detail: errMessage(err),
      hint: errHint(err),
    });
    return undefined;
  }
}

/** §9 第 5 条：未解析的 template id（sync 将失败，error(2)）。 */
export async function checkTemplates(
  host: Host,
  results: DoctorCheckResult[],
  roots: DoctorRoots,
  config: EffectiveConfig,
): Promise<void> {
  const { userRootForLoad, projectSoTRoot } = roots;
  const templateIds = config.profile.templates ?? [];
  if (templateIds.length === 0) {
    results.push({
      section: 'consistency',
      level: 'ok',
      item: 'templates',
      detail: 'profile.templates 未声明（渲染仅含 base/default）',
    });
    return;
  }
  let unresolved = false;
  for (const id of templateIds) {
    try {
      await resolveTemplate(id, {
        host,
        userSoTRoot: userRootForLoad,
        projectSoTRoot,
        storeRoot: path.join(userRootForLoad, 'store'),
      });
    } catch (err) {
      unresolved = true;
      results.push({
        section: 'consistency',
        level: 'error',
        code: toDoctorCode(err),
        item: `template/${id}`,
        detail: errMessage(err),
        hint: errHint(err),
      });
    }
  }
  if (!unresolved) {
    results.push({
      section: 'consistency',
      level: 'ok',
      item: 'templates',
      detail: `全部 ${templateIds.length} 个模板 id 解析成功`,
    });
  }
}

/** profile.skills.on_demand：MVP 只登记不物化（Spec §4.2 注记）。 */
export function checkSkillsOnDemand(results: DoctorCheckResult[], config: EffectiveConfig): void {
  // 与 status 的展示口径一致（同一句 "declared only - not projected in MVP"），
  // 让"声明了但不会被投影"这件事在 doctor 里也可见；纯信息项，恒 ok（不影响退出码）
  const onDemandSkills = config.profile.skills.on_demand ?? [];
  results.push({
    section: 'config',
    level: 'ok',
    item: 'skills-on-demand',
    detail:
      onDemandSkills.length === 0
        ? 'profile.skills.on_demand 未声明'
        : `${onDemandSkills.join(', ')} (declared only - not projected in MVP)`,
  });
}

/**
 * profile.skills.copy_mode：`symlink` 已声明未实现（Spec §4.2 注记 / §12 Phase 2）。
 *
 * 为什么是 warn 而不是让 schema 拒绝：`CopyMode` enum 从 M1 起就收 `symlink`，
 * 改成拒绝会让既有写了该值的 profile 直接加载失败（ConfigError(2)），是破坏性变更。
 * 但静默接受同样不行——用户以为配了就生效，实际 `skill add` 与四个 projector 恒做
 * 实体 copy。折中：照旧接受，由 doctor 明说"声明了但当前不生效"。
 *
 * 恒不影响退出码（warn 不参与 §6.1 的码计算），因为投影结果本身是正确的，
 * 只是与声明不符；与 skills-on-demand 同属"声明 vs 实际"的信息类落点。
 */
export function checkSkillsCopyMode(results: DoctorCheckResult[], config: EffectiveConfig): void {
  const copyMode = config.profile.skills.copy_mode;
  if (copyMode === 'symlink') {
    results.push({
      section: 'config',
      level: 'warn',
      item: 'skills-copy-mode',
      detail:
        'profile.skills.copy_mode: symlink 已声明，但 MVP 恒为实体 copy（Spec §12 Phase 2）——当前投影行为不受影响',
      hint: '改为 skills.copy_mode: copy 可消除该告警；symlink 支持属 Phase 2',
    });
    return;
  }
  results.push({
    section: 'config',
    level: 'ok',
    item: 'skills-copy-mode',
    detail: `profile.skills.copy_mode: ${copyMode}（skills 投影为实体 copy）`,
  });
}

/**
 * profile.learning.auto_capture：声明档位 vs 实际生效档位（Spec §7.4 / §9）。
 *
 * 两件"声明了但不完全生效"都必须说出来，口径同 skills-copy-mode：
 * - `hook`：MVP 没有任何 target 侧钩子写入（§12 Phase 3）→ warn，行为等同 off；
 * - `CI` 为真：learnings 恒不落盘（§7.4 护栏 3 / §10）→ **不是错误**，报 ok 并补一句
 *   原因。注意这只影响*写入*，投影正文不变（`prompt` 档在 CI 下照样渲染
 *   `## Learning Protocol` 段），这样 contentHash 才跨环境稳定。
 *
 * 恒不影响退出码：投影结果本身是自洽的，只是与声明不符。
 */
export function checkLearningAutoCapture(
  results: DoctorCheckResult[],
  config: EffectiveConfig,
  env: EnvSnapshot,
): void {
  const state = resolveAutoCapture(config.profile, env);
  if (state.unimplemented) {
    results.push({
      section: 'config',
      level: 'warn',
      item: 'learning-auto-capture',
      detail:
        'profile.learning.auto_capture: hook 已声明，但 MVP 未实现 target 侧钩子写入（Spec §12 Phase 3）——当前行为等同 off',
      hint: '需要确定性抓取请暂用 auto_capture: prompt（渲染 ## Learning Protocol 段），或改回 off 消除该告警',
    });
    return;
  }
  const projected = state.effective === 'prompt' ? '（投影正文含 ## Learning Protocol 段）' : '';
  const ciNote = state.ciNoCapture
    ? '；CI 为真 → 本次运行不会写入任何 learnings（§7.4 护栏 3，投影正文不受影响）'
    : '';
  results.push({
    section: 'config',
    level: 'ok',
    item: 'learning-auto-capture',
    detail: `profile.learning.auto_capture: ${state.effective}${projected}${ciNote}`,
  });
}

/**
 * sync-meta 读取（损坏 → error(2)；不存在 → 信息性 ok）。
 *
 * @returns 记录内容；损坏与"尚未 sync"都返回 null——调用方只用它判断有无基准可比，
 * 两种情况都无基准，区别已由 results 里的条目表达（损坏是 error，未 sync 是 ok）。
 */
export async function readSyncMetaForDoctor(
  host: Host,
  results: DoctorCheckResult[],
  roots: DoctorRoots,
  config: EffectiveConfig,
): Promise<SyncMeta | null> {
  const sotRoot =
    config.effectiveScope === 'project' ? roots.projectSoTRoot : roots.userRootForLoad;
  let syncMeta: SyncMeta | null = null;
  let syncMetaReadOk = true;
  try {
    syncMeta = await readSyncMeta(host, sotRoot);
  } catch (err) {
    syncMetaReadOk = false;
    results.push({
      section: 'consistency',
      level: 'error',
      code: toDoctorCode(err),
      item: 'sync-meta',
      detail: errMessage(err),
      hint: errHint(err),
    });
  }
  if (syncMetaReadOk) {
    results.push(
      syncMeta === null
        ? {
            section: 'consistency',
            level: 'ok',
            item: 'sync-meta',
            detail: `尚未 sync（${path.join(sotRoot, SYNC_META_FILE)} 不存在）`,
          }
        : {
            section: 'consistency',
            level: 'ok',
            item: 'sync-meta',
            detail: `${path.join(sotRoot, SYNC_META_FILE)}（lastSyncAt: ${syncMeta.lastSyncAt}）`,
          },
    );
  }
  return syncMeta;
}

/** 现有 merge_json 投影损坏（硬项 error(3)；soft 项 warn，§8.2/§8.6）。 */
export async function checkMergeJson(
  host: Host,
  results: DoctorCheckResult[],
  enabledPlans: readonly EnabledPlan[],
): Promise<void> {
  for (const { projector, plan } of enabledPlans) {
    for (const item of plan.items) {
      if (item.action !== 'merge_json') {
        continue;
      }
      if (!(await host.exists(item.path))) {
        continue;
      }
      try {
        JSON.parse(await host.readFile(item.path));
      } catch (err) {
        const soft = item.soft === true;
        results.push({
          section: 'consistency',
          level: soft ? 'warn' : 'error',
          code: soft ? undefined : ExitCode.Conflict,
          item: `merge-json/${projector.id}`,
          detail: `现有 JSON 投影无法解析（sync 时将拒绝合并）: ${item.path}\n${errMessage(err)}`,
          hint: '手动修复或删除该文件后重新执行 aforge sync（AgentForge 不会覆盖无法解析的内容）',
        });
      }
    }
  }
}
