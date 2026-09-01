/**
 * Import 关键词表单测（Spec §7.7-3 的 Phase 2 扩展）：
 * - 词边界安全：不发生子串误命中（npm/pnpm、java/javascript、turbo/turborepo…）；
 * - 正则字面量转义：`go.mod` 里的 `.` 是字面点，不是"任意字符"；
 * - 含空格的关键词按 `\s+` 匹配（可跨行折断）；
 * - 表本身的卫生条件：无单字符关键词、无重复、全小写。
 */
import { describe, expect, it } from 'vitest';

import {
  ALL_KEYWORDS,
  EXTRA_TOOLCHAIN_CATEGORIES,
  keywordRegExp,
  matchesKeyword,
  NODE_MANAGER_KEYWORDS,
  PACKAGE_MANAGER_KEYWORDS,
  PYTHON_MANAGER_KEYWORDS,
} from '../../src/core/importer/keywords';

describe('matchesKeyword：词边界安全（不发生子串误命中）', () => {
  it.each([
    // [关键词, 文本, 是否应命中]
    ['npm', 'pnpm install', false],
    ['npm', 'use npm ci', true],
    ['npm', '包管理器用 pnpm，不要 npm', true],
    ['uv', '服务基于 uvicorn', false],
    ['uv', '依赖用 uv sync', true],
    ['nvm', 'nvm-windows 安装', true],
    ['java', 'javascript 项目', false],
    ['java', 'JavaScript / TypeScript', false],
    ['java', 'Java 21 项目', true],
    ['turbo', 'turborepo 管理', false],
    ['turbo', 'turbo run build', true],
    ['turborepo', 'turborepo 管理', true],
    ['nx', 'linux 环境', false],
    ['nx', 'nx affected', true],
    ['bun', 'bundle 分析', false],
    ['bun', 'bun install', true],
    ['deno', 'denolib', false],
    ['pdm', 'pdms', false],
    ['rye', 'ryegrass', false],
    ['hatch', 'hatchling', false],
    ['mise', 'promise 链', false],
    ['asdf', 'asdfgh', false],
  ])('关键词 %s 对「%s」命中 = %s', (keyword, text, expected) => {
    expect(matchesKeyword(text, keyword)).toBe(expected);
  });

  it('大小写不敏感', () => {
    expect(matchesKeyword('Use FNM and Pnpm', 'fnm')).toBe(true);
    expect(matchesKeyword('MSBuild 构建', 'msbuild')).toBe(true);
  });

  it('中文紧邻也算边界（中文不是 ASCII 词字符）', () => {
    expect(matchesKeyword('版本管理用fnm就行', 'fnm')).toBe(true);
    expect(matchesKeyword('包管理器：pnpm。', 'pnpm')).toBe(true);
  });
});

describe('keywordRegExp：字面量转义与空白折断', () => {
  it('`.` 是字面点，不匹配任意字符', () => {
    expect(matchesKeyword('见 go.mod 定义', 'go.mod')).toBe(true);
    expect(matchesKeyword('gozmod 不是文件名', 'go.mod')).toBe(false);
    expect(matchesKeyword('rush.json 配置', 'rush.json')).toBe(true);
    expect(matchesKeyword('rushxjson', 'rush.json')).toBe(false);
  });

  it('含空格的关键词按 \\s+ 匹配（换行 / 多空格折断也命中）', () => {
    expect(matchesKeyword('CI 用 GitHub Actions', 'github actions')).toBe(true);
    expect(matchesKeyword('CI 用 GitHub\nActions', 'github actions')).toBe(true);
    expect(matchesKeyword('CI 用 GitHub   Actions', 'github actions')).toBe(true);
    expect(matchesKeyword('githubactions', 'github actions')).toBe(false);
  });

  it('连字符关键词两端仍受边界保护', () => {
    expect(matchesKeyword('提交前跑 lint-staged', 'lint-staged')).toBe(true);
    expect(matchesKeyword('xlint-staged', 'lint-staged')).toBe(false);
    expect(matchesKeyword('pre-commit 钩子', 'pre-commit')).toBe(true);
  });

  it('未收录的关键词也能即时编译（缓存缺失路径）', () => {
    expect(keywordRegExp('kubectl').test('用 kubectl apply')).toBe(true);
    expect(matchesKeyword('用 kubectl apply', 'kubectl')).toBe(true);
  });
});

describe('关键词表卫生条件', () => {
  it('无单字符关键词（`n` 这类词在散文里满地都是，词边界拦不住）', () => {
    for (const keyword of ALL_KEYWORDS) {
      expect(keyword.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('全小写且无首尾空白（匹配靠正则的 i 标志，不靠表里的大小写）', () => {
    for (const keyword of ALL_KEYWORDS) {
      expect(keyword).toBe(keyword.toLowerCase().trim());
    }
  });

  it('ALL_KEYWORDS 去重（同一关键词跨类别出现时不重复命中）', () => {
    expect(new Set(ALL_KEYWORDS).size).toBe(ALL_KEYWORDS.length);
  });

  it('既有三张表的优先级序前缀不变（node/python/包管理器的既有产物依赖它）', () => {
    expect(NODE_MANAGER_KEYWORDS.slice(0, 4)).toEqual(['fnm', 'nvm', 'volta', 'mise']);
    expect(PYTHON_MANAGER_KEYWORDS.slice(0, 5)).toEqual([
      'uv',
      'poetry',
      'pipenv',
      'conda',
      'pyenv',
    ]);
    expect(PACKAGE_MANAGER_KEYWORDS.slice(0, 4)).toEqual(['pnpm', 'bun', 'npm', 'yarn']);
  });

  it('新增类别 id / detectedKey 唯一，且不与既有三键冲突', () => {
    const ids = EXTRA_TOOLCHAIN_CATEGORIES.map((c) => c.id);
    const keys = EXTRA_TOOLCHAIN_CATEGORIES.map((c) => c.detectedKey);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect([
        'node',
        'python',
        'package_managers',
        'source',
        'imported_from',
        'imported_at',
      ]).not.toContain(key);
    }
  });

  it('覆盖面：rust / go / java / dotnet / monorepo / ci 六类齐备', () => {
    expect(EXTRA_TOOLCHAIN_CATEGORIES.map((c) => c.id)).toEqual([
      'rust',
      'go',
      'java',
      'dotnet',
      'monorepo',
      'ci',
    ]);
    for (const category of EXTRA_TOOLCHAIN_CATEGORIES) {
      expect(category.keywords.length).toBeGreaterThan(0);
    }
  });
});
