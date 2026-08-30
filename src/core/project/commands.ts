/**
 * Commands 薄壳的 SoT 侧派生（Spec §8.8）。
 *
 * `skills.expose_as_command` 点名的技能，除 skill 投影外**额外**投影一份命令/prompt
 * 薄壳。薄壳内容不复制技能正文——只写「加载技能 X、按其工作流执行、用户输入见
 * `$ARGUMENTS`」，元信息从 `SKILL.md` 的 frontmatter 派生（§8.8.1），避免同一份
 * 说明在 SoT 与投影产物里存两份而漂移。
 *
 * 本模块只做**派生与校验**，不碰路径：各 target 的落点（`command\` / `commands\` /
 * `prompts\`）与 codex 的 project scope 降级留在各自 projector 里，因为那是 target
 * 知识；这里产出的是四家共用的一份 `CommandArtifact`。
 *
 * 无 IO：输入是已读入内存的 `SkillArtifact[]`（引擎已按 §5.3 解析过 project/user
 * 两层优先级），因此 doctor 的只读路径也能复用同一套判定。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Profile } from '../../schema';
import { ConfigError } from '../errors';
import type { CommandArtifact, SkillArtifact } from './types';

/** frontmatter 里唯一被透传的两个键（§8.8.2：其余键不进薄壳）。 */
const PASSTHROUGH_DESCRIPTION = 'description';
const PASSTHROUGH_ARGUMENT_HINT = 'argument-hint';

/**
 * SoT 侧自定义命令正文的 frontmatter 键（§8.8.2 位置参数）。
 *
 * 不透传进薄壳 frontmatter——它是**正文**来源，不是元信息。
 */
export const COMMAND_BODY_KEY = 'command-body';

/** 命名空间分隔符（SoT 侧统一用 `/`；各 target 的呈现差异由 projector 负责）。 */
export const COMMAND_NAMESPACE_SEPARATOR = '/';

/**
 * pi / codex 目录扁平时的命名空间拼接符（§8.8.2 降级）。
 *
 * 用 `-` 而非 `:`：`:` 在 Windows 文件名里非法，会让整轮 sync 在写盘阶段失败。
 */
export const COMMAND_FLATTEN_SEPARATOR = '-';

/** frontmatter 分隔线（`---` 独占一行，允许行尾空白与 CRLF）。 */
const FRONTMATTER_FENCE = /^---[ \t]*\r?$|^---[ \t]*$/;

/** 命令名/命名空间段里禁止出现的字符（Windows 文件名非法字符 + 路径分隔符）。 */
const UNSAFE_SEGMENT_CHARS = /[\\:*?"<>|]/;

/**
 * 正文里所有 `$` 引导的记号（用于 §8.8.2 占位符白名单校验）。
 *
 * 覆盖四类写法：`${...}`（pi 专有默认值语法）、`$NAME`、`$12`、`$@` / `$*`，
 * 逐个比对白名单，不在其中即报错——放过一个未知记号，用户只会在 target
 * 侧看到「命令展开成一段字面量」这种难查的症状。
 */
const DOLLAR_TOKEN = /\$\{[^}]*\}?|\$[A-Za-z_][A-Za-z0-9_]*|\$\d+|\$[@*]/g;

/** 四家交集内的合法占位符（§8.8.2）。 */
const ALLOWED_PLACEHOLDERS = new Set([
  '$ARGUMENTS',
  '$1',
  '$2',
  '$3',
  '$4',
  '$5',
  '$6',
  '$7',
  '$8',
  '$9',
]);

/**
 * codex + project scope 跳过命令薄壳的原因（§8.8.4）。
 *
 * 单一事实源：`sync` 的 skipped 行与 `doctor` 的 commands/codex-project-unsupported
 * 必须说同一句话，否则用户在两处看到不同解释。
 */
export const CODEX_PROJECT_COMMANDS_SKIP_REASON =
  'codex 不支持项目级命令文件（只读 $CODEX_HOME\\prompts\\），本轮跳过其命令薄壳；codex 侧直接用 $<skill-name> 调用技能';

/**
 * 解析 `expose_as_command` 的一条声明（§8.8.2 命名空间）。
 *
 * 约定：`review/code-review` 的**最后一段是技能名**，前缀是命名空间。技能目录名
 * 不能含 `/`，所以命名空间只能由这里表达，不引入第二个配置入口。
 *
 * 段级校验从严：空段、`.` / `..`、Windows 非法字符一律拒。这些名字最终拼进文件
 * 路径，放过 `..` 等于允许写出投影根之外的文件。
 *
 * @throws ConfigError(2) 条目形态非法。
 */
export function parseCommandEntry(entry: string): { namespace: string[]; name: string } {
  const raw = entry.trim();
  const invalid = (reason: string): never => {
    throw new ConfigError(`profile.skills.expose_as_command 条目非法（${reason}）: ${entry}`, {
      hint: '写法为 <技能名> 或 <命名空间>/<技能名>（可多级），段内不得为空、不得是 . / .. 或含 \\ : * ? " < > |',
      details: { entry },
    });
  };

  if (raw === '') {
    invalid('空字符串');
  }
  const segments = raw.split(COMMAND_NAMESPACE_SEPARATOR).map((segment) => segment.trim());
  for (const segment of segments) {
    if (segment === '') {
      invalid('存在空段（首尾斜杠或连续斜杠）');
    }
    if (segment === '.' || segment === '..') {
      invalid(`段 "${segment}" 会指向目录树之外`);
    }
    if (UNSAFE_SEGMENT_CHARS.test(segment)) {
      invalid(`段 "${segment}" 含非法字符`);
    }
  }

  // segments 至少一段（空字符串已在上面拒掉），故 pop 必有值
  const name = segments.pop() as string;
  return { namespace: segments, name };
}

/**
 * 命令的规范名（含命名空间，用于报错与去重）：`review/code-review`。
 */
export function commandCanonicalName(command: {
  readonly namespace: readonly string[];
  readonly name: string;
}): string {
  return [...command.namespace, command.name].join(COMMAND_NAMESPACE_SEPARATOR);
}

/**
 * 目录扁平的 target（pi / codex）用的文件名主体：`review-code-review`（§8.8.2）。
 *
 * 选择拼接而不是「跳过带命名空间的名字」：跳过会让同一份 SoT 在四家里少两家可
 * 调用，用户得改 SoT 才能补齐；拼接只是名字变长，命令仍然存在。
 */
export function flattenCommandName(command: {
  readonly namespace: readonly string[];
  readonly name: string;
}): string {
  return [...command.namespace, command.name].join(COMMAND_FLATTEN_SEPARATOR);
}

/**
 * 校验命令正文的占位符只用四家交集（§8.8.2）。
 *
 * 白名单外的 `$` 记号一律 ConfigError(2)：`${1:-默认值}` 只有 pi 认，投到 claude /
 * opencode / codex 会原样留在正文里，用户看到的是「命令里多出一串字面量」。
 *
 * @param body 待校验正文。
 * @param skill 报错时指明来源技能。
 * @throws ConfigError(2) 出现白名单外的占位符。
 */
export function assertAllowedPlaceholders(body: string, skill: string): void {
  const offenders = [...body.matchAll(DOLLAR_TOKEN)]
    .map((match) => match[0])
    .filter((token) => !ALLOWED_PLACEHOLDERS.has(token));
  if (offenders.length === 0) {
    return;
  }
  const unique = [...new Set(offenders)];
  throw new ConfigError(
    `skill ${skill} 的 ${COMMAND_BODY_KEY} 含不被四家共同支持的占位符: ${unique.join(', ')}`,
    {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: ${N:-默认值} 是要展示给用户的 pi 语法字面量，不是模板插值
      hint: '只允许 $ARGUMENTS 与 $1..$9（§8.8.2 四家交集）；${N:-默认值} 等 pi 专有语法不能进 SoT',
      details: { skill, offenders: unique },
    },
  );
}

/**
 * 从 `SKILL.md` 正文提取 frontmatter 的透传键（§8.8.1）。
 *
 * 只认「首行即 `---`」的标准形态：正文前有空行或其它内容时视为无 frontmatter，
 * 不做容错猜测——猜错会把正文首段当成 description 投出去。
 *
 * 解析失败（YAML 损坏、顶层不是映射）一律返回空对象而不抛：技能正文的
 * frontmatter 不合法不该阻断整次 sync，薄壳退化成「无 frontmatter」仍可用。
 * 技能本身的合法性由 `aforge doctor` 负责报告。
 */
export function parseSkillFrontmatter(content: string): {
  description?: string;
  argumentHint?: string;
  commandBody?: string;
} {
  const lines = content.split('\n');
  if (lines.length === 0 || !FRONTMATTER_FENCE.test(lines[0] ?? '')) {
    return {};
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FRONTMATTER_FENCE.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, end).join('\n'));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const record = parsed as Record<string, unknown>;
  const result: { description?: string; argumentHint?: string; commandBody?: string } = {};
  const description = record[PASSTHROUGH_DESCRIPTION];
  if (typeof description === 'string' && description.trim() !== '') {
    result.description = description.trim();
  }
  const hint = record[PASSTHROUGH_ARGUMENT_HINT];
  if (typeof hint === 'string' && hint.trim() !== '') {
    result.argumentHint = hint.trim();
  }
  const body = record[COMMAND_BODY_KEY];
  if (typeof body === 'string' && body.trim() !== '') {
    // 只裁首尾空白：正文内部的换行与缩进是用户排版，原样保留
    result.commandBody = body.trim();
  }
  return result;
}

/**
 * 渲染薄壳正文（LF 基准；换行风格由 writer 按 §2.5 统一转换）。
 *
 * frontmatter 用 yaml.stringify 生成而非手拼字符串：description 里出现 `:`、引号或
 * 换行时手拼会产出非法 YAML，被 target 解析失败后整条命令静默失效。
 * 两个键都缺省时**不写 frontmatter**，避免留一个空的 `---\n---`。
 *
 * 正文来源二选一：SoT 给了 `command-body` 就用它（已在 resolve 阶段校验占位符，
 * §8.8.2），否则用内置薄壳模板（只有 `$ARGUMENTS` 一档）。
 */
export function renderCommandShell(command: CommandArtifact): string {
  const meta: Record<string, string> = {};
  if (command.description !== undefined) {
    meta[PASSTHROUGH_DESCRIPTION] = command.description;
  }
  if (command.argumentHint !== undefined) {
    meta[PASSTHROUGH_ARGUMENT_HINT] = command.argumentHint;
  }

  const body =
    command.body !== undefined
      ? `${command.body}\n`
      : [`加载 \`${command.name}\` 技能，按其工作流执行。`, '', '用户输入：$ARGUMENTS', ''].join(
          '\n',
        );

  if (Object.keys(meta).length === 0) {
    return body;
  }
  // stringifyYaml 自带尾换行，故 fence 之间不再补
  return `---\n${stringifyYaml(meta)}---\n\n${body}`;
}

/**
 * 解析本次要投影的命令清单（§4.2 / §8.8）。
 *
 * `expose_as_command` 的每条声明经 §8.8.2 解析成「命名空间 + 技能名」，技能名必须
 * 是 `skills.always` 的子集：点了名却没在 `always` 里 → `ConfigError(2)`，与
 * 「`always` 点名却没装」同一口径（§4.2）。判据用引擎已解析好的 `skills`（而不是
 * `profile.skills.always`）：两者在 §5.3 合并后可能不同层，拿实际能物化的那份比对
 * 才不会漏报。
 *
 * 另外拦两类会静默出错的重名：
 * - 规范名撞车（同一条写了两遍）——后写的会覆盖前一份产物；
 * - 扁平名撞车（`a/x` 与 `a-x` 在 pi / codex 下同名）——两条命令抢一个文件，
 *   谁最后写谁生效，且 prune 记账只留一条。
 *
 * @param profile 合并后的 profile。
 * @param skills 引擎解析出的可物化技能（`readSkillsToMaterialize` 的结果）。
 * @throws ConfigError(2) 条目形态非法 / 名单不是已装技能的子集 / 命令名撞车。
 */
export function resolveCommandsToExpose(
  profile: Profile,
  skills: readonly SkillArtifact[],
): CommandArtifact[] {
  const entries = profile.skills.expose_as_command ?? [];
  if (entries.length === 0) {
    return [];
  }

  const parsed = entries.map((entry) => parseCommandEntry(entry));
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const missing = parsed.map((item) => item.name).filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new ConfigError(
      `profile.skills.expose_as_command 点名的 skill 不在 skills.always 中: ${missing.join(', ')}`,
      {
        hint: '把这些名字加进 skills.always（或用 aforge skill add 安装），或从 expose_as_command 中移除；命名空间前缀不参与该匹配',
        details: { missing, always: skills.map((skill) => skill.name) },
      },
    );
  }

  const commands: CommandArtifact[] = [];
  const seenCanonical = new Set<string>();
  const seenFlat = new Map<string, string>();
  for (const item of parsed) {
    const canonical = commandCanonicalName(item);
    if (seenCanonical.has(canonical)) {
      throw new ConfigError(`profile.skills.expose_as_command 出现重复命令名: ${canonical}`, {
        hint: '同一个命令名只声明一次',
        details: { command: canonical },
      });
    }
    seenCanonical.add(canonical);

    const flat = flattenCommandName(item);
    const clash = seenFlat.get(flat);
    if (clash !== undefined) {
      throw new ConfigError(
        `profile.skills.expose_as_command 的 ${clash} 与 ${canonical} 在 pi / codex 下会拼成同一个文件名 ${flat}.md`,
        {
          hint: `目录扁平的 target 用 "${COMMAND_FLATTEN_SEPARATOR}" 拼命名空间（§8.8.2），请改名避免撞车`,
          details: { flat, commands: [clash, canonical] },
        },
      );
    }
    seenFlat.set(flat, canonical);

    // 名字已校验存在，非空断言由上面的 missing 检查保证
    const skill = byName.get(item.name) as SkillArtifact;
    const { commandBody, ...meta } = parseSkillFrontmatter(skill.content);
    if (commandBody !== undefined) {
      assertAllowedPlaceholders(commandBody, item.name);
    }
    commands.push({
      name: item.name,
      namespace: item.namespace,
      ...meta,
      ...(commandBody !== undefined ? { body: commandBody } : {}),
    });
  }
  return commands;
}
