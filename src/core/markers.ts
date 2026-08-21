/**
 * Marker 区间处理（Spec §8.2）：纯函数，无 IO。
 *
 * 区间语义：`[before]BEGIN\n<body>\nEND[after]`，marker 独占行；
 * split 保留原始字符（含 CRLF），replace 输出统一 LF（换行风格由 Projector
 * 最后经 fsutil.normalizeLineEnding 统一，Spec §2.5）。
 *
 * sha256Hex 依赖 infra/fsutil 中的同一实现（node:crypto 同步 hash，纯计算），
 * 与 sync-meta contentHash 保持同一规范（Spec §3.3 / §8.2）。
 */
import { sha256Hex } from '../infra/fsutil';

export const DEFAULT_MARKER_BEGIN = '<!-- BEGIN AGENTFORGE -->';
export const DEFAULT_MARKER_END = '<!-- END AGENTFORGE -->';

export interface MarkerSplit {
  /** BEGIN marker 之前的内容（原样，含换行风格）。 */
  readonly before: string;
  /** 两 marker 之间的内容（不含 marker 本身，原样含 CRLF）。 */
  readonly inside: string;
  /** END marker 之后的内容（原样）。 */
  readonly after: string;
  /** 是否找到成对 marker（只出现单个视为无 marker）。 */
  readonly hasMarkers: boolean;
}

/**
 * 按 marker 切分内容；多次出现取第一对（Spec 边界）。
 * begin 出现但其后无 end、或只有 end 无 begin → 视为无 marker。
 */
export function splitByMarkers(
  content: string,
  begin: string = DEFAULT_MARKER_BEGIN,
  end: string = DEFAULT_MARKER_END,
): MarkerSplit {
  const beginIndex = content.indexOf(begin);
  if (beginIndex < 0) {
    return { before: content, inside: '', after: '', hasMarkers: false };
  }
  const endIndex = content.indexOf(end, beginIndex + begin.length);
  if (endIndex < 0) {
    return { before: content, inside: '', after: '', hasMarkers: false };
  }
  return {
    before: content.slice(0, beginIndex),
    inside: content.slice(beginIndex + begin.length, endIndex),
    after: content.slice(endIndex + end.length),
    hasMarkers: true,
  };
}

/** 剥掉新内容首尾的全部换行（含空行与 CRLF），便于重新按规范包裹。 */
function stripEdgeNewlines(s: string): string {
  return s.replace(/^(?:\r?\n)+/, '').replace(/(?:\r?\n)+$/, '');
}

/**
 * 替换 marker 区间（或 EOF 追加）。
 *
 * - 有 marker：`before + BEGIN\n<body>\nEND + after`（marker 外内容原样保留，Spec §8.2）；
 * - 无 marker：确保原内容以换行结尾后，在 EOF 追加 `BEGIN\n<body>\nEND\n`；
 * - body 为 newInside 剥除首尾换行后的正文；空正文输出 `BEGIN\nEND` 空块；
 * - 幂等：对已生成结果再次以同一 inside 替换，输出不变（sync 稳定性前提）。
 */
export function replaceBetween(
  content: string,
  newInside: string,
  begin: string = DEFAULT_MARKER_BEGIN,
  end: string = DEFAULT_MARKER_END,
): string {
  const body = stripEdgeNewlines(newInside);
  const block = body === '' ? `${begin}\n${end}` : `${begin}\n${body}\n${end}`;

  const split = splitByMarkers(content, begin, end);
  if (split.hasMarkers) {
    return split.before + block + split.after;
  }

  let out = content;
  if (out !== '' && !out.endsWith('\n')) {
    out += '\n';
  }
  return out + block + '\n';
}

/**
 * marker 区间内容指纹：inside 经 LF 规范化后的 sha256 hex（Spec §8.2 冲突检测，
 * M7 sync 前与 sync-meta.json 记录对比）。无 marker → 空字符串的 hash（语义：
 * 区间为空，与"从未投影"等同处理）。
 */
export function markerSectionHash(
  content: string,
  begin: string = DEFAULT_MARKER_BEGIN,
  end: string = DEFAULT_MARKER_END,
): string {
  const { inside } = splitByMarkers(content, begin, end);
  return sha256Hex(inside);
}
