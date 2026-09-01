/**
 * learning 内容相似度（Spec §7.5 重复检测的升级版判据）。
 *
 * 原判据是 `content` **全等**——改一个标点、补一个空格就绕过去了，于是同一条约定
 * 会以三四种措辞同时躺在 `learnings/` 里。本模块把它换成可调阈值的相似度。
 *
 * **算法：归一化后的字符 trigram Jaccard。** 为什么不按空白分词做 token Jaccard：
 * learning 正文是中英混排的短文本，中文不带空格，整句会退化成**一个** token，
 * 判重直接失效；字符 trigram 对 CJK 天然可用，且对词形/词序的微小改写（复数、
 * 时态、"不要用 npm" ↔ "npm 不要用"）比整词切分更鲁棒。代价是对超短文本区分度低，
 * 故长度不足 3 个字符时退化为整串相等比较。
 *
 * **纯函数、无时钟、无 IO**：同样的两段文本恒得同一个分数，判重结果因此可测且跨
 * 环境一致（与 scoring.ts 同一条约束）。
 */

/** 判为「重复」的阈值：实质同一句（仅标点 / 大小写 / 空白差异）。 */
export const SIMILARITY_DUPLICATE = 0.92;

/** 判为「相似、建议合并」的阈值：同一条约定的两种措辞。 */
export const SIMILARITY_SIMILAR = 0.65;

/** trigram 的 n。 */
const NGRAM_SIZE = 3;

/** 相似度判定的三档。 */
export type SimilarityVerdict = 'duplicate' | 'similar' | 'distinct';

/** 参与比对的既有条目（只需 id + 正文，不依赖 Learning 全形态）。 */
export interface SimilarityCandidate {
  readonly id: string;
  readonly content: string;
}

/** 命中结果（distinct 不构造此对象，见 findMostSimilar 返回 null）。 */
export interface SimilarityMatch {
  readonly id: string;
  /** 相似度分数 [0,1]。 */
  readonly score: number;
  readonly verdict: 'duplicate' | 'similar';
}

/**
 * 比对前的归一化：NFKC → 小写 → 非字母数字（含标点、全部空白）折叠为单空格 → trim。
 *
 * 标点与连字符一并抹掉是刻意的：`npm install` / `npm-install` / `npm  install,`
 * 在语义上是同一件事，保留它们只会让"同一条规则的两种写法"跌到相似档以下。
 */
export function normalizeForSimilarity(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * 归一化文本的字符 trigram 集合。
 *
 * 短于 NGRAM_SIZE 时返回「整串」单元素集合——否则空集与空集的 Jaccard 无定义，
 * 且所有短文本会被判为彼此相同。
 */
export function trigramSet(text: string): Set<string> {
  const normalized = normalizeForSimilarity(text);
  if (normalized === '') {
    return new Set();
  }
  const chars = [...normalized];
  if (chars.length < NGRAM_SIZE) {
    return new Set([normalized]);
  }
  const grams = new Set<string>();
  for (let i = 0; i + NGRAM_SIZE <= chars.length; i += 1) {
    grams.add(chars.slice(i, i + NGRAM_SIZE).join(''));
  }
  return grams;
}

/**
 * 两段正文的相似度 [0,1]：trigram 集合的 Jaccard 系数。
 *
 * 边界：两边归一化后都为空 → 1（同为"无内容"，视作相同）；只有一边为空 → 0。
 */
export function contentSimilarity(a: string, b: string): number {
  const left = trigramSet(a);
  const right = trigramSet(b);
  if (left.size === 0 || right.size === 0) {
    return left.size === right.size ? 1 : 0;
  }
  let intersection = 0;
  for (const gram of left) {
    if (right.has(gram)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** 分数 → 三档判定（阈值取闭区间下界）。 */
export function classifySimilarity(score: number): SimilarityVerdict {
  if (score >= SIMILARITY_DUPLICATE) {
    return 'duplicate';
  }
  return score >= SIMILARITY_SIMILAR ? 'similar' : 'distinct';
}

/**
 * 在候选集中找最相似的一条（低于 SIMILARITY_SIMILAR → null）。
 *
 * 同分取**先出现**的候选：调用方（store.createLearning）按文件名序读盘，于是
 * 同分时恒返回 id 序更小的那条，输出可复现。
 */
export function findMostSimilar(
  content: string,
  candidates: readonly SimilarityCandidate[],
): SimilarityMatch | null {
  let best: SimilarityMatch | null = null;
  for (const candidate of candidates) {
    const score = contentSimilarity(content, candidate.content);
    if (best !== null && score <= best.score) {
      continue;
    }
    const verdict = classifySimilarity(score);
    if (verdict === 'distinct') {
      continue;
    }
    best = { id: candidate.id, score, verdict };
  }
  return best;
}

/** 相似度的百分比展示（四舍五入到整数，供提示文案与 --json 共用）。 */
export function similarityPercent(score: number): number {
  return Math.round(score * 100);
}
