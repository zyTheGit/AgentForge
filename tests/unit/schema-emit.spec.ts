/**
 * emit-schema 单测：内存 fs 上验证七个 Draft 2020-12 工件的生成与结构。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emitSchemas } from '../../src/schema/emit';
import { createFakeHost } from './test-utils';

const EXPECTED_FILES = [
  'habits.schema.json',
  'profile.schema.json',
  'learning.schema.json',
  'sources.schema.json',
  'sync-meta.schema.json',
  'manifest.schema.json',
  // Phase 3 第二层（issue #53）：声明式适配器 adapters/<id>.yaml
  'adapter.schema.json',
];

/**
 * 断言用的 JSON Schema 节点：只声明本文件读到的两个关键字，且 properties 递归。
 * 原先写成 `Record<string, { default?: unknown }>`（只一层），下面的
 * `properties.merge.properties.strategy` 是三层——tests 进 tsc 后立刻暴露。
 */
interface SchemaNode {
  readonly default?: unknown;
  readonly properties?: Record<string, SchemaNode>;
}

describe('emitSchemas（Spec §4 JSON Schema 工件）', () => {
  it('生成七个工件，均为合法 JSON 且声明 Draft 2020-12 与 $id', async () => {
    const host = createFakeHost();
    const outDir = path.resolve('schemas-test');
    const files = await emitSchemas(host, outDir);

    expect(files).toHaveLength(EXPECTED_FILES.length);
    expect(files.map((f) => path.basename(f)).sort()).toEqual([...EXPECTED_FILES].sort());

    for (const file of files) {
      const content = host.files.get(file);
      expect(content, `${file} 应已写入`).toBeDefined();
      const json = JSON.parse(content as string) as Record<string, unknown>;
      expect(json.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(json.$id).toMatch(/^https:\/\/agentforge\.dev\/schema\/[a-z-]+\.json$/);
      expect(typeof json.title).toBe('string');
      expect(content?.endsWith('\n')).toBe(true); // POSIX 结尾，git diff 友好
    }
  });

  it('profile 工件：带默认值的字段不进 required（io: input 语义）', async () => {
    const host = createFakeHost();
    await emitSchemas(host, path.resolve('schemas-test'));
    const profileFile = [...host.files.keys()].find((f) => f.endsWith('profile.schema.json'));
    const json = JSON.parse(host.files.get(profileFile as string) as string) as {
      required?: string[];
      properties?: Record<string, SchemaNode>;
    };
    // 唯一 required 字段：targets（其余均可省略，由默认值兜底）
    expect(json.required).toEqual(['targets']);
    expect(json.properties?.merge?.properties?.strategy?.default).toBe('overlay');
    expect(json.properties?.projection?.properties?.line_ending?.default).toBe('lf');
  });

  it('sources 工件：local/git 分支互斥结构存在', async () => {
    const host = createFakeHost();
    await emitSchemas(host, path.resolve('schemas-test'));
    const sourcesFile = [...host.files.keys()].find((f) => f.endsWith('sources.schema.json'));
    const json = JSON.parse(host.files.get(sourcesFile as string) as string) as {
      properties?: {
        sources?: {
          items?: {
            oneOf?: Array<{ required?: string[]; additionalProperties?: boolean }>;
          };
        };
      };
    };
    const branches = json.properties?.sources?.items?.oneOf;
    expect(branches).toHaveLength(2);
    const requiredSets = branches?.map((b) => [...(b.required ?? [])].sort());
    expect(requiredSets).toContainEqual(['id', 'path', 'type']); // local 分支
    expect(requiredSets).toContainEqual(['id', 'type', 'url']); // git 分支
    expect(branches?.every((b) => b.additionalProperties === false)).toBe(true);
  });
});
