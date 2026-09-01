/**
 * Import 解析器（Spec §7.7；Phase 2 扩展）：从既有规则文件（AGENTS.md /
 * CLAUDE.md / GEMINI.md / .cursorrules / .cursor/rules/*.mdc / .windsurfrules /
 * .github/copilot-instructions.md / opencode.md）提取工具链声明与剩余内容块。
 *
 * 纯函数模块（零 IO、不依赖 TTY）：
 * 1. 文件识别：见 ./file-kinds（声明式规则表，含父目录判据）；
 * 2. 关键词表：见 ./keywords（单一事实源，本文件只消费不定义）；
 * 3. parseImportedFile：剥除全部 AgentForge marker 区间（§7.7-7）→ 按 `## `
 *    标题分块（§7.7-3）→ 工具链关键词识别（词边界匹配，避免 uvicorn 误报 uv）；
 * 4. 映射产出：
 *    - 命中工具链关键词的块 → habits.detected.import 建议字段
 *      （source: 'import'，需用户确认，§7.7-4）；
 *    - 其余块 → custom/imported-<timestamp>.md 素材（原样保留各块标题）。
 *
 * 关键词命中即建议（可能包含 forbid 语句中的否定式提及）——Spec 定位为
 * "suggested，需用户确认"，噪声由人工核对 habits.yaml 消化。
 */
import { normalizeLineEnding } from '../../infra/fsutil';
import { splitByMarkers } from '../markers';
import {
  ALL_KEYWORDS,
  EXTRA_TOOLCHAIN_CATEGORIES,
  matchesKeyword,
  NODE_MANAGER_KEYWORDS,
  PACKAGE_MANAGER_KEYWORDS,
  PYTHON_MANAGER_KEYWORDS,
} from './keywords';

export {
  IMPORT_FILE_RULES,
  type ImportFileKind,
  type ImportFileRule,
  identifyImportFile,
  importFileTool,
  supportedImportFileHint,
  supportedImportFileKinds,
} from './file-kinds';

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
  /**
   * 新增类别命中（category id → 命中关键词，按表内顺序）；无命中的类别不出现。
   *
   * 单独开一个字段而不是把 6 个类别摊平成 6 个字段：类别表是数据驱动的，
   * 加一类只该动 keywords.ts 一处。
   */
  readonly extraToolchains: Readonly<Record<string, readonly string[]>>;
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
  const hits = ALL_KEYWORDS.filter((keyword) => matchesKeyword(content, keyword));
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
    suggestions.packageManagers.length > 0 ||
    Object.keys(suggestions.extraToolchains).length > 0
  );
}

/** 新增类别的命中聚合（无命中的类别不进结果，保持 detected.import 干净）。 */
function collectExtraToolchains(blocks: readonly ImportBlock[]): Record<string, readonly string[]> {
  const extras: Record<string, readonly string[]> = {};
  for (const category of EXTRA_TOOLCHAIN_CATEGORIES) {
    const hits = allHits(blocks, category.keywords);
    if (hits.length > 0) {
      extras[category.id] = hits;
    }
  }
  return extras;
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
      extraToolchains: collectExtraToolchains(blocks),
    },
  };
}

/** 新增类别 → detected.import 的键值（每项与既有 package_managers 同构）。 */
function extraDetectedEntries(suggestions: ImportSuggestions): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const category of EXTRA_TOOLCHAIN_CATEGORIES) {
    const hits = suggestions.extraToolchains[category.id];
    if (hits !== undefined && hits.length > 0) {
      entries[category.detectedKey] = hits.map((name) => ({ name, source: 'import' as const }));
    }
  }
  return entries;
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
    ...extraDetectedEntries(suggestions),
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
