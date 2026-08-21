/**
 * promote 单测（Spec §7.5 / §6.1 / §11.2.3 前置）。
 *
 * 覆盖：id 不存在→2、custom_rule 产物与条目标记（保留不删除）、目标冲突→3、
 * 已 promoted→3、--to user 跨层、skill target、habits_note 简单实现。
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { EnvSnapshot } from '../../../src/core/env';
import { createLearning, learningFilePath } from '../../../src/core/learning/store';
import { promoteLearning } from '../../../src/core/learning/promote';
import type { OsContext } from '../../../src/core/paths';
import { createFakeHost } from '../test-utils';
import type { FakeHost } from '../test-utils';

const OS: OsContext = { platform: 'win32' };
const USER_SOT = 'C:\\user-sot';
const PROJECT_ROOT = 'C:\\proj';
const PROJECT_SOT = path.win32.join(PROJECT_ROOT, '.agentforge');

/** 目录感知 listDir 的 fake host（与 resolver.spec 同款，见 store.spec 注释）。 */
function createHost(envMap: Record<string, string> = {}): FakeHost {
  const base = createFakeHost(envMap);
  return {
    ...base,
    async listDir(p) {
      const prefix = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
      const names = new Set<string>();
      for (const key of base.files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (rest === '') continue;
          const sep = rest.search(/[\\/]/);
          names.add(sep === -1 ? rest : rest.slice(0, sep));
        }
      }
      return [...names].sort();
    },
  };
}

function envFor(): EnvSnapshot {
  return {
    agfHome: USER_SOT,
    agfScope: undefined,
    offline: false,
    lineEnding: undefined,
    ci: false,
    codexHome: undefined,
    userProfile: 'C:\\user',
  };
}

/** 在 project 层创建一条 learning（promote 前置）。 */
async function seed(
  host: FakeHost,
  input: { content: string; id: string; promoteTarget?: 'custom_rule' | 'skill' | 'habits_note' },
): Promise<void> {
  await createLearning(
    { host, sotRoot: PROJECT_SOT },
    { content: input.content, id: input.id, promoteTarget: input.promoteTarget },
  );
}

describe('promoteLearning', () => {
  it('id 两层均不存在 → ConfigError(2)', async () => {
    const host = createHost();
    await expect(
      promoteLearning({ host, env: envFor(), os: OS, cwd: PROJECT_ROOT }, 'nope'),
    ).rejects.toMatchObject({ code: 2 });
  });

  it('custom_rule（默认目标层=条目所在层）：写 custom/<id>.md，条目标记 promoted 且保留', async () => {
    const host = createHost();
    await seed(host, { content: '规则正文', id: 'rule-1' });

    const result = await promoteLearning(
      { host, env: envFor(), os: OS, cwd: PROJECT_ROOT },
      'rule-1',
    );

    expect(result.fromScope).toBe('project');
    expect(result.targetScope).toBe('project');
    expect(result.targetSoTRoot).toBe(PROJECT_SOT);
    expect(result.targetFile).toBe(path.win32.join(PROJECT_SOT, 'custom', 'rule-1.md'));
    expect(host.files.get(result.targetFile)).toBe('规则正文');

    // 条目保留且已标记
    const entry = parseYaml(host.files.get(learningFilePath(PROJECT_SOT, 'rule-1')) ?? '');
    expect(entry.promoted).toBe(true);
    expect(entry.promoted_at).toBeTruthy();
    expect(result.learning.promoted).toBe(true);
    expect(result.learning.promoted_at).not.toBeNull();
  });

  it('目标文件已存在 → ConflictError(3)，条目不被标记 promoted（先检查后写入）', async () => {
    const host = createHost();
    await seed(host, { content: '内容', id: 'conflict-1' });
    const target = path.win32.join(PROJECT_SOT, 'custom', 'conflict-1.md');
    host.files.set(target, '既有的手工文件');

    await expect(
      promoteLearning({ host, env: envFor(), os: OS, cwd: PROJECT_ROOT }, 'conflict-1'),
    ).rejects.toMatchObject({ code: 3, name: 'ConflictError' });

    // 原文件内容未被覆盖；条目仍为未晋升
    expect(host.files.get(target)).toBe('既有的手工文件');
    const entry = parseYaml(host.files.get(learningFilePath(PROJECT_SOT, 'conflict-1')) ?? '');
    expect(entry.promoted).toBe(false);
  });

  it('已 promoted 的条目再次 promote → ConflictError(3)（幂等防重）', async () => {
    const host = createHost();
    await seed(host, { content: '内容', id: 'twice' });
    await promoteLearning({ host, env: envFor(), os: OS, cwd: PROJECT_ROOT }, 'twice');
    await expect(
      promoteLearning({ host, env: envFor(), os: OS, cwd: PROJECT_ROOT }, 'twice'),
    ).rejects.toMatchObject({ code: 3 });
  });

  it('--to user：project 层条目晋升产物写入 user 层 SoT', async () => {
    const host = createHost();
    await seed(host, { content: '跨层规则', id: 'to-user-1' });

    const result = await promoteLearning(
      { host, env: envFor(), os: OS, cwd: PROJECT_ROOT },
      'to-user-1',
      { to: 'user' },
    );

    expect(result.fromScope).toBe('project');
    expect(result.targetScope).toBe('user');
    expect(result.targetSoTRoot).toBe(USER_SOT);
    expect(result.targetFile).toBe(path.win32.join(USER_SOT, 'custom', 'to-user-1.md'));
    expect(host.files.get(result.targetFile)).toBe('跨层规则');
    // 条目仍保留在 project 层
    expect(host.files.has(learningFilePath(PROJECT_SOT, 'to-user-1'))).toBe(true);
  });

  it('promote_target=skill → 写 skills/<id>/SKILL.md', async () => {
    const host = createHost();
    await seed(host, { content: '# 技能说明', id: 'skill-1', promoteTarget: 'skill' });

    const result = await promoteLearning({ host, env: envFor(), os: OS, cwd: PROJECT_ROOT }, 'skill-1');
    expect(result.targetFile).toBe(path.win32.join(PROJECT_SOT, 'skills', 'skill-1', 'SKILL.md'));
    expect(host.files.get(result.targetFile)).toBe('# 技能说明');
  });

  it('promote_target=habits_note → 追加到目标层 habits.yaml 的 detected.promote_notes（无 habits 时创建）', async () => {
    const host = createHost();
    await seed(host, { content: '习惯性规则', id: 'note-1', promoteTarget: 'habits_note' });

    const result = await promoteLearning({ host, env: envFor(), os: OS, cwd: PROJECT_ROOT }, 'note-1');
    expect(result.targetFile).toBe(path.win32.join(PROJECT_SOT, 'habits.yaml'));

    const habits = parseYaml(host.files.get(result.targetFile) ?? '');
    expect(habits.version).toBe(1);
    expect(habits.detected.promote_notes).toEqual(['note-1: 习惯性规则']);
  });

  it('habits_note 第二次追加：notes 数组累积不覆盖', async () => {
    const host = createHost();
    await seed(host, { content: '第一条', id: 'note-a', promoteTarget: 'habits_note' });
    await seed(host, { content: '第二条', id: 'note-b', promoteTarget: 'habits_note' });
    await promoteLearning({ host, env: envFor(), os: OS, cwd: PROJECT_ROOT }, 'note-a');
    await promoteLearning({ host, env: envFor(), os: OS, cwd: PROJECT_ROOT }, 'note-b');

    const habits = parseYaml(host.files.get(path.win32.join(PROJECT_SOT, 'habits.yaml')) ?? '');
    expect(habits.detected.promote_notes).toEqual(['note-a: 第一条', 'note-b: 第二条']);
  });

  it('project 层优先于 user 层查找同 id 条目', async () => {
    const host = createHost();
    await createLearning({ host, sotRoot: PROJECT_SOT }, { content: '项目层的', id: 'both' });
    await createLearning({ host, sotRoot: USER_SOT }, { content: '用户层的', id: 'both' });

    const result = await promoteLearning({ host, env: envFor(), os: OS, cwd: PROJECT_ROOT }, 'both');
    expect(host.files.get(result.targetFile)).toBe('项目层的');
    // user 层条目未被标记
    const userEntry = parseYaml(host.files.get(learningFilePath(USER_SOT, 'both')) ?? '');
    expect(userEntry.promoted).toBe(false);
  });
});
