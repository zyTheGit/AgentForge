/**
 * aforge CLI 装配：commander 程序构建与命令注册（main.ts 保持为薄入口）。
 *
 * - 命令实现分散在 src/commands/*，此模块只做注册与 parse；
 * - --version 行为与 M0 保持一致（输出与 package.json 同步的 VERSION，退出码 0）；
 * - 纯 ASCII 描述：避免 Windows GBK 控制台（chcp 936）下非 ASCII 字符乱码。
 */
import { Command } from 'commander';
import { registerDetectCommand } from './commands/detect';
import { registerDoctorCommand } from './commands/doctor';
import { registerImportCommand } from './commands/import';
import { registerInitCommand } from './commands/init';
import { registerLearnCommand } from './commands/learn';
import { registerLearningsCommand } from './commands/learnings';
import { registerMcpCommand } from './commands/mcp';
import { registerPromoteCommand } from './commands/promote';
import { registerSkillCommand } from './commands/skill';
import { registerSourceCommand } from './commands/source';
import { registerStatusCommand } from './commands/status';
import { registerSyncCommand } from './commands/sync';
import { registerTemplateCommand } from './commands/template';
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
    // （子命令保留自身 --json 以兼容既有用法；统一经 commands/flags.resolveJsonFlag 判定）
    .option('--json', 'machine-readable output (absolute paths) - global flag (Spec 6.2)');

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

  // 无子命令 → 输出简短帮助，退出码 0（Spec §6.1）
  program.action((_options, command) => {
    command.outputHelp();
    process.exitCode = 0;
  });

  return program;
}

/** 解析并执行 CLI（命令 action 的异常向上传播，由 main.ts 统一错误出口处理）。 */
export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
