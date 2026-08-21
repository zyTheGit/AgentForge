/**
 * Import 解析器单测（M9，Spec §7.7 MVP）：
 * - identifyImportFile：按文件名识别（大小写不敏感 / 带路径 / 不支持类型）；
 * - splitMarkdownBlocks：`## ` 分块、`### ` 不切块、无标题首块、空块剔除；
 * - parseImportedFile：marker 区间（含多对）剥除、工具链关键词词边界匹配
 *   （uvicorn 不误报 uv）、块级分类（工具链块 / custom 块）、建议聚合优先级；
 * - buildImportDetected / importTimestamp / buildCustomContent。
 */
import { describe, expect, it } from 'vitest';

import {
  buildCustomContent,
  buildImportDetected,
  hasAnySuggestion,
  identifyImportFile,
  importTimestamp,
  parseImportedFile,
  splitMarkdownBlocks,
  type ImportBlock,
  type ImportSuggestions,
} from '../../src/core/importer/importer';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../../src/core/markers';

describe('identifyImportFile（按文件名识别，§7.7-2）', () => {
  it.each([
    ['AGENTS.md', 'AGENTS.md'],
    ['agents.md', 'AGENTS.md'],
    ['CLAUDE.md', 'CLAUDE.md'],
    ['claude.md', 'CLAUDE.md'],
  ])('%s → %s', (input, expected) => {
    expect(identifyImportFile(input)).toBe(expected);
  });

  it.each([
    ['带路径的绝对路径', 'C:\\proj\\AGENTS.md'],
    ['posix 路径', '/home/u/proj/CLAUDE.md'],
  ])('%s 取 basename 识别', (_name, input) => {
    expect(identifyImportFile(input)).toBeDefined();
  });

  it.each([
    ['其他 md 文件', 'README.md'],
    ['无扩展名', 'AGENTS'],
    ['json 文件', 'agents.json'],
    ['空字符串', ''],
  ])('%s → undefined', (_name, input) => {
    expect(identifyImportFile(input)).toBeUndefined();
  });
});

describe('splitMarkdownBlocks（`## ` 标题分块，§7.7-3）', () => {
  it('按 ## 分块且标题行保留在块内容中', () => {
    const blocks = splitMarkdownBlocks(
      ['# 项目规则', '', '## 工具链', '使用 fnm。', '', '## 风格', '简洁。', ''].join('\n'),
    );

    expect(blocks.map((b) => b.heading)).toEqual([null, '工具链', '风格']);
    expect(blocks[1]?.content).toContain('## 工具链');
    expect(blocks[1]?.content).toContain('使用 fnm。');
    expect(blocks[2]?.content).toContain('## 风格');
  });

  it('### 三级标题不切块（归入当前块）', () => {
    const blocks = splitMarkdownBlocks('## 工具链\n\n### Node\nfnm\n\n### Python\nuv\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toContain('### Node');
    expect(blocks[0]?.content).toContain('### Python');
  });

  it('纯空白段不产生块；仅含标题的块保留（标题也是内容）', () => {
    const blocks = splitMarkdownBlocks('## A\n\n内容\n\n## B\n\n\n## C\n内容\n');
    expect(blocks.map((b) => b.heading)).toEqual(['A', 'B', 'C']);
    // 无标题的纯空白尾部不产生块
    const tail = splitMarkdownBlocks('## A\n内容\n\n\n\n');
    expect(tail).toHaveLength(1);
  });

  it('CRLF 内容正常分块（标题含 \\r 被剥除）', () => {
    const blocks = splitMarkdownBlocks('## 工具链\r\n使用 uv\r\n');
    expect(blocks[0]?.heading).toBe('工具链');
    expect(blocks[0]?.content).toContain('使用 uv');
  });
});

describe('parseImportedFile（marker 剥除 + 关键词识别 + 分类）', () => {
  /** 典型导入样本：工具链块 + 风格块 + forbid 噪声块。 */
  const SAMPLE = [
    '# 项目规则',
    '',
    '## 工具链',
    '- Node: 使用 fnm 管理版本。',
    '- Python: 使用 uv 管理环境与依赖。',
    '- JS 包管理器：优先 pnpm，其次 bun。',
    '',
    '## 风格',
    '简洁、外科手术式修改。',
    '',
    '## 禁止',
    '- fnm 可用时不要建议 nvm。',
    '',
  ].join('\n');

  it('工具链声明映射建议字段，风格/其他块进 custom', () => {
    const parsed = parseImportedFile(SAMPLE);

    expect(parsed.suggestions.nodeManager).toBe('fnm');
    expect(parsed.suggestions.pythonManager).toBe('uv');
    expect(parsed.suggestions.packageManagers).toEqual(['pnpm', 'bun']);

    // 工具链块与禁止块（含关键词）不进 custom；文件头与风格块进 custom
    expect(parsed.customBlocks.map((b) => b.heading)).toEqual([null, '风格']);
    expect(parsed.toolchainBlocks.length).toBeGreaterThan(0);
  });

  it('marker 区间内容剥除（§7.7-7）', () => {
    const withMarker = [
      '用户自己的开头内容',
      DEFAULT_MARKER_BEGIN,
      '# AgentForge Rules',
      'use fnm and uv',
      DEFAULT_MARKER_END,
      '## 风格',
      '简洁。',
    ].join('\n');

    const parsed = parseImportedFile(withMarker);
    // marker 区间内的 fnm/uv 不参与建议（是 AgentForge 自己的投影产物）
    expect(parsed.suggestions.nodeManager).toBeUndefined();
    expect(parsed.suggestions.pythonManager).toBeUndefined();
    // marker 外内容保留：文件头块 + 风格块
    expect(parsed.blocks.map((b) => b.heading)).toEqual([null, '风格']);
  });

  it('多对 marker 循环剥净', () => {
    const withMarkers = [
      'a fnm',
      DEFAULT_MARKER_BEGIN,
      'x',
      DEFAULT_MARKER_END,
      'b',
      DEFAULT_MARKER_BEGIN,
      'y',
      DEFAULT_MARKER_END,
      'c uv',
    ].join('\n');

    const parsed = parseImportedFile(withMarkers);
    expect(parsed.suggestions.nodeManager).toBe('fnm');
    expect(parsed.suggestions.pythonManager).toBe('uv');
  });

  it('词边界匹配：uvicorn 不误报 uv，nvm-windows 命中 nvm', () => {
    const parsed = parseImportedFile('## 依赖\n- 服务基于 uvicorn。\n');
    expect(parsed.suggestions.pythonManager).toBeUndefined();

    const parsed2 = parseImportedFile('## 工具\n- nvm-windows 安装\n');
    expect(parsed2.suggestions.nodeManager).toBe('nvm');
  });

  it('关键词优先级：同块出现 fnm 与 nvm 时取 fnm（优先级序首个）', () => {
    const parsed = parseImportedFile('## 工具\nfnm 可用时不要建议 nvm\n');
    expect(parsed.suggestions.nodeManager).toBe('fnm');
  });

  it('大小写不敏感匹配', () => {
    const parsed = parseImportedFile('## Tools\nUse FNM and Pnpm\n');
    expect(parsed.suggestions.nodeManager).toBe('fnm');
    expect(parsed.suggestions.packageManagers).toEqual(['pnpm']);
  });

  it('无任何关键词命中 → 建议全空且全部块进 custom（含文件头块）', () => {
    const parsed = parseImportedFile('# 规则\n\n## 风格\n简洁。\n');
    expect(hasAnySuggestion(parsed.suggestions)).toBe(false);
    expect(parsed.toolchainBlocks).toHaveLength(0);
    expect(parsed.customBlocks.map((b) => b.heading)).toEqual([null, '风格']);
  });
});

describe('buildImportDetected（detected.import 建议对象，§7.7-4）', () => {
  it('仅写入命中的键且每项带 source: import', () => {
    const suggestions: ImportSuggestions = {
      nodeManager: 'fnm',
      pythonManager: undefined,
      packageManagers: ['pnpm', 'bun'],
    };
    const detected = buildImportDetected(suggestions, 'AGENTS.md', '2026-08-21T00:00:00.000Z');

    expect(detected.source).toBe('import');
    expect(detected.imported_from).toBe('AGENTS.md');
    expect(detected.imported_at).toBe('2026-08-21T00:00:00.000Z');
    expect(detected.node).toEqual({ manager: 'fnm', source: 'import' });
    expect(detected.python).toBeUndefined();
    expect(detected.package_managers).toEqual([
      { name: 'pnpm', source: 'import' },
      { name: 'bun', source: 'import' },
    ]);
  });

  it('全部未命中 → 仅元信息键', () => {
    const detected = buildImportDetected(
      { nodeManager: undefined, pythonManager: undefined, packageManagers: [] },
      'CLAUDE.md',
      'now',
    );
    expect(Object.keys(detected).sort()).toEqual(['imported_at', 'imported_from', 'source']);
  });
});

describe('importTimestamp / buildCustomContent', () => {
  it('时间戳段为 UTC 且 Windows 文件名安全（无冒号）', () => {
    const ts = importTimestamp(new Date('2026-08-21T15:30:45.123Z'));
    expect(ts).toBe('20260821-153045');
    expect(ts).not.toContain(':');
  });

  it('custom 正文：剩余块原样拼接（保留标题）、块间空行、以换行结尾', () => {
    const blocks: ImportBlock[] = [
      { heading: null, content: '# 项目规则\n', toolchainHits: [] },
      { heading: '风格', content: '## 风格\n简洁。\r\n', toolchainHits: [] },
    ];
    const content = buildCustomContent(blocks);
    expect(content).toBe('# 项目规则\n\n## 风格\n简洁。\n');
  });

  it('空块列表 → 空字符串', () => {
    expect(buildCustomContent([])).toBe('');
  });
});
