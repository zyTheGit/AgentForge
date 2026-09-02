/**
 * `aforge status` 的 learning 一节（Spec §7.4 auto_capture 的声明值 / 生效值 + hook 档支持度）。
 *
 * 单独成模块的理由与 ./status-sources 同源——文件预算：status.ts 已顶到
 * `npm run lint:size` 的 500 行卡口，而"auto_capture 怎么算、怎么排版"与 status 的
 * 其余部分（scope / 投影路径 / 计数 / 源登记）没有共享状态，是一条干净的缝。
 *
 * 一条硬约束：**"声明了但不生效"必须可见**。auto_capture 三档现在都各自生效，
 * 但 `hook` 档的降级发生在 **target 粒度**（只有部分 projector 有钩子落点），
 * 不逐家列出的话，用户声明了 hook 却什么都没发生，且无从知道原因。
 */
import {
  type AutoCaptureState,
  LEARNING_PROTOCOL_HEADING,
  rendersLearningProtocol,
  resolveAutoCapture,
  writesSessionHooks,
} from '../../core/learning/auto-capture';
import { SESSION_HOOK_EVENT } from '../../core/learning/hook-capture';
import { projectorRegistry } from '../../core/project/projectors/registry';
import { partitionSessionHookTargets } from '../../core/project/sync-notices';
import { getUi, type Ui } from '../../infra/ui';
import type { AutoCapture, Profile } from '../../schema';
import { renderList } from '../_shared/context';

/**
 * profile.learning.auto_capture 在 status 里的呈现（`--json` 的对外结构）。
 *
 * 三档现在都各自生效，declared 与 effective 恒等（保留两个字段：将来若再引入
 * 需要归并的档位，"声明了但被降级"这件事必须可见）。`hook` 档的降级发生在
 * **target 粒度**：hookTargets / hookUnsupportedTargets 如实列出钩子装到哪几家、
 * 哪几家等同 off。`ciNote` 另说一件事——CI 下 learnings 恒不落盘，但**生效档位
 * 与投影正文不变**（否则 contentHash 跨环境不稳定）。
 */
export interface StatusAutoCaptureInfo {
  readonly declared: AutoCapture;
  readonly effective: AutoCapture;
  readonly reason: string | null;
  readonly ciNote: string | null;
  /** hook 档下会被写入会话钩子的已启用 target（非 hook 档为空数组）。 */
  readonly hookTargets: readonly string[];
  /** hook 档下没有钩子落点、行为等同 off 的已启用 target（非 hook 档为空数组）。 */
  readonly hookUnsupportedTargets: readonly string[];
}

/**
 * 解析 auto_capture 的展示状态（纯计算、零 IO）。
 *
 * @param profile 生效 profile（档位的唯一事实源，见 core/learning/auto-capture）。
 * @param env 只用来判 CI（不改变生效档位）。
 * @param plannedTargetIds 本次**注册表命中**的 target id，与 sync 侧 engine 传 planned
 *   的口径一致：profile.targets 里写了注册表没有的名字时根本不会被投影，替它报
 *   「没有钩子落点」是错的。
 */
export function collectStatusAutoCapture(
  profile: Profile,
  env: { readonly ci: boolean },
  plannedTargetIds: readonly string[],
): StatusAutoCaptureInfo {
  const state = resolveAutoCapture(profile, env);
  // §7.4 hook 档的支持度按 target 粒度报（能力声明在各 projector 上，不做环境探测）
  const hookSplit = partitionSessionHookTargets(
    writesSessionHooks(state.effective),
    plannedTargetIds,
    projectorRegistry.list(),
  );
  return {
    declared: state.declared,
    effective: state.effective,
    reason: describeAutoCaptureReason(state, hookSplit),
    ciNote: describeAutoCaptureCiNote(state),
    hookTargets: hookSplit.capable,
    hookUnsupportedTargets: hookSplit.incapable,
  };
}

/**
 * hook 档下"这次到底会不会装上钩子"的一句话说明（其余档位 → null）。
 *
 * 只在**一家都装不上**时才出这句：此时声明了 hook 却整体等同 off，不说等于静默。
 * 部分支持的情况由 hookTargets / hookUnsupportedTargets 两张名单自己表达
 * （formatStatusLearning 逐行打印），不再重复一句概括。
 */
function describeAutoCaptureReason(
  state: AutoCaptureState,
  hookSplit: { readonly capable: readonly string[] },
): string | null {
  if (!writesSessionHooks(state.effective) || hookSplit.capable.length > 0) {
    return null;
  }
  return 'no enabled target supports session hooks - behaves as off';
}

/**
 * 当前环境下会不会真的采集（非 CI → null）。
 *
 * 与 reason 分开：CI 只挡*写入*（§7.4 护栏 3），不改变生效档位与投影正文——
 * 否则同一份 SoT 在 CI 与本地会渲染出不同的 contentHash。
 */
function describeAutoCaptureCiNote(state: AutoCaptureState): string | null {
  return state.ciNoCapture
    ? 'CI detected - no learnings will be written (projected rules are unchanged)'
    : null;
}

/** auto_capture 附加说明行的缩进（对齐首行 `auto_capture: ` 之后的值列）。 */
const NOTE_INDENT = ' '.repeat(16);

/** status 的 `learning (profile.learning):` 一节。 */
export function formatStatusLearning(capture: StatusAutoCaptureInfo, ui: Ui = getUi()): string[] {
  const lines = [ui.bold('learning (profile.learning):')];
  // 声明值与生效值分开打：将来若再引入被归并的档位，只打一个会骗人
  const arrow = capture.declared === capture.effective ? '' : ` -> ${ui.yellow(capture.effective)}`;
  lines.push(`  ${ui.dim('auto_capture')}: ${capture.declared}${arrow}`);
  if (capture.reason !== null) {
    lines.push(`${NOTE_INDENT}${ui.dim(capture.reason)}`);
  }
  if (rendersLearningProtocol(capture.effective)) {
    lines.push(
      `${NOTE_INDENT}${ui.dim(`projected rules include a ${LEARNING_PROTOCOL_HEADING} section`)}`,
    );
  }
  // hook 档：钩子装到哪几家、哪几家没有落点（等同 off）——两张名单都要可见
  if (capture.hookTargets.length > 0) {
    lines.push(
      `${NOTE_INDENT}${ui.dim(`session hook (${SESSION_HOOK_EVENT}) written for: ${renderList(capture.hookTargets)}`)}`,
    );
  }
  if (capture.hookUnsupportedTargets.length > 0) {
    lines.push(
      `${NOTE_INDENT}${ui.yellow(`no session hook target: ${renderList(capture.hookUnsupportedTargets)} (behaves as off)`)}`,
    );
  }
  if (capture.ciNote !== null) {
    lines.push(`${NOTE_INDENT}${ui.dim(capture.ciNote)}`);
  }
  return lines;
}
