/**
 * Sync 引擎 v2（Spec §7.3，M6 四 projector 全事务版）。
 *
 * 流程（§7.3 第 1-7 条）：
 * 1. 解析 SoT 根 → 三层配置装配（resolveEffectiveConfig）→ 初始化检查；
 * 2. 渲染统一 renderedRulesMd **一次**（custom + promoted learnings[空] + templates
 *    + base/default，§5.2 四层；§8.2 同一 SoT 渲染一次分发全部 target）；
 * 3. 对 profile.targets 逐个 projector.plan()（纯函数；plan 阶段失败如模板未
 *    解析属 ConfigError fail-fast——此时尚未写入任何文件，无需回滚）；
 * 4. **写入预校验**：对全部待写路径 mkdirp 目录（失败 → PermissionError(4)，
 *    §7.3-7 目录自动创建；此时同样未写入任何文件）；
 * 5. **备份**：逐项读现有文件内容存内存（不存在记 null；按路径去重——多个
 *    target 共享同一 AGENTS.md 时只备份一次）；
 * 6. **逐一 apply**（幂等跳写：目标已是最终形态则跳过）：
 *    - soft 项（§8.6 Pi MVP）失败 → 仅收集 warning，不计入失败、不触发回滚；
 *    - 任一硬项失败 → **逆序恢复全部已动文件**（备份为 null 的删除新建文件；
 *      回滚失败按 best-effort 收集进失败报告）→ 抛出失败汇总（rethrow 原始
 *      错误以保留类型与退出码——fail-fast 单失败点即 severityOf 最高者，
 *      §7.3-6 退出码取失败 target 中最高严重度）；
 * 7. 成功才写 sync-meta.json（§3.3）；回滚则不更新（保留上次记录）。
 *    soft 失败的 target 不记入 targets（该 target 投影不完整，不提供
 *    doctor 一致性基准——见下方 JSDoc「soft 项与 sync-meta」）。
 * 7.5 `projection.gitignore_generated=true` 且 project scope 时，在同一事务内
 *    把全部项目内投影产物写进 `<项目根>\.gitignore` 的 `# BEGIN AGENTFORGE`
 *    标记段（§4.2；段外用户条目保留，段内全量重算 → 幂等）。
 *
 * 并发与中断安全：
 * - **进程级排他锁**：非 dry-run 路径在 SoT 根取 `<sotRoot>/.sync.lock/`（**目录**，
 *   原子 mkdir 即互斥原语），覆盖「备份 → apply → 写 sync-meta」整段（只锁 apply
 *   无法阻止并发写入后被过期备份覆盖；writeSyncMetaOnSuccess 的读-改-写同样必须在
 *   锁内）。取不到锁 → ConflictError(3)；持锁期间有心跳，心跳停摆超过
 *   SYNC_LOCK_STALE_MS 且持有者进程已消失的锁才可抢占；产物落在 SoT 之外
 *   （CODEX_HOME / 用户目录）时额外取用户级 SoT 根的锁；
 * - **备份落盘**：备份基准同时写入 `<sotRoot>/.agf-backup/`（journal.json 记录
 *   路径映射与已写入状态），进程被 SIGKILL 后由下次 sync 在锁内检出并恢复；
 *   恢复前校验 journal 的来源（SoT / 机器 / 用户）与每条目标路径的白名单边界；
 * - **回滚前基准复核**：写回备份前复核目标文件当前内容仍等于「本次 sync 写入
 *   的结果」，不等（并发进程 / 编辑器已改动）则报告冲突而非覆盖；
 * - **回滚未完成不销毁备份**：存在 restored=false 的条目时把备份另存为
 *   `.agf-backup-failed-<ts>/` 并写进失败汇总（退出码 6），绝不让用户在被告知
 *   「手工处理」时手上没有 sync 前的原文；
 * - **信号中断**：当前事务句柄经模块级 activeTransaction 暴露，
 *   rollbackActiveSyncTransactionSync 供 main.ts 的信号 / 致命错误处理器同步回滚。
 *
 * M7（Spec §8.2-4）：apply 前执行 marker 区间冲突预检查——读现有投影文件，
 * 区间 hash 与 sync-meta 记录值不一致 → ConflictError(3)；--force 跳过；
 * 首次 sync（无记录）不检查。contentHash 基准同步统一为 marker 区间形态
 * （markers.renderedSectionHash，见其 M6→M7 调整说明）。损坏的 sync-meta
 * 在预检查阶段 fail-fast（ConfigError(2)，sync-meta.ts 契约：不静默丢基准）。
 * 同一时机还有整文件 `write` 项的预检查（assertNoWriteConflicts）：落点在上一轮
 * §7.6 `artifacts` 记账里没有、磁盘上却已有内容不同的文件 → ConflictError(3)，
 * 避免 `write` 的整文件替换静默吞掉用户既有文件（判据与存量用户豁免见 sync-verify）。
 *
 * 后续里程碑边界：
 * - sync 不刷新 habits.detected（渲染只消费声明字段；重新探测走 aforge detect）；
 * - skills 物化数据源（skillsToMaterialize）M8 skill add 接入；M6 引擎侧
 *   的 write 项 / 备份 / 回滚已就绪（skills copy 为实体 copy 非 symlink，§7.6）。
 *
 * 差集清理（Spec §7.6，阶段 5.4）：全部 target 落定后按 sync-meta 上一轮记账
 * （`artifacts` / `mcpServers`）删掉本轮不再产出的整文件产物、摘掉已从 SoT 移除的
 * MCP server 键。只删记账里认领过且内容仍与记账一致的东西，实现见 `sync-prune`。
 *
 * 模块划分（本文件只留 syncOnce 的阶段编排，各阶段实现在同目录）：
 * - `sync-types`：对外数据契约（SyncOptions / SyncResult / 失败汇总）；
 * - `sync-lock`：`.sync.lock\` 目录锁；`sync-prepare`：初始化检查 / 目标过滤 / 渲染；
 * - `sync-transaction`：备份与回滚；`sync-recovery`：崩溃恢复与备份保全；
 * - `sync-abort`：信号处理器用的同步回滚；`sync-verify`：冲突预检查与 sync-meta；
 * - `sync-residuals`：残留物盘点；`sync-gitignore`：生成物 .gitignore 段；
 * - `sync-result`：dry-run / apply 两条返回路径的 SyncResult 装配；
 * - `sync-prune`：上一轮投影产物的差集清理（§7.6）；
 * - `sync-notices`：plan 派生的提示类产出（命令跳过 / MCP transport 能力落差 /
 *   `learning.auto_capture: hook` 的 target 降级），三类共用「不进 warnings」不变式。
 *
 * 这些符号在此 re-export：既有调用方（命令层 / doctor / 测试）继续从 `./engine`
 * 单点 import，拆分不改变对外导出面。
 */
import path from 'node:path';
import { mkdirp } from '../../infra/fsutil';
import { resolveEffectiveConfig } from '../config/defaults';
import { ConfigError } from '../errors';
import { renderedSectionHash } from '../markers';
import { resolveProjectSoT, resolveUserSoT } from '../paths';
import { readSkillsToMaterialize } from '../sources/skill';
import { resolveCommandsToExpose } from './commands';
import { projectorRegistry } from './projectors/registry';
import { GITIGNORE_MARKERS, GITIGNORE_TARGET_ID, planGitignoreItem } from './sync-gitignore';
import { acquireSyncLocks, releaseSyncLocks, resolveLockRoots } from './sync-lock';
import { collectSyncAdvisories } from './sync-notices';
import {
  assertInitialized,
  filterTargets,
  type PlannedTarget,
  renderRulesMd,
  requireUserProfileForProjection,
  resolveMarkers,
  type TargetFailure,
} from './sync-prepare';
import { pruneStaleProjections } from './sync-prune';
import { preserveBackupArtifacts, recoverPendingTransaction } from './sync-recovery';
import { buildAppliedSyncResult, buildDryRunSyncResult, type SyncResultBase } from './sync-result';
import {
  backupTarget,
  beginTransaction,
  detachTransaction,
  discardTransaction,
  persistJournal,
  recordWrite,
  rollbackWrites,
  type SyncTransaction,
  transactionWarningsOf,
} from './sync-transaction';
import {
  ALL_TARGET_IDS,
  attachFailureReport,
  type SyncFailureReport,
  type SyncOptions,
  type SyncResult,
  type SyncTargetResult,
  type SyncWarning,
} from './sync-types';
import {
  assertNoMarkerConflicts,
  assertNoWriteConflicts,
  readBackSectionHash,
  readSyncMetaBaseline,
  writeSyncMetaOnSuccess,
} from './sync-verify';
import type { ProjectContext } from './types';
import { applyItem } from './writer';

export { rollbackActiveSyncTransactionSync } from './sync-abort';
export {
  buildGitignoreItem,
  GITIGNORE_FILE,
  GITIGNORE_MARKER_BEGIN,
  GITIGNORE_MARKER_END,
  GITIGNORE_TARGET_ID,
} from './sync-gitignore';
export {
  resolveLockRoots,
  SYNC_LOCK_DIRNAME,
  SYNC_LOCK_HEARTBEAT_MS,
  SYNC_LOCK_META_FILE,
  SYNC_LOCK_STALE_MS,
  withSotLock,
} from './sync-lock';
export { filterTargets, renderRulesMd } from './sync-prepare';
export type { SyncPrunedEntry, SyncPruneSkip } from './sync-prune';
export { inspectSyncResiduals, type SyncResidual, type SyncResidualKind } from './sync-residuals';
export {
  type ActiveSyncTransactionSnapshot,
  getActiveSyncTransaction,
  SYNC_BACKUP_DIRNAME,
  SYNC_BACKUP_FAILED_PREFIX,
  SYNC_BACKUP_JOURNAL_FILE,
} from './sync-transaction';
export {
  ALL_TARGET_IDS,
  getSyncFailureReport,
  REGISTERED_PROJECTORS,
  type SyncCommandSkip,
  type SyncFailureReport,
  type SyncItemStatus,
  type SyncNotice,
  type SyncOptions,
  type SyncResult,
  type SyncRollbackEntry,
  type SyncTargetResult,
  type SyncWarning,
} from './sync-types';

/**
 * 执行一次 sync（Spec §7.3，四 target 全事务版）。
 *
 * @throws ConfigError(2) 未初始化 / --targets 非法 / 模板解析失败 / 配置损坏 /
 *         sync-meta.json 损坏（冲突预检查阶段 fail-fast）；
 * @throws PermissionError(4) 目录创建失败（§7.3-7）/ 备份读取失败 / 投影写入失败；
 * @throws ConflictError(3) marker 区间被手动修改（§8.2-4，--force 跳过）/ 整文件
 *         write 落点已有未记账的用户文件（§7.6，--force 跳过）/
 *         merge_json 目标损坏（writer 层映射）/ 同一 SoT 已有 sync 在写入
 *         （`<sotRoot>/.sync.lock/` 被占用，心跳停摆且持有者进程消失才可抢占）；
 *         投影失败时先回滚全部已写文件再 rethrow 原始错误（类型与退出码不变，
 *         失败汇总经 getSyncFailureReport(err) 获取）。
 */
export async function syncOnce(opts: SyncOptions): Promise<SyncResult> {
  const { host, env, os, cwd } = opts;
  const userSoTRoot = resolveUserSoT(env, os);
  const projectSoTRoot = resolveProjectSoT(cwd, os);
  const config = await resolveEffectiveConfig(env, userSoTRoot, projectSoTRoot, host);

  await assertInitialized(host, userSoTRoot, projectSoTRoot);

  const requested = filterTargets(config.profile.targets, opts.targetsFilter);
  const renderedRulesMd = await renderRulesMd(
    host,
    userSoTRoot,
    projectSoTRoot,
    config.habits,
    config.profile,
    os,
  );
  // M8：skills.always 物化数据源（§7.6 实体 copy；同名 project > user，§5.3）
  const skillsToMaterialize = await readSkillsToMaterialize(
    host,
    userSoTRoot,
    projectSoTRoot,
    config.profile,
  );
  // §8.8：expose_as_command 点名的技能额外产出命令薄壳（名单非 always 子集 → 退出码 2）
  const commandsToExpose = resolveCommandsToExpose(config.profile, skillsToMaterialize);

  const ctx: ProjectContext = {
    os,
    scope: config.effectiveScope,
    rootDir: config.effectiveScope === 'project' ? cwd : requireUserProfileForProjection(env),
    renderedRulesMd,
    habits: config.habits,
    profile: config.profile,
    skillsToMaterialize, // M8：skill add 接入（write 项/事务 M6 已就绪）
    commandsToExpose, // §8.8：命令薄壳（codex project scope 由该 projector 自行跳过）
    mcpServers: config.profile.mcp.servers ?? [],
    dryRun: opts.dryRun,
    lineEnding: config.profile.projection.line_ending,
    markerBegin: config.profile.projection.marker_begin,
    markerEnd: config.profile.projection.marker_end,
    markerMode: config.profile.projection.marker_mode,
    env,
  };

  // ---- 阶段 1：plan 全部 target（纯函数；失败 fail-fast，无需回滚）----
  const planned: PlannedTarget[] = [];
  const skippedTargets: string[] = [];
  for (const targetId of requested) {
    const projector = projectorRegistry.get(targetId);
    if (projector === undefined) {
      skippedTargets.push(targetId);
      continue;
    }
    const plan = projector.plan(ctx);
    planned.push({ targetId, plan, statuses: [], completed: false, started: false });
  }

  if (planned.length === 0) {
    throw new ConfigError('没有可同步的 target', {
      hint: `注册表中可用的 target: ${ALL_TARGET_IDS.join(', ')}`,
      details: { requested, skippedTargets },
    });
  }

  const contentHash = renderedSectionHash(renderedRulesMd, ctx.markerBegin, ctx.markerEnd);

  // ---- plan 派生的提示类产出（投影仍完整，只是有事要告诉用户；dry-run 同样成立）----
  // §8.8.4 命令薄壳整项跳过 + Phase 2 MCP transport 能力落差 + §7.4 hook 档下无钩子
  // 落点的 target 降级。三类都不进 warnings（否则误伤 §7.6 记账），判定见 sync-notices。
  const advisories = collectSyncAdvisories({
    profile: config.profile,
    scope: ctx.scope,
    hasCommandsToExpose: commandsToExpose.length > 0,
    targetIds: planned.map((t) => t.targetId),
    projectors: projectorRegistry.list(),
    mcpServers: ctx.mcpServers,
  });

  // ctx 建好之后一律用 ctx.scope（与 config.effectiveScope 同值——ctx 就是由它赋的；
  // 同一段代码两种写法会让读者以为二者可能不同）
  const sotRoot = ctx.scope === 'project' ? projectSoTRoot : userSoTRoot;

  // ---- 阶段 1.4：.gitignore 项（§4.2 gitignore_generated；判定见 sync-gitignore）----
  const gitignoreItem = planGitignoreItem(config.profile, ctx.scope, planned, cwd, sotRoot, os);

  // 两条返回路径共享的本轮事实（装配见 sync-result：字段加漏一处即 TS 报错）
  const resultBase: SyncResultBase = {
    scope: ctx.scope,
    userSoTRoot,
    projectSoTRoot,
    sotRoot,
    contentHash,
    skippedTargets,
    advisories,
  };

  // ---- 阶段 1.5：写入冲突预检查（§8.2-4 / §7.6；--force 跳过；此刻零写入）----
  // 上一轮记账在此读一次，两道预检查与阶段 5.4 的 prune 共用（--force 下损坏容忍）
  const previousMeta = await readSyncMetaBaseline(host, sotRoot, opts.force === true);
  if (opts.force !== true) {
    await assertNoMarkerConflicts(host, planned, previousMeta, ctx);
    // 整文件 write 项：只查「本轮新进记账、磁盘上却已存在」的落点（判据见 sync-verify）
    await assertNoWriteConflicts(host, planned, previousMeta);
  }

  // ---- dry-run：返回完整计划，不 mkdirp / 不备份 / 不 apply / 不写 sync-meta ----
  if (opts.dryRun) {
    return buildDryRunSyncResult(resultBase, planned, gitignoreItem);
  }

  // ---- 阶段 1.6：取事务锁（覆盖备份 → apply → 写 sync-meta 整段）----
  // 只锁 apply 是不够的：并发进程若在「备份」与「apply」之间写入同一 AGENTS.md，
  // 本次失败回滚会用过期备份把对方的改动覆盖掉。
  // 锁按根取，但产物可能落在 SoT 之外（CODEX_HOME / PI_CODING_AGENT_DIR 指向用户目录外
  // 时两个项目会并发写同一个 config.toml / mcp.json）→ 此时额外取用户级 SoT 根的锁，
  // 按路径序加锁防死锁。
  const allItemPaths = [
    ...planned.flatMap((t) => t.plan.items.map((i) => i.path)),
    ...(gitignoreItem === undefined ? [] : [gitignoreItem.path]),
  ];
  const outsideRoots = [env.userProfile, env.codexHome, env.piCodingAgentDir].filter(
    (root): root is string => root !== undefined && root !== '',
  );
  const locks = await acquireSyncLocks(
    host,
    resolveLockRoots(sotRoot, userSoTRoot, cwd, allItemPaths, outsideRoots, os),
    os,
  );

  let tx: SyncTransaction | undefined;
  // 回滚未全部成功时保留备份目录（否则 finally 的清理会销毁用户唯一的 sync 前原文）
  let preservedBackupDir: string | null = null;
  let rollbackIncomplete = false;
  try {
    // ---- 阶段 1.7：恢复上次被强杀（SIGKILL）遗留的落盘备份（锁内执行）----
    // 白名单：journal 的目标路径必须落在这些根内，否则拒绝恢复（不信任磁盘上的 JSON）
    const allowedRoots = [
      sotRoot,
      userSoTRoot,
      projectSoTRoot,
      cwd,
      ...outsideRoots,
      ...allItemPaths.map((p) => path.dirname(p)),
    ];
    const recovery = await recoverPendingTransaction(host, os, sotRoot, allowedRoots);
    const recovered = recovery.entries;

    // ---- 阶段 2：写入预校验——全部待写目录 mkdirp（§7.3-7；失败即抛，未写任何文件）----
    const dirs = new Set<string>();
    for (const target of planned) {
      for (const item of target.plan.items) {
        dirs.add(path.dirname(item.path));
      }
    }
    if (gitignoreItem !== undefined) {
      dirs.add(path.dirname(gitignoreItem.path));
    }
    for (const dir of dirs) {
      await mkdirp(host, dir);
    }

    // ---- 阶段 3：备份——内存 + 落盘副本（null = 不存在；按路径去重，共享文件只备份一次）----
    tx = await beginTransaction(host, os, sotRoot, locks);
    for (const target of planned) {
      for (const item of target.plan.items) {
        await backupTarget(tx, item.path);
      }
    }
    if (gitignoreItem !== undefined) {
      await backupTarget(tx, gitignoreItem.path); // .gitignore 与投影产物同一事务
    }

    // ---- 阶段 4：逐一 apply（幂等跳写 + soft 容错；硬项失败 → 回滚并 rethrow）----
    const warnings: SyncWarning[] = [];
    let failure: TargetFailure | undefined;

    for (const target of planned) {
      if (failure !== undefined) {
        break; // 已失败：后续 target 一律不再执行（not-started）
      }
      target.started = true;
      const markers = resolveMarkers(target.plan, ctx);
      for (const item of target.plan.items) {
        try {
          const wrote = await applyItem(host, item, ctx.lineEnding, markers);
          target.statuses.push(wrote ? 'written' : 'unchanged');
          if (wrote) {
            await recordWrite(tx, item.path);
          }
        } catch (err) {
          if (item.soft === true) {
            // §8.6 Pi MVP soft：失败仅 warning，不计入失败、不触发回滚
            target.statuses.push('warning');
            warnings.push({
              targetId: target.targetId,
              path: item.path,
              message: err instanceof Error ? err.message : String(err),
            });
            continue;
          }
          failure = { targetId: target.targetId, itemPath: item.path, error: err };
          break;
        }
      }
      target.completed = failure === undefined;
      if (failure === undefined) {
        // sync-meta 的基准取本次实际落盘的区间形态（见 writeSyncMetaOnSuccess）
        target.contentHash = await readBackSectionHash(host, target, markers);
      }
    }

    // ---- 阶段 4.5：.gitignore（§4.2）——全部 target 成功后写，与它们同一事务 ----
    let gitignoreResult: SyncTargetResult | null = null;
    if (gitignoreItem !== undefined && failure === undefined) {
      try {
        const wrote = await applyItem(host, gitignoreItem, ctx.lineEnding, GITIGNORE_MARKERS);
        if (wrote) {
          await recordWrite(tx, gitignoreItem.path);
        }
        gitignoreResult = {
          targetId: GITIGNORE_TARGET_ID,
          items: [gitignoreItem],
          statuses: [wrote ? 'written' : 'unchanged'],
        };
      } catch (err) {
        // 硬项：与投影产物同等对待（回滚 + rethrow），不静默吞掉写入失败
        failure = { targetId: GITIGNORE_TARGET_ID, itemPath: gitignoreItem.path, error: err };
      }
    }

    // ---- 阶段 5：失败 → 逆序回滚全部已动文件 → rethrow 原始错误（附失败汇总）----
    if (failure !== undefined) {
      const fail = failure;
      const rolledBack = await rollbackWrites(host, tx.writtenFiles, tx.backups, tx.writtenHashes);
      rollbackIncomplete = rolledBack.some((entry) => !entry.restored);
      if (rollbackIncomplete) {
        // 未恢复的文件在磁盘上是**新**内容，其 sync 前原文只剩那份 .bak → 必须留证据
        preservedBackupDir = await preserveBackupArtifacts(tx, rolledBack);
      }
      const report: SyncFailureReport = {
        failedTargetId: fail.targetId,
        failedPath: fail.itemPath,
        targetStatuses: planned.map((t) => ({
          targetId: t.targetId,
          status: !t.started
            ? 'not-started'
            : t.targetId === fail.targetId
              ? 'failed'
              : 'ok-rolled-back',
        })),
        rolledBack,
        ...(preservedBackupDir === null ? {} : { preservedBackupDir }),
      };
      throw attachFailureReport(fail.error, report);
    }

    // ---- 阶段 5.4：差集清理（§7.6）——产物已落定，仍在事务与锁内 ----
    const prune = await pruneStaleProjections(tx, previousMeta, planned, ctx);

    // ---- 阶段 5.5：提交标记 —— 写 sync-meta 之前把 journal 标记为已提交 ----
    // 提交与 finally 删 journal 之间被强杀时，下次 sync 不得把已成功提交的投影当
    // 未完成事务回滚（子集 sync 不会重写被回滚的其他 target → 磁盘与 sync-meta 不一致）
    tx.journal.committed = true;
    await persistJournal(tx);

    // ---- 阶段 6：全部成功 → 写 sync-meta（soft 失败的 target 不记，见上方 JSDoc）----
    await writeSyncMetaOnSuccess(
      host,
      opts,
      os,
      sotRoot,
      contentHash,
      planned,
      warnings,
      ctx.lineEnding,
      prune,
    );

    return buildAppliedSyncResult(resultBase, planned, {
      warnings,
      transactionWarnings: transactionWarningsOf(tx, sotRoot, recovery.preservedDir),
      gitignore: gitignoreResult,
      recovered,
      prune,
    });
  } finally {
    if (tx !== undefined) {
      if (rollbackIncomplete && preservedBackupDir === null) {
        // 备份保留失败：宁可留下 .agf-backup（下次 sync 会按 journal 恢复）也不删除
        detachTransaction(tx);
      } else {
        await discardTransaction(tx);
      }
    }
    await releaseSyncLocks(host, locks);
  }
}
