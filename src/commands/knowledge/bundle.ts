/**
 * aforge bundle 命令：SoT 的导出与导入（迁移 / 备份 / 换机器）。
 *
 * `aforge bundle export --out <dir> [--scope s] [--no-redact] [--keep-detected] [--json]`
 * `aforge bundle import --from <dir> [--scope s] [--on-conflict skip|overwrite|rename] [--json]`
 *
 * 与既有 `aforge import <path>` 的区别（**两者不是一回事，刻意分开命名**）：
 * - `aforge import AGENTS.md`：从既有规则文件里**抽取工具链声明**填进 habits/custom；
 * - `aforge bundle import`：把一整份 SoT 落盘（自带完整性校验与冲突策略）。
 *   共用一个命令名会让 scope、冲突策略与退出码语义纠缠在一起。
 *
 * 本层只做参数解析与输出渲染；分类规则见 core/bundle/layout，
 * 净化改写见 core/bundle/redact，两条主流程见 core/bundle/export|import。
 */
import path from 'node:path';
import type { Command } from 'commander';
import {
  type BundleExportResult,
  exportBundle,
  redactedCountWarning,
} from '../../core/bundle/export';
import {
  BUNDLE_CONFLICT_POLICIES,
  type BundleConflictPolicy,
  type BundleImportResult,
  importBundle,
} from '../../core/bundle/import';
import { ConfigError } from '../../core/errors';
import { VERSION } from '../../version';
import {
  type CommandContext,
  defaultCommandContext,
  printJson,
  renderList,
} from '../_shared/context';
import { parseScopeOption, resolveJsonFlag } from '../_shared/flags';

/** 命令上下文（host/os/cwd 注入；export 另需 CLI 版本写进 manifest）。 */
export type BundleCommandContext = CommandContext;

/** export 核心逻辑（可注入、不打印）。 */
export async function runBundleExport(
  ctx: BundleCommandContext,
  options: {
    readonly out: string;
    readonly scope?: BundleExportScope;
    readonly redact?: boolean;
    readonly keepDetected?: boolean;
  },
): Promise<BundleExportResult> {
  return exportBundle(
    { host: ctx.host, cwd: ctx.cwd, os: ctx.os, agentforgeVersion: VERSION },
    {
      out: options.out,
      scope: options.scope,
      redact: options.redact,
      keepDetected: options.keepDetected,
    },
  );
}

/** scope 取值与 flags.parseScopeOption 出口同型（project | user）。 */
type BundleExportScope = 'project' | 'user';

/** import 核心逻辑（可注入、不打印）。 */
export async function runBundleImport(
  ctx: BundleCommandContext,
  options: {
    readonly from: string;
    readonly scope?: BundleExportScope;
    readonly onConflict?: BundleConflictPolicy;
  },
): Promise<BundleImportResult> {
  return importBundle(
    { host: ctx.host, cwd: ctx.cwd, os: ctx.os },
    { from: options.from, scope: options.scope, onConflict: options.onConflict },
  );
}

/**
 * `--on-conflict` 的字面量校验与收窄。
 *
 * 拼错的策略绝不能静默退化成缺省 `skip`：用户写 `--on-conflict overwrit` 是想覆盖，
 * 静默按 skip 跑完会报「全部跳过」，看起来像 bundle 是空的。
 *
 * @throws ConfigError(2) 取值不在 BUNDLE_CONFLICT_POLICIES 内。
 */
export function parseConflictPolicy(raw: string | undefined): BundleConflictPolicy | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!(BUNDLE_CONFLICT_POLICIES as readonly string[]).includes(raw)) {
    throw new ConfigError(`非法 --on-conflict: ${raw}`, {
      hint: `有效值: ${BUNDLE_CONFLICT_POLICIES.join(', ')}`,
      details: { onConflict: raw },
    });
  }
  return raw as BundleConflictPolicy;
}

/**
 * 人类可读输出里逐条列举的上限。
 *
 * 一份真实 SoT 有几百个文件，全量铺开会把 scope / warnings / next 这些真正要看的
 * 行冲出屏幕。超出部分折叠成一行计数并指向 `--json`——机器口径本来就是全量的。
 */
const RENDER_ITEM_LIMIT = 20;

/** 逐条列举，超过 RENDER_ITEM_LIMIT 时折叠尾部（indent 为每行前缀）。 */
function pushCapped(lines: string[], items: readonly string[], indent: string): void {
  for (const item of items.slice(0, RENDER_ITEM_LIMIT)) {
    lines.push(`${indent}${item}`);
  }
  const rest = items.length - RENDER_ITEM_LIMIT;
  if (rest > 0) {
    lines.push(`${indent}... and ${rest} more (use --json for the full list)`);
  }
}

/** export 的人类可读输出。 */
function renderExport(result: BundleExportResult): string {
  const m = result.manifest;
  const lines = [
    `bundle exported: ${result.outDir}`,
    `  scope     : ${result.scope} (${result.sotRoot})`,
    `  manifest  : ${result.manifestFile}`,
    `  content   : ${result.contentDir}`,
    `  files     : ${m.files.length} file(s) carried`,
  ];
  pushCapped(
    lines,
    m.files.map((file) => `- ${file.path}${file.transformed ? '  [transformed]' : ''}`),
    '    ',
  );
  if (m.excluded.length > 0) {
    lines.push(`  excluded  : ${m.excluded.length} entry(ies) left behind`);
    pushCapped(
      lines,
      m.excluded.map((entry) => `- ${entry.path} (${entry.reason})`),
      '    ',
    );
  }
  if (m.redacted.length > 0) {
    lines.push(`  redacted  : ${m.redacted.length} credential value(s) replaced by a placeholder`);
    pushCapped(
      lines,
      m.redacted.map((key) => `- ${key}`),
      '    ',
    );
  }
  if (m.warnings.length > 0) {
    lines.push('  warnings  :');
    for (const warning of m.warnings) {
      lines.push(`    - ${warning}`);
    }
  }
  lines.push(
    '',
    'next: move this directory to the target machine, then run',
    `      aforge bundle import --from ${result.outDir}`,
  );
  return lines.join('\n');
}

/** 醒目告警的分隔带宽度（纯 ASCII，Windows GBK 控制台安全，同 doctor 的取舍）。 */
const ALERT_RULE = '='.repeat(72);

/**
 * 凭据占位符告警块。
 *
 * 刻意放在**输出最末尾**（`next:` 之后）：这条是唯一「不处理就会静默出问题」的信息，
 * 而终端只保证最后几行必然在视野里——夹在文件清单与 next 之间会被一起滚过去。
 * 与 doctor 同用 `[WARN]` 前缀，加 `=` 分隔带把它从流水账里拽出来。
 *
 * 除了告警本身，还给出**改哪个文件**：用户拿到字段路径也得自己推 profile.yaml 在哪，
 * 少这一句就等于把最后一步留给用户猜。
 */
function pushCredentialAlert(lines: string[], result: BundleImportResult): void {
  const keys = result.manifest.redacted;
  if (keys.length === 0) {
    return;
  }
  lines.push('', ALERT_RULE, `[WARN] ${keys.length} credential value(s) are placeholders.`);
  lines.push('       The MCP server(s) below will fail auth until you set them again:');
  for (const key of keys) {
    lines.push(`         - ${key}`);
  }
  lines.push(
    `       Edit ${path.join(result.sotRoot, 'profile.yaml')}, then run \`aforge sync\`.`,
    ALERT_RULE,
  );
}

/** import 的人类可读输出（导出供测试断言告警块位置，同 doctor.formatDoctorReport 的取舍）。 */
export function renderImport(result: BundleImportResult): string {
  const counts = {
    written: result.entries.filter((e) => e.action === 'written').length,
    skipped: result.entries.filter((e) => e.action === 'skipped').length,
    renamed: result.entries.filter((e) => e.action === 'renamed').length,
  };
  const lines = [
    `bundle imported: ${result.bundleDir}`,
    `  scope     : ${result.scope} (${result.sotRoot})`,
    `  policy    : ${result.onConflict}`,
    `  written   : ${counts.written}`,
    `  skipped   : ${counts.skipped}`,
    `  renamed   : ${counts.renamed}`,
  ];
  pushCapped(
    lines,
    result.entries.map((entry) => `- ${entry.path} [${entry.action}] -> ${entry.target}`),
    '    ',
  );
  if (counts.skipped > 0 && result.onConflict === 'skip') {
    lines.push(
      '',
      'note: existing files were kept. rerun with --on-conflict overwrite (replace)',
      '      or --on-conflict rename (park the incoming copy next to yours).',
    );
  }
  if (result.manifest.warnings.length > 0) {
    // 被抹凭据那条由末尾的醒目块承担（连键名与要改的文件一起给），这里滤掉避免重复
    const noise = redactedCountWarning(result.manifest.redacted.length);
    const warnings = result.manifest.warnings.filter((w) => w !== noise);
    if (warnings.length > 0) {
      lines.push('', 'export-time warnings:');
      for (const warning of warnings) {
        lines.push(`      - ${warning}`);
      }
    }
  }
  if (result.unlisted.length > 0) {
    lines.push(
      '',
      `note: ${result.unlisted.length} file(s) in the bundle are not listed in manifest.json and were NOT imported:`,
      `      ${renderList(result.unlisted)}`,
    );
  }
  lines.push(
    '',
    'next: aforge detect   (refresh this machine toolchain snapshot)',
    '      aforge sync     (project the imported SoT to your agents)',
  );
  pushCredentialAlert(lines, result);
  return lines.join('\n');
}

export function registerBundleCommand(program: Command): void {
  const cmd = program
    .command('bundle')
    .description('export / import a whole SoT layer (migration, backup, new machine)');

  cmd
    .command('export')
    .description('copy one SoT layer into a portable bundle directory (manifest + sot/)')
    .requiredOption('--out <dir>', 'output directory (must be empty or missing)')
    .option('--scope <scope>', 'SoT scope to export: project or user (default: effective scope)')
    .option('--no-redact', 'keep MCP credentials as-is (default: replace values by a placeholder)')
    .option('--keep-detected', 'keep habits.detected (default: dropped - it is a machine snapshot)')
    .option('--json', 'machine-readable output (absolute paths) - Spec 6.2')
    .action(
      async (
        options: {
          out: string;
          scope?: string;
          redact: boolean;
          keepDetected?: boolean;
          json?: boolean;
        },
        command: Command,
      ) => {
        const result = await runBundleExport(defaultCommandContext(), {
          out: options.out,
          scope: parseScopeOption(options.scope),
          redact: options.redact,
          keepDetected: options.keepDetected === true,
        });
        if (resolveJsonFlag(command, options.json)) {
          printJson(result);
          return;
        }
        console.log(renderExport(result));
      },
    );

  cmd
    .command('import')
    .description('write a bundle directory into one SoT layer (verifies sha256 before writing)')
    .requiredOption('--from <dir>', 'bundle directory produced by `aforge bundle export`')
    .option(
      '--scope <scope>',
      'SoT scope to write: project or user (default: AGF_SCOPE or project)',
    )
    .option('--on-conflict <policy>', 'existing target files: skip (default) | overwrite | rename')
    .option('--json', 'machine-readable output (absolute paths) - Spec 6.2')
    .action(
      async (
        options: { from: string; scope?: string; onConflict?: string; json?: boolean },
        command: Command,
      ) => {
        const result = await runBundleImport(defaultCommandContext(), {
          from: options.from,
          scope: parseScopeOption(options.scope),
          onConflict: parseConflictPolicy(options.onConflict),
        });
        if (resolveJsonFlag(command, options.json)) {
          printJson(result);
          return;
        }
        console.log(renderImport(result));
      },
    );
}
