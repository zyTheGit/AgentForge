/**
 * auto-capture 单测（Spec §4.2 / §7.4 / §5.2）：三档的有效值判定与 Learning Protocol 正文。
 *
 * 这里只测"声明值 → 有效值"这一层——渲染层是否插段落由 composer 单测覆盖，
 * status / doctor 的措辞由各自单测覆盖。三处共用同一判定，改口径只需改这一份断言。
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveAutoCapture,
  LEARNING_PROTOCOL_HEADING,
  LEARNING_PROTOCOL_SECTION,
  rendersLearningProtocol,
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

describe('effectiveAutoCapture — 渲染层口径与环境无关（§7.4）', () => {
  it('缺省 → off（schema 默认）', () => {
    expect(effectiveAutoCapture(profileWith())).toBe('off');
  });

  it('prompt → prompt', () => {
    expect(effectiveAutoCapture(profileWith('prompt'))).toBe('prompt');
  });

  it('hook → off（MVP 无 target 侧钩子写入）', () => {
    expect(effectiveAutoCapture(profileWith('hook'))).toBe('off');
  });
});

describe('resolveAutoCapture — 展示层状态（§7.4）', () => {
  it('缺省 → off，无未实现声明、非 CI', () => {
    expect(resolveAutoCapture(profileWith(), { ci: false })).toEqual({
      declared: 'off',
      effective: 'off',
      ciNoCapture: false,
      unimplemented: false,
    });
  });

  it('hook → 生效 off 并标记未实现', () => {
    const state = resolveAutoCapture(profileWith('hook'), { ci: false });
    expect(state.declared).toBe('hook');
    expect(state.effective).toBe('off');
    expect(state.unimplemented).toBe(true);
  });

  it('CI 为真 → 只标 ciNoCapture，**不改变生效档位**（hash 跨环境稳定）', () => {
    for (const declared of ['off', 'prompt', 'hook'] as const) {
      const inCi = resolveAutoCapture(profileWith(declared), { ci: true });
      const local = resolveAutoCapture(profileWith(declared), { ci: false });
      expect(inCi.ciNoCapture).toBe(true);
      expect(inCi.effective).toBe(local.effective);
      expect(inCi.declared).toBe(declared);
    }
  });
});

describe('rendersLearningProtocol — 渲染判据（三处共用，§5.2）', () => {
  it('prompt → true；off / hook 归并后 → false', () => {
    expect(rendersLearningProtocol('prompt')).toBe(true);
    expect(rendersLearningProtocol('off')).toBe(false);
    // hook 先经 effectiveAutoCapture 归并为 off，渲染层不会直接拿到 hook
    expect(rendersLearningProtocol(effectiveAutoCapture(profileWith('hook')))).toBe(false);
  });
});

describe('LEARNING_PROTOCOL_SECTION — 固定正文（§5.2 / §7.4 五条护栏）', () => {
  it('以标题常量起头（三处共用同一字面量）', () => {
    expect(LEARNING_PROTOCOL_SECTION.startsWith(LEARNING_PROTOCOL_HEADING)).toBe(true);
    expect(LEARNING_PROTOCOL_HEADING).toBe('## Learning Protocol');
  });

  it('含可复制的 aforge learn 命令行', () => {
    expect(LEARNING_PROTOCOL_SECTION).toContain('aforge learn --file -');
  });

  it('明说不要塞会话原文 / 凭据（护栏 4）', () => {
    expect(LEARNING_PROTOCOL_SECTION).toMatch(/transcript/i);
    expect(LEARNING_PROTOCOL_SECTION).toMatch(/secret/i);
  });

  it('不指示 agent 自行 sync（护栏 1：进投影恒由人工）', () => {
    expect(LEARNING_PROTOCOL_SECTION).toContain('do not run it yourself');
  });

  it('明说被拒时不要重试（CI 下写入必被守卫拒掉，护栏 3）', () => {
    expect(LEARNING_PROTOCOL_SECTION).toContain('do not retry');
  });

  it('纯 ASCII（Windows GBK 控制台与四家 target 均安全）', () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言正文仅含 ASCII，字符类必须显式覆盖控制字符区间（\x00-\x1F）
    expect(LEARNING_PROTOCOL_SECTION).toMatch(/^[\x00-\x7F]*$/);
  });
});
