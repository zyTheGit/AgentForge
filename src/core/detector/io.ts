/**
 * 探测器的 IO 门面（Spec §7.2：探测对坏输入一律降级为「无线索」，绝不抛错）。
 *
 * - 三个容错原语（readOptionalFile / safeExists / safeListDir）把 Host 的 reject
 *   语义收敛成 `undefined` / `false`，判定逻辑因此可以写成纯粹的「有没有线索」；
 * - DetectIo 再把「相对 cwd 的路径拼接」也包进去：各判定模块只写自己关心的相对路径
 *   （`.java-version` / `.github/workflows`），不必各自持有 cwd 与平台 path api，
 *   也就不会出现某个模块忘了走 win32 分隔符的偏差。
 */
import type { Host } from '../../infra/host';

/** 只用到 join 的 path 门面（编排层按宿主平台传 path.win32 / path.posix）。 */
export interface PathJoiner {
  join(...segments: string[]): string;
}

/** 读可选文件：不存在 / 读失败 → undefined（探测器对坏输入一律视为无线索）。 */
export async function readOptionalFile(host: Host, file: string): Promise<string | undefined> {
  try {
    if (!(await host.exists(file))) {
      return undefined;
    }
    return await host.readFile(file);
  } catch {
    return undefined;
  }
}

/** exists 容错版：抛错 → false。 */
export async function safeExists(host: Host, file: string): Promise<boolean> {
  try {
    return await host.exists(file);
  } catch {
    return false;
  }
}

/**
 * listDir 容错版：目录不存在 / 不可读 → undefined（与「存在但为空」的 `[]` 区分）。
 *
 * 目录存在性走 listDir 而非 exists：exists 对文件与目录同样返回 true，判不出
 * `.github/workflows` 是目录还是同名文件，而列目录顺手还能看到里面有没有流水线定义。
 */
export async function safeListDir(host: Host, dir: string): Promise<string[] | undefined> {
  try {
    return await host.listDir(dir);
  } catch {
    return undefined;
  }
}

/** 相对 cwd 的容错 IO 门面（路径拼接与容错都已内置）。 */
export interface DetectIo {
  /** 读 cwd 下的文件；不存在 / 读失败 → undefined。 */
  readFile(relative: string): Promise<string | undefined>;
  /** cwd 下的路径是否存在（文件或目录）；出错 → false。 */
  exists(relative: string): Promise<boolean>;
  /** 列 cwd 下的目录；不存在 / 不可读 → undefined。 */
  listDir(relative: string): Promise<string[] | undefined>;
  /** 读环境变量；取不到 → undefined。 */
  env(key: string): string | undefined;
}

/** 构造相对 `cwd` 的 IO 门面（`api` 决定分隔符语义）。 */
export function createDetectIo(host: Host, api: PathJoiner, cwd: string): DetectIo {
  return {
    readFile: (relative) => readOptionalFile(host, api.join(cwd, relative)),
    exists: (relative) => safeExists(host, api.join(cwd, relative)),
    listDir: (relative) => safeListDir(host, api.join(cwd, relative)),
    env: (key) => {
      try {
        return host.env(key);
      } catch {
        return undefined;
      }
    },
  };
}

/** env 值存在且非全空白（DetectIo 侧的环境变量线索判据）。 */
export function envHasValue(io: DetectIo, key: string): boolean {
  const value = io.env(key);
  return value !== undefined && value.trim() !== '';
}
