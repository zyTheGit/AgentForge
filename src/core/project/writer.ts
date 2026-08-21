/**
 * 投影动作执行器（Spec §8.1 / §8.2）：把 ProjectionPlanItem 落盘。
 *
 * 所有 IO 经注入 Host + infra/fsutil（原子写 / mkdirp / 权限错误映射），writer 不直接
 * 触碰 node:fs。四种动作：
 * - write：mkdirp 目标目录 → 原子写（换行按 lineEnding，Spec §2.5）；
 * - merge_marker：读现有（不存在 → 新建）→ replaceBetween（marker 外保留，§8.2）→ 原子写；
 * - merge_json：读现有 JSON 深合并（未知键保留、AgentForge 管理键覆盖，§8.2）→ 原子写；
 * - merge_toml：按 `# BEGIN AGENTFORGE` / `# END AGENTFORGE` 文本标记段替换
 *   （复用 markers 逻辑换前缀，§8.4）→ 原子写。
 *
 * dry-run 不在此层：engine 只在非 dry-run 时调用 applyItem（dryRunItem 描述意图）。
 */
import path from 'node:path';
import { atomicWrite, isPermissionErrno, mkdirp, normalizeLineEnding } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import type { LineEnding } from '../env';
import { ConflictError, GenericError, PermissionError } from '../errors';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END, replaceBetween } from '../markers';
import type { ProjectionAction, ProjectionPlanItem } from './types';

/** Spec §8.4：TOML 标记段（M8 codex 用 `# BEGIN AGENTFORGE MCP` 变体，经参数覆盖）。 */
export const TOML_MARKER_BEGIN = '# BEGIN AGENTFORGE';
export const TOML_MARKER_END = '# END AGENTFORGE';

/** 各 merge 动作使用的标记对（marker 模式下由 profile.projection 决定）。 */
export interface ProjectionMarkers {
  /** merge_marker 用的区间标记（profile.projection.marker_begin/end）。 */
  readonly begin: string;
  readonly end: string;
  /** merge_toml 用的文本标记段前缀。 */
  readonly tomlBegin: string;
  readonly tomlEnd: string;
}

export const DEFAULT_PROJECTION_MARKERS: ProjectionMarkers = {
  begin: DEFAULT_MARKER_BEGIN,
  end: DEFAULT_MARKER_END,
  tomlBegin: TOML_MARKER_BEGIN,
  tomlEnd: TOML_MARKER_END,
};

/** 读现有投影文件：不存在 → ''（新建语义）；权限失败 → PermissionError(4)。 */
async function readExisting(host: Host, file: string): Promise<string> {
  if (!(await host.exists(file))) {
    return '';
  }
  try {
    return await host.readFile(file);
  } catch (err) {
    if (isPermissionErrno(err)) {
      throw new PermissionError(`无法读取现有投影文件: ${file}`, {
        hint: '检查文件的读权限与所在目录 ACL（必要时以管理员身份运行）',
        details: err,
      });
    }
    throw err;
  }
}

/**
 * M6 事务备份读取：现有内容；不存在 → null（回滚时“删除新建文件”的判据）。
 * 权限失败 → PermissionError(4)（备份阶段即 fail-fast，此时尚未写入任何文件）。
 */
export async function readExistingForBackup(host: Host, file: string): Promise<string | null> {
  if (!(await host.exists(file))) {
    return null;
  }
  try {
    return await host.readFile(file);
  } catch (err) {
    if (isPermissionErrno(err)) {
      throw new PermissionError(`无法读取现有投影文件（备份阶段）: ${file}`, {
        hint: '检查文件的读权限与所在目录 ACL（必要时以管理员身份运行）',
        details: err,
      });
    }
    throw err;
  }
}

/** mkdirp 目标目录 + 原子写（统一出口：保证四个动作的目录创建与换行语义一致）。 */
async function writeNormalized(
  host: Host,
  file: string,
  content: string,
  lineEnding: LineEnding,
): Promise<void> {
  await mkdirp(host, path.dirname(file));
  await atomicWrite(host, file, normalizeLineEnding(content, lineEnding));
}

// ---------------------------------------------------------------------------
// merge_json：深合并（Spec §8.2——只改 AgentForge 管理的键，未知键保留）
// ---------------------------------------------------------------------------

/** 纯数据对象判断（数组 / null 排除）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 深合并单值：两边均为对象 → 递归；否则 managed 覆盖（数组 / 标量整体替换）。 */
function deepMergeValue(current: unknown, managed: unknown): unknown {
  if (isPlainObject(current) && isPlainObject(managed)) {
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(managed)) {
      merged[key] = deepMergeValue(merged[key], value);
    }
    return merged;
  }
  return managed;
}

/**
 * JSON 深合并：item.content（AgentForge 管理键，JSON 文本）合并进现有文件内容。
 *
 * - 现有不存在 / 空文本 → 直接以管理键为全文；
 * - 现有 JSON 损坏 / 顶层非对象（数组、标量）→ ConflictError(3)：目标配置文件
 *   需人工处理，AgentForge 不覆盖用户的非预期内容；
 * - 管理键载荷非法（projector 产出坏 JSON / 非对象）→ GenericError(1)：内部错误。
 *
 * @returns 合并后的 JSON 文本（2 空格缩进 + 末尾换行，LF 基准——换行由调用方统一）。
 */
export function mergeJsonContent(existing: string, managedJson: string, file: string): string {
  let managed: unknown;
  try {
    managed = JSON.parse(managedJson);
  } catch (err) {
    throw new GenericError(`投影计划中的 JSON 载荷不合法: ${file}`, {
      hint: '这是 AgentForge 内部错误，请升级到最新版本后重试；持续出现请提交 issue',
      details: { file, managedJson, error: err },
    });
  }
  if (!isPlainObject(managed)) {
    throw new GenericError(`投影计划中的 JSON 载荷必须是对象: ${file}`, {
      hint: '这是 AgentForge 内部错误，请升级到最新版本后重试；持续出现请提交 issue',
      details: { file, managedJson },
    });
  }

  let current: unknown = {};
  if (existing.trim() !== '') {
    try {
      current = JSON.parse(existing);
    } catch (err) {
      throw new ConflictError(`现有 JSON 文件无法解析，跳过合并: ${file}`, {
        hint: '手动修复或删除该文件后重新执行 aforge sync（AgentForge 不会覆盖无法解析的内容）',
        details: { file, error: err },
      });
    }
    if (!isPlainObject(current)) {
      throw new ConflictError(`现有 JSON 文件顶层不是对象，无法合并: ${file}`, {
        hint: `手动把顶层调整为 JSON 对象（或删除该文件）后重新执行 aforge sync`,
        details: { file, current },
      });
    }
  }

  const merged = deepMergeValue(current, managed) as Record<string, unknown>;
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * 执行单个投影项（Spec §7.3 步骤 4 的 apply；目录自动创建见 writeNormalized）。
 *
 * 幂等快速路径（M6，Spec §7.3 稳定性前提）：目标文件已是将写入的最终形态
 * （含换行风格，逐字节比对落盘形态）时跳过写入，返回 false；否则落盘并返回 true。
 * 注意比较基准是 normalizeLineEnding(merged, lineEnding)——现有文件仅换行风格不同
 * 时不跳过（重写并统一为 profile 声明的换行，Spec §2.5“整个文件按换行设置写出”）。
 *
 * @param markers merge 系动作使用的标记对（默认 markdown marker + TOML 标记段）。
 * @returns 是否实际写入（false = 内容未变跳写）。
 * @throws PermissionError(4) 目标路径无写权限 / 读现有文件无权限（Spec §7.3）。
 * @throws ConflictError(3) merge_json 的现有文件损坏或无法合并。
 */
export async function applyItem(
  host: Host,
  item: ProjectionPlanItem,
  lineEnding: LineEnding,
  markers: ProjectionMarkers = DEFAULT_PROJECTION_MARKERS,
): Promise<boolean> {
  const existing = await readExisting(host, item.path);
  const merged = computeItemContent(item, existing, markers);

  if (existing !== '' && existing === normalizeLineEnding(merged, lineEnding)) {
    return false;
  }

  await writeNormalized(host, item.path, merged, lineEnding);
  return true;
}

/**
 * 计算单个投影项的最终内容（纯函数，LF 基准；换行由落盘层统一）。
 * 引擎的备份/跳写/回滚判断与 applyItem 共用同一计算（单一事实源）。
 */
export function computeItemContent(
  item: ProjectionPlanItem,
  existing: string,
  markers: ProjectionMarkers = DEFAULT_PROJECTION_MARKERS,
): string {
  switch (item.action) {
    case 'write':
      return item.content;

    case 'merge_marker':
      return replaceBetween(existing, item.content, markers.begin, markers.end);

    case 'merge_json':
      return mergeJsonContent(existing, item.content, item.path);

    case 'merge_toml':
      return replaceBetween(existing, item.content, markers.tomlBegin, markers.tomlEnd);
  }
}

/** dry-run 用的动作描述（纯函数，不落盘）。 */
const ACTION_LABELS: Record<ProjectionAction, string> = {
  write: 'write',
  merge_marker: 'merge (marker)',
  merge_json: 'merge (json)',
  merge_toml: 'merge (toml)',
};

/** 描述一个投影项将做什么（`merge (marker): <绝对路径>`）。 */
export function dryRunItem(item: ProjectionPlanItem): string {
  return `${ACTION_LABELS[item.action]}: ${item.path}`;
}
