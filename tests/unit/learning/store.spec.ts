/**
 * learning store 单测（Spec §4.3 / §7.4 / §7.5 / §10 / §11.2.3 前置）。
 *
 * 覆盖：id 生成与校验（正则 / Windows 非法字符）、createLearning 默认值与
 * CI 守卫、confidence 的自动打分与显式覆盖、相似度判重两档（§7.5 仍创建）、
 * 老 YAML（无 confidence_source）向后兼容、CRUD、YAML 往返（长行不折行）。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ConfigError } from '../../../src/core/errors';
import { scoreConfidence } from '../../../src/core/learning/scoring';
import {
  createLearning,
  generateId,
  learningFilePath,
  listLearnings,
  parseLearningText,
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
  it('默认值：promoted:false / scope:project / category:other / source:manual / trigger:"" / promote_target:custom_rule；created_at=updated_at=now', async () => {
    const host = createDirAwareHost();
    const { learning, file, duplicateOf, similarTo } = await createLearning(
      { host, sotRoot: SOT },
      { content: '规则内容' },
    );

    expect(duplicateOf).toBeUndefined();
    expect(similarTo).toBeUndefined();
    expect(learning.id).toMatch(LearningIdPattern);
    expect(learning.promoted).toBe(false);
    expect(learning.promoted_at).toBeNull();
    expect(learning.scope).toBe('project');
    expect(learning.category).toBe('other');
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

  it('未给 confidence → 走启发式自动打分（不再是硬编码 0.5），confidence_source:auto', async () => {
    const host = createDirAwareHost();
    const { learning, confidenceScore } = await createLearning(
      { host, sotRoot: SOT },
      { content: '规则内容' },
    );

    // 最小信息量条目：只有 scope=project 一个信号命中 → 0.2 + 0.1 x 0.7
    expect(learning.confidence).toBe(0.27);
    expect(learning.confidence_source).toBe('auto');
    // breakdown 随结果带回命令层展示（"为什么是这个分"）
    expect(confidenceScore?.value).toBe(0.27);
    expect(confidenceScore?.signals).toHaveLength(6);
    // 落盘的也是这个 base 值
    expect(parseYaml(host.files.get(learningFilePath(SOT, learning.id)) ?? '').confidence).toBe(
      0.27,
    );
  });

  it('自动打分随内容质量变化（信息足的条目分更高，且与纯函数结果一致）', async () => {
    const host = createDirAwareHost();
    const content = [
      '必须用 `pnpm install` 安装依赖，锁文件见 src/config/pnpm-lock.yaml：',
      '```sh',
      'pnpm install --frozen-lockfile',
      '```',
    ].join('\n');
    const { learning } = await createLearning(
      { host, sotRoot: SOT },
      {
        content,
        id: 'rich',
        trigger: 'when adding deps',
        category: 'tooling',
        promoteTarget: 'skill',
      },
    );
    expect(learning.confidence).toBe(
      scoreConfidence({
        content,
        trigger: 'when adding deps',
        category: 'tooling',
        scope: 'project',
        promoteTarget: 'skill',
      }).value,
    );
    expect(learning.confidence).toBeGreaterThan(0.27);
  });

  it('显式给 confidence → 原样落盘、不被自动打分覆盖，confidence_source:manual 且无 breakdown', async () => {
    const host = createDirAwareHost();
    const { learning, confidenceScore } = await createLearning(
      { host, sotRoot: SOT },
      { content: '规则内容', confidence: 0.42 },
    );
    expect(learning.confidence).toBe(0.42);
    expect(learning.confidence_source).toBe('manual');
    expect(confidenceScore).toBeUndefined();
  });

  it('显式 confidence 的边界 0 与 1 都不被"看起来像没给"误判', async () => {
    const host = createDirAwareHost();
    const zero = await createLearning(
      { host, sotRoot: SOT },
      { content: 'x', confidence: 0, id: 'zero' },
    );
    expect(zero.learning.confidence).toBe(0);
    expect(zero.learning.confidence_source).toBe('manual');
    const one = await createLearning(
      { host, sotRoot: SOT },
      { content: 'y', confidence: 1, id: 'one' },
    );
    expect(one.learning.confidence).toBe(1);
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

  it('相似度判重：只差标点 / 大小写 → 仍判 duplicateOf（原先的 content 全等判据会漏）', async () => {
    const host = createDirAwareHost();
    await createLearning(
      { host, sotRoot: SOT },
      { content: '依赖安装统一走 pnpm，不要用 npm install。', id: 'orig' },
    );
    const again = await createLearning(
      { host, sotRoot: SOT },
      { content: '依赖安装统一走 pnpm；不要用 NPM install', id: 'variant' },
    );
    expect(again.duplicateOf).toBe('orig');
    expect(again.similarTo).toBeUndefined();
  });

  it('相似度判重：中等相似 → similarTo（合并建议），不占用 duplicateOf、不阻断创建', async () => {
    const host = createDirAwareHost();
    await createLearning(
      { host, sotRoot: SOT },
      { content: '依赖安装统一走 pnpm，不要用 npm install 直接装。', id: 'base' },
    );
    const near = await createLearning(
      { host, sotRoot: SOT },
      {
        content: '依赖安装统一走 pnpm，不要用 npm install 直接装，锁文件必须提交。',
        id: 'near',
      },
    );
    expect(near.duplicateOf).toBeUndefined();
    expect(near.similarTo?.id).toBe('base');
    expect(near.similarTo?.verdict).toBe('similar');
    expect(near.similarTo?.score).toBeGreaterThan(0.65);
    // 仍然落盘（不做自动合并，合并由人决定）
    expect(host.files.has(learningFilePath(SOT, 'near'))).toBe(true);
  });

  it('无关内容 → duplicateOf / similarTo 都缺席', async () => {
    const host = createDirAwareHost();
    await createLearning({ host, sotRoot: SOT }, { content: '依赖安装统一走 pnpm。', id: 'deps' });
    const other = await createLearning(
      { host, sotRoot: SOT },
      { content: '提交信息一律用中文，首行不超过 50 个字符。', id: 'commit' },
    );
    expect(other.duplicateOf).toBeUndefined();
    expect(other.similarTo).toBeUndefined();
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

describe('老 YAML 向后兼容（confidence_source 是可选新增字段）', () => {
  /** 自动打分上线**前**写下的条目：没有 confidence_source 键。 */
  const LEGACY_YAML = [
    'id: legacy-entry',
    'scope: project',
    'confidence: 0.5',
    'trigger: ""',
    'content: 旧条目内容',
    'category: other',
    'source: manual',
    'created_at: 2026-01-01T00:00:00.000Z',
    'updated_at: 2026-01-01T00:00:00.000Z',
    'promoted: false',
    'promoted_at: null',
    'promote_target: custom_rule',
    '',
  ].join('\n');

  it('缺 confidence_source 仍能通过校验，字段为 undefined（不被当成校验失败）', () => {
    const learning = parseLearningText('legacy.yaml', LEGACY_YAML);
    expect(learning.id).toBe('legacy-entry');
    expect(learning.confidence).toBe(0.5);
    expect(learning.confidence_source).toBeUndefined();
  });

  it('showLearning 读老条目正常；后续 update 不凭空补出 auto', async () => {
    const host = createDirAwareHost();
    host.files.set(learningFilePath(SOT, 'legacy-entry'), LEGACY_YAML);

    const read = await showLearning({ host, sotRoot: SOT }, 'legacy-entry');
    expect(read.confidence_source).toBeUndefined();

    const updated = await updateLearning({ host, sotRoot: SOT }, 'legacy-entry', {
      trigger: 'when installing',
    });
    // 只改了 trigger：来源未知就保持未知，不假装是自动打分出来的
    expect(updated.confidence_source).toBeUndefined();
    expect(updated.confidence).toBe(0.5);
  });

  it('落盘文本不写 confidence_source: null（缺席就是缺席）', async () => {
    const host = createDirAwareHost();
    host.files.set(learningFilePath(SOT, 'legacy-entry'), LEGACY_YAML);
    await updateLearning({ host, sotRoot: SOT }, 'legacy-entry', { category: 'tooling' });
    expect(host.files.get(learningFilePath(SOT, 'legacy-entry'))).not.toContain(
      'confidence_source',
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

  it('updateLearning 改 confidence → confidence_source 自动翻成 manual', async () => {
    const host = createDirAwareHost();
    const created = await createLearning({ host, sotRoot: SOT }, { content: '内容', id: 'src' });
    expect(created.learning.confidence_source).toBe('auto');

    const updated = await updateLearning({ host, sotRoot: SOT }, 'src', { confidence: 0.95 });
    expect(updated.confidence).toBe(0.95);
    expect(updated.confidence_source).toBe('manual');
  });

  it('updateLearning 不碰 confidence 时保留原来源', async () => {
    const host = createDirAwareHost();
    await createLearning({ host, sotRoot: SOT }, { content: '内容', id: 'keep' });
    const updated = await updateLearning({ host, sotRoot: SOT }, 'keep', { category: 'process' });
    expect(updated.confidence_source).toBe('auto');
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
