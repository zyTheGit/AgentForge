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
 */
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { Host } from '../../infra/host';
import { atomicWrite, mkdirp } from '../../infra/fsutil';
import type { EnvSnapshot } from '../env';
import { ConfigError, ConflictError } from '../errors';
import { resolveProjectSoT, resolveUserSoT, type OsContext } from '../paths';
import { HABITS_FILE, loadHabits } from '../config/load';
import { LearningSchema, type HabitsInput, type Learning } from '../../schema';
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
 * habits.yaml 不存在时创建最小骨架（version + detected）。
 */
async function appendPromoteNote(
  host: Host,
  sotRoot: string,
  learning: Learning,
): Promise<string> {
  const habitsFile = path.join(sotRoot, HABITS_FILE);
  const existing = await loadHabits(host, sotRoot);
  const habits: HabitsInput = existing ?? { version: 1, detected: {} };
  const detected = { ...(habits.detected ?? {}) };
  const notes = Array.isArray(detected.promote_notes) ? [...detected.promote_notes] : [];
  notes.push(`${learning.id}: ${learning.content.replace(/\s+/g, ' ').trim()}`);
  detected.promote_notes = notes;
  habits.detected = detected;

  const text = stringifyYaml(habits, { lineWidth: 0 });
  await atomicWrite(host, habitsFile, text.endsWith('\n') ? text : `${text}\n`);
  return habitsFile;
}

/**
 * 晋升一条 learning（§7.5）。
 *
 * @throws ConfigError(2) id 两层均不存在 / learning 文件损坏；
 * @throws ConflictError(3) 目标文件已存在 / 条目已 promoted；
 * @throws PermissionError(4) 写入失败（atomicWrite 映射）。
 */
export async function promoteLearning(
  ctx: PromoteContext,
  id: string,
  opts: PromoteOptions = {},
): Promise<PromoteResult> {
  const { host, env, os, cwd } = ctx;
  const userSoTRoot = resolveUserSoT(env, os);
  const projectSoTRoot = resolveProjectSoT(cwd, os);

  const found = await findLearning(host, userSoTRoot, projectSoTRoot, id);
  if (found === null) {
    throw new ConfigError(`learning 不存在: ${id}`, {
      hint: '运行 aforge learnings list 查看全部条目',
      details: { id, userSoTRoot, projectSoTRoot },
    });
  }

  if (found.learning.promoted) {
    throw new ConflictError(`learning 已晋升: ${id}（promoted_at: ${found.learning.promoted_at}）`, {
      hint: '条目已晋升过；如需重新生成产物，先删除目标文件（custom/ 或 skills/ 下同名项）',
      details: { id, promotedAt: found.learning.promoted_at },
    });
  }

  // 目标层：--to user 显式指定；默认 = learning 所在层
  const targetScope: 'user' | 'project' = opts.to === 'user' ? 'user' : found.scope;
  const targetSoTRoot = targetScope === 'project' ? projectSoTRoot : userSoTRoot;

  let targetFile: string;
  switch (found.learning.promote_target) {
    case 'custom_rule': {
      targetFile = path.join(targetSoTRoot, 'custom', `${id}.md`);
      if (await host.exists(targetFile)) {
        throw new ConflictError(`promote 目标文件已存在: ${targetFile}`, {
          hint: '手动确认内容后删除该文件，或修改 learning 的 promote_target 后重试',
          details: { id, targetFile },
        });
      }
      await mkdirp(host, path.dirname(targetFile));
      await atomicWrite(host, targetFile, found.learning.content);
      break;
    }
    case 'skill': {
      targetFile = path.join(targetSoTRoot, 'skills', id, 'SKILL.md');
      if (await host.exists(targetFile)) {
        throw new ConflictError(`promote 目标文件已存在: ${targetFile}`, {
          hint: '手动确认内容后删除该目录，或修改 learning 的 promote_target 后重试',
          details: { id, targetFile },
        });
      }
      await mkdirp(host, path.dirname(targetFile));
      await atomicWrite(host, targetFile, found.learning.content);
      break;
    }
    case 'habits_note': {
      targetFile = await appendPromoteNote(host, targetSoTRoot, found.learning);
      break;
    }
  }

  // 标记 promoted（条目保留在原层，§7.5"不自动删除"）
  const now = host.now().toISOString();
  const promoted: Learning = LearningSchema.parse({
    ...found.learning,
    promoted: true,
    promoted_at: now,
    updated_at: now,
  });
  const yamlText = stringifyYaml(promoted, { lineWidth: 0 });
  await atomicWrite(
    host,
    learningFilePath(found.sotRoot, id),
    yamlText.endsWith('\n') ? yamlText : `${yamlText}\n`,
  );

  return {
    learning: promoted,
    fromScope: found.scope,
    targetScope,
    targetSoTRoot,
    targetFile,
  };
}
