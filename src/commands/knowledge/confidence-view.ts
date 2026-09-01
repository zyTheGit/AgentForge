/**
 * confidence 的**呈现**层：`learn` 与 `learnings list|show` 共用的一组格式化函数。
 *
 * 为什么独立成模块而不塞进两个命令文件：base / effective / 打分来源 / 衰减档位
 * 这套口径必须两处一致（同一条目在 `learn` 输出里是 0.72，在 `learnings list` 里
 * 也得是 0.72），各写一遍就是等着它们分叉。同时 learn.ts 与 learnings.ts 都已接近
 * 500 行卡口（AGENTS.md「代码组织」），没有余量再各塞 50 行。
 *
 * 本模块不读时钟：`now` 由调用方从 `ctx.host.now()` 传入（与 core/learning/scoring
 * 同一条约束）。也不做 IO，纯字符串装配。
 */
import {
  type ConfidenceScore,
  decayConfidence,
  STALE_AFTER_DAYS,
  scoreLearningConfidence,
} from '../../core/learning/scoring';
import { type SimilarityMatch, similarityPercent } from '../../core/learning/similarity';
import { getUi, type Ui } from '../../infra/ui';
import type { Learning } from '../../schema';

/** confidence 一律两位小数展示（与落盘的 roundConfidence 同精度）。 */
export function formatConfidence(value: number): string {
  return value.toFixed(2);
}

/** `confidence_source` 缺席（自动打分上线前的旧条目）时的展示值。 */
const UNKNOWN_SOURCE = 'unknown';

/** base 值来源标签（auto / manual / unknown）。 */
export function confidenceSourceLabel(learning: Learning): string {
  return learning.confidence_source ?? UNKNOWN_SOURCE;
}

/**
 * confidence 的单行摘要：未衰减 → `0.72 (auto)`；已衰减 →
 * `0.31 (auto, base 0.72, 214d stale)`。
 *
 * 只有真的衰减了才展开 base——没衰减时两个值相同，多印一遍纯属噪声。
 */
export function confidenceSummary(learning: Learning, now: Date): string {
  const decay = decayConfidence(learning, now);
  const source = confidenceSourceLabel(learning);
  if (!decay.decayed) {
    return `${formatConfidence(decay.effective)} (${source})`;
  }
  const age = `${Math.floor(decay.ageDays)}d`;
  const staleness = decay.stale ? `${age} stale` : age;
  return `${formatConfidence(decay.effective)} (${source}, base ${formatConfidence(decay.base)}, ${staleness})`;
}

/** `learn` / `learnings show` 的 `confidence` 对齐行。 */
export function confidenceKvLine(
  learning: Learning,
  now: Date,
  labelWidth: number,
  ui: Ui = getUi(),
): string {
  return ui.kv('conf', confidenceSummary(learning, now), labelWidth);
}

/**
 * 打分 breakdown 的多行展示（`learnings show` 的「为什么是这个分」）。
 *
 * breakdown 是**重算**的（scoreLearningConfidence，见 scoring.ts 模块头）：条目的
 * `confidence` 若是人手给的 `manual` 值，这里展示的就是"启发式本来会给多少"，故
 * 抬头写清 heuristic 二字，不要让人以为落盘值等于这个加权和。
 */
export function confidenceBreakdownLines(
  learning: Learning,
  now: Date,
  ui: Ui = getUi(),
): string[] {
  const score = scoreLearningConfidence(learning);
  const decay = decayConfidence(learning, now);
  const lines = [
    ui.section('confidence'),
    ui.kv('effective', formatConfidence(decay.effective), 10),
    ui.kv('base', `${formatConfidence(decay.base)} (${confidenceSourceLabel(learning)})`, 10),
    ui.kv('age', `${Math.floor(decay.ageDays)}d${decayNote(learning, now)}`, 10),
    ui.kv('heuristic', `${formatConfidence(score.value)} ${ui.dim('(signals below)')}`, 10),
  ];
  for (const signal of score.signals) {
    lines.push(
      ui.bullet(
        `${signal.id.padEnd(11)} ${formatConfidence(signal.score)} x ${signal.weight.toFixed(2)}  ${ui.dim(signal.reason)}`,
        4,
      ),
    );
  }
  if (decay.stale) {
    lines.push(
      ui.yellow(
        `  not promoted for ${STALE_AFTER_DAYS}+ days - promote it or run \`aforge learnings rm ${learning.id}\``,
      ),
    );
  }
  return lines;
}

/** age 行的尾注：已 promote / 宽限期内 / 正在衰减。 */
function decayNote(learning: Learning, now: Date): string {
  const decay = decayConfidence(learning, now);
  if (learning.promoted) {
    return ' (promoted - no decay)';
  }
  return decay.decayed ? ' (decaying)' : ' (within grace period)';
}

/**
 * 中等相似度的合并**建议**行（不阻断创建，见 store.CreateLearningResult.similarTo）。
 */
export function similarityHintLine(match: SimilarityMatch, ui: Ui = getUi()): string {
  return ui.yellow(
    `similar to ${match.id} (${similarityPercent(match.score)}%) - consider merging instead of keeping both`,
  );
}

/** `--json` 的质量字段（Spec §6.2：稳定字段名 + 数值可比较）。 */
export function learningQualityJson(learning: Learning, now: Date): Record<string, unknown> {
  const decay = decayConfidence(learning, now);
  const score = scoreLearningConfidence(learning);
  return {
    confidenceBase: decay.base,
    // effective 是浮点计算结果，四舍五入到两位小数与人类可读输出同口径
    confidenceEffective: Number(formatConfidence(decay.effective)),
    confidenceSource: learning.confidence_source ?? null,
    // 天数保留一位小数：整数会把「刚过宽限期」和「差一小时到期」压成同一个值
    ageDays: Number(decay.ageDays.toFixed(1)),
    decayed: decay.decayed,
    stale: decay.stale,
    heuristic: heuristicJson(score),
  };
}

/** 打分 breakdown 的 JSON 形态。 */
function heuristicJson(score: ConfidenceScore): Record<string, unknown> {
  return {
    value: score.value,
    weighted: Number(score.weighted.toFixed(4)),
    signals: score.signals.map((signal) => ({
      id: signal.id,
      weight: signal.weight,
      score: Number(signal.score.toFixed(4)),
    })),
  };
}
