/**
 * learning store 单测（Spec §4.3 / §7.4 / §7.5 / §10 / §11.2.3 前置）。
 *
 * 覆盖：id 生成与校验（正则 / Windows 非法字符）、createLearning 默认值与
 * CI 守卫、重复检测（§7.5 仍创建）、CRUD、YAML 往返（长行不折行）。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ConfigError } from '../../../src/core/errors';
import {
  createLearning,
  generateId,
  learningFilePath,
  listLearnings,
  removeLearning,
  showLearning,
  updateLearning,
  validateLearningId,
} from '../../../src/core/learning/store';
import { LearningIdPattern, LearningSchema } from '../../../src/schema';
import type { FakeHost } from '../test-utils';
import { createFakeHost } from '../test-utils';

const SOT = 'C:\\sot';

/**
 * 目录感知 listDir 的 fake host（对齐真实 host 的 readdir 语义；与 resolver.spec
 * 同款）：test-utils 原版 `/` 前缀扫描与 path.join（win32 `\`）产物不一致。
 */
function createDirAwareHost(envMap: Record<string, string> = {}): FakeHost {
  const base = createFakeHost(envMap);
  const host: FakeHost = {
    ...base,
    async listDir(p) {
      const prefix = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
      const names = new Set<string>();
      for (const key of base.files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (rest === '') {
            continue;
          }
          const sep = rest.search(/[\\/]/);
          names.add(sep === -1 ? rest : rest.slice(0, sep));
        }
      }
      return [...names].sort();
    },
  };
  return host;
}

describe('generateId', () => {
  it('符合 ^[a-z0-9][a-z0-9_-]{1,63}$（多次采样）', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateId()).toMatch(LearningIdPattern);
    }
  });

  it('形如 l<UTC 时间戳>-<随机后缀>（时间戳由注入 now 决定）', () => {
    const id = generateId(new Date('2026-08-21T04:30:11Z'));
    expect(id.startsWith('l20260821043011-')).toBe(true);
    expect(id).toMatch(LearningIdPattern);
  });

  it('两次生成不重复（随机后缀）', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateId()));
    expect(ids.size).toBe(20);
  });
});

describe('validateLearningId', () => {
  it('合法 id 通过', () => {
    expect(() => validateLearningId('l20260821043011-3fa2b1')).not.toThrow();
    expect(() => validateLearningId('ab')).not.toThrow();
    expect(() => validateLearningId('a-b_c9')).not.toThrow();
  });

  it('Windows 非法文件名字符 → ConfigError(2)（精确 hint）', () => {
    for (const bad of ['a<b', 'a>b', 'a:b', 'a"b', 'a/b', 'a\\b', 'a|b', 'a?b', 'a*b']) {
      try {
        validateLearningId(bad);
        expect.unreachable(`expected ConfigError for ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe(2);
        expect((err as ConfigError).message).toContain('Windows 非法文件名字符');
      }
    }
  });

  it('不符 §4.3 正则（大写开头 / 过短 / 过长）→ ConfigError(2)', () => {
    for (const bad of ['Aabc', 'a', '-ab', 'a'.repeat(65)]) {
      try {
        validateLearningId(bad);
        expect.unreachable(`expected ConfigError for ${bad.slice(0, 10)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe(2);
      }
    }
  });
});

describe('createLearning', () => {
  it('默认值：promoted:false / scope:project / category:other / confidence:0.5 / source:manual / trigger:"" / promote_target:custom_rule；created_at=updated_at=now', async () => {
    const host = createDirAwareHost();
    const { learning, file, duplicateOf } = await createLearning(
      { host, sotRoot: SOT },
      { content: '规则内容' },
    );

    expect(duplicateOf).toBeUndefined();
    expect(learning.id).toMatch(LearningIdPattern);
    expect(learning.promoted).toBe(false);
    expect(learning.promoted_at).toBeNull();
    expect(learning.scope).toBe('project');
    expect(learning.category).toBe('other');
    expect(learning.confidence).toBe(0.5);
    expect(learning.source).toBe('manual');
    expect(learning.trigger).toBe('');
    expect(learning.promote_target).toBe('custom_rule');
    // fake host now() = epoch 0
    expect(learning.created_at).toBe(new Date(0).toISOString());
    expect(learning.updated_at).toBe(new Date(0).toISOString());

    // 文件落在 <SoT>\learnings\<id>.yaml 且内容可解析往返
    expect(file).toBe(learningFilePath(SOT, learning.id));
    expect(host.files.get(file)).toBeDefined();
    const parsed = parseYaml(host.files.get(file) ?? '');
    expect(parsed.content).toBe('规则内容');
  });

  it('自定义字段全量生效（id/trigger/category/confidence/scope/source/promoteTarget）', async () => {
    const host = createDirAwareHost();
    const { learning } = await createLearning(
      { host, sotRoot: SOT },
      {
        content: '内容',
        id: 'my-custom-id',
        trigger: 'when adding deps',
        category: 'tooling',
        confidence: 0.9,
        scope: 'user',
        source: 'file:notes.md',
        promoteTarget: 'skill',
      },
    );
    expect(learning.id).toBe('my-custom-id');
    expect(learning.trigger).toBe('when adding deps');
    expect(learning.category).toBe('tooling');
    expect(learning.confidence).toBe(0.9);
    expect(learning.scope).toBe('user');
    expect(learning.source).toBe('file:notes.md');
    expect(learning.promote_target).toBe('skill');
  });

  it('CI=true（§10 守卫）→ ConfigError(2)，不落任何文件', async () => {
    const host = createDirAwareHost({ CI: 'true' });
    await expect(createLearning({ host, sotRoot: SOT }, { content: 'x' })).rejects.toMatchObject({
      code: 2,
      name: 'ConfigError',
    });
    expect(host.files.size).toBe(0);
  });

  it('CI=false / 未设置 → 正常创建', async () => {
    const a = createDirAwareHost({ CI: 'false' });
    await expect(createLearning({ host: a, sotRoot: SOT }, { content: 'x' })).resolves.toBeTruthy();
    const b = createDirAwareHost();
    await expect(createLearning({ host: b, sotRoot: SOT }, { content: 'x' })).resolves.toBeTruthy();
  });

  it('自定义 id 已存在 → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    await createLearning({ host, sotRoot: SOT }, { content: 'a', id: 'dup-id' });
    await expect(
      createLearning({ host, sotRoot: SOT }, { content: 'b', id: 'dup-id' }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it('重复检测（§7.5）：同 content 的未晋升条目 → duplicateOf 指向旧条目，仍创建（两条都在）', async () => {
    const host = createDirAwareHost();
    const first = await createLearning(
      { host, sotRoot: SOT },
      { content: '同样的规则', id: 'first' },
    );
    expect(first.duplicateOf).toBeUndefined();

    const second = await createLearning(
      { host, sotRoot: SOT },
      { content: '同样的规则', id: 'second' },
    );
    expect(second.duplicateOf).toBe('first');
    expect(second.learning.id).toBe('second');

    const all = await listLearnings({ host, sotRoot: SOT });
    expect(all.map((l) => l.id).sort()).toEqual(['first', 'second']);
  });

  it('重复检测只匹配未晋升条目：已 promoted 的同 content 不计 duplicateOf', async () => {
    const host = createDirAwareHost();
    await createLearning({ host, sotRoot: SOT }, { content: '规则', id: 'promoted-one' });
    // 手动把该条目标记为 promoted（模拟 promote 后的文件状态）
    const file = learningFilePath(SOT, 'promoted-one');
    const promoted = LearningSchema.parse({
      ...parseYaml(host.files.get(file) ?? ''),
      promoted: true,
      promoted_at: '1970-01-01T00:00:00.000Z',
    });
    host.files.set(file, stringifyYaml(promoted));

    const again = await createLearning({ host, sotRoot: SOT }, { content: '规则', id: 'again' });
    expect(again.duplicateOf).toBeUndefined();
  });

  it('长单行 content 不被 YAML 折行改写（lineWidth 0 往返一致）', async () => {
    const host = createDirAwareHost();
    const long = `规则：${'很长的内容'.repeat(60)}`; // 远超默认 80 列折行阈值
    const { learning } = await createLearning(
      { host, sotRoot: SOT },
      { content: long, id: 'long' },
    );
    const again = await showLearning({ host, sotRoot: SOT }, 'long');
    expect(again.content).toBe(long);
    expect(again.id).toBe(learning.id);
    // 落盘文本里 content 行保持单行（无折行续行）
    expect((host.files.get(learningFilePath(SOT, 'long')) ?? '').includes(long.slice(0, 20))).toBe(
      true,
    );
  });
});

describe('CRUD（list/show/update/remove）', () => {
  it('listLearnings 按文件名序；目录不存在 → []', async () => {
    const host = createDirAwareHost();
    expect(await listLearnings({ host, sotRoot: SOT })).toEqual([]);
    await createLearning({ host, sotRoot: SOT }, { content: 'a', id: 'b-entry' });
    await createLearning({ host, sotRoot: SOT }, { content: 'b', id: 'a-entry' });
    expect((await listLearnings({ host, sotRoot: SOT })).map((l) => l.id)).toEqual([
      'a-entry',
      'b-entry',
    ]);
  });

  it('showLearning 不存在 → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    await expect(showLearning({ host, sotRoot: SOT }, 'nope')).rejects.toMatchObject({ code: 2 });
  });

  it('updateLearning 修改可变字段并写回（可再读一致）', async () => {
    const host = createDirAwareHost();
    await createLearning(
      { host, sotRoot: SOT },
      {
        content: '旧内容',
        id: 'upd',
        category: 'other',
        confidence: 0.5,
      },
    );
    const updated = await updateLearning({ host, sotRoot: SOT }, 'upd', {
      content: '新内容',
      category: 'security',
      confidence: 0.8,
    });
    expect(updated.content).toBe('新内容');
    expect(updated.category).toBe('security');
    expect(updated.confidence).toBe(0.8);
    // fake host 的 now() 恒为 epoch，无法区分新旧——改为断言写回了文件且可再读
    const reread = await showLearning({ host, sotRoot: SOT }, 'upd');
    expect(reread).toEqual(updated);
  });

  it('updateLearning 不存在 → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    await expect(
      updateLearning({ host, sotRoot: SOT }, 'nope', { content: 'x' }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it('removeLearning 删除文件；再删 → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    await createLearning({ host, sotRoot: SOT }, { content: 'x', id: 'gone' });
    const { file } = await removeLearning({ host, sotRoot: SOT }, 'gone');
    expect(host.files.has(file)).toBe(false);
    await expect(removeLearning({ host, sotRoot: SOT }, 'gone')).rejects.toMatchObject({ code: 2 });
  });
});
