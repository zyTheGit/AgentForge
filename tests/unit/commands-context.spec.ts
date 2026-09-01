/**
 * commands/_shared/context 单测（Spec §6.2）：命令层共享上下文装配与 --json 输出格式。
 *
 * defaultCommandContext 是 13 个命令文件里那句 `{ host: realHost, cwd:
 * process.cwd(), os: currentOs() }` 的单一来源；printJson 是各命令 --json
 * 分支的统一输出（判定仍归 flags.resolveJsonFlag）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultCommandContext, printJson } from '../../src/commands/_shared';
import { currentOs } from '../../src/core/paths';
import { realHost } from '../../src/infra/real-host';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('defaultCommandContext', () => {
  it('装配真实 Host + 当前进程 cwd 与平台', () => {
    const ctx = defaultCommandContext();
    expect(ctx.host).toBe(realHost);
    expect(ctx.cwd).toBe(process.cwd());
    expect(ctx.os).toEqual(currentOs());
  });

  it('每次返回新对象（调用方可安全展开追加字段，如 sync 的 agentforgeVersion）', () => {
    const a = defaultCommandContext();
    const b = defaultCommandContext();
    expect(a).not.toBe(b);
    expect({ ...a, agentforgeVersion: '9.9.9' }).toMatchObject({ cwd: a.cwd });
  });

  it('cwd 跟随 process.cwd()（不在模块加载时固化）', () => {
    const spy = vi.spyOn(process, 'cwd').mockReturnValue('C:\\elsewhere');
    expect(defaultCommandContext().cwd).toBe('C:\\elsewhere');
    expect(spy).toHaveBeenCalled();
  });
});

describe('printJson', () => {
  it('2 空格缩进、单次 console.log（§6.2 机器可读输出契约）', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printJson({ a: 1, b: ['x'] });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}');
  });

  it('数组顶层同样按 JSON 输出（list 类命令的形态）', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printJson([{ id: 'a' }]);
    expect(log).toHaveBeenCalledWith(JSON.stringify([{ id: 'a' }], null, 2));
  });

  it('null / 布尔等标量原样序列化（不额外包装）', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printJson(null);
    expect(log).toHaveBeenCalledWith('null');
  });
});
