/**
 * learning.auto_capture 的口径解析与 `prompt` 档正文（Spec §4.2 / §7.4 / §5.2）。
 *
 * 为什么单独成模块：三档的**有效值**要在三个互不相邻的地方保持一致——渲染层
 * （composer 是否插 `## Learning Protocol` 段）、`aforge status`（如实展示生效档位
 * 与降级原因）、`aforge doctor`（`hook` 档未实现的告警）。把"声明值 → 有效值"的
 * 唯一判定放在这里，三处共用，避免各自 if 出三份略有差异的口径。
 *
 * 纯函数、不读 process.env：CI 判定由调用方从 EnvSnapshot 注入（与 composer 注入
 * os 的口径一致）。
 */
import type { AutoCapture, Profile } from '../../schema';

/** auto_capture 的有效状态（status / doctor / 渲染层共用）。 */
export interface AutoCaptureState {
  /** profile 里声明的档位（缺省 off）。 */
  readonly declared: AutoCapture;
  /** 实际生效的档位（CI 降级 + hook 未实现均反映在此）。 */
  readonly effective: AutoCapture;
  /** 因 CI 为真而降级（§7.4 护栏 3：不算错误，静默跳过并说明原因）。 */
  readonly ciDowngraded: boolean;
  /** 声明了 MVP 未实现的档位（当前仅 hook，§12 Phase 3）——行为等同 off。 */
  readonly unimplemented: boolean;
}

/**
 * 解析 auto_capture 的有效档位（Spec §7.4）。
 *
 * 两条降级来源，都不报错、只如实反映：
 * 1. **CI 为真 → off**（护栏 3）：§10「不在 CI 中写入 learnings」的延伸。`prompt`
 *    档在 CI 下即便渲染出来，agent 照着调 `aforge learn` 也会被 store 的 CI 守卫
 *    拒掉（ConfigError(2)），渲染一段注定失败的指令只会制造噪音。
 *    代价：同一 SoT 在 CI 与本地渲染出的正文不同（contentHash 因此不同）。可接受
 *    —— doctor 的 hash 比对在同一进程内取同一个 CI 值，跨环境比对本来就不成立。
 * 2. **hook 未实现 → off**：schema 收该值（避免既有 profile 加载失败），但 MVP 没有
 *    任何 target 侧钩子写入，语义上等同 off。与 `copy_mode: symlink` 同一处理口径：
 *    照旧接受，由 doctor 明说"声明了但当前不生效"。
 */
export function resolveAutoCapture(
  profile: Profile,
  env: { readonly ci: boolean },
): AutoCaptureState {
  const declared = profile.learning.auto_capture;
  if (env.ci) {
    return { declared, effective: 'off', ciDowngraded: true, unimplemented: declared === 'hook' };
  }
  if (declared === 'hook') {
    return { declared, effective: 'off', ciDowngraded: false, unimplemented: true };
  }
  return { declared, effective: declared, ciDowngraded: false, unimplemented: false };
}

/**
 * `## Learning Protocol` 段正文（Spec §5.2 / §7.4 `prompt` 档）。
 *
 * 固定内容、不受 SoT 影响：它是给 agent 的协议说明，不是用户沉淀。含触发条件
 * 与可直接复制的命令行；随 marker 区间整体替换，因此不产生独立产物、不进 §3.3 记账。
 *
 * 四条内容约束（对应 §7.4 的护栏）：
 * - 只让 agent 写 SoT（`aforge learn`），**不提** `aforge sync`——进投影恒由人工触发；
 * - 明说不要塞会话原文（凭据泄漏面 + 条目体积，护栏 4）；
 * - 不承诺晋升（`promote` 由人工或 auto_promote 决定，护栏 2）；
 * - 纯 ASCII 命令行，Windows 终端可直接粘。
 */
export const LEARNING_PROTOCOL_SECTION = `## Learning Protocol

When you and the user establish a durable convention during this session - a tool
choice, a project-specific gotcha, a workflow that must be repeated - record it so
future sessions inherit it. Skip one-off facts and anything already written down.

Write it with (content is read from stdin):

\`\`\`
aforge learn --file -
\`\`\`

Rules for what you write:

- Structured summary only: one convention per entry, phrased as an instruction.
- Never paste raw session transcripts, tool output, secrets or tokens.
- Recording does not activate the rule. Projection stays a human step
  (\`aforge sync\`), so do not run it yourself.`;
