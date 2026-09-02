/**
 * 环境类诊断（Spec §9 第 6/7 条 + skills/ symlink 检查）：声明值 vs detected 快照、
 * OneDrive 检测、target 目录覆盖变量、skills/ 下的 symlink 条目。
 *
 * 为什么单独成模块：这几项检查的对象是**机器环境**而非 SoT 配置内容——它们不依赖
 * projector / plan，OneDrive 与 symlink 两项甚至在 EffectiveConfig 装配失败时仍要
 * 跑（编排里它们在 config 块之外），把它们与 consistency 分开可以让这个"配置不可用
 * 也能报"的边界在文件层面就看得出来。
 * 只有 checkTargetDirOverrides 会报 error（外部路径入口的取值本身写错了，sync 必然
 * 撞同一个守卫）；其余各项恒 ok/warn，不参与退出码。
 */
import path from 'node:path';
import type { Host } from '../../infra/host';
import type { EffectiveConfig } from '../config/defaults';
import type { EnvSnapshot } from '../env';
import {
  CODEX_HOME_ENV,
  detectOneDrive,
  hasFixedRoot,
  type OsContext,
  PI_AGENT_DIR_ENV,
  SKILLS_DIRNAME,
  validatePath,
} from '../paths';
import { type DoctorCheckResult, errHint, errMessage, toDoctorCode } from './check-types';

/** OneDrive 检查的路径来源（userSoTRoot 可能因 AGF_HOME 不可解析而缺失）。 */
export interface OneDriveRoots {
  readonly userSoTRoot: string | undefined;
  /** 项目根（`--cwd` / 进程 cwd），不是项目级 SoT 根。 */
  readonly projectRoot: string;
}

/** detected 快照（loose object）中取 node/python 的 manager 字段。 */
function detectedManagerOf(
  detected: Record<string, unknown>,
  key: 'node' | 'python',
): string | undefined {
  const entry = detected[key];
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const manager = (entry as Record<string, unknown>).manager;
  return typeof manager === 'string' ? manager : undefined;
}

/** 声明值与 detected 不一致提示（§4.1：声明优先，渲染不受影响，仅提示）。 */
export function checkDeclaredVsDetected(
  results: DoctorCheckResult[],
  config: EffectiveConfig,
): void {
  const pairs: ReadonlyArray<readonly ['node' | 'python', string | undefined]> = [
    ['node', config.habits.runtime.node?.manager],
    ['python', config.habits.runtime.python?.manager],
  ];
  let mismatch = false;
  for (const [key, declared] of pairs) {
    if (declared === undefined) {
      continue;
    }
    const detected = detectedManagerOf(config.habits.detected, key);
    if (detected === undefined || detected === 'none') {
      continue; // 未探测到（detected 无快照 / none）：不算不一致
    }
    if (declared !== detected) {
      mismatch = true;
      results.push({
        section: 'environment',
        level: 'warn',
        item: `declared-vs-detected/${key}`,
        detail: `habits 声明 ${key}.manager=${declared}，但 detected 快照为 ${detected}`,
        hint: '声明字段优先于 detected（渲染不受影响）；如环境已变化可运行 aforge detect 刷新快照',
      });
    }
  }
  if (!mismatch) {
    results.push({
      section: 'environment',
      level: 'ok',
      item: 'declared-vs-detected',
      detail: '声明的 node/python manager 与 detected 快照一致（或无可比项）',
    });
  }
}

/**
 * OneDrive 检测（§2.1.1 → warn）。
 *
 * 三条路径都要看：**用户目录**、**用户级 SoT 根**（`AGF_HOME` 置位时就是它）、
 * **项目目录**。此前只看 `env.userProfile`，于是 `AGF_HOME` 指向 OneDrive 内某处、
 * 而用户目录本身不在 OneDrive 下时这条检查完全沉默——而 hint 恰恰是叫用户"把
 * AGF_HOME 与项目目录移出 OneDrive"，检查面比它承诺的窄一圈。
 *
 * userSoTRoot 由调用方传入（可能因 AGF_HOME 不可解析而缺失），本函数不再自己解析：
 * 解析失败已由 `user-sot-root` 条目报过，这里再抛一次只会重复噪音。
 */
export function checkOneDrive(
  results: DoctorCheckResult[],
  env: EnvSnapshot,
  host: Host,
  roots: OneDriveRoots,
): void {
  const candidates: ReadonlyArray<readonly [string, string | undefined]> = [
    ['用户目录', env.userProfile],
    ['用户级 SoT 根', roots.userSoTRoot],
    ['项目目录', roots.projectRoot],
  ];
  const checked = candidates.filter(
    (pair): pair is readonly [string, string] => pair[1] !== undefined && pair[1] !== '',
  );
  if (checked.length === 0) {
    return;
  }
  const hits = checked.filter(([, p]) => detectOneDrive(p, host));
  if (hits.length === 0) {
    results.push({
      section: 'environment',
      level: 'ok',
      item: 'onedrive',
      detail: `未检测到 OneDrive 同步（已检查：${checked.map(([label]) => label).join(' / ')}）`,
    });
    return;
  }
  results.push({
    section: 'environment',
    level: 'warn',
    item: 'onedrive',
    detail: `以下路径处于 OneDrive 同步范围: ${hits.map(([label, p]) => `${label}=${p}`).join('；')}`,
    hint: '建议把 AGF_HOME 与项目目录移出 OneDrive（文件锁 / 占位符状态可能导致投影写入失败）',
  });
}

/**
 * CODEX_HOME / PI_CODING_AGENT_DIR 的落点确认（Spec §2.2）。
 *
 * 为什么两个变量合成一条检查：它们是同一类入口（target 用户级目录的外部覆盖），
 * 走同一个守卫（core/paths.validatePath），分级也必须一致——分成两个函数迟早跑偏。
 * 未置位的变量不产出任何项，避免给没用 codex / pi 的用户增加噪音。
 *
 * 三档：
 * - ok：绝对路径（或 `~` 打头）——把生效目录打出来，比让人去翻 projector 源码便宜；
 * - warn：相对路径。守卫按 `path.resolve` 语义放过它（AGF_HOME 历史如此），但落点会
 *   随启动 sync 时的 cwd 漂移，同一台机器上换个目录跑就投影到别处；
 * - error：守卫会拒绝的形态（UNC / win32 上的无盘符绝对路径 / `~user`）。doctor 不拦
 *   任何东西，但要在这里如实报出来——否则用户只会在 sync 里撞见一次退出码。
 *
 * 返回值是**摘掉了非法取值**的 env 快照：projector.plan 现在也走同一个守卫，非法
 * CODEX_HOME 会让它抛 ConfigError。doctor 若把这个异常放出去，整份报告连同其余几十
 * 项检查一起消失——恰好在最需要诊断的时候。所以这里报完 error 就把该取值置回
 * undefined，后续依赖 projector 的检查按默认落点继续跑；退出码仍由这条 error 决定。
 */
export function checkTargetDirOverrides(
  results: DoctorCheckResult[],
  env: EnvSnapshot,
  os: OsContext,
): EnvSnapshot {
  const entries: ReadonlyArray<readonly [string, string, 'codexHome' | 'piCodingAgentDir']> = [
    ['codex-home', CODEX_HOME_ENV, 'codexHome'],
    ['pi-coding-agent-dir', PI_AGENT_DIR_ENV, 'piCodingAgentDir'],
  ];
  let sanitized: EnvSnapshot = env;
  for (const [item, origin, key] of entries) {
    const raw = env[key];
    if (raw === undefined || raw === '') {
      continue;
    }
    let resolved: string;
    try {
      resolved = validatePath(raw, os, { origin, home: env.userProfile });
    } catch (err) {
      results.push({
        section: 'environment',
        level: 'error',
        code: toDoctorCode(err),
        item,
        detail: errMessage(err),
        hint: errHint(err),
      });
      sanitized = { ...sanitized, [key]: undefined };
      continue;
    }
    results.push(
      hasFixedRoot(raw, os)
        ? {
            section: 'environment',
            level: 'ok',
            item,
            detail: `${origin} 已置位（${raw} → ${resolved}）：该 target 的 user scope 落点按它解析`,
          }
        : {
            section: 'environment',
            level: 'warn',
            item,
            detail: `${origin} 是相对路径（${raw} → 当前解析为 ${resolved}）`,
            hint: '改成绝对路径或 `~/` 开头——相对取值按进程 cwd 解析，换个目录跑 aforge sync 就会投影到别处',
          },
    );
  }
  return sanitized;
}

/**
 * §9 symlink 检查：扫描 SoT skills/ 顶层，**任何** symlink 条目都报 warn。
 *
 * 为什么不只报断开的：手工 symlink 进 SoT 的技能会落进一个三方口径不一致的缝里——
 * `skill list` 用 stat 能看见它、`sync` 走 host.exists 照常物化它，但 `bundle export`
 * 按 §7.9「symlink 一律不跟随」把它整个跳过。只报断开的，等于让用户直到迁移那一刻
 * 才发现这个技能没被带走。有效的 symlink 因此同样要报，hint 里点明它不会进 bundle。
 *
 * 投影恒为实体 copy 且 `copy_mode: symlink` 已决定不实现（§4.2），所以 skills/ 下的
 * symlink 不可能由 AgentForge 自己产生，报 warn 不会误伤正常安装。
 */
export async function checkSkillsSymlinks(
  host: Host,
  results: DoctorCheckResult[],
  userSoTRoot: string | undefined,
  projectSoTRoot: string,
): Promise<void> {
  const skillsDirs: string[] = [];
  if (userSoTRoot !== undefined) {
    skillsDirs.push(path.join(userSoTRoot, SKILLS_DIRNAME));
  }
  skillsDirs.push(path.join(projectSoTRoot, SKILLS_DIRNAME));
  const broken: string[] = [];
  const intact: string[] = [];
  for (const dir of skillsDirs) {
    let entries: string[];
    try {
      entries = await host.listDir(dir);
    } catch {
      continue; // 目录不存在 / 不可读：跳过
    }
    for (const name of entries) {
      const entryPath = path.join(dir, name);
      let lstatResult: { isSymbolicLink: boolean };
      try {
        lstatResult = await host.lstat(entryPath);
      } catch {
        continue; // lstat 失败（不应该发生，因为 listDir 已列出）：跳过
      }
      if (!lstatResult.isSymbolicLink) {
        continue;
      }
      let target: string;
      try {
        target = await host.readlink(entryPath);
      } catch {
        continue; // readlink 失败：跳过
      }
      // exists 跟随 symlink：目标不存在即断开
      if (await host.exists(entryPath)) {
        intact.push(`${entryPath} -> ${target}`);
      } else {
        broken.push(`${entryPath} -> ${target}`);
      }
    }
  }
  if (broken.length === 0 && intact.length === 0) {
    results.push({
      section: 'environment',
      level: 'ok',
      item: 'skills-symlink',
      detail: '未发现 symlink 条目（skills/ 目录）',
    });
    return;
  }
  const lines: string[] = [];
  if (broken.length > 0) {
    lines.push(`断开的 symlink ${broken.length} 个:`, ...broken);
  }
  if (intact.length > 0) {
    lines.push(`仍有效的 symlink ${intact.length} 个:`, ...intact);
  }
  results.push({
    section: 'environment',
    level: 'warn',
    item: 'skills-symlink',
    detail: `skills/ 下发现 ${broken.length + intact.length} 个 symlink 条目:\n${lines.join('\n')}`,
    hint:
      intact.length > 0
        ? 'skills/ 下的 symlink 不会被 aforge bundle export 带走（§7.9 一律不跟随），迁移时会静默丢失该技能；把它换成实体目录（aforge skill add 的实体 copy）。断开的条目请直接删除后重新 add'
        : '删除这些断开的 symlink 后重新 aforge skill add（投影恒为实体 copy，copy_mode: symlink 不予实现，见 §4.2）',
  });
}
