/**
 * 命令行标志读取（Spec §6.2 `--json` / §3.1 `--scope`）。
 *
 * `--json` 是 **program 级**全局标志（`aforge --json status`），同时**每条**产出机器
 * 可读结果的子命令都各自声明 `--json`，因此 `aforge status --json` 与
 * `aforge --json status` 等价——两种位置都要生效，故统一经 resolveJsonFlag 判定：
 * 先看子命令自身的解析结果，再沿 commander 的 parent 链向上找（`aforge --json
 * source list` 的标志挂在 program 上）。子命令侧一律只读不改语义：`--json` 只切换
 * 输出形态，绝不参与命令的业务入参。
 *
 * `--scope` 由 commander 交上来时只是裸字符串（`--scope <scope>` 不做枚举校验），
 * 而下游 resolveWriteTargetLayer 的入参是 `Scope` 联合类型。校验 + 收窄这一步在
 * 每个带 `--scope` 的子命令 action 里都一样，故收敛为 parseScopeOption。
 *
 * `init` 的运行模式（交互 / 静默）同样是一次纯标志判定，故与上两者同列（见
 * resolveInitMode）——放在 action 里内联会让「四个输入的优先级」这一条契约既不可
 * 单测也没有单一出处。
 */
import type { Command } from 'commander';
import type { Scope } from '../core/env';
import { ConfigError } from '../core/errors';

/**
 * 本次调用是否要求机器可读输出（Spec §6.2 `--json`）。
 *
 * @param command commander 传给 action 的 Command（最后一个参数）。
 * @param localJson 子命令自身 options 里的 json 字段（有则优先为真）。
 */
export function resolveJsonFlag(command: Command | undefined, localJson?: boolean): boolean {
  if (localJson === true) {
    return true;
  }
  let current: Command | null = command ?? null;
  while (current !== null) {
    if ((current.opts() as { json?: boolean }).json === true) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * `--scope <scope>` 的字面量校验与类型收窄（project | user，Spec §3.1）。
 *
 * 未指定 → undefined（下游按「AGF_SCOPE > project 在用 > user 在用」的有效
 * scope 语义自行解析，见 config/target-layer.resolveWriteTargetLayer）。
 *
 * @param raw commander 交上来的原始字符串（`--scope` 不做枚举校验）。
 * @returns 合法的 Scope，或未指定时的 undefined。
 * @throws ConfigError(2) 取值不是 project / user（拼错的 scope 绝不能静默退化成
 *         「按有效 scope 解析」——那会把写入落到用户没指定的那一层）。
 */
export function parseScopeOption(raw: string | undefined): Scope | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw !== 'project' && raw !== 'user') {
    throw new ConfigError(`非法 scope: ${raw}`, {
      hint: '有效值: project, user',
      details: { scope: raw },
    });
  }
  return raw;
}

/**
 * `aforge init` 的运行模式（Spec §7.1 静默 / §7.1.1 交互五步）。
 *
 * - `interactive`：走五步提问（scope 选择、目标 Agent multiselect、写入确认）；
 * - `silent`：不提问，直接按默认值落盘（scope=project，targets=全部四个）。
 */
export type InitMode = 'interactive' | 'silent';

/** resolveInitMode 的输入（三个标志 + 环境的 TTY 事实）。 */
export interface InitModeInput {
  /** `-i, --interactive`：显式要交互。 */
  readonly interactive?: boolean;
  /** `-y, --yes`：显式要静默默认值。 */
  readonly yes?: boolean;
  /** `--json`：机器可读输出，隐含调用方是脚本。 */
  readonly json?: boolean;
  /** stdin 与 stdout 是否都是 TTY（见 infra/prompt.defaultTtyProbe）。 */
  readonly isTty: boolean;
}

/**
 * init 运行模式判定：**TTY 下默认交互**，其余情况静默。
 *
 * 为什么默认翻转成交互：裸 `aforge init` 会静默选定 scope=project 并把规则投影给
 * 全部四个 target，而这两件事都写进 profile.yaml 且 init 拒绝在非空 SoT 上重跑——
 * 用户想改就得先删目录。既然默认值不可撤回，就该在有人能回答的时候先问。
 *
 * 优先级（自上而下短路，冲突时先声明的赢）：
 * 1. `-i` → interactive。显式要求交互；非 TTY 下由 assertTty 报 ConfigError(2)，
 *    而不是在这里静默降级——用户点名要提问却什么都没被问，比报错更难排查。
 * 2. `--yes` → silent。`-i --yes` 同时给出时以 `-i` 为准（上一条已短路）。
 * 3. `--json` → silent。JSON 体是给脚本消费的，脚本不可能应答提问。
 * 4. 非 TTY（CI / 管道 / 重定向）→ silent，与 `--yes` 等价路径。
 */
export function resolveInitMode(input: InitModeInput): InitMode {
  if (input.interactive === true) {
    return 'interactive';
  }
  if (input.yes === true || input.json === true) {
    return 'silent';
  }
  return input.isTty ? 'interactive' : 'silent';
}
