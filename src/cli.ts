/**
 * aforge CLI 装配：commander 程序构建与命令注册（main.ts 保持为薄入口）。
 *
 * - 命令实现按 SoT 生命周期分域放在 src/commands/{lifecycle,assets,knowledge}/，
 *   共用件在 src/commands/_shared/；此模块只 import 到域文件夹级并做注册与 parse；
 * - --version 行为与 M0 保持一致（输出与 package.json 同步的 VERSION，退出码 0）；
 * - 纯 ASCII 描述：避免 Windows GBK 控制台（chcp 936）下非 ASCII 字符乱码——
 *   命令输出本身的 ASCII 降级由 infra/ui 的能力探测负责（见 runCli 的装配）。
 */
import { Command } from 'commander';
import {
  registerMcpCommand,
  registerSkillCommand,
  registerSourceCommand,
  registerTemplateCommand,
} from './commands/assets';
import {
  registerBundleCommand,
  registerImportCommand,
  registerLearnCommand,
  registerLearningsCommand,
  registerPromoteCommand,
} from './commands/knowledge';
import {
  registerDetectCommand,
  registerDoctorCommand,
  registerInitCommand,
  registerStatusCommand,
  registerSyncCommand,
} from './commands/lifecycle';
import { createUi, defaultUiProbe, detectUiCapabilities, setUi } from './infra/ui';
import { VERSION } from './version';

export { VERSION };

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('aforge')
    .description(
      'AgentForge - manage AI coding CLI rule projections (SoT -> opencode/codex/claude/pi) from one source of truth',
    )
    .version(VERSION, '-V, --version', 'print version and exit')
    // Spec §6.2 全局标志：`aforge --json <cmd>` 与 `aforge <cmd> --json` 等价
    // （子命令保留自身 --json 以兼容既有用法；统一经 commands/_shared/flags.resolveJsonFlag 判定）
    .option('--json', 'machine-readable output (absolute paths) - global flag (Spec 6.2)')
    // 呈现标志：位置无关（在 parse 前由 extractColorFlag 从 argv 摘掉），此处声明只为进 --help
    .option('--no-color', 'disable ANSI colors (also honors NO_COLOR / FORCE_COLOR)');

  registerDetectCommand(program);
  registerInitCommand(program);
  registerSyncCommand(program);
  registerDoctorCommand(program);
  registerStatusCommand(program);

  // ---- M8 区块：learn / promote / learnings / source / template / skill / mcp ----
  registerLearnCommand(program);
  registerPromoteCommand(program);
  registerLearningsCommand(program);
  registerSourceCommand(program);
  registerTemplateCommand(program);
  registerSkillCommand(program);
  registerMcpCommand(program);

  // ---- M9 区块：import（Spec §7.7 MVP 基础版）----
  registerImportCommand(program);

  // ---- bundle 区块：SoT 导出 / 导入（迁移；与上面的 import 语义不同，见 commands/knowledge/bundle）----
  registerBundleCommand(program);

  // 无子命令 → 输出简短帮助，退出码 0（Spec §6.1）
  program.action((_options, command) => {
    command.outputHelp();
    process.exitCode = 0;
  });

  return program;
}

/**
 * 从 argv 摘出呈现标志 `--no-color` / `--color`（位置无关）。
 *
 * 为什么先摘再 parse，而不是在每条子命令上各声明一遍：commander 只认「选项挂在哪条
 * 命令上」，要让 `aforge status --no-color` 与 `aforge --no-color status` 都能用，
 * 否则得在 20 处注册点重复声明。呈现标志纯属输出形态，绝不参与业务入参，摘掉是安全的。
 *
 * `--` 之后不摘：那之后是透传给外部命令的实参，动它会改变语义。
 *
 * @returns 去掉呈现标志后的 argv 与颜色覆盖值（两个标志都没出现 → undefined）。
 */
export function extractColorFlag(argv: readonly string[]): {
  readonly argv: string[];
  readonly colorOverride: boolean | undefined;
} {
  const kept: string[] = [];
  let colorOverride: boolean | undefined;
  let passthrough = false;
  for (const arg of argv) {
    if (passthrough) {
      kept.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      kept.push(arg);
    } else if (arg === '--no-color') {
      colorOverride = false;
    } else if (arg === '--color') {
      colorOverride = true;
    } else {
      kept.push(arg);
    }
  }
  return { argv: kept, colorOverride };
}

/** 解析并执行 CLI（命令 action 的异常向上传播，由 main.ts 统一错误出口处理）。 */
export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  const { argv: parsedArgv, colorOverride } = extractColorFlag(argv);
  // 呈现层能力必须在任何 action 打印之前固化：探测一次，全进程复用（infra/ui）
  setUi(createUi(detectUiCapabilities(defaultUiProbe(colorOverride))));
  const program = buildProgram();
  await program.parseAsync(parsedArgv);
}
