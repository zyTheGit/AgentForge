/**
 * hook-capture 单测（Spec §7.4 hook 档 / §12 Phase 3）：钩子产物形态与注入安全。
 *
 * 这里只测"钩子里写什么"这一层——写到哪个文件由各 projector 的单测覆盖，哪些 target
 * 支持由 sync-notices 单测覆盖。**不注册任何真钩子、不执行任何外部命令**：本模块是
 * 纯函数，断言的是字符串与 JSON 结构。
 */
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerLearnCommand } from '../../../src/commands/knowledge';
import { LEARNING_PROTOCOL_SECTION } from '../../../src/core/learning/auto-capture';
import {
  codexSessionHooksJson,
  SESSION_HOOK_COMMAND,
  SESSION_HOOK_CONTEXT_LIMIT,
  SESSION_HOOK_DESCRIPTION,
  SESSION_HOOK_EVENT,
  SESSION_HOOK_MATCHER,
  SESSION_HOOK_STATUS_MESSAGE,
  sessionHookEntry,
  sessionHookProtocolText,
} from '../../../src/core/learning/hook-capture';

describe('SESSION_HOOK_COMMAND — 常量命令、零注入面（§7.4 安全边界）', () => {
  it('只调用 aforge 的只读子命令', () => {
    expect(SESSION_HOOK_COMMAND).toBe('aforge learn --print-protocol');
  });

  it('裸命令名（交给 PATH 解析）：不含任何路径分隔符 / 盘符 / 家目录变量', () => {
    expect(SESSION_HOOK_COMMAND).not.toContain('\\');
    expect(SESSION_HOOK_COMMAND).not.toContain('/');
    expect(SESSION_HOOK_COMMAND).not.toMatch(/[A-Za-z]:/);
    expect(SESSION_HOOK_COMMAND).not.toContain('~');
    expect(SESSION_HOOK_COMMAND).not.toContain('$');
    expect(SESSION_HOOK_COMMAND).not.toContain('%');
  });

  it('不含 shell 元字符（不会被二次解释成别的命令）', () => {
    for (const ch of ['&', '|', ';', '>', '<', '`', '"', "'", '\n', '\r']) {
      expect(SESSION_HOOK_COMMAND).not.toContain(ch);
    }
  });

  it('纯 ASCII（写进 JSON 后在任何控制台都可读）', () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言仅含 ASCII，字符类必须显式覆盖控制字符区间（\x00-\x1F）
    expect(SESSION_HOOK_COMMAND).toMatch(/^[\x00-\x7F]*$/);
  });
});

describe('codexSessionHooksJson — 钩子文件形态（实测 codex 0.147.0 接受）', () => {
  it('SessionStart + startup|resume + 单条 command 条目', () => {
    const parsed = JSON.parse(codexSessionHooksJson()) as {
      description: string;
      hooks: Record<string, { matcher: string; hooks: unknown[] }[]>;
    };
    expect(parsed.description).toBe(SESSION_HOOK_DESCRIPTION);
    const group = parsed.hooks[SESSION_HOOK_EVENT];
    expect(group).toHaveLength(1);
    expect(group?.[0]?.matcher).toBe(SESSION_HOOK_MATCHER);
    expect(group?.[0]?.hooks).toEqual([
      {
        type: 'command',
        command: SESSION_HOOK_COMMAND,
        statusMessage: SESSION_HOOK_STATUS_MESSAGE,
        additionalContextLimit: SESSION_HOOK_CONTEXT_LIMIT,
      },
    ]);
  });

  it('matcher 不含 compact（压缩续跑属同一会话，不重复注入）', () => {
    expect(SESSION_HOOK_MATCHER).not.toContain('compact');
  });

  it('自述行告诉用户怎么移除（写进用户配置目录的东西必须可溯源）', () => {
    expect(SESSION_HOOK_DESCRIPTION).toContain('AgentForge');
    expect(SESSION_HOOK_DESCRIPTION).toContain('aforge sync');
  });

  it('2 空格缩进 + 尾换行，且内容与调用次数无关（幂等，不产生噪音 diff）', () => {
    const text = codexSessionHooksJson();
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "hooks": {');
    expect(text).toBe(codexSessionHooksJson());
  });

  it('产物里不出现任何本机路径（跨机器逐字节一致 → contentHash 与 diff 稳定）', () => {
    const text = codexSessionHooksJson();
    expect(text).not.toMatch(/[A-Za-z]:\\\\/);
    expect(text).not.toContain(process.cwd().replaceAll('\\', '\\\\'));
  });

  it('sessionHookEntry 每次返回新对象（调用方改写不污染其他 target）', () => {
    const first = sessionHookEntry();
    const second = sessionHookEntry();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});

describe('sessionHookProtocolText — 与 prompt 档同一份协议（§5.2）', () => {
  it('逐字等于 LEARNING_PROTOCOL_SECTION（切换档位不会拿到两套措辞）', () => {
    expect(sessionHookProtocolText()).toBe(LEARNING_PROTOCOL_SECTION);
  });

  it('长度在 codex 的 additionalContextLimit 之内（否则注入会被截断）', () => {
    expect(sessionHookProtocolText().length).toBeLessThan(SESSION_HOOK_CONTEXT_LIMIT);
  });
});

describe('aforge learn --print-protocol — 钩子唯一执行的分支（只读旁路）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 只注册 learn 子命令的独立 program（不碰真实 CLI 入口的全局状态）。 */
  function learnProgram(): Command {
    const program = new Command();
    program.exitOverride();
    registerLearnCommand(program);
    return program;
  }

  it('把协议正文打印到 stdout，一行搞定（console.log 补尾换行）', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await learnProgram().parseAsync(['learn', '--print-protocol'], { from: 'user' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(LEARNING_PROTOCOL_SECTION);
  });

  it('CI 下同样正常返回：旁路在 store 的 CI 守卫之前，不写盘、不取锁', async () => {
    // 守卫拦的是 createLearning；--print-protocol 只读，因此 CI 里钩子照样能注入协议
    const previous = process.env.CI;
    process.env.CI = 'true';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        learnProgram().parseAsync(['learn', '--print-protocol'], { from: 'user' }),
      ).resolves.toBeDefined();
      expect(log).toHaveBeenCalledWith(LEARNING_PROTOCOL_SECTION);
    } finally {
      if (previous === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previous;
      }
    }
  });
});
