/**
 * 源管理（Spec §4.4 sources.json / §7.6 Source 安装 / §7.8 Offline 降级矩阵）。
 *
 * 登记表与缓存位置（§3.1）：sources.json 与 store\ 均在 **user 层 SoT**
 * （resolver.ts 的 storeRoot 同源：`<userSoT>\store`），项目层 sources.json
 * 为可选特性，M8 只读写 user 层。
 *
 * - addLocal：校验路径存在 → 登记 {type:"local", path}（§7.6"登记路径"）；
 * - addGit：**AGF_OFFLINE=1 → OfflineError(5)**（§7.8）→ 必须显式 --ref
 *   （缺省 ConfigError(2)，§4.4"默认要求显式 --ref"）→ clone --depth 1 到
 *   store\<id\> + fetch/checkout ref + rev-parse 记录 commit（pin）；
 * - update：OfflineError 检查同上（§7.8 source update 失败码 5）；
 *   git fetch + checkout pinned commit；
 * - remove：删登记 + **删除 store\<id\> 缓存**（M8 决策：缓存随登记回收，
 *   避免孤儿目录；重新 add 即可恢复）；
 * - manifest.yaml 解析（§4.5）供 template/skill 清单消费。
 *
 * git 调用全部经 infra/shell.gitExec（测试可 mock host.exec）。
 */
import path from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import type { Host } from '../../infra/host';
import { atomicWrite, mkdirp } from '../../infra/fsutil';
import { gitExec } from '../../infra/shell';
import type { EnvSnapshot } from '../env';
import { ConfigError, GenericError, OfflineError } from '../errors';
import { loadSourcesFile, SOURCES_FILE } from '../config/load';
import { ManifestSchema, type GitSource, type LocalSource, type Manifest, type Source } from '../../schema';

/** Spec §3.1：git 源缓存目录名（user 层 SoT 下）。 */
export const STORE_DIR = 'store';

/** 源管理上下文。 */
export interface SourceManagerContext {
  readonly host: Host;
  readonly env: EnvSnapshot;
  /** user 层 SoT 根（sources.json 与 store\ 所在层）。 */
  readonly userSoTRoot: string;
  /** 相对路径解析基准（addLocal 的相对 path）。 */
  readonly cwd: string;
}

/** add 结果。 */
export interface AddSourceResult {
  readonly source: Source;
  /** sources.json 绝对路径。 */
  readonly file: string;
  /** git 源的本地 clone 目录（local 源为 undefined）。 */
  readonly storeDir?: string;
}

/** update 结果。 */
export interface UpdateSourceResult {
  readonly source: GitSource;
  /** checkout 后的 commit（可能不变）。 */
  readonly commit: string;
  readonly file: string;
  readonly storeDir: string;
}

// ---------------------------------------------------------------------------
// 基础设施：sources.json 读写 / id 派生 / git 命令
// ---------------------------------------------------------------------------

function sourcesFilePath(ctx: SourceManagerContext): string {
  return path.join(ctx.userSoTRoot, SOURCES_FILE);
}

/** 读 sources.json（不存在 → 空表；损坏 → ConfigError(2)，loadJson 层映射）。 */
async function loadSources(ctx: SourceManagerContext): Promise<Source[]> {
  return (await loadSourcesFile(ctx.host, ctx.userSoTRoot))?.sources ?? [];
}

/** 写 sources.json（2 空格缩进 + 末尾换行，原子写；父目录自动创建——源登记可先于 user 层 init）。 */
async function saveSources(ctx: SourceManagerContext, sources: readonly Source[]): Promise<string> {
  const file = sourcesFilePath(ctx);
  await mkdirp(ctx.host, path.dirname(file));
  const text = `${JSON.stringify({ version: 1, sources }, null, 2)}\n`;
  await atomicWrite(ctx.host, file, text);
  return file;
}

/** git 源缓存目录：`<userSoT>\store\<id>`。 */
export function sourceStoreDir(ctx: SourceManagerContext, id: string): string {
  return path.join(ctx.userSoTRoot, STORE_DIR, id);
}

/**
 * 从 url / 本地路径派生源 id：末段 basename（去 .git 后缀），非法字符压成 '-'。
 * 结果不匹配 ^[a-z0-9][a-z0-9_-]{1,63}$ 时抛错，要求用户显式指定 --id
 * （保证幂等性：同一 URL 多次调用产生相同 id）。
 */
export function deriveSourceId(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/, '');
  const last = normalized.split('/').pop() ?? '';
  const base = last.replace(/\.git$/, '');
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (/^[a-z0-9][a-z0-9_-]{1,63}$/.test(sanitized)) {
    return sanitized;
  }
  throw new ConfigError(`无法从路径派生合法的源 id: ${target}（规范化后为 "${sanitized}"）`, {
    hint: '请显式指定 --id（合法格式：以字母或数字开头，仅含小写字母、数字、下划线、连字符，长度 2-64），例如: aforge source add <url> --id my-source',
    details: { target, sanitized },
  });
}

/** 执行一条 git 命令；失败 → GenericError(1)（网络 / ref 不存在等通用域）。 */
async function gitMust(
  ctx: SourceManagerContext,
  args: readonly string[],
  opts: { cwd?: string; what: string },
): Promise<string> {
  const result = await gitExec(ctx.host, args, { cwd: opts.cwd });
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    throw new GenericError(`git ${opts.what} 失败（exit ${result.code}）${stderr ? `: ${stderr}` : ''}`, {
      hint:
        opts.what === 'clone'
          ? '检查 url 可达性与本机网络（或先配置凭证），然后重试 aforge source add'
          : `检查 ref 是否存在于远端（git ls-remote 验证），然后重试`,
      details: { args, code: result.code, stderr: result.stderr, stdout: result.stdout },
    });
  }
  return result.stdout;
}

/** 离线守卫（§7.8）：AGF_OFFLINE=1 时网络操作 → OfflineError(5)。 */
function assertNotOffline(env: EnvSnapshot, operation: string): void {
  if (env.offline) {
    throw new OfflineError(`离线模式（AGF_OFFLINE=1）禁止 ${operation}`, {
      hint: '移除 AGF_OFFLINE 环境变量后重试；离线时可用 source add local / 已缓存内容',
    });
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * 登记本地源（§7.6"登记路径"）。
 *
 * @throws ConfigError(2) 路径不存在 / id 重复。
 */
export async function addLocalSource(
  ctx: SourceManagerContext,
  input: { id?: string; path: string },
): Promise<AddSourceResult> {
  const resolved = path.resolve(ctx.cwd, input.path);
  if (!(await ctx.host.exists(resolved))) {
    throw new ConfigError(`local 源路径不存在: ${input.path}（解析为 ${resolved}）`, {
      hint: '确认路径正确（相对路径按当前目录解析），或改用 git url',
      details: { input: input.path, resolved },
    });
  }

  const id = input.id ?? deriveSourceId(resolved);
  const sources = await loadSources(ctx);
  if (sources.some((s) => s.id === id)) {
    throw new ConfigError(`源 id 已存在: ${id}`, {
      hint: '先 aforge source remove 该源，或换一个路径',
      details: { id },
    });
  }

  const source: LocalSource = { id, type: 'local', path: resolved, enabled: true, kind: [] };
  const file = await saveSources(ctx, [...sources, source]);
  return { source, file };
}

/**
 * 登记并 clone git 源（§7.6 / §4.4）：
 * OfflineError(5) → ConfigError(2)（缺 --ref）→ GenericError(1)（git 失败）。
 *
 * pin 流程：clone --depth 1（默认分支）→ fetch --depth 1 origin \<ref\> →
 * checkout --detach FETCH_HEAD → rev-parse HEAD 记录 commit。
 * （分支 / 标签 / commit sha 统一走 fetch+FETCH_HEAD 路径；sha 依赖远端
 * allowReachableSHA1InWant，GitHub 支持。）
 */
export async function addGitSource(
  ctx: SourceManagerContext,
  input: { id?: string; url: string; ref?: string },
): Promise<AddSourceResult> {
  assertNotOffline(ctx.env, 'source add git');

  if (input.ref === undefined || input.ref.trim() === '') {
    throw new ConfigError('git 源必须显式指定 --ref（tag / branch / commit）', {
      hint: '示例: aforge source add https://example.com/repo.git --ref v1.2.0（Spec 不跟踪浮动 main）',
      details: { url: input.url },
    });
  }
  const ref = input.ref.trim();

  const id = input.id ?? deriveSourceId(input.url);
  const sources = await loadSources(ctx);
  if (sources.some((s) => s.id === id)) {
    throw new ConfigError(`源 id 已存在: ${id}`, {
      hint: '先 aforge source remove 该源，或换一个 url',
      details: { id },
    });
  }

  const storeDir = sourceStoreDir(ctx, id);
  await mkdirp(ctx.host, path.dirname(storeDir));
  // 孤儿缓存（登记已删但目录残留）清掉重 clone
  if (await ctx.host.exists(storeDir)) {
    await ctx.host.rm(storeDir);
  }

  await gitMust(ctx, ['clone', '--depth', '1', input.url, storeDir], { what: 'clone' });
  await gitMust(ctx, ['fetch', '--depth', '1', 'origin', ref], { cwd: storeDir, what: 'fetch' });
  await gitMust(ctx, ['checkout', '--detach', 'FETCH_HEAD'], { cwd: storeDir, what: 'checkout' });
  const commit = (await gitMust(ctx, ['rev-parse', 'HEAD'], { cwd: storeDir, what: 'rev-parse' })).trim();

  const source: GitSource = { id, type: 'git', url: input.url, ref, commit, enabled: true, kind: [] };
  const file = await saveSources(ctx, [...sources, source]);
  return { source, file, storeDir };
}

/** 列出全部登记的源。 */
export async function listSources(ctx: SourceManagerContext): Promise<Source[]> {
  return loadSources(ctx);
}

/**
 * 更新 git 源（§7.8：AGF_OFFLINE=1 → OfflineError(5)）：fetch + checkout pinned commit。
 *
 * @throws ConfigError(2) id 不存在 / local 源（无远端可更新）/ store 缓存缺失。
 */
export async function updateSource(ctx: SourceManagerContext, id: string): Promise<UpdateSourceResult> {
  const sources = await loadSources(ctx);
  const source = sources.find((s) => s.id === id);
  if (source === undefined) {
    throw new ConfigError(`源不存在: ${id}`, {
      hint: '运行 aforge source list 查看已登记的源',
      details: { id },
    });
  }
  assertNotOffline(ctx.env, 'source update');
  if (source.type === 'local') {
    throw new ConfigError(`local 源无远端可更新: ${id}（path: ${source.path}）`, {
      hint: 'local 源直接读路径实时生效；如需固定版本请改用 git 源',
      details: { id, path: source.path },
    });
  }

  const storeDir = sourceStoreDir(ctx, id);
  if (!(await ctx.host.exists(storeDir))) {
    throw new ConfigError(`源缓存缺失: ${storeDir}`, {
      hint: '先 aforge source remove 再重新 aforge source add（--ref 原值）',
      details: { id, storeDir },
    });
  }

  const ref = source.ref ?? source.commit;
  if (ref === undefined) {
    throw new ConfigError(`git 源缺少 ref/commit，无法更新: ${id}`, {
      hint: 'sources.json 手工编辑损伤；请 aforge source remove 后重新 add（--ref 指定）',
      details: { id, source },
    });
  }
  await gitMust(ctx, ['fetch', '--depth', '1', 'origin', ref], { cwd: storeDir, what: 'fetch' });
  const checkoutTarget = source.commit ?? 'FETCH_HEAD';
  await gitMust(ctx, ['checkout', '--detach', checkoutTarget], { cwd: storeDir, what: 'checkout' });
  const commit = (await gitMust(ctx, ['rev-parse', 'HEAD'], { cwd: storeDir, what: 'rev-parse' })).trim();

  const updated: GitSource = { ...source, commit };
  const file = await saveSources(
    ctx,
    sources.map((s) => (s.id === id ? updated : s)),
  );
  return { source: updated, commit, file, storeDir };
}

/**
 * 移除源：删登记 + 删除 store\<id\> 缓存（M8 决策：缓存随登记回收）。
 *
 * @throws ConfigError(2) id 不存在。
 */
export async function removeSource(
  ctx: SourceManagerContext,
  id: string,
): Promise<{ removed: Source; file: string; storeDir?: string }> {
  const sources = await loadSources(ctx);
  const source = sources.find((s) => s.id === id);
  if (source === undefined) {
    throw new ConfigError(`源不存在: ${id}`, {
      hint: '运行 aforge source list 查看已登记的源',
      details: { id },
    });
  }

  let storeDir: string | undefined;
  if (source.type === 'git') {
    storeDir = sourceStoreDir(ctx, id);
    if (await ctx.host.exists(storeDir)) {
      await ctx.host.rm(storeDir);
    }
  }

  const file = await saveSources(
    ctx,
    sources.filter((s) => s.id !== id),
  );
  return { removed: source, file, storeDir };
}

// ---------------------------------------------------------------------------
// manifest（§4.5）
// ---------------------------------------------------------------------------

/** 源根目录：local → 登记的 path；git → store\<id\>。 */
export function sourceRootDir(ctx: SourceManagerContext, source: Source): string {
  return source.type === 'local' ? source.path : sourceStoreDir(ctx, source.id);
}

/**
 * 解析源的 manifest.yaml（§4.5：模板 / skills 清单）。
 *
 * @returns null 表示源无 manifest（不是错误——目录型源可只放 skills/ 等）；
 * @throws ConfigError(2) YAML 语法错误 / schema 校验失败（含文件路径）。
 */
export async function loadSourceManifest(
  ctx: SourceManagerContext,
  source: Source,
): Promise<Manifest | null> {
  const file = path.join(sourceRootDir(ctx, source), 'manifest.yaml');
  if (!(await ctx.host.exists(file))) {
    return null;
  }
  const text = await ctx.host.readFile(file);

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      throw new ConfigError(`manifest.yaml 不是合法的 YAML: ${file}: ${err.message}`, {
        hint: `修正源仓库中的 manifest.yaml（§4.5 结构：name/version/min_agentforge/templates/skills/mcp）`,
        details: { file, message: err.message },
      });
    }
    throw err;
  }

  const result = ManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues;
    const lines = issues.map(
      (issue) => `  - ${issue.path.filter((s) => typeof s !== 'symbol').join('.') || '(根)'}: ${issue.message}`,
    );
    throw new ConfigError(
      `manifest.yaml 校验失败（${file}），共 ${issues.length} 处问题:\n${lines.join('\n')}`,
      {
        hint: '按 §4.5 结构修正源仓库中的 manifest.yaml',
        details: { file, issues },
      },
    );
  }
  return result.data;
}
