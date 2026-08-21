/**
 * aforge — AgentForge CLI 入口（薄入口：装配与命令注册见 src/cli.ts）。
 *
 * - 仅使用 Node 兼容 API（node:* / 标准 JS）；Bun 只作为构建/安装工具。
 * - 三条运行轨道共享同一份源码：
 *   1) dev:  tsx src/main.ts
 *   2) bun:  bun build --compile → dist/aforge.exe
 *   3) node: esbuild bundle    → dist/aforge.js（package.json "bin" 指向它）
 */
import { runCli } from './cli';
import { AgentForgeError, toExitCode } from './core/errors';

/**
 * 统一错误出口（Spec §6.1）：
 * - AgentForgeError → 打印 message + hint，退出码取 error.code（2/3/4/5 各归其位）；
 * - 未知错误 → 打印堆栈，退出码 1。
 */
function reportFatal(kind: string, error: unknown): never {
  console.error(`aforge: ${kind}`);
  if (error instanceof AgentForgeError) {
    console.error(error.message);
    if (error.hint !== undefined) {
      console.error(`hint: ${error.hint}`);
    }
  } else if (error instanceof Error) {
    console.error(error.stack ?? `${error.name}: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(toExitCode(error));
}

process.on('uncaughtException', (error: unknown) => {
  reportFatal('uncaught exception', error);
});

process.on('unhandledRejection', (reason: unknown) => {
  reportFatal('unhandled rejection', reason);
});

await runCli().catch((error: unknown) => {
  reportFatal('unexpected error', error);
});
