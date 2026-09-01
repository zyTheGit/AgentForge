/**
 * 导入文件识别表（Spec §7.7-2 的 Phase 2 扩展）：把"哪些文件算既有规则文件"
 * 收敛成一张声明式规则表（单一事实源），新增工具只加一行数据。
 *
 * 设计要点：
 * 1. 判据分两类——basename 精确匹配、扩展名 + 父目录约束；
 *    `.cursor/rules/*.mdc`、`.github/copilot-instructions.md` 这类靠 basename
 *    分不开的必须带父目录判据（`copilot-instructions.md` 单独躺在仓库根不算）；
 * 2. 全部比较在小写化后的 posix 段上做（大小写不敏感、分隔符跨平台安全，
 *    路径切段一律走 core/paths 的 toPosixSeparators，不手写 `\\` 拼接）；
 * 3. `ImportFileKind` 由表派生，新增一行数据即自动进类型；
 * 4. 报错 hint 也由表派生（supportedImportFileHint），不会与实现漂移。
 *
 * 本模块零 IO：只做路径字符串判定，不检查文件是否存在。
 */
import { toPosixSeparators } from '../paths';

/**
 * 单条识别规则的判据（至少要给 basename 或 extension 之一，否则会命中一切）。
 *
 * - basename：末段小写全等；
 * - extension：末段以该后缀结尾（且末段不等于后缀本身，避免把 `.mdc` 当文件名）；
 * - parentDirs：紧邻父目录段序列（自上而下），要求祖先段以它结尾；
 * - nestedUnderParents：放开"紧邻"约束——parentDirs 只需作为祖先段的连续子序列
 *   出现（Cursor 支持 `.cursor/rules/<子目录>/x.mdc` 这种嵌套摆法）。
 */
export interface ImportFileRule {
  /** 类型标识（同时是人类可读的展示名与 hint 里的条目）。 */
  readonly kind: string;
  /** 来源工具名（打印与文档用）。 */
  readonly tool: string;
  readonly basename?: string;
  readonly extension?: string;
  readonly parentDirs?: readonly string[];
  readonly nestedUnderParents?: boolean;
}

/**
 * 可识别的导入文件全集（顺序 = hint 里的展示顺序；带路径判据的排在前面，
 * 便于阅读时先看到"不只看 basename"的特例）。
 *
 * 判据里的字面量一律小写：匹配前会把路径段小写化。
 */
export const IMPORT_FILE_RULES = [
  { kind: 'AGENTS.md', tool: 'agents.md 约定（opencode / codex / pi 等）', basename: 'agents.md' },
  { kind: 'CLAUDE.md', tool: 'Claude Code', basename: 'claude.md' },
  { kind: 'GEMINI.md', tool: 'Gemini CLI', basename: 'gemini.md' },
  { kind: 'opencode.md', tool: 'opencode', basename: 'opencode.md' },
  { kind: '.cursorrules', tool: 'Cursor（旧版单文件）', basename: '.cursorrules' },
  {
    kind: '.cursor/rules/*.mdc',
    tool: 'Cursor（新版规则目录）',
    extension: '.mdc',
    parentDirs: ['.cursor', 'rules'],
    nestedUnderParents: true,
  },
  { kind: '.windsurfrules', tool: 'Windsurf', basename: '.windsurfrules' },
  {
    kind: '.github/copilot-instructions.md',
    tool: 'GitHub Copilot',
    basename: 'copilot-instructions.md',
    parentDirs: ['.github'],
  },
] as const satisfies readonly ImportFileRule[];

/** 支持导入的文件类型（由 IMPORT_FILE_RULES 派生，§7.7-2）。 */
export type ImportFileKind = (typeof IMPORT_FILE_RULES)[number]['kind'];

/** 路径切段结果：末段 + 祖先段，全部已小写化。 */
interface PathSegments {
  readonly base: string;
  readonly ancestors: readonly string[];
}

/** 拆成小写 posix 段（空段剔除；`C:\a\B.md` 与 `/a/B.md` 走同一条路径）。 */
function splitPathSegments(filePath: string): PathSegments {
  const segments = toPosixSeparators(filePath)
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => segment.toLowerCase());
  const base = segments.pop() ?? '';
  return { base, ancestors: segments };
}

/** 祖先段是否满足父目录判据（nested 时放开"紧邻"约束）。 */
function ancestorsMatch(
  ancestors: readonly string[],
  parentDirs: readonly string[],
  nested: boolean,
): boolean {
  if (parentDirs.length > ancestors.length) {
    return false;
  }
  if (!nested) {
    const tail = ancestors.slice(ancestors.length - parentDirs.length);
    return parentDirs.every((dir, i) => tail[i] === dir);
  }
  for (let start = 0; start + parentDirs.length <= ancestors.length; start += 1) {
    if (parentDirs.every((dir, i) => ancestors[start + i] === dir)) {
      return true;
    }
  }
  return false;
}

/** 单条规则是否命中（各判据取与）。 */
function ruleMatches(rule: ImportFileRule, seg: PathSegments): boolean {
  if (rule.basename !== undefined && seg.base !== rule.basename) {
    return false;
  }
  if (
    rule.extension !== undefined &&
    (seg.base === rule.extension || !seg.base.endsWith(rule.extension))
  ) {
    return false;
  }
  if (
    rule.parentDirs !== undefined &&
    !ancestorsMatch(seg.ancestors, rule.parentDirs, rule.nestedUnderParents === true)
  ) {
    return false;
  }
  return true;
}

/**
 * 按路径识别导入类型（大小写不敏感；带父目录判据的规则需要完整路径，
 * 只传 basename 会识别不出 `.cursor/rules/*.mdc` 与 `.github/copilot-instructions.md`）。
 *
 * 无命中 → undefined（命令层据此报 ConfigError(2)）。
 */
export function identifyImportFile(filePath: string): ImportFileKind | undefined {
  const seg = splitPathSegments(filePath);
  if (seg.base === '') {
    return undefined;
  }
  return IMPORT_FILE_RULES.find((rule) => ruleMatches(rule, seg))?.kind;
}

/** 命中规则的来源工具名（打印摘要用）；未命中 → undefined。 */
export function importFileTool(kind: ImportFileKind): string | undefined {
  return IMPORT_FILE_RULES.find((rule) => rule.kind === kind)?.tool;
}

/** 支持的文件名全集（hint / 文档共用，顺序同表）。 */
export function supportedImportFileKinds(): readonly ImportFileKind[] {
  return IMPORT_FILE_RULES.map((rule) => rule.kind);
}

/** 不支持的文件名时的报错 hint：列出当前支持的全集。 */
export function supportedImportFileHint(): string {
  return `支持的文件（大小写不敏感）：${supportedImportFileKinds().join(' / ')}；带目录前缀的需要放在对应目录下`;
}
