/**
 * learning 的 confidence 启发式：**创建时自动打分** + **读时时间衰减**。
 *
 * 两条架构约束，改动前请先读：
 *
 * 1. **纯函数 + 显式时间入参**。本模块不读系统时钟、不碰 IO；`now` 一律由调用方
 *    从 `host.now()` 注入（与 store.generateId(now) 同一风格）。否则打分与衰减不可
 *    稳定测试，投影产物的 contentHash 也会随机器时间漂移。
 * 2. **只有 base 值落盘，effective 值读时算**。衰减**不**改写 `learnings/*.yaml`：
 *    一条学习每被 list 一次就重写一遍文件是纯粹的写放大，会把 SoT 的 git diff 变成
 *    噪声，还会和 sync / promote 抢锁。持久化的 `confidence` 恒为 base，展示层调
 *    `decayConfidence` 得到 effective。
 *
 * 打分信号（各自一个纯函数，权重见 CONFIDENCE_WEIGHTS，合计 1.0）：
 * - `length`     正文长度是否落在"说清一件事"的区间；
 * - `actionable` 是否含可照抄的执行信息（代码块 / 行内 code / 已知命令名）；
 * - `reference`  是否引用了具体文件或路径；
 * - `directive`  是否是一条**规范性**表述（必须 / 禁止 / prefer / never …）；
 * - `metadata`   trigger / category / promote_target 是否已明确（非默认值）；
 * - `scope`      project 比 user 更具体、更可验证。
 *
 * 打分**只看已落盘的字段**（含默认值解析后的形态），因此 scoreLearningConfidence
 * 对一条既有条目重算的 breakdown 与它创建时的完全一致——breakdown 是派生量，故
 * 刻意**不**持久化（权重一改，落盘的旧 breakdown 就全部过期）。
 */

import type { LearningCategory, PromoteTarget } from '../../schema';
import type { Scope } from '../env';

/** 打分信号 id（输出顺序即 CONFIDENCE_WEIGHTS 的声明顺序）。 */
export type ConfidenceSignalId =
  | 'length'
  | 'actionable'
  | 'reference'
  | 'directive'
  | 'metadata'
  | 'scope';

/**
 * 各信号权重（合计恒为 1.0，由单测卡住）。
 *
 * 取值理由：`actionable` 最高——"能照抄执行"是 learning 有没有用的第一判据；
 * `metadata` 次之，因为 trigger / category 是人**主动**填的，比任何文本特征都更能
 * 说明这条被认真对待过；`scope` 最低，它只是个弱先验，不该盖过内容本身。
 */
export const CONFIDENCE_WEIGHTS: Readonly<Record<ConfidenceSignalId, number>> = {
  length: 0.2,
  actionable: 0.25,
  reference: 0.15,
  directive: 0.1,
  metadata: 0.2,
  scope: 0.1,
};

/** 自动分的下限：启发式再差也不该断言"完全不可信"。 */
export const AUTO_SCORE_FLOOR = 0.2;

/** 自动分的上限：启发式再好也不该断言"几乎确定"——那是人给 `--confidence` 的事。 */
export const AUTO_SCORE_CEILING = 0.9;

/** 单个信号的打分结果（reason 为可直接打印的中文解释）。 */
export interface ConfidenceSignal {
  readonly id: ConfidenceSignalId;
  readonly weight: number;
  /** 该信号的得分 [0,1]。 */
  readonly score: number;
  readonly reason: string;
}

/** 打分结果（value 为最终 confidence，signals 为「为什么是这个分」）。 */
export interface ConfidenceScore {
  /** 最终自动分，落在 [AUTO_SCORE_FLOOR, AUTO_SCORE_CEILING]，两位小数。 */
  readonly value: number;
  /** 归一化加权和 [0,1]（映射到上下限之前的原始值）。 */
  readonly weighted: number;
  readonly signals: readonly ConfidenceSignal[];
}

/** 打分输入：**默认值解析后**的条目字段（与落盘形态一致，故可重算）。 */
export interface ConfidenceInput {
  readonly content: string;
  readonly trigger: string;
  readonly category: LearningCategory;
  readonly scope: Scope;
  readonly promoteTarget: PromoteTarget;
}

// ---------------------------------------------------------------------------
// 信号 1：正文长度
// ---------------------------------------------------------------------------

/** 短于此长度基本是半句话，给 0。 */
const LENGTH_MIN = 12;
/** 进入"说清一件事"区间的下界。 */
const LENGTH_GOOD_LO = 40;
/** 该区间的上界。 */
const LENGTH_GOOD_HI = 600;
/** 超过此长度视作整篇粘贴、未提炼，衰减到地板。 */
const LENGTH_MAX = 2400;
/** 超长文本的得分地板（"太长"是提炼不足，不是没价值）。 */
const LENGTH_LONG_FLOOR = 0.3;

/** 数值夹到 [0,1]。 */
function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** 保留两位小数（落盘值必须逐字节稳定，不能带浮点尾巴）。 */
export function roundConfidence(value: number): number {
  return Math.round(clamp01(value) * 100) / 100;
}

/**
 * 正则类信号只扫描正文前这么多字符。
 *
 * 两个理由：`PATH_LIKE` 这类 `[\w.@-]+[\\/]...` 形态在几十 KB 的无分隔符文本上会
 * 退化成 O(n²) 回溯（一条误粘进来的 base64 就能让 `learn` 卡住）；而超过这个长度的
 * 正文本身已经被 `length` 信号压到地板，"第 9000 个字符处提到了一个路径"对这条学习
 * 到底有多可信没有实质影响。
 */
const SIGNAL_SCAN_LIMIT = 4000;

/** 正则信号的扫描窗口（见 SIGNAL_SCAN_LIMIT）。 */
function scanWindow(content: string): string {
  return content.length <= SIGNAL_SCAN_LIMIT ? content : content.slice(0, SIGNAL_SCAN_LIMIT);
}

/** 长度信号：过短线性升、区间内满分、过长线性降到地板。 */
export function scoreLength(content: string): number {
  const length = content.trim().length;
  if (length < LENGTH_MIN) {
    return 0;
  }
  if (length < LENGTH_GOOD_LO) {
    return clamp01((length - LENGTH_MIN) / (LENGTH_GOOD_LO - LENGTH_MIN));
  }
  if (length <= LENGTH_GOOD_HI) {
    return 1;
  }
  const overflow = clamp01(1 - (length - LENGTH_GOOD_HI) / (LENGTH_MAX - LENGTH_GOOD_HI));
  return LENGTH_LONG_FLOOR + (1 - LENGTH_LONG_FLOOR) * overflow;
}

// ---------------------------------------------------------------------------
// 信号 2：可执行信息
// ---------------------------------------------------------------------------

/** 围栏代码块。 */
const CODE_FENCE = /```/;
/** 行内 code。 */
const INLINE_CODE = /`[^`\n]+`/;
/**
 * 已知命令名（白名单）。
 *
 * 刻意不收 `go` / `make` / `run` 这类同时是常用英文词的名字——误命中会让"提到过
 * make sure"的条目白拿一档分，而漏判只是少给分，代价不对等。
 */
const COMMAND_WORD =
  /(?:^|[\s(（"'`])(?:aforge|npm|pnpm|yarn|npx|node|tsc|git|uv|pip|python|cargo|docker|kubectl|bash|pwsh|powershell|curl|vitest|jest|eslint|biome)\b/i;

/** 可执行信息信号：命中的类别数 / 3（代码块 + 行内 code + 命令名）。 */
export function scoreActionable(content: string): number {
  const text = scanWindow(content);
  const hits = [CODE_FENCE, INLINE_CODE, COMMAND_WORD].filter((re) => re.test(text)).length;
  return hits / 3;
}

// ---------------------------------------------------------------------------
// 信号 3：具体引用
// ---------------------------------------------------------------------------

/** 带已知扩展名的文件名。 */
const FILE_EXTENSION =
  /[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|toml|py|rs|go|sh|ps1|lock|cfg|ini|xml|env|sql)\b/i;
/** 含分隔符的路径片段（`src/core/x`、`.agentforge\profile`）。 */
const PATH_LIKE = /[\w.@-]+[\\/][\w.@*-]+/;

/** 引用信号：命中的类别数 / 2（文件名 + 路径）。 */
export function scoreReference(content: string): number {
  const text = scanWindow(content);
  const hits = [FILE_EXTENSION, PATH_LIKE].filter((re) => re.test(text)).length;
  return hits / 2;
}

// ---------------------------------------------------------------------------
// 信号 4：规范性表述
// ---------------------------------------------------------------------------

/** 中英规范性措辞。二值信号：一条要么是规则，要么只是观察，没有"程度"。 */
const DIRECTIVE =
  /必须|禁止|不得|不要|一律|务必|应当|绝不|改用|统一使用|优先|(?:^|\W)(?:must|never|always|should|prefer|avoid|don't|do not|instead of)(?:\W|$)/i;

/** 规范性信号：命中 → 1，否则 0。 */
export function scoreDirective(content: string): number {
  return DIRECTIVE.test(scanWindow(content)) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 信号 5 / 6：元数据与层级
// ---------------------------------------------------------------------------

/**
 * 元数据信号：三个子项各占 1/3——trigger 非空、category 非 `other`、
 * promote_target 非默认 `custom_rule`。
 *
 * 判据是"是否偏离默认值"而非"调用方是否显式传参"：后者在落盘后无从恢复，
 * 会让 scoreLearningConfidence 重算出与创建时不同的分。
 */
export function scoreMetadata(input: ConfidenceInput): number {
  const hits = [
    input.trigger.trim() !== '',
    input.category !== 'other',
    input.promoteTarget !== 'custom_rule',
  ].filter(Boolean).length;
  return hits / 3;
}

/** 层级信号：project 更具体（1）；user 是跨项目的泛化断言（0.5）。 */
export function scoreScope(scope: Scope): number {
  return scope === 'project' ? 1 : 0.5;
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/** 各信号的中文标签（打印 breakdown 用）。 */
const SIGNAL_LABEL: Readonly<Record<ConfidenceSignalId, string>> = {
  length: '正文长度落在可读区间',
  actionable: '含可照抄的执行信息（代码块 / 命令）',
  reference: '引用了具体文件或路径',
  directive: '是一条规范性表述',
  metadata: 'trigger / category / promote_target 已明确',
  scope: 'scope 的具体程度',
};

/**
 * 自动打分（`learn` 未显式给 `--confidence` 时使用）。
 *
 * 归一化：加权和 ∈ [0,1] → 线性映射到 [AUTO_SCORE_FLOOR, AUTO_SCORE_CEILING] →
 * 两位小数。恒不越界 [0,1]，故必然通过 schema 的 `confidence` 校验。
 */
export function scoreConfidence(input: ConfidenceInput): ConfidenceScore {
  const raw: Readonly<Record<ConfidenceSignalId, number>> = {
    length: scoreLength(input.content),
    actionable: scoreActionable(input.content),
    reference: scoreReference(input.content),
    directive: scoreDirective(input.content),
    metadata: scoreMetadata(input),
    scope: scoreScope(input.scope),
  };

  const signals: ConfidenceSignal[] = [];
  let weighted = 0;
  for (const id of Object.keys(CONFIDENCE_WEIGHTS) as ConfidenceSignalId[]) {
    const weight = CONFIDENCE_WEIGHTS[id];
    const score = clamp01(raw[id]);
    weighted += weight * score;
    signals.push({ id, weight, score, reason: SIGNAL_LABEL[id] });
  }
  weighted = clamp01(weighted);

  return {
    value: roundConfidence(AUTO_SCORE_FLOOR + weighted * (AUTO_SCORE_CEILING - AUTO_SCORE_FLOOR)),
    weighted,
    signals,
  };
}

/** 落盘条目 → 打分 breakdown（重算，不读持久化字段；见模块头注释）。 */
export function scoreLearningConfidence(entry: {
  readonly content: string;
  readonly trigger: string;
  readonly category: LearningCategory;
  readonly scope: Scope;
  readonly promote_target: PromoteTarget;
}): ConfidenceScore {
  return scoreConfidence({
    content: entry.content,
    trigger: entry.trigger,
    category: entry.category,
    scope: entry.scope,
    promoteTarget: entry.promote_target,
  });
}

// ---------------------------------------------------------------------------
// 时间衰减
// ---------------------------------------------------------------------------

/** 一天的毫秒数。 */
const MS_PER_DAY = 86_400_000;

/** 宽限期：这么多天内不衰减（刚记下的东西还没到"过期"这一步）。 */
export const DECAY_GRACE_DAYS = 30;

/** 半衰期：过了宽限期后，每这么多天衰掉可衰减部分的一半。 */
export const DECAY_HALF_LIFE_DAYS = 90;

/** 衰减地板比例：effective 恒 >= base * 此值（旧 ≠ 错，只是该复核）。 */
export const DECAY_FLOOR_RATIO = 0.25;

/** 超过这么多天仍未 promote → 标记 stale，由展示层给清理提示。 */
export const STALE_AFTER_DAYS = 180;

/** 衰减输入：Learning 的结构子集（Learning 天然满足）。 */
export interface DecayInput {
  readonly confidence: number;
  readonly updated_at: string;
  readonly promoted: boolean;
}

/** 衰减结果（effective 不落盘，见模块头注释）。 */
export interface ConfidenceDecay {
  /** 落盘的 base 值。 */
  readonly base: number;
  /** 衰减后的展示值 [0, base]。 */
  readonly effective: number;
  /** 距 `updated_at` 的天数（不为负）。 */
  readonly ageDays: number;
  /** 是否真的衰减了（已 promote 或在宽限期内 → false）。 */
  readonly decayed: boolean;
  /** 是否到了建议清理 / 复核的档。 */
  readonly stale: boolean;
}

/**
 * 计算距 `updated_at` 的天数。
 *
 * 用 `updated_at` 而非 `created_at` 作为锚点：条目被再次命中（`learnings edit`、
 * `updateLearning` 刷新 confidence）时 `updated_at` 会前移，正对应"又被用到了"。
 * 时间戳不可解析（理论上被 schema 挡住）或落在未来 → 0，即不衰减。
 */
export function ageInDays(updatedAt: string, now: Date): number {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) {
    return 0;
  }
  return Math.max(0, (now.getTime() - then) / MS_PER_DAY);
}

/**
 * 时间衰减：`effective = base * (FLOOR + (1 - FLOOR) * 0.5^((age - GRACE) / HALF_LIFE))`。
 *
 * - **已 promote 的条目不衰减**：它已经落成 `custom/` 或 `skills/` 产物，置信度由
 *   产物本身承担，再衰减只会让排序莫名其妙；
 * - age <= GRACE 时同样返回 base（分段函数在 age = GRACE 处连续）；
 * - 结果对 age 单调不增，且恒在 [0, base] ⊂ [0,1] 内。
 */
export function decayConfidence(entry: DecayInput, now: Date): ConfidenceDecay {
  const base = clamp01(entry.confidence);
  const ageDays = ageInDays(entry.updated_at, now);
  if (entry.promoted || ageDays <= DECAY_GRACE_DAYS) {
    return { base, effective: base, ageDays, decayed: false, stale: false };
  }
  const halfLives = (ageDays - DECAY_GRACE_DAYS) / DECAY_HALF_LIFE_DAYS;
  const retained = DECAY_FLOOR_RATIO + (1 - DECAY_FLOOR_RATIO) * 0.5 ** halfLives;
  return {
    base,
    effective: clamp01(base * retained),
    ageDays,
    decayed: true,
    stale: ageDays >= STALE_AFTER_DAYS,
  };
}
