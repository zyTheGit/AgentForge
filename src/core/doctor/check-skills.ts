/**
 * `profile.skills.*` 的「声明 vs 实际」诊断（Spec §4.2 / §9）。
 *
 * 从 check-consistency 拆出来的理由：那个模块里的检查共享「这次 sync 会不会失败、
 * 上次 sync 留下的基准是什么」这个前提，本模块回答的是另一类问题——**声明了但
 * 实际不生效**（on_demand 名字没装 / 按需标记注不进去 / copy_mode: symlink 恒被
 * 忽略）。两类的退出码影响也不同：这里几乎全是 warn（不参与 §6.1 的码计算），
 * 投影结果本身自洽，只是与声明有落差。
 */
import type { Host } from '../../infra/host';
import type { EffectiveConfig } from '../config/defaults';
import {
  injectOnDemandMarker,
  isOnDemandEffective,
  ON_DEMAND_FRONTMATTER_KEY,
  skillDocCandidates,
} from '../sources/skill';
import type { DoctorRoots } from './check-config';
import { type DoctorCheckResult, errHint, errMessage, toDoctorCode } from './check-types';

/** 候选路径里第一个存在的文件（全都不存在 → undefined）。 */
async function firstExisting(
  host: Host,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const file of candidates) {
    if (await host.exists(file)) {
      return file;
    }
  }
  return undefined;
}

/**
 * 单个 `on_demand` 名字的诊断（**逐项失败不中断**：读文件的异常也收成一条结果）。
 *
 * @returns 该名字的按需语义生效 → true（调用方并进 effective 列表）。
 */
async function checkOneOnDemandSkill(
  host: Host,
  results: DoctorCheckResult[],
  roots: DoctorRoots,
  name: string,
): Promise<boolean> {
  const item = `skills-on-demand/${name}`;
  const candidates = skillDocCandidates(roots.userRootForLoad, roots.projectSoTRoot, name);
  const found = await firstExisting(host, candidates);
  if (found === undefined) {
    results.push({
      section: 'config',
      level: 'warn',
      item,
      detail: `skills.on_demand 声明的 skill 未安装: ${name}（查找 ${candidates.join(' / ')}）——本轮 sync 跳过它，不投影`,
      hint: '运行 aforge skill add <name> --no-register 安装（on_demand 不需要登记进 always），或从 profile.yaml 的 skills.on_demand 中移除该名字',
    });
    return false;
  }

  // doctor 的契约是「逐项收集、单项失败不中断」：SKILL.md 权限不可读 / 被换成目录 /
  // UNC 断链都会让裸 readFile 抛出，而 runConfigDependentChecks 没有 try —— 那会
  // 让整份诊断报告丢失、退出码退化成 GenericError(1)。口径同 checkTemplates
  let content: string;
  try {
    content = await host.readFile(found);
  } catch (err) {
    results.push({
      section: 'config',
      level: 'error',
      code: toDoctorCode(err),
      item,
      detail: `无法读取 ${found}: ${errMessage(err)}`,
      hint:
        errHint(err) ?? '确认该路径是可读的普通文件（不是目录 / 断链的 symlink），或修正其权限位',
    });
    return false;
  }

  // 与 sync 走同一个判定函数（skill-materialize.injectOnDemandMarker），否则 doctor
  // 会说「按需已生效」而 sync 实际记了一条 skip
  const status = injectOnDemandMarker(content).status;
  if (isOnDemandEffective(status)) {
    return true;
  }
  if (status === 'declared-false') {
    results.push({
      section: 'config',
      level: 'warn',
      item,
      detail: `${found} 的 frontmatter 显式声明了非 true 的 ${ON_DEMAND_FRONTMATTER_KEY}：尊重该取值不覆盖，因此四家一律**不**启用按需语义（codex 也不写 sidecar），该技能仍进模型的自动路由清单`,
      hint: `把 ${found} 里的 ${ON_DEMAND_FRONTMATTER_KEY} 改成 true 或整行删掉（删掉时由 sync 自动注入），或从 profile.yaml 的 skills.on_demand 中移除该名字`,
    });
    return false;
  }
  const why =
    status === 'no-frontmatter'
      ? `没有 frontmatter（首行不是 --- 或缺结束 fence）`
      : `frontmatter 区间不是合法的 YAML 顶层映射`;
  results.push({
    section: 'config',
    level: 'warn',
    item,
    detail: `${found} ${why}，无处注入 ${ON_DEMAND_FRONTMATTER_KEY}：正文照常投影，但 claude / pi 侧按需语义不生效（codex 的 sidecar 与 frontmatter 无关，仍会写）`,
    hint: `给该 SKILL.md 补上 --- 包裹的合法 frontmatter（至少 name 与 description）`,
  });
  return false;
}

/**
 * `profile.skills.on_demand`：按需装载的名单状态与各 target 的支持差异（Phase 2）。
 *
 * 语义提醒：`on_demand` 的技能**正文照常投影**，区别只在产物 frontmatter 多一行
 * `disable-model-invocation: true`（claude / pi 据此不把它放进模型的自动路由清单，
 * 仍可 `/name` 显式调用）；codex 走 sidecar `agents\openai.yaml`。落点：
 *
 * - 名字未安装 → warn（**不是** error）：`on_demand` 是「备货清单」，允许先写名字
 *   再逐个 `aforge skill add`。sync 也只是跳过并记一条 skillSkips，不失败——两处
 *   口径必须一致，否则用户会看到 doctor 说没事而 sync 报错（或反过来）；
 * - `SKILL.md` 读不出来 → error（带 errno 映射的退出码），但**不中断**其余检查；
 * - 无 frontmatter / frontmatter 不是合法 YAML 顶层映射 → warn：注入被拒绝，正文
 *   照常投影（注入永远不在「没解析成功」的前提下改写用户文件）；
 * - SoT 显式写了非 `true` 的取值 → warn：尊重该取值，四家一律不启用按需语义；
 * - 启用了 opencode 且确有生效的 on_demand 技能 → warn：opencode 对未知
 *   frontmatter 键的处理未实机验证（降级提示，不静默）；
 * - 其余情况 → ok（列出生效的名字）。
 *
 * 「同名同时出现在 always 与 on_demand」不在此处判：schema 的 superRefine 已让这种
 * profile 在装配阶段就以 ConfigError(2) 失败，doctor 走不到这里。
 *
 * warn 都不影响退出码：投影结果本身是自洽的，只是与「按需」的期望有差距。
 */
export async function checkSkillsOnDemand(
  host: Host,
  results: DoctorCheckResult[],
  roots: DoctorRoots,
  config: EffectiveConfig,
): Promise<void> {
  const onDemand = config.profile.skills.on_demand ?? [];
  if (onDemand.length === 0) {
    results.push({
      section: 'config',
      level: 'ok',
      item: 'skills-on-demand',
      detail: 'profile.skills.on_demand 未声明',
    });
    return;
  }

  const effective: string[] = [];
  for (const name of onDemand) {
    if (await checkOneOnDemandSkill(host, results, roots, name)) {
      effective.push(name);
    }
  }

  if (effective.length === 0) {
    return;
  }
  results.push({
    section: 'config',
    level: 'ok',
    item: 'skills-on-demand',
    detail: `${effective.join(', ')}（投影正文 + ${ON_DEMAND_FRONTMATTER_KEY}: true，不进模型自动路由清单）`,
  });
  if (config.profile.targets.includes('opencode')) {
    results.push({
      section: 'config',
      level: 'warn',
      item: 'skills-on-demand/opencode-unsupported',
      detail: `opencode 的公开文档只列 name / description / license / compatibility / metadata，它对 ${ON_DEMAND_FRONTMATTER_KEY} 的处理**未实机验证**：若忽略未知键，则 ${effective.join(', ')} 在 opencode 里仍会进模型的技能清单；若它做严格校验，注入可能让该技能在 opencode 侧加载失败`,
      hint: '在 opencode 侧确认技能仍可用；需要挡住自动调用，在 opencode.json 里配 permission.skill.<name>: "ask" 或 "deny"',
    });
  }
}

/**
 * profile.skills.copy_mode：`symlink` 恒被忽略且**不计划实现**（Spec §4.2）。
 *
 * 为什么是 warn 而不是让 schema 拒绝：`CopyMode` enum 从 M1 起就收 `symlink`，
 * 改成拒绝会让既有写了该值的 profile 直接加载失败（ConfigError(2)），是破坏性变更。
 * 但静默接受同样不行——用户以为配了就生效，实际 `skill add` 与四个 projector 恒做
 * 实体 copy。折中：照旧接受，由 doctor 明说"声明了但不生效、且不会生效"。
 *
 * 恒不影响退出码（warn 不参与 §6.1 的码计算），因为投影结果本身是正确的，
 * 只是与声明不符；与 skills-on-demand 同属"声明 vs 实际"的信息类落点。注意两者的
 * 后续走向不同：on_demand 已在 Phase 2 落地（投影正文 + 按需标记，见
 * checkSkillsOnDemand），copy_mode: symlink 已明确不做（理由见 §4.2：与 §7.6 prune
 * 判据冲突、Windows 默认无创建权限、四家读取行为未实测）。
 */
export function checkSkillsCopyMode(results: DoctorCheckResult[], config: EffectiveConfig): void {
  const copyMode = config.profile.skills.copy_mode;
  if (copyMode === 'symlink') {
    results.push({
      section: 'config',
      level: 'warn',
      item: 'skills-copy-mode',
      detail:
        'profile.skills.copy_mode: symlink 已声明，但该取值恒被忽略、投影恒为实体 copy（Spec §4.2：已决定不实现）——当前投影行为不受影响',
      hint: '改为 skills.copy_mode: copy 可消除该告警；symlink 不在任何 Phase 的计划内',
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
