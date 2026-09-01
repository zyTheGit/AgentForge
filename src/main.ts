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
import { EXIT_CODE_ROLLBACK_INCOMPLETE, getExitCodeOverride } from './commands/lifecycle';
import { AgentForgeError, describeFatal, toExitCode } from './core/errors';
import { getActiveSyncTransaction, rollbackActiveSyncTransactionSync } from './core/project/engine';
import { isCancelledError } from './infra/prompt';
import { getUi } from './infra/ui';

/** 中断退出码（POSIX 惯例 128 + SIGINT(2)；Spec §6.1 的 0-5 之外，不与失败码冲突）。 */
const EXIT_CODE_INTERRUPTED = 130;

/**
 * 统一错误出口（Spec §6.1）：
 * - 用户取消交互（CancelledError）→ 打印取消提示，退出码 130；
 * - AgentForgeError → 打印 message + hint，退出码取 error.code（2/3/4/5 各归其位）；
 * - 未知错误 → 打印堆栈，退出码 1；
 * - 退出码覆盖（sync 回滚未完成 → 6，见 commands/lifecycle/sync.ts）优先于以上映射。
 *
 * 首行标签经 describeFatal 决定：可预期的 AgentForgeError 报出自己的归类与**最终**
 * 退出码（`configuration error (exit code 2)`），只有真的意外才落到调用方给的 kind 上。
 * 首行的码必须与进程退出码一致，故先算出 finalCode 再输出。
 *
 * 进程即将退出前先回滚进行中的 sync 事务：uncaughtException / unhandledRejection
 * 走的是这条路径而**不是** syncOnce 的 finally，不清理就退出会留下半新半旧的投影
 * ＋残留 journal ＋残留锁（要等心跳判定陈旧才能被抢占）。正常错误路径上事务已在
 * finally 里结束，此处为空操作。
 */
function reportFatal(kind: string, error: unknown): never {
  const ui = getUi();
  if (isCancelledError(error)) {
    console.error(ui.yellow('aforge: cancelled'));
    console.error(error.message);
    process.exit(error.exitCode);
  }

  const override = getExitCodeOverride(error);
  const finalCode = override ?? toExitCode(error);
  console.error(ui.red(`aforge: ${describeFatal(error, kind, finalCode)}`));
  if (error instanceof AgentForgeError) {
    console.error(error.message);
    if (error.hint !== undefined) {
      console.error(ui.hint(error.hint));
    }
  } else if (error instanceof Error) {
    console.error(ui.dim(error.stack ?? `${error.name}: ${error.message}`));
  } else {
    console.error(error);
  }
  rollbackInFlightSyncTransaction();
  if (override !== undefined) {
    console.error(
      ui.red(
        override === EXIT_CODE_ROLLBACK_INCOMPLETE
          ? `exit code ${override}: rollback incomplete - see the file list above`
          : `exit code ${override}`,
      ),
    );
  }
  process.exit(finalCode);
}

/**
 * 同步回滚进行中的 sync 事务并打印结果（无事务 → 空操作）。
 *
 * SIGINT/SIGTERM 与 uncaughtException/unhandledRejection 共用同一路径：两者都绕过
 * syncOnce 的 finally，善后动作必须一致。回滚必须用同步 IO
 * （理由见 engine.rollbackActiveSyncTransactionSync 的 JSDoc）。
 */
function rollbackInFlightSyncTransaction(): void {
  const active = getActiveSyncTransaction();
  if (active === null) {
    return;
  }
  const ui = getUi();
  console.error(
    ui.yellow(
      `rolling back the in-flight sync transaction (${active.writtenFiles.length} written file(s))...`,
    ),
  );
  const rolledBack = rollbackActiveSyncTransactionSync();
  const failed = rolledBack.filter((entry) => !entry.restored);
  for (const entry of failed) {
    console.error(ui.red(`  NOT restored: ${entry.path}: ${entry.error ?? 'unknown error'}`));
  }
  console.error(
    failed.length === 0
      ? ui.green(`rollback complete: ${rolledBack.length} file(s) restored to the pre-sync state`)
      : ui.red(
          `rollback incomplete - ${failed.length} file(s) could not be restored (see above); ` +
            `the pre-sync backups are kept next to the SoT root (.agf-backup-failed-*)`,
        ),
  );
}

/**
 * Ctrl-C / SIGTERM：先同步回滚进行中的 sync 事务，再以 130 退出。
 *
 * 不做清理就退出会留下一组半新半旧的 target 配置（sync-meta 仍是旧值），
 * 用户毫不知情——故在此把已写文件恢复到 sync 前状态。
 */
function handleInterrupt(signal: 'SIGINT' | 'SIGTERM'): never {
  console.error(getUi().yellow(`\naforge: interrupted (${signal})`));
  rollbackInFlightSyncTransaction();
  process.exit(EXIT_CODE_INTERRUPTED);
}

process.on('SIGINT', () => {
  handleInterrupt('SIGINT');
});

process.on('SIGTERM', () => {
  handleInterrupt('SIGTERM');
});

process.on('uncaughtException', (error: unknown) => {
  reportFatal('uncaught exception', error);
});

process.on('unhandledRejection', (reason: unknown) => {
  reportFatal('unhandled rejection', reason);
});

await runCli().catch((error: unknown) => {
  reportFatal('unexpected error', error);
});
