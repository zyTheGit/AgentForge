/**
 * 一致性检查（Spec §9 第 5/8 条与 sync-meta / 渲染 / 命令暴露信息项）。
 *
 * 为什么单独成模块：这几项共享同一个前提——EffectiveConfig 已装配成功——且都在回答
 * 「这次 sync 会不会失败、上次 sync 留下的基准是什么」。渲染基准（renderForDoctor）
 * 必须与 sync 共用 sync-prepare.renderRulesMd 这一单一事实源（直接指实现模块，不经
 * engine 门面——那会把整个 sync 引擎图拖进 doctor），放在同一文件里让"doctor 不
 * 得自己拼渲染"这条约束有个明确落点；marker 区间三方比对因判定表独立，另置
 * check-projection-hash；`profile.skills.*` 的「声明 vs 实际」另置 check-skills。
 */
import path from 'node:path';
import type { Host } from '../../infra/host';
import type { SyncMeta } from '../../schema';
import type { EffectiveConfig } from '../config/defaults';
import type { EnvSnapshot } from '../env';
import { ExitCode } from '../errors';
import { resolveTemplate } from '../generate/resolver';
import {
  effectiveAutoCapture,
  LEARNING_PROTOCOL_HEADING,
  rendersLearningProtocol,
  resolveAutoCapture,
  writesSessionHooks,
} from '../learning/auto-capture';
import { SESSION_HOOK_EVENT } from '../learning/hook-capture';
import type { OsContext } from '../paths';
import {
  CODEX_PROJECT_COMMANDS_SKIP_REASON,
  commandCanonicalName,
  flattenCommandName,
  parseCommandEntry,
} from '../project/commands';
import {
  codexConfigPath,
  codexHooksPath,
  codexTomlHasInlineHooks,
} from '../project/projectors/codex';
import { projectorRegistry } from '../project/projectors/registry';
import { readSyncMeta, SYNC_META_FILE } from '../project/sync-meta';
import {
  hookCapableTargetIds,
  partitionSessionHookTargets,
  SESSION_HOOK_NOTICE_ITEM,
} from '../project/sync-notices';
import { renderRulesMd } from '../project/sync-prepare';
import type { ProjectContext } from '../project/types';
import type { DoctorRoots } from './check-config';
import type { EnabledPlan } from './check-paths';
import { type DoctorCheckResult, errHint, errMessage, toDoctorCode } from './check-types';

/** hook 档下 codex 同层并存两种钩子表示时的 doctor item（与 sync 侧那条同前缀）。 */
export const SESSION_HOOK_INLINE_ITEM = 'learning-auto-capture-hook-inline';

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
 * profile.learning.auto_capture：声明档位与各 target 的实际落点（Spec §7.4 / §9）。
 *
 * 四件事都必须说出来，口径同 skills-copy-mode：
 * - 三档现在都各自生效（`hook` 已在 §12 Phase 3 落地 target 侧钩子写入），因此不再有
 *   「声明了 hook 等同 off」这条整体性 warn；
 * - `hook` 档下**没有钩子落点的已启用 target** → 单独一条 warn（`learning-auto-capture-hook`），
 *   如实列出哪几家等同 off。判据取自各 projector 的 `writesSessionHooks` 能力声明，
 *   **不做环境探测**（本机装没装某个 CLI 不影响结论，钩子写入是声明驱动的）；
 * - `CI` 为真：learnings 恒不落盘（§7.4 护栏 3 / §10）→ **不是错误**，补一句原因。注意这
 *   只影响*写入*，投影正文不变（`prompt` 档在 CI 下照样渲染），这样 contentHash 才跨环境稳定；
 * - `prompt` + `auto_promote: true`：agent 会话中途的 `learn` 会连带 promote，而 promote 取的
 *   是与 `sync` 同一把 `.sync.lock` → 与人工 `sync` 并发即 ConflictError(3)。单独报一条 warn
 *   而不是在协议正文里写死 `--no-auto-promote`：那会静默覆盖用户显式配置，违反护栏 2
 *   「auto_capture 不改变 auto_promote」的正交性。
 *   `hook` 档不需要同款 warn：钩子执行的是只读命令（`aforge learn --print-protocol`），
 *   既不写 SoT 也不取 `.sync.lock`（见 learning/hook-capture.ts）。
 *
 * 本函数只看声明（纯函数、不碰 IO）。需要读目标文件才能判定的那条 —— hook 档下
 * codex 同层并存 inline `[hooks]` —— 在 `checkCodexInlineHooks`（同文件，做 IO）。
 *
 * 恒不影响退出码：投影结果本身是自洽的，只是与声明不符。
 */
export function checkLearningAutoCapture(
  results: DoctorCheckResult[],
  config: EffectiveConfig,
  env: EnvSnapshot,
): void {
  const state = resolveAutoCapture(config.profile, env);
  // CI 说明与档位判定正交：各档位都要带上，否则同一状态下 doctor 少一句而 status 有，
  // 两处口径分叉
  const ciNote = state.ciNoCapture
    ? '；CI 为真 → 本次运行不会写入任何 learnings（§7.4 护栏 3，投影正文不受影响）'
    : '';
  const hooks = partitionSessionHookTargets(
    writesSessionHooks(state.effective),
    // 只看**注册表命中**的 target（口径同 sync 的 engine：传的是已过 filterTargets 的
    // planned 名单）。profile.targets 里写了注册表没有的名字时那个 target 根本不会被
    // 投影，替它报「没有钩子落点」是错的——它连产物都没有
    registeredTargetIds(config),
    projectorRegistry.list(),
  );
  const projected = rendersLearningProtocol(state.effective)
    ? `（投影正文含 ${LEARNING_PROTOCOL_HEADING} 段）`
    : '';
  const hooked =
    hooks.capable.length > 0
      ? `（${SESSION_HOOK_EVENT} 钩子写入 ${hooks.capable.join(' / ')}）`
      : '';
  results.push({
    section: 'config',
    level: 'ok',
    item: 'learning-auto-capture',
    detail: `profile.learning.auto_capture: ${state.effective}${projected}${hooked}${ciNote}`,
  });
  if (hooks.incapable.length > 0) {
    results.push({
      section: 'config',
      level: 'warn',
      item: SESSION_HOOK_NOTICE_ITEM,
      detail: `auto_capture: hook 对以下已启用 target 等同 off（没有可声明式写入的会话钩子落点）：${hooks.incapable.join(' / ')}${
        hooks.capable.length === 0 ? '——本次没有任何 target 会装上钩子' : ''
      }`,
      hint:
        hooks.capable.length === 0
          ? `需要确定性投递协议请改用 auto_capture: prompt（渲染 ${LEARNING_PROTOCOL_HEADING} 段），或启用支持钩子的 target（${hookCapableTargetIds(projectorRegistry.list()).join(' / ')}）`
          : '这些 target 的其余产物照常投影；要让它们也拿到学习协议请改用 auto_capture: prompt',
    });
  }
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

/** profile.targets 里注册表命中的那批（未命中的不会被投影，谈其能力无意义）。 */
function registeredTargetIds(config: EffectiveConfig): string[] {
  return config.profile.targets.filter((id) => projectorRegistry.get(id) !== undefined);
}

/**
 * hook 档下 codex 同层并存 `hooks.json` 与 inline `[hooks]` → warn（§7.4 / §9）。
 *
 * 为什么必须由 doctor 出这条、而不是 sync 侧拒绝写入：codex 在同一 config 层同时
 * 发现两种钩子表示时**每次启动都告警**（上游："Prefer one representation per layer"），
 * 而 AgentForge 投出 `hooks.json` 正是那个告警的直接成因——只写在 docs 里等于让读不到
 * 文档的用户长期对着一个自己找不到源头的告警。反过来，让 sync 去看目标文件内容会破坏
 * `Projector.plan` 的纯函数契约（plan 不做 IO，§8.4），所以这条只能落在本来就做 IO 的
 * doctor 侧，且只报不拦。
 *
 * 恒 warn 不影响退出码：钩子仍然生效，只是多一条上游告警。
 */
export async function checkCodexInlineHooks(
  host: Host,
  results: DoctorCheckResult[],
  ctx: ProjectContext,
  config: EffectiveConfig,
): Promise<void> {
  if (!writesSessionHooks(effectiveAutoCapture(config.profile))) {
    return;
  }
  if (!registeredTargetIds(config).includes('codex')) {
    return;
  }
  const configPath = codexConfigPath(ctx);
  if (!(await host.exists(configPath))) {
    return;
  }
  let toml: string;
  try {
    toml = await host.readFile(configPath);
  } catch {
    return; // 读不出（权限）：可写性 / merge_toml 的检查项会另行报，这里不重复
  }
  if (!codexTomlHasInlineHooks(toml)) {
    return;
  }
  results.push({
    section: 'config',
    level: 'warn',
    item: SESSION_HOOK_INLINE_ITEM,
    detail: `${configPath} 里有 inline [hooks] 段，而 auto_capture: hook 会在同一层投出 ${codexHooksPath(ctx)}：codex 在同一 config 层同时发现两种钩子表示时每次启动都会告警`,
    hint: '把 config.toml 里的 [hooks] 段挪走（或合并进你自己的另一层配置）；hooks.json 由 AgentForge 独占管理，auto_capture 改回 off / prompt 后会被 aforge sync 整文件清理',
  });
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
