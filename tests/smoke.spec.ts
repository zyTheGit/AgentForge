/**
 * M0 冒烟测试（Spec §1.1 技术选型验证）：
 * 1) handlebars 可用：深层路径取值 + {{#if}} 条件 + noEscape 不转义 Markdown 符号（如 <path>）；
 * 2) aforge --version/-V 行为：tsx 开发轨道下输出版本号、退出码 0；无参数输出帮助、退出码 0。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('handlebars 冒烟（SoT 模板引擎）', () => {
  it('渲染深层变量 + #if 条件，且 noEscape 不转义 <path> 等符号', async () => {
    const { default: Handlebars } = await import('handlebars');

    const template = Handlebars.compile(
      [
        '# Rules for {{runtime.cli}}',
        '',
        '- node manager: {{runtime.node.manager}} (v{{runtime.node.version}})',
        '{{#if runtime.node.manager}}',
        '- bootstrap: `fnm use {{runtime.node.version}}` then see <{{runtime.docs}}> for details',
        '{{/if}}',
        '{{#if runtime.missing}}',
        '- SHOULD_NOT_RENDER',
        '{{/if}}',
      ].join('\n'),
      { noEscape: true },
    );

    const output = template({
      runtime: {
        cli: 'aforge',
        node: { manager: 'fnm', version: '22' },
        docs: 'https://example.com/docs',
      },
    });

    expect(output).toContain('# Rules for aforge');
    expect(output).toContain('- node manager: fnm (v22)');
    // noEscape: true → <...> 保持原样，不被转义成 &lt;...&gt;（Markdown 规则文件的关键需求）
    expect(output).toContain('see <https://example.com/docs> for details');
    expect(output).not.toContain('&lt;');
    expect(output).not.toContain('&gt;');
    // falsy 条件分支不渲染
    expect(output).not.toContain('SHOULD_NOT_RENDER');
  });
});

describe('aforge --version 冒烟（tsx 开发轨道）', () => {
  const runAforge = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

  it.each(['--version', '-V'])('%s 输出 0.1.0 且退出码 0', (flag) => {
    const result = runAforge(flag);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0.1.0');
  });

  it('无参数输出简短帮助且退出码 0', () => {
    const result = runAforge();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('aforge');
  });
});
