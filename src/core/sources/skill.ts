/**
 * skill 安装与清单（Spec §7.6 / §5.3 / §11.2.6）。
 *
 * - addSkill：从源（local 路径 / git store）**实体 copy** 到目标层 SoT
 *   `skills\<name\>\`（递归目录；非 symlink，§7.6 Windows 默认；写入为独立
 *   文件——修改 SoT 副本不影响源）。目标已存在 → ConflictError(3)；
 * - listSkills：目标层 SoT skills\ + 各源 skills 清单（源侧直接列目录名，
 *   manifest.skills 为 loose 结构不作强约束）；
 * - readSkillsToMaterialize：sync 引擎的物化数据源（§5.3 同名优先级
 *   project SoT > user SoT；profile.skills.always 逐名取 SKILL.md）。
 *
 * copy 经 Host 的 readFile/writeFile（UTF-8 文本域）；二进制文件不属于
 * M8 支持范围（skill 以 Markdown 说明为主，§10 投影只 copy 不执行）。
 */
import path from 'node:path';
import type { Host } from '../../infra/host';
import { atomicWrite, mkdirp } from '../../infra/fsutil';
import type { EnvSnapshot } from '../env';
import { ConfigError, ConflictError } from '../errors';
import { resolveProjectSoT, resolveUserSoT, type OsContext } from '../paths';
import type { Profile } from '../../schema';
import type { SkillArtifact } from '../project/types';
import { listSources, loadSourceManifest, sourceRootDir, type SourceManagerContext } from './manager';

/** skill 名安全校验（目录名）：字母数字开头，可含字母数字/./_/-，总长 ≤64。 */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** skill 说明文件名（各 target 统一约定，projectors/claude.ts 同源）。 */
export const SKILL_DOC_FILENAME = 'SKILL.md';

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
}

/** 清单项。 */
export interface SkillListItem {
  readonly name: string;
  /** installed：SoT skills\ 已安装；available：仅在源中。 */
  readonly status: 'installed' | 'available';
  /** installed 项的所在层（project / user）；available 项为来源源 id。 */
  readonly origin: string;
}

/** 校验 skill 名（目录名安全）。@throws ConfigError(2) 名字非法。 */
export function validateSkillName(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new ConfigError(
      `非法 skill 名: ${name}（须以字母或数字开头，长度 1-64，仅含字母数字、点、下划线、连字符）`,
      {
        hint: 'skill 名同时是 SoT 下的目录名（skills/<name>/），不能包含路径分隔符等字符',
        details: { name },
      },
    );
  }
}

/** 列出某目录的直接子项（目录不存在 → []）。 */
async function listDirSafe(host: Host, dir: string): Promise<string[]> {
  try {
    return await host.listDir(dir);
  } catch {
    return [];
  }
}

/**
 * 递归 copy：from → to（from 不存在 → ConfigError；to 预先不存在）。
 * rel 为当前目录相对**顶层目标**的相对路径前缀（返回的 files 路径基准）。
 */
async function copyDirDeep(
  host: Host,
  from: string,
  to: string,
  rel: string,
  acc: string[],
): Promise<void> {
  await mkdirp(host, to);
  for (const entry of [...(await listDirSafe(host, from))].sort()) {
    const src = path.join(from, entry);
    const dst = path.join(to, entry);
    const relEntry = rel === '' ? entry : `${rel}${path.sep}${entry}`;
    let stat;
    try {
      stat = await host.stat(src);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory === true) {
      await copyDirDeep(host, src, dst, relEntry, acc);
    } else {
      // 文本 copy（实体文件，非 symlink：Host 无 symlink 语义，恒为独立副本）
      await atomicWrite(host, dst, await host.readFile(src));
      acc.push(relEntry);
    }
  }
}

/**
 * 安装 skill（§7.6 skill add = copy 到 SoT skills\）。
 *
 * @param from 源标识：登记的源 id、或源根目录路径（其下 skills\<name\>\）、
 *        或直接指向 skill 目录本身（含 SKILL.md）的路径。缺省时按登记顺序
 *        在全部源中找首个含该 skill 的源。
 * @throws ConfigError(2) 名字非法 / 源或 skill 不存在；
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
  const targetDir = path.join(ctx.targetSoTRoot, 'skills', name);
  const existing = await listDirSafe(ctx.host, targetDir);
  if (existing.length > 0) {
    throw new ConflictError(`skill 已存在: ${targetDir}（${existing.length} 个文件）`, {
      hint: '先删除该目录（或 aforge learnings/skill 管理入口移除）后再安装；已安装 skill 以 SoT 为准（§5.3）',
      details: { name, targetDir, existing },
    });
  }

  // 3. 实体 copy（递归）
  const files: string[] = [];
  await copyDirDeep(ctx.host, skillDir.dir, targetDir, '', files);

  return {
    name,
    fromRoot: skillDir.root,
    fromSourceId: skillDir.sourceId,
    targetDir,
    files: files.sort(),
  };
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
  };

  if (from !== undefined) {
    // a. 登记源 id
    const sources = await listSources(mgr);
    const matched = sources.find((s) => s.id === from);
    if (matched !== undefined) {
      const root = sourceRootDir(mgr, matched);
      const dir = path.join(root, 'skills', name);
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
    const asRoot = path.join(root, 'skills', name);
    if (await host.exists(asRoot)) {
      return { dir: asRoot, root, sourceId: undefined };
    }
    const skillDoc = path.join(root, SKILL_DOC_FILENAME);
    if (await host.exists(skillDoc)) {
      return { dir: root, root, sourceId: undefined };
    }
    throw new ConfigError(
      `--from 既不是登记源 id，也不是含 skills/${name}/ 或 ${SKILL_DOC_FILENAME} 的目录: ${from}`,
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
    const dir = path.join(sourceRootDir(mgr, source), 'skills', name);
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
 * - 源侧优先读 manifest（含 skills 数组则取其 name 字段；loose 结构），
 *   无 manifest / 无 skills 字段时直接列源 skills\ 目录名。
 */
export async function listSkills(ctx: SkillContext): Promise<SkillListItem[]> {
  const items: SkillListItem[] = [];

  for (const layer of [
    { origin: 'project', root: ctx.projectSoTRoot },
    { origin: 'user', root: ctx.userSoTRoot },
  ]) {
    for (const name of (await listDirSafe(ctx.host, path.join(layer.root, 'skills'))).sort()) {
      const stat = await ctx.host.stat(path.join(layer.root, 'skills', name)).catch(() => undefined);
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
        ? declared
            .map((s) => (typeof (s as { name?: unknown }).name === 'string' ? (s as { name: string }).name : ''))
            .filter((n) => n !== '')
        : await listDirSafe(ctx.host, path.join(root, 'skills'));
    for (const name of [...new Set(names)].sort()) {
      items.push({ name, status: 'available', origin: source.id });
    }
  }

  return items;
}

/**
 * 读取物化 skill 列表（sync 引擎数据源，§5.3：project SoT > user SoT）。
 * 仅消费 SKILL.md 正文（projector 产出 write 项；附属文件 M8 不投影）。
 *
 * @throws ConfigError(2) profile.skills.always 声明的名字两层均不存在
 *         （声明但未安装，fail-fast 同“未解析的 template id”语义）。
 */
export async function readSkillsToMaterialize(
  host: Host,
  userSoTRoot: string,
  projectSoTRoot: string,
  profile: Profile,
): Promise<SkillArtifact[]> {
  const names = profile.skills.always ?? [];
  const artifacts: SkillArtifact[] = [];

  for (const name of names) {
    const candidates = [
      path.join(projectSoTRoot, 'skills', name, SKILL_DOC_FILENAME),
      path.join(userSoTRoot, 'skills', name, SKILL_DOC_FILENAME),
    ];
    let content: string | undefined;
    for (const file of candidates) {
      if (await host.exists(file)) {
        content = await host.readFile(file);
        break;
      }
    }
    if (content === undefined) {
      throw new ConfigError(`profile.skills.always 声明的 skill 未安装: ${name}`, {
        hint: '运行 aforge skill add 安装，或从 profile.yaml 的 skills.always 中移除该名字',
        details: { name, candidates },
      });
    }
    artifacts.push({ name, content });
  }
  return artifacts;
}
