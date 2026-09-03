/**
 * learn 的输入入口单测（Spec §6.2 / §7.4-1）：`--file -` 的 TTY 守卫与本地 `--json`。
 *
 * 两条都属"可发现性"缺陷而非功能缺失（PRD §10 Phase 4）：协议正文与 README 把
 * `--file -` 摆在最显眼的位置，误敲的概率不低，因此这里断言的是**误用时的反馈**，
 * 而不是正常路径（正常路径由 integration/learn-promote-sync 覆盖）。
 *
 * 不写盘、不读 SoT：两条断言都在 runLearn 之前就返回。
 */
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { registerLearnCommand } from '../../src/commands/knowledge';
import { ConfigError } from '../../src/core/errors';

/** 只注册 learn 子命令的独立 program（不碰真实 CLI 入口的全局状态）。 */
function learnProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerLearnCommand(program);
  return program;
}

/** learn 子命令引用（断言选项登记面）。 */
function learnCommand(): Command {
  const program = learnProgram();
  const learn = program.commands.find((cmd) => cmd.name() === 'learn');
  if (learn === undefined) {
    throw new Error('learn 子命令未注册');
  }
  return learn;
}

const originalIsTty = process.stdin.isTTY;

/** 覆盖 process.stdin.isTTY（isInteractiveStdin 的唯一判据）。 */
function setStdinTty(isTty: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: isTty, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTty, configurable: true });
});

describe('learn --file - 的 TTY 守卫（§7.4-1）', () => {
  it('交互终端里裸给 --file - → ConfigError(2)，而不是挂着等 EOF', async () => {
    setStdinTty(true);
    const error = await learnProgram()
      .parseAsync(['learn', '--file', '-'], { from: 'user' })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe(2);
    expect((error as ConfigError).message).toContain('--file -');
  });

  it('hint 给全三条正确形态（交互粘贴 / 管道 / 重定向）', async () => {
    setStdinTty(true);
    const error = await learnProgram()
      .parseAsync(['learn', '--file', '-'], { from: 'user' })
      .then(() => undefined)
      .catch((e: unknown) => e);
    const hint = (error as ConfigError).hint ?? '';
    expect(hint).toContain('aforge learn --file -');
    expect(hint).toContain('< notes.md');
    expect(hint).toMatch(/echo .* \| aforge learn --file -/);
  });
});

describe('learn 的本地 --json（§6.2）', () => {
  it('入口登记了 --json（缺它时 aforge learn --file - --json 会报 unknown option）', () => {
    const flags = learnCommand().options.map((opt) => opt.long);
    expect(flags).toContain('--json');
  });

  it('--file - --json 组合能过 commander 解析，错误来自 TTY 守卫而非未知选项', async () => {
    setStdinTty(true);
    const error = await learnProgram()
      .parseAsync(['learn', '--file', '-', '--json'], { from: 'user' })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).not.toMatch(/unknown option/i);
  });
});
