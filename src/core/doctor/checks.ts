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
 * 8. 现有 merge_json 投影损坏（硬项 error(3)，soft 项 warn——§8.2/§8.6）。
 *
 * 设计原则：
 * - 单项失败不中断整体：逐项收集（区分于 sync 的 fail-fast），一次运行报告全部问题；
 * - 无持久副作用：除目录可写性探针（mkdirp + 临时文件 + 删除，§7.3-7 语义）
 *   外不写任何文件——探针创建的空目录与 sync 行为一致，无害；
 * - 渲染路径与 sync 共用（engine.renderRulesMd，单一事实源）；
 * - 聚合退出码见 doctorExitCode（Permission 4 > Conflict 3 > 其他 error；仅 warn → 0）。
 */
import path from 'node:path';
import type { Host } from '../../infra/host';
import { sha256Hex } from '../../infra/fsutil';
import type { EnvSnapshot, Scope } from '../env';
import { detectOneDrive, resolveProjectSoT, resolveUserSoT, type OsContext } from '../paths';
import { AgentForgeError, ExitCode } from '../errors';
import { HABITS_FILE, PROFILE_FILE, loadHabits, loadProfile } from '../config/load';
import { resolveEffectiveConfig, type EffectiveConfig } from '../config/defaults';
import { resolveTemplate } from '../generate/resolver';
import { renderedSectionHash, splitByMarkers } from '../markers';
import { readSyncMeta, SYNC_META_FILE } from '../project/sync-meta';
import { renderRulesMd } from '../project/engine';
import { projectorRegistry } from '../project/projectors/registry';
import type { ProjectContext } from '../project/types';
import type { SyncMeta } from '../../schema';

/** 单项检查结果级别（人类可读输出映射为 OK / WARN / FAIL，纯 ASCII）。 */
export type DoctorLevel = 'ok' | 'warn' | 'error';

/** 报告分组（人类可读输出按此分节）。 */
export type DoctorSection = 'config' | 'paths' | 'consistency' | 'environment';

/** 单项检查结果（--json 输出的原子单元；路径一律绝对路径字符串，§6.2）。 */
export interface DoctorCheckResult {
  readonly section: DoctorSection;
  readonly level: DoctorLevel;
  /** 检查项标识（如 initialization / yaml/user.profile.yaml / path/claude）。 */
  readonly item: string;
  /** 详情（可含 \n 多行）。 */
  readonly detail: string;
  /** error 级的退出码归属（2=配置 / 3=冲突 / 4=权限 / 1=UNC 等）；ok/warn 不设。 */
  readonly code?: ExitCode;
  /** 修复建议（error/warn 级附操作指引）。 */
  readonly hint?: string;
}

/** doctor 诊断报告：全部检查项 + 聚合退出码。 */
export interface DoctorReport {
  readonly results: readonly DoctorCheckResult[];
  readonly exitCode: number;
}

/** doctor 输入（host/os/cwd 由命令层注入；测试可注入 fake host 与任意平台）。 */
export interface DoctorOptions {
  readonly host: Host;
  readonly env: EnvSnapshot;
  readonly os: OsContext;
  readonly cwd: string;
}

/**
 * 聚合退出码（Spec §6.1 语义在 doctor 的映射，M7 任务定义）：
 * - 任一 error 级 Permission 类（code 4）→ 4；
 * - 否则任一 error 级 Conflict 类（code 3）→ 3；
 * - 否则任一其他 error（code 2 配置 / 1 UNC 等）→ 取最大值；
 * - 仅 warn / ok → 0。
 */
export function doctorExitCode(results: readonly DoctorCheckResult[]): number {
  let code: number = ExitCode.Success;
  for (const result of results) {
    if (result.level === 'error') {
      const candidate = result.code ?? ExitCode.Config;
      if (candidate > code) {
        code = candidate;
      }
    }
  }
  return code;
}

/** 任意错误的退出码归属：AgentForgeError → 其 code；未知 → 2（配置域安全默认）。 */
function toDoctorCode(err: unknown): ExitCode {
  return err instanceof AgentForgeError ? err.code : ExitCode.Config;
}

/** 任意错误的 message（诊断条目 detail 用）。 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** AgentForgeError 的 hint（有则透传给检查条目）。 */
function errHint(err: unknown): string | undefined {
  return err instanceof AgentForgeError ? err.hint : undefined;
}

/** detected 快照（loose object）中取 node/python 的 manager 字段。 */
function detectedManagerOf(
  detected: Record<string, unknown>,
  key: 'node' | 'python',
): string | undefined {
  const entry = detected[key];
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const manager = (entry as Record<string, unknown>).manager;
  return typeof manager === 'string' ? manager : undefined;
}

/** doctor 内部的 plan ctx 构造（与 engine.syncOnce 的 ctx 同构；dryRun: true 表诊断不写）。 */
function buildPlanCtx(
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
    mcpServers: config.profile.mcp.servers ?? [],
    dryRun: true,
    lineEnding: config.profile.projection.line_ending,
    markerBegin: config.profile.projection.marker_begin,
    markerEnd: config.profile.projection.marker_end,
    env,
  };
}

interface ProbeResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * 目录可写性探测：mkdirp（§7.3-7 目录自动创建语义——sync 同样会创建）→
 * 写入探针文件 → 删除。任何失败均视为不可写（探针写入失败的场景，
 * 实际投影写入同样会失败）。
 */
async function probeWritable(host: Host, dir: string): Promise<ProbeResult> {
  try {
    await host.mkdirp(dir);
    const probe = path.join(dir, `.agf-doctor-probe-${host.now().getTime()}`);
    await host.writeFile(probe, '');
    await host.rm(probe);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

/**
 * 单个投影文件的 marker 区间一致性检查（§9 第 3 条，M7）：
 * 三方比对——当前渲染 hash（A）、sync-meta 记录值（B）、投影区间实际 hash（C）：
 * - C ≠ B：区间与上次 sync 记录不一致 → warn（可能被手动修改）；
 * - C = B ≠ A：投影未被动过但 SoT 已变更 → warn（过期，未 sync）；
 * - C = B = A：一致 → ok；
 * - 文件不存在 / 无 marker / 读取失败 → warn（漂移或不可诊断）。
 */
async function checkProjectionHash(
  host: Host,
  results: DoctorCheckResult[],
  targetId: string,
  filePath: string,
  recordedHash: string,
  currentHash: string,
  markerBegin: string,
  markerEnd: string,
): Promise<void> {
  const item = `projection-hash/${targetId}`;
  if (!(await host.exists(filePath))) {
    results.push({
      section: 'consistency',
      level: 'warn',
      item,
      detail: `投影文件不存在: ${filePath}`,
      hint: '执行 aforge sync 重建投影',
    });
    return;
  }
  let content: string;
  try {
    content = await host.readFile(filePath);
  } catch (err) {
    results.push({
      section: 'consistency',
      level: 'warn',
      item,
      detail: `投影文件无法读取: ${filePath}\n${errMessage(err)}`,
    });
    return;
  }
  const split = splitByMarkers(content, markerBegin, markerEnd);
  if (!split.hasMarkers) {
    results.push({
      section: 'consistency',
      level: 'warn',
      item,
      detail: `投影文件无 marker 区间（可能被移除）: ${filePath}`,
      hint: '执行 aforge sync 重新追加投影区间',
    });
    return;
  }
  const sectionHash = sha256Hex(split.inside);
  if (sectionHash !== recordedHash) {
    results.push({
      section: 'consistency',
      level: 'warn',
      item,
      detail: `hash 不一致（投影与上次 sync 记录不符，可能被手动修改）: ${filePath}`,
      hint: '确认修改无需保留后执行 aforge sync --force 覆盖；否则请先恢复区间内容',
    });
  } else if (sectionHash !== currentHash) {
    results.push({
      section: 'consistency',
      level: 'warn',
      item,
      detail: `投影可能过期或被修改（SoT 在上次 sync 后已变更）: ${filePath}`,
      hint: '执行 aforge sync 更新投影',
    });
  } else {
    results.push({
      section: 'consistency',
      level: 'ok',
      item,
      detail: `一致: ${filePath}`,
    });
  }
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
  let userSoTRoot: string | undefined;
  try {
    userSoTRoot = resolveUserSoT(env, os);
  } catch (err) {
    results.push({
      section: 'config',
      level: 'error',
      code: toDoctorCode(err),
      item: 'user-sot-root',
      detail: errMessage(err),
      hint: errHint(err),
    });
  }
  const projectSoTRoot = resolveProjectSoT(cwd, os);
  // user 根不可解析时以 project 根占位（该层文件被加载两次，幂等无副作用）
  const userRootForLoad = userSoTRoot ?? projectSoTRoot;

  // ---- 初始化检查（两层 SoT 是否有 profile/habits；全无 → error 并终止后续）----
  const userInit =
    userSoTRoot !== undefined &&
    ((await host.exists(path.join(userSoTRoot, PROFILE_FILE))) ||
      (await host.exists(path.join(userSoTRoot, HABITS_FILE))));
  const projectInit =
    (await host.exists(path.join(projectSoTRoot, PROFILE_FILE))) ||
    (await host.exists(path.join(projectSoTRoot, HABITS_FILE)));
  const initialized = userInit || projectInit;
  results.push({
    section: 'config',
    level: initialized ? 'ok' : 'error',
    code: initialized ? undefined : ExitCode.Config,
    item: 'initialization',
    detail: [
      `user SoT    : ${userSoTRoot ?? '(unresolvable)'} ${userInit ? '(initialized)' : '(not initialized)'}`,
      `project SoT : ${projectSoTRoot} ${projectInit ? '(initialized)' : '(not initialized)'}`,
    ].join('\n'),
    hint: initialized ? undefined : '先运行 aforge init 建立任一层 SoT',
  });
  if (!initialized) {
    return { results, exitCode: doctorExitCode(results) };
  }

  // ---- SoT 根可写性（只探测实际存在的层；不创建未初始化层）----
  const sotDirs: string[] = [];
  if (userSoTRoot !== undefined && (await host.exists(userSoTRoot))) {
    sotDirs.push(userSoTRoot);
  }
  if (await host.exists(projectSoTRoot)) {
    sotDirs.push(projectSoTRoot);
  }
  for (const dir of sotDirs) {
    const probe = await probeWritable(host, dir);
    results.push(
      probe.ok
        ? { section: 'paths', level: 'ok', item: 'writable', detail: `可写: ${dir}` }
        : {
            section: 'paths',
            level: 'error',
            code: ExitCode.Permission,
            item: 'writable',
            detail: `不可写: ${dir}${probe.error ? `（${probe.error}）` : ''}`,
            hint: '检查目录写权限（必要时以管理员身份运行），或把 SoT 移到用户可写位置',
          },
    );
  }

  // ---- 坏 YAML 检查（§9：逐文件报告损坏的 habits / profile）----
  const yamlChecks: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    [`user/${PROFILE_FILE}`, () => loadProfile(host, userRootForLoad)],
    [`user/${HABITS_FILE}`, () => loadHabits(host, userRootForLoad)],
    [`project/${PROFILE_FILE}`, () => loadProfile(host, projectSoTRoot)],
    [`project/${HABITS_FILE}`, () => loadHabits(host, projectSoTRoot)],
  ];
  let yamlOk = true;
  for (const [item, load] of yamlChecks) {
    try {
      await load();
    } catch (err) {
      yamlOk = false;
      results.push({
        section: 'config',
        level: 'error',
        code: toDoctorCode(err),
        item: `yaml/${item}`,
        detail: errMessage(err),
        hint: errHint(err) ?? '修正该文件的 YAML 语法或字段结构后重试',
      });
    }
  }

  // ---- 三层配置装配（坏 YAML 时跳过——错误已在上面逐文件报告，避免重复）----
  let config: EffectiveConfig | undefined;
  if (yamlOk) {
    try {
      config = await resolveEffectiveConfig(env, userRootForLoad, projectSoTRoot, host);
    } catch (err) {
      results.push({
        section: 'config',
        level: 'error',
        code: toDoctorCode(err),
        item: 'effective-config',
        detail: errMessage(err),
        hint: errHint(err) ?? '按错误信息修正 profile.yaml / habits.yaml 的合并结果',
      });
    }
  }

  if (config !== undefined) {
    // ---- 当前 SoT 渲染（hash 基准；与 sync 共用 engine.renderRulesMd）----
    let rendered: string | undefined;
    try {
      rendered = await renderRulesMd(
        host,
        userRootForLoad,
        projectSoTRoot,
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
    }

    // ---- §9 第 1 条：各 target 解析后的绝对路径（project + user scope）----
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

    // ---- §9 第 5 条：未解析的 template id（sync 将失败，error(2)）----
    const templateIds = config.profile.templates ?? [];
    if (templateIds.length === 0) {
      results.push({
        section: 'consistency',
        level: 'ok',
        item: 'templates',
        detail: 'profile.templates 未声明（渲染仅含 base/default）',
      });
    } else {
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

    // ---- sync-meta 读取（损坏 → error(2)；不存在 → 信息性 ok）----
    const sotRoot = config.effectiveScope === 'project' ? projectSoTRoot : userRootForLoad;
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

    // ---- 有效 scope 的投影 rootDir（user scope 需要用户目录，§8.5）----
    const rootDir =
      config.effectiveScope === 'project' ? cwd : env.userProfile;
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
      const markerBegin = config.profile.projection.marker_begin;
      const markerEnd = config.profile.projection.marker_end;
      if (rendered !== undefined && syncMeta !== null) {
        const currentHash = renderedSectionHash(rendered, markerBegin, markerEnd);
        const recordedIds = Object.keys(syncMeta.targets);
        if (recordedIds.length === 0) {
          results.push({
            section: 'consistency',
            level: 'ok',
            item: 'projection-hash',
            detail: 'sync-meta 无投影记录（尚无成功 sync 的 target）',
          });
        }
        for (const targetId of recordedIds) {
          const projector = projectorRegistry.get(targetId);
          const recorded = syncMeta.targets[targetId];
          if (projector === undefined || recorded === undefined) {
            results.push({
              section: 'consistency',
              level: 'warn',
              item: `projection-hash/${targetId}`,
              detail: 'sync-meta 记录了未知 target（可能由更新版本的 aforge 写入）',
            });
            continue;
          }
          for (const item of projector.plan(ctx).items) {
            if (item.action !== 'merge_marker') {
              continue; // 只比对 md marker 区间（§8.2-4 检测范围，与 sync 预检查一致）
            }
            await checkProjectionHash(
              host,
              results,
              targetId,
              item.path,
              recorded.contentHash,
              currentHash,
              markerBegin,
              markerEnd,
            );
          }
        }
      }

      // ---- 有效 scope 启用 target 的投影计划（merge_json 检查与目标目录可写性共用）----
      const enabledTargets = (config.profile.targets as readonly string[]).includes.bind(
        config.profile.targets,
      );
      const enabledPlans = projectorRegistry
        .list()
        .filter((p) => enabledTargets(p.id))
        .map((p) => ({ projector: p, plan: p.plan(ctx) }));

      // ---- 现有 merge_json 投影损坏（硬项 error(3)；soft 项 warn，§8.2/§8.6）----
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

      // ---- §9 第 2 条：目标目录可写性（mkdirp + 探针；不可写 → error(4)）----
      const targetDirs = new Set<string>();
      for (const { plan } of enabledPlans) {
        for (const item of plan.items) {
          targetDirs.add(path.dirname(item.path));
        }
      }
      for (const dir of [...targetDirs].sort()) {
        const probe = await probeWritable(host, dir);
        results.push(
          probe.ok
            ? { section: 'paths', level: 'ok', item: 'writable', detail: `可写: ${dir}` }
            : {
                section: 'paths',
                level: 'error',
                code: ExitCode.Permission,
                item: 'writable',
                detail: `不可写: ${dir}${probe.error ? `（${probe.error}）` : ''}`,
                hint: '检查目录写权限（必要时以管理员身份运行），或把项目移到用户可写位置',
              },
        );
      }
    }

    // ---- 声明值与 detected 不一致提示（§4.1：声明优先，渲染不受影响，仅提示）----
    const pairs: ReadonlyArray<readonly ['node' | 'python', string | undefined]> = [
      ['node', config.habits.runtime.node?.manager],
      ['python', config.habits.runtime.python?.manager],
    ];
    let mismatch = false;
    for (const [key, declared] of pairs) {
      if (declared === undefined) {
        continue;
      }
      const detected = detectedManagerOf(config.habits.detected, key);
      if (detected === undefined || detected === 'none') {
        continue; // 未探测到（detected 无快照 / none）：不算不一致
      }
      if (declared !== detected) {
        mismatch = true;
        results.push({
          section: 'environment',
          level: 'warn',
          item: `declared-vs-detected/${key}`,
          detail: `habits 声明 ${key}.manager=${declared}，但 detected 快照为 ${detected}`,
          hint: '声明字段优先于 detected（渲染不受影响）；如环境已变化可运行 aforge detect 刷新快照',
        });
      }
    }
    if (!mismatch) {
      results.push({
        section: 'environment',
        level: 'ok',
        item: 'declared-vs-detected',
        detail: '声明的 node/python manager 与 detected 快照一致（或无可比项）',
      });
    }
  }

  // ---- OneDrive 检测（§2.1.1 → warn）----
  if (env.userProfile !== undefined && env.userProfile !== '') {
    if (detectOneDrive(env.userProfile, host)) {
      results.push({
        section: 'environment',
        level: 'warn',
        item: 'onedrive',
        detail: `用户目录处于 OneDrive 同步范围: ${env.userProfile}`,
        hint: '建议把 AGF_HOME 与项目目录移出 OneDrive（文件锁 / 占位符状态可能导致投影写入失败）',
      });
    } else {
      results.push({
        section: 'environment',
        level: 'ok',
        item: 'onedrive',
        detail: '未检测到 OneDrive 同步（用户目录不在 OneDrive 范围内）',
      });
    }
  }

  return { results, exitCode: doctorExitCode(results) };
}
