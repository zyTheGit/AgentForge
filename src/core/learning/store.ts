/**
 * learnings 存储层（Spec §4.3 / §7.4 / §7.5 / §10）。
 *
 * 布局：`<SoT>\learnings\<id>.yaml`（一文件一条，§3.1/§3.2 learnings\ 子目录）。
 * - YAML 序列化用 yaml 包（lineWidth: 0 禁止折行——长 content 不得被改写）；
 * - id 受 §4.3 正则约束（^[a-z0-9][a-z0-9_-]{1,63}$），该字符集天然排除
 *   Windows 非法文件名字符（<>:"/\|?*），自定义 id 时显式校验并给出可操作报错；
 * - CI 守卫（§10"不在 CI 中写入 learnings"）：env.CI 为真时 createLearning
 *   → ConfigError(2)；
 * - 重复检测（§7.5）：新 content 与现有未 promote 条目相同 → 结果携带
 *   duplicateOf（仍创建，warning 由命令层输出）。
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from 'yaml';
import { atomicWrite, ensureTrailingNewline } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import {
  type Learning,
  type LearningCategory,
  LearningIdPattern,
  LearningSchema,
  type PromoteTarget,
} from '../../schema';
import type { Scope } from '../env';
import { readEnv } from '../env';
import { ConfigError } from '../errors';

/** Spec §3.1/§3.2：learnings 子目录名。 */
export const LEARNINGS_DIR = 'learnings';

/** learning 条目文件路径（`<SoT>\learnings\<id>.yaml`）。 */
export function learningFilePath(sotRoot: string, id: string): string {
  return path.join(sotRoot, LEARNINGS_DIR, `${id}.yaml`);
}

/**
 * 自动生成 learning id（§7.5：id 由系统自动生成，符合 §4.3 正则）。
 * 形如 `l20260821043011-3fa2b1`（UTC 时间戳 + 随机后缀），恒满足
 * ^[a-z0-9][a-z0-9_-]{1,63}$。
 */
export function generateId(now: Date = new Date()): string {
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}` +
    `${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}`;
  return `l${stamp}-${randomBytes(3).toString('hex')}`;
}

/**
 * 校验 learning id（§4.3 正则 + Windows 非法文件名字符 §4.3 末行）。
 * 正则字符集（a-z0-9_-）已排除全部非法字符，此处仍分别报错以给出精确 hint。
 * @throws ConfigError(2) id 非法。
 */
export function validateLearningId(id: string): void {
  if (/[<>:"/\\|?*]/.test(id)) {
    throw new ConfigError(`learning id 含 Windows 非法文件名字符: ${id}`, {
      hint: 'id 仅可包含 a-z、0-9、下划线与连字符（<>:"/\\|?* 均不允许）',
      details: { id },
    });
  }
  if (!LearningIdPattern.test(id)) {
    throw new ConfigError(
      `非法 learning id: ${id}（须以小写字母或数字开头，长度 2-64，仅含 a-z0-9_-）`,
      {
        hint: '省略 --id 让系统自动生成，或改用符合 ^[a-z0-9][a-z0-9_-]{1,63}$ 的 id',
        details: { id },
      },
    );
  }
}

/** learning 存储句柄：目标 SoT 根 + 注入 host（测试可换 fake host）。 */
export interface LearningStore {
  readonly host: Host;
  readonly sotRoot: string;
}

/** createLearning 输入：content 必填，其余可选（缺省见各字段注释）。 */
export interface CreateLearningInput {
  /** 学习内容正文（§4.3 content）。 */
  readonly content: string;
  /** 触发场景；缺省 ''。 */
  readonly trigger?: string;
  /** 分类；缺省 'other'。 */
  readonly category?: LearningCategory;
  /** 置信度 0-1；缺省 0.5。 */
  readonly confidence?: number;
  /** 来源标识；缺省 'manual'。 */
  readonly source?: string;
  /** 自定义 id；缺省系统生成（§7.5）。 */
  readonly id?: string;
  /** 所属层级；缺省 'project'（§4.3 scope）。 */
  readonly scope?: Scope;
  /** 晋升目标；缺省 'custom_rule'（schema 默认）。 */
  readonly promoteTarget?: PromoteTarget;
}

/** createLearning 结果。 */
export interface CreateLearningResult {
  readonly learning: Learning;
  readonly file: string;
  /** 内容重复的既有未晋升条目 id（§7.5：仍创建，命令层输出 warning）。 */
  readonly duplicateOf: string | undefined;
}

/** learning 条目 YAML 序列化（lineWidth 0：长 content 不折行，保证往返一致）。 */
function serializeLearning(learning: Learning): string {
  return ensureTrailingNewline(stringifyYaml(learning, { lineWidth: 0 }));
}

/**
 * 读取一层 SoT 的全部 learning 条目（按文件名序）。
 * 目录不存在 → []（未 learn 过是正常态）；文件损坏 → ConfigError(2)
 * （§6.1：配置/校验错误 fail-fast，不静默跳过坏数据）。
 */
export async function readLearningLayer(host: Host, sotRoot: string): Promise<Learning[]> {
  const dir = path.join(sotRoot, LEARNINGS_DIR);
  let entries: readonly string[];
  try {
    entries = await host.listDir(dir);
  } catch {
    return [];
  }

  const learnings: Learning[] = [];
  for (const name of [...entries].sort()) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) {
      continue;
    }
    const file = path.join(dir, name);
    learnings.push(parseLearningText(file, await host.readFile(file)));
  }
  return learnings;
}

/** 文本 → Learning（YAML 解析 + schema 校验，错误统一映射 ConfigError(2)）。 */
export function parseLearningText(file: string, text: string): Learning {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      throw new ConfigError(`learning 文件不是合法的 YAML: ${file}: ${err.message}`, {
        hint: '修正或删除该文件后重试（aforge learnings show 查看内容）',
        details: { file, message: err.message },
      });
    }
    throw err;
  }
  return validateLearningData(raw, file);
}

/** 校验 unknown → Learning（schema 校验失败 → ConfigError(2)，附字段路径）。 */
function validateLearningData(data: unknown, file: string): Learning {
  const result = LearningSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues;
    const lines = issues.map(
      (issue) =>
        `  - ${issue.path.filter((s) => typeof s !== 'symbol').join('.') || '(根)'}: ${issue.message}`,
    );
    throw new ConfigError(
      `learning 文件校验失败（${file}），共 ${issues.length} 处问题:\n${lines.join('\n')}`,
      {
        hint: '按 §4.3 字段结构修正该文件，或删除后重新 aforge learn',
        details: { file, issues },
      },
    );
  }
  return result.data;
}

/** 读取并校验单个 learning 文件（不存在 → null；损坏 → ConfigError(2)）。 */
export async function readLearningFile(host: Host, file: string): Promise<Learning | null> {
  if (!(await host.exists(file))) {
    return null;
  }
  return parseLearningText(file, await host.readFile(file));
}

/**
 * 创建 learning 条目（§7.4：写入 learnings/，不自动进入投影）。
 *
 * @throws ConfigError(2) CI 为真（§10 禁写）/ id 非法 / 既有文件同名；
 * @throws PermissionError(4) 写入失败（权限域，atomicWrite 映射）。
 */
export async function createLearning(
  store: LearningStore,
  input: CreateLearningInput,
): Promise<CreateLearningResult> {
  const { host } = store;

  // CI 守卫（§10：不在 CI 中写入 learnings）——创建是唯一的 learnings 写入口径
  if (readEnv(host).ci) {
    throw new ConfigError('CI 环境禁止写入 learnings（检测到 CI=true）', {
      hint: 'CI 环境禁写 learnings；请在本地执行 aforge learn',
      details: { sotRoot: store.sotRoot },
    });
  }

  const id = input.id ?? generateId(host.now());
  validateLearningId(id);

  const file = learningFilePath(store.sotRoot, id);
  if (await host.exists(file)) {
    throw new ConfigError(`learning id 已存在: ${id}（${file}）`, {
      hint: '换一个 --id 或省略让系统自动生成',
      details: { id, file },
    });
  }

  // 重复检测（§7.5）：同 content 的未晋升条目 → 仍创建但报告 duplicateOf
  let duplicateOf: string | undefined;
  for (const existing of await readLearningLayer(host, store.sotRoot)) {
    if (!existing.promoted && existing.content === input.content) {
      duplicateOf = existing.id;
      break;
    }
  }

  const now = host.now().toISOString();
  const learning: Learning = LearningSchema.parse({
    id,
    scope: input.scope ?? 'project',
    confidence: input.confidence ?? 0.5,
    trigger: input.trigger ?? '',
    content: input.content,
    category: input.category ?? 'other',
    source: input.source ?? 'manual',
    created_at: now,
    updated_at: now,
    promoted: false,
    promoted_at: null,
    promote_target: input.promoteTarget ?? 'custom_rule',
  });

  await atomicWrite(host, file, serializeLearning(learning));
  return { learning, file, duplicateOf };
}

/** 列出一层 SoT 的全部 learning（按文件名序）。 */
export async function listLearnings(store: LearningStore): Promise<Learning[]> {
  return readLearningLayer(store.host, store.sotRoot);
}

/**
 * 读取单条 learning。
 * @throws ConfigError(2) id 不存在（§6.1：learning id 不存在 → 退出码 2）。
 */
export async function showLearning(store: LearningStore, id: string): Promise<Learning> {
  const file = learningFilePath(store.sotRoot, id);
  const learning = await readLearningFile(store.host, file);
  if (learning === null) {
    throw new ConfigError(`learning 不存在: ${id}`, {
      hint: '运行 aforge learnings list 查看全部条目',
      details: { id, file },
    });
  }
  return learning;
}

/** updateLearning 的可修改字段（管理字段 id/created_at/promoted* 不可改）。 */
export type LearningPatch = Partial<
  Pick<
    Learning,
    'trigger' | 'content' | 'category' | 'confidence' | 'source' | 'scope' | 'promote_target'
  >
>;

/**
 * 更新单条 learning（updated_at 刷新为 now）。
 * @throws ConfigError(2) id 不存在 / 修改后校验失败。
 */
export async function updateLearning(
  store: LearningStore,
  id: string,
  patch: LearningPatch,
): Promise<Learning> {
  const current = await showLearning(store, id);
  const updated: Learning = LearningSchema.parse({
    ...current,
    ...patch,
    updated_at: store.host.now().toISOString(),
  });
  await atomicWrite(store.host, learningFilePath(store.sotRoot, id), serializeLearning(updated));
  return updated;
}

/**
 * 删除单条 learning 文件。
 * @throws ConfigError(2) id 不存在。
 */
export async function removeLearning(
  store: LearningStore,
  id: string,
): Promise<{ id: string; file: string }> {
  const file = learningFilePath(store.sotRoot, id);
  if (!(await store.host.exists(file))) {
    throw new ConfigError(`learning 不存在: ${id}`, {
      hint: '运行 aforge learnings list 查看全部条目',
      details: { id, file },
    });
  }
  await store.host.rm(file);
  return { id, file };
}
