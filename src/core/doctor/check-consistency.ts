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
import {
  LEARNING_PROTOCOL_HEADING,
  rendersLearningProtocol,
  resolveAutoCapture,
} from '../learning/auto-capture';
import type { OsContext } from '../paths';
import {
  CODEX_PROJECT_COMMANDS_SKIP_REASON,
  commandCanonicalName,
  flattenCommandName,
  frontmatterRange,
  parseCommandEntry,
} from '../project/commands';
import { readSyncMeta, SYNC_META_FILE } from '../project/sync-meta';
import { renderRulesMd } from '../project/sync-prepare';
import { ON_DEMAND_FRONTMATTER_KEY, skillDocCandidates } from '../sources/skill';
import type { DoctorRoots } from './check-config';
import type { EnabledPlan } from './check-paths';
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
 * 当前 SoT 渲染（hash 基准；与 sync 共用 sync-prepare.renderRulesMd）。失败 → error 并返回 undefined。
 *
 * 不传 EnvSnapshot：渲染正文与环境无关（`learning.auto_capture` 只经
 * effectiveAutoCapture），CI 与本地渲染同一份 SoT 得到同一个 contentHash。
 *
 * @param os 必须与 sync 取同一个平台值：`projection.path_style: auto` 下 composer 会按它
 *   改写路径 token，两侧不一致会把平台差异误报成投影漂移。
 */
export async function renderForDoctor(
  host: Host,
  results: DoctorCheckResult[],
  roots: DoctorRoots,
  config: EffectiveConfig,
  os: OsContext,
): Promise<string | undefined> {
  try {
    return await renderRulesMd(
      host,
      roots.userRootForLoad,
      roots.projectSoTRoot,
      config.habits,
      config.profile,
      os,
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

/**
 * `profile.skills.on_demand`：按需装载的名单状态与各 target 的支持差异（Phase 2）。
 *
 * 语义提醒：`on_demand` 的技能**正文照常投影**，区别只在产物 frontmatter 多一行
 * `disable-model-invocation: true`（claude / pi 据此不把它放进模型的自动路由清单，
 * 仍可 `/name` 显式调用）；codex 走 sidecar `agents\openai.yaml`。四条落点：
 *
 * - 名字未安装 → warn（**不是** error）：`on_demand` 是「备货清单」，允许先写名字
 *   再逐个 `aforge skill add`。sync 也只是跳过并记一条 skillSkips，不失败——两处
 *   口径必须一致，否则用户会看到 doctor 说没事而 sync 报错（或反过来）；
 * - 同名也在 `skills.always` 里 → warn：按 always 投影，按需标记不生效；
 * - 启用了 opencode 且确有可投影的 on_demand 技能 → warn：opencode 只认
 *   `name` / `description` / `license` / `compatibility` / `metadata`，未知 frontmatter
 *   键一律忽略，该技能在 opencode 里**仍会**进模型清单（降级提示，不静默）；
 * - 其余情况 → ok（列出生效的名字）。
 *
 * 全部 warn 都不影响退出码：投影结果本身是自洽的，只是与「按需」的期望有差距。
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

  const always = new Set(config.profile.skills.always ?? []);
  const effective: string[] = [];
  for (const name of onDemand) {
    if (always.has(name)) {
      results.push({
        section: 'config',
        level: 'warn',
        item: `skills-on-demand/${name}`,
        detail: `${name} 同时出现在 skills.always 与 skills.on_demand 中：按 always 投影，不注入 ${ON_DEMAND_FRONTMATTER_KEY}（仍会进模型的自动路由清单）`,
        hint: '从 skills.always 中摘掉该名字（aforge skill remove）才能让按需装载生效',
      });
      continue;
    }
    const candidates = skillDocCandidates(roots.userRootForLoad, roots.projectSoTRoot, name);
    const found = await firstExisting(host, candidates);
    if (found === undefined) {
      results.push({
        section: 'config',
        level: 'warn',
        item: `skills-on-demand/${name}`,
        detail: `skills.on_demand 声明的 skill 未安装: ${name}（查找 ${candidates.join(' / ')}）——本轮 sync 跳过它，不投影`,
        hint: '运行 aforge skill add <name> --no-register 安装（on_demand 不需要登记进 always），或从 profile.yaml 的 skills.on_demand 中移除该名字',
      });
      continue;
    }
    if (frontmatterRange(await host.readFile(found)) === null) {
      results.push({
        section: 'config',
        level: 'warn',
        item: `skills-on-demand/${name}`,
        detail: `${found} 没有 frontmatter，无处注入 ${ON_DEMAND_FRONTMATTER_KEY}：正文照常投影，但按需语义不生效（四家客户端也都要求 name/description 必填）`,
        hint: `给该 SKILL.md 补上 --- 包裹的 frontmatter（至少 name 与 description）`,
      });
      continue;
    }
    effective.push(name);
  }

  if (effective.length > 0) {
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
        detail: `opencode 只识别 name / description / license / compatibility / metadata，忽略 ${ON_DEMAND_FRONTMATTER_KEY}：${effective.join(', ')} 在 opencode 里仍会进模型的技能清单（正文仍是按需读取，上下文开销只有一行 description）`,
        hint: '需要在 opencode 侧也挡住自动调用，在 opencode.json 里配 permission.skill.<name>: "ask" 或 "deny"',
      });
    }
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

/**
 * profile.learning.auto_capture：声明档位 vs 实际生效档位（Spec §7.4 / §9）。
 *
 * 三件事都必须说出来，口径同 skills-copy-mode：
 * - `hook`：MVP 没有任何 target 侧钩子写入（§12 Phase 3）→ warn，行为等同 off；
 * - `CI` 为真：learnings 恒不落盘（§7.4 护栏 3 / §10）→ **不是错误**，补一句原因。注意这
 *   只影响*写入*，投影正文不变（`prompt` 档在 CI 下照样渲染），这样 contentHash 才跨环境稳定；
 * - `prompt` + `auto_promote: true`：agent 会话中途的 `learn` 会连带 promote，而 promote 取的
 *   是与 `sync` 同一把 `.sync.lock` → 与人工 `sync` 并发即 ConflictError(3)。单独报一条 warn
 *   而不是在协议正文里写死 `--no-auto-promote`：那会静默覆盖用户显式配置，违反护栏 2
 *   「auto_capture 不改变 auto_promote」的正交性。
 *
 * 恒不影响退出码：投影结果本身是自洽的，只是与声明不符。
 */
export function checkLearningAutoCapture(
  results: DoctorCheckResult[],
  config: EffectiveConfig,
  env: EnvSnapshot,
): void {
  const state = resolveAutoCapture(config.profile, env);
  // CI 说明与档位判定正交：hook（warn）与其余档位（ok）都要带上，否则同一状态下
  // doctor 少一句而 status 有，两处口径分叉
  const ciNote = state.ciNoCapture
    ? '；CI 为真 → 本次运行不会写入任何 learnings（§7.4 护栏 3，投影正文不受影响）'
    : '';
  if (state.unimplemented) {
    results.push({
      section: 'config',
      level: 'warn',
      item: 'learning-auto-capture',
      detail: `profile.learning.auto_capture: hook 已声明，但 MVP 未实现 target 侧钩子写入（Spec §12 Phase 3）——当前行为等同 off${ciNote}`,
      hint: '需要确定性抓取请暂用 auto_capture: prompt（渲染 ## Learning Protocol 段），或改回 off 消除该告警',
    });
    return;
  }
  const projected = rendersLearningProtocol(state.effective)
    ? `（投影正文含 ${LEARNING_PROTOCOL_HEADING} 段）`
    : '';
  results.push({
    section: 'config',
    level: 'ok',
    item: 'learning-auto-capture',
    detail: `profile.learning.auto_capture: ${state.effective}${projected}${ciNote}`,
  });
  if (rendersLearningProtocol(state.effective) && config.profile.learning.auto_promote) {
    results.push({
      section: 'config',
      level: 'warn',
      item: 'learning-auto-capture-lock',
      detail:
        'auto_capture: prompt 与 auto_promote: true 并存：agent 照协议执行的 aforge learn 会连带 promote，而 promote 取的是与 sync 同一把 .sync.lock，与人工 aforge sync 并发时报 ConflictError(3)',
      hint: '让 agent 改用 aforge learn --no-auto-promote，或把 learning.auto_promote 置回 false（晋升仍可人工 aforge promote）',
    });
  }
}

/**
 * profile.skills.expose_as_command：名单合法性 + codex project scope 不支持（§8.8）。
 *
 * 两件事一次说完：
 * - **名单必须是 `skills.always` 的子集** → 否则 sync 会以 ConfigError(2) 失败，
 *   doctor 提前以 error(2) 报出（口径同 template 未解析：能预判的 sync 失败就预判）。
 *   注意这里比对的是静态的 `skills.always`，而 sync 比对的是实际可物化的技能——
 *   名字在 `always` 里但技能没装时 doctor 这项过、sync 仍会失败，那种情况由
 *   skills 物化自身的报错负责，不在此处重复判定；
 * - **codex + project scope → warn**：§8.8.5 实测 codex 只读 `$CODEX_HOME\prompts\`，
 *   项目级放进去 `/name` 不展开，因此该 target 整项跳过（不写用户目录——那会把
 *   项目级配置泄漏成全局配置）。codex 侧用 `$<skill-name>` 直接调技能即可。
 */
export function checkCommandsExposure(results: DoctorCheckResult[], config: EffectiveConfig): void {
  const exposed = config.profile.skills.expose_as_command ?? [];
  if (exposed.length === 0) {
    results.push({
      section: 'config',
      level: 'ok',
      item: 'skills-expose-as-command',
      detail: 'profile.skills.expose_as_command 未声明（不产出命令/prompt 薄壳）',
    });
    return;
  }

  const always = config.profile.skills.always ?? [];
  let parsed: { namespace: string[]; name: string }[];
  try {
    parsed = exposed.map((entry) => parseCommandEntry(entry));
  } catch (err) {
    // 条目形态非法（空段 / .. / 非法字符）：sync 会以退出码 2 失败，doctor 先把原因说清
    results.push({
      section: 'config',
      level: 'error',
      code: ExitCode.Config,
      item: 'skills-expose-as-command',
      detail: `${err instanceof Error ? err.message : String(err)}（sync 将以退出码 2 失败）`,
      hint: '写法为 <技能名> 或 <命名空间>/<技能名>（可多级）',
    });
    return;
  }

  const missing = parsed.map((item) => item.name).filter((name) => !always.includes(name));
  if (missing.length > 0) {
    results.push({
      section: 'config',
      level: 'error',
      code: ExitCode.Config,
      item: 'skills-expose-as-command',
      detail: `expose_as_command 点名的 skill 不在 skills.always 中: ${missing.join(', ')}（sync 将以退出码 2 失败）`,
      hint: '把这些名字加进 skills.always（或用 aforge skill add 安装），或从 expose_as_command 中移除；命名空间前缀不参与该匹配',
    });
  } else {
    results.push({
      section: 'config',
      level: 'ok',
      item: 'skills-expose-as-command',
      detail: `${exposed.join(', ')}（额外投影为命令/prompt 薄壳）`,
    });
  }

  // §8.8.2：pi / codex 的命令目录平铺，命名空间只能拼进文件名——名字与 claude /
  // opencode 侧不同，不提醒的话用户在 pi 里按 /ns/name 找不到命令
  const namespaced = parsed.filter((item) => item.namespace.length > 0);
  const flatTargets = config.profile.targets.filter(
    (target) => target === 'pi' || target === 'codex',
  );
  if (namespaced.length > 0 && flatTargets.length > 0) {
    results.push({
      section: 'config',
      level: 'warn',
      item: 'commands/namespace-flattened',
      detail: `${flatTargets.join(' / ')} 的命令目录平铺，带命名空间的命令会改名: ${namespaced
        .map((item) => `${commandCanonicalName(item)} → ${flattenCommandName(item)}`)
        .join('、')}`,
      hint: 'claude / opencode 侧仍按命名空间调用（/ns:name、/ns/name）；平铺 target 用拼接后的名字调用',
    });
  }

  if (config.effectiveScope === 'project' && config.profile.targets.includes('codex')) {
    results.push({
      section: 'config',
      level: 'warn',
      item: 'commands/codex-project-unsupported',
      detail: CODEX_PROJECT_COMMANDS_SKIP_REASON,
      hint: 'codex 侧直接用 $<skill-name> 调用技能；需要命令文件请在 user scope（AGF_HOME 层）声明 expose_as_command',
    });
  }
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
