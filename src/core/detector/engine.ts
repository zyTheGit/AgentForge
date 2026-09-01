/**
 * 探测引擎（Spec §7.2 Detect 顺序编排；PRD §8 L2：探测准确率 ≥90%）。
 *
 * 编排顺序：
 * 1. PATH 零进程扫描（path-scan）：node/python 版本管理器候选、包管理器、
 *    rust/go 工具链、java 版本管理器、monorepo 工具、各语言本体（→ system 推断）；
 * 2. 版本文件交叉（probes / probes-runtime）：.node-version / .python-version /
 *    package.json#packageManager / pyproject.toml / .java-version / .sdkmanrc /
 *    global.json；
 * 3. 工作区配置文件（probes-workspace）：monorepo 配置与 CI 流水线定义；
 * 4. 现有规则文件：cwd 下 AGENTS.md / CLAUDE.md 存在性；
 * 5. Shell 启发式（probes.detectShell）。
 *
 * 产出 DetectedSnapshot——结构即 habits.detected 的内容（Spec §4.1 passthrough）。
 * 已有 habits.yaml 声明时不覆盖声明：声明优先在 generator/init 层处理，本引擎只产 detected。
 *
 * 模块边界：本文件只做编排与 node/python/包管理器/rust/go 的判定；java/dotnet 判定在
 * probes-runtime，monorepo/ci 判定在 probes-workspace，快照类型在 types，容错 IO 在 io。
 * 类型与 runDetection 仍从这里 re-export，`core/detector/engine` 的 import 路径不变。
 *
 * 探测候选枚举在此局部定义（不 import schema，避免 core 运行时依赖 zod），
 * 与 schema/habits.ts 枚举的一致性由单测校验。
 */
import path from 'node:path';
import { createDetectIo, readOptionalFile, safeExists } from './io';
import { scanPath } from './path-scan';
import {
  detectShell,
  type PackageManagerField,
  parseNodeVersionFile,
  parsePackageJsonManager,
  parsePyproject,
  parsePythonVersionFile,
} from './probes';
import { probeRuntimes, RUNTIME_SCAN_NAMES } from './probes-runtime';
import { probeWorkspace, WORKSPACE_SCAN_NAMES } from './probes-workspace';
import type {
  DetectContext,
  DetectedPackageManager,
  DetectedRuntime,
  DetectedSnapshot,
  DetectedTool,
} from './types';

export { JAVA_MANAGER_PRIORITY } from './probes-runtime';
export { CI_PROVIDER_PRIORITY, MONOREPO_TOOL_PRIORITY } from './probes-workspace';
export type {
  DetectContext,
  DetectedPackageManager,
  DetectedRuntime,
  DetectedSnapshot,
  DetectedTool,
  DetectionSource,
} from './types';

/** Node 版本管理器 PATH 命中优先级（Spec §7.2）。 */
export const NODE_MANAGER_PRIORITY = ['fnm', 'nvm', 'volta', 'mise', 'asdf', 'n'] as const;

/** Python 工具链 PATH 命中优先级（mise 为通用 runtime manager，排最后）。 */
export const PYTHON_MANAGER_PRIORITY = [
  'uv',
  'poetry',
  'pipenv',
  'conda',
  'pyenv',
  'mise',
] as const;

/** 包管理器 PATH 命中优先级（Spec §4.1 runtime.package_managers 惯例顺序）。 */
export const PACKAGE_MANAGER_PRIORITY = ['pnpm', 'bun', 'npm', 'yarn'] as const;

/** 一次 PATH 扫描覆盖的全部可执行名（去重；零进程派生，每目录只 listDir 一次）。 */
const SCAN_NAMES: readonly string[] = [
  ...new Set<string>([
    ...NODE_MANAGER_PRIORITY,
    ...PYTHON_MANAGER_PRIORITY,
    'node',
    'python',
    ...PACKAGE_MANAGER_PRIORITY,
    'rustup',
    'cargo',
    'go',
    ...RUNTIME_SCAN_NAMES,
    ...WORKSPACE_SCAN_NAMES,
  ]),
];

/**
 * Node 探测：PATH manager 命中（优先级序）→ path；否则版本文件交叉
 * （.node-version 给出 version，node 本体在 PATH 则推断 system）；再否则 node 本体 → system。
 */
function detectNode(
  hits: ReadonlyMap<string, string>,
  versionFile: string | undefined,
): DetectedRuntime {
  const manager = NODE_MANAGER_PRIORITY.find((m) => hits.has(m));
  if (manager !== undefined) {
    return { manager, source: 'path', version: versionFile, path: hits.get(manager) };
  }
  const nodePath = hits.get('node');
  if (versionFile !== undefined) {
    return {
      manager: nodePath !== undefined ? 'system' : 'none',
      source: 'version-file',
      version: versionFile,
      path: nodePath,
    };
  }
  if (nodePath !== undefined) {
    return { manager: 'system', source: 'path', path: nodePath };
  }
  return { manager: 'none', source: 'none' };
}

/**
 * Python 探测：PATH manager 命中（uv > poetry > pipenv > conda > pyenv > mise）→ path；
 * 否则 pyproject.toml [tool.*] 段线索；否则 .python-version 交叉；再否则 python 本体 → system。
 */
function detectPython(
  hits: ReadonlyMap<string, string>,
  versionFile: string | undefined,
  pyprojectClue: string | undefined,
): DetectedRuntime {
  const manager = PYTHON_MANAGER_PRIORITY.find((m) => hits.has(m));
  if (manager !== undefined) {
    return { manager, source: 'path', version: versionFile, path: hits.get(manager) };
  }
  if (pyprojectClue !== undefined) {
    return { manager: pyprojectClue, source: 'pyproject', version: versionFile };
  }
  const pythonPath = hits.get('python');
  if (versionFile !== undefined) {
    return {
      manager: pythonPath !== undefined ? 'system' : 'none',
      source: 'version-file',
      version: versionFile,
      path: pythonPath,
    };
  }
  if (pythonPath !== undefined) {
    return { manager: 'system', source: 'path', path: pythonPath };
  }
  return { manager: 'none', source: 'none' };
}

/** yarn 主版本 ≥2 → berry（yarn-berry），否则原样。 */
function yarnMajorIsBerry(version: string | undefined): boolean {
  if (version === undefined) {
    return false;
  }
  const major = /^(\d+)/.exec(version.trim())?.[1];
  return major !== undefined && Number.parseInt(major, 10) >= 2;
}

/** package.json#packageManager 声明 → 快照用的包管理器名（非枚举值 → undefined）。 */
function declaredPackageManagerName(field: PackageManagerField): string | undefined {
  if (field.manager === 'yarn') {
    return yarnMajorIsBerry(field.version) ? 'yarn-berry' : 'yarn';
  }
  return (PACKAGE_MANAGER_PRIORITY as readonly string[]).includes(field.manager)
    ? field.manager
    : undefined;
}

/**
 * 包管理器探测：PATH 命中按 pnpm > bun > npm > yarn 排序；
 * package.json#packageManager 声明优先置首（yarn-berry 复用 yarn 的 PATH 命中路径）。
 */
function detectPackageManagers(
  hits: ReadonlyMap<string, string>,
  declaredField: PackageManagerField | undefined,
): DetectedPackageManager[] {
  const fromPath: DetectedPackageManager[] = PACKAGE_MANAGER_PRIORITY.filter((m) =>
    hits.has(m),
  ).map((m) => ({ name: m, source: 'path' as const, path: hits.get(m) }));

  const declaredName =
    declaredField === undefined ? undefined : declaredPackageManagerName(declaredField);
  if (declaredName === undefined) {
    return fromPath;
  }

  const hitName = declaredName === 'yarn-berry' ? 'yarn' : declaredName;
  const rest = fromPath.filter((p) => p.name !== hitName);
  const declared: DetectedPackageManager = {
    name: declaredName,
    source: 'package.json',
    path: hits.get(hitName),
  };
  return [declared, ...rest];
}

/** Rust 探测：rustup 在 PATH → rustup；仅 cargo → system（直装工具链）；都无 → none。 */
function detectRust(hits: ReadonlyMap<string, string>): DetectedTool {
  const rustup = hits.get('rustup');
  if (rustup !== undefined) {
    return { manager: 'rustup', source: 'path', path: rustup };
  }
  const cargo = hits.get('cargo');
  if (cargo !== undefined) {
    return { manager: 'system', source: 'path', path: cargo };
  }
  return { manager: 'none', source: 'none' };
}

/** Go 探测：go 在 PATH → system（不臆断 goenv/asdf/mise 托管）；无 → none。 */
function detectGo(hits: ReadonlyMap<string, string>): DetectedTool {
  const go = hits.get('go');
  if (go !== undefined) {
    return { manager: 'system', source: 'path', path: go };
  }
  return { manager: 'none', source: 'none' };
}

/**
 * 运行探测（Spec §7.2 顺序编排），产出 habits.detected 快照。
 * 全程零子进程派生、零网络；对坏环境（缺 PATH / 目录不可读 / 坏版本文件）
 * 一律降级为"未检出"，不抛错。
 */
export async function runDetection(ctx: DetectContext): Promise<DetectedSnapshot> {
  const win32 = ctx.os === 'win32';
  const api = win32 ? path.win32 : path.posix;
  const io = createDetectIo(ctx.host, api, ctx.cwd);

  // 1. PATH 零进程扫描（一次覆盖全部探测名）
  const hits = await scanPath(ctx.host, SCAN_NAMES, { platform: ctx.os, cwd: ctx.cwd });

  // 2. 版本文件与工作区判据并行读取（IO 全部容错）
  const [
    nodeVersionContent,
    pythonVersionContent,
    packageJsonContent,
    pyprojectContent,
    agentsMd,
    claudeMd,
    runtimes,
    workspace,
  ] = await Promise.all([
    readOptionalFile(ctx.host, api.join(ctx.cwd, '.node-version')),
    readOptionalFile(ctx.host, api.join(ctx.cwd, '.python-version')),
    readOptionalFile(ctx.host, api.join(ctx.cwd, 'package.json')),
    readOptionalFile(ctx.host, api.join(ctx.cwd, 'pyproject.toml')),
    safeExists(ctx.host, api.join(ctx.cwd, 'AGENTS.md')),
    safeExists(ctx.host, api.join(ctx.cwd, 'CLAUDE.md')),
    probeRuntimes(io, hits),
    probeWorkspace(io, hits),
  ]);

  const nodeVersion =
    nodeVersionContent !== undefined ? parseNodeVersionFile(nodeVersionContent) : undefined;
  const pythonVersion =
    pythonVersionContent !== undefined ? parsePythonVersionFile(pythonVersionContent) : undefined;
  const declaredField =
    packageJsonContent !== undefined ? parsePackageJsonManager(packageJsonContent) : undefined;
  const pyprojectClue =
    pyprojectContent !== undefined ? parsePyproject(pyprojectContent) : undefined;

  // 3. 现有规则文件（固定顺序）
  const existingRules = [agentsMd ? 'AGENTS.md' : '', claudeMd ? 'CLAUDE.md' : ''].filter(
    (name) => name !== '',
  );

  return {
    node: detectNode(hits, nodeVersion),
    python: detectPython(hits, pythonVersion, pyprojectClue),
    package_managers: detectPackageManagers(hits, declaredField),
    shell: detectShell(ctx.host, ctx.os),
    existing_rules: existingRules,
    rust: detectRust(hits),
    go: detectGo(hits),
    java: runtimes.java,
    dotnet: runtimes.dotnet,
    monorepo: workspace.monorepo,
    ci: workspace.ci,
  };
}
