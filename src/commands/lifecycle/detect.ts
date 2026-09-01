/**
 * aforge detect 命令（Spec §6 命令表 / §7.2 Detect 顺序）：运行探测引擎并输出结果。
 *
 * - 默认人类可读输出（纯 ASCII，避免 Windows GBK 控制台 chcp 936 乱码）；
 * - --json 输出机器可读 JSON（DetectedSnapshot 结构，路径为绝对路径）；
 * - 探测引擎零失败路径（坏环境一律降级为"未检出"），进程退出码恒 0。
 */
import type { Command } from 'commander';
import type { DetectedRuntime, DetectedSnapshot, DetectedTool } from '../../core/detector/engine';
import { runDetection } from '../../core/detector/engine';
import { readEnv } from '../../core/env';
import { realHost } from '../../infra/real-host';
import { printJson } from '../_shared/context';
import { resolveJsonFlag } from '../_shared/flags';

/** 注册 detect 命令（由 cli.ts 装配调用）。 */
export function registerDetectCommand(program: Command): void {
  program
    .command('detect')
    .description('probe local toolchain (node/python/package managers/shell) without side effects')
    .option('--json', 'print machine-readable JSON (absolute paths)')
    .action(async (options: { json?: boolean }, command: Command) => {
      const snapshot = await runDetection({
        host: realHost,
        os: process.platform,
        cwd: process.cwd(),
        env: readEnv(realHost),
      });
      if (resolveJsonFlag(command, options.json)) {
        printJson(snapshot);
        return;
      }
      printHuman(snapshot);
    });
}

/** 两列对齐的字段行：`  manager   : fnm`。 */
function fieldLine(label: string, value: string | undefined): string {
  return `  ${label.padEnd(10)}: ${value ?? '(none)'}`;
}

function printRuntime(lines: string[], runtime: DetectedRuntime): void {
  lines.push(fieldLine('manager', runtime.manager));
  lines.push(fieldLine('source', runtime.source));
  if (runtime.version !== undefined) {
    lines.push(fieldLine('version', runtime.version));
  }
  if (runtime.path !== undefined) {
    lines.push(fieldLine('path', runtime.path));
  }
}

function printTool(lines: string[], tool: DetectedTool): void {
  lines.push(fieldLine('manager', tool.manager));
  lines.push(fieldLine('source', tool.source));
  if (tool.path !== undefined) {
    lines.push(fieldLine('path', tool.path));
  }
}

/** 人类可读输出：分节列表（工具 / 命中 / 来源 / 路径）。 */
function printHuman(snapshot: DetectedSnapshot): void {
  const lines: string[] = ['aforge detect - toolchain probe', ''];

  lines.push('Node.js');
  printRuntime(lines, snapshot.node);

  lines.push('', 'Python');
  printRuntime(lines, snapshot.python);

  lines.push('', 'Package managers (priority order)');
  if (snapshot.package_managers.length === 0) {
    lines.push('  (none)');
  }
  for (const [index, pm] of snapshot.package_managers.entries()) {
    lines.push(`  ${index + 1}. ${pm.name.padEnd(12)} [${pm.source}]`);
    // 缩进对齐编号前缀（"  1. " 占 5 列）
    if (pm.path !== undefined) {
      lines.push(`     ${'path'.padEnd(12)}: ${pm.path}`);
    }
  }

  lines.push('', 'Shell');
  lines.push(fieldLine('shell', snapshot.shell));

  lines.push('', 'Rust');
  printTool(lines, snapshot.rust);

  lines.push('', 'Go');
  printTool(lines, snapshot.go);

  lines.push('', 'Existing rule files');
  if (snapshot.existing_rules.length === 0) {
    lines.push('  (none)');
  }
  for (const rule of snapshot.existing_rules) {
    lines.push(`  ${rule}`);
  }

  console.log(lines.join('\n'));
}
