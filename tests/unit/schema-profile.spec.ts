/**
 * profile schema 单测（Spec §4.2：默认值 / targets / mcp / passthrough）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../../src/core/markers';
import { ProfileSchema } from '../../src/schema/profile';

describe('ProfileSchema 默认值（Spec §4.2）', () => {
  it('最小 profile（仅 targets）→ Spec 默认值全部填充', () => {
    const data = ProfileSchema.parse({ targets: ['claude'] });
    expect(data.version).toBe(1);
    expect(data.scope).toBeUndefined();
    expect(data.skills.copy_mode).toBe('copy');
    expect(data.merge).toEqual({ strategy: 'overlay', arrays: 'replace' });
    expect(data.projection.marker_mode).toBe('replace_between_markers');
    expect(data.projection.marker_begin).toBe(DEFAULT_MARKER_BEGIN);
    expect(data.projection.marker_end).toBe(DEFAULT_MARKER_END);
    expect(data.projection.line_ending).toBe('lf');
    expect(data.projection.path_style).toBe('auto');
    expect(data.learning).toEqual({
      default_scope: 'project',
      auto_promote: false,
      include_promoted_in_sync: true,
    });
    // 内容型数组保持"未设置"（不伪造用户选择，交由合并/渲染层处理）
    expect(data.templates).toBeUndefined();
    expect(data.mcp.servers).toBeUndefined();
    expect(data.skills.always).toBeUndefined();
  });

  it('marker 默认值与 core/markers 常量同源（单一事实源）', () => {
    expect(DEFAULT_MARKER_BEGIN).toBe('<!-- BEGIN AGENTFORGE -->');
    expect(DEFAULT_MARKER_END).toBe('<!-- END AGENTFORGE -->');
  });

  it('部分声明：已写字段保留、未写字段填默认', () => {
    const data = ProfileSchema.parse({
      targets: ['pi'],
      projection: { line_ending: 'crlf', marker_mode: 'append_below_marker' },
      skills: { copy_mode: 'symlink' },
    });
    expect(data.projection.line_ending).toBe('crlf');
    expect(data.projection.marker_mode).toBe('append_below_marker');
    expect(data.projection.path_style).toBe('auto'); // 未声明 → 默认
    expect(data.skills.copy_mode).toBe('symlink');
    expect(data.merge.strategy).toBe('overlay'); // 容器整体未声明 → 容器默认
  });
});

describe('ProfileSchema 校验规则', () => {
  it('targets 至少一项（空数组 → 失败）', () => {
    const result = ProfileSchema.safeParse({ targets: [] });
    expect(result.success).toBe(false);
  });

  it('targets 缺失 → 失败（required）', () => {
    expect(ProfileSchema.safeParse({ version: 1 }).success).toBe(false);
  });

  it('targets 非法元素 → 失败且路径精确', () => {
    const result = ProfileSchema.safeParse({ targets: ['claude', 'cursor'] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('targets.1');
    }
  });

  it('scope 非法 → 失败', () => {
    expect(ProfileSchema.safeParse({ targets: ['claude'], scope: 'global' }).success).toBe(false);
  });

  it('projection.line_ending / path_style / marker_mode 枚举校验', () => {
    expect(
      ProfileSchema.safeParse({ targets: ['claude'], projection: { line_ending: 'cr' } }).success,
    ).toBe(false);
    expect(
      ProfileSchema.safeParse({ targets: ['claude'], projection: { path_style: 'unix' } }).success,
    ).toBe(false);
    expect(
      ProfileSchema.safeParse({ targets: ['claude'], projection: { marker_mode: 'overwrite' } })
        .success,
    ).toBe(false);
  });

  it('merge.strategy / merge.arrays 枚举校验', () => {
    expect(
      ProfileSchema.safeParse({ targets: ['claude'], merge: { strategy: 'deep' } }).success,
    ).toBe(false);
    expect(
      ProfileSchema.safeParse({ targets: ['claude'], merge: { arrays: 'merge' } }).success,
    ).toBe(false);
  });

  it('learning.default_scope 枚举校验', () => {
    expect(
      ProfileSchema.safeParse({ targets: ['claude'], learning: { default_scope: 'org' } }).success,
    ).toBe(false);
  });
});

describe('ProfileSchema mcp.servers（Spec §4.2）', () => {
  it('stdio server 合法：name + transport 必填，enabled 默认 true', () => {
    const data = ProfileSchema.parse({
      targets: ['codex'],
      mcp: {
        servers: [{ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-fs'] }],
      },
    });
    expect(data.mcp.servers?.[0]).toMatchObject({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-fs'],
      enabled: true,
    });
  });

  it('http server：url/headers/env record 校验', () => {
    const data = ProfileSchema.parse({
      targets: ['claude'],
      mcp: {
        servers: [
          {
            name: 'remote',
            transport: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer x' },
          },
        ],
      },
    });
    expect(data.mcp.servers?.[0]?.url).toBe('https://example.com/mcp');
    expect(data.mcp.servers?.[0]?.headers).toEqual({ Authorization: 'Bearer x' });
  });

  it('transport 非法 / name 缺失 / env 值非字符串 → 失败', () => {
    expect(
      ProfileSchema.safeParse({
        targets: ['claude'],
        mcp: { servers: [{ name: 'x', transport: 'ws' }] },
      }).success,
    ).toBe(false);
    expect(
      ProfileSchema.safeParse({ targets: ['claude'], mcp: { servers: [{ transport: 'stdio' }] } })
        .success,
    ).toBe(false);
    expect(
      ProfileSchema.safeParse({
        targets: ['claude'],
        mcp: { servers: [{ name: 'x', transport: 'stdio', env: { A: 1 } }] },
      }).success,
    ).toBe(false);
  });
});

describe('ProfileSchema extensions', () => {
  it('passthrough：未知键原样保留', () => {
    const data = ProfileSchema.parse({
      targets: ['claude'],
      extensions: { ci: { forbid_sync: true } },
    });
    expect(data.extensions).toEqual({ ci: { forbid_sync: true } });
  });
});
