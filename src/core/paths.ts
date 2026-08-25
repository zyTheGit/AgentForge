/**
 * 路径解析（Spec §2.1 / §2.1.1 / §2.2）：纯计算，路径计算依赖注入的 env 与 os。
 *
 * - 一律输出规范化绝对路径（Spec §2.1）；
 * - Windows 比较大小写不敏感（samePath）；
 * - 长路径（>240）加 `\\?\` 前缀（Spec §2.1.1）；
 * - UNC 不支持（Spec §2.1.1，退出码 1）；
 * - node:path 为纯计算模块，允许直接使用；文件 IO 一律经 Host。
 */
import path from 'node:path';
import type { Host } from '../infra/host';
import { ConfigError, GenericError } from './errors';
import type { EnvSnapshot } from './env';

/** 平台上下文：注入以支持在任意宿主平台上测试 win32/posix 分支。 */
export interface OsContext {
  readonly platform: 'win32' | 'darwin' | 'linux';
}

/** 当前进程平台（生产用；测试请显式传入 OsContext）。 */
export function currentOs(): OsContext {
  return { platform: process.platform as OsContext['platform'] };
}

/** 四个投影 target 的用户级根目录（Spec §2.2）。 */
export interface TargetUserDirs {
  readonly opencode: string;
  readonly codex: string;
  readonly claude: string;
  readonly pi: string;
}

function pathApiFor(os: OsContext): typeof path.win32 | typeof path.posix {
  return os.platform === 'win32' ? path.win32 : path.posix;
}

/** 要求存在用户目录，否则无法解析任何用户级路径。 */
function requireUserProfile(env: EnvSnapshot): string {
  const home = env.userProfile;
  if (home === undefined || home === '') {
    throw new ConfigError('无法确定用户目录（USERPROFILE 与 HOME 均未设置）', {
      hint: '设置 USERPROFILE（Windows）或 HOME（类 Unix），或用 AGF_HOME 显式指定用户级 SoT 根目录',
    });
  }
  return home;
}

/**
 * 用户级 SoT 根目录（Spec §2.1）：AGF_HOME 覆盖，否则 `<userProfile>/.agentforge`。
 * 返回规范化绝对路径；AGF_HOME 本身先过 UNC 校验。
 */
export function resolveUserSoT(env: EnvSnapshot, os: OsContext = currentOs()): string {
  if (env.agfHome !== undefined && env.agfHome !== '') {
    return validatePath(env.agfHome);
  }
  const api = pathApiFor(os);
  return api.resolve(requireUserProfile(env), '.agentforge');
}

/** 项目级 SoT 根目录（Spec §2.1）：`<projectRoot>/.agentforge`（绝对化）。 */
export function resolveProjectSoT(projectRoot: string, os: OsContext = currentOs()): string {
  const api = pathApiFor(os);
  return api.resolve(projectRoot, '.agentforge');
}

/**
 * 四 target 的用户级全局目录（Spec §2.2）：
 * - opencode：`~/.config/opencode`
 * - codex：CODEX_HOME 覆盖，否则 `~/.codex`
 * - claude：`~/.claude`
 * - pi：`~/.pi/agent`
 * 分隔符随注入 os 变化（win32 `\`，posix `/`）。
 */
export function resolveTargetUserDirs(env: EnvSnapshot, os: OsContext): TargetUserDirs {
  const api = pathApiFor(os);
  const home = requireUserProfile(env);
  return {
    opencode: api.resolve(home, '.config', 'opencode'),
    codex: env.codexHome ? api.resolve(env.codexHome) : api.resolve(home, '.codex'),
    claude: api.resolve(home, '.claude'),
    pi: api.resolve(home, '.pi', 'agent'),
  };
}

/**
 * 校验路径并返回规范化绝对路径。
 * UNC 网络路径（`\\server\share` 或 `//server/share`）→ GenericError(1)（Spec §2.1.1）。
 */
export function validatePath(p: string): string {
  if (p.startsWith('\\\\') || p.startsWith('//')) {
    throw new GenericError(`AGF_HOME 不支持网络路径（UNC）: ${p}`, {
      hint: '改用本地磁盘路径（如 C:\\agentforge），或将网络位置先同步到本地再使用',
    });
  }
  return path.resolve(p);
}

/** 路径等价比较：win32 先 normalize 再大小写不敏感；posix 精确比较（Spec §2.1）。 */
export function samePath(a: string, b: string, os: OsContext): boolean {
  const api = pathApiFor(os);
  const na = api.normalize(a);
  const nb = api.normalize(b);
  return os.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * Windows 长路径保护（Spec §2.1.1）：长度 >240 时加 `\\?\` 前缀。
 * - 仅 win32 生效；已是 `\\?\` 前缀或 UNC 长路径形式则原样返回；
 * - 假定输入为绝对路径（Spec §2.1：路径一律绝对）。
 */
export function longPathAware(p: string, os: OsContext): string {
  if (os.platform !== 'win32' || p.length <= 240) return p;
  if (p.startsWith('\\\\?\\')) return p;
  const normalized = path.win32.normalize(p);
  // UNC 长路径形式：\\server\share → \\?\UNC\server\share
  if (normalized.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${normalized.slice(2)}`;
  }
  return `\\\\?\\${normalized}`;
}

/**
 * 检测用户目录是否处于 OneDrive 同步范围内（Spec §2.1.1，doctor 用 warning）。
 * 判据（满足其一）：
 * 1) 路径中含 OneDrive 目录段（`OneDrive`、`OneDrive - <tenant>`）；
 * 2) 环境变量 OneDrive 指向的目录与用户目录互为前缀。
 */
export function detectOneDrive(userProfile: string, host: Host): boolean {
  const segments = userProfile.split(/[\\/]+/).filter((s) => s !== '');
  for (const segment of segments) {
    if (/^onedrive(?:$|[\s-])/i.test(segment)) {
      return true;
    }
  }

  const oneDriveEnv = host.env('OneDrive');
  if (oneDriveEnv === undefined) return false;
  const od = oneDriveEnv.trim().replace(/[\\/]+$/, '');
  if (od === '') return false;
  const up = userProfile.trim().replace(/[\\/]+$/, '');
  const odLower = od.toLowerCase();
  const upLower = up.toLowerCase();
  return (
    upLower === odLower ||
    upLower.startsWith(`${odLower}\\`) ||
    odLower.startsWith(`${upLower}\\`)
  );
}
