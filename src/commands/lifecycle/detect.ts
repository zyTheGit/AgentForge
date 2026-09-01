/**
 * aforge detect 命令（Spec §6 命令表 / §7.2 Detect 顺序）：运行探测引擎并输出结果。
 *
 * - 默认人类可读输出（上色 + 符号；Windows GBK 控制台与管道自动降级为纯 ASCII，见 infra/ui）；
 * - --json 输出机器可读 JSON（DetectedSnapshot 结构，路径为绝对路径）；
 * - 探测引擎零失败路径（坏环境一律降级为"未检出"），进程退出码恒 0。
 */
import type { Command } from 'commander';
import type { DetectedRuntime, DetectedSnapshot, DetectedTool } from '../../core/detector/engine';
import { runDetection } from '../../core/detector/engine';
import { readEnv } from '../../core/env';
import { realHost } from '../../infra/real-host';
import { getUi, type Ui } from '../../infra/ui';
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

/** 字段行的 label 宽度（`manager` / `version` / `path` 共用一档，冒号同列）。 */
const FIELD_WIDTH = 10;

/** 两列对齐的字段行：`  manager   : fnm`（未检出 → 暗色 `(none)`）。 */
function fieldLine(ui: Ui, label: string, value: string | undefined): string {
  return ui.kv(label, value ?? ui.dim('(none)'), FIELD_WIDTH);
}

function printRuntime(lines: string[], runtime: DetectedRuntime, ui: Ui): void {
  lines.push(fieldLine(ui, 'manager', runtime.manager));
  lines.push(fieldLine(ui, 'source', runtime.source));
  if (runtime.version !== undefined) {
    lines.push(fieldLine(ui, 'version', runtime.version));
  }
  if (runtime.path !== undefined) {
    lines.push(fieldLine(ui, 'path', ui.path(runtime.path)));
  }
}

function printTool(lines: string[], tool: DetectedTool, ui: Ui): void {
  lines.push(fieldLine(ui, 'manager', tool.manager));
  lines.push(fieldLine(ui, 'source', tool.source));
  if (tool.path !== undefined) {
    lines.push(fieldLine(ui, 'path', ui.path(tool.path)));
  }
}

/** 人类可读输出：分节列表（工具 / 命中 / 来源 / 路径）。 */
function printHuman(snapshot: DetectedSnapshot, ui: Ui = getUi()): void {
  const lines: string[] = [...ui.title('aforge detect', 'toolchain probe')];

  lines.push(ui.bold('Node.js'));
  printRuntime(lines, snapshot.node, ui);

  lines.push('', ui.bold('Python'));
  printRuntime(lines, snapshot.python, ui);

  lines.push('', ui.bold('Package managers (priority order)'));
  if (snapshot.package_managers.length === 0) {
    lines.push(`  ${ui.dim('(none)')}`);
  }
  for (const [index, pm] of snapshot.package_managers.entries()) {
    lines.push(`  ${index + 1}. ${pm.name.padEnd(12)} ${ui.dim(`[${pm.source}]`)}`);
    // 缩进对齐编号前缀（"  1. " 占 5 列）
    if (pm.path !== undefined) {
      lines.push(`     ${ui.dim('path'.padEnd(12))}: ${ui.path(pm.path)}`);
    }
  }

  lines.push('', ui.bold('Shell'));
  lines.push(fieldLine(ui, 'shell', snapshot.shell));

  lines.push('', ui.bold('Rust'));
  printTool(lines, snapshot.rust, ui);

  lines.push('', ui.bold('Go'));
  printTool(lines, snapshot.go, ui);

  lines.push('', ui.bold('Existing rule files'));
  if (snapshot.existing_rules.length === 0) {
    lines.push(`  ${ui.dim('(none)')}`);
  }
  for (const rule of snapshot.existing_rules) {
    lines.push(`  ${ui.path(rule)}`);
  }

  console.log(lines.join('\n'));
}
