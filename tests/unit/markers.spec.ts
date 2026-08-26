/**
 * markers 单测（Spec §8.2）：切分 / 重组 / 区间 hash / 多次 marker / CRLF / 行锚定 / 正文守卫。
 */
import { describe, expect, it } from 'vitest';
import { ConflictError } from '../../src/core/errors';
import {
  DEFAULT_MARKER_BEGIN,
  DEFAULT_MARKER_END,
  markerSectionHash,
  replaceBetween,
  splitByMarkers,
  wrapWithMarkers,
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
    expect(split).toEqual({
      before: 'just a plain file\n',
      inside: '',
      after: '',
      hasMarkers: false,
    });
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

  it('边界：marker 未独占行（紧贴前后文字）→ 不命中（行锚定）', () => {
    // 行为变更（行锚定修复）：旧实现用 indexOf 定位，`abc<BEGIN>xyz<END>def` 会被当成
    // 合法区间。行锚定后这类行内出现一律不命中——否则正文里引用 marker 字符串就会
    // 让区间边界漂移，sync 逐次把用户正文啃进 after 并留下多余 END。
    const content = `abc${B}xyz${E}def`;
    const split = splitByMarkers(content);
    expect(split.hasMarkers).toBe(false);
    expect(split.before).toBe(content);
  });

  it('行锚定：marker 出现在行内 / 代码块内不被误命中，只认独占行的那一对', () => {
    const content = [
      '# doc',
      `说明：请勿手写 ${B} 这个串`, // 行内出现
      '```md',
      `${B} 示例（同一行还有别的字符）`, // 代码块内、行内出现
      '```',
      B, // 真正的区间起点
      'rules',
      E,
      'tail',
    ].join('\n');
    const split = splitByMarkers(content);
    expect(split.hasMarkers).toBe(true);
    expect(split.inside).toBe('\nrules\n');
    expect(split.after).toBe('\ntail');
    expect(split.before.endsWith('```\n')).toBe(true);
  });

  it('行锚定：marker 行尾允许水平空白（空格 / Tab）', () => {
    const split = splitByMarkers(`${B}  \nrules\n${E}\t\ntail`);
    expect(split.hasMarkers).toBe(true);
    expect(split.inside).toBe('\nrules\n');
    expect(split.after).toBe('\ntail');
  });

  it('行锚定：marker 行有前置缩进 → 仍命中（缩进不该让区间失配）', () => {
    // 行为变更（round-2）：旧实现只锚定行首，marker 嵌在缩进上下文（YAML 块 /
    // Markdown 列表项）时匹配不上 → replace_between_markers 静默降级成 EOF 追加，
    // 每次 sync 追加一份新区间，反复污染用户文件。故行首容忍水平空白。
    const split = splitByMarkers(`  ${B}\nrules\n  ${E}\ntail`);
    expect(split.hasMarkers).toBe(true);
    expect(split.inside).toBe('\nrules\n');
    expect(split.after).toBe('\ntail');
  });

  it('行锚定：缩进 marker 的区间被替换而非追加（不产生第二份区间）', () => {
    const content = `- 配置:\n  ${B}\n  old\n  ${E}\ntail\n`;
    const out = replaceBetween(content, 'new');
    expect(out).toBe(`- 配置:\n${B}\nnew\n${E}\ntail\n`);
    // 幂等：再替换一次输出不变（区间只有一份）
    expect(replaceBetween(out, 'new')).toBe(out);
  });

  it('前缀不误命中：`# BEGIN AGENTFORGE` 不匹配 `# BEGIN AGENTFORGE MCP` 行（Spec §8.4）', () => {
    const toml = ['user = 1', '# BEGIN AGENTFORGE MCP', 'x = 1', '# END AGENTFORGE MCP', ''].join(
      '\n',
    );
    const split = splitByMarkers(toml, '# BEGIN AGENTFORGE', '# END AGENTFORGE');
    expect(split.hasMarkers).toBe(false);
    // 反向也成立：MCP 变体自己能命中自己的段
    const mcp = splitByMarkers(toml, '# BEGIN AGENTFORGE MCP', '# END AGENTFORGE MCP');
    expect(mcp.hasMarkers).toBe(true);
    expect(mcp.inside).toBe('\nx = 1\n');
  });

  it('边界：CRLF 内容，inside 原样保留 CRLF', () => {
    const content = `a\r\n${B}\r\nrules\r\n${E}\r\nb`;
    const split = splitByMarkers(content);
    expect(split.hasMarkers).toBe(true);
    expect(split.before).toBe('a\r\n');
    expect(split.inside).toBe('\r\nrules\r\n');
    expect(split.after).toBe('\r\nb');
  });

  it('自定义 marker 对（含正则元字符，独占行）', () => {
    const split = splitByMarkers('x\n/*AF-S*/\ny\n/*AF-E*/\nz', '/*AF-S*/', '/*AF-E*/');
    expect(split.hasMarkers).toBe(true);
    expect(split.before).toBe('x\n');
    expect(split.inside).toBe('\ny\n');
    expect(split.after).toBe('\nz');
  });

  it('自定义 marker 对：行内出现不命中（与默认 marker 同一规则）', () => {
    expect(splitByMarkers('x/*AF-S*/y/*AF-E*/z', '/*AF-S*/', '/*AF-E*/').hasMarkers).toBe(false);
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

  it('marker 未独占行的现有内容 → 视为无 marker，走 EOF 追加（行锚定后的行为）', () => {
    // 行为变更（行锚定修复）：旧实现会就地替换 `abc<BEGIN>xyz<END>def` 的“区间”。
    // 现在这类内容原样保留，新块追加到 EOF——用户正文不再被行内 marker 串牵连改写。
    const out = replaceBetween(`abc${B}xyz${E}def`, 'new');
    expect(out).toBe(`abc${B}xyz${E}def\n${B}\nnew\n${E}\n`);
  });

  it('自定义 marker 对（独占行）', () => {
    const out = replaceBetween('x\n/*AF-S*/\ny\n/*AF-E*/\nz', 'n', '/*AF-S*/', '/*AF-E*/');
    expect(out).toBe('x\n/*AF-S*/\nn\n/*AF-E*/\nz');
  });

  it('正文含 END marker → ConflictError(3)，不写出自我嵌套的区间', () => {
    const body = `rules\n${E}\n伪造的尾部`;
    expect(() => replaceBetween(`# doc\n${B}\nold\n${E}\n`, body)).toThrow(ConflictError);
  });
});

describe('marker 正文守卫（Spec §8.2：写出前拦截，避免逐次累积损坏）', () => {
  it('body 含 BEGIN marker → ConflictError(3)，错误信息点名 marker 与来源文件', () => {
    try {
      wrapWithMarkers(`前言\n${B}\n伪造`, B, E, {
        source: 'C:\\Users\\u\\.agentforge\\custom\\x.md',
      });
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      const e = err as ConflictError;
      expect(e.code).toBe(3);
      expect(e.message).toContain(B);
      expect(e.message).toContain('custom\\x.md');
      expect(e.hint).toBeTruthy();
    }
  });

  it('body 含 END marker → ConflictError(3)（无来源上下文时错误信息仍点名 marker）', () => {
    try {
      wrapWithMarkers(`rules\n${E}\n多余尾部`);
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).message).toContain(E);
    }
  });

  it('行内出现也拦截（守卫按字面量判定，比 split 的行锚定更严）', () => {
    expect(() => wrapWithMarkers(`见 ${E} 说明`)).toThrow(ConflictError);
  });

  it('自定义/TOML marker 同样受守卫保护', () => {
    expect(() =>
      wrapWithMarkers(
        'x\n# END AGENTFORGE MCP\n',
        '# BEGIN AGENTFORGE MCP',
        '# END AGENTFORGE MCP',
      ),
    ).toThrow(ConflictError);
  });

  it('不含 marker 字面量的正文正常包裹（守卫不误伤）', () => {
    expect(wrapWithMarkers('BEGIN AGENTFORGE 只是普通文字')).toBe(
      `${B}\nBEGIN AGENTFORGE 只是普通文字\n${E}`,
    );
  });
});

describe('wrapWithMarkers（投影层规范包裹）', () => {
  it('marker 独占行、body 前后无多余空行', () => {
    expect(wrapWithMarkers('rules here')).toBe(`${B}\nrules here\n${E}`);
  });

  it('body 首尾多余空行（含 CRLF）被剥除', () => {
    expect(wrapWithMarkers('\n\n\nrules\r\n\r\n')).toBe(`${B}\nrules\n${E}`);
  });

  it('空 body → 空块（BEGIN 紧跟 END）', () => {
    expect(wrapWithMarkers('')).toBe(`${B}\n${E}`);
    expect(wrapWithMarkers('\n\n')).toBe(`${B}\n${E}`);
  });

  it('自定义 marker 对', () => {
    expect(wrapWithMarkers('x', '/*S*/', '/*E*/')).toBe('/*S*/\nx\n/*E*/');
  });

  it('与 replaceBetween 共用同一规范：无 marker 追加的块 = wrapWithMarkers + 尾换行', () => {
    const wrapped = wrapWithMarkers('rules');
    expect(replaceBetween('', 'rules')).toBe(`${wrapped}\n`);
    expect(replaceBetween('# head', 'rules')).toBe(`# head\n${wrapped}\n`);
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
