/**
 * bundle 的布局契约与 SoT 分类规则（`aforge bundle export` / `import` 共用）。
 *
 * bundle 目录形态：
 *   <out>\manifest.json     ← 自描述清单（schema/bundle）
 *   <out>\sot\...           ← 内容副本，路径与 SoT 内一一对应
 *
 * 为什么内容要放进 `sot\` 子目录而不是平铺在 `<out>` 下：manifest.json 与
 * SoT 里可能存在的同名文件不会互相争位，import 侧也能用「整棵 sot\ 树」做
 * 「manifest 未登记的多余文件」比对（见 importBundle 的 unlisted 报告）。
 *
 * 分类规则（三类，决定 export 带走什么）：
 * - CARRY_FILES / CARRY_DIRS：用户沉淀，必须带走；
 * - EXCLUDED_*：本机状态 / 事务残留 / 可重建缓存，默认剔除并在 manifest.excluded 里报出；
 * - 其余：不属于 SoT 约定布局，按 `not-part-of-sot` 报出但同样不带走——
 *   静默带走会把用户随手放在 SoT 里的临时文件搬到新机器，静默丢弃则让用户
 *   以为「导出即完整」。报而不带是唯一诚实的选项。
 */
import path from 'node:path';
import { listDirSafe } from '../../infra/fsutil';
import type { FileStat, Host } from '../../infra/host';
import type { BundleExcludeReason } from '../../schema/bundle';
import { HABITS_FILE, PROFILE_FILE, SOURCES_FILE } from '../config/load';
import { ConfigError } from '../errors';
import { type OsContext, SKILLS_DIRNAME, toPosixSeparators } from '../paths';
import {
  SYNC_BACKUP_DIRNAME,
  SYNC_BACKUP_FAILED_PREFIX,
  SYNC_LOCK_DIRNAME,
} from '../project/sync-artifacts';

/** bundle 内的内容根目录名。 */
export const BUNDLE_CONTENT_DIR = 'sot';

/** bundle 内的清单文件名。 */
export const BUNDLE_MANIFEST_FILE = 'manifest.json';

/** 顶层文件：全部带走（habits / profile 另经净化改写，见 export 的 transform）。 */
export const CARRY_FILES: readonly string[] = [HABITS_FILE, PROFILE_FILE, SOURCES_FILE];

/** 顶层目录：整棵带走（与 init 骨架 SOT_SUBDIRS 同集合）。 */
export const CARRY_DIRS: readonly string[] = [
  'custom',
  'learnings',
  'templates',
  SKILLS_DIRNAME,
  'mcp',
];

/** user 层的 git 源缓存目录名（sources/store.STORE_DIR 同值，见下方 note）。 */
const STORE_DIRNAME = 'store';

/**
 * 递归遍历深度上限。
 *
 * 与 sources/skill.MAX_COPY_DEPTH 同值但**不**共用常量：那条是「从不可信 git 源
 * 往 SoT 写盘」的安全阈值，这条是「在自己的 SoT 里走一圈」的兜底，两者调整理由
 * 不同（前者收紧要看源仓库形态，后者只防用户手工造出的环路）。
 */
export const MAX_TREE_DEPTH = 32;

/** 单条顶层条目的分类结果。 */
export type SotEntryKind =
  | { readonly kind: 'file' }
  | { readonly kind: 'dir' }
  | { readonly kind: 'excluded'; readonly reason: BundleExcludeReason };

/**
 * 顶层条目分类（只看名字，不看磁盘类型——名字即契约）。
 *
 * `store\` 只在 user 层出现，但两层用同一张表：project 层若真有个 `store\`，
 * 它也不属于 SoT 布局，归到 `cache` 与归到 `not-part-of-sot` 对用户的动作
 * （都不带走、都报出来）完全一致，不值得为此分叉。
 */
export function classifySotEntry(name: string): SotEntryKind {
  if (CARRY_FILES.includes(name)) {
    return { kind: 'file' };
  }
  if (CARRY_DIRS.includes(name)) {
    return { kind: 'dir' };
  }
  if (name === 'sync-meta.json') {
    return { kind: 'excluded', reason: 'machine-state' };
  }
  if (
    name === SYNC_LOCK_DIRNAME ||
    name === SYNC_BACKUP_DIRNAME ||
    name.startsWith(SYNC_BACKUP_FAILED_PREFIX)
  ) {
    return { kind: 'excluded', reason: 'transient' };
  }
  if (name === STORE_DIRNAME) {
    return { kind: 'excluded', reason: 'cache' };
  }
  return { kind: 'excluded', reason: 'not-part-of-sot' };
}

/** 遍历中被跳过的项（与 skill copy 同语义：symlink 不跟随、环路不重入）。 */
export interface SkippedTreeEntry {
  /** 绝对路径。 */
  readonly path: string;
  readonly reason: 'symlink' | 'cycle';
}

/** collectTree 结果。 */
export interface TreeListing {
  /** 相对 `root` 的 **posix** 相对路径，已排序。 */
  readonly files: string[];
  readonly skipped: SkippedTreeEntry[];
}

/** 目录去重键（win32 大小写不敏感，同 paths.samePath 语义）。 */
function pathKey(p: string, os: OsContext): string {
  const api = os.platform === 'win32' ? path.win32 : path.posix;
  const normalized = api.normalize(p);
  return os.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function lstatOrUndefined(host: Host, p: string): Promise<FileStat | undefined> {
  try {
    return await host.lstat(p);
  } catch {
    return undefined;
  }
}

/**
 * 递归列举目录下的文件（不落盘、不读内容）。
 *
 * 判类型用 **lstat**：symlink 一律跳过并记入 `skipped`。SoT 里的 symlink 可能指向
 * 家目录外的任意文件（用户自己 `ln -s` 进来的），跟随它等于把链接目标的内容打进
 * bundle 再搬到别的机器——比 skill 安装那条路径更危险，因为 bundle 会被拷来拷去。
 *
 * @param rel 当前目录相对顶层 root 的 posix 相对前缀（顶层传 `''`）。
 * @throws ConfigError(2) 层级超过 MAX_TREE_DEPTH。
 */
export async function collectTree(
  host: Host,
  os: OsContext,
  root: string,
  rel = '',
  depth = 0,
  acc?: TreeListing,
  visited?: Set<string>,
): Promise<TreeListing> {
  const listing: TreeListing = acc ?? { files: [], skipped: [] };
  const seen = visited ?? new Set<string>();
  if (depth > MAX_TREE_DEPTH) {
    throw new ConfigError(`目录层级过深（超过 ${MAX_TREE_DEPTH} 层）: ${root}`, {
      hint: '检查 SoT 目录是否存在异常嵌套（symlink 已按安全边界跳过，此处为深度兜底）',
      details: { root, depth, maxDepth: MAX_TREE_DEPTH },
    });
  }
  seen.add(pathKey(root, os));

  for (const name of [...(await listDirSafe(host, root))].sort()) {
    const abs = path.join(root, name);
    const relEntry = rel === '' ? name : `${rel}/${name}`;
    const stat = await lstatOrUndefined(host, abs);
    if (stat?.isSymbolicLink === true) {
      listing.skipped.push({ path: abs, reason: 'symlink' });
      continue;
    }
    if (stat?.isDirectory === true) {
      if (seen.has(pathKey(abs, os))) {
        listing.skipped.push({ path: abs, reason: 'cycle' });
        continue;
      }
      await collectTree(host, os, abs, relEntry, depth + 1, listing, seen);
      continue;
    }
    listing.files.push(relEntry);
  }

  listing.files.sort();
  return listing;
}

/**
 * bundle 内相对路径的安全校验（import 侧对**不可信** manifest 的守卫）。
 *
 * manifest.json 是可手工编辑的普通文件，`path` 会直接参与 `path.join(targetSoT, …)`。
 * 不校验的话 `..\..\.ssh\authorized_keys` 或 `C:\Windows\...` 就能让 import 往
 * SoT 之外写盘。三项拒绝：绝对路径（含盘符与 UNC）、任何 `..` 段、空段。
 *
 * @returns 归一化后的 posix 相对路径。
 * @throws ConfigError(2) 路径越界或形态非法。
 */
export function assertSafeBundlePath(p: string): string {
  const posix = toPosixSeparators(p);
  const segments = posix.split('/');
  const illegal =
    posix === '' ||
    posix.startsWith('/') ||
    /^[A-Za-z]:/.test(posix) ||
    segments.some((seg) => seg === '' || seg === '.' || seg === '..');
  if (illegal) {
    throw new ConfigError(`bundle 内路径非法（越界或形态错误）: ${p}`, {
      hint: 'manifest.json 的 files[].path 必须是 sot/ 下的相对路径，不得含 .. 或绝对路径',
      details: { path: p },
    });
  }
  return posix;
}
