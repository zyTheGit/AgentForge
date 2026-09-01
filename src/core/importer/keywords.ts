/**
 * Import 工具链关键词表（Spec §7.7-3）：importer 侧的**单一事实源**。
 *
 * importer.ts 只消费不定义。分两部分：
 * 1. 三张既有关键词表（node / python 管理器、JS 包管理器）——顺序即优先级序，
 *    **只允许追加不允许重排**：`habits.detected.import` 的 node/python 取"优先级序
 *    首个命中"，重排会改既有产物；
 * 2. EXTRA_TOOLCHAIN_CATEGORIES——新增类别（rust / go / java / dotnet / monorepo / ci），
 *    各自落在 detected.import 下的新键，全部取"全部命中"。
 *
 * 匹配语义（keywordRegExp）：
 * - 大小写不敏感；
 * - 词边界安全：关键词首/末字符是 ASCII 词字符时才加边界断言，故 `npm` 不命中
 *   `pnpm`、`java` 不命中 `javascript`、`turbo` 不命中 `turborepo`；
 * - 关键词按正则字面量转义：`go.mod` 里的 `.` 是字面点（不会命中 `gozmod`）；
 * - 关键词内的空白编译成 `\s+`：`github actions` 也能命中跨行折断的写法。
 *
 * 取舍（有意为之，别当 bug 修）：
 * - 不收单字符关键词（如 node 版本管理器 `n`）：`n` 这种词在中英文散文里满地都是，
 *   词边界拦不住（"选 n" / "y/n"），噪声远大于收益；
 * - 不收裸 `go`：英文散文里的动词 go 会大面积误报，改用 `golang` / `go.mod` /
 *   `gofmt` 等无歧义写法兜住 Go 项目；
 * - `rush` 同理只收 `rush.json` / `rushstack`。
 */

/** Node 版本管理器关键词（§7.7-3；命中顺序即优先级序，只追加不重排）。 */
export const NODE_MANAGER_KEYWORDS = ['fnm', 'nvm', 'volta', 'mise', 'nodenv', 'asdf'] as const;

/** Python 工具链关键词（§7.7-3；只追加不重排）。 */
export const PYTHON_MANAGER_KEYWORDS = [
  'uv',
  'poetry',
  'pipenv',
  'conda',
  'pyenv',
  'pdm',
  'hatch',
  'rye',
  'mamba',
  'virtualenv',
] as const;

/** JS 包管理器关键词（§7.7-3；只追加不重排）。 */
export const PACKAGE_MANAGER_KEYWORDS = ['pnpm', 'bun', 'npm', 'yarn', 'deno'] as const;

/** Rust 工具链关键词。 */
export const RUST_KEYWORDS = ['cargo', 'rustup', 'rustc', 'clippy', 'rustfmt'] as const;

/** Go 工具链关键词（裸 `go` 有意排除，见文件头取舍）。 */
export const GO_KEYWORDS = ['golang', 'go.mod', 'go.sum', 'gofmt', 'goimports', 'gopls'] as const;

/** Java 工具链关键词。 */
export const JAVA_KEYWORDS = [
  'maven',
  'gradle',
  'mvnw',
  'gradlew',
  'sdkman',
  'jdk',
  'java',
] as const;

/** .NET 工具链关键词。 */
export const DOTNET_KEYWORDS = ['dotnet', 'nuget', 'msbuild', 'csproj', 'csharp'] as const;

/** Monorepo 工具关键词。 */
export const MONOREPO_KEYWORDS = [
  'turborepo',
  'turbo',
  'nx',
  'lerna',
  'rush.json',
  'rushstack',
  'changesets',
  'pnpm-workspace',
  'workspaces',
] as const;

/** CI / 提交钩子关键词（含空格的条目按 `\s+` 匹配，可跨行）。 */
export const CI_KEYWORDS = [
  'github actions',
  'gitlab ci',
  'azure pipelines',
  'jenkins',
  'circleci',
  'travis',
  'dependabot',
  'husky',
  'lint-staged',
  'pre-commit',
  'commitlint',
] as const;

/** 新增工具链类别（既有 node / python / package_managers 三键不在此表内）。 */
export interface ToolchainCategory {
  /** 类别 id（对外稳定标识）。 */
  readonly id: string;
  /** habits.detected.import 下的键名（新键，不与既有键冲突）。 */
  readonly detectedKey: string;
  /** 人类可读摘要 label。 */
  readonly label: string;
  readonly keywords: readonly string[];
}

/**
 * 新增类别表：每类命中的关键词全部写入 detected.import 的对应新键。
 * 既有三键（node / python / package_managers）不走这里——它们的结构与优先级
 * 语义都要保持向后兼容，见 importer.ts。
 */
export const EXTRA_TOOLCHAIN_CATEGORIES: readonly ToolchainCategory[] = [
  { id: 'rust', detectedKey: 'rust', label: 'rust toolchain', keywords: RUST_KEYWORDS },
  { id: 'go', detectedKey: 'go', label: 'go toolchain', keywords: GO_KEYWORDS },
  { id: 'java', detectedKey: 'java', label: 'java toolchain', keywords: JAVA_KEYWORDS },
  { id: 'dotnet', detectedKey: 'dotnet', label: 'dotnet toolchain', keywords: DOTNET_KEYWORDS },
  { id: 'monorepo', detectedKey: 'monorepo', label: 'monorepo tools', keywords: MONOREPO_KEYWORDS },
  { id: 'ci', detectedKey: 'ci', label: 'ci / hooks', keywords: CI_KEYWORDS },
];

/** 全部关键词（去重；块级命中判定用，顺序为"三张既有表 → 新增类别表"）。 */
export const ALL_KEYWORDS: readonly string[] = [
  ...new Set<string>([
    ...NODE_MANAGER_KEYWORDS,
    ...PYTHON_MANAGER_KEYWORDS,
    ...PACKAGE_MANAGER_KEYWORDS,
    ...EXTRA_TOOLCHAIN_CATEGORIES.flatMap((category) => category.keywords),
  ]),
];

/** ASCII 词字符（`\b` 的判定集；边界断言与它保持一致）。 */
const WORD_CHAR_RE = /[A-Za-z0-9_]/;

/** 正则字面量转义（关键词里的 `.` 必须是字面点）。 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 关键词 → 匹配正则（大小写不敏感）。
 *
 * 边界断言按首/末字符是否为词字符**分别**决定：`\b` 在非词字符处的语义是反的
 * （`\b.net\b` 恒不命中 " .NET"），所以不能无脑两头加 `\b`。
 */
export function keywordRegExp(keyword: string): RegExp {
  const trimmed = keyword.trim();
  const body = trimmed.split(/\s+/).map(escapeRegExp).join('\\s+');
  const first = trimmed.slice(0, 1);
  const last = trimmed.slice(-1);
  const left = WORD_CHAR_RE.test(first) ? '(?<![A-Za-z0-9_])' : '';
  const right = WORD_CHAR_RE.test(last) ? '(?![A-Za-z0-9_])' : '';
  return new RegExp(`${left}${body}${right}`, 'i');
}

/** 关键词 → 正则缓存（每个关键词只编译一次）。 */
const KEYWORD_RES: ReadonlyMap<string, RegExp> = new Map(
  ALL_KEYWORDS.map((keyword) => [keyword, keywordRegExp(keyword)]),
);

/** 内容中是否命中该关键词（词边界安全、大小写不敏感）。 */
export function matchesKeyword(content: string, keyword: string): boolean {
  const re = KEYWORD_RES.get(keyword) ?? keywordRegExp(keyword);
  return re.test(content);
}
