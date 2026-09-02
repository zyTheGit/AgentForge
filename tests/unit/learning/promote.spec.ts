/**
 * promote 单测（Spec §7.5 / §6.1 / §11.2.3 前置）。
 *
 * 覆盖：id 不存在→2、custom_rule 产物与条目标记（保留不删除）、目标冲突→3
 * （且条目仍 promoted:false，可重试）、已 promoted→3、--to user 跨层、skill
 * target、habits_note 简单实现（含目标层目录未 init 时自动 mkdirp）。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { EnvSnapshot } from '../../../src/core/env';
import { promoteLearning } from '../../../src/core/learning/promote';
import { createLearning, learningFilePath } from '../../../src/core/learning/store';
import { currentOs, type OsContext } from '../../../src/core/paths';
import type { FakeHost } from '../test-utils';
import { abs, createFakeHost, errnoError } from '../test-utils';

// 夹具走宿主平台语义：被测代码（promote / store / SoT 事务锁）用宿主 path.join
// 拼内存 fs 的键，夹具必须同语义，否则 posix 上键错位（见 test-utils.abs）。
const OS: OsContext = currentOs();
const USER_SOT = abs('user-sot');
const PROJECT_ROOT = abs('proj');
const PROJECT_SOT = path.join(PROJECT_ROOT, '.agentforge');

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
}

/**
 * 目录感知**严格**版 fake host：writeFile 要求父目录已被 mkdirp（模拟真实 fs 的
 * ENOENT），用于断言"写入前确实创建了目录"。preCreated 预置已 init 的目录。
 */
function createStrictDirHost(
  preCreated: readonly string[] = [],
): FakeHost & { mkdirpCalls: string[] } {
  const base = createHost();
  const mkdirpCalls: string[] = [];
  const dirs = new Set<string>();

  const addDir = (dir: string): void => {
    let current = dir;
    while (!dirs.has(current)) {
      dirs.add(current);
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  };
  for (const dir of preCreated) {
    addDir(dir);
  }

  return {
    ...base,
    mkdirpCalls,
    async mkdirp(p) {
      mkdirpCalls.push(p);
      addDir(p);
    },
    async mkdirExclusive(p) {
      // 原子创建成功即目录存在（SoT 事务锁目录走这条路，其下要能写 meta.json）
      const created = await base.mkdirExclusive(p);
      if (created) {
        addDir(p);
      }
      return created;
    },
    async writeFile(p, content) {
      const dir = path.dirname(p);
      if (!dirs.has(dir)) {
        throw errnoError('ENOENT', `no such directory: ${dir}`);
      }
      return base.writeFile(p, content);
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
    piCodingAgentDir: undefined,
    userProfile: abs('user'),
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
    expect(result.targetFile).toBe(path.join(PROJECT_SOT, 'custom', 'rule-1.md'));
    expect(host.files.get(result.targetFile)).toBe('规则正文');

    // 条目保留且已标记
    const entry = parseYaml(host.files.get(learningFilePath(PROJECT_SOT, 'rule-1')) ?? '');
    expect(entry.promoted).toBe(true);
    expect(entry.promoted_at).toBeTruthy();
    expect(result.learning.promoted).toBe(true);
    expect(result.learning.promoted_at).not.toBeNull();
  });

  it('目标文件已存在 → ConflictError(3)，且条目仍为 promoted:false（删除目标文件后可重试成功）', async () => {
    const host = createHost();
    await seed(host, { content: '内容', id: 'conflict-1' });
    const target = path.join(PROJECT_SOT, 'custom', 'conflict-1.md');
    host.files.set(target, '既有的手工文件');

    await expect(
      promoteLearning({ host, env: envFor(), os: OS, cwd: PROJECT_ROOT }, 'conflict-1'),
    ).rejects.toMatchObject({ code: 3, name: 'ConflictError' });

    // 可重试性：冲突在写 promoted 标记之前判定，条目状态未被污染
    const entry = parseYaml(host.files.get(learningFilePath(PROJECT_SOT, 'conflict-1')) ?? '');
    expect(entry.promoted).toBe(false);
    expect(entry.promoted_at).toBeNull();
    // 目标文件内容未被覆盖
    expect(host.files.get(target)).toBe('既有的手工文件');

    // 按 hint 删除目标文件后重试 → 成功（不需要手工编辑 learning YAML）
    host.files.delete(target);
    const retried = await promoteLearning(
      { host, env: envFor(), os: OS, cwd: PROJECT_ROOT },
      'conflict-1',
    );
    expect(retried.learning.promoted).toBe(true);
    expect(host.files.get(target)).toBe('内容');
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
    expect(result.targetFile).toBe(path.join(USER_SOT, 'custom', 'to-user-1.md'));
    expect(host.files.get(result.targetFile)).toBe('跨层规则');
    // 条目仍保留在 project 层
    expect(host.files.has(learningFilePath(PROJECT_SOT, 'to-user-1'))).toBe(true);
  });

  it('promote_target=skill → 写 skills/<id>/SKILL.md', async () => {
    const host = createHost();
    await seed(host, { content: '# 技能说明', id: 'skill-1', promoteTarget: 'skill' });

    const result = await promoteLearning(
      { host, env: envFor(), os: OS, cwd: PROJECT_ROOT },
      'skill-1',
    );
    expect(result.targetFile).toBe(path.join(PROJECT_SOT, 'skills', 'skill-1', 'SKILL.md'));
    expect(host.files.get(result.targetFile)).toBe('# 技能说明');
  });

  it('promote_target=habits_note → 追加到目标层 habits.yaml 的顶层 notes（无 habits 时创建）', async () => {
    const host = createHost();
    await seed(host, { content: '习惯性规则', id: 'note-1', promoteTarget: 'habits_note' });

    const result = await promoteLearning(
      { host, env: envFor(), os: OS, cwd: PROJECT_ROOT },
      'note-1',
    );
    expect(result.targetFile).toBe(path.join(PROJECT_SOT, 'habits.yaml'));

    const habits = parseYaml(host.files.get(result.targetFile) ?? '');
    expect(habits.version).toBe(1);
    expect(habits.notes).toEqual(['note-1: 习惯性规则']);
    // 不再写 detected 下的自由键（§4.1：detected 是探测器只读快照）
    expect(habits.detected?.promote_notes).toBeUndefined();
  });

  it('habits_note 第二次追加：notes 数组累积不覆盖', async () => {
    const host = createHost();
    await seed(host, { content: '第一条', id: 'note-a', promoteTarget: 'habits_note' });
    await seed(host, { content: '第二条', id: 'note-b', promoteTarget: 'habits_note' });
    await promoteLearning({ host, env: envFor(), os: OS, cwd: PROJECT_ROOT }, 'note-a');
    await promoteLearning({ host, env: envFor(), os: OS, cwd: PROJECT_ROOT }, 'note-b');

    const habits = parseYaml(host.files.get(path.join(PROJECT_SOT, 'habits.yaml')) ?? '');
    expect(habits.notes).toEqual(['note-a: 第一条', 'note-b: 第二条']);
  });

  it('project 层优先于 user 层查找同 id 条目', async () => {
    const host = createHost();
    await createLearning({ host, sotRoot: PROJECT_SOT }, { content: '项目层的', id: 'both' });
    await createLearning({ host, sotRoot: USER_SOT }, { content: '用户层的', id: 'both' });

    const result = await promoteLearning(
      { host, env: envFor(), os: OS, cwd: PROJECT_ROOT },
      'both',
    );
    expect(host.files.get(result.targetFile)).toBe('项目层的');
    // user 层条目未被标记
    const userEntry = parseYaml(host.files.get(learningFilePath(USER_SOT, 'both')) ?? '');
    expect(userEntry.promoted).toBe(false);
  });

  it('产物写入失败 → 条目仍为 promoted:false，恢复后重试成功（写入顺序：先产物，最后 promoted 标记）', async () => {
    const host = createHost();
    await seed(host, { content: '内容', id: 'atomic-test' });

    // 写入顺序断言随本次修复调整：修复前第 1 次 writeFile 是 learning 文件、
    // 第 2 次才是 custom/<id>.md；修复后前置校验与产物写入都在标记之前，
    // 因此 custom/<id>.md 变成第 1 次写入（其 atomicWrite 临时文件同在 custom/ 下）。
    // round-2：整段在 SoT 事务锁内执行，锁元数据（.sync.lock/meta.json）也走
    // host.writeFile，故断言前先滤掉锁目录下的写入。
    const originalWriteFile = host.writeFile.bind(host);
    const writtenPaths: string[] = [];
    host.writeFile = async (p: string, c: string) => {
      if (!p.includes('.sync.lock')) {
        writtenPaths.push(p);
      }
      if (p.includes('custom')) {
        throw new Error('模拟写目标文件失败');
      }
      return originalWriteFile(p, c);
    };

    await expect(
      promoteLearning({ host, env: envFor(), os: OS, cwd: PROJECT_ROOT }, 'atomic-test'),
    ).rejects.toThrow('模拟写目标文件失败');

    // 首次写入即产物（learning 文件此时尚未被重写）
    expect(writtenPaths.length).toBe(1);
    expect(writtenPaths[0]).toContain('custom');

    // 条目未被污染：仍是 promoted:false，也没有 promoted_at
    const entry = parseYaml(host.files.get(learningFilePath(PROJECT_SOT, 'atomic-test')) ?? '');
    expect(entry.promoted).toBe(false);
    expect(entry.promoted_at).toBeNull();

    const targetFile = path.join(PROJECT_SOT, 'custom', 'atomic-test.md');
    expect(host.files.has(targetFile)).toBe(false);

    // 恢复 writeFile 后直接重试即可成功（无需手工把 promoted 改回 false）
    host.writeFile = originalWriteFile;
    const retried = await promoteLearning(
      { host, env: envFor(), os: OS, cwd: PROJECT_ROOT },
      'atomic-test',
    );
    expect(retried.learning.promoted).toBe(true);
    expect(host.files.get(targetFile)).toBe('内容');
  });

  it('habits_note + --to user：user 层 SoT 目录不存在时先 mkdirp（不抛裸 ENOENT）', async () => {
    const host = createStrictDirHost([path.join(PROJECT_SOT, 'learnings')]);
    await seed(host, { content: '习惯规则', id: 'note-user', promoteTarget: 'habits_note' });

    const result = await promoteLearning(
      { host, env: envFor(), os: OS, cwd: PROJECT_ROOT },
      'note-user',
      { to: 'user' },
    );

    expect(result.targetScope).toBe('user');
    expect(result.targetFile).toBe(path.join(USER_SOT, 'habits.yaml'));
    expect(host.mkdirpCalls).toContain(USER_SOT);
    const habits = parseYaml(host.files.get(result.targetFile) ?? '');
    expect(habits.notes).toEqual(['note-user: 习惯规则']);
  });
});

describe('promoteLearning 并发（SoT 事务锁：校验-写入不重入）', () => {
  it('两个并发 promote：后者拿不到锁（ConflictError(3)），重试后两条产物都在（不丢写）', async () => {
    const host = createHost();
    await seed(host, { content: '第一条', id: 'race-a' });
    await seed(host, { content: '第二条', id: 'race-b' });
    const ctx = { host, env: envFor(), os: OS, cwd: PROJECT_ROOT };

    const settled = await Promise.allSettled([
      promoteLearning(ctx, 'race-a'),
      promoteLearning(ctx, 'race-b'),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
      code: 3,
      name: 'ConflictError',
    });

    // 失败者的条目未被污染（仍可重试），重试后两条产物齐备
    const loser = settled[0]?.status === 'fulfilled' ? 'race-b' : 'race-a';
    const loserEntry = parseYaml(host.files.get(learningFilePath(PROJECT_SOT, loser)) ?? '');
    expect(loserEntry.promoted).toBe(false);
    await promoteLearning(ctx, loser);
    expect(host.files.get(path.join(PROJECT_SOT, 'custom', 'race-a.md'))).toBe('第一条');
    expect(host.files.get(path.join(PROJECT_SOT, 'custom', 'race-b.md'))).toBe('第二条');
  });

  it('同一 id 并发 promote：产物只写一次，后者被锁或幂等守卫拦下（3）', async () => {
    const host = createHost();
    await seed(host, { content: '只应产出一次', id: 'race-same' });
    const ctx = { host, env: envFor(), os: OS, cwd: PROJECT_ROOT };

    const settled = await Promise.allSettled([
      promoteLearning(ctx, 'race-same'),
      promoteLearning(ctx, 'race-same'),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ code: 3 });
    expect(host.files.get(path.join(PROJECT_SOT, 'custom', 'race-same.md'))).toBe('只应产出一次');
  });

  it('锁在成功路径后被释放（连续 promote 不被自己的残留锁挡住）', async () => {
    const host = createHost();
    await seed(host, { content: 'A', id: 'seq-a' });
    await seed(host, { content: 'B', id: 'seq-b' });
    const ctx = { host, env: envFor(), os: OS, cwd: PROJECT_ROOT };
    await promoteLearning(ctx, 'seq-a');
    await expect(promoteLearning(ctx, 'seq-b')).resolves.toMatchObject({ targetScope: 'project' });
  });
});
