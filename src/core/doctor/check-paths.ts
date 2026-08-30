/**
 * 投影路径解析检查（Spec §9 第 1 条）与 doctor 侧 plan ctx 构造。
 *
 * 为什么单独成模块：`buildPlanCtx` 是 doctor 里唯一「把 EffectiveConfig 翻译成
 * projector 输入」的地方，其余检查项（投影 hash / merge_json / 目标目录可写性）
 * 都靠它拿 plan。它与 §9 第 1 条的路径枚举共用同一组 projector 语义（同一个
 * ctx 换 scope 跑两遍），放在一起改一处即可保持两侧一致；把它留在编排文件里
 * 会让每个检查项模块都反向依赖 checks.ts 而成环。
 */

import type { EffectiveConfig } from '../config/defaults';
import type { EnvSnapshot, Scope } from '../env';
import type { OsContext } from '../paths';
import { projectorRegistry } from '../project/projectors/registry';
import type { ProjectContext, ProjectionPlan, Projector } from '../project/types';
import type { DoctorCheckResult } from './check-types';

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
 * §9 第 1 条：各 target 解析后的绝对路径（project + user scope）。
 *
 * 恒为 ok 的信息项——用户看的是"到底会写到哪"，不是判定；user 目录不可解析时
 * 只在 detail 里标注，不降级为 warn（该场景另有 projection-root / user-sot-root 条目）。
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
    const projectPaths = projector
      .plan(buildPlanCtx(os, 'project', cwd, rendered ?? '', config, env))
      .items.map((i) => i.path);
    const detailLines = [`project: ${projectPaths.join('; ')}`];
    if (env.userProfile === undefined || env.userProfile === '') {
      detailLines.push('user    : (user dir unresolvable)');
    } else {
      const userPaths = projector
        .plan(buildPlanCtx(os, 'user', env.userProfile, rendered ?? '', config, env))
        .items.map((i) => i.path);
      detailLines.push(`user    : ${userPaths.join('; ')}`);
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
 */
export function collectEnabledPlans(
  ctx: ProjectContext,
  config: EffectiveConfig,
): readonly EnabledPlan[] {
  const enabledTargets = (config.profile.targets as readonly string[]).includes.bind(
    config.profile.targets,
  );
  return projectorRegistry
    .list()
    .filter((p) => enabledTargets(p.id))
    .map((p) => ({ projector: p, plan: p.plan(ctx) }));
}
