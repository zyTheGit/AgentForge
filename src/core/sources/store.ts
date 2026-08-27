/**
 * 源登记表与缓存布局（Spec §3.1 存放位置 / §4.4 sources.json / §10 安全边界）。
 *
 * 本模块只做一件事：**把"源 id / url / ref"这类外部输入变成可信的落盘位置**——
 * sources.json 的读写、`<userSoT>\store\<id>` 的路径推导，以及守护二者的纯校验。
 *
 * 为什么单独成模块（而不是留在 manager.ts）：
 * - manager.ts 的职责是 add/list/update/remove 的**流程编排**（离线判定、git 调用
 *   序列、结果装配），与"往哪写盘、路径是否越界"是两种变化速率不同的关注点；
 * - 这里的每个函数都直接决定安全不变量（递归删除的目标、clone 的目标目录、传给
 *   git 的参数），集中一处才能一眼看全边界，也便于单测逐条断言（守卫全为无 IO
 *   的纯函数，assert* 一律导出，见下方 §10 小节的理由）；
 * - 依赖方向单向：manager → store。store 不反向依赖 manager，因此
 *   `SourceManagerContext` 契约随最底层消费者下沉到本文件（manager.ts 再 re-export
 *   保持对外导出面不变），避免类型环。
 */
import path from 'node:path';
import { atomicWrite, mkdirp } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import type { Source } from '../../schema';
import { loadSourcesFile, SOURCES_FILE } from '../config/load';
import type { EnvSnapshot } from '../env';
import { ConfigError } from '../errors';
import { isWithinAnyRoot, type OsContext, samePath, toPosixSeparators } from '../paths';

/** Spec §3.1：git 源缓存目录名（user 层 SoT 下）。 */
export const STORE_DIR = 'store';

/** 源管理上下文。 */
export interface SourceManagerContext {
  readonly host: Host;
  readonly env: EnvSnapshot;
  /** user 层 SoT 根（sources.json 与 store\ 所在层）。 */
  readonly userSoTRoot: string;
  /** 相对路径解析基准（addLocal 的相对 path）。 */
  readonly cwd: string;
  /** 宿主平台（store 边界判定的大小写 / 长路径前缀口径，见 assertWithinStore）。 */
  readonly os: OsContext;
}

// ---------------------------------------------------------------------------
// 基础设施：sources.json 读写 / id 派生
// ---------------------------------------------------------------------------

function sourcesFilePath(ctx: SourceManagerContext): string {
  return path.join(ctx.userSoTRoot, SOURCES_FILE);
}

/** 读 sources.json（不存在 → 空表；损坏 → ConfigError(2)，loadJson 层映射）。 */
export async function loadSources(ctx: SourceManagerContext): Promise<Source[]> {
  const sources = (await loadSourcesFile(ctx.host, ctx.userSoTRoot))?.sources ?? [];
  // schema 侧 id 仅 min(1)（不加 pattern 以免破坏既有夹具），越界字符在此拦截：
  // 登记表里的 id 会直接参与 store\<id> 路径拼装与递归删除，必须逐项校验
  for (const source of sources) {
    assertSourceId(source.id);
  }
  return sources;
}

/** 写 sources.json（2 空格缩进 + 末尾换行，原子写；父目录自动创建——源登记可先于 user 层 init）。 */
export async function saveSources(
  ctx: SourceManagerContext,
  sources: readonly Source[],
): Promise<string> {
  const file = sourcesFilePath(ctx);
  await mkdirp(ctx.host, path.dirname(file));
  const text = `${JSON.stringify({ version: 1, sources }, null, 2)}\n`;
  await atomicWrite(ctx.host, file, text);
  return file;
}

/** git 源缓存根目录：`<userSoT>\store`（全部源缓存的边界）。 */
function storeRootDir(ctx: SourceManagerContext): string {
  return path.join(ctx.userSoTRoot, STORE_DIR);
}

/** git 源缓存目录：`<userSoT>\store\<id>`（id 先过 assertSourceId）。 */
export function sourceStoreDir(ctx: SourceManagerContext, id: string): string {
  assertSourceId(id);
  return path.join(storeRootDir(ctx), id);
}

// ---------------------------------------------------------------------------
// §10 安全守卫（统一 export）
//
// 五个 assert* 一律导出，可见性不再参差：它们是本模块的安全不变量
// （id / store 边界 / 选项注入 / url / ref），每条都直接决定"往哪写盘、给 git 传
// 什么参数"。半导出半私有的后果是覆盖不均——私有的那几个只能靠 addGitSource /
// updateSource 的间接路径撞，边界用例（`-` 前缀、`root-evil` 前缀绕过）写不出来。
// 统一导出后每条守卫都能被直接断言，且它们都是纯校验函数（无 IO、无状态），
// 对外暴露不增加可被误用的表面。
// ---------------------------------------------------------------------------

/**
 * 断言目录严格位于 store 根之内（越界删除 / 越界 clone 的纵深防御）。
 * 等于 store 根本身也拒绝（不允许整体回收）。
 *
 * 边界判定复用 paths.isWithinAnyRoot（单一事实源）：它用 `path.relative` 而非
 * 字符串前缀（`<store 根>-evil` 这种兄弟目录不会被判成"在 store 内"），并额外做
 * win32 大小写折叠与 `\\?\` / `\\?\UNC\` 长路径前缀剥离。本函数早先自己拼
 * `${root}${sep}` 前缀比较，缺后两项——win32 上大小写或长路径前缀不一致时会把
 * 合法目录误判为越界（fail-closed，不会放过真越界，但会挡住正常 remove/update）。
 *
 * @throws ConfigError(2) 目录逃出 store 根。
 */
export function assertWithinStore(ctx: SourceManagerContext, dir: string): void {
  const root = storeRootDir(ctx);
  const target = path.resolve(dir);
  if (!isWithinAnyRoot(target, [root], ctx.os) || samePath(target, root, ctx.os)) {
    throw new ConfigError(`源缓存目录逃出 store 根: ${dir}`, {
      hint: '源 id 不得包含路径分隔符或 ..；用 aforge source list 检查 sources.json 的 id 字段',
      details: { dir, resolved: target, storeRoot: root },
    });
  }
}

/** 源 id 安全格式（与 deriveSourceId 的输出约束同源）：小写字母数字开头，长度 2-64。 */
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** git ref 白名单：字母数字与 `. _ / -`，长度 1-255（拒绝空格 / `:` / `^` 等 git 语法字符）。 */
const GIT_REF_PATTERN = /^[A-Za-z0-9._/-]{1,255}$/;

/**
 * 校验源 id（显式 --id 与 sources.json 读入项共用同一守卫）。
 *
 * id 直接参与 `store\<id>` 路径拼装、递归删除与 git clone 目标目录，
 * `../../x` 之类取值会越界写盘/删盘，必须在进入路径计算前拦掉。
 *
 * @throws ConfigError(2) id 不匹配 `^[a-z0-9][a-z0-9_-]{1,63}$`。
 */
export function assertSourceId(id: string): void {
  if (!SOURCE_ID_PATTERN.test(id)) {
    throw new ConfigError(`非法源 id: ${id}`, {
      hint: '合法格式：以小写字母或数字开头，仅含小写字母、数字、下划线、连字符，长度 2-64（如 my-source）',
      details: { id, pattern: SOURCE_ID_PATTERN.source },
    });
  }
}

/**
 * 拒绝以 `-` 开头的取值（§10 参数注入）：git 在位置参数后仍解析选项，
 * `--ref=--upload-pack=<cmd>` 一类取值会被当作 git 选项 → 任意命令执行。
 *
 * @throws ConfigError(2) 取值以 `-` 开头。
 */
export function assertNotOptionLike(value: string, field: string): void {
  if (value.startsWith('-')) {
    throw new ConfigError(`${field} 不得以 "-" 开头: ${value}`, {
      hint: 'git 在位置参数后仍会解析选项；请去掉开头的连字符（如需传 ref，用 v1.2.0 / main / <sha> 形式）',
      details: { field, value },
    });
  }
}

/** 校验 git url：非空且不以 `-` 开头（防被 git 解析为选项）。@throws ConfigError(2) */
export function assertGitUrl(url: string): void {
  if (url.trim() === '') {
    throw new ConfigError('git 源 url 不能为空', {
      hint: '示例: aforge source add https://example.com/repo.git --ref v1.2.0',
      details: { url },
    });
  }
  assertNotOptionLike(url, 'git url');
}

/** 校验 git ref：不以 `-` 开头且匹配白名单。@throws ConfigError(2) */
export function assertGitRef(ref: string): void {
  assertNotOptionLike(ref, 'git ref');
  if (!GIT_REF_PATTERN.test(ref)) {
    throw new ConfigError(`非法 git ref: ${ref}`, {
      hint: 'ref 仅允许字母、数字与 . _ / -（长度 1-255）；tag / branch / commit sha 均满足',
      details: { ref, pattern: GIT_REF_PATTERN.source },
    });
  }
}

/**
 * 从 url / 本地路径派生源 id：末段 basename（去 .git 后缀），非法字符压成 '-'。
 * 结果不匹配 ^[a-z0-9][a-z0-9_-]{1,63}$ 时抛错，要求用户显式指定 --id
 * （保证幂等性：同一 URL 多次调用产生相同 id）。
 */
export function deriveSourceId(target: string): string {
  const normalized = toPosixSeparators(target).replace(/\/+$/, '');
  const last = normalized.split('/').pop() ?? '';
  const base = last.replace(/\.git$/, '');
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (SOURCE_ID_PATTERN.test(sanitized)) {
    return sanitized;
  }
  throw new ConfigError(`无法从路径派生合法的源 id: ${target}（规范化后为 "${sanitized}"）`, {
    hint: '请显式指定 --id（合法格式：以字母或数字开头，仅含小写字母、数字、下划线、连字符，长度 2-64），例如: aforge source add <url> --id my-source',
    details: { target, sanitized },
  });
}
