/**
 * confidence 启发式打分与时间衰减单测（core/learning/scoring）。
 *
 * 三条被测契约：
 * 1. 每个信号的边界（过短 / 区间内 / 超长、命中与未命中）；
 * 2. 归一化恒不越界 [0,1] 且落在 [AUTO_SCORE_FLOOR, AUTO_SCORE_CEILING]；
 * 3. **确定性**——同一输入恒得同一输出，衰减只随显式注入的 now 变化。
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_SCORE_CEILING,
  AUTO_SCORE_FLOOR,
  ageInDays,
  CONFIDENCE_WEIGHTS,
  type ConfidenceInput,
  DECAY_FLOOR_RATIO,
  DECAY_GRACE_DAYS,
  DECAY_HALF_LIFE_DAYS,
  decayConfidence,
  roundConfidence,
  STALE_AFTER_DAYS,
  scoreActionable,
  scoreConfidence,
  scoreDirective,
  scoreLearningConfidence,
  scoreLength,
  scoreMetadata,
  scoreReference,
  scoreScope,
} from '../../../src/core/learning/scoring';

/** 最小信息量输入：只有 scope 这一个弱信号（其余全 0）。 */
const MINIMAL: ConfidenceInput = {
  content: '规则内容',
  trigger: '',
  category: 'other',
  scope: 'project',
  promoteTarget: 'custom_rule',
};

/** 满信号输入：六个信号全部拉满。 */
const RICH: ConfidenceInput = {
  content: [
    '必须用 `pnpm install` 安装依赖，锁文件见 src/config/pnpm-lock.yaml：',
    '```sh',
    'pnpm install --frozen-lockfile',
    '```',
  ].join('\n'),
  trigger: 'when adding dependencies',
  category: 'tooling',
  scope: 'project',
  promoteTarget: 'skill',
};

describe('权重表', () => {
  it('六个信号权重合计为 1.0', () => {
    const total = Object.values(CONFIDENCE_WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('每个权重都是正数', () => {
    for (const weight of Object.values(CONFIDENCE_WEIGHTS)) {
      expect(weight).toBeGreaterThan(0);
    }
  });
});

describe('scoreLength（长度信号）', () => {
  it('空串 / 过短 → 0', () => {
    expect(scoreLength('')).toBe(0);
    expect(scoreLength('   ')).toBe(0);
    expect(scoreLength('a'.repeat(11))).toBe(0);
    // 下界处线性段起点也是 0（(12-12)/(40-12)）
    expect(scoreLength('a'.repeat(12))).toBe(0);
  });

  it('12–40 线性上升且严格单调', () => {
    const at20 = scoreLength('a'.repeat(20));
    const at30 = scoreLength('a'.repeat(30));
    expect(at20).toBeGreaterThan(0);
    expect(at30).toBeGreaterThan(at20);
    expect(at30).toBeLessThan(1);
  });

  it('40–600 满分（含端点）', () => {
    expect(scoreLength('a'.repeat(40))).toBe(1);
    expect(scoreLength('a'.repeat(300))).toBe(1);
    expect(scoreLength('a'.repeat(600))).toBe(1);
  });

  it('超过 600 递减；2400 及以上落在地板 0.3（不为 0）', () => {
    const at900 = scoreLength('a'.repeat(900));
    const at1800 = scoreLength('a'.repeat(1800));
    expect(at900).toBeLessThan(1);
    expect(at1800).toBeLessThan(at900);
    expect(scoreLength('a'.repeat(2400))).toBeCloseTo(0.3, 10);
    expect(scoreLength('a'.repeat(100_000))).toBeCloseTo(0.3, 10);
  });

  it('长度按 trim 后计算（首尾空白不算信息量）', () => {
    expect(scoreLength(`   ${'a'.repeat(40)}   `)).toBe(1);
  });

  it('恒在 [0,1]', () => {
    for (const n of [0, 1, 11, 12, 39, 40, 600, 601, 2400, 9999]) {
      const score = scoreLength('x'.repeat(n));
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe('scoreActionable（可执行信息）', () => {
  it('纯叙述 → 0', () => {
    expect(scoreActionable('团队约定统一走内网镜像')).toBe(0);
  });

  it('只命中命令名 → 1/3', () => {
    expect(scoreActionable('依赖安装走 pnpm 而不是别的')).toBeCloseTo(1 / 3, 10);
  });

  it('代码块 + 命令名 → 2/3（围栏内没有行内 code）', () => {
    expect(scoreActionable(['```sh', 'npm ci', '```'].join('\n'))).toBeCloseTo(2 / 3, 10);
  });

  it('代码块 + 行内 code + 命令名 → 1', () => {
    expect(scoreActionable(RICH.content)).toBe(1);
  });

  it('不把同时是常用英文词的名字当命令（make / go 不在白名单）', () => {
    expect(scoreActionable('make sure you go through the checklist')).toBe(0);
  });

  it('只扫描正文前 4000 字符（超长文本上的回溯上限，见 SIGNAL_SCAN_LIMIT）', () => {
    const padding = '天'.repeat(5000);
    expect(scoreActionable(`${padding} npm ci`)).toBe(0);
    expect(scoreActionable(`npm ci ${padding}`)).toBeCloseTo(1 / 3, 10);
  });
});

describe('scoreReference（具体引用）', () => {
  it('无引用 → 0', () => {
    expect(scoreReference('提交前先跑一遍全量校验')).toBe(0);
  });

  it('只有文件名 → 0.5', () => {
    expect(scoreReference('改动请同步 profile.yaml')).toBe(0.5);
  });

  it('文件名 + 路径 → 1', () => {
    expect(scoreReference('见 src/core/learning/store.ts')).toBe(1);
  });
});

describe('scoreDirective（规范性表述）', () => {
  it.each([
    ['依赖安装必须走 pnpm', 1],
    ['禁止直接改投影产物', 1],
    ['prefer uv over pip', 1],
    ['you must never force push', 1],
    ['今天发现构建变慢了', 0],
    ['构建耗时从 30s 涨到 90s', 0],
  ])('content=%j → %s', (content, expected) => {
    expect(scoreDirective(content)).toBe(expected);
  });
});

describe('scoreMetadata / scoreScope', () => {
  it('三项全默认 → 0；全非默认 → 1；单项 → 1/3', () => {
    expect(scoreMetadata(MINIMAL)).toBe(0);
    expect(scoreMetadata(RICH)).toBe(1);
    expect(scoreMetadata({ ...MINIMAL, trigger: 'when installing' })).toBeCloseTo(1 / 3, 10);
    expect(scoreMetadata({ ...MINIMAL, category: 'tooling' })).toBeCloseTo(1 / 3, 10);
    expect(scoreMetadata({ ...MINIMAL, promoteTarget: 'skill' })).toBeCloseTo(1 / 3, 10);
  });

  it('空白 trigger 不算已填', () => {
    expect(scoreMetadata({ ...MINIMAL, trigger: '   ' })).toBe(0);
  });

  it('project 1 / user 0.5', () => {
    expect(scoreScope('project')).toBe(1);
    expect(scoreScope('user')).toBe(0.5);
  });
});

describe('scoreConfidence（汇总与归一化）', () => {
  it('最小信息量 → 0.27（只有 scope 一档：0.2 + 0.1 x 0.7）', () => {
    const score = scoreConfidence(MINIMAL);
    expect(score.weighted).toBeCloseTo(0.1, 10);
    expect(score.value).toBe(0.27);
  });

  it('满信号 → 上限 0.9', () => {
    const score = scoreConfidence(RICH);
    expect(score.weighted).toBeCloseTo(1, 10);
    expect(score.value).toBe(AUTO_SCORE_CEILING);
  });

  it('恒落在 [AUTO_SCORE_FLOOR, AUTO_SCORE_CEILING] ⊂ [0,1]', () => {
    const samples: ConfidenceInput[] = [
      MINIMAL,
      RICH,
      { ...MINIMAL, content: '' },
      { ...MINIMAL, content: 'x'.repeat(50_000), scope: 'user' },
      { ...RICH, scope: 'user', category: 'other' },
    ];
    for (const sample of samples) {
      const { value } = scoreConfidence(sample);
      expect(value).toBeGreaterThanOrEqual(AUTO_SCORE_FLOOR);
      expect(value).toBeLessThanOrEqual(AUTO_SCORE_CEILING);
    }
  });

  it('确定性：同一输入多次调用完全相等（含 breakdown）', () => {
    expect(scoreConfidence(RICH)).toEqual(scoreConfidence(RICH));
    expect(scoreConfidence(MINIMAL)).toEqual(scoreConfidence(MINIMAL));
  });

  it('落盘值只保留两位小数（YAML 文本逐字节稳定）', () => {
    for (const sample of [MINIMAL, RICH, { ...MINIMAL, content: 'a'.repeat(25) }]) {
      const { value } = scoreConfidence(sample);
      expect(value).toBe(Math.round(value * 100) / 100);
    }
  });

  it('breakdown 覆盖全部六个信号，权重与权重表一致', () => {
    const { signals } = scoreConfidence(RICH);
    expect(signals.map((s) => s.id)).toEqual(Object.keys(CONFIDENCE_WEIGHTS));
    for (const signal of signals) {
      expect(signal.weight).toBe(CONFIDENCE_WEIGHTS[signal.id]);
      expect(signal.score).toBeGreaterThanOrEqual(0);
      expect(signal.score).toBeLessThanOrEqual(1);
      expect(signal.reason).not.toBe('');
    }
  });

  it('信息更足的条目分更高（单调性的行为化断言）', () => {
    expect(scoreConfidence(RICH).value).toBeGreaterThan(scoreConfidence(MINIMAL).value);
    expect(scoreConfidence(RICH).value).toBeGreaterThan(
      scoreConfidence({ ...RICH, scope: 'user' }).value,
    );
  });

  it('scoreLearningConfidence 从落盘形态重算，与创建时一致', () => {
    const fromEntry = scoreLearningConfidence({
      content: RICH.content,
      trigger: RICH.trigger,
      category: RICH.category,
      scope: RICH.scope,
      promote_target: RICH.promoteTarget,
    });
    expect(fromEntry).toEqual(scoreConfidence(RICH));
  });
});

describe('roundConfidence', () => {
  it('两位小数 + 夹到 [0,1]', () => {
    expect(roundConfidence(0.123_456)).toBe(0.12);
    expect(roundConfidence(0.125)).toBe(0.13);
    expect(roundConfidence(-1)).toBe(0);
    expect(roundConfidence(2)).toBe(1);
    expect(roundConfidence(Number.NaN)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 时间衰减
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-01T00:00:00.000Z');

/** 构造一条「距 NOW 若干天前更新」的衰减输入。 */
function aged(days: number, overrides: { confidence?: number; promoted?: boolean } = {}) {
  return {
    confidence: overrides.confidence ?? 0.8,
    promoted: overrides.promoted ?? false,
    updated_at: new Date(NOW.getTime() - days * 86_400_000).toISOString(),
  };
}

describe('ageInDays', () => {
  it('按注入的 now 计算，不读系统时钟', () => {
    expect(ageInDays('2026-08-02T00:00:00.000Z', NOW)).toBeCloseTo(30, 6);
  });

  it('未来时间戳 / 不可解析 → 0（不倒着衰减）', () => {
    expect(ageInDays('2099-01-01T00:00:00.000Z', NOW)).toBe(0);
    expect(ageInDays('not-a-date', NOW)).toBe(0);
  });
});

describe('decayConfidence', () => {
  it('已 promote → 不衰减（哪怕很老）', () => {
    const decay = decayConfidence(aged(3650, { promoted: true }), NOW);
    expect(decay.effective).toBe(0.8);
    expect(decay.decayed).toBe(false);
    expect(decay.stale).toBe(false);
  });

  it('宽限期内（<= 30 天）→ 不衰减', () => {
    expect(decayConfidence(aged(0), NOW).effective).toBe(0.8);
    expect(decayConfidence(aged(DECAY_GRACE_DAYS), NOW).effective).toBe(0.8);
    expect(decayConfidence(aged(DECAY_GRACE_DAYS), NOW).decayed).toBe(false);
  });

  it('过了宽限期即开始衰减', () => {
    const decay = decayConfidence(aged(DECAY_GRACE_DAYS + 1), NOW);
    expect(decay.decayed).toBe(true);
    expect(decay.effective).toBeLessThan(0.8);
  });

  it('对 age 单调不增，且长跨度上严格下降', () => {
    const ages = [0, 10, 30, 31, 60, 90, 120, 200, 365, 1000, 3650];
    const values = ages.map((age) => decayConfidence(aged(age), NOW).effective);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1] as number);
    }
    expect(values.at(-1)).toBeLessThan(values[0] as number);
  });

  it('半衰期语义：宽限期 + 一个半衰期后，可衰减部分恰好剩一半', () => {
    const decay = decayConfidence(aged(DECAY_GRACE_DAYS + DECAY_HALF_LIFE_DAYS), NOW);
    const expected = 0.8 * (DECAY_FLOOR_RATIO + (1 - DECAY_FLOOR_RATIO) * 0.5);
    expect(decay.effective).toBeCloseTo(expected, 10);
  });

  it('地板：再老也不低于 base x DECAY_FLOOR_RATIO', () => {
    const decay = decayConfidence(aged(100_000), NOW);
    expect(decay.effective).toBeGreaterThanOrEqual(0.8 * DECAY_FLOOR_RATIO - 1e-12);
    expect(decay.effective).toBeCloseTo(0.8 * DECAY_FLOOR_RATIO, 6);
  });

  it('边界恒在 [0,1]（base 取 0 / 1 / 越界值）', () => {
    for (const confidence of [0, 0.5, 1, -1, 2]) {
      for (const age of [0, 31, 365, 10_000]) {
        const decay = decayConfidence(aged(age, { confidence }), NOW);
        expect(decay.effective).toBeGreaterThanOrEqual(0);
        expect(decay.effective).toBeLessThanOrEqual(1);
        expect(decay.effective).toBeLessThanOrEqual(decay.base);
      }
    }
  });

  it('base 为 0 → effective 恒 0', () => {
    expect(decayConfidence(aged(365, { confidence: 0 }), NOW).effective).toBe(0);
  });

  it('stale 在 180 天处翻转；已 promote 恒不 stale', () => {
    expect(decayConfidence(aged(STALE_AFTER_DAYS - 1), NOW).stale).toBe(false);
    expect(decayConfidence(aged(STALE_AFTER_DAYS), NOW).stale).toBe(true);
    expect(decayConfidence(aged(STALE_AFTER_DAYS, { promoted: true }), NOW).stale).toBe(false);
  });

  it('确定性：同一 (entry, now) 多次调用完全相等', () => {
    const entry = aged(200);
    expect(decayConfidence(entry, NOW)).toEqual(decayConfidence(entry, NOW));
  });
});
