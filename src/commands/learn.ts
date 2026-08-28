/**
 * aforge learn 命令（Spec §6 命令表 / §7.4）。
 *
 * `aforge learn [--scope project|user] [--file <path>|-] [--id <id>]`：
 * - 输入（§7.4-1）：--file <path> 读文件（相对 cwd）| --file - 读 stdin |
 *   无参数且 TTY → 交互粘贴；非 TTY 无输入 → ConfigError(2)；
 * - 落层：`--scope` > 生效 profile 的 `learning.default_scope`（§4.2）；
 * - 元数据：TTY 时交互询问 trigger / category / confidence（非交互用默认值）；
 * - 结构化写入目标层 learnings/（§7.4-2/3，**不**自动进入投影）；
 * - 内容重复 → warning（§7.5：仍创建）；
 * - 完成后提示 `aforge promote <id>`（§7.4-4）。
 *
 * 核心逻辑在 core/learning/store.createLearning；本层只做输入采集与输出。
 */
import path from 'node:path';
import { cancel, intro, isCancel, multiline, outro, select, text } from '@clack/prompts';
import type { Command } from 'commander';
import { resolveEffectiveConfig } from '../core/config/defaults';
import { resolveWriteTargetLayer } from '../core/config/target-layer';
import type { EnvSnapshot, Scope } from '../core/env';
import { readEnv } from '../core/env';
import { ConfigError } from '../core/errors';
import { type CreateLearningResult, createLearning } from '../core/learning/store';
import { resolveProjectSoT, resolveUserSoT } from '../core/paths';
import type { LearningCategory } from '../schema';
import { type CommandContext, defaultCommandContext, printJson } from './context';
import { parseScopeOption, resolveJsonFlag } from './flags';
import { isInteractiveStdin, readStdinText } from './stdin';

/** 命令上下文（host/os/cwd 注入；测试用真实临时目录 + env 覆盖 host）。 */
export type LearnCommandContext = CommandContext;

/** learn 选项（CLI 解析结果；content 类字段由 action 采集后传入）。 */
export interface LearnOptions {
  /** --scope；缺省 project（§7.4/§4.3 scope 默认）。 */
  readonly scope?: Scope;
  /** --file <path>：经 host 读取（相对 cwd 解析）；'-' 由 action 先读 stdin。 */
  readonly file?: string;
  /** 直传内容（优先级最高；程序化调用/测试）。 */
  readonly content?: string;
  /** --file - 时 action 读好的 stdin 文本。 */
  readonly stdinContent?: string;
  readonly trigger?: string;
  readonly category?: LearningCategory;
  readonly confidence?: number;
  readonly id?: string;
  /** 内容来源标识（file:<path> / stdin / paste / cli）。 */
  readonly source?: string;
}

/** learn 结果（store 结果 + 目标层信息）。 */
export interface LearnResult extends CreateLearningResult {
  readonly scope: Scope;
  readonly sotRoot: string;
}

/**
 * learn 核心逻辑（可注入、不打印）。内容优先级：content > file > stdinContent；
 * 三者皆空 → ConfigError(2)。
 *
 * scope 优先级：`--scope` > `profile.learning.default_scope`（Spec §4.2）——
 * 之前硬编码 'project'，使该配置项完全失效。
 *
 * @throws ConfigError(2) 目标层未初始化 / 内容为空 / id 非法 / CI 环境 / 配置损坏；
 * @throws PermissionError(4) 写入失败。
 */
export async function runLearn(
  ctx: LearnCommandContext,
  options: LearnOptions = {},
): Promise<LearnResult> {
  const env = readEnv(ctx.host);
  const scope: Scope = options.scope ?? (await resolveDefaultLearningScope(ctx, env));
  const layer = await resolveWriteTargetLayer(ctx.host, env, ctx.os, ctx.cwd, scope);

  let content = options.content;
  let source = options.source;
  if (content === undefined) {
    if (options.file !== undefined && options.file !== '-') {
      const file = path.resolve(ctx.cwd, options.file);
      if (!(await ctx.host.exists(file))) {
        throw new ConfigError(`--file 文件不存在: ${options.file}（解析为 ${file}）`, {
          hint: '确认路径正确（相对路径按当前目录解析）',
          details: { file },
        });
      }
      content = await ctx.host.readFile(file);
      source = source ?? `file:${options.file}`;
    } else if (options.stdinContent !== undefined) {
      content = options.stdinContent;
      source = source ?? 'stdin';
    }
  }
  if (content === undefined || content.trim() === '') {
    throw new ConfigError('learning 内容为空（--file <path> / --file - 或交互粘贴提供内容）', {
      hint: '示例: aforge learn --file notes.md；或 echo "..." | aforge learn --file -',
    });
  }

  const result = await createLearning(
    { host: ctx.host, sotRoot: layer.sotRoot },
    {
      content,
      trigger: options.trigger,
      category: options.category,
      confidence: options.confidence,
      id: options.id,
      scope,
      source,
    },
  );
  return { ...result, scope, sotRoot: layer.sotRoot };
}

/** 全部合法 category（§4.3，交互 select 用；字面量 + as const 供泛型推断）。 */
const CATEGORY_OPTIONS = [
  { value: 'tooling' as const, label: 'tooling' },
  { value: 'code-style' as const, label: 'code-style' },
  { value: 'architecture' as const, label: 'architecture' },
  { value: 'debugging' as const, label: 'debugging' },
  { value: 'process' as const, label: 'process' },
  { value: 'security' as const, label: 'security' },
  { value: 'other' as const, label: 'other' },
];

/** 交互采集元数据（trigger / category / confidence；取消 → null 表示放弃）。 */
async function promptMetadata(): Promise<{
  trigger: string;
  category: LearningCategory;
  confidence: number;
} | null> {
  const trigger = await text({
    message: 'Trigger（何时应用此规则，可留空）',
    placeholder: 'e.g. when adding dependencies',
  });
  if (isCancel(trigger)) {
    return null;
  }
  const category = await select<LearningCategory>({
    message: 'Category',
    options: CATEGORY_OPTIONS,
    initialValue: 'other',
  });
  if (isCancel(category)) {
    return null;
  }
  const confidenceRaw = await text({
    message: 'Confidence (0-1)',
    placeholder: '0.5',
    initialValue: '0.5',
  });
  if (isCancel(confidenceRaw)) {
    return null;
  }
  const confidence = Number.parseFloat(confidenceRaw);
  return {
    trigger: trigger.trim(),
    category,
    confidence: Number.isFinite(confidence) ? confidence : 0.5,
  };
}

/**
 * `--scope` 缺省时的落层：生效 profile 的 `learning.default_scope`（Spec §4.2）。
 *
 * user 级 SoT 根不可解析（无 USERPROFILE/HOME）时以 project 根占位装配——与
 * status / doctor 同口径，保证 learn 在缺用户目录的环境下仍可用（默认值仍是
 * schema 的 'project'）。
 */
async function resolveDefaultLearningScope(
  ctx: LearnCommandContext,
  env: EnvSnapshot,
): Promise<Scope> {
  const projectSoTRoot = resolveProjectSoT(ctx.cwd, ctx.os);
  let userSoTRoot = projectSoTRoot;
  try {
    userSoTRoot = resolveUserSoT(env, ctx.os);
  } catch {
    // 用户目录不可解析：仅影响 user 层配置的读取，诊断归 aforge doctor
  }
  const config = await resolveEffectiveConfig(env, userSoTRoot, projectSoTRoot, ctx.host);
  return config.profile.learning.default_scope;
}

export function registerLearnCommand(program: Command): void {
  program
    .command('learn')
    .description('capture a learning entry into SoT learnings/ (not projected until promoted)')
    .option(
      '--scope <scope>',
      'SoT scope to write: project or user (default: profile learning.default_scope)',
    )
    .option('--file <path>', 'read content from a file, or "-" for stdin')
    .option('--id <id>', 'custom learning id (default: auto-generated)')
    .action(
      async (
        options: { scope?: string; file?: string; id?: string; json?: boolean },
        command: Command,
      ) => {
        const json = resolveJsonFlag(command, options.json);
        const scope = parseScopeOption(options.scope);

        // ---- 内容采集（§7.4-1：粘贴 / 文件 / stdin）----
        let stdinContent: string | undefined;
        if (options.file === '-') {
          stdinContent = await readStdinText();
        } else if (options.file === undefined && isInteractiveStdin()) {
          intro('aforge learn');
          const pasted = await multiline({
            message: '粘贴 learning 内容（多行）',
          });
          if (isCancel(pasted)) {
            cancel('已取消');
            return;
          }
          stdinContent = pasted;
          outro('内容已记录');
        } else if (options.file === undefined) {
          throw new ConfigError('非交互终端且未提供内容（需要 --file <path> 或 --file -）', {
            hint: '示例: aforge learn --file - < notes.md，或在交互终端直接运行 aforge learn',
          });
        }

        // ---- 元数据（TTY 交互；非交互走默认值）----
        let trigger: string | undefined;
        let category: LearningCategory | undefined;
        let confidence: number | undefined;
        if (options.file === undefined && isInteractiveStdin()) {
          const meta = await promptMetadata();
          if (meta === null) {
            cancel('已取消');
            return;
          }
          trigger = meta.trigger;
          category = meta.category;
          confidence = meta.confidence;
        }

        const result = await runLearn(defaultCommandContext(), {
          scope,
          file: options.file,
          stdinContent,
          trigger,
          category,
          confidence,
          id: options.id,
        });

        if (json) {
          // §6.2 机器可读输出：与 doctor/status --json 同风格（绝对路径 + 结构化字段）
          printJson({
            learning: result.learning,
            scope: result.scope,
            sotRoot: result.sotRoot,
            file: result.file,
            duplicateOf: result.duplicateOf ?? null,
          });
          return;
        }

        const lines: string[] = [
          `learning created: ${result.learning.id}`,
          `  scope     : ${result.learning.scope} (${result.sotRoot})`,
          `  category  : ${result.learning.category}`,
          `  file      : ${result.file}`,
        ];
        if (result.duplicateOf !== undefined) {
          lines.push(
            `  WARNING   : content duplicates unpromoted entry ${result.duplicateOf} (still created, Spec 7.5)`,
          );
        }
        lines.push(
          '',
          `next: review then run \`aforge promote ${result.learning.id}\` to inject into projections`,
        );
        console.log(lines.join('\n'));
      },
    );
}
