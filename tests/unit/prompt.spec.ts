/**
 * prompt 封装单测（M9，Spec §7.1.1）：
 * - assertTty：非 TTY（CI / 管道）→ ConfigError(2)，hint 引导非交互参数；
 * - defaultTtyProbe：stdin/stdout 均为 TTY 才可交互；
 * - createClackPrompt：动态加载成功且四个方法齐备（交互渲染行为由集成层
 *   的 fake prompt 驱动测试覆盖，真 clack 渲染依赖人工 TTY 验收）。
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../src/core/errors';
import {
  assertTty,
  createClackPrompt,
  defaultTtyProbe,
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
