/**
 * 生成物 .gitignore 段（Spec §4.2 projection.gitignore_generated）。
 *
 * 段内全量重算 → 幂等；段外用户条目保留。写入仍在 sync 事务内（备份 / 回滚一视同仁），
 * 但**不写入 sync-meta**：sync-meta.targets 的 contentHash 是 doctor 的规则正文区间
 * 基准，.gitignore 没有对应的正文区间可比。
 */
import path from 'node:path';
import { longPathAware, type OsContext, pathApiFor, toPosixSeparators } from '../paths';
import {
  SYNC_BACKUP_DIRNAME,
  SYNC_BACKUP_FAILED_PREFIX,
  SYNC_LOCK_DIRNAME,
} from './sync-artifacts';
import type { ProjectionPlan, ProjectionPlanItem } from './types';
import { DEFAULT_PROJECTION_MARKERS, type ProjectionMarkers } from './writer';

// ---------------------------------------------------------------------------
// .gitignore 投影（Spec §4.2 projection.gitignore_generated）
// ---------------------------------------------------------------------------

/** 项目根下的 .gitignore 文件名。 */
export const GITIGNORE_FILE = '.gitignore';

/**
 * .gitignore 在 SyncResult 里的伪 target id（不属于 ALL_TARGET_IDS，
 * 也不写 sync-meta.targets——仅用于命令层输出标注）。
 */
export const GITIGNORE_TARGET_ID = 'gitignore';

/**
 * .gitignore 内的 AgentForge 标记段（`#` 注释前缀——`.gitignore` 不支持 HTML
 * 注释，故不能复用 profile.projection 的 markdown marker）。段外用户条目原样保留，
 * 段内每次 sync 全量重算 → 幂等。
 */
export const GITIGNORE_MARKER_BEGIN = '# BEGIN AGENTFORGE';
export const GITIGNORE_MARKER_END = '# END AGENTFORGE';

/** .gitignore 写入用的标记对（只用 begin/end；action 恒为 merge_marker）。 */
export const GITIGNORE_MARKERS: ProjectionMarkers = {
  ...DEFAULT_PROJECTION_MARKERS,
  begin: GITIGNORE_MARKER_BEGIN,
  end: GITIGNORE_MARKER_END,
  mode: 'replace_between_markers',
};

/** 投影路径 → 根锚定的 gitignore 模式（`/AGENTS.md`、`/.codex/config.toml`）。 */
export function gitignorePattern(
  target: string,
  projectRoot: string,
  os: OsContext,
): string | undefined {
  const api = pathApiFor(os);
  const rel = api.relative(projectRoot, target);
  if (rel === '' || rel.startsWith('..') || api.isAbsolute(rel)) {
    return undefined; // 项目根之外（user scope 投影 / CODEX_HOME 覆盖）：不进 .gitignore
  }
  return `/${toPosixSeparators(rel)}`;
}

/**
 * AgentForge 自身的运行时产物在 SoT 根下的根锚定目录模式（事务锁 / 备份 /
 * 回滚失败保留副本）。
 *
 * 为什么必须一并忽略：`<sotRoot>/.sync.lock/` 与 `<sotRoot>/.agf-backup/` 在 sync
 * 期间存在，`.agf-backup-failed-<ts>/` 在回滚不完整时会长期保留——三者都是**本机
 * 进程态 / 单机备份**，提交进仓库不仅无意义，还会让 clone 到别的机器上的仓库带着
 * 一个"别人的锁目录"，本机 sync 会据此误判有并发写入而拒绝执行。
 *
 * @returns 落在项目根内时的模式列表；SoT 根在项目根之外（user scope /
 *          AGF_HOME 指向别处）时为空数组——判据与投影产物共用 gitignorePattern。
 */
export function runtimeGitignorePatterns(
  sotRoot: string,
  projectRoot: string,
  os: OsContext,
): string[] {
  const api = pathApiFor(os);
  const names = [SYNC_LOCK_DIRNAME, SYNC_BACKUP_DIRNAME, `${SYNC_BACKUP_FAILED_PREFIX}*`];
  const patterns: string[] = [];
  for (const name of names) {
    const pattern = gitignorePattern(api.join(sotRoot, name), projectRoot, os);
    if (pattern !== undefined) {
      patterns.push(`${pattern}/`); // 目录形式：只忽略目录，同名文件不受影响
    }
  }
  return patterns;
}

/**
 * 构造 .gitignore 投影项（Spec §4.2 projection.gitignore_generated=true 时）。
 *
 * 收集全部 target 的投影产物路径 + AgentForge 自身的运行时产物（见
 * runtimeGitignorePatterns）→ 只取落在项目根内的 → 转根锚定 posix 模式
 * （`.gitignore` 的分隔符恒为 `/`，与 projection.path_style 无关）→ 去重排序。
 *
 * @returns 投影项；无任何项目内产物时 undefined（不写空标记段）。
 */
export function buildGitignoreItem(
  planned: readonly { readonly plan: ProjectionPlan }[],
  projectRoot: string,
  sotRoot: string,
  os: OsContext,
): ProjectionPlanItem | undefined {
  const patterns = new Set<string>();
  for (const target of planned) {
    for (const item of target.plan.items) {
      const pattern = gitignorePattern(item.path, projectRoot, os);
      if (pattern !== undefined) {
        patterns.add(pattern);
      }
    }
  }
  for (const pattern of runtimeGitignorePatterns(sotRoot, projectRoot, os)) {
    patterns.add(pattern);
  }
  if (patterns.size === 0) {
    return undefined;
  }
  return {
    path: longPathAware(path.join(projectRoot, GITIGNORE_FILE), os),
    action: 'merge_marker',
    content: [...patterns].sort().join('\n'),
  };
}
