/**
 * aforge — AgentForge CLI 入口（M0：脚手架 + 双轨构建冒烟）。
 *
 * - 仅使用 Node 兼容 API（node:* / 标准 JS）；Bun 只作为构建/安装工具。
 * - 三条运行轨道共享同一份源码：
 *   1) dev:  tsx src/main.ts
 *   2) bun:  bun build --compile → dist/aforge.exe
 *   3) node: esbuild bundle    → dist/aforge.js（package.json "bin" 指向它）
 */
import { Command } from 'commander';

/**
 * 与 package.json "version" 保持同步。
 * 不在运行时读取 package.json：bun --compile 产物中该文件不存在。
 */
export const VERSION = '0.1.0';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('aforge')
    // 纯 ASCII：避免 Windows GBK 控制台（chcp 936）下非 ASCII 字符乱码
    .description(
      'AgentForge - manage AI coding CLI rule projections (SoT -> opencode/codex/claude/pi) from one source of truth',
    )
    .version(VERSION, '-V, --version', 'print version and exit');

  // 占位命令：M1 起实现（Spec §6）
  program
    .command('sync')
    .description('render SoT rules and project them to agent targets (M1)')
    .action(() => {
      console.error('aforge: sync is not implemented yet (planned for M1)');
      process.exitCode = 1;
    });

  // 无子命令 → 输出简短帮助，退出码 0（Spec §6.1）
  program.action((_options, command) => {
    command.outputHelp();
    process.exitCode = 0;
  });

  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}

/** 统一错误出口：console.error + exit 1（Spec §6.1 通用错误） */
function reportFatal(kind: string, error: unknown): never {
  console.error(`aforge: ${kind}`);
  if (error instanceof Error) {
    console.error(error.stack ?? `${error.name}: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
}

process.on('uncaughtException', (error: unknown) => {
  reportFatal('uncaught exception', error);
});

process.on('unhandledRejection', (reason: unknown) => {
  reportFatal('unhandled rejection', reason);
});

await main().catch((error: unknown) => {
  reportFatal('unexpected error', error);
});
