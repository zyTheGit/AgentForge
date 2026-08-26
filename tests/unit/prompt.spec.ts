/**
 * prompt 封装单测（M9，Spec §7.1.1）：
 * - assertTty：非 TTY（CI / 管道）→ ConfigError(2)，hint 引导非交互参数；
 * - defaultTtyProbe：stdin/stdout 均为 TTY 才可交互；
 * - createClackPrompt：动态加载成功且四个方法齐备（交互渲染行为由集成层
 *   的 fake prompt 驱动测试覆盖，真 clack 渲染依赖人工 TTY 验收）；
 * - CancelledError（P2 修复）：取消不再静默 exit 0，而是可识别的错误 + 退出码 130。
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../src/core/errors';
import {
  assertTty,
  CancelledError,
  createClackPrompt,
  defaultTtyProbe,
  isCancelledError,
  type TtyProbe,
} from '../../src/infra/prompt';

function probe(interactive: boolean): TtyProbe {
  return { isInteractive: () => interactive };
}

describe('assertTty（非 TTY → ConfigError(2)）', () => {
  it('非交互（管道 / CI）→ ConfigError，code=2 且 hint 引导非交互参数', () => {
    try {
      assertTty(probe(false));
      expect.unreachable('应抛 ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const configErr = err as ConfigError;
      expect(configErr.code).toBe(2);
      expect(configErr.message).toContain('非 TTY');
      expect(configErr.hint).toContain('非交互');
    }
  });

  it('交互环境（TTY）→ 不抛', () => {
    expect(() => assertTty(probe(true))).not.toThrow();
  });
});

describe('defaultTtyProbe（stdin 与 stdout 均为 TTY 才可交互）', () => {
  it('两者均 TTY → true', () => {
    expect(
      defaultTtyProbe(
        { isTTY: true } as unknown as NodeJS.ReadableStream,
        { isTTY: true } as unknown as NodeJS.WritableStream,
      ).isInteractive(),
    ).toBe(true);
  });

  it.each([
    ['stdin 非 TTY（输入重定向）', { isTTY: false }, { isTTY: true }],
    ['stdout 非 TTY（管道 / CI 日志收集）', { isTTY: true }, { isTTY: false }],
    ['两者均非 TTY', { isTTY: false }, { isTTY: false }],
  ])('%s → false', (_name, stdin, stdout) => {
    expect(
      defaultTtyProbe(
        stdin as unknown as NodeJS.ReadableStream,
        stdout as unknown as NodeJS.WritableStream,
      ).isInteractive(),
    ).toBe(false);
  });

  it('isTTY 属性缺失（非控制台句柄）→ false', () => {
    expect(
      defaultTtyProbe(
        {} as unknown as NodeJS.ReadableStream,
        {} as unknown as NodeJS.WritableStream,
      ).isInteractive(),
    ).toBe(false);
  });
});

describe('createClackPrompt（@clack/prompts 动态加载）', () => {
  it('加载成功且四个方法齐备（select/confirm/multiselect/note）', async () => {
    const prompt = await createClackPrompt();
    expect(typeof prompt.select).toBe('function');
    expect(typeof prompt.confirm).toBe('function');
    expect(typeof prompt.multiselect).toBe('function');
    expect(typeof prompt.note).toBe('function');
  });
});

describe('CancelledError（P2：取消不再静默 exit 0）', () => {
  it('退出码 130、name 可识别、默认 message 说明是用户中断', () => {
    const err = new CancelledError();
    expect(err.exitCode).toBe(130);
    expect(err.name).toBe('CancelledError');
    expect(err.message).toContain('已取消');
    expect(err).toBeInstanceOf(Error);
    // 不属于 AgentForgeError 体系（取消不是失败）：不带 code 字段
    expect((err as unknown as { code?: unknown }).code).toBeUndefined();
  });

  it('自定义 message 透传', () => {
    expect(new CancelledError('在第④步取消').message).toBe('在第④步取消');
  });

  it('isCancelledError：仅对取消错误为真（name 判定，跨 bundle 安全）', () => {
    expect(isCancelledError(new CancelledError())).toBe(true);
    const duck = new Error('已取消');
    duck.name = 'CancelledError';
    expect(isCancelledError(duck)).toBe(true);
    expect(isCancelledError(new Error('boom'))).toBe(false);
    expect(isCancelledError(new ConfigError('bad config'))).toBe(false);
    expect(isCancelledError(undefined)).toBe(false);
  });
});
