/**
 * 投影路径解析检查（Spec §9 第 1 条）与 doctor 侧 plan ctx 构造。
 *
 * 为什么单独成模块：`buildPlanCtx` 是 doctor 里唯一「把 EffectiveConfig 翻译成
 * projector 输入」的地方，其余检查项（投影 hash / merge_json / 目标目录可写性）
 * 都靠它拿 plan。它与 §9 第 1 条的路径枚举共用同一组 projector 语义（同一个
 * ctx 换 scope 跑两遍），放在一起改一处即可保持两侧一致；把它留在编排文件里
 * 会让每个检查项模块都反向依赖 checks.ts 而成环。
 *
 * **plan 失败必须就地降级**（Phase 3 第二层补的护栏）：`projector.plan()` 不再
 * 保证只属于内置四家——声明式适配器（issue #53）的 plan 会在落点越界、scope 未声明
 * 这类情况抛 ConfigError。原先这里裸调 plan，一条异常就会冒到 `runDoctorChecks`
 * 之外，把几十项检查连同整份报告一起带走（PR #59 踩过）。诊断工具在「最需要诊断」
 * 的时刻消失是最坏的失效模式，所以这里对每个 projector 单独 try/catch，把失败报成
 * 一条 error 条目后继续。
 */

import type { EffectiveConfig } from '../config/defaults';
import type { EnvSnapshot, Scope } from '../env';
import type { OsContext } from '../paths';
import { projectorRegistry } from '../project/projectors/registry';
import type { ProjectContext, ProjectionPlan, Projector } from '../project/types';
import { type DoctorCheckResult, errHint, errMessage, toDoctorCode } from './check-types';

/**
 * doctor 内部的 plan ctx 构造（与 engine.syncOnce 的 ctx 同构；dryRun: true 表诊断不写）。
 *
 * markerMode 必须注入：缺失时 ProjectContext 按历史默认
 * `replace_between_markers` 处理，projector 的主规则动作恒为 merge_marker；而
 * 用户配置 `marker_mode: none` 时 sync 实际走整文件 write（types.mainRuleAction），
 * 两侧不一致会让 doctor 的 marker 区间比对（checkProjectionHash）在无 marker 的
 * 投影上误报"marker 被移除"。engine / status / init 三处 plan ctx 均已注入，此处对齐。
 */
export function buildPlanCtx(
  os: OsContext,
  scope: Scope,
  rootDir: string,
  renderedRulesMd: string,
  config: EffectiveConfig,
  env: EnvSnapshot,
): ProjectContext {
  return {
    os,
    scope,
    rootDir,
    renderedRulesMd,
    habits: config.habits,
    profile: config.profile,
    skillsToMaterialize: [],
    // §8.8：doctor 只看主规则/MCP 路径，命令薄壳路径不参与此处比对
    commandsToExpose: [],
    mcpServers: config.profile.mcp.servers ?? [],
    dryRun: true,
    lineEnding: config.profile.projection.line_ending,
    markerBegin: config.profile.projection.marker_begin,
    markerEnd: config.profile.projection.marker_end,
    markerMode: config.profile.projection.marker_mode,
    env,
  };
}

/**
 * 安全地取一个 projector 的 plan：失败 → 记一条 error 条目并返回 undefined。
 *
 * 失败的退出码归属沿用错误自身（`toDoctorCode`：ConfigError→2 / Permission→4 …），
 * 提示沿用 AgentForgeError 的 hint（声明式适配器的错误都带可操作 hint）。
 */
function planSafely(
  results: DoctorCheckResult[],
  projector: Projector,
  ctx: ProjectContext,
  item: string,
): ProjectionPlan | undefined {
  try {
    return projector.plan(ctx);
  } catch (err) {
    results.push({
      section: 'paths',
      level: 'error',
      code: toDoctorCode(err),
      item,
      detail: `${projector.id} 的投影计划无法生成（${ctx.scope} scope）: ${errMessage(err)}`,
      ...(errHint(err) === undefined ? {} : { hint: errHint(err) as string }),
    });
    return undefined;
  }
}

/**
 * §9 第 1 条：各 target 解析后的绝对路径（project + user scope）。
 *
 * 正常路径恒为 ok 的信息项——用户看的是"到底会写到哪"，不是判定；user 目录不可解析时
 * 只在 detail 里标注，不降级为 warn（该场景另有 projection-root / user-sot-root 条目）。
 * plan 抛错的 target 单独报一条 error，其余 target 照常列出（见文件头）。
 */
export function checkTargetPaths(
  results: DoctorCheckResult[],
  os: OsContext,
  cwd: string,
  rendered: string | undefined,
  config: EffectiveConfig,
  env: EnvSnapshot,
): void {
  for (const projector of projectorRegistry.list()) {
    const detailLines: string[] = [];
    const projectPlan = planSafely(
      results,
      projector,
      buildPlanCtx(os, 'project', cwd, rendered ?? '', config, env),
      `path/${projector.id}`,
    );
    if (projectPlan === undefined) {
      continue;
    }
    detailLines.push(`project: ${projectPlan.items.map((i) => i.path).join('; ')}`);

    if (env.userProfile === undefined || env.userProfile === '') {
      detailLines.push('user    : (user dir unresolvable)');
    } else {
      const userPlan = planSafely(
        results,
        projector,
        buildPlanCtx(os, 'user', env.userProfile, rendered ?? '', config, env),
        `path/${projector.id}`,
      );
      if (userPlan === undefined) {
        continue;
      }
      detailLines.push(`user    : ${userPlan.items.map((i) => i.path).join('; ')}`);
    }

    results.push({
      section: 'paths',
      level: 'ok',
      item: `path/${projector.id}`,
      detail: detailLines.join('\n'),
    });
  }
}

/** 有效 scope 下启用 target 的投影计划（projector 与其 plan 成对，供多个检查项共用）。 */
export interface EnabledPlan {
  readonly projector: Projector;
  readonly plan: ProjectionPlan;
}

/**
 * 有效 scope 启用 target 的投影计划（merge_json 检查与目标目录可写性共用）。
 *
 * 只 plan 一次再分发给两个检查项：plan 是纯函数但不便宜（渲染字符串拼装），
 * 且两侧必须看到同一份 items 才能保证"报了损坏的文件"和"探测的目录"一致。
 *
 * plan 抛错的 target 记一条 error 后被剔除（见文件头）——后续两个检查项只对
 * 能产出计划的 target 生效，不因某个第三方适配器坏掉而整块跳过。
 */
export function collectEnabledPlans(
  ctx: ProjectContext,
  config: EffectiveConfig,
  results: DoctorCheckResult[],
): readonly EnabledPlan[] {
  const enabledTargets = (config.profile.targets as readonly string[]).includes.bind(
    config.profile.targets,
  );
  const plans: EnabledPlan[] = [];
  for (const projector of projectorRegistry.list()) {
    if (!enabledTargets(projector.id)) {
      continue;
    }
    const plan = planSafely(results, projector, ctx, `plan/${projector.id}`);
    if (plan !== undefined) {
      plans.push({ projector, plan });
    }
  }
  return plans;
}
