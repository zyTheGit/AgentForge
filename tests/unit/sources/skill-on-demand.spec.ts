/**
 * `skills.on_demand` 按需装载单测（Phase 2，Spec §4.2 / §5.3）。
 *
 * 覆盖三件事：
 * 1) `injectOnDemandMarker`：纯文本行插入、幂等、无 frontmatter 时不动；
 * 2) `readSkillsToMaterialize` 的 `on_demand` 分支：产物形态与三种 skip 原因；
 * 3) **always 回归守卫**：只声明 `always` 时，产物逐字节等于 SoT 原文，且绝不
 *    出现 `disable-model-invocation` —— 本功能对 always 必须是零影响。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
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

describe('injectOnDemandMarker（frontmatter 行插入，纯函数）', () => {
  it('有 frontmatter 且无该键 → 在结束 fence 前插入一行，其余逐字不动', () => {
    const result = injectOnDemandMarker(DOC_WITH_FRONTMATTER);
    expect(result.injected).toBe(true);
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

  it('幂等：已注入的产物再过一遍 → 原样返回（不重复插入）', () => {
    const once = injectOnDemandMarker(DOC_WITH_FRONTMATTER).content;
    expect(injectOnDemandMarker(once).content).toBe(once);
  });

  it('SoT 自己写了 disable-model-invocation: false → 尊重显式取值，不覆盖', () => {
    const doc = ['---', 'name: s', `${ON_DEMAND_FRONTMATTER_KEY}: false`, '---', 'body'].join('\n');
    const result = injectOnDemandMarker(doc);
    expect(result.injected).toBe(true);
    expect(result.content).toBe(doc);
  });

  it('无 frontmatter（首行不是 ---）→ 原样返回、injected=false', () => {
    const doc = '# 没有 frontmatter\n';
    expect(injectOnDemandMarker(doc)).toEqual({ content: doc, injected: false });
  });

  it('只有起始 fence、没有结束 fence → 视为无 frontmatter，不注入', () => {
    const doc = '---\nname: s\n没有结束围栏\n';
    expect(injectOnDemandMarker(doc)).toEqual({ content: doc, injected: false });
  });

  it('CRLF 正文：插入行跟随 CRLF 行尾（不制造混合行尾）', () => {
    const doc = '---\r\nname: s\r\n---\r\nbody\r\n';
    const result = injectOnDemandMarker(doc);
    expect(result.injected).toBe(true);
    expect(result.content).toBe(
      `---\r\nname: s\r\n${ON_DEMAND_FRONTMATTER_LINE}\r\n---\r\nbody\r\n`,
    );
  });

  it('缩进的同名键不算命中（那是别的映射的子键）→ 仍在顶层插入', () => {
    const doc = ['---', 'metadata:', `  ${ON_DEMAND_FRONTMATTER_KEY}: true`, '---', 'x'].join('\n');
    const result = injectOnDemandMarker(doc);
    expect(result.content.split('\n')).toContain(ON_DEMAND_FRONTMATTER_LINE);
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
  it('正常装了 → 产物带 onDemand: true 且正文被注入按需标记', async () => {
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
    expect(result.artifacts[0]?.content).toContain(ON_DEMAND_FRONTMATTER_LINE);
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

  it('同名已在 always → skip(shadowed-by-always)，只投影一次且不注入标记', async () => {
    const host = createDirAwareHost();
    seed(host, PROJECT_SOT, 'dup', DOC_WITH_FRONTMATTER);

    const result = await readSkillsToMaterialize(
      host,
      USER_SOT,
      PROJECT_SOT,
      profileWith({ always: ['dup'], on_demand: ['dup'] }),
    );
    expect(result.artifacts).toEqual([{ name: 'dup', content: DOC_WITH_FRONTMATTER }]);
    expect(result.skips[0]?.reason).toBe('shadowed-by-always');
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
