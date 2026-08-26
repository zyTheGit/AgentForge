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
 * - 落盘的是 mutate 返回的原始形态，不是 parse 后的形态。
 *
 * 并发（round-2 修复）：「读 → 改 → 写」整段在**SoT 事务锁**内执行
 * （project/engine.withSotLock，与 sync 同一把 `.sync.lock`）。无锁时两个并发
 * `mcp add` / `template enable` 会各自读到旧 profile 再全量覆盖，后写者静默丢掉
 * 前者的字段；与 sync 并发时同样会被 sync 的过期备份覆盖。
 */
import { stringify as stringifyYaml } from 'yaml';
import { atomicWrite, ensureTrailingNewline } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import { type Profile, type ProfileInput, ProfileSchema } from '../../schema';
import { currentOs, type OsContext } from '../paths';
import { withSotLock } from '../project/engine';
import { loadProfile } from './load';
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
  /** 实际写入的 profile.yaml 绝对路径。 */
  readonly profileFile: string;
  /** 落盘的 z.input 原始形态（mutate 的返回值）。 */
  readonly written: ProfileInput;
  /** 校验并填充默认值后的完整形态（供调用方读回写入结果）。 */
  readonly parsed: Profile;
}

/**
 * 编辑目标层 profile.yaml 的一个字段并落盘（读-改-写整段持 SoT 事务锁）。
 *
 * @param mutate 纯函数：接收当前（或缺省）原始形态，返回修改后的原始形态。
 *        不要在回调里做 IO；不要原地修改入参（返回新对象）。
 * @param os 宿主平台（决定锁目录的长路径归一）；缺省取当前进程平台，测试请显式注入。
 * @throws ConfigError(2) 目标层 profile.yaml 损坏（loadProfile 抛出）。
 * @throws ConflictError(3) 取不到 SoT 事务锁（另一个 aforge 正在写同一 SoT）。
 * @throws ZodError 修改后整体校验失败（调用方按各自语义包装）。
 */
export async function editProfile(
  host: Host,
  targetLayer: TargetLayer,
  mutate: (profile: ProfileInput) => ProfileInput,
  os: OsContext = currentOs(),
): Promise<EditProfileResult> {
  return withSotLock(host, targetLayer.sotRoot, os, async () => {
    const existing = await loadProfile(host, targetLayer.sotRoot);
    const written = mutate(existing ?? newProfileDefaults());
    // 写入前全量校验（schema 层填充默认值，同时保证落盘形态合法）
    const parsed = ProfileSchema.parse(written);

    await atomicWrite(
      host,
      targetLayer.profileFile,
      ensureTrailingNewline(stringifyYaml(written, { lineWidth: 0 })),
    );

    return { profileFile: targetLayer.profileFile, written, parsed };
  });
}
