/**
 * aforge CLI 装配：commander 程序构建与命令注册（main.ts 保持为薄入口）。
 *
 * - 命令实现分散在 src/commands/*，此模块只做注册与 parse；
 * - --version 行为与 M0 保持一致（输出与 package.json 同步的 VERSION，退出码 0）；
 * - 纯 ASCII 描述：避免 Windows GBK 控制台（chcp 936）下非 ASCII 字符乱码。
 */
import { Command } from 'commander';
import { registerDetectCommand } from './commands/detect';

/**
 * 与 package.json "version" 保持同步。
 * 不在运行时读取 package.json：bun --compile 产物中该文件不存在。
 */
export const VERSION = '0.1.0';

/** sync 占位命令：M1 起实现（Spec §6）。 */
function registerSyncStub(program: Command): void {
  program
    .command('sync')
    .description('render SoT rules and project them to agent targets (M1)')
    .action(() => {
      console.error('aforge: sync is not implemented yet (planned for M1)');
      process.exitCode = 1;
    });
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('aforge')
    .description(
      'AgentForge - manage AI coding CLI rule projections (SoT -> opencode/codex/claude/pi) from one source of truth',
    )
    .version(VERSION, '-V, --version', 'print version and exit');

  registerDetectCommand(program);
  registerSyncStub(program);

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
