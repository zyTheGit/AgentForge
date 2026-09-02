/**
 * aforge learn 命令（Spec §6 命令表 / §7.4）。
 *
 * `aforge learn [--scope project|user] [--file <path>|-] [--id <id>] [--confidence <0-1>]`：
 * - 输入（§7.4-1）：--file <path> 读文件（相对 cwd）| --file - 读 stdin |
 *   无参数且 TTY → 交互粘贴；非 TTY 无输入 → ConfigError(2)；
 * - 落层：`--scope` > 生效 profile 的 `learning.default_scope`（§4.2）；
 * - 元数据：TTY 时交互询问 trigger / category / confidence（非交互用默认值）；
 * - `--confidence` 显式给值 → 原样落盘并跳过自动打分；**省略 → 启发式打分**
 *   （core/learning/scoring，不再硬编码 0.5），breakdown 随输出打印；
 * - 结构化写入目标层 learnings/（§7.4-2/3，**不**自动进入投影）；
 * - 内容与既有未晋升条目高度相似 → warning（§7.5：仍创建）；中等相似 → 合并建议；
 * - 完成后提示 `aforge promote <id>`（§7.4-4）。
 *
 * `aforge learn --print-protocol` 是一条**只读旁路**：只把 `## Learning Protocol`
 * 正文打到 stdout 后立刻返回，不解析配置、不读 SoT、不写盘、不取锁、不进交互。
 * 它是 `learning.auto_capture: hook` 档下会话钩子执行的唯一命令（见
 * core/learning/hook-capture.ts）——正因为只读，才能在 CI、无 TTY、与人工
 * `aforge sync` 并发这三种场景下都安全运行。
 *
 * 核心逻辑在 core/learning/store.createLearning；本层只做输入采集与输出。
 *
 * **auto_promote（§4.2 `learning.auto_promote`，默认 false）**：为真时条目落盘后
 * 立刻在同一次命令内跑一遍 §7.5 promote（产物写入条目所在层，等价于不带 `--to`
 * 的 `aforge promote <id>`）。`--no-auto-promote` 可单次关掉。两点边界：
 * - **仍不投影**：promote 只写 SoT 的 `custom/` 或 `skills/`，进 agent 侧投影依旧
 *   要 `aforge sync`（§7.4-3 的"不自动进入投影"未被破坏）；
 * - **不回滚 learn**：promote 失败（目标文件已存在 → 3 / 无写权限 → 4）时条目
 *   **保留**且仍为 promoted:false，命令先打印"learning created"再按 promote 的
 *   退出码失败，用户处理掉冲突后 `aforge promote <id>` 即可续跑。故失败原因不能
 *   直接 throw 出 runLearn——那会让"条目已创建"这件事在输出里丢掉。
 */
import path from 'node:path';
import { cancel, intro, isCancel, multiline, outro, select, text } from '@clack/prompts';
import type { Command } from 'commander';
import { resolveEffectiveConfig } from '../../core/config/defaults';
import { resolveWriteTargetLayer } from '../../core/config/target-layer';
import type { EnvSnapshot, Scope } from '../../core/env';
import { readEnv } from '../../core/env';
import { ConfigError } from '../../core/errors';
import { sessionHookProtocolText } from '../../core/learning/hook-capture';
import { type PromoteResult, promoteLearning } from '../../core/learning/promote';
import { type CreateLearningResult, createLearning } from '../../core/learning/store';
import { resolveProjectSoT, resolveUserSoT } from '../../core/paths';
import { getUi, type Ui } from '../../infra/ui';
import type { LearningCategory, Profile } from '../../schema';
import { type CommandContext, defaultCommandContext, printJson } from '../_shared/context';
import {
  assertPrintProtocolAlone,
  parseConfidenceOption,
  parseScopeOption,
  resolveJsonFlag,
} from '../_shared/flags';
import { isInteractiveStdin, readStdinText } from '../_shared/stdin';
import { confidenceKvLine, learningQualityJson, similarityHintLine } from './confidence-view';

/** 详情行的 label 宽度（`category` / `promoted` / `WARNING` 同档，冒号同列）。 */
const LEARN_LABEL_WIDTH = 8;

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
  /** 显式置信度；省略 → createLearning 走启发式自动打分。 */
  readonly confidence?: number;
  readonly id?: string;
  /** 内容来源标识（file:<path> / stdin / paste / cli）。 */
  readonly source?: string;
  /** 覆盖 `profile.learning.auto_promote`（`--no-auto-promote` → false）；缺省随配置。 */
  readonly autoPromote?: boolean;
}

/**
 * auto_promote 的执行结果。失败**不**中断 learn（条目已落盘、仍 promoted:false），
 * 错误原样带出由命令层先打印条目再按其退出码失败。
 */
export type AutoPromoteOutcome =
  | { readonly ok: true; readonly result: PromoteResult }
  | { readonly ok: false; readonly error: unknown };

/** learn 结果（store 结果 + 目标层信息）。 */
export interface LearnResult extends CreateLearningResult {
  readonly scope: Scope;
  readonly sotRoot: string;
  /** auto_promote 关闭时为 undefined（"没跑" ≠ "跑了但失败"）。 */
  readonly autoPromote: AutoPromoteOutcome | undefined;
}

/**
 * learn 核心逻辑（可注入、不打印）。内容优先级：content > file > stdinContent；
 * 三者皆空 → ConfigError(2)。
 *
 * scope 优先级：`--scope` > `profile.learning.default_scope`（Spec §4.2）——
 * 之前硬编码 'project'，使该配置项完全失效。
 *
 * auto_promote 优先级：`options.autoPromote`（`--no-auto-promote`）>
 * `profile.learning.auto_promote`。为真时条目落盘后立刻 promote，失败经
 * `autoPromote.ok === false` 上报而**不**抛出（见文件头）。
 *
 * @throws ConfigError(2) 目标层未初始化 / 内容为空 / id 非法 / CI 环境 / 配置损坏；
 * @throws PermissionError(4) 写入失败。
 */
export async function runLearn(
  ctx: LearnCommandContext,
  options: LearnOptions = {},
): Promise<LearnResult> {
  const env = readEnv(ctx.host);
  const learningConfig = await resolveLearningConfig(ctx, env);
  const scope: Scope = options.scope ?? learningConfig.default_scope;
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

  const autoPromote =
    (options.autoPromote ?? learningConfig.auto_promote)
      ? await tryAutoPromote(ctx, env, result.learning.id)
      : undefined;
  return { ...result, scope, sotRoot: layer.sotRoot, autoPromote };
}

/**
 * 落盘后的自动 promote（等价于不带 `--to` 的 `aforge promote <id>`：产物写入条目
 * 所在层）。异常一律收进 `ok:false` —— learn 已经改了磁盘，抛出去会让"条目已创建"
 * 从输出里消失，用户不知道该 `aforge promote <id>` 续跑还是重新 learn。
 */
async function tryAutoPromote(
  ctx: LearnCommandContext,
  env: EnvSnapshot,
  id: string,
): Promise<AutoPromoteOutcome> {
  try {
    const result = await promoteLearning({ host: ctx.host, env, os: ctx.os, cwd: ctx.cwd }, id);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
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

/**
 * 交互采集元数据（trigger / category / confidence；取消 → null 表示放弃）。
 *
 * confidence 留空 → `undefined`，交给启发式自动打分（初始值刻意为空而不是 0.5：
 * 预填一个数会让人以为"这就是系统的判断"，然后直接回车把它固化下来）。填了但不是
 * [0,1] 的数 → parseConfidenceOption 抛 ConfigError(2)，不静默兜底。
 */
async function promptMetadata(): Promise<{
  trigger: string;
  category: LearningCategory;
  confidence: number | undefined;
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
    message: 'Confidence (0-1，留空 = 自动打分)',
    placeholder: 'auto',
  });
  if (isCancel(confidenceRaw)) {
    return null;
  }
  const trimmed = confidenceRaw.trim();
  return {
    trigger: trigger.trim(),
    category,
    confidence: trimmed === '' ? undefined : parseConfidenceOption(trimmed),
  };
}

/**
 * 生效 profile 的 `learning` 段（Spec §4.2）：`default_scope` 决定 `--scope` 缺省时
 * 的落层，`auto_promote` 决定落盘后是否自动 promote。
 *
 * user 级 SoT 根不可解析（无 USERPROFILE/HOME）时以 project 根占位装配——与
 * status / doctor 同口径，保证 learn 在缺用户目录的环境下仍可用（默认值仍是
 * schema 的 'project' / false）。
 */
async function resolveLearningConfig(
  ctx: LearnCommandContext,
  env: EnvSnapshot,
): Promise<Profile['learning']> {
  const projectSoTRoot = resolveProjectSoT(ctx.cwd, ctx.os);
  let userSoTRoot = projectSoTRoot;
  try {
    userSoTRoot = resolveUserSoT(env, ctx.os);
  } catch {
    // 用户目录不可解析：仅影响 user 层配置的读取，诊断归 aforge doctor
  }
  const config = await resolveEffectiveConfig(env, userSoTRoot, projectSoTRoot, ctx.host);
  return config.profile.learning;
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
    .option(
      '--confidence <value>',
      'explicit confidence 0-1 (default: scored by heuristics from the content)',
    )
    .option('--no-auto-promote', 'do not promote right away even if learning.auto_promote is true')
    .option(
      '--print-protocol',
      'print the learning protocol text and exit (used by the session hook of learning.auto_capture: hook)',
    )
    .action(
      async (
        options: {
          scope?: string;
          file?: string;
          id?: string;
          confidence?: string;
          json?: boolean;
          autoPromote?: boolean;
          printProtocol?: boolean;
        },
        command: Command,
      ) => {
        // ---- --print-protocol：会话钩子唯一执行的分支（§7.4 hook 档）----
        // 必须在一切之前返回：只读、不解析配置、不读 SoT、不写盘、不取锁、不进交互，
        // 因此在 CI 下、无 TTY 下、与 aforge sync 并发时都能安全跑（见
        // core/learning/hook-capture.ts 的约束 2）。--json 不影响它：钩子要的是
        // 能直接进上下文的纯文本，包一层 JSON 反而要 target 侧再解一次。
        if (options.printProtocol === true) {
          assertPrintProtocolAlone(options);
          console.log(sessionHookProtocolText());
          return;
        }
        const json = resolveJsonFlag(command, options.json);
        const scope = parseScopeOption(options.scope);
        const explicitConfidence = parseConfidenceOption(options.confidence);
        // commander 的 --no-x 无参时恒为 true，区分不出"未指定"；只把显式 false
        // 当覆盖，其余交回 profile.learning.auto_promote
        const autoPromote = options.autoPromote === false ? false : undefined;

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
        // `--confidence` 显式给了就不再被交互应答覆盖（标志比提问更明确）
        let confidence: number | undefined = explicitConfidence;
        if (options.file === undefined && isInteractiveStdin()) {
          const meta = await promptMetadata();
          if (meta === null) {
            cancel('已取消');
            return;
          }
          trigger = meta.trigger;
          category = meta.category;
          confidence = explicitConfidence ?? meta.confidence;
        }

        const ctx = defaultCommandContext();
        const result = await runLearn(ctx, {
          scope,
          file: options.file,
          stdinContent,
          trigger,
          category,
          confidence,
          id: options.id,
          autoPromote,
        });
        const now = ctx.host.now();

        if (json) {
          // §6.2 机器可读输出：与 doctor/status --json 同风格（绝对路径 + 结构化字段）
          printJson({
            learning: result.learning,
            scope: result.scope,
            sotRoot: result.sotRoot,
            file: result.file,
            duplicateOf: result.duplicateOf ?? null,
            similarTo: result.similarTo ?? null,
            quality: learningQualityJson(result.learning, now),
            autoPromote: describeAutoPromoteJson(result.autoPromote),
          });
          throwAutoPromoteFailure(result.autoPromote);
          return;
        }

        const ui = getUi();
        const lines: string[] = [
          `${ui.green('learning created')}: ${ui.bold(result.learning.id)}`,
          ui.kv(
            'scope',
            `${result.learning.scope} (${ui.path(result.sotRoot)})`,
            LEARN_LABEL_WIDTH,
          ),
          ui.kv('category', result.learning.category, LEARN_LABEL_WIDTH),
          confidenceKvLine(result.learning, now, LEARN_LABEL_WIDTH, ui),
          ui.kv('file', ui.path(result.file), LEARN_LABEL_WIDTH),
        ];
        if (result.duplicateOf !== undefined) {
          lines.push(
            ui.kv(
              'WARNING',
              ui.yellow(
                `content duplicates unpromoted entry ${result.duplicateOf} (still created, Spec 7.5)`,
              ),
              LEARN_LABEL_WIDTH,
            ),
          );
        }
        if (result.similarTo !== undefined) {
          lines.push(ui.kv('NOTE', similarityHintLine(result.similarTo, ui), LEARN_LABEL_WIDTH));
        }
        lines.push(...autoPromoteLines(result));
        console.log(lines.join('\n'));
        throwAutoPromoteFailure(result.autoPromote);
      },
    );
}

/** auto_promote 的 --json 形态（关闭 → null，避免与"跑了但失败"混淆）。 */
function describeAutoPromoteJson(
  outcome: AutoPromoteOutcome | undefined,
): Record<string, unknown> | null {
  if (outcome === undefined) {
    return null;
  }
  if (!outcome.ok) {
    return { ok: false, error: describeAutoPromoteError(outcome.error) };
  }
  return {
    ok: true,
    targetScope: outcome.result.targetScope,
    targetSoTRoot: outcome.result.targetSoTRoot,
    targetFile: outcome.result.targetFile,
    promotedAt: outcome.result.learning.promoted_at,
  };
}

function describeAutoPromoteError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 人类可读输出的尾段：auto_promote 结果 + 下一步提示。 */
function autoPromoteLines(result: LearnResult, ui: Ui = getUi()): string[] {
  const outcome = result.autoPromote;
  if (outcome === undefined) {
    return [
      '',
      ui.next(
        `review then run ${ui.code(`aforge promote ${result.learning.id}`)} to inject into projections`,
      ),
    ];
  }
  if (!outcome.ok) {
    return [
      '',
      ui.red(
        `auto-promote FAILED (learning.auto_promote=true): ${describeAutoPromoteError(outcome.error)}`,
      ),
      ui.yellow(
        `  entry kept as promoted:false - fix the cause then run \`aforge promote ${result.learning.id}\``,
      ),
    ];
  }
  return [
    ui.kv(
      'promoted',
      `${ui.path(outcome.result.targetFile)} ${ui.dim('(learning.auto_promote=true)')}`,
      LEARN_LABEL_WIDTH,
    ),
    '',
    ui.next(`run ${ui.code('aforge sync')} to project the promoted rule into agent targets`),
  ];
}

/**
 * auto_promote 失败时按 promote 的退出码失败（3 冲突 / 4 权限），但**在打印之后**
 * ——用户先看到条目已创建，再看到失败原因，才知道下一步是续跑 promote。
 */
function throwAutoPromoteFailure(outcome: AutoPromoteOutcome | undefined): void {
  if (outcome !== undefined && !outcome.ok) {
    throw outcome.error;
  }
}
