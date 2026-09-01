/**
 * monorepo / CI 探测（Spec §7.2 Detect 顺序，工具形态）。
 *
 * 与 runtime 类探测相反，这两类**以仓库里的配置文件为主判据**，PATH 命中只作补充：
 *
 * - monorepo 工具几乎都靠 `npx nx` / `pnpm turbo` 这类间接调用，全局装的概率不高，
 *   而 `nx.json` / `turbo.json` 只要存在就说明这个仓库确实按该工具组织。因此顺序是
 *   「先看配置文件（`config-file`），再看 PATH（`path`）」；
 * - CI 提供方**只有**文件/目录判据：CI 的执行发生在远端，本机 PATH 上不会有
 *   `github-actions` 这种命令，扫它是浪费。
 *
 * 判定对多工具共存（既有 `nx.json` 又有 `turbo.json`）取优先级首位——快照要的是
 * 「这个仓库主要用什么」，罗列全部会让 detected 变成一份无法直接用的清单。
 */
import type { DetectIo } from './io';
import type { DetectedTool } from './types';

/** monorepo 工具候选优先级。 */
export const MONOREPO_TOOL_PRIORITY = ['nx', 'turbo', 'lerna', 'rush', 'pnpm-workspace'] as const;

export type MonorepoTool = (typeof MONOREPO_TOOL_PRIORITY)[number];

/**
 * monorepo 工具 → 配置文件（cwd 相对路径）与 PATH 可执行名。
 *
 * `pnpm-workspace` 没有 exec：它不是独立工具，工作区能力由 pnpm 本体提供
 * （pnpm 自身的 PATH 命中已由 runtime.package_managers 覆盖，不在此重复）。
 */
const MONOREPO_MARKERS: Readonly<
  Record<MonorepoTool, { readonly config: string; readonly exec?: string }>
> = {
  nx: { config: 'nx.json', exec: 'nx' },
  turbo: { config: 'turbo.json', exec: 'turbo' },
  lerna: { config: 'lerna.json', exec: 'lerna' },
  rush: { config: 'rush.json', exec: 'rush' },
  'pnpm-workspace': { config: 'pnpm-workspace.yaml' },
};

/** monorepo 探测需要并入一次性 PATH 扫描的可执行名。 */
export const WORKSPACE_SCAN_NAMES: readonly string[] = MONOREPO_TOOL_PRIORITY.map(
  (tool) => MONOREPO_MARKERS[tool].exec,
).filter((exec): exec is string => exec !== undefined);

/** 单文件判据的 CI 提供方（按优先级；github-actions 判目录，另行处理）。 */
const CI_FILE_PROVIDERS = ['gitlab-ci', 'circleci', 'jenkins', 'azure-pipelines'] as const;

/** CI 提供方候选优先级。 */
export const CI_PROVIDER_PRIORITY = ['github-actions', ...CI_FILE_PROVIDERS] as const;

export type CiProvider = (typeof CI_PROVIDER_PRIORITY)[number];

/** 单文件判据的 CI 提供方 → 流水线定义文件（cwd 相对路径）。 */
const CI_FILE_MARKERS: Readonly<Record<(typeof CI_FILE_PROVIDERS)[number], string>> = {
  'gitlab-ci': '.gitlab-ci.yml',
  circleci: '.circleci/config.yml',
  jenkins: 'Jenkinsfile',
  'azure-pipelines': 'azure-pipelines.yml',
};

/** GitHub Actions 的工作流目录。 */
const GITHUB_WORKFLOWS_DIR = '.github/workflows';

/** 工作流文件扩展名（`.yml` / `.yaml` 两种写法 GitHub 都认）。 */
const WORKFLOW_FILE_RE = /\.ya?ml$/i;

/** 工具的 PATH 路径（无 exec 或未命中 → undefined）。 */
function execPathOf(hits: ReadonlyMap<string, string>, tool: MonorepoTool): string | undefined {
  const exec = MONOREPO_MARKERS[tool].exec;
  return exec === undefined ? undefined : hits.get(exec);
}

/**
 * Monorepo 探测：配置文件命中（优先级序）→ config-file；否则 PATH 命中 → path；
 * 都无 → none。命中时若本体也在 PATH，顺带回报路径。
 */
export async function detectMonorepo(
  io: DetectIo,
  hits: ReadonlyMap<string, string>,
): Promise<DetectedTool> {
  const configHits = await Promise.all(
    MONOREPO_TOOL_PRIORITY.map((tool) => io.exists(MONOREPO_MARKERS[tool].config)),
  );
  for (const [index, tool] of MONOREPO_TOOL_PRIORITY.entries()) {
    if (configHits[index] === true) {
      return { manager: tool, source: 'config-file', path: execPathOf(hits, tool) };
    }
  }

  const fromPath = MONOREPO_TOOL_PRIORITY.find((tool) => execPathOf(hits, tool) !== undefined);
  if (fromPath !== undefined) {
    return { manager: fromPath, source: 'path', path: execPathOf(hits, fromPath) };
  }
  return { manager: 'none', source: 'none' };
}

/**
 * CI 探测：纯文件/目录存在性，命中即 config-file，无命中 → none。
 *
 * GitHub Actions 额外要求 `.github/workflows/` 里**至少有一个** `.yml` / `.yaml`：
 * 空目录（或只放了 issue 模板的 `.github/`）说明这个仓库并没有配流水线，
 * 报成「用 github-actions」会让 doctor 与规则生成拿到假线索。
 */
export async function detectCi(io: DetectIo): Promise<DetectedTool> {
  const [workflowEntries, fileHits] = await Promise.all([
    io.listDir(GITHUB_WORKFLOWS_DIR),
    Promise.all(CI_FILE_PROVIDERS.map((provider) => io.exists(CI_FILE_MARKERS[provider]))),
  ]);

  if (workflowEntries?.some((entry) => WORKFLOW_FILE_RE.test(entry)) === true) {
    return { manager: 'github-actions', source: 'config-file' };
  }
  for (const [index, provider] of CI_FILE_PROVIDERS.entries()) {
    if (fileHits[index] === true) {
      return { manager: provider, source: 'config-file' };
    }
  }
  return { manager: 'none', source: 'none' };
}

export interface WorkspaceProbeResult {
  readonly monorepo: DetectedTool;
  readonly ci: DetectedTool;
}

/** monorepo 与 CI 判据并行探测（全容错，绝不抛错）。 */
export async function probeWorkspace(
  io: DetectIo,
  hits: ReadonlyMap<string, string>,
): Promise<WorkspaceProbeResult> {
  const [monorepo, ci] = await Promise.all([detectMonorepo(io, hits), detectCi(io)]);
  return { monorepo, ci };
}
