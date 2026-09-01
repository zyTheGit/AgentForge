/**
 * skill 安装与清单（Spec §7.6 / §5.3 / §11.2.6）。
 *
 * - addSkill：从源（local 路径 / git store）**实体 copy** 到目标层 SoT
 *   `skills\<name\>\`（递归目录；非 symlink，§7.6 Windows 默认；写入为独立
 *   文件——修改 SoT 副本不影响源）。目标已存在 → ConflictError(3)；
 * - setSkillAlways / validateSkillName：实现在 skill-registry（登记要持 SoT 锁、
 *   要读改写 profile.yaml，与"文件搬运"不是一件事），本模块原样再导出；
 * - listSkills：目标层 SoT skills\ + 各源 skills 清单（源侧直接列目录名，
 *   manifest.skills 为 loose 结构不作强约束）；
 * - readSkillsToMaterialize：sync 引擎的物化数据源，实现在 skill-materialize
 *   （`skills.always` 原文 + `skills.on_demand` 注入按需标记；§5.3 同名优先级
 *   project SoT > user SoT），本模块原样再导出。
 *
 * copy 经 Host 的 readFile/writeFile（UTF-8 文本域）；二进制文件不属于
 * M8 支持范围（skill 以 Markdown 说明为主，§10 投影只 copy 不执行）。
 *
 * 安全边界（§10，源可能来自不可信 git 仓库）：
 * - 递归 copy 用 **lstat** 判类型，symlink 一律**跳过**并记入结果 `skipped`
 *   （跟随链接会把 `~/.ssh/id_rsa` 之类目标读进 SoT，再被投影进规则文件）；
 * - 深度上限 MAX_COPY_DEPTH，另以"已访问路径 Set"作环路基准（键为**词法**
 *   规范化路径，见 pathKey——不做 realpath，故不解析链接目标；junction
 *   在 Windows 上也报 symlink，双保险防无限递归 / 无限写盘）；
 * - copy 中途失败时回滚本次写入的内容（冲突判据与回滚判据同源，见 addSkill），
 *   避免残留让下次 `skill add` 被 ConflictError 永久挡死。
 */
import path from 'node:path';
import { atomicWrite, listDirSafe, mkdirp } from '../../infra/fsutil';
import type { FileStat, Host } from '../../infra/host';
import type { EnvSnapshot } from '../env';
import { ConfigError, ConflictError } from '../errors';
import { type OsContext, SKILL_DOC_FILENAME, SKILLS_DIRNAME } from '../paths';
import {
  listSources,
  loadSourceManifest,
  type SourceManagerContext,
  sourceRootDir,
} from './manager';
import { validateSkillName } from './skill-registry';

/**
 * skill 名规则与 `skills.always` 登记搬到了 skill-registry（登记要持 SoT 锁、要读改写
 * profile.yaml，与"文件搬运"不是一件事）；这里原样再导出，对外仍是同一个入口。
 */
export {
  type SetSkillAlwaysResult,
  setSkillAlways,
  setSkillAlwaysLocked,
  validateSkillName,
} from './skill-registry';

/** 递归 copy 深度上限（超过 → ConfigError(2)；正常 skill 目录远不及此）。 */
export const MAX_COPY_DEPTH = 32;

/** skill 上下文。 */
export interface SkillContext {
  readonly host: Host;
  readonly env: EnvSnapshot;
  readonly os: OsContext;
  readonly cwd: string;
  readonly userSoTRoot: string;
  readonly projectSoTRoot: string;
  /** skill 安装目标层 SoT 根（命令层经 target-layer 解析后注入）。 */
  readonly targetSoTRoot: string;
}

/** copy 过程中被跳过的项（不静默丢弃：作为结果的一部分返回给调用方）。 */
export interface SkippedEntry {
  /** 被跳过项的绝对源路径。 */
  readonly path: string;
  /** symlink：不跟随符号链接；cycle：真实路径已访问过（环路基准）。 */
  readonly reason: 'symlink' | 'cycle';
}

/** addSkill 结果。 */
export interface AddSkillResult {
  readonly name: string;
  /** 源根目录（local 路径或 store\<id\>；直连路径时即该路径）。 */
  readonly fromRoot: string;
  /** 来源源 id（--from 给的是登记 id 时；直连路径为 undefined）。 */
  readonly fromSourceId: string | undefined;
  readonly targetDir: string;
  /** 实际 copy 的文件（相对 targetDir 的相对路径，排序稳定）。 */
  readonly files: string[];
  /** 跳过的项（symlink / 环路）；空数组表示无跳过。 */
  readonly skipped: SkippedEntry[];
  /**
   * copy 前目标目录是否已存在（必为空目录，否则冲突检查已拦下）。
   *
   * 给调用方做后续步骤失败时的补偿回滚用（见 rollbackSkillCopy 的两种语义）：
   * 命令层"copy 成功但登记 skills.always 失败"要撤销 copy，必须知道那个空目录
   * 是不是用户自己建的——不能删自己没创建的东西。
   */
  readonly targetPreexisted: boolean;
}

/** 清单项。 */
export interface SkillListItem {
  readonly name: string;
  /** installed：SoT skills\ 已安装；available：仅在源中。 */
  readonly status: 'installed' | 'available';
  /** installed 项的所在层（project / user）；available 项为来源源 id。 */
  readonly origin: string;
}

/** copy 过程共享状态（累积文件清单 / 跳过项 / 环路基准）。 */
interface CopyState {
  readonly host: Host;
  readonly os: OsContext;
  readonly files: string[];
  readonly skipped: SkippedEntry[];
  /** 已进入过的目录规范化键（环路基准）。 */
  readonly visited: Set<string>;
}

/** 目录去重键：按平台规范化（win32 大小写不敏感，同 paths.samePath 语义）。 */
function pathKey(p: string, os: OsContext): string {
  const api = os.platform === 'win32' ? path.win32 : path.posix;
  const normalized = api.normalize(p);
  return os.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 递归 copy：from → to（from 不存在 → 空目录；to 由本函数创建）。
 *
 * rel 为当前目录相对**顶层目标**的相对路径前缀（state.files 路径基准）；
 * depth 为当前层级（顶层 0）。
 *
 * 判类型用 lstat 而非 stat：symlink 一律跳过（不跟随，防越界读取与无限递归），
 * 并把该项记入 state.skipped。**不要改回 stat**——与 listSkills 的 stat 判据
 * 有意不同：那里是"报告 SoT 能提供什么"，这里是"从不可信源往 SoT 写盘"。
 *
 * @throws ConfigError(2) 目录层级超过 MAX_COPY_DEPTH。
 */
async function copyDirDeep(
  state: CopyState,
  from: string,
  to: string,
  rel: string,
  depth: number,
): Promise<void> {
  if (depth > MAX_COPY_DEPTH) {
    throw new ConfigError(`skill 源目录层级过深（超过 ${MAX_COPY_DEPTH} 层）: ${from}`, {
      hint: '源目录疑似存在环路或异常深的嵌套；检查源仓库（symlink 已被跳过，此处为深度兜底）',
      details: { from, depth, maxDepth: MAX_COPY_DEPTH },
    });
  }
  state.visited.add(pathKey(from, state.os));

  const host = state.host;
  await mkdirp(host, to);
  for (const entry of [...(await listDirSafe(host, from))].sort()) {
    const src = path.join(from, entry);
    const dst = path.join(to, entry);
    const relEntry = rel === '' ? entry : `${rel}${path.sep}${entry}`;
    let stat: FileStat | undefined;
    try {
      stat = await host.lstat(src);
    } catch {
      stat = undefined;
    }
    if (stat?.isSymbolicLink === true) {
      // 不跟随：指向祖先目录 → 无限递归；指向 ~/.ssh/id_rsa → 私钥进 SoT
      state.skipped.push({ path: src, reason: 'symlink' });
      continue;
    }
    if (stat?.isDirectory === true) {
      if (state.visited.has(pathKey(src, state.os))) {
        state.skipped.push({ path: src, reason: 'cycle' });
        continue;
      }
      await copyDirDeep(state, src, dst, relEntry, depth + 1);
      continue;
    }
    // 文本 copy（实体文件，非 symlink：恒为独立副本）
    await atomicWrite(host, dst, await host.readFile(src));
    state.files.push(relEntry);
  }
}

/**
 * copy 失败回滚：清掉本次写入 targetDir 的全部内容。
 *
 * 判据必须与 addSkill 的冲突判据（`listDirSafe(targetDir).length > 0`）同源：
 * 旧实现用 `host.exists(targetDir)` 决定是否回滚，于是「目标目录已存在但为空」
 * 时冲突检查放行、失败却因 exists 为真而跳过回滚——半装内容留在原地，下次
 * `skill add` 被 ConflictError 永久挡死。
 *
 * `preexisted=false`（本次新建）→ 连目录一并删除；`true`（原为空目录，是用户
 * 创建的）→ 只删本次写入的子项，保留那个空目录本身（不删自己没创建的东西）。
 * 两种情况回滚后目标都回到"无内容"状态，与冲突检查的前置条件一致。
 */
export async function rollbackSkillCopy(
  host: Host,
  targetDir: string,
  preexisted: boolean,
): Promise<void> {
  try {
    if (!preexisted) {
      await host.rm(targetDir);
      return;
    }
    for (const entry of await listDirSafe(host, targetDir)) {
      await host.rm(path.join(targetDir, entry));
    }
  } catch {
    // 回滚失败不掩盖原始错误（调用方 rethrow 才是用户要看的原因）
  }
}

/**
 * 安装 skill（§7.6 skill add = copy 到 SoT skills\）。
 *
 * @param from 源标识：登记的源 id、或源根目录路径（其下 skills\<name\>\）、
 *        或直接指向 skill 目录本身（含 SKILL.md）的路径。缺省时按登记顺序
 *        在全部源中找首个含该 skill 的源。
 * @throws ConfigError(2) 名字非法 / 源或 skill 不存在 / 源目录层级过深 /
 *         copy 产物不含 SKILL.md（空安装，见下）。
 * @throws ConflictError(3) 目标 skills\<name\> 已存在内容。
 */
export async function addSkill(
  ctx: SkillContext,
  name: string,
  from?: string,
): Promise<AddSkillResult> {
  validateSkillName(name);

  // 1. 定位源 skill 目录
  const skillDir = await locateSourceSkillDir(ctx, name, from);

  // 2. 目标冲突检查（skills\<name\> 下已有任何内容 → Conflict，§6.1）
  const targetDir = path.join(ctx.targetSoTRoot, SKILLS_DIRNAME, name);
  const existing = await listDirSafe(ctx.host, targetDir);
  if (existing.length > 0) {
    throw new ConflictError(`skill 已存在: ${targetDir}（${existing.length} 个文件）`, {
      hint: '先删除该目录（或 aforge learnings/skill 管理入口移除）后再安装；已安装 skill 以 SoT 为准（§5.3）',
      details: { name, targetDir, existing },
    });
  }

  // 3. 实体 copy（递归）；失败一律回滚本次写入的内容（见 rollbackSkillCopy）
  const targetPreexisted = await ctx.host.exists(targetDir);
  const state: CopyState = {
    host: ctx.host,
    os: ctx.os,
    files: [],
    skipped: [],
    visited: new Set<string>(),
  };
  try {
    await copyDirDeep(state, skillDir.dir, targetDir, '', 0);
    // 4. 空安装守卫：产物必须含 SKILL.md（sync 物化的唯一正文来源）
    assertSkillDocCopied(state, name, targetDir, skillDir.dir);
  } catch (err) {
    await rollbackSkillCopy(ctx.host, targetDir, targetPreexisted);
    throw err;
  }

  return {
    name,
    fromRoot: skillDir.root,
    fromSourceId: skillDir.sourceId,
    targetDir,
    files: state.files.sort(),
    skipped: state.skipped,
    targetPreexisted,
  };
}

/**
 * 产物不含 SKILL.md → ConfigError(2)（**空安装**必须失败，不能登记成功）。
 *
 * 为什么修在这里而不是命令层：`--no-register` 路径也要被保护。空安装（源目录为空，
 * 或 SKILL.md 本身是 symlink 被 copyDirDeep 跳过）过去照样返回成功，命令层随即把
 * 名字登记进 skills.always；此后每次 `aforge sync` 都在 readSkillsToMaterialize
 * 抛「声明的 skill 未安装」(2)，而重跑 `skill add` 因冲突判据是「目标目录非空」
 * 也不会报冲突——依旧空装 + 幂等登记，用户只能手改 profile.yaml 才能自愈。
 *
 * 消息里带上 skipped 清单：symlink 项是"为什么复制出来是空的"的唯一线索（§10
 * 不跟随符号链接）。抛出后由 addSkill 的 catch 走 rollbackSkillCopy 撤销本次 copy。
 */
function assertSkillDocCopied(
  state: CopyState,
  name: string,
  targetDir: string,
  fromDir: string,
): void {
  if (state.files.includes(SKILL_DOC_FILENAME)) {
    return;
  }
  const skippedDoc = state.skipped.filter((entry) => entry.path.endsWith(SKILL_DOC_FILENAME));
  throw new ConfigError(
    `skill 安装产物不含 ${SKILL_DOC_FILENAME}: ${name}（源 ${fromDir}，复制了 ${state.files.length} 个文件）`,
    {
      hint:
        skippedDoc.length > 0
          ? `源里的 ${SKILL_DOC_FILENAME} 是符号链接，已按安全边界跳过（§10 不跟随 symlink）：把它替换为实体文件后重试`
          : `确认源目录 ${fromDir} 下有 ${SKILL_DOC_FILENAME}（sync 只物化该文件的正文）`,
      details: {
        name,
        targetDir,
        fromDir,
        files: state.files,
        skipped: state.skipped,
      },
    },
  );
}

/** 源 skill 目录定位结果。 */
interface SourceSkillDir {
  /** skill 目录（copy 源）。 */
  readonly dir: string;
  /** 源根目录（--from 参数解析出的根，供展示）。 */
  readonly root: string;
  /** 命中的登记源 id（非登记源直连时 undefined）。 */
  readonly sourceId: string | undefined;
}

/** 按 --from（源 id / 源根路径 / skill 目录直连）或缺省全源扫描，定位 skills/<name>/。 */
async function locateSourceSkillDir(
  ctx: SkillContext,
  name: string,
  from: string | undefined,
): Promise<SourceSkillDir> {
  const host = ctx.host;
  const mgr: SourceManagerContext = {
    host,
    env: ctx.env,
    userSoTRoot: ctx.userSoTRoot,
    cwd: ctx.cwd,
    os: ctx.os,
  };

  if (from !== undefined) {
    // a. 登记源 id
    const sources = await listSources(mgr);
    const matched = sources.find((s) => s.id === from);
    if (matched !== undefined) {
      const root = sourceRootDir(mgr, matched);
      const dir = path.join(root, SKILLS_DIRNAME, name);
      if (!(await host.exists(dir))) {
        throw new ConfigError(`源 ${from} 中不存在 skill: ${name}（查找 ${dir}）`, {
          hint: '运行 aforge skill list 查看源中可用的 skill',
          details: { from, name, dir },
        });
      }
      return { dir, root, sourceId: matched.id };
    }

    // b. 直连路径：先按“源根（其下 skills/<name>/）”解释，再按“skill 目录本身”解释
    const root = path.resolve(ctx.cwd, from);
    const asRoot = path.join(root, SKILLS_DIRNAME, name);
    if (await host.exists(asRoot)) {
      return { dir: asRoot, root, sourceId: undefined };
    }
    const skillDoc = path.join(root, SKILL_DOC_FILENAME);
    if (await host.exists(skillDoc)) {
      return { dir: root, root, sourceId: undefined };
    }
    throw new ConfigError(
      `--from 既不是登记源 id，也不是含 ${SKILLS_DIRNAME}/${name}/ 或 ${SKILL_DOC_FILENAME} 的目录: ${from}`,
      {
        hint: '运行 aforge source list 查看登记源；--from 传源 id 或源根目录路径',
        details: { from, triedRoot: asRoot, triedSkillDir: skillDoc },
      },
    );
  }

  // c. 缺省：按登记顺序找首个含该 skill 的源
  const sources = await listSources(mgr);
  for (const source of sources) {
    if (source.enabled === false) {
      continue;
    }
    const dir = path.join(sourceRootDir(mgr, source), SKILLS_DIRNAME, name);
    if (await host.exists(dir)) {
      return { dir, root: sourceRootDir(mgr, source), sourceId: source.id };
    }
  }
  throw new ConfigError(`所有已登记源中均未找到 skill: ${name}`, {
    hint: '先用 aforge source add 登记含该 skill 的源，或用 --from 指定源 id / 路径',
    details: { name, sources: sources.map((s) => s.id) },
  });
}

/**
 * skill 清单（SoT skills\ + 源 skills 清单）：
 * - SoT 侧列 skills\ 直接子目录名（project 层与 user 层分别标注，同名时
 *   两层都列出——project 优先生效，§5.3）；
 * - 源侧优先读 manifest（含 skills 数组则取其 name 字段；§4.5 已强约束
 *   name 必填非空，缺 name 的条目在 loadSourceManifest 就报 ConfigError(2)，
 *   不再像早期那样被静默跳过），无 manifest / 无 skills 字段时直接列源
 *   skills\ 目录名。
 */
export async function listSkills(ctx: SkillContext): Promise<SkillListItem[]> {
  const items: SkillListItem[] = [];

  for (const layer of [
    { origin: 'project', root: ctx.projectSoTRoot },
    { origin: 'user', root: ctx.userSoTRoot },
  ]) {
    for (const name of (
      await listDirSafe(ctx.host, path.join(layer.root, SKILLS_DIRNAME))
    ).sort()) {
      // 判类型用 stat（跟随 symlink）而非 copyDirDeep 的 lstat：本函数报告的是
      // "这一层 SoT 实际能提供什么"，而 readSkillsToMaterialize 取正文走
      // host.exists（fsp.access，跟随链接）。若此处改 lstat，用户手工 symlink 进
      // SoT 的 skill 会从 skill list 消失、却仍被 sync 物化——清单与投影脱节。
      const stat = await ctx.host
        .stat(path.join(layer.root, SKILLS_DIRNAME, name))
        .catch(() => undefined);
      if (stat?.isDirectory !== true) {
        continue; // 只列目录（fake host 无目录概念时按文件名略过）
      }
      items.push({ name, status: 'installed', origin: layer.origin });
    }
  }

  const mgr: SourceManagerContext = {
    host: ctx.host,
    env: ctx.env,
    userSoTRoot: ctx.userSoTRoot,
    cwd: ctx.cwd,
    os: ctx.os,
  };
  for (const source of await listSources(mgr)) {
    if (source.enabled === false) {
      continue;
    }
    const root = sourceRootDir(mgr, source);
    const manifest = await loadSourceManifest(mgr, source);
    const declared = manifest?.skills ?? [];
    const names =
      declared.length > 0
        ? declared.map((entry) => entry.name)
        : await listDirSafe(ctx.host, path.join(root, SKILLS_DIRNAME));
    for (const name of [...new Set(names)].sort()) {
      items.push({ name, status: 'available', origin: source.id });
    }
  }

  return items;
}

/**
 * 读取物化 skill 列表（sync 引擎数据源，§5.3 / Phase 2 `skills.on_demand`）。
 *
 * 实现搬到了 skill-materialize（那边管「sync 该投影哪些正文」，本模块管「把源里的
 * skill 目录搬进 SoT」，两件事的失败语义与安全边界完全不同）；这里原样再导出，
 * 既有调用点（engine / 测试）仍从 `core/sources/skill` 单点 import。
 */
export {
  injectOnDemandMarker,
  ON_DEMAND_FRONTMATTER_KEY,
  ON_DEMAND_FRONTMATTER_LINE,
  readSkillsToMaterialize,
  type SkillMaterializeSkip,
  type SkillMaterializeSkipReason,
  type SkillsToMaterialize,
  skillDocCandidates,
} from './skill-materialize';
