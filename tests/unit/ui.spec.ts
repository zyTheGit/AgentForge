/**
 * 终端呈现层单测（src/infra/ui）。
 *
 * 关注三件事：
 * 1. 能力探测的优先级（颜色 / Unicode 是两个独立维度）；
 * 2. ASCII 降级档必须与改造前的字面量逐字节一致——大量既有断言（如
 *    tests/unit/commands-doctor-status.spec.ts）依赖它；
 * 3. 对齐计算按**可见**宽度（带色单元格不能把表格算歪）。
 */
import { describe, expect, it } from 'vitest';
import { extractColorFlag } from '../../src/cli';
import {
  createUi,
  detectUiCapabilities,
  stripAnsi,
  type UiProbe,
  visibleWidth,
} from '../../src/infra/ui';

const ESC = '\u001B';

const probe = (over: Partial<UiProbe> = {}): UiProbe => ({
  env: () => undefined,
  isTty: true,
  platform: 'linux',
  ...over,
});

const envOf =
  (map: Readonly<Record<string, string>>) =>
  (key: string): string | undefined =>
    map[key];

const ascii = createUi({ color: false, unicode: false, columns: 80 });
const colorAscii = createUi({ color: true, unicode: false, columns: 80 });
const fancy = createUi({ color: true, unicode: true, columns: 80 });

describe('detectUiCapabilities：颜色判定', () => {
  it('TTY 且无环境变量 → 开色', () => {
    expect(detectUiCapabilities(probe()).color).toBe(true);
  });

  it('非 TTY → 关色（管道 / CI 日志）', () => {
    expect(detectUiCapabilities(probe({ isTty: false })).color).toBe(false);
  });

  it('NO_COLOR 压过 FORCE_COLOR（no-color.org 约定：关闭意愿优先）', () => {
    const caps = detectUiCapabilities(probe({ env: envOf({ NO_COLOR: '1', FORCE_COLOR: '1' }) }));
    expect(caps.color).toBe(false);
  });

  it('FORCE_COLOR 压过非 TTY（`aforge status | less -R`）', () => {
    const caps = detectUiCapabilities(probe({ isTty: false, env: envOf({ FORCE_COLOR: '1' }) }));
    expect(caps.color).toBe(true);
  });

  it('NO_COLOR=0 / 空串不算设置', () => {
    expect(detectUiCapabilities(probe({ env: envOf({ NO_COLOR: '0' }) })).color).toBe(true);
    expect(detectUiCapabilities(probe({ env: envOf({ NO_COLOR: '' }) })).color).toBe(true);
  });

  it('TERM=dumb → 关色', () => {
    expect(detectUiCapabilities(probe({ env: envOf({ TERM: 'dumb' }) })).color).toBe(false);
  });

  it('--no-color / --color 显式覆盖压过一切', () => {
    expect(
      detectUiCapabilities(probe({ colorOverride: false, env: envOf({ FORCE_COLOR: '1' }) })).color,
    ).toBe(false);
    expect(
      detectUiCapabilities(
        probe({ colorOverride: true, isTty: false, env: envOf({ NO_COLOR: '1' }) }),
      ).color,
    ).toBe(true);
  });
});

describe('detectUiCapabilities：Unicode 判定', () => {
  it('非 TTY → ASCII（下游可能是 GBK 日志文件）', () => {
    expect(detectUiCapabilities(probe({ isTty: false })).unicode).toBe(false);
  });

  it('POSIX TTY → Unicode；TERM=linux（裸 console）除外', () => {
    expect(detectUiCapabilities(probe()).unicode).toBe(true);
    expect(detectUiCapabilities(probe({ env: envOf({ TERM: 'linux' }) })).unicode).toBe(false);
  });

  it('Windows 默认（cmd / PowerShell 5 的 GBK 代码页）→ ASCII', () => {
    expect(detectUiCapabilities(probe({ platform: 'win32' })).unicode).toBe(false);
  });

  it('Windows 已知 UTF-8 宿主 → Unicode', () => {
    const hosts = [
      { WT_SESSION: 'x' },
      { TERM_PROGRAM: 'vscode' },
      { TERMINAL_EMULATOR: 'JetBrains-JediTerm' },
    ];
    for (const env of hosts) {
      expect(detectUiCapabilities(probe({ platform: 'win32', env: envOf(env) })).unicode).toBe(
        true,
      );
    }
  });

  it('列宽未知或非正 → 回落 80', () => {
    expect(detectUiCapabilities(probe()).columns).toBe(80);
    expect(detectUiCapabilities(probe({ columns: 0 })).columns).toBe(80);
    expect(detectUiCapabilities(probe({ columns: 120 })).columns).toBe(120);
  });
});

describe('createUi：ASCII + 无色档（既有断言的基线，逐字节固定）', () => {
  it('着色函数全部退化为恒等', () => {
    expect(ascii.red('x')).toBe('x');
    expect(ascii.green('x')).toBe('x');
    expect(ascii.bold('x')).toBe('x');
    expect(ascii.path('/tmp/a')).toBe('/tmp/a');
    expect(ascii.level('error', 'boom')).toBe('boom');
  });

  it('徽标 / 分节 / 标题保持改造前的字面量', () => {
    expect(ascii.badge('ok')).toBe('[OK  ]');
    expect(ascii.badge('warn')).toBe('[WARN]');
    expect(ascii.badge('error')).toBe('[FAIL]');
    expect(ascii.badgeWidth).toBe(6);
    expect(ascii.section('targets')).toBe('== targets ==');
    expect(ascii.title('aforge doctor', 'report')).toEqual(['aforge doctor - report', '']);
  });

  it('kv / bullet / hint / next 的间距与前缀', () => {
    expect(ascii.kv('scope', 'project', 9)).toBe('  scope    : project');
    expect(ascii.kv('scope', 'project', 9, 4)).toBe('    scope    : project');
    expect(ascii.bullet('item')).toBe('  - item');
    expect(ascii.hint('run aforge init', 9)).toBe('         hint: run aforge init');
    expect(ascii.next('aforge sync')).toBe('next: aforge sync');
  });

  it('无色档的 code() 用反引号保留「这是命令」的暗示', () => {
    expect(ascii.code('aforge sync')).toBe('`aforge sync`');
    expect(colorAscii.code('aforge sync')).toBe(`${ESC}[1maforge sync${ESC}[0m`);
  });

  it('输出不含任何非 ASCII 字符', () => {
    const sample = [
      ...ascii.title('aforge status', 'x'),
      ascii.section('s'),
      ascii.badge('warn'),
      ascii.bullet('b'),
      ascii.rule(),
      ...ascii.table([
        ['id', 'type'],
        ['a', 'git'],
      ]),
    ].join('\n');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言范围本身就是 ASCII 控制字符区间
    expect(sample).toMatch(/^[\x00-\x7F]*$/);
  });
});

describe('createUi：彩色 + Unicode 档', () => {
  it('SGR 序列成对出现，剥离后与无色档同文本', () => {
    expect(fancy.green('ok')).toBe(`${ESC}[32mok${ESC}[0m`);
    expect(stripAnsi(fancy.green('ok'))).toBe('ok');
    expect(fancy.badgeWidth).toBe(1);
    expect(stripAnsi(fancy.badge('ok'))).toBe('\u2714');
  });

  it('标题追加一条分隔线（三行：标题 / 线 / 空行）', () => {
    const lines = fancy.title('aforge doctor', 'report');
    expect(lines).toHaveLength(3);
    expect(stripAnsi(lines[0] ?? '')).toBe('aforge doctor \u2500\u2500 report');
    expect(stripAnsi(lines[1] ?? '')).toBe('\u2500'.repeat(72));
    expect(lines[2]).toBe('');
  });

  it('分隔线长度取 min(列宽-1, 72)', () => {
    const narrow = createUi({ color: false, unicode: true, columns: 40 });
    expect(narrow.rule()).toHaveLength(39);
    expect(fancy.rule()).not.toBe('');
    expect(visibleWidth(fancy.rule())).toBe(72);
  });

  it('分节标题用 ▸ 前缀', () => {
    expect(stripAnsi(fancy.section('targets'))).toBe('\u25B8 targets');
  });
});

describe('ui.table：按可见宽度对齐', () => {
  it('列宽忽略 SGR 序列，末列不填充（不留行尾空白）', () => {
    const rows = [
      ['id', 'type'],
      [colorAscii.green('a'), 'git'],
      ['bbbb', 'local'],
    ];
    const lines = colorAscii.table(rows).map((line) => stripAnsi(line));
    expect(lines).toEqual(['  id    type', '  a     git', '  bbbb  local']);
  });

  it('首行加粗，其余不加', () => {
    const lines = colorAscii.table([['h'], ['v']]);
    expect(lines[0]).toBe(`${ESC}[1m  h${ESC}[0m`);
    expect(lines[1]).toBe('  v');
  });

  it('空表 → 空数组', () => {
    expect(ascii.table([])).toEqual([]);
  });
});

describe('visibleWidth / stripAnsi', () => {
  it('可见宽度不计颜色序列', () => {
    expect(visibleWidth(fancy.red('abc'))).toBe(3);
    expect(stripAnsi('plain')).toBe('plain');
  });
});

describe('extractColorFlag：位置无关的呈现开关', () => {
  it('未给 → undefined，argv 原样', () => {
    expect(extractColorFlag(['node', 'aforge', 'status'])).toEqual({
      argv: ['node', 'aforge', 'status'],
      colorOverride: undefined,
    });
  });

  it('子命令后出现的 --no-color 也生效，且从 argv 中摘掉', () => {
    expect(extractColorFlag(['node', 'aforge', 'doctor', '--no-color', '--json'])).toEqual({
      argv: ['node', 'aforge', 'doctor', '--json'],
      colorOverride: false,
    });
  });

  it('--color 显式开启', () => {
    expect(extractColorFlag(['node', 'aforge', '--color', 'status']).colorOverride).toBe(true);
  });

  it('`--` 之后不再解析（透传给下游的参数保持原样）', () => {
    expect(extractColorFlag(['node', 'aforge', 'x', '--', '--no-color'])).toEqual({
      argv: ['node', 'aforge', 'x', '--', '--no-color'],
      colorOverride: undefined,
    });
  });
});
