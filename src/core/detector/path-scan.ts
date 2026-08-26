/**
 * PATH 零进程扫描（Spec §7.2 Detect 顺序第 2 步；PRD §8 L2 性能优先路径）。
 *
 * - 不派生任何子进程：解析 PATH → 每个目录 listDir 一次 → 名字 + PATHEXT 展开做内存匹配；
 * - Windows：PATH 以 `;` 分隔、文件名大小写不敏感、按 PATHEXT（默认 .COM;.EXE;.BAT;.CMD）
 *   展开可执行名（如 fnm 命中 fnm.exe / fnm.cmd / fnm.bat）；
 * - 类 Unix：PATH 以 `:` 分隔、精确匹配无扩展名文件（大小写敏感）；
 * - PATH 靠前的目录优先（第一个命中即定，与 where.exe 语义一致）；
 * - 目录不存在 / 不可读 → 跳过该目录（约定不抛错）；
 * - node:path 为纯计算模块，允许直接使用（与 core/paths.ts 同约定）。
 */
import path from 'node:path';
import type { Host } from '../../infra/host';

/** Windows 默认 PATHEXT（真实环境优先读 PATHEXT 变量，缺失/为空时兜底）。 */
const DEFAULT_PATHEXT = ['.com', '.exe', '.bat', '.cmd'];

export interface PathScanOptions {
  /** 平台（process.platform 值）；仅 'win32' 走 Windows 语义，其余按 posix。 */
  readonly platform?: string;
  /** 相对 PATH 条目绝对化的基准目录（探测引擎传 cwd；缺省时相对条目原样保留）。 */
  readonly cwd?: string;
}

/** 剥离 PATH 条目首尾引号（注册表中的 "C:\Program Files\..." 形式）。 */
function stripQuotes(dir: string): string {
  if (
    dir.length >= 2 &&
    ((dir.startsWith('"') && dir.endsWith('"')) || (dir.startsWith("'") && dir.endsWith("'")))
  ) {
    return dir.slice(1, -1);
  }
  return dir;
}

/** 解析 PATHEXT：`;` 分隔、补 `.` 前缀、小写化；未设置/解析为空 → 默认值。 */
function parsePathExt(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [...DEFAULT_PATHEXT];
  }
  const exts = raw
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== '')
    .map((e) => (e.startsWith('.') ? e : `.${e}`));
  return exts.length > 0 ? exts : [...DEFAULT_PATHEXT];
}

/**
 * 扫描 PATH 上的一组可执行名，返回 name → 解析出的绝对路径。
 *
 * 性能关键路径：每个 PATH 目录只 listDir 一次，全部待查名字在内存索引上匹配；
 * 命中后即从待查集合移除，pending 为空时提前终止遍历。
 * 解析路径保留磁盘上的真实文件名（win32 大小写不敏感匹配但路径用原名）。
 */
export async function scanPath(
  host: Host,
  execNames: readonly string[],
  opts: PathScanOptions = {},
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const pending = new Set(execNames.map((n) => n.trim()).filter((n) => n !== ''));
  if (pending.size === 0) {
    return resolved;
  }

  const win32 = opts.platform === 'win32';
  const api = win32 ? path.win32 : path.posix;

  const pathValue = host.env('PATH');
  if (pathValue === undefined || pathValue.trim() === '') {
    return resolved;
  }

  const pathExt = win32 ? parsePathExt(host.env('PATHEXT')) : [];

  for (const rawDir of pathValue.split(win32 ? ';' : ':')) {
    if (pending.size === 0) {
      break;
    }

    let dir = stripQuotes(rawDir.trim());
    if (dir === '') {
      continue;
    }
    // 相对 PATH 条目（罕见，如 shims 目录相对引用）按 cwd 绝对化
    if (opts.cwd !== undefined && !api.isAbsolute(dir)) {
      dir = api.resolve(opts.cwd, dir);
    }

    let entries: string[];
    try {
      entries = await host.listDir(dir);
    } catch {
      // 目录不存在 / 不可读 → 跳过（约定不抛错）
      continue;
    }

    if (win32) {
      // 大小写不敏感索引：小写文件名 → 磁盘原名
      const entryIndex = new Map<string, string>();
      for (const entry of entries) {
        entryIndex.set(entry.toLowerCase(), entry);
      }
      for (const name of pending) {
        for (const ext of pathExt) {
          const hit = entryIndex.get(`${name.toLowerCase()}${ext}`);
          if (hit !== undefined) {
            resolved.set(name, api.resolve(dir, hit));
            pending.delete(name);
            break;
          }
        }
      }
    } else {
      const entrySet = new Set(entries);
      for (const name of pending) {
        if (entrySet.has(name)) {
          resolved.set(name, api.resolve(dir, name));
          pending.delete(name);
        }
      }
    }
  }

  return resolved;
}
