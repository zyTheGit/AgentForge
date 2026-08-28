/**
 * aforge skill 命令（Spec §6 命令表 / §7.6 / §11.2.6）。
 *
 * `aforge skill add <name> [--from <sourceId|路径>] [--no-register] | list
 *            | remove <name> [--scope project|user]`（三条子命令均支持 `--json`，§6.2）：
 * - add：从源（local 路径 / git store）**实体 copy** 到目标层 SoT
 *   `skills\<name>\`（非 symlink，§7.6 Windows 默认；目标已存在 →
 *   ConflictError(3)）；目标层 = AGF_SCOPE > project 在用 > user 在用；
 *   copy 完成后把名字**自动登记**进同一层 profile.yaml 的 skills.always
 *   （幂等；`--no-register` 只 copy 不登记，留给手工编排 profile 的场景）；
 * - list：SoT skills\（installed，标层）+ 各源 skills 清单（available，
 *   标源 id；同名时 project 层优先生效，§5.3）；
 * - remove：**只**把名字从该层 profile.yaml 的 skills.always 摘掉，
 *   `skills\<name>\` 目录原样留在磁盘上（§7.6 profile-only；见 runSkillRemove）。
 *
 * 核心逻辑在 core/sources/skill；本层只做目标层解析与输出。
 *
 * 拆分后的模块清单（对外导出面不变，remove 侧的符号在文件末尾原样 re-export）：
 * - 本文件：上下文构造 + add / list 逻辑 + 三个子命令的注册与输出渲染；
 * - commands/skill-remove.ts：remove 的结果类型与核心逻辑（含「层选错了」的 hint）。
 */
import type { Command } from 'commander';
import { defaultHabits, windowsDefaultProfile } from '../core/config/defaults';
import { resolveWriteTargetLayer, type TargetLayer } from '../core/config/target-layer';
import { type EnvSnapshot, readEnv, type Scope } from '../core/env';
import { resolveProjectSoT, resolveUserSoT } from '../core/paths';
import { claudeSkillPath } from '../core/project/projectors/claude';
import { codexSkillPath } from '../core/project/projectors/codex';
import { opencodeSkillPath } from '../core/project/projectors/opencode';
import { piSkillPath } from '../core/project/projectors/pi';
import { withSotLock } from '../core/project/sync-lock';
import type { ProjectContext } from '../core/project/types';
import {
  type AddSkillResult,
  addSkill,
  listSkills,
  rollbackSkillCopy,
  type SetSkillAlwaysResult,
  type SkillContext,
  type SkillListItem,
  setSkillAlwaysLocked,
} from '../core/sources/skill';
import { HabitsSchema, ProfileSchema } from '../schema';
import {
  type CommandContext,
  defaultCommandContext,
  printJson,
  projectionRootFor,
  renderList,
} from './context';
import { parseScopeOption, resolveJsonFlag } from './flags';
import { runSkillRemove } from './skill-remove';

/** 命令上下文。 */
export type SkillCommandContext = CommandContext;

/** buildSkillContext 产物：skill 上下文 + 解析出的写入目标层（add 才有）。 */
interface ResolvedSkillContext {
  readonly skillCtx: SkillContext;
  readonly targetLayer: TargetLayer | undefined;
}

/** 构造 skill 上下文；add 时解析安装目标层（要求该层已 init）。 */
async function buildSkillContext(
  ctx: SkillCommandContext,
  withTarget: boolean,
): Promise<ResolvedSkillContext> {
  const env = readEnv(ctx.host);
  const userSoTRoot = resolveUserSoT(env, ctx.os);
  const projectSoTRoot = resolveProjectSoT(ctx.cwd, ctx.os);
  // 目标层同时是 copy 落点与 skills.always 的登记落点（同源，不会分叉）
  const targetLayer = withTarget
    ? await resolveWriteTargetLayer(ctx.host, env, ctx.os, ctx.cwd)
    : undefined;
  return {
    skillCtx: {
      host: ctx.host,
      env,
      os: ctx.os,
      cwd: ctx.cwd,
      userSoTRoot,
      projectSoTRoot,
      targetSoTRoot: targetLayer?.sotRoot ?? projectSoTRoot,
    },
    targetLayer,
  };
}

/** skill add 结果（copy 结果 + 自动登记结果）。 */
export interface SkillAddResult extends AddSkillResult {
  /** 登记进 skills.always 的结果；`--no-register` 时为 undefined。 */
  readonly registered: SetSkillAlwaysResult | undefined;
}

/**
 * skill add 核心逻辑（可注入、不打印）。
 *
 * 整段（copy → 登记 → 失败回滚）在**一次** SoT 事务锁内执行（withSotLock，与 sync
 * 同一把 `<sotRoot>/.sync.lock`）。只锁登记那一步是不够的：递归写盘与回滚递归删除
 * 都在锁外时，并发 `aforge sync` 会读到半装 / 正被删除的 skill 目录，把它投影出去。
 * 锁内调用的是 setSkillAlwaysLocked（不再自持锁）——目录锁非递归，内层若走
 * setSkillAlways 会撞自己刚建的锁目录而抛 ConflictError(3)。
 *
 * 先 copy 再登记：反过来（先登记后 copy）一旦 copy 失败，profile 里会留下一个
 * 没装的名字，`sync` 直接 fail-fast 退出码 2。而 copy 成功后登记失败（profile.yaml
 * 损坏 → ConfigError(2)）**必须撤销 copy**：否则文件留在 SoT 里而 profile 没登记，
 * 用户重跑同一条命令会撞 addSkill 的「目标已存在 → ConflictError(3)」被永久挡死，
 * 只能手删目录。撤销后这条命令回到「要么全成、要么什么都没发生」。
 *
 * @param register false → 只 copy 不改 profile.yaml（`--no-register`）。
 * @throws ConflictError(3) 取不到 SoT 事务锁（另一个 aforge 正在写同一 SoT）。
 * @see addSkill / setSkillAlwaysLocked 异常契约。
 */
export async function runSkillAdd(
  ctx: SkillCommandContext,
  name: string,
  from?: string,
  register = true,
): Promise<SkillAddResult> {
  const { skillCtx, targetLayer } = await buildSkillContext(ctx, true);
  // 锁根取 copy 落点所在层（= 登记落点，两者同源；targetLayer 缺省回落项目层 SoT）
  return withSotLock(ctx.host, skillCtx.targetSoTRoot, ctx.os, async () => {
    const added = await addSkill(skillCtx, name, from);
    if (!register || targetLayer === undefined) {
      return { ...added, registered: undefined };
    }
    try {
      return {
        ...added,
        registered: await setSkillAlwaysLocked(ctx.host, targetLayer, name, true),
      };
    } catch (err) {
      // 补偿回滚：撤销本次 copy，原始错误照原样抛给用户（回滚失败也不掩盖它）
      await rollbackSkillCopy(ctx.host, added.targetDir, added.targetPreexisted);
      throw err;
    }
  });
}

/** skill list 核心逻辑（可注入、不打印）。 */
export async function runSkillList(ctx: SkillCommandContext): Promise<SkillListItem[]> {
  return listSkills((await buildSkillContext(ctx, false)).skillCtx);
}

/**
 * remove 侧的导出面 re-export：`runSkillRemove` / `SkillRemoveResult` 实现已搬到
 * commands/skill-remove.ts，这里保证调用方与测试仍能从 `commands/skill` 原路径拿到。
 */
export { runSkillRemove, type SkillRemoveResult } from './skill-remove';

/** 单行 skill 摘要（ASCII）。 */
function skillLine(item: SkillListItem): string {
  return `  ${item.name}  [${item.status}]  ${item.origin}`;
}

/**
 * 本次写入那一层上、四个 target 实际会落 `skills\<name>\SKILL.md` 的绝对路径。
 *
 * 路径一律取自 projector 的 skills 解析函数（Spec §2.3 / §8.3-8.6 是它们的唯一出处）：
 * 命令层原先写死的 `.claude / .opencode / .agents / .pi` 只对 project 层成立，
 * `--scope user` 时 opencode（`~\.config\opencode`）、codex（`CODEX_HOME` 或
 * `~\.codex`）的全局根根本不在项目根下，用户照那行提示找不到要删的文件。
 *
 * projector 的签名要 ProjectContext，但这几个函数只读 os / scope / rootDir / env；
 * profile 与 habits 仅为满足类型用默认值填充（同 init -i 的 targetMainRulePaths），
 * 不参与路径计算，也不落盘。
 *
 * @param env 由调用方传入（命令层已读过一次），避免同一条命令里重复 readEnv。
 */
function projectedSkillDocPaths(
  ctx: SkillCommandContext,
  env: EnvSnapshot,
  scope: Scope,
  skillName: string,
): string[] {
  const rootDir = projectionRootFor(ctx, env, scope);
  const profile = ProfileSchema.parse(windowsDefaultProfile());
  const planCtx: ProjectContext = {
    os: ctx.os,
    scope,
    rootDir,
    renderedRulesMd: '',
    habits: HabitsSchema.parse(defaultHabits()),
    profile,
    skillsToMaterialize: [],
    mcpServers: [],
    dryRun: true,
    lineEnding: profile.projection.line_ending,
    markerBegin: profile.projection.marker_begin,
    markerEnd: profile.projection.marker_end,
    markerMode: profile.projection.marker_mode,
    // env 必须注入：codexSkillPath 走 ctx.env?.codexHome 分支，缺了会忽略 CODEX_HOME
    env,
  };
  return [
    opencodeSkillPath(planCtx, skillName),
    codexSkillPath(planCtx, skillName),
    claudeSkillPath(planCtx, skillName),
    piSkillPath(planCtx, skillName),
  ];
}

export function registerSkillCommand(program: Command): void {
  const cmd = program
    .command('skill')
    .description('install / list / unregister agent skills (add copies files into SoT skills/)');

  cmd
    .command('add <name>')
    .description('install a skill from a source into the SoT skills/ directory (copy, not symlink)')
    .option(
      '--from <source>',
      'source id or path containing skills/<name>/ (default: first source that has it)',
    )
    .option('--no-register', 'copy only - do not add the name to profile.yaml skills.always')
    .option('--json', 'machine-readable output (absolute paths) - Spec 6.2')
    .action(
      async (
        name: string,
        options: { from?: string; register: boolean; json?: boolean },
        command: Command,
      ) => {
        const result = await runSkillAdd(
          defaultCommandContext(),
          name,
          options.from,
          options.register,
        );
        if (resolveJsonFlag(command, options.json)) {
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
        if (result.registered === undefined) {
          lines.push(
            '',
            '--no-register: add the skill name to profile.yaml skills.always to project it',
          );
        } else {
          lines.push(
            `  profile  : ${result.registered.profileFile}`,
            `  always   : ${result.registered.always.join(', ')}${
              result.registered.changed ? '' : ' (already registered)'
            }`,
            '',
            'next: run `aforge sync` to project it to your agents',
          );
        }
        console.log(lines.join('\n'));
      },
    );

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

  cmd
    .command('remove <name>')
    .description('unregister a skill from profile.yaml skills.always (files stay in SoT skills/)')
    .option('--scope <scope>', 'SoT scope to write: project or user (default: effective scope)')
    .option('--json', 'machine-readable output (absolute paths) - Spec 6.2')
    .action(async (name: string, options: { scope?: string; json?: boolean }, command: Command) => {
      const ctx = defaultCommandContext();
      const result = await runSkillRemove(ctx, name, {
        scope: parseScopeOption(options.scope),
      });
      if (resolveJsonFlag(command, options.json)) {
        printJson(result);
        return;
      }
      console.log(
        [
          `skill removed: ${result.name} (profile only)`,
          `  scope     : ${result.scope}`,
          `  profile   : ${result.profileFile}`,
          `  always    : ${renderList(result.always)}`,
          `  skill dir : ${result.skillDir} (kept on disk)`,
          '',
          // prune 已落地（Spec §7.6）：下次 sync 按 sync-meta 上一轮记账删这些产物。
          // 路径按本次写入的层从 projector 现算，不写死 project 级目录名
          'note: removed from profile.yaml only. run `aforge sync` to drop the',
          `      projected copies (${result.scope} level):`,
          ...projectedSkillDocPaths(ctx, readEnv(ctx.host), result.scope, result.name).map(
            (file) => `        ${file}`,
          ),
          '      manually edited copies are kept and listed under `prune skipped`.',
        ].join('\n'),
      );
    });
}
