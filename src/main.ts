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

await runCli().catch((error: unknown) => {
  reportFatal('unexpected error', error);
});
