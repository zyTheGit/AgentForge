/**
 * 声明式适配器的 **containment 校验**（issue #53 安全边界 3）——本层最重要的护栏。
 *
 * ## 与 core/paths.validatePath（PR #59 统一守卫）的分工
 *
 * 两者都在问「外部给的路径能不能用」，但管的是**不同的东西**，不能合并、也不许各写
 * 一份重叠判据：
 *
 * | | core/paths.validatePath | 本模块 |
 * | --- | --- | --- |
 * | 对象 | 用户从**进程外部**指定的**根目录**（AGF_HOME / CODEX_HOME / PI_CODING_AGENT_DIR / 项目目录） | 适配器**模板渲染出来的落点**（根 + 声明的路径段） |
 * | 判什么 | 取值形态：`~` 展开、UNC、win32 无盘符绝对路径、`~user` | 落点相对**允许根集合**的位置关系：越界、盘符跳变、兄弟目录、symlink 逃逸 |
 * | 时机 | 每次解析那几个入口 | 加载（含 symlink）+ 每次 plan（纯路径） |
 * | 数据来源 | 环境 / 命令行 | `adapters/<id>.yaml` |
 *
 * 复用关系是**单向的**：本模块的允许根集合里，白名单环境变量那几项在
 * `loader.readWhitelistedEnv` 里已经过了 `validatePath`，所以这里不再重判形态
 * （只留一条 `isAbsolute` 不变量断言，见 isUsableRootValue 的 JSDoc）。反过来
 * 守卫不知道适配器的存在，也不该知道——它看不到模板，判不了「越界」。
 *
 * 判据：模板求值后的绝对路径，规范化之后必须落在下列**允许根**之一之下——
 * `projectRoot`、`userHome`，或某个**已置位且过了守卫的**白名单环境变量指向的目录
 * （`CODEX_HOME` 这类变量本身就是「某个 agent 的配置根」，上游客户端也按它找配置，
 * 所以它指向哪里、投影就该落在哪里）。
 *
 * 拦下来的绕过手法（逐条有测试，见 tests/unit/adapters/containment.spec.ts）：
 * - `..` 目录穿越（模板层已拒，这里是第二道：环境变量值里带 `..` 时仍能拦）；
 * - 盘符跳变（`D:\...` 落点 vs `C:\Users\u` 根）；
 * - UNC / 网络路径**落点**（`\\server\share`，win32 上一律拒——Spec §2.1.1 同口径）；
 * - 前缀相似的兄弟目录（`C:\Users\user2` 不算落在 `C:\Users\user` 内，靠
 *   `paths.isWithinAnyRoot` 的 relative 判据而非字符串前缀）；
 * - **symlink 逃逸**：落点自身或任一已存在的祖先目录是指向根外的 symlink
 *   （`~/.my` → `C:\Windows`），纯路径运算看不出来，必须读 fs。
 *
 * 两个入口对应两种时机：
 * - `assertWithinAllowedRoots`：**纯函数**，plan 阶段（每次 sync / doctor / status）
 *   都跑，零 IO；
 * - `assertNoSymlinkEscape`：**异步**，只在加载注册阶段跑一次（要读 lstat/readlink）。
 *
 * 两者都不合格 → ConfigError(2)。
 */

import type { Host } from '../../infra/host';
import { ConfigError } from '../errors';
import { isWithinAnyRoot, type OsContext, type PathApi, stripLongPathPrefix } from '../paths';
import { ADAPTER_ENV_WHITELIST, type AdapterEnvName } from './limits';

/** containment 违规 → ConfigError(2)，由 loader 归类为 `containment` 失败。 */
export class AdapterContainmentError extends ConfigError {
  constructor(message: string, hint: string) {
    super(message, { hint });
    this.name = 'AdapterContainmentError';
  }
}

/** symlink 解析的最大跳数（防 symlink 环把加载卡死）。 */
const MAX_SYMLINK_HOPS = 16;

/** 本次求值可用的允许根集合（含来源标注，报错时要说清「越出了哪些根」）。 */
export interface AllowedRoots {
  /** 全部允许根的绝对路径（顺序：projectRoot → userHome → 白名单 env）。 */
  readonly roots: readonly string[];
  /** 每个根的来源标注（`userHome=C:\Users\u` 形态），只进错误提示。 */
  readonly labels: readonly string[];
}

/**
 * 允许根候选是否可用：非空且是**绝对路径**。
 *
 * 这里刻意**不再判 UNC**——「外部给的路径取值形态合不合法」（`~` 展开 / UNC /
 * win32 无盘符绝对路径 / `~user`）只有一处判据，即 core/paths.validatePath
 * （PR #59 的统一守卫）；白名单环境变量在 loader.readWhitelistedEnv 已经过它一遍。
 * 同一件事在这里再判一次，下次守卫改了分级就会剩一个对不上的旧判据。
 *
 * 落点侧的 UNC 仍要拦，见 assertWithinAllowedRoots——那是守卫看不到的东西（守卫管
 * 「用户给的根」，落点是根 + 模板段拼出来的）。就算某个调用点漏了守卫、让 UNC 混进
 * 允许根，`C:\...` 形态的落点也不会因此落进它内部（relative 判据），而 UNC 形态的
 * 落点会被落点侧那道直接拒掉。
 */
function isUsableRootValue(value: string | undefined, api: PathApi): boolean {
  if (value === undefined || value.trim() === '') {
    return false;
  }
  return api.isAbsolute(value.trim());
}

/**
 * 组装允许根集合。
 *
 * @param projectRoot 项目根（恒可用）。
 * @param userHome 用户目录（取不到时不进集合）。
 * @param envValues 白名单环境变量**过完统一守卫之后**的取值：未置位、或取值被守卫
 *   拒绝（UNC / 无盘符 / `~user`）的变量根本不会出现在这个 map 里，见
 *   loader.readWhitelistedEnv。
 */
export function buildAllowedRoots(
  projectRoot: string,
  userHome: string | undefined,
  envValues: Readonly<Partial<Record<AdapterEnvName, string>>>,
  api: PathApi,
): AllowedRoots {
  const roots: string[] = [];
  const labels: string[] = [];
  const push = (label: string, value: string | undefined): void => {
    if (!isUsableRootValue(value, api)) {
      return;
    }
    const resolved = api.resolve((value as string).trim());
    roots.push(resolved);
    labels.push(`${label}=${resolved}`);
  };
  push('projectRoot', projectRoot);
  push('userHome', userHome);
  for (const name of ADAPTER_ENV_WHITELIST) {
    push(name, envValues[name]);
  }
  return { roots, labels };
}

/**
 * 纯路径 containment 校验（plan 阶段每次都跑）。
 *
 * @param target 待校验的绝对路径（模板求值结果）。
 * @param allowed 允许根集合。
 * @param what 出错时报的落点名（如 `my-agent.user.main_rule`）。
 * @throws AdapterContainmentError 路径越出全部允许根 / 是 UNC / 不是绝对路径。
 */
export function assertWithinAllowedRoots(
  target: string,
  allowed: AllowedRoots,
  os: OsContext,
  api: PathApi,
  what: string,
): void {
  const bare = stripLongPathPrefix(target);
  if (os.platform === 'win32' && (bare.startsWith('\\\\') || bare.startsWith('//'))) {
    throw new AdapterContainmentError(
      `${what}: 落点是网络路径（UNC）: ${target}`,
      'UNC 不受支持（Spec §2.1.1）——改用本地磁盘路径，或把网络位置先同步到本地',
    );
  }
  if (!api.isAbsolute(bare)) {
    throw new AdapterContainmentError(
      `${what}: 落点不是绝对路径: ${target}`,
      '路径模板必须以 {projectRoot} / {userHome} / {env:NAME} 开头',
    );
  }
  if (allowed.roots.length === 0) {
    throw new AdapterContainmentError(
      `${what}: 当前环境没有任何可用的允许根（projectRoot / userHome / 白名单环境变量都取不到）`,
      '设置 USERPROFILE（Windows）或 HOME（类 Unix）后重试',
    );
  }
  if (!isWithinAnyRoot(bare, allowed.roots, os)) {
    throw new AdapterContainmentError(
      `${what}: 落点 ${target} 越出允许的根目录（${allowed.labels.join(', ')}）`,
      '声明式适配器只能往项目根、用户目录或白名单环境变量指向的目录内写；需要写到别处请改用内置 projector（须改代码并评审）',
    );
  }
}

/** 把绝对路径切成 `{ root, segments }`（`C:\a\b` → `C:\` + [a, b]）。 */
function splitPath(target: string, api: PathApi): { root: string; segments: string[] } {
  const bare = stripLongPathPrefix(target);
  const root = api.parse(bare).root;
  const segments = bare
    .slice(root.length)
    .split(/[\\/]+/)
    .filter((seg) => seg !== '');
  return { root, segments };
}

/** 找出路径上**第一个 symlink 前缀**（含落点自身）；祖先不存在即返回 undefined。 */
async function firstSymlinkPrefix(
  host: Host,
  target: string,
  api: PathApi,
): Promise<{ prefix: string; rest: string[] } | undefined> {
  const { root, segments } = splitPath(target, api);
  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    current = api.join(current, segments[i] as string);
    let isLink = false;
    try {
      isLink = (await host.lstat(current)).isSymbolicLink;
    } catch {
      // 该层不存在（或不可 lstat）→ 更深的层不可能存在，路径上再无 symlink
      return undefined;
    }
    if (isLink) {
      return { prefix: current, rest: segments.slice(i + 1) };
    }
  }
  return undefined;
}

/**
 * symlink 逃逸校验（加载注册阶段执行一次）。
 *
 * 为什么纯路径校验不够：`{userHome}/.my/skills` 逐字符看完全落在 userHome 内，
 * 但 `~/.my` 可以是一个指向 `C:\Windows` 的 symlink（或 Windows 的目录联接）。
 * 这里把落点沿路径逐层展开——遇到 symlink 就 readlink 后重新拼——最终得到**真实**
 * 路径再做一次 containment 判定。
 *
 * 允许根自身也先展开（用户目录本身是 symlink 的环境很常见），否则「根是 symlink」
 * 会让所有落点误判越界。
 *
 * @throws AdapterContainmentError 真实路径越界 / symlink 跳数超限（疑似环）。
 */
export async function assertNoSymlinkEscape(
  host: Host,
  target: string,
  allowed: AllowedRoots,
  os: OsContext,
  api: PathApi,
  what: string,
): Promise<void> {
  const realTarget = await resolveSymlinksDeep(host, target, api, what);
  const realRoots: string[] = [];
  for (const root of allowed.roots) {
    realRoots.push(await resolveSymlinksDeep(host, root, api, `${what} 的允许根`));
  }
  if (!isWithinAnyRoot(stripLongPathPrefix(realTarget), realRoots, os)) {
    throw new AdapterContainmentError(
      `${what}: 落点经 symlink 解析后指向 ${realTarget}，越出允许的根目录（${realRoots.join(', ')}）`,
      '落点路径上有指向根外的 symlink / 目录联接；删掉它或改声明落点',
    );
  }
}

/** 逐层展开路径上的 symlink，返回真实路径（不存在的层原样保留）。 */
async function resolveSymlinksDeep(
  host: Host,
  target: string,
  api: PathApi,
  what: string,
): Promise<string> {
  let current = api.resolve(stripLongPathPrefix(target));
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    const found = await firstSymlinkPrefix(host, current, api);
    if (found === undefined) {
      return current;
    }
    let link: string;
    try {
      link = await host.readlink(found.prefix);
    } catch {
      // 竞态（读到 symlink 又被删掉）：按不可解析处理，交给纯路径校验的结论
      return current;
    }
    const resolvedLink = api.isAbsolute(link)
      ? api.resolve(link)
      : api.resolve(api.dirname(found.prefix), link);
    current = found.rest.length === 0 ? resolvedLink : api.join(resolvedLink, ...found.rest);
  }
  throw new AdapterContainmentError(
    `${what}: symlink 解析超过 ${MAX_SYMLINK_HOPS} 跳（疑似 symlink 环）: ${target}`,
    '检查落点路径上的 symlink / 目录联接是否互相指向',
  );
}
