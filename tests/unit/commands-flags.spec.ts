/**
 * commands/flags 单测（Spec §6.2 全局 `--json`；§7.1 / §7.1.1 init 运行模式）：
 * - resolveJsonFlag：`aforge --json <cmd>` 与 `aforge <cmd> --json` 必须等价——
 *   沿 commander 的 parent 链向上查找，任一层出现 --json 即为机器可读输出；
 * - resolveInitMode：裸 `aforge init` 在 TTY 下默认交互，`--yes` / `--json` / 非 TTY
 *   静默，`-i` 优先于其余输入（非 TTY 下由 assertTty 报错而非静默降级）。
 */
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { resolveInitMode, resolveJsonFlag } from '../../src/commands/flags';

/** 构造 program（带全局 --json）+ 子命令 + 孙命令，返回三层引用。 */
function buildProgram(): { program: Command; sub: Command; grandchild: Command } {
  const program = new Command();
  program.exitOverride().option('--json', 'machine-readable output');
  const sub = program.command('sub').option('--json', 'machine-readable output');
  const grandchild = sub.command('child').option('--json', 'machine-readable output');
  // action 必须存在，否则 commander 对无 action 的叶子命令报错
  sub.action(() => {});
  grandchild.action(() => {});
  return { program, sub, grandchild };
}

describe('resolveJsonFlag', () => {
  it('子命令自身 --json → true', () => {
    const { program, sub } = buildProgram();
    program.parse(['sub', '--json'], { from: 'user' });
    expect(resolveJsonFlag(sub)).toBe(true);
  });

  it('program 级 --json（前置全局标志）→ true（此前完全未注册，Spec §6.2）', () => {
    const { program, sub } = buildProgram();
    program.parse(['--json', 'sub'], { from: 'user' });
    expect(resolveJsonFlag(sub)).toBe(true);
  });

  it('祖父层 --json 也生效（沿 parent 链向上）', () => {
    const { program, grandchild } = buildProgram();
    program.parse(['--json', 'sub', 'child'], { from: 'user' });
    expect(resolveJsonFlag(grandchild)).toBe(true);
  });

  it('无任何 --json → false', () => {
    const { program, sub } = buildProgram();
    program.parse(['sub'], { from: 'user' });
    expect(resolveJsonFlag(sub)).toBe(false);
  });

  it('localJson 参数为 true 时短路（子命令已自行解析出 options.json 的场景）', () => {
    const { program, sub } = buildProgram();
    program.parse(['sub'], { from: 'user' });
    expect(resolveJsonFlag(sub, true)).toBe(true);
  });

  it('command 为 undefined → 退化为 localJson（不抛异常）', () => {
    expect(resolveJsonFlag(undefined)).toBe(false);
    expect(resolveJsonFlag(undefined, true)).toBe(true);
  });
});

describe('resolveInitMode', () => {
  it('裸 init 在 TTY 下 → interactive（默认值翻转：不再静默定 scope 与 targets）', () => {
    expect(resolveInitMode({ isTty: true })).toBe('interactive');
  });

  it('裸 init 在非 TTY（CI / 管道）下 → silent', () => {
    expect(resolveInitMode({ isTty: false })).toBe('silent');
  });

  it('--yes → silent（即使在 TTY 下）', () => {
    expect(resolveInitMode({ yes: true, isTty: true })).toBe('silent');
  });

  it('--json → silent（JSON 体给脚本消费，脚本无法应答提问）', () => {
    expect(resolveInitMode({ json: true, isTty: true })).toBe('silent');
  });

  it('-i → interactive，且优先于 --yes / --json 与非 TTY（非 TTY 由 assertTty 报错）', () => {
    expect(resolveInitMode({ interactive: true, yes: true, isTty: true })).toBe('interactive');
    expect(resolveInitMode({ interactive: true, json: true, isTty: true })).toBe('interactive');
    expect(resolveInitMode({ interactive: true, isTty: false })).toBe('interactive');
  });
});
