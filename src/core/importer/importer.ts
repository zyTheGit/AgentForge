/**
 * Import 解析器（Spec §7.7 MVP 基础版，M9）：从既有 AGENTS.md / CLAUDE.md
 * 提取工具链声明与剩余内容块。
 *
 * 纯函数模块（零 IO、不依赖 TTY）：
 * 1. identifyImportFile：按文件名识别 AGENTS.md / CLAUDE.md（大小写不敏感）；
 * 2. parseImportedFile：剥除全部 AgentForge marker 区间（§7.7-7）→ 按 `## `
 *    标题分块（§7.7-3）→ 工具链关键词识别（词边界匹配，避免 uvicorn 误报 uv）；
 * 3. 映射产出：
 *    - 命中工具链关键词的块 → habits.detected.import 建议字段
 *      （source: 'import'，需用户确认，§7.7-4）；
 *    - 其余块 → custom/imported-<timestamp>.md 素材（原样保留各块标题）。
 *
 * 关键词命中即建议（可能包含 forbid 语句中的否定式提及）——Spec 定位为
 * "suggested，需用户确认"，噪声由人工核对 habits.yaml 消化。
 */
import { normalizeLineEnding } from '../../infra/fsutil';
import { splitByMarkers } from '../markers';
import { toPosixSeparators } from '../paths';

/** Node 版本管理器关键词（§7.7-3；命中顺序即优先级序）。 */
export const NODE_MANAGER_KEYWORDS = ['fnm', 'nvm', 'volta', 'mise'] as const;

/** Python 工具链关键词（§7.7-3）。 */
export const PYTHON_MANAGER_KEYWORDS = ['uv', 'poetry', 'pipenv', 'conda', 'pyenv'] as const;

/** JS 包管理器关键词（§7.7-3）。 */
export const PACKAGE_MANAGER_KEYWORDS = ['pnpm', 'bun', 'npm', 'yarn'] as const;

/** 全部关键词（块级命中判定用）。 */
const ALL_KEYWORDS: readonly string[] = [
  ...NODE_MANAGER_KEYWORDS,
  ...PYTHON_MANAGER_KEYWORDS,
  ...PACKAGE_MANAGER_KEYWORDS,
];

/** 关键词 → 词边界正则（大小写不敏感；`uv` 不命中 `uvicorn`、`nvm` 命中 `nvm-windows`）。 */
const KEYWORD_RES: ReadonlyMap<string, RegExp> = new Map(
  ALL_KEYWORDS.map((kw) => [kw, new RegExp(`\\b${kw}\\b`, 'i')]),
);

/** 支持导入的文件类型（按文件名识别，§7.7-2）。 */
export type ImportFileKind = 'AGENTS.md' | 'CLAUDE.md';

/** 按文件名识别导入类型：basename 大小写不敏感匹配；其余 → undefined。 */
export function identifyImportFile(fileName: string): ImportFileKind | undefined {
  const base = toPosixSeparators(fileName).split('/').pop() ?? '';
  const lower = base.toLowerCase();
  if (lower === 'agents.md') {
    return 'AGENTS.md';
  }
  if (lower === 'claude.md') {
    return 'CLAUDE.md';
  }
  return undefined;
}

/** Markdown 内容块（`## ` 标题切分；首块可能无标题——文件头散文本）。 */
export interface ImportBlock {
  /** 块标题（`## ` 行的文本，不含前缀）；文件头块为 null。 */
  readonly heading: string | null;
  /** 块完整内容（含 `## ` 标题行，换行原样保留）。 */
  readonly content: string;
  /** 块内命中的工具链关键词（判定"工具链声明块"的依据）。 */
  readonly toolchainHits: readonly string[];
}

/** 工具链声明建议（habits.detected.import 的数据面；§7.7-4）。 */
export interface ImportSuggestions {
  /** 命中的 Node 版本管理器（关键词优先级序取首个；无 → undefined）。 */
  readonly nodeManager: string | undefined;
  readonly pythonManager: string | undefined;
  /** 命中的 JS 包管理器（全部，按优先级序）。 */
  readonly packageManagers: readonly string[];
}

/** parseImportedFile 结果。 */
export interface ImportParseResult {
  /** marker 剥除后的全部内容块（空块已剔除）。 */
  readonly blocks: readonly ImportBlock[];
  /** 命中工具链关键词的块（不进入 custom 文件）。 */
  readonly toolchainBlocks: readonly ImportBlock[];
  /** 其余块（写入 custom/imported-<timestamp>.md）。 */
  readonly customBlocks: readonly ImportBlock[];
  readonly suggestions: ImportSuggestions;
}

/** 剥除全部 AgentForge marker 区间（多对 marker 循环剥净；§7.7-7）。 */
function stripAllMarkerSections(content: string): string {
  let out = content;
  let split = splitByMarkers(out);
  while (split.hasMarkers) {
    out = split.before + split.after;
    split = splitByMarkers(out);
  }
  return out;
}

/** 构造内容块：词边界关键词命中收集。 */
function makeBlock(content: string, heading: string | null): ImportBlock {
  const lower = content.toLowerCase();
  const hits: string[] = [];
  for (const kw of ALL_KEYWORDS) {
    if (KEYWORD_RES.get(kw)?.test(lower) === true) {
      hits.push(kw);
    }
  }
  return { heading, content, toolchainHits: hits };
}

/**
 * 按 `## ` 标题分块（§7.7-3）：
 * - `## ` 行开新块且保留在块内容中（原样保留各块标题）；
 * - `# ` 一级标题不切块（文件头块的一部分，heading 为 null）；
 * - `### ` 及更深级别归入当前块；
 * - 纯空白块剔除。
 */
export function splitMarkdownBlocks(content: string): ImportBlock[] {
  const blocks: ImportBlock[] = [];
  let current: string[] = [];
  let currentHeading: string | null = null;

  const flush = (): void => {
    if (current.join('').trim() !== '') {
      blocks.push(makeBlock(current.join(''), currentHeading));
    }
    current = [];
    currentHeading = null;
  };

  // lookbehind 分割：每段自带行尾换行（末段可能无换行），拼接无损且 ^## 对任意行生效
  for (const line of content.split(/(?<=\n)/)) {
    const headingMatch = /^##[ \t]+([^\r\n]*)/.exec(line);
    if (headingMatch !== null) {
      flush();
      currentHeading = (headingMatch[1] ?? '').trim();
      current = [line];
    } else {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

/** 关键词组在块集合中按优先级序取首个命中。 */
function firstHit(blocks: readonly ImportBlock[], keywords: readonly string[]): string | undefined {
  for (const kw of keywords) {
    for (const block of blocks) {
      if (block.toolchainHits.includes(kw)) {
        return kw;
      }
    }
  }
  return undefined;
}

/** 关键词组在块集合中的全部命中（按关键词优先级序）。 */
function allHits(blocks: readonly ImportBlock[], keywords: readonly string[]): string[] {
  return keywords.filter((kw) => blocks.some((block) => block.toolchainHits.includes(kw)));
}

/** 是否存在任一工具链建议。 */
export function hasAnySuggestion(suggestions: ImportSuggestions): boolean {
  return (
    suggestions.nodeManager !== undefined ||
    suggestions.pythonManager !== undefined ||
    suggestions.packageManagers.length > 0
  );
}

/**
 * 解析导入内容（纯函数）：
 * 剥 marker → 分块 → 关键词分类（toolchainBlocks / customBlocks）+ 建议聚合。
 */
export function parseImportedFile(content: string): ImportParseResult {
  const blocks = splitMarkdownBlocks(stripAllMarkerSections(content));
  const toolchainBlocks = blocks.filter((block) => block.toolchainHits.length > 0);
  const customBlocks = blocks.filter((block) => block.toolchainHits.length === 0);

  return {
    blocks,
    toolchainBlocks,
    customBlocks,
    suggestions: {
      nodeManager: firstHit(blocks, NODE_MANAGER_KEYWORDS),
      pythonManager: firstHit(blocks, PYTHON_MANAGER_KEYWORDS),
      packageManagers: allHits(blocks, PACKAGE_MANAGER_KEYWORDS),
    },
  };
}

/** habits.detected.import 建议对象（source: 'import'，§7.7-4；仅写入命中的键）。 */
export function buildImportDetected(
  suggestions: ImportSuggestions,
  importedFrom: string,
  importedAt: string,
): Record<string, unknown> {
  return {
    source: 'import',
    imported_from: importedFrom,
    imported_at: importedAt,
    ...(suggestions.nodeManager !== undefined
      ? { node: { manager: suggestions.nodeManager, source: 'import' } }
      : {}),
    ...(suggestions.pythonManager !== undefined
      ? { python: { manager: suggestions.pythonManager, source: 'import' } }
      : {}),
    ...(suggestions.packageManagers.length > 0
      ? {
          package_managers: suggestions.packageManagers.map((name) => ({
            name,
            source: 'import' as const,
          })),
        }
      : {}),
  };
}

/** custom/imported-<timestamp>.md 的文件名时间戳段（UTC，Windows 文件名安全字符）。 */
export function importTimestamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return [
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`,
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`,
  ].join('-');
}

/**
 * custom 文件正文：剩余块原样拼接（保留各块标题，含 `## ` 行），
 * 块间空行分隔、统一 LF（与 SoT 素材换行约定一致）、以换行结尾。
 */
export function buildCustomContent(blocks: readonly ImportBlock[]): string {
  const body = blocks
    .map((block) => normalizeLineEnding(block.content, 'lf').trim())
    .filter((text) => text !== '')
    .join('\n\n');
  return body === '' ? '' : `${body}\n`;
}
