/**
 * skill 名规则与 `skills.always` 登记（Spec §4.2 / §7.6）。
 *
 * 这条缝划在"文件搬运"与"profile 登记"之间：sources/skill 只管把 skill 目录实体
 * copy 进 SoT，登记则要读改写目标层 profile.yaml、并因此要持 SoT 事务锁。两件事
 * 唯一的共享物是 skill 名的合法性规则，所以规则连同登记一起放在这个叶模块里，
 * sources/skill 反向依赖它（而不是它依赖 sources/skill）——否则 re-export 会成环。
 */
import type { Host } from '../../infra/host';
import {
  editProfile,
  editProfileLocked,
  editProfileStringArray,
  type ProfileStringArrayField,
} from '../config/edit-profile';
import type { TargetLayer } from '../config/target-layer';
import { ConfigError } from '../errors';
import type { OsContext } from '../paths';

/** skill 名安全校验（目录名）：字母数字开头，可含字母数字/./_/-，总长 ≤64。 */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 校验 skill 名（目录名安全）。@throws ConfigError(2) 名字非法。 */
export function validateSkillName(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new ConfigError(
      `非法 skill 名: ${name}（须以字母或数字开头，长度 1-64，仅含字母数字、点、下划线、连字符）`,
      {
        hint: 'skill 名同时是 SoT 下的目录名（skills/<name>/），不能包含路径分隔符等字符',
        details: { name },
      },
    );
  }
}

/** setSkillAlways 结果。 */
export interface SetSkillAlwaysResult {
  readonly name: string;
  /** 编辑的 profile.yaml 绝对路径。 */
  readonly profileFile: string;
  /** 修改后的 skills.always 数组（写入值）。 */
  readonly always: string[];
  /** 本次是否实际改动（登记时已含 / 摘除时本就不含 → false，写盘幂等）。 */
  readonly changed: boolean;
}

/** `skills.always` 的字段访问器（两个变体共用，避免登记语义分叉）。 */
const SKILLS_ALWAYS_FIELD: ProfileStringArrayField = {
  read: (profile) => profile.skills?.always,
  write: (profile, next) => ({ ...profile, skills: { ...profile.skills, always: next } }),
};

/**
 * 登记 / 摘除 skills.always 中的一个 skill 名（只改 profile.skills.always）。
 *
 * `skill add` 装完即调用（§4.2：sync 只投影 skills.always 点到的名字）。登记进
 * **安装的那一层**——与 copy 的目标层同源，两者不会分叉。注意 §5.3 的合并语义：
 * `merge.arrays: replace`（缺省）下 project 层的 skills.always 整体覆盖 user 层，
 * 故装到 user 层的 skill 在"project 层自己也写了 always"的项目里不会生效。
 *
 * @param os 宿主平台（透传给 editProfile 决定锁目录的长路径归一）；缺省由
 *        editProfile 取当前进程平台，跨平台用例必须显式注入。
 * @throws ConfigError(2) 名字非法 / 目标层 profile.yaml 损坏 / 修改后校验失败。
 * @throws ConflictError(3) 取不到 SoT 事务锁（editProfile 契约）。
 */
export async function setSkillAlways(
  host: Host,
  targetLayer: TargetLayer,
  name: string,
  always: boolean,
  os?: OsContext,
): Promise<SetSkillAlwaysResult> {
  validateSkillName(name);
  const result = await editProfileStringArray(
    (mutate) => editProfile(host, targetLayer, mutate, os),
    SKILLS_ALWAYS_FIELD,
    name,
    always,
  );
  return { name, profileFile: result.profileFile, always: result.next, changed: result.changed };
}

/**
 * setSkillAlways 的**内层**版本：同一段登记，但走 editProfileLocked（不再自持锁）。
 *
 * 供**已持有 targetLayer.sotRoot 事务锁**的调用方使用——`skill add` 把
 * 「copy → 登记 → 失败回滚」整段包进一次 withSotLock（见 commands/skill.runSkillAdd），
 * 内层若再走 editProfile 会撞自己刚建的锁目录（非递归目录锁）而抛 ConflictError(3)。
 *
 * @throws ConfigError(2) 名字非法 / profile.yaml 损坏 / 修改后校验失败。
 */
export async function setSkillAlwaysLocked(
  host: Host,
  targetLayer: TargetLayer,
  name: string,
  always: boolean,
): Promise<SetSkillAlwaysResult> {
  validateSkillName(name);
  const result = await editProfileStringArray(
    (mutate) => editProfileLocked(host, targetLayer, mutate),
    SKILLS_ALWAYS_FIELD,
    name,
    always,
  );
  return { name, profileFile: result.profileFile, always: result.next, changed: result.changed };
}
