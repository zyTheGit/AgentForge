/**
 * auto-capture 单测（Spec §4.2 / §7.4 / §5.2）：三档的有效值判定与 Learning Protocol 正文。
 *
 * 这里只测"声明值 → 有效值"这一层——渲染层是否插段落由 composer 单测覆盖，
 * status / doctor 的措辞由各自单测覆盖。三处共用同一判定，改口径只需改这一份断言。
 */
import { describe, expect, it } from 'vitest';
import {
  LEARNING_PROTOCOL_SECTION,
  resolveAutoCapture,
} from '../../../src/core/learning/auto-capture';
import type { AutoCapture } from '../../../src/schema';
import { ProfileSchema } from '../../../src/schema';

function profileWith(autoCapture?: AutoCapture) {
  return ProfileSchema.parse({
    version: 1,
    targets: ['claude'],
    ...(autoCapture === undefined ? {} : { learning: { auto_capture: autoCapture } }),
  });
}

describe('resolveAutoCapture — 有效档位（§7.4）', () => {
  it('缺省 → off（schema 默认），无降级', () => {
    expect(resolveAutoCapture(profileWith(), { ci: false })).toEqual({
      declared: 'off',
      effective: 'off',
      ciDowngraded: false,
      unimplemented: false,
    });
  });

  it('prompt 且非 CI → 原样生效', () => {
    const state = resolveAutoCapture(profileWith('prompt'), { ci: false });
    expect(state.effective).toBe('prompt');
    expect(state.ciDowngraded).toBe(false);
    expect(state.unimplemented).toBe(false);
  });

  it('hook → 降级为 off 并标记未实现（MVP 无 target 侧钩子写入）', () => {
    const state = resolveAutoCapture(profileWith('hook'), { ci: false });
    expect(state.declared).toBe('hook');
    expect(state.effective).toBe('off');
    expect(state.unimplemented).toBe(true);
    expect(state.ciDowngraded).toBe(false);
  });

  it('CI 为真 → 三档一律降级为 off（护栏 3），且标出 ciDowngraded', () => {
    for (const declared of ['off', 'prompt', 'hook'] as const) {
      const state = resolveAutoCapture(profileWith(declared), { ci: true });
      expect(state.effective).toBe('off');
      expect(state.ciDowngraded).toBe(true);
      expect(state.declared).toBe(declared);
    }
  });

  it('CI 优先于 hook 的未实现判定，但 hook 仍标记为未实现（两条原因可同时成立）', () => {
    const state = resolveAutoCapture(profileWith('hook'), { ci: true });
    expect(state.ciDowngraded).toBe(true);
    expect(state.unimplemented).toBe(true);
  });
});

describe('LEARNING_PROTOCOL_SECTION — 固定正文（§5.2 / §7.4 四条护栏）', () => {
  it('以 ## Learning Protocol 起头，含可复制的 aforge learn 命令行', () => {
    expect(LEARNING_PROTOCOL_SECTION.startsWith('## Learning Protocol')).toBe(true);
    expect(LEARNING_PROTOCOL_SECTION).toContain('aforge learn --file -');
  });

  it('明说不要塞会话原文 / 凭据（护栏 4）', () => {
    expect(LEARNING_PROTOCOL_SECTION).toMatch(/transcript/i);
    expect(LEARNING_PROTOCOL_SECTION).toMatch(/secret/i);
  });

  it('不指示 agent 自行 sync（护栏 1：进投影恒由人工）', () => {
    expect(LEARNING_PROTOCOL_SECTION).toContain('do not run it yourself');
  });

  it('纯 ASCII（Windows GBK 控制台与四家 target 均安全）', () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言正文仅含 ASCII，字符类必须显式覆盖控制字符区间（\x00-\x1F）
    expect(LEARNING_PROTOCOL_SECTION).toMatch(/^[\x00-\x7F]*$/);
  });
});
