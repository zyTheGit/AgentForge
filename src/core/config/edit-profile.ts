/**
 * profile.yaml 定点编辑（Spec §7.6 / §4.2）。
 *
 * `mcp add` / `template enable|disable` 这类命令的写盘序列完全一致：
 * 读目标层 profile.yaml（缺失 → 最小缺省）→ 改一个字段 → 全量校验 → YAML
 * 序列化（lineWidth:0，不折行）→ 补尾换行 → 原子写入。各管理器只在"改哪个
 * 字段"上不同，故把整段序列收敛到 editProfile，管理器只提供 mutate 回调。
 *
 * 语义要点（保持与原先各自实现一致）：
 * - 编辑 z.input 原始形态往返：**不展开默认值**，用户未设置的键不会被写出；
 * - 写入前 `ProfileSchema.parse` 全量校验（防把 profile 写坏；同时把填充默认值
 *   后的完整形态回给调用方，用于结果展示）；
 * - 落盘的是 mutate 返回的原始形态，不是 parse 后的形态；
 * - **无改动即不写盘**：mutate 返回 null 时跳过 atomicWrite（见下）。
 *
 * 为什么"无改动不写"是必须的：这里的写盘是 YAML **重新序列化**，注释、空行、
 * 行内数组风格（`targets: [claude]`）都会丢失，键顺序变成对象插入顺序。内容幂等
 * 的操作（重复 `skill add` 同名 skill）若照样写盘，在 git 里就是一次纯格式 diff。
 * 注释保真需要改用 yaml Document API 做定点编辑，不在本函数范围内。
 *
 * 并发：「读 → 改 → 写」整段在**SoT 事务锁**内执行
 * （project/sync-lock.withSotLock，与 sync 同一把 `.sync.lock`）。无锁时两个并发
 * `mcp add` / `template enable` 会各自读到旧 profile 再全量覆盖，后写者静默丢掉
 * 前者的字段；与 sync 并发时同样会被 sync 的过期备份覆盖。
 *
 * 依赖方向：锁原语**直接从 project/sync-lock 取**，不经 project/engine 转出口——
 * engine 顶层 import 了 sources/skill，而 sources/skill 又 import 本模块，走 engine
 * 会形成 `sources/skill → config/edit-profile → project/engine → sources/skill`
 * 运行时环（ESM 下靠"求值时不调用"侥幸能跑，打包重排后就是 undefined is not a function）。
 */
import { atomicWrite } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import { type Profile, type ProfileInput, ProfileSchema } from '../../schema';
import { ConfigError } from '../errors';
import { currentOs, type OsContext } from '../paths';
import { withSotLock } from '../project/sync-lock';
import { loadProfile } from './load';
import { serializeYamlDoc } from './serialize';
import type { TargetLayer } from './target-layer';

/**
 * 目标层缺少 profile.yaml 时使用的最小缺省（每次调用返回新对象，避免共享引用）。
 * 与 `aforge init` 的产物同口径：仅 version + 默认 target。
 */
export function newProfileDefaults(): ProfileInput {
  return { version: 1, targets: ['opencode'] };
}

/** editProfile 结果。 */
export interface EditProfileResult {
  /** 目标层 profile.yaml 绝对路径（changed=false 时该文件可能并不存在）。 */
  readonly profileFile: string;
  /** 落盘的 z.input 原始形态（mutate 返回 null 时为读入的原形态）。 */
  readonly written: ProfileInput;
  /** 校验并填充默认值后的完整形态（供调用方读回写入结果）。 */
  readonly parsed: Profile;
  /** 本次是否真的写了盘（mutate 返回 null → false）。 */
  readonly changed: boolean;
}

/**
 * 编辑目标层 profile.yaml 的一个字段并落盘（读-改-写整段持 SoT 事务锁）。
 *
 * @param mutate 纯函数：接收当前（或缺省）原始形态，返回修改后的原始形态；
 *        **返回 null 表示无改动** → 跳过写盘（不产生纯格式 diff，见模块头）。
 *        不要在回调里做 IO；不要原地修改入参（返回新对象）。
 *        允许**抛 ConfigError(2)** 表达「本次编辑的前置条件不成立」（如
 *        `mcp remove` 发现目标名不在该层）——异常在 atomicWrite 之前冒泡，
 *        故此时一个字节都不会写盘，详见 editProfileLocked。
 * @param os 宿主平台（决定锁目录的长路径归一）；缺省取当前进程平台，测试请显式注入。
 * @throws ConfigError(2) 目标层 profile.yaml 损坏（loadProfile 抛出）/ 修改后整体校验失败
 *         / mutate 自己抛出的前置条件错误（原样冒泡，不被包装）。
 * @throws ConflictError(3) 取不到 SoT 事务锁（另一个 aforge 正在写同一 SoT）。
 */
export async function editProfile(
  host: Host,
  targetLayer: TargetLayer,
  mutate: (profile: ProfileInput) => ProfileInput | null,
  os: OsContext = currentOs(),
): Promise<EditProfileResult> {
  return withSotLock(host, targetLayer.sotRoot, os, () =>
    editProfileLocked(host, targetLayer, mutate),
  );
}

/**
 * editProfile 的**内层**实现：同一段读-改-写，但**自己不取锁**。
 *
 * 给"已经持有同一个 `<sotRoot>/.sync.lock` 的调用方"用（`skill add` 把 copy +
 * 登记 + 回滚整段包进一次 withSotLock，见 commands/skill.runSkillAdd）。锁是
 * 非递归的目录锁：同一进程在锁内再调 editProfile 会撞自己刚建的锁目录，
 * 因 acquiredAt 恒新鲜而直接抛 ConflictError(3)——不是死等，但同样走不通。
 *
 * 调用方必须**已持有 targetLayer.sotRoot 的锁**；不确定时用 editProfile。
 *
 * mutate 抛出的异常在 `atomicWrite` **之前**冒泡（顺序：loadProfile → mutate →
 * assertValidProfile → atomicWrite），因此 mutate 里用 ConfigError 表达「前置条件
 * 不成立」是安全的——`mcp remove` 的「目标名不在该层」判据就落在那里，profile.yaml
 * 一个字节都不会被改写。
 *
 * @throws ConfigError(2) profile.yaml 损坏 / 修改后整体校验失败（见 assertValidProfile）
 *         / mutate 自己抛出的前置条件错误（原样冒泡）。
 */
export async function editProfileLocked(
  host: Host,
  targetLayer: TargetLayer,
  mutate: (profile: ProfileInput) => ProfileInput | null,
): Promise<EditProfileResult> {
  const existing = await loadProfile(host, targetLayer.sotRoot);
  const before = existing ?? newProfileDefaults();
  const mutated = mutate(before);
  const written = mutated ?? before;
  // 校验不受"是否写盘"影响：无改动时也要保证当前形态合法（并回给调用方 parsed）
  const parsed = assertValidProfile(written, targetLayer.profileFile);

  if (mutated !== null) {
    await atomicWrite(host, targetLayer.profileFile, serializeYamlDoc(written));
  }

  return { profileFile: targetLayer.profileFile, written, parsed, changed: mutated !== null };
}

/**
 * 写入前全量校验，失败包成 **ConfigError(2)**。
 *
 * 为什么不让裸 ZodError 上抛：errors.toExitCode 对非 AgentForgeError 返回
 * Generic(1)，而 `skill add` / `template enable` / `mcp add` 的文档承诺都是
 * "校验失败 → 退出码 2"。包装后退出码与文档一致，且 issue 摘要与 config/load
 * 的坏 YAML 报错同一形态（字段路径 + 逐条 message）。
 */
function assertValidProfile(written: ProfileInput, profileFile: string): Profile {
  const result = ProfileSchema.safeParse(written);
  if (!result.success) {
    const issues = result.error.issues;
    const lines = issues.map((issue) => {
      const at = issue.path.filter((seg) => typeof seg !== 'symbol').join('.') || '(根)';
      return `  - ${at}: ${issue.message}`;
    });
    throw new ConfigError(
      `修改后的 profile.yaml 校验失败（${profileFile}），共 ${issues.length} 处问题:\n${lines.join('\n')}`,
      {
        hint: '按上述字段路径修正入参或 profile.yaml；字段结构与枚举见 schemas/ 下的 JSON Schema 工件',
        details: { file: profileFile, issues },
      },
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// profile 内「字符串数组字段」的登记 / 摘除（skills.always / templates 共用）
// ---------------------------------------------------------------------------

/**
 * 一个字符串数组字段的读写访问器（调用方只提供"改哪个字段"）。
 *
 * setter 必须返回**新对象**（不得原地改入参）——editProfile 的 mutate 契约要求纯函数。
 */
export interface ProfileStringArrayField {
  readonly read: (profile: ProfileInput) => readonly string[] | undefined;
  readonly write: (profile: ProfileInput, next: string[]) => ProfileInput;
}

/**
 * 读-改-写的执行者：`editProfile`（自取锁）或 `editProfileLocked`（复用调用方的锁）。
 *
 * 做成参数而不是布尔开关：走哪条路径取决于"调用方是否已持有该 SoT 根的锁"，这个
 * 事实只有调用点知道，在调用点写成 `editProfileLocked(...)` 比传 `locked: true`
 * 更难写错（非递归目录锁，选错即 ConflictError(3)）。
 */
export type ProfileEditRunner = (
  mutate: (profile: ProfileInput) => ProfileInput | null,
) => Promise<EditProfileResult>;

/** editProfileStringArray 结果（调用方据此拼各自的对外结果类型）。 */
export interface ProfileStringArrayEditResult {
  readonly profileFile: string;
  /** 修改后的数组（写入值；无改动时为当前值的副本）。 */
  readonly next: string[];
  /** 本次是否实际改动（登记时已含 / 摘除时本就不含 → false，写盘幂等）。 */
  readonly changed: boolean;
}

/**
 * 在 profile 的某个字符串数组字段里登记 / 摘除一个值（幂等语义的唯一实现）。
 *
 * `skill add`（skills.always）与 `template enable|disable`（templates）除"改哪个
 * 字段"外完全同构，原先各写一遍：同样的外部 let 捕获、同样的三元 include 判定、
 * 同样的「changed 才返回新对象否则 null」约定。**null 分支是必须的**——内容幂等的
 * 操作若照样写盘，就是一次纯格式 diff（YAML 重新序列化会丢注释与行内数组风格，
 * 见模块头）。任一处漏掉都会静默退化，故收敛到这里一处。
 *
 * @param add true = 登记（已存在则不动）；false = 摘除（不存在则不动）。
 * @throws ConfigError(2) profile.yaml 损坏 / 修改后校验失败（runner 契约）。
 * @throws ConflictError(3) 取不到 SoT 事务锁（仅 editProfile 路径）。
 */
export async function editProfileStringArray(
  runner: ProfileEditRunner,
  field: ProfileStringArrayField,
  value: string,
  add: boolean,
): Promise<ProfileStringArrayEditResult> {
  // mutate 须为纯函数，但结果（写入值 / 是否改动）要回给调用方，故用闭包带出来
  let next: string[] = [];
  let changed = false;
  const { profileFile } = await runner((profile) => {
    const current = field.read(profile) ?? [];
    next = add
      ? current.includes(value)
        ? [...current]
        : [...current, value]
      : current.filter((item) => item !== value);
    changed = next.length !== current.length;
    return changed ? field.write(profile, next) : null;
  });
  return { profileFile, next, changed };
}
