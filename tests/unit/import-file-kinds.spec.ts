/**
 * 导入文件识别表单测（Spec §7.7-2 的 Phase 2 扩展）：
 * - 表驱动：每种支持的文件名 + 大小写变体 + 带路径写法；
 * - 父目录判据命中 / 未命中（`.cursor/rules/*.mdc`、`.github/copilot-instructions.md`）；
 * - 不支持的文件名 → undefined；
 * - hint 覆盖当前支持全集（报错文案与表不漂移）。
 */
import { describe, expect, it } from 'vitest';

import {
  IMPORT_FILE_RULES,
  identifyImportFile,
  importFileTool,
  supportedImportFileHint,
  supportedImportFileKinds,
} from '../../src/core/importer/file-kinds';

describe('identifyImportFile：支持的文件名全集（表驱动）', () => {
  it.each([
    ['AGENTS.md', 'AGENTS.md'],
    ['CLAUDE.md', 'CLAUDE.md'],
    ['GEMINI.md', 'GEMINI.md'],
    ['opencode.md', 'opencode.md'],
    ['.cursorrules', '.cursorrules'],
    ['.windsurfrules', '.windsurfrules'],
    ['.cursor/rules/style.mdc', '.cursor/rules/*.mdc'],
    ['.github/copilot-instructions.md', '.github/copilot-instructions.md'],
  ])('%s → %s', (input, expected) => {
    expect(identifyImportFile(input)).toBe(expected);
  });

  it.each([
    ['全小写', 'agents.md', 'AGENTS.md'],
    ['全大写', 'GEMINI.MD', 'GEMINI.md'],
    ['混合大小写', 'ClAuDe.Md', 'CLAUDE.md'],
    ['隐藏文件大写', '.CursorRules', '.cursorrules'],
    ['windsurf 大写', '.WINDSURFRULES', '.windsurfrules'],
    ['opencode 大写', 'OpenCode.md', 'opencode.md'],
    ['mdc 大写 + 目录大写', '.CURSOR/RULES/Style.MDC', '.cursor/rules/*.mdc'],
    ['copilot 大写', '.GitHub/Copilot-Instructions.MD', '.github/copilot-instructions.md'],
  ])('大小写不敏感：%s（%s）→ %s', (_name, input, expected) => {
    expect(identifyImportFile(input)).toBe(expected);
  });

  it.each([
    ['win32 绝对路径', 'C:\\proj\\AGENTS.md', 'AGENTS.md'],
    ['posix 绝对路径', '/home/u/proj/CLAUDE.md', 'CLAUDE.md'],
    ['win32 带父目录判据', 'C:\\proj\\.cursor\\rules\\ts.mdc', '.cursor/rules/*.mdc'],
    [
      'posix 带父目录判据',
      '/home/u/p/.github/copilot-instructions.md',
      '.github/copilot-instructions.md',
    ],
    ['混合分隔符', 'C:\\proj/.cursor\\rules/ts.mdc', '.cursor/rules/*.mdc'],
  ])('分隔符跨平台安全：%s → %s', (_name, input, expected) => {
    expect(identifyImportFile(input)).toBe(expected);
  });
});

describe('identifyImportFile：父目录判据', () => {
  it('.mdc 不在 .cursor/rules 下 → 不识别', () => {
    expect(identifyImportFile('docs/style.mdc')).toBeUndefined();
    expect(identifyImportFile('rules/style.mdc')).toBeUndefined();
    // 只有 .cursor 没有 rules
    expect(identifyImportFile('.cursor/style.mdc')).toBeUndefined();
    // 顺序颠倒
    expect(identifyImportFile('rules/.cursor/style.mdc')).toBeUndefined();
  });

  it('.cursor/rules 下的嵌套子目录仍识别（Cursor 支持嵌套摆法）', () => {
    expect(identifyImportFile('.cursor/rules/frontend/vue.mdc')).toBe('.cursor/rules/*.mdc');
    expect(identifyImportFile('C:\\p\\.cursor\\rules\\a\\b\\c.mdc')).toBe('.cursor/rules/*.mdc');
  });

  it('.mdc 本身不能当文件名（`.mdc` 末段）', () => {
    expect(identifyImportFile('.cursor/rules/.mdc')).toBeUndefined();
  });

  it('copilot-instructions.md 必须紧邻 .github 之下', () => {
    expect(identifyImportFile('copilot-instructions.md')).toBeUndefined();
    expect(identifyImportFile('docs/copilot-instructions.md')).toBeUndefined();
    // 嵌套一层就不算（紧邻父目录判据）
    expect(identifyImportFile('.github/instructions/copilot-instructions.md')).toBeUndefined();
    expect(identifyImportFile('sub/.github/copilot-instructions.md')).toBe(
      '.github/copilot-instructions.md',
    );
  });
});

describe('identifyImportFile：不支持的文件名', () => {
  it.each([
    ['其他 md 文件', 'README.md'],
    ['规则风格但未收录', 'RULES.md'],
    ['无扩展名', 'AGENTS'],
    ['扩展名不对', 'agents.json'],
    ['opencode 配置而非规则', 'opencode.json'],
    ['前缀相近', 'AGENTS.md.bak'],
    ['后缀相近', 'my-agents.md'],
    ['空字符串', ''],
    ['仅分隔符', '/'],
    ['目录而非文件', 'C:\\proj\\.cursor\\rules'],
  ])('%s（%s）→ undefined', (_name, input) => {
    expect(identifyImportFile(input)).toBeUndefined();
  });
});

describe('规则表与 hint 的一致性', () => {
  it('hint 列出全部支持项（新增一条规则后文案自动跟上）', () => {
    const hint = supportedImportFileHint();
    for (const kind of supportedImportFileKinds()) {
      expect(hint).toContain(kind);
    }
  });

  it('每条规则都有 kind / tool，且至少一条匹配判据（否则会命中一切）', () => {
    for (const rule of IMPORT_FILE_RULES) {
      expect(rule.kind).not.toBe('');
      expect(rule.tool).not.toBe('');
      const hasCriteria =
        ('basename' in rule && rule.basename !== undefined) ||
        ('extension' in rule && rule.extension !== undefined);
      expect(hasCriteria).toBe(true);
    }
  });

  it('kind 无重复；importFileTool 可反查来源工具', () => {
    const kinds = supportedImportFileKinds();
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(importFileTool('CLAUDE.md')).toContain('Claude');
  });
});
