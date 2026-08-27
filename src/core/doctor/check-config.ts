/**
 * 配置层诊断（Spec §9 第 4 条 + 初始化前置）：SoT 根解析、初始化状态、坏 YAML、
 * 三层配置装配。
 *
 * 为什么单独成模块：这四步是后续全部检查项的**前置条件**（拿不到根就无从谈路径，
 * 拿不到 EffectiveConfig 就无从谈投影），彼此按固定顺序共享同一组根路径，是天然
 * 的一簇；且它们全部只依赖 config/load 与 config/defaults，不碰 projector，与
 * consistency / environment 两簇的依赖面完全不同，分开后各文件的 import 面更窄。
 */
import path from 'node:path';
import type { Host } from '../../infra/host';
import { type EffectiveConfig, resolveEffectiveConfig } from '../config/defaults';
import { HABITS_FILE, loadHabits, loadProfile, PROFILE_FILE } from '../config/load';
import type { EnvSnapshot } from '../env';
import { ExitCode } from '../errors';
import { type OsContext, resolveProjectSoT, resolveUserSoT } from '../paths';
import { type DoctorCheckResult, errHint, errMessage, toDoctorCode } from './check-types';

/** 两层 SoT 根的解析结果（userSoTRoot 不可解析时为 undefined，见 userRootForLoad）。 */
export interface DoctorRoots {
  readonly userSoTRoot: string | undefined;
  readonly projectSoTRoot: string;
  /** 配置装载用的 user 根：user 根不可解析时以 project 根占位。 */
  readonly userRootForLoad: string;
}

/** 根目录解析（user 根不可解析（无用户目录 / UNC AGF_HOME）→ error）。 */
export function resolveDoctorRoots(
  results: DoctorCheckResult[],
  env: EnvSnapshot,
  os: OsContext,
  cwd: string,
): DoctorRoots {
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
  return { userSoTRoot, projectSoTRoot, userRootForLoad };
}

/**
 * 初始化检查（两层 SoT 是否有 profile/habits；全无 → error）。
 *
 * @returns 是否已初始化——false 时调用方须终止后续检查（配置全缺时后面每一项都会
 * 连锁报错，只会淹没"先跑 aforge init"这个唯一有用的结论）。
 */
export async function checkInitialization(
  host: Host,
  results: DoctorCheckResult[],
  roots: DoctorRoots,
): Promise<boolean> {
  const { userSoTRoot, projectSoTRoot } = roots;
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
  return initialized;
}

/** 实际存在的 SoT 层目录（只探测实际存在的层；不创建未初始化层）。 */
export async function existingSotDirs(host: Host, roots: DoctorRoots): Promise<string[]> {
  const sotDirs: string[] = [];
  if (roots.userSoTRoot !== undefined && (await host.exists(roots.userSoTRoot))) {
    sotDirs.push(roots.userSoTRoot);
  }
  if (await host.exists(roots.projectSoTRoot)) {
    sotDirs.push(roots.projectSoTRoot);
  }
  return sotDirs;
}

/**
 * 坏 YAML 检查（§9：逐文件报告损坏的 habits / profile）。
 *
 * @returns 四个文件是否全部可解析——false 时调用方跳过三层装配（错误已逐文件报告）。
 */
export async function checkYamlFiles(
  host: Host,
  results: DoctorCheckResult[],
  roots: DoctorRoots,
): Promise<boolean> {
  const { userRootForLoad, projectSoTRoot } = roots;
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
  return yamlOk;
}

/** 三层配置装配（失败 → error 并返回 undefined，后续投影相关检查整体跳过）。 */
export async function resolveConfigForDoctor(
  host: Host,
  results: DoctorCheckResult[],
  env: EnvSnapshot,
  roots: DoctorRoots,
): Promise<EffectiveConfig | undefined> {
  try {
    return await resolveEffectiveConfig(env, roots.userRootForLoad, roots.projectSoTRoot, host);
  } catch (err) {
    results.push({
      section: 'config',
      level: 'error',
      code: toDoctorCode(err),
      item: 'effective-config',
      detail: errMessage(err),
      hint: errHint(err) ?? '按错误信息修正 profile.yaml / habits.yaml 的合并结果',
    });
    return undefined;
  }
}
