/**
 * aforge skill 命令（Spec §6 命令表 / §7.6 / §11.2.6）。
 *
 * `aforge skill add <name> [--from <sourceId|路径>] | list [--json]`：
 * - add：从源（local 路径 / git store）**实体 copy** 到目标层 SoT
 *   `skills\<name>\`（非 symlink，§7.6 Windows 默认；目标已存在 →
 *   ConflictError(3)）；目标层 = AGF_SCOPE > project 在用 > user 在用；
 * - list：SoT skills\（installed，标层）+ 各源 skills 清单（available，
 *   标源 id；同名时 project 层优先生效，§5.3）。
 *
 * 核心逻辑在 core/sources/skill；本层只做目标层解析与输出。
 */
import type { Command } from 'commander';
import { resolveWriteTargetLayer } from '../core/config/target-layer';
import { readEnv } from '../core/env';
import { resolveProjectSoT, resolveUserSoT } from '../core/paths';
import {
  type AddSkillResult,
  addSkill,
  listSkills,
  type SkillContext,
  type SkillListItem,
} from '../core/sources/skill';
import { type CommandContext, defaultCommandContext, printJson } from './context';
import { resolveJsonFlag } from './flags';

/** 命令上下文。 */
export type SkillCommandContext = CommandContext;

/** 构造 skill 上下文；add 时解析安装目标层（要求该层已 init）。 */
async function buildSkillContext(
  ctx: SkillCommandContext,
  withTarget: boolean,
): Promise<SkillContext> {
  const env = readEnv(ctx.host);
  const userSoTRoot = resolveUserSoT(env, ctx.os);
  const projectSoTRoot = resolveProjectSoT(ctx.cwd, ctx.os);
  let targetSoTRoot = projectSoTRoot;
  if (withTarget) {
    targetSoTRoot = (await resolveWriteTargetLayer(ctx.host, env, ctx.os, ctx.cwd)).sotRoot;
  }
  return {
    host: ctx.host,
    env,
    os: ctx.os,
    cwd: ctx.cwd,
    userSoTRoot,
    projectSoTRoot,
    targetSoTRoot,
  };
}

/** skill add 核心逻辑（可注入、不打印）。@see addSkill 异常契约。 */
export async function runSkillAdd(
  ctx: SkillCommandContext,
  name: string,
  from?: string,
): Promise<AddSkillResult> {
  return addSkill(await buildSkillContext(ctx, true), name, from);
}

/** skill list 核心逻辑（可注入、不打印）。 */
export async function runSkillList(ctx: SkillCommandContext): Promise<SkillListItem[]> {
  return listSkills(await buildSkillContext(ctx, false));
}

/** 单行 skill 摘要（ASCII）。 */
function skillLine(item: SkillListItem): string {
  return `  ${item.name}  [${item.status}]  ${item.origin}`;
}

export function registerSkillCommand(program: Command): void {
  const cmd = program
    .command('skill')
    .description('install / list agent skills (add copies files into SoT skills/)');

  cmd
    .command('add <name>')
    .description('install a skill from a source into the SoT skills/ directory (copy, not symlink)')
    .option(
      '--from <source>',
      'source id or path containing skills/<name>/ (default: first source that has it)',
    )
    .action(async (name: string, options: { from?: string }, command: Command) => {
      const result = await runSkillAdd(defaultCommandContext(), name, options.from);
      if (resolveJsonFlag(command)) {
        // skipped 一并输出：symlink / 环路跳过项属于结果的一部分（§10 安全边界）
        printJson(result);
        return;
      }
      const lines: string[] = [
        `skill installed: ${result.name}`,
        `  from     : ${result.fromSourceId ?? result.fromRoot}`,
        `  target   : ${result.targetDir}`,
        `  files    : ${result.files.length} file(s) copied (real copy, not symlink)`,
      ];
      for (const file of result.files) {
        lines.push(`    - ${file}`);
      }
      if (result.skipped.length > 0) {
        // 不静默丢弃：symlink 不跟随（防私钥等越界读取）、环路项跳过（§10）
        lines.push(`  skipped  : ${result.skipped.length} entry(ies) not copied`);
        for (const entry of result.skipped) {
          const reason =
            entry.reason === 'symlink' ? 'symlink - not followed' : 'cycle - already visited';
          lines.push(`    - ${entry.path} (${reason})`);
        }
      }
      lines.push(
        '',
        'next: add the skill name to profile.yaml skills.always to project it via `aforge sync`',
      );
      console.log(lines.join('\n'));
    });

  cmd
    .command('list')
    .description('list installed (SoT) and available (source) skills')
    .option('--json', 'machine-readable output (Spec 6.2)')
    .action(async (options: { json?: boolean }, command: Command) => {
      const items = await runSkillList(defaultCommandContext());
      if (resolveJsonFlag(command, options.json)) {
        printJson(items);
        return;
      }
      if (items.length === 0) {
        console.log('no skills found - run `aforge skill add <name>` to install one');
        return;
      }
      const lines = items.map(skillLine);
      lines.push('', `${items.length} skill(s)`);
      console.log(lines.join('\n'));
    });
}
