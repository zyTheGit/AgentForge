/**
 * learnings 存储层（Spec §4.3 / §7.4 / §7.5 / §10）。
 *
 * 布局：`<SoT>\learnings\<id>.yaml`（一文件一条，§3.1/§3.2 learnings\ 子目录）。
 * - YAML 序列化统一走 config/serialize.serializeYamlDoc（lineWidth: 0 禁止折行——
 *   长 content 不得被改写；补尾换行同源）；
 * - id 受 §4.3 正则约束（^[a-z0-9][a-z0-9_-]{1,63}$），该字符集天然排除
 *   Windows 非法文件名字符（<>:"/\|?*），自定义 id 时显式校验并给出可操作报错；
 * - CI 守卫（§10"不在 CI 中写入 learnings"）：env.CI 为真时 createLearning
 *   → ConfigError(2)；
 * - 重复检测（§7.5）：新 content 与现有未 promote 条目**高度相似**（trigram
 *   相似度 >= SIMILARITY_DUPLICATE）→ 结果携带 duplicateOf（仍创建，warning 由
 *   命令层输出）；中等相似 → similarTo（合并**建议**，绝不静默合并）；
 * - confidence：调用方未给值时走 scoring.scoreConfidence 自动打分（不再硬编码
 *   0.5），落盘的恒为 base 值 + confidence_source 标记。
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { atomicWrite } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import {
  type ConfidenceSource,
  type Learning,
  type LearningCategory,
  LearningIdPattern,
  LearningSchema,
  type PromoteTarget,
} from '../../schema';
import { serializeYamlDoc } from '../config/serialize';
import type { Scope } from '../env';
import { readEnv } from '../env';
import { ConfigError } from '../errors';
import { type ConfidenceScore, scoreConfidence } from './scoring';
import { findMostSimilar, type SimilarityCandidate, type SimilarityMatch } from './similarity';

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
  /** 置信度 0-1；**缺省走启发式自动打分**（scoring.scoreConfidence）。 */
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
  /**
   * 内容重复的既有未晋升条目 id（§7.5：仍创建，命令层输出 warning）。
   *
   * 判据是 trigram 相似度 >= SIMILARITY_DUPLICATE（全等自然满足），比原先的
   * `content` 全等宽松：改一个标点就绕过判重会让同一条约定攒出好几份。
   *
   * **best-effort**：判重与写入不在同一把锁内（createLearning 全程无 SoT 锁），
   * 并发 learn 时可能双方都判为"不重复"。这是有意的取舍——重复只影响一条提示，
   * 为它引入锁会让 `auto_capture: prompt` 下的会话内写入与人工 sync 争锁。
   */
  readonly duplicateOf: string | undefined;
  /**
   * 中等相似度（[SIMILARITY_SIMILAR, SIMILARITY_DUPLICATE)）的既有未晋升条目。
   *
   * **只提示、不阻断、不自动合并**：roadmap 的「非目标」排除无人值守的全自动晋升，
   * 合并两条学习同样是需要人看一眼的判断。命令层据此打印「与 <id> 相似度 N%，
   * 考虑合并」。
   */
  readonly similarTo: SimilarityMatch | undefined;
  /**
   * 自动打分的 breakdown（「为什么是这个分」）；调用方显式给了 confidence 时为
   * undefined —— 人给的值没有 breakdown 可言。
   */
  readonly confidenceScore: ConfidenceScore | undefined;
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
 * confidence 两条路径：
 * - 调用方给了值（`aforge learn --confidence 0.9` / 交互填写）→ 原样落盘，
 *   `confidence_source: manual`，**跳过**自动打分；
 * - 未给 → scoring.scoreConfidence 按内容与元数据算一个可解释的初始分，
 *   `confidence_source: auto`，breakdown 经 `confidenceScore` 带回命令层展示。
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

  // 相似度判重（§7.5）：只比未晋升条目——已 promote 的条目要合并得先回退产物，
  // 超出「给一条提示」的范围
  const candidates: SimilarityCandidate[] = [];
  for (const existing of await readLearningLayer(host, store.sotRoot)) {
    if (!existing.promoted) {
      candidates.push({ id: existing.id, content: existing.content });
    }
  }
  const match = findMostSimilar(input.content, candidates);
  const duplicateOf = match?.verdict === 'duplicate' ? match.id : undefined;
  const similarTo = match?.verdict === 'similar' ? match : undefined;

  // 默认值先解析出来再打分：打分只看落盘形态，scoreLearningConfidence 重算才能一致
  const scope: Scope = input.scope ?? 'project';
  const trigger = input.trigger ?? '';
  const category: LearningCategory = input.category ?? 'other';
  const promoteTarget: PromoteTarget = input.promoteTarget ?? 'custom_rule';
  const confidenceScore =
    input.confidence === undefined
      ? scoreConfidence({ content: input.content, trigger, category, scope, promoteTarget })
      : undefined;
  const confidenceSource: ConfidenceSource = confidenceScore === undefined ? 'manual' : 'auto';

  const now = host.now().toISOString();
  const learning: Learning = LearningSchema.parse({
    id,
    scope,
    confidence: input.confidence ?? confidenceScore?.value,
    confidence_source: confidenceSource,
    trigger,
    content: input.content,
    category,
    source: input.source ?? 'manual',
    created_at: now,
    updated_at: now,
    promoted: false,
    promoted_at: null,
    promote_target: promoteTarget,
  });

  await atomicWrite(host, file, serializeYamlDoc(learning));
  return { learning, file, duplicateOf, similarTo, confidenceScore };
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
    | 'trigger'
    | 'content'
    | 'category'
    | 'confidence'
    | 'confidence_source'
    | 'source'
    | 'scope'
    | 'promote_target'
  >
>;

/**
 * 更新单条 learning（updated_at 刷新为 now）。
 *
 * 改了 `confidence` 但没显式给 `confidence_source` → 自动标成 `manual`：值一旦被
 * 人改过，就不该再挂着 `auto` 让展示层解释成"启发式算出来的"。
 *
 * `updated_at` 前移会顺带**重置衰减**（decayConfidence 以它为锚点），这正是想要的
 * 语义：条目刚被复核过。
 *
 * @throws ConfigError(2) id 不存在 / 修改后校验失败。
 */
export async function updateLearning(
  store: LearningStore,
  id: string,
  patch: LearningPatch,
): Promise<Learning> {
  const current = await showLearning(store, id);
  const confidenceSource =
    patch.confidence_source ??
    (patch.confidence === undefined ? current.confidence_source : 'manual');
  const updated: Learning = LearningSchema.parse({
    ...current,
    ...patch,
    confidence_source: confidenceSource,
    updated_at: store.host.now().toISOString(),
  });
  await atomicWrite(store.host, learningFilePath(store.sotRoot, id), serializeYamlDoc(updated));
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
