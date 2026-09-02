/**
 * 合并结果的出口校验（填充 schema 默认值），失败包成 **ConfigError(2)**。
 *
 * 为什么不能直接 `ProfileSchema.parse`：跨层不变式（如 `skills.always` 与
 * `skills.on_demand` 交集非空——user 层写了 always、project 层写了 on_demand 时
 * 单层各自都合法）只有在合并后才暴露，裸 ZodError 走 errors.toExitCode 会退化成
 * GenericError(1) + 裸堆栈，与 loadProfile 里逐层校验失败的 ConfigError(2) 不一致。
 *
 * @throws ConfigError(2) 合并后的 profile 校验失败（附字段路径与逐条 issue）。
 */
function parseMergedProfile(
  merged: ProfileInput,
  userSoTRoot: string,
  projectSoTRoot: string,
): Profile {
  const result = ProfileSchema.safeParse(merged);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues;
  const lines = issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
  throw new ConfigError(
    `user + project 两层合并后的 profile 校验失败，共 ${issues.length} 处问题:\n${lines.join('\n')}`,
    {
      hint: '按上述字段路径修正任一层的 profile.yaml（跨层合并后才暴露的冲突需要两层一起看）',
      details: { userSoTRoot, projectSoTRoot, issues },
    },
  );
}

/**
 * 三层装配入口（Spec §4.2 / §2.4）。
 *

 * 优先级（高 → 低）：
 *   env（AGF_LINE_ENDING 等） > project 层文件 > user 层文件 > 内置默认
 *
 * resolveEffectiveConfig 是配置消费的唯一入口：
 * - 在 z.input 形态上完成 user/project 合并（保留"未设置"语义）；
 * - 出口统一做 Schema.parse 填充 schema 默认值 → 返回完整形态，
 *   消费端（sync/status 等）无需再判空；
 * - 无任何配置文件时返回内置默认（init 落盘与全新环境装配共用同一来源）。
 */
import type { Host } from '../../infra/host';
import type { Habits, HabitsInput, Profile, ProfileInput } from '../../schema';
import { HabitsSchema, ProfileSchema } from '../../schema';
import type { EnvSnapshot, Scope } from '../env';
import { ConfigError } from '../errors';
import { loadHabits, loadProfile } from './load';
import { type MergeOptions, mergeHabits, mergeProfiles } from './merge';

/**
 * Spec §4.2 "Windows 安装默认值" 代码块（逐字段对齐）。
 * init 写盘与"无任何配置文件"时的兜底装配共用，保证两处永不漂移。
 */
export function windowsDefaultProfile(): ProfileInput {
  return {
    version: 1,
    scope: 'project',
    targets: ['opencode', 'codex', 'claude', 'pi'],
    templates: ['base/default'],
    skills: { copy_mode: 'copy' },
    projection: { marker_mode: 'replace_between_markers', line_ending: 'lf' },
    learning: { default_scope: 'project', auto_promote: false },
  };
}

/** habits 空骨架（init 用；detected 由探测器填充，Spec §7.1）。 */
export function defaultHabits(): HabitsInput {
  return { version: 1, detected: {} };
}

/** 三层装配结果：profile/habits 为完整形态，scope/根目录为本次装配上下文。 */
export interface EffectiveConfig {
  readonly profile: Profile;
  readonly habits: Habits;
  readonly userSoTRoot: string;
  readonly projectSoTRoot: string;
  readonly effectiveScope: Scope;
}

/**
 * 三层装配入口：加载 user/project 两层 SoT → 按 §4.2 合并 → 填充默认值 → 应用 env 覆盖。
 *
 * - 合并选项取"更高层级"（project 层优先）的 merge 声明；两层都未声明时
 *   使用 schema 默认（overlay / replace）；
 * - env 覆盖：AGF_LINE_ENDING 覆盖 projection.line_ending（Spec §2.4）；
 * - effectiveScope：AGF_SCOPE 强制 > project 层在用 > user 层在用 > 内置默认 project；
 * - 任一层配置损坏（YAML 语法 / 校验失败）时向上抛 ConfigError(2)（fail-fast，
 *   不静默降级到默认值）。
 */
export async function resolveEffectiveConfig(
  env: EnvSnapshot,
  userSoTRoot: string,
  projectSoTRoot: string,
  host: Host,
): Promise<EffectiveConfig> {
  const [userProfile, projectProfile, userHabits, projectHabits] = await Promise.all([
    loadProfile(host, userSoTRoot),
    loadProfile(host, projectSoTRoot),
    loadHabits(host, userSoTRoot),
    loadHabits(host, projectSoTRoot),
  ]);

  // 合并策略由更高层级（project）声明；两层都未声明 → schema 默认
  const declared = projectProfile?.merge ?? userProfile?.merge;
  const opts: MergeOptions = {
    strategy: declared?.strategy ?? 'overlay',
    arrays: declared?.arrays ?? 'replace',
  };

  const mergedProfile: ProfileInput =
    userProfile === null && projectProfile === null
      ? windowsDefaultProfile()
      : mergeProfiles(userProfile, projectProfile, opts);
  const mergedHabits: HabitsInput =
    userHabits === null && projectHabits === null
      ? defaultHabits()
      : mergeHabits(userHabits, projectHabits, opts);

  // 出口统一填充 schema 默认值（此后对象为完整形态，消费端不再判空）
  const profile = parseMergedProfile(mergedProfile, userSoTRoot, projectSoTRoot);
  const habits = HabitsSchema.parse(mergedHabits);

  // env 覆盖（Spec §2.4）：AGF_LINE_ENDING > 文件声明 > 内置默认
  if (env.lineEnding !== undefined) {
    profile.projection.line_ending = env.lineEnding;
  }

  // 有效 scope：AGF_SCOPE 强制 > project 层在用 > user 层在用 > 内置默认 project
  const projectInUse = projectProfile !== null || projectHabits !== null;
  const userInUse = userProfile !== null || userHabits !== null;
  const effectiveScope: Scope =
    env.agfScope ?? (projectInUse ? 'project' : userInUse ? 'user' : 'project');

  return { profile, habits, userSoTRoot, projectSoTRoot, effectiveScope };
}
