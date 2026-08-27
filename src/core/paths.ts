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
import type { EnvSnapshot } from './env';
import { ConfigError, GenericError } from './errors';

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

/** win32 / posix 路径 api（pathApiFor 的返回类型；供跨模块签名标注复用）。 */
export type PathApi = typeof path.win32 | typeof path.posix;

/**
 * 按注入 os 选择路径 api（win32 / posix）。
 *
 * 纯计算：所有需要"在任意宿主平台上算另一平台路径"的调用点（paths 自身与
 * 四个 projector）共用这一处，避免各自复制一份平台判定。
 */
export function pathApiFor(os: OsContext): PathApi {
  return os.platform === 'win32' ? path.win32 : path.posix;
}

/**
 * skills 子目录名（Spec §2.3 / §7.6）：SoT 侧 `<sotRoot>/skills/<name>/` 与四个
 * target 的投影侧 `<targetRoot>/skills/<name>/` 同名，故只有一处定义。
 *
 * 放在本模块（最底层的纯路径模块）而非 projectors/shared：SoT 侧的消费者
 * （core/sources/skill、core/learning/promote、core/doctor/check-environment、
 * commands/init-scaffold）
 * 与投影侧的消费者（四个 projector）互不依赖，共享物必须落在两者共同的下游。
 * projectors/shared 仍原样导出这两个名字（见该文件），投影侧调用点无需改动。
 */
export const SKILLS_DIRNAME = 'skills';

/** 单个 skill 的说明文件名（SoT 侧与四个 target 投影侧统一约定，Spec §2.3）。 */
export const SKILL_DOC_FILENAME = 'SKILL.md';

/** 要求存在用户目录，否则无法解析任何用户级路径。 */
function requireUserProfile(env: EnvSnapshot): string {
  const home = env.userProfile;
  if (home === undefined || home === '') {
    throw new ConfigError('无法确定用户目录（USERPROFILE / HOME 均未设置，且 homedir 解析失败）', {
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
    return validatePath(env.agfHome, os);
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
 *
 * UNC 是 Windows 概念，故只在 win32 上拦：posix 上 `\` 是合法文件名字符，
 * `//foo` 是合法绝对路径（`path.posix.resolve` 折叠为 `/foo`），拦掉即误伤。
 * 绝对化同样按注入 os 走 pathApiFor，否则在 posix 宿主上算 win32 路径会退化为
 * "拼到 cwd 后面"。
 */
export function validatePath(p: string, os: OsContext = currentOs()): string {
  if (os.platform === 'win32' && (p.startsWith('\\\\') || p.startsWith('//'))) {
    throw new GenericError(`AGF_HOME 不支持网络路径（UNC）: ${p}`, {
      hint: '改用本地磁盘路径（如 C:\\agentforge），或将网络位置先同步到本地再使用',
    });
  }
  return pathApiFor(os).resolve(p);
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
  if (os.platform !== 'win32' || p.length <= 240) {
    return p;
  }
  if (p.startsWith('\\\\?\\')) {
    return p;
  }
  const normalized = path.win32.normalize(p);
  // UNC 长路径形式：\\server\share → \\?\UNC\server\share
  if (normalized.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${normalized.slice(2)}`;
  }
  return `\\\\?\\${normalized}`;
}

/**
 * 分隔符归一到 `/`（每个 `\` 与 `/` 都映射为一个 `/`，不折叠连续分隔符、
 * 不 trim、不去尾部分隔符）。
 *
 * 用于**逻辑路径**的呈现：写进文件正文的 `.gitignore` 模式、模板 id、
 * 相对路径展示、从路径末段派生标识。这些取值与宿主平台无关，在 Windows 上
 * 也必须是 `/`，所以不能用 `path.sep`。
 *
 * 与本文件内 toComparablePath 的区别：后者是**前缀比较**用的归一化
 * （额外 trim + 去尾部分隔符 + 把连续分隔符折叠成一个），两者不可互换。
 * 与写盘路径无关：落盘路径一律走 pathApiFor / longPathAware。
 */
export function toPosixSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * 前缀比较用的归一化：去首尾空白、去尾部分隔符、分隔符统一为 `/`。
 *
 * 分隔符必须统一：macOS / Linux 版 OneDrive 的环境变量与 userProfile 用 `/` 分隔，
 * 若只拼 `\\` 做前缀比较则前缀关系恒为 false（只有完全相等才命中），
 * 与本文件段扫描处的 `/[\\/]+/` 兼容策略不一致。
 */
function toComparablePath(p: string): string {
  return p
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/[\\/]+/g, '/');
}

/**
 * 检测用户目录是否处于 OneDrive 同步范围内（Spec §2.1.1，doctor 用 warning）。
 * 判据（满足其一）：
 * 1) 路径中含 OneDrive 目录段（`OneDrive`、`OneDrive - <tenant>`）；
 * 2) 环境变量 OneDrive 指向的目录与用户目录互为前缀（分隔符不敏感）。
 */
export function detectOneDrive(userProfile: string, host: Host): boolean {
  const segments = userProfile.split(/[\\/]+/).filter((s) => s !== '');
  for (const segment of segments) {
    if (/^onedrive(?:$|[\s-])/i.test(segment)) {
      return true;
    }
  }

  const oneDriveEnv = host.env('OneDrive');
  if (oneDriveEnv === undefined) {
    return false;
  }
  const od = toComparablePath(oneDriveEnv);
  if (od === '') {
    return false;
  }
  const up = toComparablePath(userProfile);
  const odLower = od.toLowerCase();
  const upLower = up.toLowerCase();
  return (
    upLower === odLower || upLower.startsWith(`${odLower}/`) || odLower.startsWith(`${upLower}/`)
  );
}

/**
 * 去掉 Windows 长路径前缀（`\\?\` / `\\?\UNC\`），使两侧路径可以逐段比较。
 *
 * longPathAware 加过前缀的路径与未加前缀的根直接比较必然不等，而"是否加前缀"取决于
 * 路径长度这种与语义无关的因素——比较前先剥掉，避免边界判定随路径长度漂移。
 */
export function stripLongPathPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${p.slice('\\\\?\\UNC\\'.length)}`;
  }
  return p.startsWith('\\\\?\\') ? p.slice('\\\\?\\'.length) : p;
}

/**
 * 目标路径是否落在任一白名单根内（win32 大小写不敏感）。
 *
 * 用 `relative` 而不是字符串前缀：前缀比较会把 `C:\a-b` 判成在 `C:\a` 内。
 * 恢复落盘 journal（§10 不信任磁盘上的 JSON）与事务锁根解析都靠它划边界。
 */
export function isWithinAnyRoot(target: string, roots: readonly string[], os: OsContext): boolean {
  const api = pathApiFor(os);
  const fold = (p: string): string => {
    const bare = stripLongPathPrefix(p);
    return os.platform === 'win32' ? bare.toLowerCase() : bare;
  };
  const folded = fold(target);
  return roots.some((root) => {
    const rel = api.relative(fold(root), folded);
    return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
  });
}
