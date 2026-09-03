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
  writesSessionHooks,
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

  it('hook → hook（§12 Phase 3 起不再折叠为 off）', () => {
    expect(effectiveAutoCapture(profileWith('hook'))).toBe('hook');
  });
});

describe('resolveAutoCapture — 展示层状态（§7.4）', () => {
  it('缺省 → off、非 CI', () => {
    expect(resolveAutoCapture(profileWith(), { ci: false })).toEqual({
      declared: 'off',
      effective: 'off',
      ciNoCapture: false,
    });
  });

  it('三档的 declared 与 effective 恒等（降级只发生在 target 粒度）', () => {
    for (const declared of ['off', 'prompt', 'hook'] as const) {
      const state = resolveAutoCapture(profileWith(declared), { ci: false });
      expect(state.declared).toBe(declared);
      expect(state.effective).toBe(declared);
    }
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

describe('writesSessionHooks / rendersLearningProtocol — 两条投递通道互斥（§5.2 / §7.4）', () => {
  it('prompt 渲染正文、不写钩子', () => {
    expect(rendersLearningProtocol('prompt')).toBe(true);
    expect(writesSessionHooks('prompt')).toBe(false);
  });

  it('hook 写钩子、不渲染正文（同一份协议不投两遍）', () => {
    expect(writesSessionHooks('hook')).toBe(true);
    expect(rendersLearningProtocol('hook')).toBe(false);
  });

  it('off 两者皆否', () => {
    expect(rendersLearningProtocol('off')).toBe(false);
    expect(writesSessionHooks('off')).toBe(false);
  });

  it('任一档位下两者不同时为真', () => {
    for (const tier of ['off', 'prompt', 'hook'] as const) {
      expect(rendersLearningProtocol(tier) && writesSessionHooks(tier)).toBe(false);
    }
  });
});

describe('LEARNING_PROTOCOL_SECTION — 固定正文（§5.2 / §7.4 六条护栏）', () => {
  it('以标题常量起头（三处共用同一字面量）', () => {
    expect(LEARNING_PROTOCOL_SECTION.startsWith(LEARNING_PROTOCOL_HEADING)).toBe(true);
    expect(LEARNING_PROTOCOL_HEADING).toBe('## Learning Protocol');
  });

  it('含可复制的 aforge learn 命令行', () => {
    expect(LEARNING_PROTOCOL_SECTION).toContain('aforge learn --file -');
  });

  it('管道形态给全（只写 --file - 时 agent 不知道正文怎么喂进去）', () => {
    expect(LEARNING_PROTOCOL_SECTION).toContain('| aforge learn --file -');
  });

  it('给出多行正文的备选形态 --file <path>（管道塞多行容易被截断）', () => {
    expect(LEARNING_PROTOCOL_SECTION).toMatch(/aforge learn --file \w+\.md/);
  });

  it('触发条件里点名"用户的纠正"（信号最强、最容易被丢掉的沉淀时机）', () => {
    expect(LEARNING_PROTOCOL_SECTION).toMatch(/user corrects/i);
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

  it('明说 --print-protocol 的输出不能管道回 learn（agent 最容易的反射式误动作）', () => {
    expect(LEARNING_PROTOCOL_SECTION).toContain('--print-protocol');
    expect(LEARNING_PROTOCOL_SECTION).toMatch(/Never pipe .*--print-protocol/);
  });

  it('纯 ASCII（Windows GBK 控制台与四家 target 均安全）', () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言正文仅含 ASCII，字符类必须显式覆盖控制字符区间（\x00-\x1F）
    expect(LEARNING_PROTOCOL_SECTION).toMatch(/^[\x00-\x7F]*$/);
  });

  it('说明 scope 默认 project、跨项目才用 --scope user（缺了 agent 会猜）', () => {
    expect(LEARNING_PROTOCOL_SECTION).toContain('--scope user');
    expect(LEARNING_PROTOCOL_SECTION).toMatch(/project-scoped by default/i);
  });
});
