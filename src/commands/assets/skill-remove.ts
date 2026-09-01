/**
 * `aforge skill remove <name>` 的核心逻辑（Spec §7.6 profile-only 摘除）。
 *
 * 从 commands/assets/skill.ts 抽出成独立模块：add / list 是「装东西 + 列东西」，remove 是
 * 「摘登记 + 在摘不到时把用户引导回正确的层」，后者的分量几乎全在错误分支上——
 * 一个三选一的 hint 决策 + 两次只读探测（本层 skill 目录是否还在、另一层是否登记了
 * 同名）。这些细节与 add/list 没有任何共享状态，留在同一文件只会让 skill.ts 持续
 * 逼近 500 行卡口（AGENTS.md / Spec §11.3）。
 *
 * 本模块只做「算结果 / 抛错」，不打印：命令注册与输出渲染仍在 commands/assets/skill.ts，
 * 且原路径的导出面通过 re-export 保持不变。
 */
import path from 'node:path';
import { loadProfile } from '../../core/config/load';
import { resolveWriteTargetLayer, type TargetLayer } from '../../core/config/target-layer';
import { readEnv, type Scope } from '../../core/env';
import { ConfigError } from '../../core/errors';
import { SKILLS_DIRNAME } from '../../core/paths';
import { withSotLock } from '../../core/project/sync-lock';
import { setSkillAlwaysLocked, validateSkillName } from '../../core/sources/skill';
import type { Host } from '../../infra/host';
import { otherScope, sotRootFor } from '../_shared/context';
// 仅类型导入：编译后被擦除，因此与 commands/assets/skill.ts 的 re-export 不构成运行时环依赖
import type { SkillCommandContext } from './skill';

/** skill remove 结果（profile-only：磁盘目录不动）。 */
export interface SkillRemoveResult {
  readonly name: string;
  /** 实际编辑的那一层（供输出与脚本判层）。 */
  readonly scope: Scope;
  readonly profileFile: string;
  /** 摘除后的 skills.always（可能为空数组）。 */
  readonly always: string[];
  /** 恒 true：`changed=false`（该层没登记过）已在此前抛 ConfigError(2)。 */
  readonly changed: true;
  /** SoT 里那个 skill 目录的绝对路径（**未被删除**，见 skillDirKept）。 */
  readonly skillDir: string;
  /** 恒 true：remove 只改 profile，全程不碰磁盘目录（行为承诺，非存在性断言）。 */
  readonly skillDirKept: true;
}

/**
 * 另一层的 skills.always 里是否有这个名字（供「层选错了」的 hint 给出具体 --scope 值）。
 *
 * 只读探测，失败一律按 false：另一层 profile.yaml 损坏 / 不可读**不该**掩盖本次
 * 「该层没登记」这个真正的错误，最坏结果只是 hint 退化成泛化措辞。
 */
async function otherLayerHasSkill(
  host: Host,
  otherSotRoot: string,
  name: string,
): Promise<boolean> {
  try {
    return (await loadProfile(host, otherSotRoot))?.skills?.always?.includes(name) === true;
  } catch {
    return false;
  }
}

/** 生成 hint 所需的三个探测结果（全部由调用方在锁外算好后传入）。 */
interface SkillRemoveProbes {
  /** SoT 里那个 skill 目录当前是否还在盘上。 */
  readonly skillDirExists: boolean;
  /** 另一层的 scope 值（hint 里那个可复制的 `--scope <另一层>`）。 */
  readonly otherScopeId: Scope;
  /** 另一层的 skills.always 是否登记了同名。 */
  readonly otherScopeHasSkill: boolean;
}

/**
 * 「该层 skills.always 里没有这个名字」→ ConfigError(2)。
 *
 * 判据放在命令层而不是 skill-registry：错误消息要给出 `skills\<name>\` 的绝对
 * 路径，那是安装布局知识（目标层 SoT 根 + SKILLS_DIRNAME），不属于「改 profile
 * 某个字符串数组」这一职责。
 *
 * hint 三选一，优先级从高到低（每种情形对应一个不同的下一步动作）：
 * 1. **另一层登记了同名** → 用户选错了层，直接给出可复制的 `--scope <另一层>`；
 *    泛化的「运行 aforge skill list」要用户自己再推一次，是这条命令最常见的误用；
 * 2. 目录还在盘上 → 用户多半想「删掉重装」，必须提醒 `skill add` 遇已存在目录会
 *    报 ConflictError(3)；
 * 3. 都没有 → 名字大概记错了，指向 `skill list` 看两层实际装了什么。
 *
 * 两次只读探测（`host.exists(skillDir)` 与另一层 profile）由调用方在**锁外**做完、
 * 结果经 probes 传入：它们唯一的用途就是这段 hint，放进锁内只会白白拉长
 * `.sync.lock` 的持有窗口，让并发 `aforge sync` 更容易撞 ConflictError(3)（与
 * runMcpRemove 同口径）。因此本函数是同步纯函数，不做任何 IO。
 */
function skillNotRegisteredError(
  name: string,
  targetLayer: TargetLayer,
  skillDir: string,
  always: readonly string[],
  probes: SkillRemoveProbes,
): ConfigError {
  const { skillDirExists, otherScopeId, otherScopeHasSkill } = probes;
  const hint = otherScopeHasSkill
    ? `该 skill 登记在 ${otherScopeId} 层而不是 ${targetLayer.scope} 层：改用 aforge skill remove ${name} --scope ${otherScopeId}`
    : skillDirExists
      ? [
          `该 skill 未登记在 ${targetLayer.scope} 层 skills.always；目录仍在磁盘上: ${skillDir}。`,
          '若要重新安装，先手动删除该目录（aforge skill add 遇已存在目录会报 ConflictError(3)）',
        ].join('')
      : `该 skill 未登记在 ${targetLayer.scope} 层 skills.always，磁盘上也没有 ${skillDir}；运行 aforge skill list 查看两层已安装的 skill`;
  return new ConfigError(`skills.always 中不存在该 skill: ${name}（${targetLayer.profileFile}）`, {
    hint,
    details: {
      name,
      scope: targetLayer.scope,
      profileFile: targetLayer.profileFile,
      skillDir,
      skillDirExists,
      otherScope: otherScopeId,
      otherScopeHasSkill,
      always: [...always],
    },
  });
}

/**
 * skill remove 核心逻辑（可注入、不打印）：**只**摘 profile.skills.always。
 *
 * 磁盘上的 `skills\<name>\` 一律保留——remove 路径不引入任何删除 API。理由：
 * skill 目录可能被用户手工改过（§5.3 已安装 skill 以 SoT 为准），而"从投影里去掉
 * 一个 skill"只需要 profile 不再点到它；真要腾空间，删目录是一次显式的人工操作。
 *
 * **投影侧的清理时机**：摘除只作用于 SoT。各 agent 目录下的 `skills\<name>\SKILL.md`
 * 由**下一次 `aforge sync`** 删除——sync 按 sync-meta 上一轮记账的 `artifacts` 做差集
 * （Spec §7.6 prune），且只删内容仍与记账一致的那些；手工改过的产物保留并报进
 * `prune skipped`。命令输出据此指向 sync，并列出会被清理的路径。
 *
 * 锁边界：名字校验 / 目标层解析 / 路径拼接 / 两次只读探测都在锁外，
 * 「读 profile → 判存在 → 改 → 校验 → 写」整段在一次 withSotLock 内，故内层走
 * setSkillAlwaysLocked（自取锁的变体会撞自己刚建的锁目录，非递归目录锁）。
 * 先 validateSkillName 再取锁：非法名恒得退出码 2，不会被锁冲突的 3 抢先。
 *
 * 两次探测是**无条件**做的（哪怕本次会成功）：它们只喂失败分支的 hint，而失败判据
 * 要等锁内 mutate 才知道，那里是同步纯函数、不能 await。代价是两次小文件只读，换来
 * 锁窗口里不夹任何 hint 用途的 IO（口径同 runMcpRemove）。
 *
 * @throws ConfigError(2) 名字非法 / scope 层未 init / 该层 skills.always 无此名 /
 *         profile.yaml 损坏。
 * @throws ConflictError(3) 取不到 SoT 事务锁；
 * @throws PermissionError(4) SoT 根不可写（锁目录建不出来）/ profile.yaml 读不出来。
 */
export async function runSkillRemove(
  ctx: SkillCommandContext,
  name: string,
  options: { scope?: Scope } = {},
): Promise<SkillRemoveResult> {
  validateSkillName(name);
  const env = readEnv(ctx.host);
  const targetLayer = await resolveWriteTargetLayer(ctx.host, env, ctx.os, ctx.cwd, options.scope);
  const skillDir = path.join(targetLayer.sotRoot, SKILLS_DIRNAME, name);
  // 锁外探测：另一层的 SoT 根仅用于「该层没登记」的错误分支给出具体 --scope 值
  const otherScopeId = otherScope(targetLayer.scope);
  const probes: SkillRemoveProbes = {
    skillDirExists: await ctx.host.exists(skillDir),
    otherScopeId,
    otherScopeHasSkill: await otherLayerHasSkill(
      ctx.host,
      sotRootFor(ctx, env, otherScopeId),
      name,
    ),
  };
  return withSotLock(ctx.host, targetLayer.sotRoot, ctx.os, async () => {
    const removed = await setSkillAlwaysLocked(ctx.host, targetLayer, name, false);
    if (!removed.changed) {
      // changed=false 时 editProfileLocked 已跳过写盘（幂等分支），profile 一字未改
      throw skillNotRegisteredError(name, targetLayer, skillDir, removed.always, probes);
    }
    return {
      name,
      scope: targetLayer.scope,
      profileFile: removed.profileFile,
      always: removed.always,
      changed: true,
      skillDir,
      skillDirKept: true,
    };
  });
}
