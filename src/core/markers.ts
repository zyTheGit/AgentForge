/**
 * Marker 区间处理（Spec §8.2）：纯函数，无 IO。
 *
 * 区间语义：`[before]BEGIN\n<body>\nEND[after]`，marker 独占行；
 * split 保留原始字符（含 CRLF），replace 输出统一 LF（换行风格由 Projector
 * 最后经 fsutil.normalizeLineEnding 统一，Spec §2.5）。
 *
 * marker 定位一律行锚定（marker 必须独占一行，允许**行首缩进**与行尾水平空白）：
 * 行内出现（正文引用、代码块示例、`# BEGIN AGENTFORGE MCP` 这类“更长变体”）
 * 都不会被误命中，避免区间边界漂移导致用户文件被逐次啃食。
 *
 * 写出侧另有一道守卫：正文（body）自身含 marker 字面量时**直接拒绝**
 * （assertMarkerFreeBody → ConflictError(3)），不做转义、不做容忍——理由见该函数
 * 的 JSDoc（自我嵌套的区间会让每次 sync 累积残留）。因此"marker 只可能出现在
 * 区间边界"是 replace 侧的不变量，而非仅靠定位规则的巧合。
 *
 * sha256Hex / ensureTrailingNewline 复用 infra/fsutil 的同一实现（纯计算 / 纯字符串），
 * hash 与 sync-meta contentHash 保持同一规范（Spec §3.3 / §8.2）。
 */
import { ensureTrailingNewline, sha256Hex } from '../infra/fsutil';
import { ConflictError } from './errors';

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

/** 包裹/写出 marker 区块时的可选上下文（仅用于错误信息定位）。 */
export interface MarkerContext {
  /** 正文来源（投影目标文件绝对路径 / 模板文件名等），若可得。 */
  readonly source?: string;
}

/** 正则元字符转义：marker 常含 `<!-- -->`、`#`、`*`、`(` 等字面量。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 行锚定 marker 匹配器：`^[ \t]*<marker>[ \t]*$`（multiline + global）。
 *
 * 行首容忍水平空白：marker 被嵌进缩进上下文（YAML 块、Markdown 列表项、
 * 代码围栏内的配置片段）时若匹配不上，`marker_mode=replace_between_markers`
 * 会静默降级成 EOF 追加——每次 sync 追加一份新区间，反复污染用户文件。
 *
 * 行尾用 `[ \t]*$` 而非 `\s*$`：`\s` 含换行，贪婪匹配会把 marker 行之后的空行/CR
 * 一并吞入匹配区间，破坏「inside 原样保留（含 CRLF）」契约（CRLF 文件会丢 `\r`）。
 */
function markerRegExp(marker: string): RegExp {
  return new RegExp(`^[ \\t]*${escapeRegExp(marker)}[ \\t]*$`, 'gm');
}

/**
 * 按 marker 切分内容；多次出现取第一对（Spec 边界）。
 *
 * - marker 必须独占一行（行首缩进与行尾水平空白除外）：行内出现
 *   （如 `见 <!-- BEGIN AGENTFORGE --> 说明`）不命中；
 * - begin 出现但其后无 end、或只有 end 无 begin → 视为无 marker。
 */
export function splitByMarkers(
  content: string,
  begin: string = DEFAULT_MARKER_BEGIN,
  end: string = DEFAULT_MARKER_END,
): MarkerSplit {
  const noMarkers: MarkerSplit = { before: content, inside: '', after: '', hasMarkers: false };

  const beginMatch = markerRegExp(begin).exec(content);
  if (beginMatch === null) {
    return noMarkers;
  }
  const insideStart = beginMatch.index + beginMatch[0].length;

  const endRe = markerRegExp(end);
  endRe.lastIndex = insideStart;
  const endMatch = endRe.exec(content);
  if (endMatch === null) {
    return noMarkers;
  }

  return {
    before: content.slice(0, beginMatch.index),
    inside: content.slice(insideStart, endMatch.index),
    after: content.slice(endMatch.index + endMatch[0].length),
    hasMarkers: true,
  };
}

/** 剥掉新内容首尾的全部换行（含空行与 CRLF），便于重新按规范包裹。 */
function stripEdgeNewlines(s: string): string {
  return s.replace(/^(?:\r?\n)+/, '').replace(/(?:\r?\n)+$/, '');
}

/**
 * 出口守卫：正文里出现 marker 字面量 → ConflictError(3)（Spec §8.2）。
 *
 * 为什么必须在“写出”时拦而不是容忍：若 body 内含 END marker，落盘后文件里就出现
 * 自我嵌套的区间；下一次 sync 的 splitByMarkers 会在 body 内部那个 END 处收边，
 * 把其后的真实正文并入 after 并保留多余 END —— 每次 sync 累积一段残留，逐步
 * 损坏用户的 AGENTS.md / CLAUDE.md。第一次写入即拒绝，才不埋下累积的种子。
 */
function assertMarkerFreeBody(body: string, begin: string, end: string, ctx: MarkerContext): void {
  let hit: string | undefined;
  if (body.includes(begin)) {
    hit = begin;
  } else if (body.includes(end)) {
    hit = end;
  }
  if (hit === undefined) {
    return;
  }
  const where = ctx.source === undefined ? '' : `（来源: ${ctx.source}）`;
  throw new ConflictError(`渲染正文中出现 AgentForge marker 字面量 \`${hit}\`${where}`, {
    hint: '从来源文件中删除该 marker 字面量（示例请改写为不含 AGENTFORGE 的占位串），或在 profile.projection 里换一对不冲突的 marker 后重新执行 aforge sync',
    details: { marker: hit, source: ctx.source, begin, end },
  });
}

/**
 * 规范 marker 包裹块（投影层用）：marker 独占行、body 前后无多余空行。
 *
 * 返回 `BEGIN\n<body>\nEND`（空 body → `BEGIN\nEND`），不含 marker 外的任何内容。
 * replaceBetween 的区间重建与本函数共用同一规范（单一事实源）；
 * 投影侧需要“裸包裹块”时（如构造 merge 片段 / 测试断言）直接调用。
 *
 * @param ctx 可选来源上下文，仅用于 body 含 marker 字面量时的错误定位。
 * @throws ConflictError(3) body 内含 begin/end marker 字面量（见 assertMarkerFreeBody）。
 */
export function wrapWithMarkers(
  content: string,
  begin: string = DEFAULT_MARKER_BEGIN,
  end: string = DEFAULT_MARKER_END,
  ctx: MarkerContext = {},
): string {
  const body = stripEdgeNewlines(content);
  assertMarkerFreeBody(body, begin, end, ctx);
  return body === '' ? `${begin}\n${end}` : `${begin}\n${body}\n${end}`;
}

/**
 * 替换 marker 区间（或 EOF 追加）。
 *
 * - 有 marker：`before + BEGIN\n<body>\nEND + after`（marker 外内容原样保留，Spec §8.2）；
 * - 无 marker：确保原内容以换行结尾后，在 EOF 追加 `BEGIN\n<body>\nEND\n`；
 * - body 为 newInside 剥除首尾换行后的正文；空正文输出 `BEGIN\nEND` 空块；
 * - 幂等：对已生成结果再次以同一 inside 替换，输出不变（sync 稳定性前提）。
 *
 * @throws ConflictError(3) newInside 含 marker 字面量（见 wrapWithMarkers）。
 */
export function replaceBetween(
  content: string,
  newInside: string,
  begin: string = DEFAULT_MARKER_BEGIN,
  end: string = DEFAULT_MARKER_END,
  ctx: MarkerContext = {},
): string {
  const block = wrapWithMarkers(newInside, begin, end, ctx);

  const split = splitByMarkers(content, begin, end);
  if (split.hasMarkers) {
    return split.before + block + split.after;
  }

  // 追加前后各补一次尾换行（fsutil 的同一实现：空串不制造孤立空行）
  return ensureTrailingNewline(`${ensureTrailingNewline(content)}${block}`);
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

/**
 * 渲染正文在投影文件 marker 区间中的内容指纹（M7，Spec §8.2-4 冲突检测基准）。
 *
 * 语义：sync-meta.json 的 contentHash 记录值（M7 起）。计算方式是“先按投影层
 * 规范包裹、再切回区间”的往返（wrapWithMarkers → splitByMarkers），与读回
 * 真实投影文件后调用 markerSectionHash 完全同构——因此两值可直接相等比较，
 * 不依赖 composer 输出的首尾换行惯例（换行差异由 sha256Hex 的 LF 规范化吸收）。
 *
 * 背景调整（M6 → M7）：M6 曾直接记录 sha256Hex(renderedRulesMd)（渲染正文
 * 本体 hash）。但投影落盘的区间 body 是 stripEdgeNewlines 后的正文（见
 * wrapWithMarkers），尾随换行等边缘差异会导致“读回区间 hash ≠ 记录值”的
 * 恒定误报，无法作为冲突检测基准。故 M7 统一为 marker 区间形态（本函数）。
 *
 * @throws ConflictError(3) 渲染正文含 marker 字面量（见 wrapWithMarkers；此处即
 *   sync 的 fail-fast 点：不合法的正文在计算基准 hash 时就被拒绝，不会落盘）。
 */
export function renderedSectionHash(
  content: string,
  begin: string = DEFAULT_MARKER_BEGIN,
  end: string = DEFAULT_MARKER_END,
  ctx: MarkerContext = {},
): string {
  return markerSectionHash(wrapWithMarkers(content, begin, end, ctx), begin, end);
}
