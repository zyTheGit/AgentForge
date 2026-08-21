/**
 * renderer 单测（Spec §5.4）：语法校验 → ConfigError(2)（message 带解析位置）、
 * noEscape（Markdown 不转义）、空变量 #if 省略（不输出 "Not specified"）、
 * 输出规范化与幂等。
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, ExitCode } from '../../../src/core/errors';
import { renderTemplate, validateTemplate } from '../../../src/core/generate/renderer';

/** 断言 promise 拒绝为 ConfigError(code 2)，并返回错误供进一步检查。 */
async function expectConfigError(promise: Promise<unknown>): Promise<ConfigError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    const e = err as ConfigError;
    expect(e.code).toBe(ExitCode.Config);
    return e;
  }
  throw new Error('期望抛出 ConfigError，但 promise 正常完成');
}

describe('validateTemplate', () => {
  it('合法模板（#if / #each / {{else if}} 链式）通过', async () => {
    await expect(
      validateTemplate(
        '{{#if ai.style}}## Style\n{{ai.style}}\n{{/if}}{{#each ai.forbid}}- {{this}}\n{{/each}}',
      ),
    ).resolves.toBeUndefined();
  });

  it('未闭合 {{#if}} → ConfigError(2)，message 带解析错误位置（行号）', async () => {
    const err = await expectConfigError(validateTemplate('{{#if unclosed'));
    expect(err.message).toContain('line 1');
    expect(err.hint).toBeDefined();
  });

  it('未闭合 {{#each}} → ConfigError(2)', async () => {
    await expectConfigError(validateTemplate('ok\n{{#each ai.forbid}}\n- {{this}}'));
  });

  it('多余闭合标签 → ConfigError(2)', async () => {
    await expectConfigError(validateTemplate('{{/if}}'));
  });

  it('label（模板 id）出现在 message 中', async () => {
    const err = await expectConfigError(validateTemplate('{{#if x', '模板 extra/one '));
    expect(err.message).toContain('extra/one');
  });
});

describe('renderTemplate', () => {
  it('noEscape：<path> / **bold** / & 原样输出，不做 HTML 转义', async () => {
    const out = await renderTemplate('Editor: {{tools.editor}}', {
      tools: { editor: 'C:\\<work>\\**bold** & <tags>' },
    });
    expect(out).toBe('Editor: C:\\<work>\\**bold** & <tags>\n');
  });

  it('undefined / null / 空数组在 #if 下省略小节，不输出 "Not specified"', async () => {
    const tpl = [
      '{{#if ai.style}}## Style',
      '{{ai.style}}',
      '{{/if}}{{#if ai.verification}}## Verification',
      '{{#each ai.verification}}- {{this}}',
      '{{/each}}{{/if}}',
      '## End',
    ].join('\n');
    const out = await renderTemplate(tpl, { ai: {} });
    expect(out).toBe('## End\n');
    expect(out).not.toContain('Not specified');
  });

  it('变量插值 + each 遍历（@first 加粗、其余项前加 ", then"）', async () => {
    const out = await renderTemplate(
      'prefer {{#each runtime.package_managers}}{{#if @first}}**{{this}}**{{else}}, then {{this}}{{/if}}{{/each}}.',
      { runtime: { package_managers: ['pnpm', 'bun', 'npm'] } },
    );
    expect(out).toBe('prefer **pnpm**, then bun, then npm.\n');
    const two = await renderTemplate(
      'prefer {{#each runtime.package_managers}}{{#if @first}}**{{this}}**{{else}}, then {{this}}{{/if}}{{/each}}.',
      { runtime: { package_managers: ['pnpm', 'npm'] } },
    );
    expect(two).toBe('prefer **pnpm**, then npm.\n');
    const one = await renderTemplate(
      'prefer {{#each runtime.package_managers}}{{#if @first}}**{{this}}**{{else}}, then {{this}}{{/if}}{{/each}}.',
      { runtime: { package_managers: ['pnpm'] } },
    );
    expect(one).toBe('prefer **pnpm**.\n');
  });

  it('尾部多余空行被 trim，统一单个换行结尾（中间结构原样保留）', async () => {
    const out = await renderTemplate('# Title\n\n\nbody\n\n\n\n', {});
    expect(out).toBe('# Title\n\n\nbody\n');
  });

  it('首部空行被剥除', async () => {
    const out = await renderTemplate('\n\n# Title\n', {});
    expect(out).toBe('# Title\n');
  });

  it('幂等：同输入两次渲染输出完全一致', async () => {
    const source = '{{#if ai.style}}## Style\n{{ai.style}}\n{{/if}}';
    const data = { ai: { style: 'concise' } };
    expect(await renderTemplate(source, data)).toBe(await renderTemplate(source, data));
  });

  it('语法错误 → ConfigError(2)（compile 路径兜底）', async () => {
    await expectConfigError(renderTemplate('{{#if unclosed', {}));
  });
});
