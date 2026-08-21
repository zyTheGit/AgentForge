/**
 * 交互提示封装（M9，Spec §7.1.1 init -i）：@clack/prompts 的唯一入口。
 *
 * 设计约束：
 * - 命令核心逻辑经 PromptApi 注入（select / confirm / multiselect / note），
 *   测试用脚本化 fake 驱动交互流程，不依赖真 TTY（交互代码集中于此，易测）；
 * - clack 以动态 import 按需加载：非交互命令路径不付出加载开销；
 *   bundle 产物（bun --compile / esbuild bundle）对动态 import 均内联支持，
 *   由构建验证覆盖；
 * - 用户取消（Ctrl+C / Esc）：统一「提示已取消 + exit 0」，不上抛错误
 *   （半途退出不视为失败，Spec §7.1.1 无中途状态需要清理）；
 * - assertTty：CI / 管道（stdin 或 stdout 非 TTY）→ ConfigError(2)，
 *   hint 引导非交互参数。
 */
import { ConfigError } from '../core/errors';

/** 单个选项（select / multiselect 共用；value 限定 string 便于 YAML/日志序列化）。 */
export interface PromptOption<T extends string> {
  readonly value: T;
  /** 展示文本（必填：交互列表的用户可读面）。 */
  readonly label: string;
  /** 附加提示（如目标将写入的绝对路径）。 */
  readonly hint?: string;
}

/**
 * 交互提示接口（注入点）。
 *
 * 三个提问方法的语义：
 * - select：单选（initialValue 高亮默认项，回车即选）；
 * - confirm：Y/n 确认；
 * - multiselect：空格切换、回车提交；required=true 时至少选一项；
 *   返回顺序稳定（按 options 顺序而非用户点选顺序）。
 */
export interface PromptApi {
  select<T extends string>(
    message: string,
    options: readonly PromptOption<T>[],
    initialValue?: T,
  ): Promise<T>;
  confirm(message: string, initialValue?: boolean): Promise<boolean>;
  multiselect<T extends string>(
    message: string,
    options: readonly PromptOption<T>[],
    initialValues?: readonly T[],
    required?: boolean,
  ): Promise<T[]>;
  /** 信息面板（探测结果 / 文件清单等非交互展示）。 */
  note(message: string, title?: string): void;
}

/** TTY 探测（注入点：测试伪造 CI / 管道环境）。 */
export interface TtyProbe {
  readonly isInteractive: () => boolean;
}

/**
 * 默认 TTY 探测：stdin 与 stdout 均为 TTY 才可交互。
 * 管道（`aforge init -i | tee`）、CI runner、非控制台句柄均判定为不可交互。
 */
export function defaultTtyProbe(
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
): TtyProbe {
  return {
    isInteractive: () =>
      (stdin as { isTTY?: boolean }).isTTY === true &&
      (stdout as { isTTY?: boolean }).isTTY === true,
  };
}

/**
 * 交互前置断言：非 TTY（CI / 管道 / 重定向）→ ConfigError(2)。
 * 在进入任何 clack 调用前执行——clack 在非 TTY 下行为未定义（渲染错乱）。
 */
export function assertTty(probe: TtyProbe = defaultTtyProbe()): void {
  if (!probe.isInteractive()) {
    throw new ConfigError('当前环境不支持交互式输入（stdin/stdout 非 TTY，常见于 CI 与管道）', {
      hint: '非交互环境请使用非交互参数（例如：aforge init --scope project）',
    });
  }
}

/** clack 选项的解析后形态（Value=string 的 Primitive 分支；泛型 T 的条件类型延迟解析会阻断结构检查，故固定为 string 再断言回 T）。 */
type ClackOption = { value: string; label?: string; hint?: string; disabled?: boolean };

/** PromptOption[] → clack 选项形态（label/hint 透传）。 */
function toClackOptions<T extends string>(options: readonly PromptOption<T>[]): ClackOption[] {
  return options.map((option) => ({
    value: option.value,
    label: option.label,
    ...(option.hint !== undefined ? { hint: option.hint } : {}),
  }));
}

/**
 * 构造基于 @clack/prompts 的真实 PromptApi。
 *
 * - 动态 import：仅交互路径加载 clack（bun/esbuild bundle 产物均内联）；
 * - isCancel → cancel 提示 + process.exit(0)（用户主动放弃，退出码 0）；
 * - multiselect 返回值按 options 声明顺序重排（targets 顺序稳定性）。
 */
export async function createClackPrompt(): Promise<PromptApi> {
  const clack = await import('@clack/prompts');

  /** clack 返回值统一拆包：cancel 语义在此终结（exit 0）。 */
  function unwrap<T>(value: T | symbol): T {
    if (clack.isCancel(value)) {
      clack.cancel('已取消');
      process.exit(0);
    }
    return value as T;
  }

  const impl: PromptApi = {
    select: async <T extends string>(
      message: string,
      options: readonly PromptOption<T>[],
      initialValue?: T,
    ): Promise<T> => {
      const picked = await clack.select({
        message,
        options: toClackOptions(options),
        ...(initialValue !== undefined ? { initialValue } : {}),
      });
      return unwrap(picked) as T;
    },
    confirm: async (message: string, initialValue?: boolean): Promise<boolean> =>
      unwrap(await clack.confirm({ message, initialValue: initialValue ?? true })),
    multiselect: async <T extends string>(
      message: string,
      options: readonly PromptOption<T>[],
      initialValues?: readonly T[],
      required?: boolean,
    ): Promise<T[]> => {
      const picked = unwrap(
        await clack.multiselect({
          message,
          options: toClackOptions(options),
          initialValues: initialValues !== undefined ? [...initialValues] : undefined,
          required: required ?? false,
        }),
      ) as string[];
      // 按声明顺序稳定输出（用户点选顺序不影响 targets 顺序）
      const order = new Map<string, number>(
        options.map((option, index) => [option.value as string, index]),
      );
      return [...picked].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)) as T[];
    },
    note: (message: string, title?: string): void => {
      clack.note(message, title);
    },
  };
  return impl;
}
