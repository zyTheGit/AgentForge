/**
 * learning 晋升（Spec §7.5 Promote）。
 *
 * 流程（§7.5 第 1-4 条）：
 * 1. 校验 id（project 层优先于 user 层查找；两层均无 → ConfigError(2)）；
 * 2. 按 promote_target 写入目标层 SoT：
 *    - custom_rule → `custom/<id>.md`；
 *    - skill → `skills/<id>/SKILL.md`；
 *    - habits_note → 追加到 habits.yaml 的 detected.promote_notes
 *      （**简单实现**：notes 类字段 Spec 未定义结构，此处选 detected 下的
 *      自由键，渲染层不消费——仅作记录；M9+ 如有正式 notes 字段再迁移）；
 * 3. 标记 promoted: true + promoted_at（条目保留不删除，§7.5）；
 * 4. 可选立即 sync 由 CLI 层提示，core 不自动执行。
 *
 * 目标层：默认写入 learning 所在层；--to user → user 层（显式确认语义在 CLI 层，
 * core 层直接执行）。目标文件已存在 → ConflictError(3)（§6.1 promote 目标
 * 文件名冲突）。已 promoted 的条目再次 promote → ConflictError(3)（幂等防重）。
 *
 * 写入顺序（可重试性保障）：全部前置校验（目标路径冲突 / 目录可创建）→ 写产物
 * → **最后**写 promoted 标记。任一前置校验或产物写入失败时，条目仍为
 * promoted:false，用户处理掉冲突/权限问题后可直接重跑 promote。
 *
 * 并发（round-2 修复）：整段「读条目 → 校验 → 写产物 → 写 promoted 标记」在
 * **SoT 事务锁**内执行（project/sync-lock.withSotLock，与 sync 同一把 `.sync.lock`）。
 * 锁原语直接从 project/sync-lock 取而不经 project/engine 转出口——engine 顶层会求值
 * 整套 sync 引擎（projector 注册表、sources/skill、writer），为一个锁函数拖进来无谓，
 * 与 config/edit-profile 同源（见该模块头「依赖方向」）。
 * 不持锁时有两个窗口：① 两个并发 promote 都读到 promoted:false → 产物写两遍、
 * 标记互相覆盖；② 与 sync 并发时 sync 的备份基准已过期，回滚会覆盖 promote 的写入。
 * 条目在锁内**重新读取**（锁外那次只用于确定要锁哪几个 SoT 根）。
 */
import path from 'node:path';
import { atomicWrite, mkdirp } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import { type HabitsInput, type Learning, LearningSchema } from '../../schema';
import { HABITS_FILE, loadHabits } from '../config/load';
import { serializeYamlDoc } from '../config/serialize';
import type { EnvSnapshot } from '../env';
import { ConfigError, ConflictError } from '../errors';
import {
  type OsContext,
  resolveProjectSoT,
  resolveUserSoT,
  SKILL_DOC_FILENAME,
  SKILLS_DIRNAME,
} from '../paths';
import { withSotLock } from '../project/sync-lock';
import { learningFilePath, readLearningFile } from './store';

/** promote 上下文（host/env/os/cwd 注入；测试可换 fake host）。 */
export interface PromoteContext {
  readonly host: Host;
  readonly env: EnvSnapshot;
  readonly os: OsContext;
  /** 项目根（project 层 SoT 基准）。 */
  readonly cwd: string;
}

export interface PromoteOptions {
  /** --to user：晋升产物写入 user 层 SoT（默认写入 learning 所在层）。 */
  readonly to?: 'user';
}

/** promote 结果。 */
export interface PromoteResult {
  /** 标记 promoted 后的最新条目（原文件已更新，条目保留不删除）。 */
  readonly learning: Learning;
  /** 条目所在层。 */
  readonly fromScope: 'user' | 'project';
  /** 产物写入层。 */
  readonly targetScope: 'user' | 'project';
  readonly targetSoTRoot: string;
  /** custom_rule / skill 的目标文件（habits_note 为 habits.yaml 路径）。 */
  readonly targetFile: string;
}

/** 在两层 SoT 中查找 learning（project 优先，§5.3 同名优先级精神）。 */
async function findLearning(
  host: Host,
  userSoTRoot: string,
  projectSoTRoot: string,
  id: string,
): Promise<{ learning: Learning; scope: 'user' | 'project'; sotRoot: string } | null> {
  for (const layer of [
    { scope: 'project' as const, sotRoot: projectSoTRoot },
    { scope: 'user' as const, sotRoot: userSoTRoot },
  ]) {
    const learning = await readLearningFile(host, learningFilePath(layer.sotRoot, id));
    if (learning !== null) {
      return { learning, scope: layer.scope, sotRoot: layer.sotRoot };
    }
  }
  return null;
}

/**
 * habits_note 简单实现：追加到目标层 habits.yaml 的 detected.promote_notes 数组。
 * habits.yaml 不存在时创建最小骨架（version + detected）；目标层 SoT 目录尚未
 * init（如 `--to user` 但 user 层未初始化）时先 mkdirp，避免裸 ENOENT 绕过
 * PermissionError(4) 的错误码映射（与 custom_rule / skill 两个分支一致）。
 */
async function appendPromoteNote(host: Host, sotRoot: string, learning: Learning): Promise<string> {
  const habitsFile = path.join(sotRoot, HABITS_FILE);
  const existing = await loadHabits(host, sotRoot);
  const habits: HabitsInput = existing ?? { version: 1, detected: {} };
  const detected = { ...(habits.detected ?? {}) };
  const notes = Array.isArray(detected.promote_notes) ? [...detected.promote_notes] : [];
  notes.push(`${learning.id}: ${learning.content.replace(/\s+/g, ' ').trim()}`);
  detected.promote_notes = notes;
  habits.detected = detected;

  await mkdirp(host, sotRoot);
  await atomicWrite(host, habitsFile, serializeYamlDoc(habits));
  return habitsFile;
}

/** 按 promote_target 计算产物路径（纯计算，供写入前的冲突预检使用）。 */
function resolveTargetFile(targetSoTRoot: string, learning: Learning): string {
  switch (learning.promote_target) {
    case 'custom_rule':
      return path.join(targetSoTRoot, 'custom', `${learning.id}.md`);
    case 'skill':
      return path.join(targetSoTRoot, SKILLS_DIRNAME, learning.id, SKILL_DOC_FILENAME);
    case 'habits_note':
      return path.join(targetSoTRoot, HABITS_FILE);
  }
}

/**
 * 产物写入前的冲突预检（§6.1 promote 目标文件名冲突 → 退出码 3）。
 * habits_note 为**追加**语义，habits.yaml 已存在不算冲突。
 * @throws ConflictError(3) 目标文件已存在。
 */
async function assertTargetWritable(
  host: Host,
  learning: Learning,
  targetFile: string,
): Promise<void> {
  if (learning.promote_target === 'habits_note') {
    return;
  }
  if (await host.exists(targetFile)) {
    throw new ConflictError(`promote 目标文件已存在: ${targetFile}`, {
      hint:
        learning.promote_target === 'skill'
          ? '手动确认内容后删除该目录，或修改 learning 的 promote_target 后重试'
          : '手动确认内容后删除该文件，或修改 learning 的 promote_target 后重试',
      details: { id: learning.id, targetFile },
    });
  }
}

/** 写入晋升产物（目录自动创建；habits_note 走追加实现）。 */
async function writePromoteArtifact(
  host: Host,
  targetSoTRoot: string,
  learning: Learning,
  targetFile: string,
): Promise<void> {
  if (learning.promote_target === 'habits_note') {
    await appendPromoteNote(host, targetSoTRoot, learning);
    return;
  }
  await mkdirp(host, path.dirname(targetFile));
  await atomicWrite(host, targetFile, learning.content);
}

/**
 * 晋升一条 learning（§7.5）。
 *
 * 失败即可重试：任何异常抛出时条目仍为 promoted:false（标记是最后一步写入）。
 * 校验与写入整段在 SoT 事务锁内（见文件头「并发」小节）。
 *
 * @throws ConfigError(2) id 两层均不存在 / learning 文件损坏；
 * @throws ConflictError(3) 目标文件已存在 / 条目已 promoted / 取不到 SoT 事务锁；
 * @throws PermissionError(4) 目录创建或写入失败（mkdirp/atomicWrite 映射）。
 */
export async function promoteLearning(
  ctx: PromoteContext,
  id: string,
  opts: PromoteOptions = {},
): Promise<PromoteResult> {
  const { host, env, os, cwd } = ctx;
  const userSoTRoot = resolveUserSoT(env, os);
  const projectSoTRoot = resolveProjectSoT(cwd, os);

  // 锁外先定位一次：只为确定"要锁哪几个 SoT 根"（条目内容在锁内重新读取）
  const located = await findLearning(host, userSoTRoot, projectSoTRoot, id);
  if (located === null) {
    throw new ConfigError(`learning 不存在: ${id}`, {
      hint: '运行 aforge learnings list 查看全部条目',
      details: { id, userSoTRoot, projectSoTRoot },
    });
  }
  const targetScope: 'user' | 'project' = opts.to === 'user' ? 'user' : located.scope;
  const targetSoTRoot = targetScope === 'project' ? projectSoTRoot : userSoTRoot;

  const run = (): Promise<PromoteResult> =>
    promoteInLock(ctx, id, { userSoTRoot, projectSoTRoot, targetScope, targetSoTRoot });

  // 条目所在层与产物目标层可能不同（--to user）：按字典序从外到内嵌套加锁，
  // 与 engine.acquireSyncLocks 的顺序一致，避免与并发 sync 形成环形等待。
  const roots = [...new Set([located.sotRoot, targetSoTRoot])].sort();
  const [first, second] = roots;
  if (first === undefined) {
    return run();
  }
  if (second === undefined) {
    return withSotLock(host, first, os, run);
  }
  return withSotLock(host, first, os, () => withSotLock(host, second, os, run));
}

/** 锁内的实际晋升流程（条目重新读取 → 校验 → 写产物 → 最后写 promoted 标记）。 */
async function promoteInLock(
  ctx: PromoteContext,
  id: string,
  layers: {
    readonly userSoTRoot: string;
    readonly projectSoTRoot: string;
    readonly targetScope: 'user' | 'project';
    readonly targetSoTRoot: string;
  },
): Promise<PromoteResult> {
  const { host } = ctx;
  const { userSoTRoot, projectSoTRoot, targetScope, targetSoTRoot } = layers;

  // 锁内重新读取：锁外那次读取到取得锁之间，条目可能已被并发 promote 改写
  const found = await findLearning(host, userSoTRoot, projectSoTRoot, id);
  if (found === null) {
    throw new ConfigError(`learning 不存在: ${id}`, {
      hint: '运行 aforge learnings list 查看全部条目',
      details: { id, userSoTRoot, projectSoTRoot },
    });
  }

  if (found.learning.promoted) {
    throw new ConflictError(
      `learning 已晋升: ${id}（promoted_at: ${found.learning.promoted_at}）`,
      {
        hint: '条目已晋升过，产物已生成；如需重新生成，先删除目标文件（custom/ 或 skills/ 下同名项），并把该条目 YAML 的 promoted 改回 false',
        details: { id, promotedAt: found.learning.promoted_at },
      },
    );
  }

  // 可重试性保障：前置校验（目标冲突）→ 写产物 → 最后写 promoted 标记。
  // 任一步失败时条目仍为 promoted:false，用户处理掉冲突/权限问题后可直接重跑。
  const targetFile = resolveTargetFile(targetSoTRoot, found.learning);
  await assertTargetWritable(host, found.learning, targetFile);
  await writePromoteArtifact(host, targetSoTRoot, found.learning, targetFile);

  const now = host.now().toISOString();
  const promoted: Learning = LearningSchema.parse({
    ...found.learning,
    promoted: true,
    promoted_at: now,
    updated_at: now,
  });
  await atomicWrite(host, learningFilePath(found.sotRoot, id), serializeYamlDoc(promoted));

  return {
    learning: promoted,
    fromScope: found.scope,
    targetScope,
    targetSoTRoot,
    targetFile,
  };
}
