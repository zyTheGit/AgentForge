/**
 * learning.auto_capture 的口径解析与 `prompt` 档正文（Spec §4.2 / §7.4 / §5.2）。
 *
 * 为什么单独成模块：三档的**有效值**要在三个互不相邻的地方保持一致——渲染层
 * （composer 是否插 `## Learning Protocol` 段）、`aforge status`（如实展示生效档位
 * 与当前环境下会不会真的采集）、`aforge doctor`（各档位的告警）。把
 * "声明值 → 有效值"的唯一判定放在这里，三处共用，避免各自 if 出三份略有差异的口径。
 *
 * 两个出口刻意分开：**effectiveAutoCapture 与环境无关**（渲染层只用它，保证
 * contentHash 跨环境稳定），resolveAutoCapture 才吃 env、只为展示层补充说明。
 * 纯函数、不读 process.env：CI 判定由调用方从 EnvSnapshot 注入。
 *
 * 本模块**不知道 target**：`hook` 档写什么在 `hook-capture.ts`，写到哪在各
 * projector，哪些 target 支持在 `core/project/sync-notices.ts`。三层拆开后，
 * 新增一个 target 不必改这里的档位判定。
 */
import type { AutoCapture, Profile } from '../../schema';

/** auto_capture 的有效状态（status / doctor 共用；渲染层只用 effectiveAutoCapture）。 */
export interface AutoCaptureState {
  /** profile 里声明的档位（缺省 off）。 */
  readonly declared: AutoCapture;
  /** 实际生效的档位（当前三档恒等；与环境无关，见 effectiveAutoCapture）。 */
  readonly effective: AutoCapture;
  /**
   * CI 为真：本次运行不会有任何 learnings 落盘（§7.4 护栏 3 / §10）。
   *
   * **不影响渲染**——`prompt` 档的 `## Learning Protocol` 段在 CI 下照样渲染，
   * 否则同一份 SoT 在 CI 与本地会产出不同的 contentHash（见 effectiveAutoCapture）。
   */
  readonly ciNoCapture: boolean;
}

/**
 * 渲染层用的有效档位（Spec §7.4）：**恒等映射，且与环境无关**。
 *
 * - 三档各自生效，不再有归并：`hook` 在 §12 Phase 3 已落地 target 侧钩子写入
 *   （见 hook-capture.ts 与 codex projector），因此不再折叠成 `off`。保留这层
 *   间接不删函数：它是「渲染层只认有效档位」这条约束的落点，将来若再引入需要
 *   归并的档位，改这一处即可，三个消费方自动跟上。
 * - **CI 不参与判定**：护栏 3「CI 为真时任何档位都不得产生 `learnings/` 写入」约束的是
 *   *写入*路径（`aforge learn` 在 CI 下被 store 守卫拒掉，ConfigError(2)），不是渲染路径。
 *   若让 CI 也削掉这一段正文，同一份
 *   SoT 在 CI 与本地就会渲染出不同的 marker 区间 → contentHash 不同 → 任何跨环境
 *   的 hash 比对（CI 里 `aforge doctor` 对着本机 sync 出的产物）都会误报漂移。
 *   投影产物因此保持环境无关；"CI 里不会真的采集"由 status / doctor 如实说明。
 * - **不看本机装了哪个 CLI**：`hook` 档的钩子写入是声明驱动的（按 `profile.targets`
 *   与各 projector 的能力声明），不做任何探测，因此 contentHash 与钩子产物
 *   都不因宿主环境而变。
 */
export function effectiveAutoCapture(profile: Profile): AutoCapture {
  return profile.learning.auto_capture;
}

/**
 * 解析 auto_capture 的完整状态（供 status / doctor 展示，Spec §7.4）。
 *
 * 与 effectiveAutoCapture 的分工：有效档位（进而是投影正文）只由 profile 决定；
 * env 只用来补一句"当前环境下会不会真的采集"，不改变 effective。
 */
export function resolveAutoCapture(
  profile: Profile,
  env: { readonly ci: boolean },
): AutoCaptureState {
  return {
    declared: profile.learning.auto_capture,
    effective: effectiveAutoCapture(profile),
    ciNoCapture: env.ci,
  };
}

/**
 * 该有效档位是否要求 target 侧写入会话钩子（Spec §7.4 `hook` 档 / §12 Phase 3）。
 *
 * 与 rendersLearningProtocol **互斥**：两者是同一份协议的两条投递通道
 * （静态嵌进规则文件 vs 会话开始时由钩子动态注入），同时为真等于把协议投两遍。
 * 单独成函数而不在 projector 里就地比较字面量：sync / status / doctor 三处都要
 * 回答"这次会不会写钩子"，共用一个判据才不会漂移。
 */
export function writesSessionHooks(effective: AutoCapture): boolean {
  return effective === 'hook';
}

/**
 * `## Learning Protocol` 段的标题行。
 *
 * 单独导出是因为三处都要提到它：composer 渲染正文、`aforge status` 与 `aforge doctor`
 * 各自向用户说明"投影正文里会多这一段"。三处手抄同一字面量时，改标题只会让后两处
 * 静默变成假话（测试断言的是各自的措辞，不会失败）。
 */
export const LEARNING_PROTOCOL_HEADING = '## Learning Protocol';

/**
 * 该有效档位是否会让投影正文包含 `## Learning Protocol` 段（Spec §5.2）。
 *
 * composer 用它做渲染判据，status / doctor 用它决定是否向用户声明该段存在——
 * 三处共用同一函数，渲染条件将来若扩大（例如 hook 落地后也渲染），说明文案不会
 * 落后于实际行为。
 */
export function rendersLearningProtocol(effective: AutoCapture): boolean {
  return effective === 'prompt';
}

/**
 * `## Learning Protocol` 段正文（Spec §5.2 / §7.4 `prompt` 档）。
 *
 * 固定内容、不受 SoT 影响：它是给 agent 的协议说明，不是用户沉淀。含触发条件
 * 与可直接复制的命令行；随 marker 区间整体替换，因此不产生独立产物、不进 §3.3 记账。
 *
 * 五条内容约束（对应 §7.4 的护栏）：
 * - 只让 agent 写 SoT（`aforge learn`），**不提** `aforge sync`——进投影恒由人工触发；
 * - 明说不要塞会话原文（凭据泄漏面 + 条目体积，护栏 4）；
 * - 不承诺晋升（`promote` 由人工或 auto_promote 决定，护栏 2）；
 * - 明说命令被拒时不要重试：CI 下 store 守卫会拒掉写入（ConfigError(2)，护栏 3），
 *   而正文与环境无关、照样渲染，不加这一句 agent 可能对着注定失败的命令反复重试；
 * - 纯 ASCII 命令行，Windows 终端可直接粘。
 */
export const LEARNING_PROTOCOL_SECTION = `${LEARNING_PROTOCOL_HEADING}

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
  (\`aforge sync\`), so do not run it yourself.
- If the command is refused (CI environment), do not retry it.`;
