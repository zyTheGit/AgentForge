/**
 * 路径解析（Spec §2.1 / §2.1.1 / §2.2）：纯计算，路径计算依赖注入的 env 与 os。
 *
 * - 一律输出规范化绝对路径（Spec §2.1）；
 * - Windows 比较大小写不敏感（samePath）；
 * - 长路径（>240）加 `\\?\` 前缀（Spec §2.1.1）；
 * - UNC 不支持（Spec §2.1.1，退出码 1）；
 * - **全部外部路径入口**（AGF_HOME / CODEX_HOME / PI_CODING_AGENT_DIR / 项目目录）
 *   共用 validatePath 这一个守卫：`~` 展开 + UNC / 无盘符绝对路径的拒绝；
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
 * commands/lifecycle/init-scaffold）
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
 * 返回规范化绝对路径；AGF_HOME 本身先过统一守卫（validatePath）。
 */
export function resolveUserSoT(env: EnvSnapshot, os: OsContext = currentOs()): string {
  if (env.agfHome !== undefined && env.agfHome !== '') {
    return validatePath(env.agfHome, os, { origin: AGF_HOME_ENV, home: env.userProfile });
  }
  const api = pathApiFor(os);
  return api.resolve(requireUserProfile(env), '.agentforge');
}

/**
 * 项目级 SoT 根目录（Spec §2.1）：`<projectRoot>/.agentforge`（绝对化）。
 *
 * projectRoot 同样过统一守卫：它来自 `--cwd` / 进程 cwd，是与 AGF_HOME 同类的
 * **外部**取值，UNC 形态在这里放过去等于把 §2.1.1 的拒绝只落实了一半。
 */
export function resolveProjectSoT(projectRoot: string, os: OsContext = currentOs()): string {
  const api = pathApiFor(os);
  return api.resolve(validatePath(projectRoot, os, { origin: PROJECT_DIR_ORIGIN }), '.agentforge');
}

/**
 * 四 target 的用户级全局目录（Spec §2.2）：
 * - opencode：`~/.config/opencode`
 * - codex：CODEX_HOME 覆盖，否则 `~/.codex`
 * - claude：`~/.claude`
 * - pi：PI_CODING_AGENT_DIR 覆盖，否则 `~/.pi/agent`
 * 分隔符随注入 os 变化（win32 `\`，posix `/`）。
 */
export function resolveTargetUserDirs(env: EnvSnapshot, os: OsContext): TargetUserDirs {
  const api = pathApiFor(os);
  const home = requireUserProfile(env);
  return {
    opencode: api.resolve(home, '.config', 'opencode'),
    codex: resolveOverridableDir(
      env.codexHome,
      api.resolve(home, '.codex'),
      CODEX_HOME_ENV,
      home,
      os,
    ),
    claude: api.resolve(home, '.claude'),
    pi: resolveOverridableDir(
      env.piCodingAgentDir,
      api.resolve(home, '.pi', 'agent'),
      PI_AGENT_DIR_ENV,
      home,
      os,
    ),
  };
}

// ---------------------------------------------------------------------------
// 外部路径入口的统一守卫（Spec §2.1 / §2.1.1）
// ---------------------------------------------------------------------------

/** 统一守卫覆盖的环境变量名（错误消息与 doctor 条目共用同一字面量）。 */
export const AGF_HOME_ENV = 'AGF_HOME';
export const CODEX_HOME_ENV = 'CODEX_HOME';
export const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';

/** 非环境变量的入口名：`--cwd` / 进程 cwd 推导出的项目根。 */
export const PROJECT_DIR_ORIGIN = '项目目录';

/** 外部路径入口的校验上下文。 */
export interface PathGuardContext {
  /** 入口名（环境变量名 / PROJECT_DIR_ORIGIN）：出现在错误消息与 hint 里。 */
  readonly origin: string;
  /**
   * `~` 展开的基准目录。缺省（或空串）时输入以 `~` 开头即报 ConfigError——
   * 绝不放过去：`path.resolve` 会把它当成一个普通相对段，造出字面名为 `~` 的目录。
   */
  readonly home?: string | undefined;
}

/** 前导 `~` 段：`~` 自身或 `~/x` / `~\x`；`~user` 形态不在其中（见 expandTilde）。 */
const LEADING_TILDE = /^~(?=$|[\\/])/;

/**
 * `~` 展开。**必须在任何校验与绝对化之前**发生，否则字面 `~` 会被当成合法相对段
 * （落出一个真的名为 `~` 的目录，用户在文件管理器里根本认不出那是自己的配置）。
 *
 * 只展开前导的 `~` 段。`~user`（展开成"另一个用户的家目录"）在三大平台上语义不同、
 * 且需要读 passwd，这里不猜——直接报错比落到错误的目录下安全。
 */
function expandTilde(p: string, os: OsContext, ctx: PathGuardContext): string {
  if (!LEADING_TILDE.test(p)) {
    if (p.startsWith('~')) {
      throw new ConfigError(`${ctx.origin} 不支持 \`~user\` 形态的路径: ${p}`, {
        hint: `写完整路径，或用 \`~/\` 开头表示当前用户的家目录（当前 ${ctx.origin}=${p}）`,
      });
    }
    return p;
  }
  if (ctx.home === undefined || ctx.home === '') {
    throw new ConfigError(`${ctx.origin} 以 \`~\` 开头但无法确定家目录: ${p}`, {
      hint: '设置 USERPROFILE（Windows）或 HOME（类 Unix），或把该取值改成完整绝对路径',
    });
  }
  const rest = p.slice(1).replace(/^[\\/]+/, '');
  return rest === '' ? ctx.home : pathApiFor(os).join(ctx.home, rest);
}

/**
 * 外部路径入口的统一守卫：`~` 展开 → 形态校验 → 规范化绝对路径。
 *
 * 覆盖 AGF_HOME / CODEX_HOME / PI_CODING_AGENT_DIR / 项目目录四个入口（调用点见
 * resolveUserSoT、resolveProjectSoT、resolveOverridableDir）。四者是同一类取值——
 * "由用户从进程外部指定的落盘根"——只给其中一个上守卫等于没上：codex 的
 * `hooks.json` 是整文件 `write`，落点由 CODEX_HOME 决定，漏掉它就等于把一次整文件
 * 覆盖导向任意目录。
 *
 * 两档处置：
 * - **拒绝**：UNC（`\\` / `//` 开头）→ GenericError(1)，与 Spec §2.1.1 一致；
 *   win32 上的无盘符绝对路径（`/home/x`、`\opt\x`）与 `~user` / 无家目录的 `~`
 *   → ConfigError(2)（取值本身写错了，属于配置错误）。
 * - **放过但可诊断**：相对路径仍按 `path.resolve` 语义绝对化（历史行为，AGF_HOME
 *   一直如此），由 doctor 的 `hasFixedRoot` 判据报 warn——它只是落点随 cwd 漂移，
 *   不像上面几种会写到一个用户完全没预期的位置。
 *
 * UNC 只在 win32 上拦：posix 上 `\` 是合法文件名字符，`//foo` 是合法绝对路径
 * （`path.posix.resolve` 折叠为 `/foo`），拦掉即误伤。
 * 绝对化同样按注入 os 走 pathApiFor，否则在 posix 宿主上算 win32 路径会退化为
 * "拼到 cwd 后面"。
 */
export function validatePath(
  p: string,
  os: OsContext = currentOs(),
  ctx: PathGuardContext = { origin: AGF_HOME_ENV },
): string {
  const expanded = expandTilde(p, os, ctx);
  if (os.platform === 'win32') {
    if (expanded.startsWith('\\\\') || expanded.startsWith('//')) {
      throw new GenericError(`${ctx.origin} 不支持网络路径（UNC）: ${expanded}`, {
        hint: '改用本地磁盘路径（如 C:\\agentforge），或将网络位置先同步到本地再使用',
      });
    }
    // `/home/x` / `\opt\x`：win32.resolve 会静默补上 cwd 的盘符，落点与用户写的完全不是
    // 一回事（典型是在 Windows 上照抄了一份 WSL 侧的配置），不猜盘符，直接报错。
    if (/^[\\/]/.test(expanded)) {
      throw new ConfigError(`${ctx.origin} 在 Windows 上必须带盘符: ${expanded}`, {
        hint: `写成 \`C:\\...\` 形态（当前取值会被静默解析到当前盘符下）；WSL 侧的 posix 路径不能直接用于 Windows 侧的 ${ctx.origin}`,
      });
    }
  }
  return pathApiFor(os).resolve(expanded);
}

/**
 * 可被环境变量覆盖的 target 用户级目录（CODEX_HOME / PI_CODING_AGENT_DIR）。
 *
 * 为什么要有这一层而不是各调用点自己写三元：这两个变量的解析点有三处
 * （本文件的 resolveTargetUserDirs、projectors/codex 的 codexUserDir、
 * projectors/pi 的 piUserAgentDir），必须给出同一结论。缺省值由调用方各自拼好传进来
 * ——codex 用 `<rootDir>/.codex`、pi 用 `<rootDir>/.pi/agent`，段定义在各 projector 里。
 *
 * @param override 环境变量原值（undefined / 空串 → 用 fallback，不做任何校验）。
 * @param fallback 未置位时的缺省目录（调用方已算好，不再过守卫）。
 * @param home `~` 展开基准（通常即 user scope 的基准根）。
 */
export function resolveOverridableDir(
  override: string | undefined,
  fallback: string,
  origin: string,
  home: string | undefined,
  os: OsContext,
): string {
  if (override === undefined || override === '') {
    return fallback;
  }
  return validatePath(override, os, { origin, home });
}

/**
 * 取值是否给定了**确定**的落点（`~` 打头或绝对路径）。
 *
 * doctor 用它把"能解析但落点随进程 cwd 漂移"的相对取值报成 warn：
 * `CODEX_HOME=codex-home` 在不同目录下跑 sync 会投影到不同地方，而 validatePath
 * 按历史语义放过它（AGF_HOME 一直允许相对值），只报不拦。
 */
export function hasFixedRoot(p: string, os: OsContext): boolean {
  return p.startsWith('~') || pathApiFor(os).isAbsolute(p);
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
 * 记账路径的比较键：剥长路径前缀 + 分隔符统一为 `/` + **无条件**折叠大小写。
 *
 * 与 samePath 的区别：samePath 按 `os.platform` 决定是否折叠大小写，而 sync-meta 里的
 * 路径是**上一轮进程**写下的，写它的进程未必与当前进程处在同一路径语义下：
 * - WSL 里 `/mnt/c` 报 `process.platform === 'linux'`，但底层 drvfs 大小写不敏感；
 * - Windows 上 `process.cwd()` 的盘符大小写随启动方式漂移（`c:\x` 与 `C:\x` 同一文件）。
 *
 * 于是"按平台决定折不折"这件事本身不可靠——差集比对一律折叠。
 *
 * 代价：POSIX 上仅大小写不同的两个真实文件会被判成同一项，prune 会漏删其中之一。
 * 失败方向因此从「误删活产物」（数据丢失，issue #67）变成「漏删残留」（由调用方报成
 * skip，用户可见可手删）。这个不对称是刻意的。
 */
export function pathIdentityKey(p: string): string {
  return stripLongPathPrefix(p)
    .replace(/[\\/]+/g, '/')
    .toLowerCase();
}

/** 绝对路径的书写形态。`other` = 相对路径等无法判定归属的取值。 */
export type PathFlavor = 'win32' | 'posix' | 'other';

/**
 * 路径的书写形态：盘符 / UNC → `win32`；`/` 打头 → `posix`；其余 → `other`。
 *
 * 用来识别「这条记账是另一平台写下的」：同一个 SoT 被 Windows 与 WSL 交替 sync 时，
 * 两侧记下的绝对路径形态不同（`C:\...` vs `/mnt/c/...`），当前进程对另一侧的路径
 * 既 stat 不到也不该删——必须与「用户手删了产物」区分开（issue #68）。
 */
export function pathFlavorOf(p: string): PathFlavor {
  const bare = stripLongPathPrefix(p);
  if (/^[a-zA-Z]:[\\/]/.test(bare) || bare.startsWith('\\\\')) {
    return 'win32';
  }
  return bare.startsWith('/') ? 'posix' : 'other';
}

/** 当前平台写出的绝对路径应有的形态。 */
export function nativePathFlavor(os: OsContext): PathFlavor {
  return os.platform === 'win32' ? 'win32' : 'posix';
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
