/**
 * java / dotnet 探测（Spec §7.2 Detect 顺序，runtime 形态）。
 *
 * 与 node/python 同构：PATH 上的版本管理器优先，其次版本文件线索，再退到本体
 * 可执行文件推断 `system`，什么都没有 → `none`。两处生态差异值得单独说明：
 *
 * - **sdkman 在 PATH 上没有本体**：`sdk` 是 sdkman-init.sh 注入的 shell 函数，
 *   零进程扫描永远扫不到它。故 sdkman 只能靠 `.sdkmanrc`（项目级钉版本文件）
 *   或 `SDKMAN_DIR` 环境变量判定，后者对应的 source 记为 `env`；
 * - **dotnet 没有第三方版本管理器生态**：SDK 版本由 `global.json` 钉、由 `dotnet`
 *   本体自己切，因此 manager 只可能是 `system` / `none`，不设候选优先级。
 */
import type { DetectIo } from './io';
import { envHasValue } from './io';
import { parseFirstVersionLine } from './probes';
import type { DetectedRuntime } from './types';

/** PATH 上有同名可执行文件的 java 版本管理器（按命中优先级）。 */
const JAVA_PATH_MANAGERS = ['jenv', 'jabba', 'mise', 'asdf'] as const;

/** java 版本管理器候选优先级（sdkman 居首，但只能靠文件/env 判，见文件头注释）。 */
export const JAVA_MANAGER_PRIORITY = ['sdkman', ...JAVA_PATH_MANAGERS] as const;

/** java/dotnet 探测需要并入一次性 PATH 扫描的可执行名（含两个本体）。 */
export const RUNTIME_SCAN_NAMES: readonly string[] = [
  ...JAVA_PATH_MANAGERS,
  'java',
  'javac',
  'dotnet',
];

/** jenv / asdf / mise 共用的 java 版本文件。 */
const JAVA_VERSION_FILE = '.java-version';

/** sdkman 的项目级钉版本文件（`java=21.0.2-tem` 形式的 key=value）。 */
const SDKMANRC_FILE = '.sdkmanrc';

/** dotnet SDK 钉版本文件（`{"sdk":{"version":"8.0.100"}}`）。 */
const GLOBAL_JSON_FILE = 'global.json';

/** `.java-version` → 版本字符串（`v21` → `21`）。空/坏内容 → undefined。 */
export function parseJavaVersionFile(content: string): string | undefined {
  return parseFirstVersionLine(content);
}

/** `.sdkmanrc` 的 `java=<identifier>` 行（`#` 注释与其他键忽略；值必须以非空白起头）。 */
const SDKMANRC_JAVA_RE = /^\s*java\s*=\s*(\S.*?)\s*$/i;

/**
 * `.sdkmanrc` → java 版本标识（如 `21.0.2-tem`）。
 *
 * 刻意**不**剥 `v` 前缀、不做归一化：sdkman 的 identifier 是「版本-发行商」整体
 * （`21.0.2-tem` / `17.0.9-graalce`），截断任一段都会得到一个不存在的候选版本。
 * 无 `java=` 行（只钉了 maven/gradle）→ undefined。
 */
export function parseSdkmanrcJava(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) {
      continue;
    }
    const matched = SDKMANRC_JAVA_RE.exec(line);
    const value = matched?.[1];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

/**
 * `global.json` → `sdk.version`（非法 JSON / 无 sdk 段 / 非字符串值 → undefined）。
 *
 * 注意「解析不出版本」与「文件不存在」是两件事：前者仍是一条 dotnet 线索
 * （只钉了 `msbuild-sdks` 的 global.json 也说明这是 dotnet 项目），故调用方按
 * 文件是否存在判线索、按本函数结果填 version。
 */
export function parseGlobalJsonSdkVersion(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const sdk = (parsed as Record<string, unknown>).sdk;
  if (typeof sdk !== 'object' || sdk === null) {
    return undefined;
  }
  const version = (sdk as Record<string, unknown>).version;
  if (typeof version !== 'string' || version.trim() === '') {
    return undefined;
  }
  return version.trim();
}

/** java 的文件 / env 线索（由 probeRuntimes 汇总，detectJava 只做判定）。 */
export interface JavaClues {
  /** `.java-version` 优先，回落 `.sdkmanrc` 的 `java=`；都解析不出 → undefined。 */
  readonly version: string | undefined;
  /** `.java-version` 或 `.sdkmanrc` 存在（内容坏也算线索）。 */
  readonly hasVersionFile: boolean;
  /** `.sdkmanrc` 存在（sdkman 的强信号）。 */
  readonly hasSdkmanrc: boolean;
  /** `SDKMAN_DIR` 环境变量非空（sdkman 已 init 过当前 shell）。 */
  readonly hasSdkmanDir: boolean;
}

/**
 * Java 探测：sdkman（`.sdkmanrc` / `SDKMAN_DIR`）> jenv > jabba > mise > asdf（PATH）
 * > 版本文件交叉（java/javac 在 PATH 则推断 system）> java 本体 → system > none。
 */
export function detectJava(hits: ReadonlyMap<string, string>, clues: JavaClues): DetectedRuntime {
  // 本体路径：优先 java（运行时），仅装 JDK 而 java 不在 PATH 时退 javac
  const javaPath = hits.get('java') ?? hits.get('javac');

  if (clues.hasSdkmanrc || clues.hasSdkmanDir) {
    return {
      manager: 'sdkman',
      source: clues.hasSdkmanrc ? 'version-file' : 'env',
      version: clues.version,
      path: javaPath,
    };
  }

  const manager = JAVA_PATH_MANAGERS.find((m) => hits.has(m));
  if (manager !== undefined) {
    return { manager, source: 'path', version: clues.version, path: hits.get(manager) };
  }

  if (clues.hasVersionFile) {
    return {
      manager: javaPath !== undefined ? 'system' : 'none',
      source: 'version-file',
      version: clues.version,
      path: javaPath,
    };
  }

  if (javaPath !== undefined) {
    return { manager: 'system', source: 'path', path: javaPath };
  }
  return { manager: 'none', source: 'none' };
}

/** dotnet 的文件线索。 */
export interface DotnetClues {
  /** `global.json` 的 `sdk.version`（解析不出 → undefined）。 */
  readonly version: string | undefined;
  /** `global.json` 存在（内容坏也算线索）。 */
  readonly hasGlobalJson: boolean;
}

/**
 * .NET 探测：`global.json` 存在 → version-file（dotnet 本体在 PATH 则 system，
 * 否则 none）；仅 dotnet 本体 → system；都无 → none。manager 无第三方候选。
 */
export function detectDotnet(
  hits: ReadonlyMap<string, string>,
  clues: DotnetClues,
): DetectedRuntime {
  const dotnetPath = hits.get('dotnet');
  if (clues.hasGlobalJson) {
    return {
      manager: dotnetPath !== undefined ? 'system' : 'none',
      source: 'version-file',
      version: clues.version,
      path: dotnetPath,
    };
  }
  if (dotnetPath !== undefined) {
    return { manager: 'system', source: 'path', path: dotnetPath };
  }
  return { manager: 'none', source: 'none' };
}

export interface RuntimeProbeResult {
  readonly java: DetectedRuntime;
  readonly dotnet: DetectedRuntime;
}

/** 读齐 java/dotnet 的文件与 env 线索（并行、全容错）后交给两个判定函数。 */
export async function probeRuntimes(
  io: DetectIo,
  hits: ReadonlyMap<string, string>,
): Promise<RuntimeProbeResult> {
  const [javaVersionContent, sdkmanrcContent, globalJsonContent] = await Promise.all([
    io.readFile(JAVA_VERSION_FILE),
    io.readFile(SDKMANRC_FILE),
    io.readFile(GLOBAL_JSON_FILE),
  ]);

  const javaVersion =
    javaVersionContent !== undefined ? parseJavaVersionFile(javaVersionContent) : undefined;
  const sdkmanVersion =
    sdkmanrcContent !== undefined ? parseSdkmanrcJava(sdkmanrcContent) : undefined;

  return {
    java: detectJava(hits, {
      version: javaVersion ?? sdkmanVersion,
      hasVersionFile: javaVersionContent !== undefined || sdkmanrcContent !== undefined,
      hasSdkmanrc: sdkmanrcContent !== undefined,
      hasSdkmanDir: envHasValue(io, 'SDKMAN_DIR'),
    }),
    dotnet: detectDotnet(hits, {
      version:
        globalJsonContent !== undefined ? parseGlobalJsonSdkVersion(globalJsonContent) : undefined,
      hasGlobalJson: globalJsonContent !== undefined,
    }),
  };
}
