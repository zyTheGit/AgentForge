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

/** frontmatter 分隔线（`---` 独占一行，允许行尾空白与 CRLF）。 */
const FRONTMATTER_FENCE = /^---[ \t]*\r?$|^---[ \t]*$/;

/**
 * codex + project scope 跳过命令薄壳的原因（§8.8.4）。
 *
 * 单一事实源：`sync` 的 skipped 行与 `doctor` 的 commands/codex-project-unsupported
 * 必须说同一句话，否则用户在两处看到不同解释。
 */
export const CODEX_PROJECT_COMMANDS_SKIP_REASON =
  'codex 不支持项目级命令文件（只读 $CODEX_HOME\\prompts\\），本轮跳过其命令薄壳；codex 侧直接用 $<skill-name> 调用技能';

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
  const result: { description?: string; argumentHint?: string } = {};
  const description = record[PASSTHROUGH_DESCRIPTION];
  if (typeof description === 'string' && description.trim() !== '') {
    result.description = description.trim();
  }
  const hint = record[PASSTHROUGH_ARGUMENT_HINT];
  if (typeof hint === 'string' && hint.trim() !== '') {
    result.argumentHint = hint.trim();
  }
  return result;
}

/**
 * 渲染薄壳正文（LF 基准；换行风格由 writer 按 §2.5 统一转换）。
 *
 * frontmatter 用 yaml.stringify 生成而非手拼字符串：description 里出现 `:`、引号或
 * 换行时手拼会产出非法 YAML，被 target 解析失败后整条命令静默失效。
 * 两个键都缺省时**不写 frontmatter**，避免留一个空的 `---\n---`。
 */
export function renderCommandShell(command: CommandArtifact): string {
  const meta: Record<string, string> = {};
  if (command.description !== undefined) {
    meta[PASSTHROUGH_DESCRIPTION] = command.description;
  }
  if (command.argumentHint !== undefined) {
    meta[PASSTHROUGH_ARGUMENT_HINT] = command.argumentHint;
  }

  const body = [
    `加载 \`${command.name}\` 技能，按其工作流执行。`,
    '',
    '用户输入：$ARGUMENTS',
    '',
  ].join('\n');

  if (Object.keys(meta).length === 0) {
    return body;
  }
  // stringifyYaml 自带尾换行，故 fence 之间不再补
  return `---\n${stringifyYaml(meta)}---\n\n${body}`;
}

/**
 * 解析本次要投影的命令清单（§4.2 / §8.8）。
 *
 * `expose_as_command` 必须是 `skills.always` 的子集：点了名却没在 `always` 里 →
 * `ConfigError(2)`，与「`always` 点名却没装」同一口径（§4.2）。判据用引擎已解析好的
 * `skills`（而不是 `profile.skills.always`）：两者在 §5.3 合并后可能不同层，
 * 拿实际能物化的那份比对才不会漏报。
 *
 * @param profile 合并后的 profile。
 * @param skills 引擎解析出的可物化技能（`readSkillsToMaterialize` 的结果）。
 * @throws ConfigError(2) 名单不是已装技能的子集。
 */
export function resolveCommandsToExpose(
  profile: Profile,
  skills: readonly SkillArtifact[],
): CommandArtifact[] {
  const names = profile.skills.expose_as_command ?? [];
  if (names.length === 0) {
    return [];
  }

  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const missing = names.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new ConfigError(
      `profile.skills.expose_as_command 点名的 skill 不在 skills.always 中: ${missing.join(', ')}`,
      {
        hint: '把这些名字加进 skills.always（或用 aforge skill add 安装），或从 expose_as_command 中移除',
        details: { missing, always: skills.map((skill) => skill.name) },
      },
    );
  }

  const commands: CommandArtifact[] = [];
  for (const name of names) {
    // 名字已校验存在，非空断言由上面的 missing 检查保证
    const skill = byName.get(name) as SkillArtifact;
    const meta = parseSkillFrontmatter(skill.content);
    commands.push({ name, ...meta });
  }
  return commands;
}
