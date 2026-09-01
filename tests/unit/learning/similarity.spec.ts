/**
 * learning 内容相似度单测（core/learning/similarity）。
 *
 * 覆盖：全等 / 高相似（仅标点大小写差异）/ 中等相似（同规则两种措辞）/ 无关 /
 * 空内容 / 超短（退化为整串比较）/ 超长；以及 findMostSimilar 的选取与并列稳定性。
 */
import { describe, expect, it } from 'vitest';
import {
  classifySimilarity,
  contentSimilarity,
  findMostSimilar,
  normalizeForSimilarity,
  SIMILARITY_DUPLICATE,
  SIMILARITY_SIMILAR,
  similarityPercent,
  trigramSet,
} from '../../../src/core/learning/similarity';

const RULE = '依赖安装统一走 pnpm，不要用 npm install 直接装。';
const RULE_LONGER = '依赖安装统一走 pnpm，不要用 npm install 直接装，锁文件必须提交。';
const UNRELATED = '提交信息一律用中文，首行不超过 50 个字符。';

describe('normalizeForSimilarity', () => {
  it('小写 + 标点与空白折叠为单空格 + trim', () => {
    expect(normalizeForSimilarity('  Use  PNPM,  not NPM!  ')).toBe('use pnpm not npm');
  });

  it('连字符与标点等价（npm install / npm-install / npm  install）', () => {
    const canonical = normalizeForSimilarity('npm install');
    expect(normalizeForSimilarity('npm-install')).toBe(canonical);
    expect(normalizeForSimilarity('npm  install,')).toBe(canonical);
  });

  it('中文标点同样被抹掉', () => {
    expect(normalizeForSimilarity('依赖安装，走 pnpm。')).toBe('依赖安装 走 pnpm');
  });

  it('纯标点 → 空串', () => {
    expect(normalizeForSimilarity('———！！！')).toBe('');
    expect(normalizeForSimilarity('   ')).toBe('');
  });
});

describe('trigramSet', () => {
  it('归一化后按字符切 3-gram', () => {
    expect([...trigramSet('abcd')].sort()).toEqual(['abc', 'bcd']);
  });

  it('短于 3 字符 → 整串单元素集合（否则所有短文本会被判为相同）', () => {
    expect([...trigramSet('ab')]).toEqual(['ab']);
    expect([...trigramSet('a')]).toEqual(['a']);
  });

  it('归一化后为空 → 空集', () => {
    expect(trigramSet('').size).toBe(0);
    expect(trigramSet('！！').size).toBe(0);
  });

  it('CJK 逐字切分（中文无空格，token 切分会整句退化成一个词）', () => {
    expect([...trigramSet('依赖安装')].sort()).toEqual(['依赖安', '赖安装']);
  });
});

describe('contentSimilarity', () => {
  it('全等 → 1', () => {
    expect(contentSimilarity(RULE, RULE)).toBe(1);
  });

  it('只差标点 / 大小写 / 空白 → 1（归一化后同一串）', () => {
    expect(contentSimilarity('Use PNPM, not npm!', 'use  pnpm   not npm')).toBe(1);
    expect(contentSimilarity('依赖安装，走 pnpm。', '依赖安装 走 pnpm')).toBe(1);
  });

  it('对称性', () => {
    expect(contentSimilarity(RULE, RULE_LONGER)).toBe(contentSimilarity(RULE_LONGER, RULE));
  });

  it('同一条规则的两种措辞落在 similar 档（不是 duplicate）', () => {
    const score = contentSimilarity(RULE, RULE_LONGER);
    expect(score).toBeGreaterThanOrEqual(SIMILARITY_SIMILAR);
    expect(score).toBeLessThan(SIMILARITY_DUPLICATE);
    expect(classifySimilarity(score)).toBe('similar');
  });

  it('无关内容 → distinct 且分数很低', () => {
    const score = contentSimilarity(RULE, UNRELATED);
    expect(score).toBeLessThan(0.3);
    expect(classifySimilarity(score)).toBe('distinct');
  });

  it('空内容：两边都空 → 1；只有一边空 → 0', () => {
    expect(contentSimilarity('', '')).toBe(1);
    expect(contentSimilarity('   ', '！！')).toBe(1);
    expect(contentSimilarity('', RULE)).toBe(0);
    expect(contentSimilarity(RULE, '')).toBe(0);
  });

  it('超短内容：整串相等才算相同', () => {
    expect(contentSimilarity('ab', 'ab')).toBe(1);
    expect(contentSimilarity('ab', 'cd')).toBe(0);
    expect(contentSimilarity('ab', 'abc')).toBe(0);
  });

  it('超长内容：全等仍为 1；追加一小段仍判 duplicate', () => {
    // 刻意用**互不重复**的行拼长文：trigram 是集合，`s.repeat(200)` 的集合与 s 的
    // 完全相同，用重复串测不出"长文本上追加一小段影响很小"这条性质
    const long = Array.from({ length: 200 }, (_, i) => `第 ${i} 条：依赖安装走 pnpm-${i}。`).join(
      '\n',
    );
    expect(contentSimilarity(long, long)).toBe(1);
    const score = contentSimilarity(long, `${long}\n补充：CI 里同样适用。`);
    expect(score).toBeGreaterThanOrEqual(SIMILARITY_DUPLICATE);
  });

  it('恒在 [0,1]', () => {
    const samples = ['', '   ', 'a', 'ab', RULE, RULE_LONGER, UNRELATED, 'x'.repeat(5000)];
    for (const a of samples) {
      for (const b of samples) {
        const score = contentSimilarity(a, b);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('确定性：同一对文本多次调用恒等', () => {
    expect(contentSimilarity(RULE, RULE_LONGER)).toBe(contentSimilarity(RULE, RULE_LONGER));
  });
});

describe('classifySimilarity（两档阈值）', () => {
  it.each([
    [1, 'duplicate'],
    [SIMILARITY_DUPLICATE, 'duplicate'],
    [SIMILARITY_DUPLICATE - 0.01, 'similar'],
    [SIMILARITY_SIMILAR, 'similar'],
    [SIMILARITY_SIMILAR - 0.01, 'distinct'],
    [0, 'distinct'],
  ])('score=%s → %s', (score, verdict) => {
    expect(classifySimilarity(score)).toBe(verdict);
  });

  it('阈值本身取闭区间下界且 duplicate 严于 similar', () => {
    expect(SIMILARITY_DUPLICATE).toBeGreaterThan(SIMILARITY_SIMILAR);
  });
});

describe('findMostSimilar', () => {
  const candidates = [
    { id: 'a-unrelated', content: UNRELATED },
    { id: 'b-similar', content: RULE_LONGER },
    { id: 'c-exact', content: RULE },
  ];

  it('取分数最高的一条（全等胜过相似）', () => {
    const match = findMostSimilar(RULE, candidates);
    expect(match).toMatchObject({ id: 'c-exact', score: 1, verdict: 'duplicate' });
  });

  it('无 duplicate 时返回 similar 档命中', () => {
    const match = findMostSimilar(RULE, [candidates[0] as never, candidates[1] as never]);
    expect(match?.id).toBe('b-similar');
    expect(match?.verdict).toBe('similar');
  });

  it('全部低于 similar 阈值 → null', () => {
    expect(findMostSimilar(RULE, [{ id: 'x', content: UNRELATED }])).toBeNull();
  });

  it('空候选集 → null', () => {
    expect(findMostSimilar(RULE, [])).toBeNull();
  });

  it('并列同分取先出现的候选（调用方按文件名序读盘 → 输出可复现）', () => {
    const tied = [
      { id: 'first', content: RULE },
      { id: 'second', content: RULE },
    ];
    expect(findMostSimilar(RULE, tied)?.id).toBe('first');
  });
});

describe('similarityPercent', () => {
  it('四舍五入到整数百分比', () => {
    expect(similarityPercent(1)).toBe(100);
    expect(similarityPercent(0.789)).toBe(79);
    expect(similarityPercent(0)).toBe(0);
  });
});
