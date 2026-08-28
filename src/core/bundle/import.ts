/**
 * `aforge bundle import`：把 bundle 目录落进一层 SoT（`bundle export` 的逆操作）。
 *
 * 顺序是安全性的核心——**先全量校验，再一次性落盘**：
 * 1. 读 manifest.json（schema 校验，坏包 → ConfigError(2)）；
 * 2. 逐条校验 `files[].path` 的合法性（layout.assertSafeBundlePath 拒绝 `..` /
 *    绝对路径 / 盘符——manifest 是可手工编辑的文件，路径直接参与 join，不校验
 *    就能往 SoT 之外写盘）与 sha256（LF 规范化后比对）；
 * 3. 任一条不通过 → 抛错且**一个字节都没写**；全通过后才进入写入阶段。
 *
 * 与 export 不同，import **会覆盖用户现有 SoT 文件**，所以：
 * - 默认冲突策略是 `skip`（不动既有文件），`overwrite` / `rename` 必须显式指定；
 * - 全程持 SoT 事务锁（与 sync 同一把 `.sync.lock`），避免并发 sync 读到半个 SoT；
 * - **不自动 sync**：填 SoT 与写别人的文件是两件风险等级不同的事，命令层只提示
 *   下一步跑 `aforge detect && aforge sync`。
 *
 * 目标层不要求已 init：迁移的典型场景就是「新机器上什么都没有」。若先 init 再
 * import，骨架 profile.yaml 会让 `skip` 策略把 bundle 里那份真配置挡在门外——
 * 那才是更坏的默认。目标 SoT 目录由本命令按需创建。
 *
 * 非事务：写入阶段中途失败（磁盘满 / 权限）会留下部分文件。校验前置已经排掉了
 * 「内容不对」这类可预见的失败，剩下的是环境故障；此时重跑同一条命令即可续写
 * （已写好的文件哈希一致，`skip` 会跳过、`overwrite` 会重写）。
 */
import path from 'node:path';
import { atomicWrite, mkdirp, sha256Hex } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import { type BundleManifest, BundleManifestSchema } from '../../schema/bundle';
import { loadJson } from '../config/load';
import { readEnv, type Scope } from '../env';
import { ConfigError, ConflictError } from '../errors';
import { type OsContext, resolveProjectSoT, resolveUserSoT } from '../paths';
import { withSotLock } from '../project/sync-lock';
import {
  assertSafeBundlePath,
  BUNDLE_CONTENT_DIR,
  BUNDLE_MANIFEST_FILE,
  collectTree,
} from './layout';

/** 冲突策略（目标已存在同名文件时）。 */
export type BundleConflictPolicy = 'skip' | 'overwrite' | 'rename';

/** 全部合法策略（命令层校验 `--on-conflict` 取值的唯一出处）。 */
export const BUNDLE_CONFLICT_POLICIES: readonly BundleConflictPolicy[] = [
  'skip',
  'overwrite',
  'rename',
];

/** `rename` 策略给**来料**文件加的后缀（不改名既有文件，见 resolveRenameTarget）。 */
export const IMPORT_RENAME_SUFFIX = '.imported';

/** 同名 `.imported` 也被占用时的编号上限（超出 → ConflictError(3)）。 */
const MAX_RENAME_ATTEMPTS = 100;

export interface BundleImportContext {
  readonly host: Host;
  readonly cwd: string;
  readonly os: OsContext;
}

export interface BundleImportOptions {
  /** bundle 目录（相对 cwd 解析）。 */
  readonly from: string;
  /** 落到哪一层（缺省 AGF_SCOPE > project）。 */
  readonly scope?: Scope;
  /** 冲突策略（缺省 skip）。 */
  readonly onConflict?: BundleConflictPolicy;
}

/** 单个文件的处理结果。 */
export interface ImportedEntry {
  /** bundle 内 posix 相对路径。 */
  readonly path: string;
  /** 实际写入（或跳过）的绝对路径。 */
  readonly target: string;
  readonly action: 'written' | 'skipped' | 'renamed';
}

export interface BundleImportResult {
  readonly scope: Scope;
  readonly sotRoot: string;
  readonly bundleDir: string;
  readonly manifest: BundleManifest;
  readonly onConflict: BundleConflictPolicy;
  readonly entries: ImportedEntry[];
  /** bundle 里存在但 manifest 未登记的文件（不导入，报出来供核对）。 */
  readonly unlisted: string[];
}

/** 校验阶段的产物：路径已安全化、内容已读出并验过哈希。 */
interface VerifiedFile {
  readonly rel: string;
  readonly content: string;
}

/** 读 manifest.json（缺失 / 损坏 / 校验失败一律 ConfigError(2)）。 */
async function readManifest(host: Host, bundleDir: string): Promise<BundleManifest> {
  const file = path.join(bundleDir, BUNDLE_MANIFEST_FILE);
  const manifest = await loadJson(host, file, BundleManifestSchema, 'bundle manifest.json');
  if (manifest === null) {
    throw new ConfigError(`不是有效的 bundle 目录（缺少 ${BUNDLE_MANIFEST_FILE}）: ${bundleDir}`, {
      hint: '确认 --from 指向 aforge bundle export 的输出目录（其下应有 manifest.json 与 sot/）',
      details: { bundleDir, manifestFile: file },
    });
  }
  return manifest;
}

/**
 * 校验全部登记文件：路径安全 + 内容哈希一致，并把内容读进内存。
 *
 * 一次性把问题**全部**收集完再抛：坏包往往不止一处，逐条 fail-fast 会让用户
 * 修一条跑一次。bundle 是纯文本且体量与 SoT 同级，整包驻留内存没有压力。
 *
 * @throws ConfigError(2) 有文件缺失或哈希不符。
 */
async function verifyFiles(
  host: Host,
  contentDir: string,
  manifest: BundleManifest,
): Promise<VerifiedFile[]> {
  const verified: VerifiedFile[] = [];
  const problems: string[] = [];
  for (const entry of manifest.files) {
    const rel = assertSafeBundlePath(entry.path);
    const file = path.join(contentDir, ...rel.split('/'));
    if (!(await host.exists(file))) {
      problems.push(`${rel}: 文件缺失（manifest 已登记）`);
      continue;
    }
    const content = await host.readFile(file);
    const actual = sha256Hex(content);
    if (actual !== entry.sha256) {
      problems.push(`${rel}: 内容哈希不符（期望 ${entry.sha256}，实际 ${actual}）`);
      continue;
    }
    verified.push({ rel, content });
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `bundle 完整性校验失败，共 ${problems.length} 处问题:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
      {
        hint: 'bundle 在传输中被改动或损坏；重新导出一份（哈希按 LF 规范化计算，换行差异不会误报）',
        details: { problems },
      },
    );
  }
  return verified;
}

/** `rename` 策略的落点：`<name>.imported`，被占用则 `.imported-2`、`-3`…… */
async function resolveRenameTarget(host: Host, target: string): Promise<string> {
  const first = `${target}${IMPORT_RENAME_SUFFIX}`;
  if (!(await host.exists(first))) {
    return first;
  }
  for (let n = 2; n <= MAX_RENAME_ATTEMPTS; n += 1) {
    const candidate = `${target}${IMPORT_RENAME_SUFFIX}-${n}`;
    if (!(await host.exists(candidate))) {
      return candidate;
    }
  }
  throw new ConflictError(
    `重命名落点全部被占用: ${first}（已尝试 ${MAX_RENAME_ATTEMPTS} 个后缀）`,
    {
      hint: '手工清理目标目录里的 *.imported* 残留后重试',
      details: { target, suffix: IMPORT_RENAME_SUFFIX, attempts: MAX_RENAME_ATTEMPTS },
    },
  );
}

/** 单文件落盘（按冲突策略决定写 / 跳过 / 改名写）。 */
async function writeOne(
  host: Host,
  sotRoot: string,
  file: VerifiedFile,
  policy: BundleConflictPolicy,
): Promise<ImportedEntry> {
  const target = path.join(sotRoot, ...file.rel.split('/'));
  if (await host.exists(target)) {
    if (policy === 'skip') {
      return { path: file.rel, target, action: 'skipped' };
    }
    if (policy === 'rename') {
      const renamed = await resolveRenameTarget(host, target);
      await mkdirp(host, path.dirname(renamed));
      await atomicWrite(host, renamed, file.content);
      return { path: file.rel, target: renamed, action: 'renamed' };
    }
  }
  await mkdirp(host, path.dirname(target));
  await atomicWrite(host, target, file.content);
  return { path: file.rel, target, action: 'written' };
}

/** 目标层 SoT 根（不要求已 init：新机器上目录本来就不存在，见文件头）。 */
function resolveTargetSoT(ctx: BundleImportContext, scope: Scope): string {
  return scope === 'project'
    ? resolveProjectSoT(ctx.cwd, ctx.os)
    : resolveUserSoT(readEnv(ctx.host), ctx.os);
}

/**
 * 从 bundle 目录导入一层 SoT。
 *
 * @throws ConfigError(2) 不是 bundle 目录 / manifest 损坏 / 路径越界 / 哈希不符。
 * @throws ConflictError(3) SoT 事务锁被他人持有 / rename 落点耗尽。
 * @throws PermissionError(4) 目标层不可写。
 */
export async function importBundle(
  ctx: BundleImportContext,
  options: BundleImportOptions,
): Promise<BundleImportResult> {
  const bundleDir = path.resolve(ctx.cwd, options.from);
  const contentDir = path.join(bundleDir, BUNDLE_CONTENT_DIR);
  const policy = options.onConflict ?? 'skip';
  const scope: Scope = options.scope ?? readEnv(ctx.host).agfScope ?? 'project';
  const sotRoot = resolveTargetSoT(ctx, scope);

  const manifest = await readManifest(ctx.host, bundleDir);
  const verified = await verifyFiles(ctx.host, contentDir, manifest);

  // manifest 未登记的多余文件：不导入（登记表是唯一权威），但要报出来——
  // 手工往 bundle 里塞文件是很自然的误用，静默忽略会让用户以为已经带过去了
  const listed = new Set(verified.map((f) => f.rel));
  const unlisted = (await collectTree(ctx.host, ctx.os, contentDir)).files.filter(
    (rel) => !listed.has(rel),
  );

  // 锁目录用 mkdir 原语，父目录（SoT 根）必须先存在
  await mkdirp(ctx.host, sotRoot);
  const entries = await withSotLock(ctx.host, sotRoot, ctx.os, async () => {
    const written: ImportedEntry[] = [];
    for (const file of verified) {
      written.push(await writeOne(ctx.host, sotRoot, file, policy));
    }
    return written;
  });

  return { scope, sotRoot, bundleDir, manifest, onConflict: policy, entries, unlisted };
}
