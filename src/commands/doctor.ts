/**
 * aforge doctor 命令（Spec §9，M7）：一致性与环境诊断报告。
 *
 * - 默认人类可读输出：按 Configuration / Paths / Consistency / Environment 分节，
 *   每条以 [OK] / [WARN] / [FAIL] 前缀（纯 ASCII，Windows GBK 控制台安全）；
 * - --json 输出结构化报告（DoctorReport：results + 聚合退出码）；
 * - 退出码：聚合规则见 core/doctor/checks.doctorExitCode（§6.1 映射）——
 *   诊断发现问题属"正常输出"而非异常，故不抛错、直接设 process.exitCode；
 *   runDoctorChecks 自身的意外错误仍走 main.ts 统一出口。
 *
 * 核心逻辑在 core/doctor/checks.runDoctorChecks；本层只做参数解析与输出。
 */
import type { Command } from 'commander';
import {
  type DoctorLevel,
  type DoctorReport,
  type DoctorSection,
  runDoctorChecks,
} from '../core/doctor/checks';
import { readEnv } from '../core/env';
import { type CommandContext, defaultCommandContext, printJson } from './context';
import { resolveJsonFlag } from './flags';

/** 命令上下文（host/os/cwd 注入；测试可换 fake host 与任意平台）。 */
export type DoctorCommandContext = CommandContext;

/** doctor 核心逻辑（可注入、不打印）。@see runDoctorChecks 的检查清单与契约。 */
export async function runDoctor(ctx: DoctorCommandContext): Promise<DoctorReport> {
  return runDoctorChecks({
    host: ctx.host,
    env: readEnv(ctx.host),
    os: ctx.os,
    cwd: ctx.cwd,
  });
}

/** 级别 → 人类可读标签（纯 ASCII；padEnd(4) 对齐 item 起始列）。 */
const LEVEL_LABELS: Readonly<Record<DoctorLevel, string>> = {
  ok: 'OK',
  warn: 'WARN',
  error: 'FAIL',
};

/** 分节 → 标题（人类可读输出的节名）。 */
const SECTION_TITLES: Readonly<Record<DoctorSection, string>> = {
  config: 'Configuration',
  paths: 'Paths & writability',
  consistency: 'Consistency',
  environment: 'Environment',
};

/** 分节输出顺序（config → paths → consistency → environment）。 */
const SECTION_ORDER: readonly DoctorSection[] = ['config', 'paths', 'consistency', 'environment'];

/** item 行前缀宽度（`  [WARN] ` = 9 列）；detail / hint 行缩进与之对齐。 */
const DETAIL_INDENT = ' '.repeat(9);

/** 人类可读报告（分节 + 级别前缀 + summary 尾行；调用方 console.log）。 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ['aforge doctor - consistency & environment report', ''];

  for (const section of SECTION_ORDER) {
    const items = report.results.filter((r) => r.section === section);
    if (items.length === 0) {
      continue;
    }
    lines.push(`== ${SECTION_TITLES[section]} ==`);
    for (const result of items) {
      lines.push(`  [${LEVEL_LABELS[result.level].padEnd(4)}] ${result.item}`);
      for (const line of result.detail.split('\n')) {
        lines.push(`${DETAIL_INDENT}${line}`);
      }
      if (result.hint !== undefined) {
        lines.push(`${DETAIL_INDENT}hint: ${result.hint}`);
      }
    }
    lines.push('');
  }

  const okCount = report.results.filter((r) => r.level === 'ok').length;
  const warnCount = report.results.filter((r) => r.level === 'warn').length;
  const errorCount = report.results.filter((r) => r.level === 'error').length;
  lines.push(
    `summary: ${okCount} ok, ${warnCount} warn, ${errorCount} error, exit code ${report.exitCode}`,
  );
  return lines.join('\n');
}

/** 注册 doctor 命令（由 cli.ts 装配调用）。 */
export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('diagnose SoT config, projection consistency and environment issues')
    .option('--json', 'print machine-readable JSON (results + aggregated exit code)')
    .action(async (options: { json?: boolean }, command: Command) => {
      const report = await runDoctor(defaultCommandContext());
      if (resolveJsonFlag(command, options.json)) {
        printJson(report);
      } else {
        console.log(formatDoctorReport(report));
      }
      // 诊断结论经退出码表达（§6.1 映射），不作为异常抛出（main.ts 只接意外错误）
      if (report.exitCode !== 0) {
        process.exitCode = report.exitCode;
      }
    });
}
