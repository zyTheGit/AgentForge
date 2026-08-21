/**
 * habits schema 单测（Spec §4.1 / §13.1 示例）。
 */
import { describe, expect, it } from 'vitest';
import { HabitsSchema } from '../../src/schema/habits';

describe('HabitsSchema（Spec §4.1）', () => {
  it('Spec §13.1 示例对象合法且字段原样保留', () => {
    const input = {
      version: 1,
      runtime: {
        node: { manager: 'fnm', version: 'lts' },
        python: { manager: 'uv', version: '3.12+' },
        package_managers: ['pnpm', 'bun', 'npm'],
      },
      tools: {
        shell: 'powershell',
        git: { conventional_commits: true },
      },
      ai: {
        language: ['zh-CN', 'en'],
        style: 'concise, surgical changes, no speculative features',
        verification: ['test', 'lint', 'typecheck'],
        forbid: [
          'Do not suggest nvm when fnm is available',
          'Do not use pip install for project deps when uv is configured',
        ],
      },
    };
    const result = HabitsSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime.node).toEqual({ manager: 'fnm', version: 'lts' });
      expect(result.data.runtime.package_managers).toEqual(['pnpm', 'bun', 'npm']);
      expect(result.data.tools.shell).toBe('powershell');
      expect(result.data.tools.git?.conventional_commits).toBe(true);
      expect(result.data.ai.verification).toEqual(['test', 'lint', 'typecheck']);
    }
  });

  it('空对象 → 全部默认：version 1、容器空对象', () => {
    const data = HabitsSchema.parse({});
    expect(data).toEqual({
      version: 1,
      runtime: {},
      tools: {},
      ai: {},
      detected: {},
      extensions: {},
    });
  });

  it('缺 version → 默认 1；version: 2 → 校验失败', () => {
    expect(HabitsSchema.parse({ runtime: {} }).version).toBe(1);
    const bad = HabitsSchema.safeParse({ version: 2 });
    expect(bad.success).toBe(false);
  });

  it('runtime.node.manager 非法枚举 → 失败且 issue 路径精确', () => {
    const result = HabitsSchema.safeParse({ runtime: { node: { manager: 'nvmx' } } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('runtime.node.manager');
    }
  });

  it('runtime.python.manager 枚举校验（uv 合法 / pip 非法）', () => {
    expect(HabitsSchema.safeParse({ runtime: { python: { manager: 'uv' } } }).success).toBe(true);
    expect(HabitsSchema.safeParse({ runtime: { python: { manager: 'pip' } } }).success).toBe(false);
  });

  it('package_managers 非法元素 → 失败且路径含索引', () => {
    const result = HabitsSchema.safeParse({ runtime: { package_managers: ['pnpm', 'yolo'] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('runtime.package_managers.1');
    }
  });

  it('ai.verification 枚举（合法五项 / 非法项报错）', () => {
    expect(
      HabitsSchema.safeParse({
        ai: { verification: ['test', 'lint', 'typecheck', 'build', 'format'] },
      }).success,
    ).toBe(true);
    expect(HabitsSchema.safeParse({ ai: { verification: ['deploy'] } }).success).toBe(false);
  });

  it('tools.shell / tools.container 枚举校验', () => {
    expect(HabitsSchema.safeParse({ tools: { shell: 'nushell' } }).success).toBe(true);
    expect(HabitsSchema.safeParse({ tools: { shell: 'powershell-core' } }).success).toBe(false);
    expect(HabitsSchema.safeParse({ tools: { container: 'podman' } }).success).toBe(true);
    expect(HabitsSchema.safeParse({ tools: { container: 'containerd' } }).success).toBe(false);
  });

  it('runtime.rust.manager / runtime.go.manager 枚举校验', () => {
    expect(HabitsSchema.safeParse({ runtime: { rust: { manager: 'rustup' } } }).success).toBe(true);
    expect(HabitsSchema.safeParse({ runtime: { rust: { manager: 'cargo' } } }).success).toBe(false);
    expect(HabitsSchema.safeParse({ runtime: { go: { manager: 'mise' } } }).success).toBe(true);
    expect(HabitsSchema.safeParse({ runtime: { go: { manager: 'gvm' } } }).success).toBe(false);
  });

  it('detected / extensions 为 passthrough：未知键原样保留', () => {
    const data = HabitsSchema.parse({
      detected: { node: { manager: 'fnm', source: 'where.exe' }, editor: 'code' },
      extensions: { team: { convention: 'trunk-based' } },
    });
    expect(data.detected).toEqual({
      node: { manager: 'fnm', source: 'where.exe' },
      editor: 'code',
    });
    expect(data.extensions).toEqual({ team: { convention: 'trunk-based' } });
  });

  it('顶层未知键被剥离（z.object 默认 strip，不透传到输出）', () => {
    const data = HabitsSchema.parse({ version: 1, rogue_key: 'x' });
    expect('rogue_key' in data).toBe(false);
  });
});
