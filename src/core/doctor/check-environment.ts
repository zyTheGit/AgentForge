/**
 * 环境类诊断（Spec §9 第 6/7 条 + symlink 失败检查）：声明值 vs detected 快照、
 * OneDrive 检测、skills/ 下断开的 symlink。
 *
 * 为什么单独成模块：这三项检查的对象是**机器环境**而非 SoT 配置内容——它们不依赖
 * projector / plan，OneDrive 与 symlink 两项甚至在 EffectiveConfig 装配失败时仍要
 * 跑（编排里它们在 config 块之外），把它们与 consistency 分开可以让这个"配置不可用
 * 也能报"的边界在文件层面就看得出来。全部只报 warn/ok，不参与退出码。
 */
import path from 'node:path';
import type { Host } from '../../infra/host';
import type { EffectiveConfig } from '../config/defaults';
import type { EnvSnapshot } from '../env';
import { detectOneDrive, SKILLS_DIRNAME } from '../paths';
import type { DoctorCheckResult } from './check-types';

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

/** OneDrive 检测（§2.1.1 → warn）。 */
export function checkOneDrive(results: DoctorCheckResult[], env: EnvSnapshot, host: Host): void {
  if (env.userProfile !== undefined && env.userProfile !== '') {
    if (detectOneDrive(env.userProfile, host)) {
      results.push({
        section: 'environment',
        level: 'warn',
        item: 'onedrive',
        detail: `用户目录处于 OneDrive 同步范围: ${env.userProfile}`,
        hint: '建议把 AGF_HOME 与项目目录移出 OneDrive（文件锁 / 占位符状态可能导致投影写入失败）',
      });
    } else {
      results.push({
        section: 'environment',
        level: 'ok',
        item: 'onedrive',
        detail: '未检测到 OneDrive 同步（用户目录不在 OneDrive 范围内）',
      });
    }
  }
}

/**
 * PI_CODING_AGENT_DIR 置位提示（Spec §2.2 已知限制 → warn）。
 *
 * 为什么必须报：pi 的 user scope 落点在 projector 里硬编码为 `.pi\agent`，该变量置位时
 * 上游适配器改读它指向的目录，于是投影落在 pi 不读的路径上；又因 pi 的 MCP 项是 soft
 * （写成功即静默、不算 sync 失败），用户拿不到任何"这份配置不生效"的信号。对比 CODEX_HOME
 * 已被 paths 层认掉，此项属待补的对称支持，在补上之前由 doctor 顶着。
 */
export function checkPiCodingAgentDir(results: DoctorCheckResult[], env: EnvSnapshot): void {
  if (env.piCodingAgentDir === undefined) {
    return; // 未置位：不产出 ok 项（避免给没用 pi 的用户增加噪音）
  }
  results.push({
    section: 'environment',
    level: 'warn',
    item: 'pi-coding-agent-dir',
    detail: `PI_CODING_AGENT_DIR 已置位（${env.piCodingAgentDir}），但 pi 的 user scope 落点仍硬编码为 .pi/agent`,
    hint: '若启用了 pi 且使用 user scope，该 MCP 投影会落在 pi 不读的路径上；改用 project scope，或手工把 mcp.json 复制到 PI_CODING_AGENT_DIR 指向的目录',
  });
}

/** §9 symlink 失败检查：扫描 SoT skills/ 目录，检测断开的 symlink → warn。 */
export async function checkBrokenSymlinks(
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
  const brokenSymlinks: string[] = [];
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
      // 是 symlink，检查目标是否存在
      let target: string;
      try {
        target = await host.readlink(entryPath);
      } catch {
        continue; // readlink 失败：跳过
      }
      // 检查 symlink 目标是否存在（用 exists，它会跟随 symlink）
      const targetExists = await host.exists(entryPath);
      if (!targetExists) {
        brokenSymlinks.push(`${entryPath} -> ${target}`);
      }
    }
  }
  if (brokenSymlinks.length > 0) {
    results.push({
      section: 'environment',
      level: 'warn',
      item: 'broken-symlink',
      detail: `发现 ${brokenSymlinks.length} 个断开的 symlink:\n${brokenSymlinks.join('\n')}`,
      hint: '建议设置 skills.copy_mode: copy（避免 symlink 跨平台问题），或删除无效 symlink 后重新 skill add',
    });
  } else {
    results.push({
      section: 'environment',
      level: 'ok',
      item: 'broken-symlink',
      detail: '未发现断开的 symlink（skills/ 目录）',
    });
  }
}
