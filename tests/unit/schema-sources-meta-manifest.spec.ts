/**
 * sources / sync-meta / manifest schema 单测（Spec §4.4 / §3.3 / §4.5）。
 */
import { describe, expect, it } from 'vitest';
import { ManifestSchema } from '../../src/schema/manifest';
import { SourcesFileSchema } from '../../src/schema/sources';
import { SyncMetaSchema } from '../../src/schema/sync-meta';

/** 64 位 hex（合法 contentHash）。 */
const HASH_64 = 'a'.repeat(64);

describe('SourcesFileSchema local/git 互斥（Spec §4.4）', () => {
  it('local 源：仅 path，enabled/kind 填充默认', () => {
    const data = SourcesFileSchema.parse({
      version: 1,
      sources: [{ id: 'tpl-local', type: 'local', path: 'D:\\templates' }],
    });
    expect(data.version).toBe(1);
    expect(data.sources[0]).toEqual({
      id: 'tpl-local',
      type: 'local',
      path: 'D:\\templates',
      enabled: true,
      kind: [],
    });
  });

  it('git 源：url/ref/commit 合法', () => {
    const data = SourcesFileSchema.parse({
      sources: [
        {
          id: 'tpl-git',
          type: 'git',
          url: 'https://github.com/example/tpl.git',
          ref: 'v1.2.0',
          commit: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b',
          kind: ['templates', 'skills'],
        },
      ],
    });
    expect(data.sources[0]).toMatchObject({ type: 'git', ref: 'v1.2.0' });
  });

  it('local 源携带 url → 校验失败（字段互斥）', () => {
    const result = SourcesFileSchema.safeParse({
      sources: [{ id: 'x', type: 'local', path: 'D:\\t', url: 'https://example.com' }],
    });
    expect(result.success).toBe(false);
  });

  it('local 源携带 ref / commit → 校验失败', () => {
    expect(
      SourcesFileSchema.safeParse({
        sources: [{ id: 'x', type: 'local', path: 'D:\\t', ref: 'main' }],
      }).success,
    ).toBe(false);
    expect(
      SourcesFileSchema.safeParse({
        sources: [{ id: 'x', type: 'local', path: 'D:\\t', commit: 'abc' }],
      }).success,
    ).toBe(false);
  });

  it('git 源携带 path → 校验失败（字段互斥）', () => {
    expect(
      SourcesFileSchema.safeParse({
        sources: [{ id: 'x', type: 'git', url: 'https://example.com', path: 'D:\\t' }],
      }).success,
    ).toBe(false);
  });

  it('缺失 type / 非法 type → 校验失败', () => {
    expect(SourcesFileSchema.safeParse({ sources: [{ id: 'x', path: 'D:\\t' }] }).success).toBe(
      false,
    );
    expect(
      SourcesFileSchema.safeParse({ sources: [{ id: 'x', type: 'svn', url: 'u' }] }).success,
    ).toBe(false);
  });

  it('kind 非法元素 / path 空串 → 校验失败', () => {
    expect(
      SourcesFileSchema.safeParse({
        sources: [{ id: 'x', type: 'local', path: 'D:\\t', kind: ['agents'] }],
      }).success,
    ).toBe(false);
    expect(
      SourcesFileSchema.safeParse({ sources: [{ id: 'x', type: 'local', path: '' }] }).success,
    ).toBe(false);
  });

  it('空对象 → version 默认 1、sources 默认 []', () => {
    expect(SourcesFileSchema.parse({})).toEqual({ version: 1, sources: [] });
  });
});

describe('SyncMetaSchema（Spec §3.3）', () => {
  it('Spec 示例结构合法', () => {
    const data = SyncMetaSchema.parse({
      version: 1,
      lastSyncAt: '2026-08-21T10:00:00Z',
      os: 'win32',
      agentforgeVersion: '0.1.0',
      targets: {
        claude: { contentHash: HASH_64, writtenAt: '2026-08-21T10:00:00Z' },
        opencode: { contentHash: '0'.repeat(64), writtenAt: '2026-08-21T10:00:01Z' },
      },
    });
    expect(data.targets.claude?.contentHash).toBe(HASH_64);
  });

  it('os 非法 → 失败（仅 win32 | darwin | linux）', () => {
    expect(
      SyncMetaSchema.safeParse({
        lastSyncAt: '2026-08-21T10:00:00Z',
        os: 'windows',
        agentforgeVersion: '0.1.0',
      }).success,
    ).toBe(false);
  });

  it('contentHash 非 64 位小写 hex → 失败', () => {
    expect(
      SyncMetaSchema.safeParse({
        lastSyncAt: '2026-08-21T10:00:00Z',
        os: 'win32',
        agentforgeVersion: '0.1.0',
        targets: { claude: { contentHash: 'xyz', writtenAt: '2026-08-21T10:00:00Z' } },
      }).success,
    ).toBe(false);
    expect(
      SyncMetaSchema.safeParse({
        lastSyncAt: '2026-08-21T10:00:00Z',
        os: 'win32',
        agentforgeVersion: '0.1.0',
        targets: { claude: { contentHash: 'A'.repeat(64), writtenAt: '2026-08-21T10:00:00Z' } },
      }).success,
    ).toBe(false);
  });

  it('targets 缺省 → 默认 {}；lastSyncAt 非法 → 失败', () => {
    const data = SyncMetaSchema.parse({
      lastSyncAt: '2026-08-21T10:00:00Z',
      os: 'linux',
      agentforgeVersion: '0.1.0',
    });
    expect(data.version).toBe(1);
    expect(data.targets).toEqual({});
    expect(
      SyncMetaSchema.safeParse({
        lastSyncAt: 'yesterday',
        os: 'linux',
        agentforgeVersion: '0.1.0',
      }).success,
    ).toBe(false);
  });
});

describe('ManifestSchema（Spec §4.5）', () => {
  /** 只关心 skills/mcp 元素形状的用例：必填头部字段固定，避免逐条重复。 */
  const manifestWith = (patch: Record<string, unknown>) =>
    ManifestSchema.safeParse({ name: 'n', version: '1.0.0', min_agentforge: 1, ...patch });

  it('Spec 示例合法（min_agentforge 为数字）', () => {
    const data = ManifestSchema.parse({
      name: 'modern-toolchain',
      version: '1.0.0',
      min_agentforge: 1,
      templates: [
        {
          id: 'tools/modern-js',
          path: 'templates/tools/modern-js.md',
          description: '现代 JS 工具链约定',
        },
      ],
    });
    expect(data.min_agentforge).toBe(1);
    expect(data.templates[0]?.id).toBe('tools/modern-js');
    expect(data.skills).toEqual([]);
    expect(data.mcp).toEqual([]);
  });

  it('min_agentforge 接受字符串；name/version 缺失 → 失败', () => {
    expect(
      ManifestSchema.safeParse({ name: 'n', version: '1', min_agentforge: '>=0.1' }).success,
    ).toBe(true);
    expect(ManifestSchema.safeParse({ version: '1', min_agentforge: 1 }).success).toBe(false);
    expect(ManifestSchema.safeParse({ name: 'n', min_agentforge: 1 }).success).toBe(false);
  });

  it('templates 元素结构校验（缺 description → 失败）', () => {
    expect(
      ManifestSchema.safeParse({
        name: 'n',
        version: '1',
        min_agentforge: 1,
        templates: [{ id: 'x', path: 'x.md' }],
      }).success,
    ).toBe(false);
  });

  it('templates/skills/mcp 缺省 → 默认 []（Spec 示例 skills: [] / mcp: []）', () => {
    const data = ManifestSchema.parse({ name: 'n', version: '1.0.0', min_agentforge: 1 });
    expect(data.templates).toEqual([]);
  });

  it('skills 元素：缺 name / name 为空串 → 失败；只有 name → 通过', () => {
    expect(manifestWith({ skills: [{ description: 'pdf skill' }] }).success).toBe(false);
    expect(manifestWith({ skills: [{ name: '' }] }).success).toBe(false);
    expect(manifestWith({ skills: [{ name: 'pdf' }] }).success).toBe(true);
  });

  it('skills 元素：name + description 通过且 description 保留', () => {
    const data = ManifestSchema.parse({
      name: 'n',
      version: '1.0.0',
      min_agentforge: 1,
      skills: [{ name: 'pdf', description: 'pdf skill' }],
    });
    expect(data.skills).toEqual([{ name: 'pdf', description: 'pdf skill' }]);
  });

  it('mcp 元素：缺 transport / transport 非枚举值 → 失败', () => {
    expect(manifestWith({ mcp: [{ name: 'fetch', command: 'npx' }] }).success).toBe(false);
    expect(manifestWith({ mcp: [{ name: 'fetch', transport: 'grpc' }] }).success).toBe(false);
  });

  it('mcp 元素：合法 stdio 条目通过，enabled 填默认 true（与 §4.2 同构）', () => {
    const data = ManifestSchema.parse({
      name: 'n',
      version: '1.0.0',
      min_agentforge: 1,
      mcp: [
        { name: 'fetch', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-server-fetch'] },
      ],
    });
    expect(data.mcp).toEqual([
      {
        name: 'fetch',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-server-fetch'],
      },
    ]);
  });
});
