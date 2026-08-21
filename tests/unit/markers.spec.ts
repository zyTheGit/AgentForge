/**
 * markers 单测（Spec §8.2）：切分 / 重组 / 区间 hash / 多次 marker / CRLF / 无换行包裹。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKER_BEGIN,
  DEFAULT_MARKER_END,
  markerSectionHash,
  replaceBetween,
  splitByMarkers,
} from '../../src/core/markers';
import { sha256Hex } from '../../src/infra/fsutil';

const B = DEFAULT_MARKER_BEGIN;
const E = DEFAULT_MARKER_END;

describe('splitByMarkers', () => {
  it('标准形态：marker 独占行', () => {
    const content = `# Title\n\n${B}\nrules here\n${E}\n\nfooter`;
    const split = splitByMarkers(content);
    expect(split.hasMarkers).toBe(true);
    expect(split.before).toBe('# Title\n\n');
    expect(split.inside).toBe('\nrules here\n');
    expect(split.after).toBe('\n\nfooter');
  });

  it('无 marker → hasMarkers=false，before 为全文', () => {
    const split = splitByMarkers('just a plain file\n');
    expect(split).toEqual({ before: 'just a plain file\n', inside: '', after: '', hasMarkers: false });
  });

  it('只有 begin 无 end → 视为无 marker', () => {
    const split = splitByMarkers(`head\n${B}\nbroken`);
    expect(split.hasMarkers).toBe(false);
    expect(split.before).toBe(`head\n${B}\nbroken`);
  });

  it('只有 end 无 begin → 视为无 marker', () => {
    const split = splitByMarkers(`head\n${E}\ntail`);
    expect(split.hasMarkers).toBe(false);
  });

  it('多次 marker：取第一对', () => {
    const content = `${B}\nfirst\n${E}\nmiddle\n${B}\nsecond\n${E}`;
    const split = splitByMarkers(content);
    expect(split.hasMarkers).toBe(true);
    expect(split.before).toBe('');
    expect(split.inside).toBe('\nfirst\n');
    expect(split.after).toBe(`\nmiddle\n${B}\nsecond\n${E}`);
  });

  it('边界：marker 无换行包裹（紧贴前后文字）', () => {
    const content = `abc${B}xyz${E}def`;
    const split = splitByMarkers(content);
    expect(split.hasMarkers).toBe(true);
    expect(split.before).toBe('abc');
    expect(split.inside).toBe('xyz');
    expect(split.after).toBe('def');
  });

  it('边界：CRLF 内容，inside 原样保留 CRLF', () => {
    const content = `a\r\n${B}\r\nrules\r\n${E}\r\nb`;
    const split = splitByMarkers(content);
    expect(split.hasMarkers).toBe(true);
    expect(split.before).toBe('a\r\n');
    expect(split.inside).toBe('\r\nrules\r\n');
    expect(split.after).toBe('\r\nb');
  });

  it('自定义 marker 对', () => {
    const split = splitByMarkers('x/*AF-S*/y/*AF-E*/z', '/*AF-S*/', '/*AF-E*/');
    expect(split.hasMarkers).toBe(true);
    expect(split.before).toBe('x');
    expect(split.inside).toBe('y');
    expect(split.after).toBe('z');
  });
});

describe('replaceBetween', () => {
  it('有 marker：替换区间，marker 外内容原样保留（Spec §8.2）', () => {
    const content = `# keep\n${B}\nold\n${E}\ntail`;
    const out = replaceBetween(content, '\nnew\n');
    expect(out).toBe(`# keep\n${B}\nnew\n${E}\ntail`);
  });

  it('有 marker：newInside 无边缘换行也规范化为独立行包裹', () => {
    const content = `# keep\n${B}\nold\n${E}\ntail`;
    const out = replaceBetween(content, 'new');
    expect(out).toBe(`# keep\n${B}\nnew\n${E}\ntail`);
  });

  it('有 marker：newInside 首尾多余空行被剥除（每侧保留语义不受损）', () => {
    const content = `${B}\nold\n${E}`;
    const out = replaceBetween(content, '\n\n\nnew\n\n\n');
    expect(out).toBe(`${B}\nnew\n${E}`);
  });

  it('无 marker：EOF 追加，前置确保换行（Spec §8.2 append 语义）', () => {
    const out = replaceBetween('# head', '\nnew\n');
    expect(out).toBe(`# head\n${B}\nnew\n${E}\n`);
  });

  it('无 marker：原内容已以换行结尾时不重复加换行', () => {
    const out = replaceBetween('# head\n', 'new');
    expect(out).toBe(`# head\n${B}\nnew\n${E}\n`);
  });

  it('无 marker：空文件直接追加块', () => {
    const out = replaceBetween('', 'new');
    expect(out).toBe(`${B}\nnew\n${E}\n`);
  });

  it('空 inside → 空块（BEGIN 紧跟 END）', () => {
    expect(replaceBetween(`# a\n${B}\nold\n${E}\n`, '\n')).toBe(`# a\n${B}\n${E}\n`);
    expect(replaceBetween('x', '')).toBe(`x\n${B}\n${E}\n`);
  });

  it('幂等：同一 inside 替换两次结果不变（sync 稳定性前提）', () => {
    const content = `# t\n\n${B}\nold rules\n${E}\n\ntail`;
    const once = replaceBetween(content, '\nNEW\n');
    expect(replaceBetween(once, '\nNEW\n')).toBe(once);
    // 无 marker 的追加路径同样幂等
    const appended = replaceBetween('# plain', 'NEW');
    expect(replaceBetween(appended, 'NEW')).toBe(appended);
  });

  it('CRLF 内容：marker 外 CRLF 原样保留，新块统一 LF（风格由上层 normalize）', () => {
    const content = `a\r\n${B}\r\nold\r\n${E}\r\nb`;
    const out = replaceBetween(content, 'new');
    expect(out).toBe(`a\r\n${B}\nnew\n${E}\r\nb`);
  });

  it('marker 无换行包裹的边界内容也能替换', () => {
    const out = replaceBetween(`abc${B}xyz${E}def`, 'new');
    expect(out).toBe(`abc${B}\nnew\n${E}def`);
  });

  it('自定义 marker 对', () => {
    const out = replaceBetween('x/*AF-S*/y/*AF-E*/z', 'n', '/*AF-S*/', '/*AF-E*/');
    expect(out).toBe('x/*AF-S*/\nn\n/*AF-E*/z');
  });
});

describe('markerSectionHash（Spec §8.2 冲突检测基准）', () => {
  it('LF 与 CRLF 的同内容 inside 产生相同 hash（换行风格不敏感）', () => {
    const lf = `x\n${B}\n- a\n- b\n${E}\ny`;
    const crlf = `x\r\n${B}\r\n- a\r\n- b\r\n${E}\r\ny`;
    expect(markerSectionHash(lf)).toBe(markerSectionHash(crlf));
  });

  it('等于 sha256Hex(inside)（与 fsutil contentHash 同一规范）', () => {
    const inside = '\n# AgentForge Rules\n- use fnm\n';
    expect(markerSectionHash(`${B}${inside}${E}`)).toBe(sha256Hex(inside));
  });

  it('内容不同 → hash 不同', () => {
    const a = markerSectionHash(`${B}\nrules v1\n${E}`);
    const b = markerSectionHash(`${B}\nrules v2\n${E}`);
    expect(a).not.toBe(b);
  });

  it('无 marker → sha256("")（语义：区间为空）', () => {
    expect(markerSectionHash('plain file')).toBe(sha256Hex(''));
  });

  it('多次 marker：取第一对的 inside', () => {
    const content = `${B}\nfirst\n${E}\nmid\n${B}\nsecond\n${E}`;
    expect(markerSectionHash(content)).toBe(sha256Hex('\nfirst\n'));
  });
});
