/**
 * 探测器纯函数集（Spec §7.2 Detect 顺序第 3/5 步：版本文件 + Shell 启发式）。
 *
 * - 版本文件解析全部为纯函数（无 IO）：内容 → 结构化线索，坏输入一律 → undefined；
 * - pyproject.toml 为简单文本级检测（只看 [tool.uv] / [tool.poetry] / [tool.pipenv]
 *   段头行），不引 TOML 库；
 * - detectShell 经 Host 读环境变量：win32 用 ComSpec/PSModulePath 启发式，
 *   非 win32 用 $SHELL basename。
 */
import type { Host } from '../../infra/host';

/** habits.tools.shell 枚举值（Spec §4.1；与 schema/habits.ts Shell 对齐，单测做兼容校验）。 */
export type ShellName =
  | 'powershell'
  | 'pwsh'
  | 'cmd'
  | 'zsh'
  | 'bash'
  | 'fish'
  | 'nushell'
  | 'other';

/** package.json#packageManager 解析结果（如 "pnpm@9.1.0"）。 */
export interface PackageManagerField {
  readonly manager: string;
  readonly version: string | undefined;
}

/** pyproject.toml 文本级 [tool.*] 段线索。 */
export type PythonManagerClue = 'uv' | 'poetry' | 'pipenv';

/**
 * 取首个非空、非 `#` 注释行并剥掉 v 前缀
 * （.node-version / .python-version / .java-version 共用）。
 */
export function parseFirstVersionLine(content: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const version = line.replace(/^v/i, '');
    return version === '' ? undefined : version;
  }
  return undefined;
}

/** .node-version → 版本字符串（如 "22.11.0"；"v22.11.0" → "22.11.0"）。空/坏内容 → undefined。 */
export function parseNodeVersionFile(content: string): string | undefined {
  return parseFirstVersionLine(content);
}

/** .python-version → 版本字符串（如 "3.12"）。空/坏内容 → undefined。 */
export function parsePythonVersionFile(content: string): string | undefined {
  return parseFirstVersionLine(content);
}

/**
 * package.json#packageManager → { manager, version }（Spec §7.2 第 3 步）。
 * 如 "pnpm@9.1.0" → {manager:"pnpm", version:"9.1.0"}；"npm" → {manager:"npm", version:undefined}。
 * 非法 JSON / 无字段 / 非字符串值 → undefined；corepack 完整性后缀（+sha256-...）剥掉。
 */
export function parsePackageJsonManager(content: string): PackageManagerField | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const field = (parsed as Record<string, unknown>).packageManager;
  if (typeof field !== 'string' || field.trim() === '') {
    return undefined;
  }

  const value = field.trim();
  const at = value.lastIndexOf('@');
  if (at < 1) {
    return { manager: value, version: undefined };
  }
  const rawVersion = value.slice(at + 1).split('+')[0] ?? '';
  return { manager: value.slice(0, at), version: rawVersion === '' ? undefined : rawVersion };
}

/** pyproject 段头优先级（uv 最现代，优先于 poetry/pipenv）。 */
const PYPROJECT_CLUE_PRIORITY: readonly PythonManagerClue[] = ['uv', 'poetry', 'pipenv'];

/** [tool.uv] / [tool.uv.workspace] 等段头（含子表：TOML 子表隐含父表存在）。 */
const PYPROJECT_SECTION_RE = /^\s*\[tool\.(uv|poetry|pipenv)(?:\.|\])/;

/**
 * pyproject.toml → python manager 线索（文本级，不解析 TOML）。
 * 段存在性检测：[tool.uv] / [tool.poetry] / [tool.pipenv]（含其子表）；
 * 多段同时存在按 uv > poetry > pipenv 取；无 → undefined。
 */
export function parsePyproject(content: string): PythonManagerClue | undefined {
  const found = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const m = PYPROJECT_SECTION_RE.exec(line);
    if (m !== null && m[1] !== undefined) {
      found.add(m[1]);
    }
  }
  return PYPROJECT_CLUE_PRIORITY.find((clue) => found.has(clue));
}

/** env 值存在且非全空白。 */
function envPresent(host: Host, key: string): boolean {
  const value = host.env(key);
  return value !== undefined && value.trim() !== '';
}

/** SHELL basename → 枚举映射（win32 上 Git Bash/MSYS 也会导出 SHELL，是强信号）。 */
function shellFromShellEnv(host: Host): ShellName | undefined {
  const shell = host.env('SHELL');
  if (shell === undefined || shell.trim() === '') {
    return undefined;
  }
  const base =
    shell
      .trim()
      .split(/[\\/]+/)
      .filter((s) => s !== '')
      .pop() ?? '';
  switch (base.toLowerCase()) {
    case 'zsh':
      return 'zsh';
    case 'bash':
      return 'bash';
    case 'fish':
      return 'fish';
    case 'nu':
      return 'nushell';
    default:
      return 'other';
  }
}

/**
 * Shell 启发式（Spec §7.2 第 5 步，写入 habits.tools.shell）：
 * - SHELL 存在（Git Bash/MSYS 或类 Unix）→ basename 映射（zsh/bash/fish/nushell/other）；
 * - win32：POWERSHELL_DISTRIBUTION_CHANNEL → pwsh（PowerShell 7 导出，5.1 不导出）；
 *   PSModulePath → powershell；ComSpec 含 cmd.exe → cmd；其余 → other；
 *   （已知局限：PSModulePath 是系统级变量，cmd 会话下也可能存在，属启发式取舍）；
 * - 非 win32 且无 SHELL → other。
 */
export function detectShell(host: Host, os: string): ShellName {
  const fromShellEnv = shellFromShellEnv(host);
  if (fromShellEnv !== undefined) {
    return fromShellEnv;
  }

  if (os === 'win32') {
    if (envPresent(host, 'POWERSHELL_DISTRIBUTION_CHANNEL')) {
      return 'pwsh';
    }
    if (envPresent(host, 'PSModulePath')) {
      return 'powershell';
    }
    const comSpec = host.env('ComSpec') ?? host.env('COMSPEC');
    if (comSpec !== undefined && /cmd\.exe$/i.test(comSpec.trim())) {
      return 'cmd';
    }
    return 'other';
  }
  return 'other';
}
