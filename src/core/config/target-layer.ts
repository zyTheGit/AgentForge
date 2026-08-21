/**
 * 写入目标层解析（M8：learn / skill add / template enable/disable / mcp add 共用）。
 *
 * 规则（与 defaults.resolveEffectiveConfig 的 effectiveScope 同源语义）：
 * - 显式 scope（learn --scope / AGF_SCOPE）> project 层在用 > user 层在用 > project；
 * - 选中的层必须已初始化（profile.yaml 存在）→ 否则 ConfigError(2) 引导 aforge init；
 * - 编辑 profile.yaml 一律编辑**该层自己的文件**（z.input 原始形态往返，
 *   保留用户未设置的键，不做默认值展开）。
 */
import path from 'node:path';
import type { Host } from '../../infra/host';
import type { EnvSnapshot, Scope } from '../env';
import { resolveProjectSoT, resolveUserSoT, type OsContext } from '../paths';
import { ConfigError } from '../errors';
import { HABITS_FILE, PROFILE_FILE } from './load';

/** 解析结果：写入目标层。 */
export interface TargetLayer {
  readonly scope: Scope;
  readonly sotRoot: string;
  readonly profileFile: string;
}

/** 某层 SoT 是否"在用"（profile.yaml 或 habits.yaml 任一存在，与 defaults.ts 同判据）。 */
async function layerInUse(host: Host, sotRoot: string): Promise<boolean> {
  return (
    (await host.exists(path.join(sotRoot, PROFILE_FILE))) ||
    (await host.exists(path.join(sotRoot, HABITS_FILE)))
  );
}

/**
 * 解析写入目标层。
 *
 * @param forcedScope 显式指定层（learn --scope：缺省 project；不指定则按
 *        AGF_SCOPE > project 在用 > user 在用 > project 的有效 scope 语义）。
 * @throws ConfigError(2) 选中层未初始化（无 profile.yaml）。
 */
export async function resolveWriteTargetLayer(
  host: Host,
  env: EnvSnapshot,
  os: OsContext,
  cwd: string,
  forcedScope?: Scope,
): Promise<TargetLayer> {
  const userSoTRoot = resolveUserSoT(env, os);
  const projectSoTRoot = resolveProjectSoT(cwd, os);

  const scope: Scope =
    forcedScope ??
    env.agfScope ??
    ((await layerInUse(host, projectSoTRoot))
      ? 'project'
      : (await layerInUse(host, userSoTRoot))
        ? 'user'
        : 'project');

  const sotRoot = scope === 'project' ? projectSoTRoot : userSoTRoot;
  const profileFile = path.join(sotRoot, PROFILE_FILE);
  if (!(await host.exists(profileFile))) {
    throw new ConfigError(`SoT 未初始化（${scope} 层缺少 profile.yaml）: ${sotRoot}`, {
      hint: `先运行 aforge init${scope === 'user' ? ' --scope user' : ''}`,
      details: { scope, sotRoot, profileFile },
    });
  }
  return { scope, sotRoot, profileFile };
}
