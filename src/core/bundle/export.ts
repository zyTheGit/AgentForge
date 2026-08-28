/**
 * `aforge bundle export`：把一层 SoT 打成可搬走的 bundle 目录（Spec §3.1 SoT 布局）。
 *
 * 只读 SoT、只写 `--out` 目录，全程不碰投影文件、不改 SoT 一个字节。
 *
 * 三个阶段：
 * 1. **分类**：按 layout.classifySotEntry 把顶层条目分成「带走 / 排除」，排除项
 *    连原因一起进 manifest.excluded（不静默丢弃）；
 * 2. **净化**：habits 剔 detected、profile 抹 MCP 凭据（见 redact.ts）。改写过的
 *    文件在 manifest 里标 `transformed: true`；
 * 3. **落盘 + 记账**：内容写进 `<out>\sot\`，每个文件记 sha256（LF 规范化后计算，
 *    见 fsutil.sha256Hex）——import 侧据此校验完整性。用 LF 规范化的哈希是有意的：
 *    bundle 常经 git / 压缩包 / 网盘搬运，CRLF 被改写不该被判成内容损坏。
 *
 * 已知取舍：
 * - **YAML 注释会丢**。habits.yaml / profile.yaml 经「解析 → 改写 → 重新序列化」
 *   往返（与 `skill add` 写 profile 同源的代价，见 README「凡是会写 profile.yaml
 *   的命令」）。`--no-redact --keep-detected` 时两份文件仍走原文直拷，注释保留；
 * - **文本域**：内容经 Host.readFile/writeFile（UTF-8），二进制附属文件不在支持
 *   范围内（同 §7.6 skill copy 的约定）；
 * - **非事务**：写到一半失败会留下半个 bundle 目录。这是可丢弃的产物（不是 SoT、
 *   不是投影），删掉重跑即可，不值得为它引入备份 / 回滚机制。
 */
import path from 'node:path';
import {
  atomicWrite,
  ensureTrailingNewline,
  listDirSafe,
  mkdirp,
  sha256Hex,
} from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import type { BundleExcluded, BundleFile, BundleManifest } from '../../schema/bundle';
import { BundleManifestSchema } from '../../schema/bundle';
import {
  HABITS_FILE,
  loadHabits,
  loadProfile,
  loadSourcesFile,
  PROFILE_FILE,
  SOURCES_FILE,
} from '../config/load';
import { serializeYamlDoc } from '../config/serialize';
import { resolveWriteTargetLayer } from '../config/target-layer';
import { readEnv, type Scope } from '../env';
import { ConfigError, ConflictError } from '../errors';
import { isWithinAnyRoot, type OsContext } from '../paths';
import {
  BUNDLE_CONTENT_DIR,
  BUNDLE_MANIFEST_FILE,
  classifySotEntry,
  collectTree,
  type SkippedTreeEntry,
} from './layout';
import { redactProfileSecrets, stripDetected } from './redact';

/** export 上下文（host / cwd / os 注入，同命令层三件套）。 */
export interface BundleExportContext {
  readonly host: Host;
  readonly cwd: string;
  readonly os: OsContext;
  /** 写进 manifest 的 CLI 版本（命令层传 VERSION；测试传固定值以稳定断言）。 */
  readonly agentforgeVersion: string;
}

export interface BundleExportOptions {
  /** 导出哪一层（缺省按有效 scope 解析，要求该层已 init）。 */
  readonly scope?: Scope;
  /** 输出目录（相对 cwd 解析）；已存在且非空 → ConflictError(3)。 */
  readonly out: string;
  /** 抹掉 MCP 凭据（缺省 true；`--no-redact` 传 false 即原样导出密钥）。 */
  readonly redact?: boolean;
  /** 保留 habits.detected（缺省 false = 剔除）。 */
  readonly keepDetected?: boolean;
}

export interface BundleExportResult {
  readonly scope: Scope;
  readonly sotRoot: string;
  readonly outDir: string;
  readonly contentDir: string;
  readonly manifestFile: string;
  readonly manifest: BundleManifest;
  /** 遍历时跳过的 symlink / 环路项（不静默丢弃，命令层要打出来）。 */
  readonly skipped: SkippedTreeEntry[];
}

/** 写盘累加器：内容 + 记账一处产生，避免「写了但没记 / 记了但没写」。 */
interface WriteAcc {
  readonly host: Host;
  readonly contentDir: string;
  readonly files: BundleFile[];
}

/** 写一个文件进 bundle 并记账（rel 为 posix 相对路径）。 */
async function emit(
  acc: WriteAcc,
  rel: string,
  content: string,
  transformed: boolean,
): Promise<void> {
  const target = path.join(acc.contentDir, ...rel.split('/'));
  await mkdirp(acc.host, path.dirname(target));
  await atomicWrite(acc.host, target, content);
  acc.files.push({ path: rel, sha256: sha256Hex(content), transformed });
}

/** habits.yaml：剔 detected（keepDetected 时原文直拷，保住注释）。 */
async function emitHabits(
  ctx: BundleExportContext,
  acc: WriteAcc,
  sotRoot: string,
  keepDetected: boolean,
): Promise<void> {
  const file = path.join(sotRoot, HABITS_FILE);
  if (!(await ctx.host.exists(file))) {
    return;
  }
  if (keepDetected) {
    await emit(acc, HABITS_FILE, await ctx.host.readFile(file), false);
    return;
  }
  // loadHabits 顺带做 schema 校验：坏 habits.yaml 在这里 fail-fast(2)，
  // 而不是被打进 bundle 等到 import 后的第一次 sync 才炸
  const raw = await loadHabits(ctx.host, sotRoot);
  if (raw === null) {
    return;
  }
  const { habits, changed } = stripDetected(raw);
  await emit(acc, HABITS_FILE, serializeYamlDoc(habits), changed);
}

/** profile.yaml：抹 MCP 凭据（redact=false 时原文直拷，保住注释）。 */
async function emitProfile(
  ctx: BundleExportContext,
  acc: WriteAcc,
  sotRoot: string,
  redact: boolean,
): Promise<string[]> {
  const file = path.join(sotRoot, PROFILE_FILE);
  if (!(await ctx.host.exists(file))) {
    return [];
  }
  if (!redact) {
    await emit(acc, PROFILE_FILE, await ctx.host.readFile(file), false);
    return [];
  }
  const raw = await loadProfile(ctx.host, sotRoot);
  if (raw === null) {
    return [];
  }
  const { profile, redacted } = redactProfileSecrets(raw);
  await emit(acc, PROFILE_FILE, serializeYamlDoc(profile), redacted.length > 0);
  return redacted;
}

/**
 * sources.json：原文直拷 + 为 local 源产出 warning。
 *
 * local 源的 `path` 是**本机绝对路径**，换机器后必然失效；但也不能替用户删掉登记
 * （那等于悄悄改配置），所以原样带走、把失效风险写进 manifest.warnings。
 */
async function emitSources(
  ctx: BundleExportContext,
  acc: WriteAcc,
  sotRoot: string,
  warnings: string[],
): Promise<void> {
  const file = path.join(sotRoot, SOURCES_FILE);
  if (!(await ctx.host.exists(file))) {
    return;
  }
  await emit(acc, SOURCES_FILE, await ctx.host.readFile(file), false);
  const parsed = await loadSourcesFile(ctx.host, sotRoot);
  for (const source of parsed?.sources ?? []) {
    if (source.type === 'local') {
      warnings.push(
        `local source "${source.id}" points at ${source.path} - re-register it after import (aforge source add)`,
      );
    }
  }
}

/** 目标目录守卫：不能落在 SoT 内（边写边遍历），不能已有内容（防覆盖既有 bundle）。 */
async function assertOutDirUsable(
  host: Host,
  os: OsContext,
  outDir: string,
  sotRoot: string,
): Promise<void> {
  if (isWithinAnyRoot(outDir, [sotRoot], os)) {
    throw new ConfigError(`--out 不能位于 SoT 目录内: ${outDir}`, {
      hint: '换一个 SoT 之外的目录（导出目录落在 SoT 内会被自己遍历到）',
      details: { outDir, sotRoot },
    });
  }
  const existing = await listDirSafe(host, outDir);
  if (existing.length > 0) {
    throw new ConflictError(`--out 目录非空: ${outDir}（${existing.length} 个条目）`, {
      hint: '换一个空目录，或先删除该目录（bundle 是可丢弃产物，不做增量合并）',
      details: { outDir, existing },
    });
  }
}

/**
 * 导出一层 SoT 为 bundle。
 *
 * @throws ConfigError(2) 该层未 init / habits.yaml 或 profile.yaml 校验失败 /
 *         `--out` 落在 SoT 内 / 目录层级过深。
 * @throws ConflictError(3) `--out` 目录已有内容。
 * @throws PermissionError(4) 输出目录不可写。
 */
export async function exportBundle(
  ctx: BundleExportContext,
  options: BundleExportOptions,
): Promise<BundleExportResult> {
  const env = readEnv(ctx.host);
  const layer = await resolveWriteTargetLayer(ctx.host, env, ctx.os, ctx.cwd, options.scope);
  const outDir = path.resolve(ctx.cwd, options.out);
  await assertOutDirUsable(ctx.host, ctx.os, outDir, layer.sotRoot);

  const contentDir = path.join(outDir, BUNDLE_CONTENT_DIR);
  const acc: WriteAcc = { host: ctx.host, contentDir, files: [] };
  const excluded: BundleExcluded[] = [];
  const warnings: string[] = [];
  const skipped: SkippedTreeEntry[] = [];

  await emitHabits(ctx, acc, layer.sotRoot, options.keepDetected === true);
  const redacted = await emitProfile(ctx, acc, layer.sotRoot, options.redact !== false);
  await emitSources(ctx, acc, layer.sotRoot, warnings);

  for (const name of [...(await listDirSafe(ctx.host, layer.sotRoot))].sort()) {
    const entry = classifySotEntry(name);
    if (entry.kind === 'excluded') {
      excluded.push({ path: name, reason: entry.reason });
      continue;
    }
    if (entry.kind === 'file') {
      continue; // 三个顶层文件已由上面的 emit* 处理（含净化改写）
    }
    const listing = await collectTree(ctx.host, ctx.os, path.join(layer.sotRoot, name), name);
    skipped.push(...listing.skipped);
    for (const rel of listing.files) {
      await emit(
        acc,
        rel,
        await ctx.host.readFile(path.join(layer.sotRoot, ...rel.split('/'))),
        false,
      );
    }
  }

  if (redacted.length > 0) {
    warnings.push(
      `${redacted.length} credential value(s) redacted - set them again after import (see manifest.redacted)`,
    );
  }
  for (const entry of skipped) {
    warnings.push(`skipped ${entry.reason}: ${entry.path} (not followed, Spec 10)`);
  }

  const manifest = BundleManifestSchema.parse({
    version: 1,
    agentforgeVersion: ctx.agentforgeVersion,
    exportedAt: ctx.host.now().toISOString(),
    scope: layer.scope,
    sourceSotRoot: layer.sotRoot,
    files: [...acc.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    redacted,
    excluded,
    warnings,
  });
  const manifestFile = path.join(outDir, BUNDLE_MANIFEST_FILE);
  await mkdirp(ctx.host, outDir);
  await atomicWrite(
    ctx.host,
    manifestFile,
    ensureTrailingNewline(JSON.stringify(manifest, null, 2)),
  );

  return {
    scope: layer.scope,
    sotRoot: layer.sotRoot,
    outDir,
    contentDir,
    manifestFile,
    manifest,
    skipped,
  };
}
