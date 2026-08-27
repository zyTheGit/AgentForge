/**
 * config/serialize 单测：SoT YAML 文档序列化的**唯一出口**。
 *
 * 这两条不变量都是正确性约束而非格式偏好：
 * - `lineWidth: 0`——长 content（learning 正文、custom 规则、mcp 参数）不得被折成
 *   多行折叠标量，否则往返读回已不是写入时那一份；
 * - 补尾换行——缺了每次 diff 都带 "\ No newline at end of file"。
 *
 * 「逐字节不变」用**原内联表达式**作基准断言：收敛前 10 个调用点写的都是
 * `ensureTrailingNewline(stringifyYaml(x, { lineWidth: 0 }))`，这里对同一组夹具
 * 逐字节比对，任何参数漂移（lineWidth 被改、换成 flow 风格）都会立刻失败。
 */
import { describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { serializeYamlDoc } from '../../src/core/config/serialize';
import { ensureTrailingNewline } from '../../src/infra/fsutil';

/** 收敛前各调用点内联的那一行（逐字节基准）。 */
function legacyInline(value: unknown): string {
  return ensureTrailingNewline(stringifyYaml(value, { lineWidth: 0 }));
}

const FIXTURES: readonly { readonly name: string; readonly value: unknown }[] = [
  { name: '空对象', value: {} },
  { name: '最小 profile 形态', value: { version: 1, targets: ['opencode'] } },
  {
    name: 'habits 骨架形态（嵌套 + 数组 + passthrough detected）',
    value: {
      version: 1,
      runtime: { node: { manager: 'fnm' } },
      detected: { package_managers: [{ name: 'pnpm', source: 'path' }], shell: 'pwsh' },
    },
  },
  {
    name: 'learning 形态（超长 content + 中文 + 引号）',
    value: {
      id: 'l20260827000000-abcdef',
      content: `${'很长的一行内容 '.repeat(40)}末尾 "带引号" 与 : 冒号`,
      promoted: false,
      promoted_at: null,
    },
  },
  { name: '含换行的多行字符串', value: { note: 'first\nsecond\nthird\n' } },
  { name: '空数组与空字符串', value: { templates: [], name: '' } },
];

describe('serializeYamlDoc', () => {
  it.each(FIXTURES)('与收敛前的内联写法逐字节一致：$name', ({ value }) => {
    expect(serializeYamlDoc(value)).toBe(legacyInline(value));
  });

  it('长字符串不被折行（lineWidth: 0；默认 80 列会改写内容）', () => {
    const long = 'x'.repeat(500);
    const out = serializeYamlDoc({ content: long });
    expect(out).toContain(long);
    expect(out.split('\n').filter((l) => l !== '')).toHaveLength(1);
  });

  it('输出以单个换行结尾（yaml 已带尾换行时不再追加）', () => {
    const out = serializeYamlDoc({ version: 1 });
    expect(out).toBe('version: 1\n');
  });

  it('可被 YAML 解析器读回（往返一致）', async () => {
    const { parse } = await import('yaml');
    const value = { version: 1, templates: ['a', 'b'], nested: { k: 'v' } };
    expect(parse(serializeYamlDoc(value))).toEqual(value);
  });
});
