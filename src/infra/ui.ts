/**
 * 终端呈现层：颜色 / 符号 / 版式原语的唯一出处。
 *
 * 设计约束：
 * - **能力探测优先，不假设终端**。颜色与 Unicode 是两件独立的事：颜色看
 *   NO_COLOR / FORCE_COLOR / TTY，Unicode 看代码页与终端型号（Windows GBK 控制台
 *   `chcp 936` 下 `✔` 会变成两个乱码字，docs/platform.md 承诺的「静默命令纯 ASCII」
 *   就靠这一层的降级兜底）；
 * - **纯函数 + 注入**：`createUi(caps)` 不读全局，能力由调用方给定；命令层用
 *   `getUi()` 取进程级单例（`cli.ts` 在 parse 前用 `--no-color` 的判定装配它），
 *   单测直接 `createUi({ color: false, unicode: true })` 覆盖四种组合；
 * - **`--json` 不经过这里**。机器可读输出必须逐字节稳定，`printJson` 保持裸
 *   `console.log`；此模块只服务人类可读分支。
 *
 * 为什么不引三方库（chalk / picocolors / ora）：SGR 序列与 ASCII 降级表加起来不到
 * 一百行，而 bin 是 esbuild / bun --compile 的单文件产物，多一个运行时依赖要多一份
 * 供应链与体积成本。
 */

/** ESC（不写进正则字面量：biome 的 noControlCharactersInRegex 会拦）。 */
const ESC = '\u001B';

/** SGR 序列匹配（只需覆盖本模块自己产出的 `ESC[...m`）。 */
const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** 去掉 SGR 序列（对齐计算与测试断言用）。 */
export function stripAnsi(text: string): string {
  return text.replace(SGR_PATTERN, '');
}

/** 可见宽度（忽略颜色序列；不处理东亚全角——本项目输出不含 CJK）。 */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

/** 终端呈现能力（两个维度彼此独立，见模块头注释）。 */
export interface UiCapabilities {
  /** 是否输出 ANSI 颜色。 */
  readonly color: boolean;
  /** 是否使用非 ASCII 符号（✔ / ─ / →）。 */
  readonly unicode: boolean;
  /** 终端列宽（用于分隔线长度；未知 → 80）。 */
  readonly columns: number;
}

/** 诊断级别（doctor / sync 报告共用的三档语义色）。 */
export type UiLevel = 'ok' | 'warn' | 'error';

/** detectUiCapabilities 的输入（全部可注入：单测不碰真实 process）。 */
export interface UiProbe {
  /** 环境变量读取器。 */
  readonly env: (key: string) => string | undefined;
  /** stdout 是否为 TTY。 */
  readonly isTty: boolean;
  /** stdout 列宽（非 TTY → undefined）。 */
  readonly columns?: number;
  /** `process.platform`。 */
  readonly platform: string;
  /** `--no-color` / `--color` 显式覆盖（未给 → 按环境判定）。 */
  readonly colorOverride?: boolean;
}

/** 默认探针：读真实 process（生产装配用）。 */
export function defaultUiProbe(colorOverride?: boolean): UiProbe {
  const stdout = process.stdout as { isTTY?: boolean; columns?: number };
  return {
    env: (key) => process.env[key],
    isTty: stdout.isTTY === true,
    ...(typeof stdout.columns === 'number' ? { columns: stdout.columns } : {}),
    platform: process.platform,
    ...(colorOverride !== undefined ? { colorOverride } : {}),
  };
}

/** 环境变量是否被设置为「非空且非 0」（NO_COLOR / FORCE_COLOR 的通行判据）。 */
function isEnvEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/**
 * 颜色判定优先级：显式覆盖 > NO_COLOR > FORCE_COLOR > TERM=dumb > TTY。
 *
 * FORCE_COLOR 排在 TTY 之前是为了让 `aforge status | less -R` 与 CI 日志能保留颜色；
 * NO_COLOR 压过 FORCE_COLOR 是 no-color.org 的约定（用户的关闭意愿优先）。
 */
function detectColor(probe: UiProbe): boolean {
  if (probe.colorOverride !== undefined) {
    return probe.colorOverride;
  }
  if (isEnvEnabled(probe.env('NO_COLOR'))) {
    return false;
  }
  if (isEnvEnabled(probe.env('FORCE_COLOR'))) {
    return true;
  }
  if (probe.env('TERM') === 'dumb') {
    return false;
  }
  return probe.isTty;
}

/**
 * Unicode 判定：非 TTY 一律 ASCII；Windows 只在已知 UTF-8 终端里开。
 *
 * 非 TTY 走 ASCII 有两个理由：管道下游可能是 GBK 编码的日志文件；而人类可读输出的
 * 纯 ASCII 断言（tests/unit/commands-doctor-status.spec.ts）正是靠这条保持稳定。
 * Windows 白名单参考社区惯例（Windows Terminal / VS Code / ConEmu-Cmder 等已知
 * UTF-8 宿主）——`cmd.exe` 与 PowerShell 5 的默认 GBK 代码页不在其中，故降级。
 */
function detectUnicode(probe: UiProbe): boolean {
  if (!probe.isTty) {
    return false;
  }
  if (probe.platform !== 'win32') {
    return probe.env('TERM') !== 'linux';
  }
  return (
    probe.env('WT_SESSION') !== undefined ||
    probe.env('TERM_PROGRAM') === 'vscode' ||
    probe.env('TERMINAL_EMULATOR') === 'JetBrains-JediTerm' ||
    probe.env('ConEmuTask') === '{cmd::Cmder}' ||
    probe.env('TERM') === 'xterm-256color' ||
    probe.env('TERM') === 'alacritty'
  );
}

/** 从环境探测呈现能力。 */
export function detectUiCapabilities(probe: UiProbe = defaultUiProbe()): UiCapabilities {
  return {
    color: detectColor(probe),
    unicode: detectUnicode(probe),
    columns: probe.columns !== undefined && probe.columns > 0 ? probe.columns : 80,
  };
}

/** SGR 码（只用 8 色基础集 + bold/dim：老终端与 GBK 控制台均可渲染）。 */
const SGR = {
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  cyan: 36,
} as const;

/** 符号表（unicode 档与 ASCII 降级档；ASCII 档刻意与改造前的字面量一致）。 */
const GLYPHS = {
  unicode: {
    ok: '\u2714',
    warn: '\u25B2',
    error: '\u2716',
    bullet: '\u2022',
    arrow: '\u2192',
    rule: '\u2500',
    section: '\u25B8',
  },
  ascii: {
    ok: '[OK  ]',
    warn: '[WARN]',
    error: '[FAIL]',
    bullet: '-',
    arrow: '->',
    rule: '=',
    section: '==',
  },
} as const;

/** 分隔线最大长度（超宽终端下不铺满整行——长横线比信息更抢眼）。 */
const MAX_RULE_WIDTH = 72;

/** 人类可读输出的构造原语（由 createUi 装配，能力已固化）。 */
export interface Ui {
  readonly caps: UiCapabilities;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  /** 级别语义色（ok 绿 / warn 黄 / error 红）。 */
  level(level: UiLevel, text: string): string;
  /** 文件系统路径（青色；无色档原样）。 */
  path(text: string): string;
  /** 可照抄的命令（加粗；无色档退回反引号包裹以保留「这是命令」的暗示）。 */
  code(text: string): string;
  /**
   * 命令标题块：`['aforge status - subtitle', '']`（unicode 档追加一条分隔线）。
   *
   * 返回数组而非字符串：调用方统一 `lines.push(...ui.title(...))`，尾部空行的
   * 有无由本模块决定，不散落到 14 个命令里。
   */
  title(command: string, subtitle: string): string[];
  /** 分节标题（ASCII 档 `== X ==`，unicode 档 `▸ X` + 加粗）。 */
  section(text: string): string;
  /** 级别徽标（ASCII 档 `[OK  ]`，unicode 档单字符）。 */
  badge(level: UiLevel): string;
  /** 徽标的可见宽度（续行缩进由调用方按此对齐，避免硬编码列数）。 */
  readonly badgeWidth: number;
  /** `  label   : value` 对齐行（label 右填充到 labelWidth）。 */
  kv(label: string, value: string, labelWidth: number, indent?: number): string;
  /** 列表项（前缀符号 + 文本）。 */
  bullet(text: string, indent?: number): string;
  /** `hint: ...` 行（暗色）。 */
  hint(text: string, indent?: number): string;
  /** `next: ...` 行（青色强调下一步动作）。 */
  next(text: string): string;
  /** 分隔线（长度取 min(终端列宽-1, 72)）。 */
  rule(): string;
  /** 表格（首行为表头；列宽按可见宽度计算，末列不填充）。 */
  table(rows: readonly (readonly string[])[]): string[];
}

/** 按能力装配 Ui（纯函数：同样的 caps 得到同样的输出）。 */
export function createUi(caps: UiCapabilities): Ui {
  const paint = (code: number, text: string): string =>
    caps.color ? `${ESC}[${code}m${text}${ESC}[0m` : text;
  const glyphs = caps.unicode ? GLYPHS.unicode : GLYPHS.ascii;
  const levelColor: Readonly<Record<UiLevel, number>> = {
    ok: SGR.green,
    warn: SGR.yellow,
    error: SGR.red,
  };

  const bold = (text: string): string => paint(SGR.bold, text);
  const dim = (text: string): string => paint(SGR.dim, text);
  const cyan = (text: string): string => paint(SGR.cyan, text);
  const ruleWidth = Math.max(8, Math.min(caps.columns - 1, MAX_RULE_WIDTH));

  return {
    caps,
    bold,
    dim,
    red: (text) => paint(SGR.red, text),
    green: (text) => paint(SGR.green, text),
    yellow: (text) => paint(SGR.yellow, text),
    cyan,
    level: (level, text) => paint(levelColor[level], text),
    path: (text) => cyan(text),
    code: (text) => (caps.color ? bold(text) : `\`${text}\``),
    title: (command, subtitle) =>
      caps.unicode
        ? [
            `${bold(command)} ${dim(glyphs.rule.repeat(2))} ${subtitle}`,
            dim(glyphs.rule.repeat(ruleWidth)),
            '',
          ]
        : [`${command} - ${subtitle}`, ''],
    section: (text) => (caps.unicode ? `${cyan(glyphs.section)} ${bold(text)}` : `== ${text} ==`),
    badge: (level) => paint(levelColor[level], glyphs[level]),
    badgeWidth: glyphs.ok.length,
    kv: (label, value, labelWidth, indent = 2) =>
      `${' '.repeat(indent)}${dim(label.padEnd(labelWidth))}: ${value}`,
    bullet: (text, indent = 2) => `${' '.repeat(indent)}${dim(glyphs.bullet)} ${text}`,
    hint: (text, indent = 0) => `${' '.repeat(indent)}${dim(`hint: ${text}`)}`,
    next: (text) => `${cyan('next')}: ${text}`,
    rule: () => dim(glyphs.rule.repeat(ruleWidth)),
    table: (rows) => renderTable(rows, bold),
  };
}

/**
 * 等宽表格：列宽按**可见**宽度取最大值，末列不填充（避免行尾空白）。
 *
 * 从 commands/assets/source.ts 上提：`skill list` / `learnings list` 也要对齐输出，
 * 三处各写一遍 padEnd 的结果是「有的表算错了带色单元格的宽度」。
 */
function renderTable(
  rows: readonly (readonly string[])[],
  bold: (text: string) => string,
): string[] {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const widths: number[] = [];
  for (let col = 0; col < columns; col += 1) {
    widths.push(Math.max(0, ...rows.map((row) => visibleWidth(row[col] ?? ''))));
  }
  return rows.map((row, index) => {
    const cells = row.map((cell, col) => {
      if (col === row.length - 1) {
        return cell;
      }
      const pad = (widths[col] ?? 0) - visibleWidth(cell);
      return `${cell}${' '.repeat(Math.max(0, pad))}`;
    });
    const line = `  ${cells.join('  ')}`;
    return index === 0 ? bold(line) : line;
  });
}

/** 进程级单例（cli.ts 在 parse 前装配；未装配时按环境惰性探测）。 */
let current: Ui | undefined;

/** 取当前 Ui（未装配 → 按真实环境探测一次并缓存）。 */
export function getUi(): Ui {
  current ??= createUi(detectUiCapabilities());
  return current;
}

/** 装配进程级 Ui（cli.ts 装配 / 单测重置；传 undefined 恢复惰性探测）。 */
export function setUi(ui: Ui | undefined): void {
  current = ui;
}
