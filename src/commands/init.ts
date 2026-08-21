/**
 * aforge init 命令（Spec §7.1 非交互路径；交互式 -i 模式后续里程碑提供）。
 *
 * 流程：确定 scope 与 SoT 根 → 探测（快照进 habits.detected）→ 写 habits.yaml
 * （声明字段空骨架 + detected 快照）与 profile.yaml（windowsDefaultProfile 按
 * scope 调整）→ 创建目录结构（custom/learnings/templates/skills/mcp）→
 * 打印创建的绝对路径列表。
 *
 * 已初始化（SoT 根存在 profile.yaml）→ ConfigError(2)，不覆盖既有配置。
 * 正常输出纯 ASCII（Windows GBK 控制台兼容，见 cli.ts 约定）。
 */
import path from 'node:path';
import type { Command } from 'commander';
import { stringify as stringifyYaml } from 'yaml';
import { defaultHabits, windowsDefaultProfile } from '../core/config/defaults';
import type { DetectedSnapshot } from '../core/detector/engine';
import { runDetection } from '../core/detector/engine';
import type { Scope } from '../core/env';
import { readEnv } from '../core/env';
import { ConfigError } from '../core/errors';
import { currentOs, resolveProjectSoT, resolveUserSoT, type OsContext } from '../core/paths';
import type { Host } from '../infra/host';
import { atomicWrite, mkdirp } from '../infra/fsutil';
import { HABITS_FILE, PROFILE_FILE } from '../core/config/load';
import { realHost } from '../infra/real-host';

/** Spec §3.1 / §3.2：init 创建的 SoT 子目录（store/cache 由 source 管理按需创建）。 */
export const SOT_SUBDIRS = ['custom', 'learnings', 'templates', 'skills', 'mcp'] as const;

/** 命令上下文（host/os/cwd 注入；测试用真实临时目录 + realHost 或 env 覆盖 host）。 */
export interface InitContext {
  readonly host: Host;
  /** 项目根（project scope 的 SoT 位置与探测基准）。 */
  readonly cwd: string;
  readonly os: OsContext;
}

export interface InitOptions {
  /** --scope；缺省回落 AGF_SCOPE，再缺省 project（Spec §7.1-1）。 */
  readonly scope?: Scope;
}

export interface InitResult {
  readonly scope: Scope;
  readonly sotRoot: string;
  readonly createdFiles: readonly string[];
  readonly createdDirs: readonly string[];
  readonly detection: DetectedSnapshot;
}

/**
 * init 核心逻辑（可注入、不打印——CLI 输出与测试共用同一入口）。
 *
 * @throws ConfigError(2) SoT 已初始化 / 用户目录无法解析。
 * @throws PermissionError(4) SoT 目录无写权限。
 */
export async function runInit(ctx: InitContext, options: InitOptions = {}): Promise<InitResult> {
  const env = readEnv(ctx.host);
  const scope: Scope = options.scope ?? env.agfScope ?? 'project';

  const userSoTRoot = resolveUserSoT(env, ctx.os);
  const projectSoTRoot = resolveProjectSoT(ctx.cwd, ctx.os);
  const sotRoot = scope === 'project' ? projectSoTRoot : userSoTRoot;

  // Spec §6.1：init 目录已初始化 → 退出码 2（防误覆盖既有 SoT）
  if (await ctx.host.exists(path.join(sotRoot, PROFILE_FILE))) {
    throw new ConfigError(`SoT 已初始化: ${sotRoot}`, {
      hint: '已初始化，如需重置请先删除该目录（或其中的 profile.yaml）',
      details: { sotRoot },
    });
  }

  // 探测（Spec §7.1-2）：快照进 detected；交互确认到声明字段是 -i 模式的职责
  const detection = await runDetection({
    host: ctx.host,
    os: ctx.os.platform,
    cwd: ctx.cwd,
    env,
  });

  // habits.yaml：声明字段空骨架 + detected 快照（Spec §7.1-2）
  // profile.yaml：Windows 安装默认值，scope 按本次 init 调整（Spec §4.2 / §7.1-3）
  const habitsYaml = stringifyYaml({ ...defaultHabits(), detected: detection }, { lineWidth: 0 });
  const profileYaml = stringifyYaml({ ...windowsDefaultProfile(), scope }, { lineWidth: 0 });

  // 目录结构（Spec §7.3-7 同语义：创建失败（权限）→ PermissionError(4)）
  await mkdirp(ctx.host, sotRoot);
  const createdDirs: string[] = [];
  for (const dir of SOT_SUBDIRS) {
    const abs = path.join(sotRoot, dir);
    await mkdirp(ctx.host, abs);
    createdDirs.push(abs);
  }

  // 配置文件原子写（YAML 固定 LF：Spec §2.5 的换行设置约束 Markdown/JSON/TOML 投影产物）
  const habitsFile = path.join(sotRoot, HABITS_FILE);
  const profileFile = path.join(sotRoot, PROFILE_FILE);
  await atomicWrite(ctx.host, habitsFile, habitsYaml.endsWith('\n') ? habitsYaml : `${habitsYaml}\n`);
  await atomicWrite(ctx.host, profileFile, profileYaml.endsWith('\n') ? profileYaml : `${profileYaml}\n`);

  return {
    scope,
    sotRoot,
    createdFiles: [habitsFile, profileFile],
    createdDirs,
    detection,
  };
}

// ---------------------------------------------------------------------------
// CLI 装配（打印逻辑只在 action 层）
// ---------------------------------------------------------------------------

/** 探测摘要行（ASCII，两列对齐）。 */
function detectionSummary(d: DetectedSnapshot): string[] {
  const pms = d.package_managers.map((p) => p.name).join(', ');
  return [
    `  node manager     : ${d.node.manager}`,
    `  python manager   : ${d.python.manager}`,
    `  package managers : ${pms === '' ? '(none)' : pms}`,
    `  shell            : ${d.shell}`,
    `  existing rules   : ${d.existing_rules.length === 0 ? '(none)' : d.existing_rules.join(', ')}`,
  ];
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('initialize the SoT directory (habits/profile skeletons + detect snapshot)')
    .option('--scope <scope>', 'SoT scope: project or user (default: project)')
    .action(async (options: { scope?: string }) => {
      let scope: Scope | undefined;
      if (options.scope !== undefined) {
        if (options.scope !== 'project' && options.scope !== 'user') {
          throw new ConfigError(`非法 scope: ${options.scope}`, {
            hint: '有效值: project, user',
          });
        }
        scope = options.scope;
      }

      const result = await runInit({ host: realHost, cwd: process.cwd(), os: currentOs() }, { scope });

      const lines: string[] = [
        `aforge init - scope: ${result.scope}`,
        `SoT root: ${result.sotRoot}`,
        '',
        'created files:',
        ...result.createdFiles.map((f) => `  ${f}`),
        '',
        'created dirs:',
        ...result.createdDirs.map((d) => `  ${d}`),
        '',
        'detected (snapshot saved to habits.yaml):',
        ...detectionSummary(result.detection),
        '',
        'next: run `aforge sync` to project rules to agent targets',
      ];
      console.log(lines.join('\n'));
    });
}
