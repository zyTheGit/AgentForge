/**
 * `skills.on_demand` 按需装载单测（Phase 2，Spec §4.2 / §5.3）。
 *
 * 覆盖四件事：
 * 1) `injectOnDemandMarker` 的五态判定：注入 / 已是 true / 显式非 true /
 *    无 frontmatter / frontmatter 非法；
 * 2) **产物必须能被真的 YAML 解析器解析**：注入是写用户文件，字符串 toContain
 *    断言看不出「一行 YAML 被插进正文中间」或「同名键重复」这类结构破坏；
 * 3) `readSkillsToMaterialize` 的 `on_demand` 分支：产物形态与各 skip 原因；
 * 4) **always 回归守卫**：只声明 `always` 时，产物逐字节等于 SoT 原文，且绝不
 *    出现 `disable-model-invocation` —— 本功能对 always 必须是零影响。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { frontmatterRange } from '../../../src/core/project/commands';
import {
  injectOnDemandMarker,
  ON_DEMAND_FRONTMATTER_KEY,
  ON_DEMAND_FRONTMATTER_LINE,
  readSkillsToMaterialize,
  skillDocCandidates,
} from '../../../src/core/sources/skill';
import type { Profile } from '../../../src/schema';
import { ProfileSchema } from '../../../src/schema';
import { abs } from '../test-utils';
import { createDirAwareHost, type DirAwareHost } from './helpers';

const USER_SOT = abs('user-sot');
const PROJECT_SOT = path.join(abs('proj'), '.agentforge');

/** 带 frontmatter 的正常 SKILL.md（四家客户端都要求 name + description）。 */
const DOC_WITH_FRONTMATTER = [
  '---',
  'name: deep-research',
  'description: 深挖一个问题',
  '---',
  '',
  '# Deep Research',
  '',
  '正文若干。',
  '',
].join('\n');

function profileWith(skills: { always?: string[]; on_demand?: string[] }): Profile {
  return ProfileSchema.parse({ version: 1, targets: ['claude'], skills });
}

/** 往指定层布置一个 skill 的 SKILL.md。 */
function seed(host: DirAwareHost, root: string, name: string, content: string): string {
  const file = path.join(root, 'skills', name, 'SKILL.md');
  host.files.set(file, content);
  return file;
}

/**
 * 产物的 frontmatter 必须是合法 YAML 顶层映射，且按需键恰为 `true`。
 *
 * 这是本功能唯一的正确性判据：注入改写的是用户文件，字符串断言无法区分
 * 「插在 frontmatter 里」与「插进正文 / 插进块标量内部」。
 */
function expectValidInjectedFrontmatter(content: string): Record<string, unknown> {
  const range = frontmatterRange(content);
  expect(range).not.toBeNull();
  // 按 /\r?\n/ 切分再以 \n 拼回：真实 YAML 解析器把 CRLF 当换行，用 \n 硬切会把 `\r`
  // 留在标量里（`true\r` 变成字符串），那是测试脚手架的失真而非产物的问题
  const body = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .slice(1, range?.end)
    .join('\n');
  // parseYaml 会对 duplicate key 抛 YAMLParseError —— 引号形态同名键的回归守卫
  const parsed = parseYaml(body) as unknown;
  expect(typeof parsed).toBe('object');
  expect(parsed).not.toBeNull();
  expect(Array.isArray(parsed)).toBe(false);
  const record = parsed as Record<string, unknown>;
  expect(record[ON_DEMAND_FRONTMATTER_KEY]).toBe(true);
  return record;
}

describe('injectOnDemandMarker（frontmatter 行插入，纯函数）', () => {
  it('有 frontmatter 且无该键 → 在结束 fence 前插入一行，其余逐字不动', () => {
    const result = injectOnDemandMarker(DOC_WITH_FRONTMATTER);
    expect(result.status).toBe('injected');
    expect(result.content).toBe(
      [
        '---',
        'name: deep-research',
        'description: 深挖一个问题',
        ON_DEMAND_FRONTMATTER_LINE,
        '---',
        '',
        '# Deep Research',
        '',
        '正文若干。',
        '',
      ].join('\n'),
    );
    // 只多一行，正文区一个字符都没变
    expect(result.content.split('\n')).toHaveLength(DOC_WITH_FRONTMATTER.split('\n').length + 1);
  });

  it('幂等：已注入的产物再过一遍 → 原样返回、status=already-true', () => {
    const once = injectOnDemandMarker(DOC_WITH_FRONTMATTER).content;
    const twice = injectOnDemandMarker(once);
    expect(twice.status).toBe('already-true');
    expect(twice.content).toBe(once);
  });

  it('SoT 自己写了 disable-model-invocation: true → already-true，不重复插入', () => {
    const doc = ['---', 'name: s', `${ON_DEMAND_FRONTMATTER_KEY}: true`, '---', 'body'].join('\n');
    expect(injectOnDemandMarker(doc)).toEqual({ content: doc, status: 'already-true' });
  });

  it('SoT 显式写了 false → declared-false（尊重取值，但按需语义不生效）', () => {
    const doc = ['---', 'name: s', `${ON_DEMAND_FRONTMATTER_KEY}: false`, '---', 'body'].join('\n');
    expect(injectOnDemandMarker(doc)).toEqual({ content: doc, status: 'declared-false' });
  });

  it('引号形态的同名键（"key": true）也算命中 → 不追加第二个同名键', () => {
    const doc = ['---', 'name: s', `"${ON_DEMAND_FRONTMATTER_KEY}": true`, '---', 'x'].join('\n');
    const result = injectOnDemandMarker(doc);
    expect(result.status).toBe('already-true');
    expect(result.content).toBe(doc);
    // 追加过就会变成 duplicate key，parseYaml 直接抛
    expect(() =>
      parseYaml(['name: s', `"${ON_DEMAND_FRONTMATTER_KEY}": true`].join('\n')),
    ).not.toThrow();
  });

  it('单引号形态的 false 同名键 → declared-false（正则扫行扫不到，解析能）', () => {
    const doc = ['---', 'name: s', `'${ON_DEMAND_FRONTMATTER_KEY}': false`, '---', 'x'].join('\n');
    expect(injectOnDemandMarker(doc).status).toBe('declared-false');
  });

  it('无 frontmatter（首行不是 ---）→ 原样返回、no-frontmatter', () => {
    const doc = '# 没有 frontmatter\n';
    expect(injectOnDemandMarker(doc)).toEqual({ content: doc, status: 'no-frontmatter' });
  });

  it('只有起始 fence、没有结束 fence → 视为无 frontmatter，不注入', () => {
    const doc = '---\nname: s\n没有结束围栏\n';
    expect(injectOnDemandMarker(doc)).toEqual({ content: doc, status: 'no-frontmatter' });
  });

  it('CRLF 正文：插入行跟随 CRLF 行尾（不制造混合行尾）', () => {
    const doc = '---\r\nname: s\r\n---\r\nbody\r\n';
    const result = injectOnDemandMarker(doc);
    expect(result.status).toBe('injected');
    expect(result.content).toBe(
      `---\r\nname: s\r\n${ON_DEMAND_FRONTMATTER_LINE}\r\n---\r\nbody\r\n`,
    );
    expectValidInjectedFrontmatter(result.content);
  });

  it('混合行尾（frontmatter CRLF、正文 LF）：插入行跟随 fence 行的 CRLF', () => {
    const doc = '---\r\nname: s\r\n---\r\nbody line\nmore\n';
    const result = injectOnDemandMarker(doc);
    expect(result.status).toBe('injected');
    expect(result.content).toContain(`${ON_DEMAND_FRONTMATTER_LINE}\r\n---\r\n`);
    expectValidInjectedFrontmatter(result.content);
  });

  it('缩进的同名键不算命中（那是别的映射的子键）→ 仍在顶层插入', () => {
    const doc = ['---', 'metadata:', `  ${ON_DEMAND_FRONTMATTER_KEY}: true`, '---', 'x'].join('\n');
    const result = injectOnDemandMarker(doc);
    expect(result.status).toBe('injected');
    expect(result.content.split('\n')).toContain(ON_DEMAND_FRONTMATTER_LINE);
    const record = expectValidInjectedFrontmatter(result.content);
    // 子键仍在 metadata 下，没有被顶层的那行顶掉
    expect(record.metadata).toEqual({ [ON_DEMAND_FRONTMATTER_KEY]: true });
  });

  it('UTF-8 BOM 开头：不再静默降级为「无 frontmatter」，正常注入且 BOM 保留', () => {
    const doc = `\uFEFF${DOC_WITH_FRONTMATTER}`;
    const result = injectOnDemandMarker(doc);
    expect(result.status).toBe('injected');
    expect(result.content.startsWith('\uFEFF---')).toBe(true);
    expect(result.content.split('\n')).toContain(ON_DEMAND_FRONTMATTER_LINE);
  });
});

describe('injectOnDemandMarker — 拒绝在「没解析成功」的前提下改写用户文件', () => {
  it('正文以 --- 水平线开头（无 frontmatter 的文档）→ invalid-frontmatter，一个字节都不改', () => {
    const doc = ['---', '# 标题', '---', '', '正文，这里有个 key: value 的行。', ''].join('\n');
    expect(injectOnDemandMarker(doc)).toEqual({ content: doc, status: 'invalid-frontmatter' });
  });

  it('frontmatter 区间解析出的不是映射（纯标量）→ invalid-frontmatter', () => {
    const doc = ['---', '就是一句话', '---', 'body'].join('\n');
    expect(injectOnDemandMarker(doc)).toEqual({ content: doc, status: 'invalid-frontmatter' });
  });

  it('frontmatter 区间解析出数组 → invalid-frontmatter', () => {
    const doc = ['---', '- a', '- b', '---', 'body'].join('\n');
    expect(injectOnDemandMarker(doc)).toEqual({ content: doc, status: 'invalid-frontmatter' });
  });

  it('空 frontmatter（---\\n---）→ invalid-frontmatter（没有 name/description 本就加载不了）', () => {
    const doc = ['---', '---', 'body'].join('\n');
    expect(injectOnDemandMarker(doc)).toEqual({ content: doc, status: 'invalid-frontmatter' });
  });

  it('块标量里的 --- 缩进时正常注入，产物仍是合法 YAML 且块标量内容不变', () => {
    // command-body 存的是 prompt 正文，里面出现 --- 分隔线很自然。合法 YAML 里块标量
    // 内容必须比父键更缩进，因此这些 --- 一定带缩进 → fence 正则（要求顶格）不会误判
    const doc = [
      '---',
      'name: s',
      'description: d',
      'command-body: |',
      '  第一段',
      '  ---',
      '  第二段',
      '---',
      '',
      'body',
      '',
    ].join('\n');
    const result = injectOnDemandMarker(doc);
    expect(result.status).toBe('injected');
    const record = expectValidInjectedFrontmatter(result.content);
    expect(record['command-body']).toBe('第一段\n---\n第二段\n');
  });

  it('文档里有多条顶格 ---：产物的 frontmatter 仍恒为合法 YAML 顶层映射', () => {
    // 顶格 --- 在 YAML 里就是文档分隔符，这种 SKILL.md 本身语义歧义（谁是结束 fence
    // 无从判定）。本函数的承诺只有一条：无论输入如何，**产出的 frontmatter 必须能被
    // YAML 解析器解析成顶层映射**（否则退回原文报 invalid-frontmatter），不会让
    // claude / pi 因为一个坏产物而整个技能加载失败
    const doc = ['---', 'name: s', '---', '正文一段', '---', '正文二段', ''].join('\n');
    const result = injectOnDemandMarker(doc);
    if (result.status === 'injected') {
      expectValidInjectedFrontmatter(result.content);
    } else {
      expect(result.content).toBe(doc);
    }
  });
});

describe('skillDocCandidates（§5.3 project 优先于 user）', () => {
  it('顺序恒为 [project, user]', () => {
    expect(skillDocCandidates(USER_SOT, PROJECT_SOT, 'x')).toEqual([
      path.join(PROJECT_SOT, 'skills', 'x', 'SKILL.md'),
      path.join(USER_SOT, 'skills', 'x', 'SKILL.md'),
    ]);
  });
});

describe('readSkillsToMaterialize — always 回归守卫（本功能对 always 零影响）', () => {
  it('always 的产物逐字节等于 SoT 原文，且不含按需标记', async () => {
    const host = createDirAwareHost();
    seed(host, PROJECT_SOT, 'code-review', DOC_WITH_FRONTMATTER);

    const result = await readSkillsToMaterialize(
      host,
      USER_SOT,
      PROJECT_SOT,
      profileWith({ always: ['code-review'] }),
    );
    expect(result).toEqual({
      artifacts: [{ name: 'code-review', content: DOC_WITH_FRONTMATTER }],
      skips: [],
    });
    expect(result.artifacts[0]?.content).not.toContain(ON_DEMAND_FRONTMATTER_KEY);
    // onDemand 位对 always 必须缺席（codex projector 据此决定是否写 sidecar）
    expect(result.artifacts[0]?.onDemand).toBeUndefined();
  });

  it('always 缺失仍是 ConfigError(2) fail-fast（不因新增 skips 通道而降级）', async () => {
    const host = createDirAwareHost();
    await expect(
      readSkillsToMaterialize(host, USER_SOT, PROJECT_SOT, profileWith({ always: ['ghost'] })),
    ).rejects.toMatchObject({ code: 2 });
  });
});

describe('readSkillsToMaterialize — on_demand 分支', () => {
  it('正常装了 → 产物带 onDemand: true，正文注入且仍是合法 YAML', async () => {
    const host = createDirAwareHost();
    seed(host, PROJECT_SOT, 'deep-research', DOC_WITH_FRONTMATTER);

    const result = await readSkillsToMaterialize(
      host,
      USER_SOT,
      PROJECT_SOT,
      profileWith({ on_demand: ['deep-research'] }),
    );
    expect(result.skips).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.name).toBe('deep-research');
    expect(result.artifacts[0]?.onDemand).toBe(true);
    expectValidInjectedFrontmatter(result.artifacts[0]?.content ?? '');
  });

  it('§5.3 优先级同样适用：project 层覆盖 user 层同名', async () => {
    const host = createDirAwareHost();
    seed(host, USER_SOT, 'x', '---\nname: x\n---\nuser 版\n');
    seed(host, PROJECT_SOT, 'x', '---\nname: x\n---\nproject 版\n');

    const result = await readSkillsToMaterialize(
      host,
      USER_SOT,
      PROJECT_SOT,
      profileWith({ on_demand: ['x'] }),
    );
    expect(result.artifacts[0]?.content).toContain('project 版');
  });

  it('未安装 → skip(not-installed)，不抛错、不产出产物（与 always 刻意不同）', async () => {
    const host = createDirAwareHost();
    const result = await readSkillsToMaterialize(
      host,
      USER_SOT,
      PROJECT_SOT,
      profileWith({ on_demand: ['ghost'] }),
    );
    expect(result.artifacts).toEqual([]);
    expect(result.skips).toHaveLength(1);
    expect(result.skips[0]?.name).toBe('ghost');
    expect(result.skips[0]?.reason).toBe('not-installed');
    // detail 列出查找过的两层路径，便于用户直接定位
    expect(result.skips[0]?.detail).toContain(path.join(PROJECT_SOT, 'skills', 'ghost'));
    expect(result.skips[0]?.detail).toContain(path.join(USER_SOT, 'skills', 'ghost'));
  });

  it('无 frontmatter → skip(no-frontmatter)，但正文照常投影（不让技能凭空消失）', async () => {
    const host = createDirAwareHost();
    const file = seed(host, PROJECT_SOT, 'bare', '# 裸文档\n');

    const result = await readSkillsToMaterialize(
      host,
      USER_SOT,
      PROJECT_SOT,
      profileWith({ on_demand: ['bare'] }),
    );
    expect(result.artifacts).toEqual([{ name: 'bare', content: '# 裸文档\n', onDemand: true }]);
    expect(result.skips).toEqual([{ name: 'bare', reason: 'no-frontmatter', detail: file }]);
  });

  it('frontmatter 非法 → skip(invalid-frontmatter)，正文逐字节原样投影', async () => {
    const host = createDirAwareHost();
    const doc = ['---', '# 标题', '---', '', '正文 key: value', ''].join('\n');
    const file = seed(host, PROJECT_SOT, 'weird', doc);

    const result = await readSkillsToMaterialize(
      host,
      USER_SOT,
      PROJECT_SOT,
      profileWith({ on_demand: ['weird'] }),
    );
    // onDemand 仍为 true：codex 的 sidecar 与 frontmatter 无关，那一侧照样生效
    expect(result.artifacts).toEqual([{ name: 'weird', content: doc, onDemand: true }]);
    expect(result.skips).toEqual([{ name: 'weird', reason: 'invalid-frontmatter', detail: file }]);
  });

  it('SoT 显式 false → skip(declared-false) 且**不带 onDemand**（codex 也不产 sidecar）', async () => {
    const host = createDirAwareHost();
    const doc = ['---', 'name: s', `${ON_DEMAND_FRONTMATTER_KEY}: false`, '---', 'body', ''].join(
      '\n',
    );
    const file = seed(host, PROJECT_SOT, 'optout', doc);

    const result = await readSkillsToMaterialize(
      host,
      USER_SOT,
      PROJECT_SOT,
      profileWith({ on_demand: ['optout'] }),
    );
    expect(result.artifacts).toEqual([{ name: 'optout', content: doc }]);
    expect(result.artifacts[0]?.onDemand).toBeUndefined();
    expect(result.skips).toEqual([{ name: 'optout', reason: 'declared-false', detail: file }]);
  });

  it('两张名单并存：产物顺序为先 always 后 on_demand', async () => {
    const host = createDirAwareHost();
    seed(host, PROJECT_SOT, 'a', DOC_WITH_FRONTMATTER);
    seed(host, PROJECT_SOT, 'b', DOC_WITH_FRONTMATTER);

    const result = await readSkillsToMaterialize(
      host,
      USER_SOT,
      PROJECT_SOT,
      profileWith({ always: ['a'], on_demand: ['b'] }),
    );
    expect(result.artifacts.map((item) => item.name)).toEqual(['a', 'b']);
    expect(result.artifacts[0]?.onDemand).toBeUndefined();
    expect(result.artifacts[1]?.onDemand).toBe(true);
  });
});

describe('两张名单交集 → schema 直接拒（不再是 sync 阶段的 warn）', () => {
  it('同名同时出现在 always 与 on_demand → ProfileSchema 校验失败', () => {
    const result = ProfileSchema.safeParse({
      version: 1,
      targets: ['claude'],
      skills: { always: ['dup'], on_demand: ['dup'] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['skills', 'on_demand']);
    expect(result.error?.issues[0]?.message).toContain('dup');
  });

  it('无交集时照常通过', () => {
    expect(
      ProfileSchema.safeParse({
        version: 1,
        targets: ['claude'],
        skills: { always: ['a'], on_demand: ['b'] },
      }).success,
    ).toBe(true);
  });
});
