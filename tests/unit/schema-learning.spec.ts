/**
 * learning schema 单测（Spec §4.3：id 正则边界 / confidence / datetime / 默认值）。
 */
import { describe, expect, it } from 'vitest';
import { LearningSchema } from '../../src/schema/learning';

/** 构造一条合法 learning（其余字段用例内覆盖）。 */
function validLearning(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'use-uv-not-pip',
    scope: 'project',
    confidence: 0.8,
    trigger: '用户配置了 uv 管理 Python 依赖',
    content: '项目依赖安装一律用 uv，不用 pip。',
    category: 'tooling',
    source: 'chat-summary',
    created_at: '2026-08-21T10:00:00Z',
    updated_at: '2026-08-21T10:00:00Z',
    ...overrides,
  };
}

describe('LearningSchema id 正则（Spec §4.3：^[a-z0-9][a-z0-9_-]{1,63}$）', () => {
  it.each([
    ['ab', true],
    ['a1-b_c', true],
    ['0-start-with-digit', true],
    ['a'.repeat(64), true], // 总长 64（1 + 63）为上界
    ['a', false], // 总长 1：首字符后至少还需 1 个字符
    ['a'.repeat(65), false], // 总长 65 越界
    ['-ab', false], // 非法首字符
    ['_ab', false],
    ['Abc', false], // 大写
    ['ab.c', false], // 非法字符 .
    ['ab c', false], // 空格
    ['中文', false],
  ])('id=%j → 合法性 %s', (id, ok) => {
    expect(LearningSchema.safeParse(validLearning({ id })).success).toBe(ok);
  });

  it('非法 id 的错误信息含正则说明（友好提示）', () => {
    const result = LearningSchema.safeParse(validLearning({ id: 'BAD' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('learning id');
    }
  });
});

describe('LearningSchema 字段校验（Spec §4.3）', () => {
  it('合法完整条目（promoted_at 为 null）', () => {
    const data = LearningSchema.parse(validLearning({ promoted_at: null }));
    expect(data.id).toBe('use-uv-not-pip');
    expect(data.promoted).toBe(false); // 默认
    expect(data.promoted_at).toBeNull(); // 默认
    expect(data.promote_target).toBe('custom_rule'); // 默认
  });

  it('promoted 条目：promoted_at 为 ISO datetime、promote_target 为 skill', () => {
    const data = LearningSchema.parse(
      validLearning({
        promoted: true,
        promoted_at: '2026-08-21T12:30:00Z',
        promote_target: 'skill',
      }),
    );
    expect(data.promoted).toBe(true);
    expect(data.promoted_at).toBe('2026-08-21T12:30:00Z');
    expect(data.promote_target).toBe('skill');
  });

  it('confidence 边界：0 与 1 合法，越界失败', () => {
    expect(LearningSchema.safeParse(validLearning({ confidence: 0 })).success).toBe(true);
    expect(LearningSchema.safeParse(validLearning({ confidence: 1 })).success).toBe(true);
    expect(LearningSchema.safeParse(validLearning({ confidence: -0.01 })).success).toBe(false);
    expect(LearningSchema.safeParse(validLearning({ confidence: 1.01 })).success).toBe(false);
  });

  it('scope / category / promote_target 枚举校验', () => {
    expect(LearningSchema.safeParse(validLearning({ scope: 'team' })).success).toBe(false);
    expect(LearningSchema.safeParse(validLearning({ category: 'perf' })).success).toBe(false);
    expect(LearningSchema.safeParse(validLearning({ promote_target: 'agent' })).success).toBe(
      false,
    );
    expect(LearningSchema.safeParse(validLearning({ category: 'code-style' })).success).toBe(true);
    expect(
      LearningSchema.safeParse(validLearning({ category: 'security', scope: 'user' })).success,
    ).toBe(true);
  });

  it('datetime 字段必须是 ISO-8601：纯日期 / 乱串 / 带时区偏移', () => {
    expect(LearningSchema.safeParse(validLearning({ created_at: '2026-08-21' })).success).toBe(
      false,
    );
    expect(LearningSchema.safeParse(validLearning({ created_at: 'not-a-date' })).success).toBe(
      false,
    );
    // ISO-8601 时区偏移形式合法（用户手写场景）
    expect(
      LearningSchema.safeParse(validLearning({ created_at: '2026-08-21T18:00:00+08:00' })).success,
    ).toBe(true);
  });

  it('必填字段缺失 → 失败（trigger/content/source 等）', () => {
    for (const key of ['trigger', 'content', 'source', 'confidence']) {
      const input = validLearning();
      delete input[key];
      expect(LearningSchema.safeParse(input).success).toBe(false);
    }
  });
});
