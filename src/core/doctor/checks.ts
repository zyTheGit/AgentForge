/**
 * Doctor 检查引擎（Spec §9，M7）：一致性与环境诊断，产出结构化结果数组。
 *
 * 检查清单（§9 + M7 任务补充）：
 * 1. 各 target 解析后的绝对路径（project + user 两个 scope，§2.2）；
 * 2. SoT / 目标目录可写性（不可写 → error(4)，最终退出码 4）；
 * 3. 当前 SoT 渲染 contentHash 与投影文件 marker 区间 hash（不一致 → warn
 *    "投影可能过期或被修改"；区间与上次 sync 记录不一致时提示被手动修改）；
 * 4. 坏 YAML（habits / profile 任一层解析失败 → error(2)）；
 * 5. 未解析的 template id（error(2)——sync 将失败）；
 * 6. OneDrive 检测（§2.1.1 → warn）；
 * 7. 声明值与 detected 不一致（§4.1：声明优先，仅提示 → warn）；
 * 8. 现有 merge_json 投影损坏（硬项 error(3)，soft 项 warn——§8.2/§8.6）；
 * 9. profile.skills.on_demand 清单（信息项：MVP 只登记不物化，§4.2 注记）；
 * 10. pi 的 MCP 历史落点残留（`.pi\settings.json` 含 `mcpServers` → warn，只诊断不删）；
 * 11. profile.skills.copy_mode 声明 `symlink`（恒被忽略且不计划实现 → warn，§4.2）；
 * 12. profile.learning.auto_capture：三档如实报 ok；`hook` 档下没有会话钩子落点的
 *     已启用 target → warn（对它们等同 off，§7.4 / §12 Phase 3）；CI 为真时补一句
 *     "本次不会写入 learnings"（§7.4 护栏 3 / §10；投影正文不受 CI 影响）；
 *     `prompt` 与 `auto_promote: true` 并存 → warn（会与人工 sync 争 `.sync.lock`）；
 *     `hook` 档 + codex 的 config.toml 里另有 inline `[hooks]` → warn（同层两种钩子
 *     表示会让 codex 每次启动告警，`checkCodexInlineHooks`，只报不拦）；
 * 13. profile.skills.expose_as_command：名单不是 `skills.always` 子集 → error(2)（sync 将失败）；
 *     project scope 且启用 codex → warn（codex 只读 `$CODEX_HOME\prompts\`，该项跳过，§8.8）；
 * 14. MCP transport × target 能力落差（Phase 2 MCP 对齐）：某家上游表达不了某种
 *     transport 时报 warn（codex 不支持 sse → 跳过；opencode 的 remote 无法区分 sse
 *     → 按 streamable HTTP 连接）；
 * 15. 默认注册源（官方模板源）：登记 / 启用 / 缓存 / pin 状态（只读 fs、零网络，恒 ok|warn）。
 *
 * 设计原则：
 * - 单项失败不中断整体：逐项收集（区分于 sync 的 fail-fast），一次运行报告全部问题；
 * - 无持久副作用：除目录可写性探针（mkdirp + 临时文件 + 删除，§7.3-7 语义）
 *   外不写任何文件——探针创建的空目录与 sync 行为一致，无害；
 * - 与 sync 共用 `sync-prepare.renderRulesMd`（不经 engine 门面）；
 * - 聚合退出码见 doctorExitCode（Permission 4 > Conflict 3 > 其他 error；仅 warn → 0）。
 *
 * 模块划分（本文件只留 runDoctorChecks 的检查项编排，各检查项实现在同目录）：
 * - `check-types`：对外数据契约（DoctorCheckResult / DoctorReport）与退出码归属；
 * - `check-config`：SoT 根解析 / 初始化 / 坏 YAML / 三层配置装配（后续检查的前置）；
 * - `check-paths`：doctor 侧 plan ctx 构造、§9 第 1 条路径枚举、启用 target 的投影计划；
 * - `check-writable`：SoT 根与目标目录可写性探针（唯一有写副作用的检查）；
 * - `check-residuals`：事务残留（锁 / journal / 回滚失败备份）的级别与提示取舍；
 * - `check-consistency`：渲染基准 / 模板解析 / on_demand / copy_mode / sync-meta / merge_json；
 * - `check-mcp-transport`：MCP transport × target 能力落差（降级 / 跳过）；
 * - `check-projection-hash`：marker 区间三方比对（当前渲染 vs 记录 vs 磁盘）；
 * - `check-environment`：declared vs detected / OneDrive / skills/ 下的 symlink。
 * - `check-sources`：源登记表与默认注册的官方模板源（只读 fs、零网络、恒不抬退出码）。
 *
 * 类型与 doctorExitCode 在此 re-export：既有调用方（commands/lifecycle/doctor、测试）继续从
 * `./checks` 单点 import，拆分不改变对外导出面。
 */

import type { Host } from '../../infra/host';
import type { EffectiveConfig } from '../config/defaults';
import type { EnvSnapshot } from '../env';
import { ExitCode } from '../errors';
import type { OsContext } from '../paths';
import {
  checkInitialization,
  checkYamlFiles,
  type DoctorRoots,
  existingSotDirs,
  resolveConfigForDoctor,
  resolveDoctorRoots,
} from './check-config';
import {
  checkCodexInlineHooks,
  checkCommandsExposure,
  checkLearningAutoCapture,
  checkMergeJson,
  checkSkillsCopyMode,
  checkSkillsOnDemand,
  checkTemplates,
  readSyncMetaForDoctor,
  renderForDoctor,
} from './check-consistency';
import {
  checkDeclaredVsDetected,
  checkOneDrive,
  checkPiCodingAgentDir,
  checkSkillsSymlinks,
} from './check-environment';
import { checkMcpTransport } from './check-mcp-transport';
import { buildPlanCtx, checkTargetPaths, collectEnabledPlans } from './check-paths';
import { checkProjectionHashes } from './check-projection-hash';
import { piLegacyMcpResults, residualResults } from './check-residuals';
import { checkDefaultSources } from './check-sources';
import { type DoctorCheckResult, type DoctorReport, doctorExitCode } from './check-types';
import { checkSotWritable, checkTargetDirsWritable } from './check-writable';

export {
  type DoctorCheckResult,
  type DoctorLevel,
  type DoctorReport,
  type DoctorSection,
  doctorExitCode,
} from './check-types';

/** doctor 输入（host/os/cwd 由命令层注入；测试可注入 fake host 与任意平台）。 */
export interface DoctorOptions {
  readonly host: Host;
  readonly env: EnvSnapshot;
  readonly os: OsContext;
  readonly cwd: string;
}

/**
 * 执行全部 doctor 检查（§9）。
 *
 * @returns 结构化报告（results + 聚合退出码）。本函数不打印、不因单项失败中断。
 */
export async function runDoctorChecks(opts: DoctorOptions): Promise<DoctorReport> {
  const results: DoctorCheckResult[] = [];
  const { host, env, os, cwd } = opts;

  // ---- 根目录解析（user 根不可解析（无用户目录 / UNC AGF_HOME）→ error）----
  const roots = resolveDoctorRoots(results, env, os, cwd);
  const { userSoTRoot, projectSoTRoot } = roots;

  // ---- 初始化检查（两层 SoT 是否有 profile/habits；全无 → error 并终止后续）----
  if (!(await checkInitialization(host, results, roots))) {
    return { results, exitCode: doctorExitCode(results) };
  }

  // ---- SoT 根可写性（只探测实际存在的层；不创建未初始化层）----
  const sotDirs = await existingSotDirs(host, roots);
  await checkSotWritable(host, results, sotDirs);

  // ---- 事务残留（锁 / 未提交 journal / 回滚失败保留的备份；只读诊断，不清理）----
  for (const dir of sotDirs) {
    results.push(...(await residualResults(host, dir, os)));
  }

  // ---- 投影侧历史落点残留：pi 的 MCP 曾写在 .pi/settings.json（只诊断，不删）----
  results.push(...(await piLegacyMcpResults(host, cwd, env.userProfile, os)));

  // ---- 坏 YAML 检查（§9：逐文件报告损坏的 habits / profile）----
  const yamlOk = await checkYamlFiles(host, results, roots);

  // ---- 三层配置装配（坏 YAML 时跳过——错误已在上面逐文件报告，避免重复）----
  let config: EffectiveConfig | undefined;
  if (yamlOk) {
    config = await resolveConfigForDoctor(host, results, env, roots);
  }

  if (config !== undefined) {
    await runConfigDependentChecks(host, results, env, os, cwd, roots, config);
  }

  // ---- 默认注册源（官方模板源）：登记 / 启用 / 缓存状态与 pin（只读 fs，零网络）----
  await checkDefaultSources(host, results, env, os, cwd, userSoTRoot);

  // ---- OneDrive 检测（§2.1.1 → warn）----
  checkOneDrive(results, env, host);

  // ---- PI_CODING_AGENT_DIR 置位确认（§2.2：user scope 落点按它解析 → ok）----
  checkPiCodingAgentDir(results, env);

  // ---- §9 symlink 检查：扫描 SoT skills/，任何 symlink 条目 → warn（含仍有效的）----
  await checkSkillsSymlinks(host, results, userSoTRoot, projectSoTRoot);

  return { results, exitCode: doctorExitCode(results) };
}

/**
 * 需要 EffectiveConfig 的检查项（渲染 / 路径 / 模板 / sync-meta / 投影 / detected）。
 *
 * 单独一个函数只为让 runDoctorChecks 的顶层流程保持在一屏内：装配失败时整块跳过，
 * 与原先的 `if (config !== undefined) { ... }` 块语义、顺序完全一致。
 */
async function runConfigDependentChecks(
  host: Host,
  results: DoctorCheckResult[],
  env: EnvSnapshot,
  os: OsContext,
  cwd: string,
  roots: DoctorRoots,
  config: EffectiveConfig,
): Promise<void> {
  // ---- 当前 SoT 渲染（hash 基准；与 sync 共用 sync-prepare.renderRulesMd，不经 engine 门面）----
  // os 必须注入（与 sync 同一个值：path_style: auto 依据它改写路径）；env 刻意不注入——
  // 渲染正文与环境无关（auto_capture 只经 effectiveAutoCapture），CI 与本地得到同一 hash
  const rendered = await renderForDoctor(host, results, roots, config, os);

  // ---- §9 第 1 条：各 target 解析后的绝对路径（project + user scope）----
  checkTargetPaths(results, os, cwd, rendered, config, env);

  // ---- §9 第 5 条：未解析的 template id（sync 将失败，error(2)）----
  await checkTemplates(host, results, roots, config);

  // ---- profile.skills.on_demand：MVP 只登记不物化（Spec §4.2 注记）----
  checkSkillsOnDemand(results, config);

  // ---- profile.skills.copy_mode：symlink 已声明未实现（§4.2 注记 / §12 Phase 2）----
  checkSkillsCopyMode(results, config);

  // ---- profile.skills.expose_as_command：名单子集校验 + codex project scope 跳过（§8.8）----
  checkCommandsExposure(results, config);

  // ---- profile.learning.auto_capture：钩子落点 / CI 不写入 / 与 auto_promote 撞锁（§7.4 / §9）----
  checkLearningAutoCapture(results, config, env);

  // ---- MCP transport × target 能力落差（Phase 2 MCP 对齐：降级 / 跳过 → warn）----
  checkMcpTransport(results, config);

  // ---- sync-meta 读取（损坏 → error(2)；不存在 → 信息性 ok）----
  const syncMeta = await readSyncMetaForDoctor(host, results, roots, config);

  // ---- 有效 scope 的投影 rootDir（user scope 需要用户目录，§8.5）----
  const rootDir = config.effectiveScope === 'project' ? cwd : env.userProfile;
  if (rootDir === undefined || rootDir === '') {
    results.push({
      section: 'consistency',
      level: 'error',
      code: ExitCode.Config,
      item: 'projection-root',
      detail: 'user scope 投影需要用户目录（USERPROFILE 与 HOME 均未设置）',
      hint: '设置 USERPROFILE（Windows）或 HOME 后重试',
    });
  } else {
    const ctx = buildPlanCtx(os, config.effectiveScope, rootDir, rendered ?? '', config, env);

    // ---- §9 第 3 条：当前渲染 hash vs 投影 marker 区间 hash（三方比对）----
    await checkProjectionHashes(host, results, ctx, rendered, syncMeta);

    // ---- hook 档 + codex：同层并存 inline [hooks] → warn（§7.4；只报不拦）----
    await checkCodexInlineHooks(host, results, ctx, config);

    // ---- 有效 scope 启用 target 的投影计划（merge_json 检查与目标目录可写性共用）----
    const enabledPlans = collectEnabledPlans(ctx, config);

    // ---- 现有 merge_json 投影损坏（硬项 error(3)；soft 项 warn，§8.2/§8.6）----
    await checkMergeJson(host, results, enabledPlans);

    // ---- §9 第 2 条：目标目录可写性（mkdirp + 探针；不可写 → error(4)）----
    await checkTargetDirsWritable(host, results, enabledPlans);
  }

  // ---- 声明值与 detected 不一致提示（§4.1：声明优先，渲染不受影响，仅提示）----
  checkDeclaredVsDetected(results, config);
}
