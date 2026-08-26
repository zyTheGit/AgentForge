/**
 * aforge import 命令（Spec §7.7 Import MVP，M9）：从既有 AGENTS.md / CLAUDE.md
 * 导入工具链声明与规则内容。
 *
 * `aforge import <path>`：
 * - 未初始化（effective scope 层 SoT 无 profile.yaml）→ ConfigError(2)；
 * - 文件不存在 / 不可读 / 文件名不是 AGENTS.md|CLAUDE.md → ConfigError(2)；
 * - 解析（纯函数，见 core/importer/importer）：
 *   · 工具链声明 → habits.yaml 的 detected.import 建议字段（source: 'import'）；
 *   · 其余内容块 → `<SoT>\custom\imported-<timestamp>.md`（原样保留块标题）；
 * - 打印映射摘要，提示检查 habits.yaml 并手动执行 `aforge sync`
 *   （不自动 sync，§7.7-6）；纯本地操作，AGF_OFFLINE=1 正常执行（§7.8）。
 */
import path from 'node:path';
import type { Command } from 'commander';
import { stringify as stringifyYaml } from 'yaml';
import { HABITS_FILE, loadHabits, PROFILE_FILE } from '../core/config/load';
import { readEnv } from '../core/env';
import { ConfigError } from '../core/errors';
import {
  buildCustomContent,
  buildImportDetected,
  hasAnySuggestion,
  type ImportFileKind,
  type ImportSuggestions,
  identifyImportFile,
  importTimestamp,
  parseImportedFile,
} from '../core/importer/importer';
import { resolveProjectSoT, resolveUserSoT } from '../core/paths';
import { atomicWrite, ensureTrailingNewline } from '../infra/fsutil';
import { type CommandContext, defaultCommandContext, printJson } from './context';
import { resolveJsonFlag } from './flags';

/** 命令上下文（host/os/cwd 注入；测试用真实临时目录 + realHost）。 */
export type ImportCommandContext = CommandContext;

/** import 结果（打印与测试断言共用）。 */
export interface ImportResult {
  /** 导入文件绝对路径。 */
  readonly importFile: string;
  readonly kind: ImportFileKind;
  /** effective scope 层 SoT 根（AGF_SCOPE=user 时为用户级）。 */
  readonly sotRoot: string;
  readonly habitsFile: string;
  /** 写入的 custom 素材文件绝对路径；无剩余内容块 → null。 */
  readonly customFile: string | null;
  readonly suggestions: ImportSuggestions;
}

/**
 * import 核心逻辑（可注入、不打印——CLI 输出与测试共用同一入口）。
 *
 * @throws ConfigError(2) 未初始化 / 文件不存在或不可读 / 文件名不受支持。
 */
export async function runImport(ctx: ImportCommandContext, pathArg: string): Promise<ImportResult> {
  const env = readEnv(ctx.host);
  const scope = env.agfScope ?? 'project';
  const sotRoot =
    scope === 'project' ? resolveProjectSoT(ctx.cwd, ctx.os) : resolveUserSoT(env, ctx.os);

  // §7.7-1 前置：SoT 必须已初始化（import 不创建 SoT）
  if (!(await ctx.host.exists(path.join(sotRoot, PROFILE_FILE)))) {
    throw new ConfigError(`SoT 未初始化: ${sotRoot}`, {
      hint: '先运行 aforge init，再导入既有规则文件',
      details: { sotRoot },
    });
  }

  // §7.7-1：验证文件存在且可读
  const importFile = path.resolve(ctx.cwd, pathArg);
  if (!(await ctx.host.exists(importFile))) {
    throw new ConfigError(`导入文件不存在: ${importFile}`, {
      hint: '检查路径拼写；支持绝对路径与相对当前目录的路径',
      details: { importFile },
    });
  }
  let content: string;
  try {
    content = await ctx.host.readFile(importFile);
  } catch (err) {
    throw new ConfigError(`导入文件不可读: ${importFile}`, {
      hint: '检查文件权限与占用状态（关闭正在编辑该文件的程序后重试）',
      details: err,
    });
  }

  // §7.7-2：按文件名识别类型（MVP 仅 AGENTS.md / CLAUDE.md）
  const kind = identifyImportFile(path.basename(importFile));
  if (kind === undefined) {
    throw new ConfigError(`不支持的导入文件: ${path.basename(importFile)}`, {
      hint: 'MVP 仅支持 AGENTS.md / CLAUDE.md（按文件名识别）',
      details: { importFile },
    });
  }

  // §7.7-3/4：解析 + 映射（纯函数；marker 区间已在解析内剥除）
  const parsed = parseImportedFile(content);
  const now = ctx.host.now();

  // habits.yaml：detected.import 建议字段（不覆盖既有声明字段与探测快照）
  const habitsFile = path.join(sotRoot, HABITS_FILE);
  const habits = (await loadHabits(ctx.host, sotRoot)) ?? { version: 1 };
  const detected: Record<string, unknown> = { ...((habits.detected as object | undefined) ?? {}) };
  if (hasAnySuggestion(parsed.suggestions)) {
    detected.import = buildImportDetected(
      parsed.suggestions,
      path.basename(importFile),
      now.toISOString(),
    );
  }
  const habitsYaml = stringifyYaml({ ...habits, detected }, { lineWidth: 0 });
  await atomicWrite(ctx.host, habitsFile, ensureTrailingNewline(habitsYaml));

  // §7.7-4：剩余内容块 → custom/imported-<timestamp>.md
  let customFile: string | null = null;
  if (parsed.customBlocks.length > 0) {
    customFile = path.join(sotRoot, 'custom', `imported-${importTimestamp(now)}.md`);
    await atomicWrite(ctx.host, customFile, buildCustomContent(parsed.customBlocks));
  }

  return {
    importFile,
    kind,
    sotRoot,
    habitsFile,
    customFile,
    suggestions: parsed.suggestions,
  };
}

/** 建议摘要行（ASCII，两列对齐；无命中时输出 '(none)'）。 */
function suggestionSummary(s: ImportSuggestions): string[] {
  const pms = s.packageManagers.join(', ');
  return [
    `  node manager     : ${s.nodeManager ?? '(none)'}`,
    `  python manager   : ${s.pythonManager ?? '(none)'}`,
    `  package managers : ${pms === '' ? '(none)' : pms}`,
  ];
}

export function registerImportCommand(program: Command): void {
  program
    .command('import <path>')
    .description(
      'import toolchain declarations and rule blocks from an existing AGENTS.md / CLAUDE.md',
    )
    .action(async (pathArg: string, _options: unknown, command: Command) => {
      const result = await runImport(defaultCommandContext(), pathArg);

      if (resolveJsonFlag(command)) {
        // §6.2 机器可读输出（路径一律绝对路径）
        printJson(result);
        return;
      }

      const lines: string[] = [
        `aforge import - ${path.basename(result.importFile)} (${result.kind})`,
        `SoT root: ${result.sotRoot}`,
        '',
        'toolchain declarations detected (suggestions saved to habits.yaml detected.import):',
        ...suggestionSummary(result.suggestions),
        '',
        result.customFile === null
          ? 'custom blocks: (none - all blocks were toolchain declarations)'
          : `custom blocks written: ${result.customFile}`,
        `habits.yaml updated: ${result.habitsFile}`,
        '',
        'next: review habits.yaml (move suggestions into declared fields if desired),',
        'then run `aforge sync` to project the imported rules',
      ];
      console.log(lines.join('\n'));
    });
}
