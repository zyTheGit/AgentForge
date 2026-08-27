/**
 * 交互 init 取消时的产物清单：累加、挂到错误上、取回、格式化成提示文案。
 *
 * 为什么单独成模块：这组函数的唯一职责是在 CancelledError 上搬运一份「磁盘上已经
 * 留下了什么」的清单——生产方是交互流程（init-interactive），消费方是命令层的打印
 * 分支（init.ts）。两侧都要用它，它自己零 import；放在中间层让交互层与命令层保持
 * 单向依赖不成环，也让「清单挂载属性名」这个跨模块契约只有一个定义点。
 */

/**
 * 交互 init 被取消时已落盘的产物清单。
 *
 * 为什么需要：`init -i` 的 edit 分支会**先**写 habits.yaml 骨架与全部子目录
 * （见 runInitInteractive 的 ③ edit 分支），此后任一提问处 Ctrl-C 都会留下半
 * 初始化的 SoT。prompt.unwrap 抛出的 CancelledError 只带退出码 130，命令层
 * 无从得知产物，故由 runInitInteractive 把清单挂到错误上回传。
 */
export interface CancelledInitArtifacts {
  readonly createdFiles: readonly string[];
  readonly createdDirs: readonly string[];
}

/** CancelledError 上承载清单的属性名（普通属性：跨 bundle 边界安全，同 isCancelledError 的取舍）。 */
const CANCELLED_ARTIFACTS_PROP = 'agfInitArtifacts';

/** 累加中的产物清单（仅 runInitInteractive 内部可变；对外暴露为只读形态）。 */
export interface MutableInitArtifacts {
  readonly createdFiles: string[];
  readonly createdDirs: string[];
}

/** 记录一次 materializeSoT 成功落盘的产物（去重：edit 分支的子目录会被再次 mkdirp）。 */
export function recordCreated(
  acc: MutableInitArtifacts,
  created: { readonly createdFiles: readonly string[]; readonly createdDirs: readonly string[] },
): void {
  for (const file of created.createdFiles) {
    if (!acc.createdFiles.includes(file)) {
      acc.createdFiles.push(file);
    }
  }
  for (const dir of created.createdDirs) {
    if (!acc.createdDirs.includes(dir)) {
      acc.createdDirs.push(dir);
    }
  }
}

/** 把清单挂到取消错误上（原错误原样重抛，退出码 130 语义不变）。 */
export function attachInitArtifacts(err: unknown, artifacts: CancelledInitArtifacts): unknown {
  if (typeof err === 'object' && err !== null) {
    (err as Record<string, unknown>)[CANCELLED_ARTIFACTS_PROP] = artifacts;
  }
  return err;
}

/** 从取消错误上取回清单（无清单 / 结构不符 → undefined）。@see attachInitArtifacts */
export function extractInitArtifacts(err: unknown): CancelledInitArtifacts | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const raw = (err as Record<string, unknown>)[CANCELLED_ARTIFACTS_PROP];
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const { createdFiles, createdDirs } = raw as Partial<CancelledInitArtifacts>;
  if (!Array.isArray(createdFiles) || !Array.isArray(createdDirs)) {
    return undefined;
  }
  return { createdFiles, createdDirs };
}

/**
 * 取消提示文案（命令层打印；清单为空 → 明确告知 nothing was written）。
 *
 * 产物路径与提示分行输出，便于用户直接复制路径删除。
 */
export function formatCancelledInitArtifacts(
  artifacts: CancelledInitArtifacts | undefined,
): string[] {
  const files = artifacts?.createdFiles ?? [];
  const dirs = artifacts?.createdDirs ?? [];
  if (files.length === 0 && dirs.length === 0) {
    return ['aforge init - cancelled: nothing was written'];
  }
  return [
    'aforge init - cancelled; the following artifacts remain on disk:',
    ...files.map((file) => `created file: ${file}`),
    ...dirs.map((dir) => `created dir: ${dir}`),
    '',
    // 不写"或重新运行 init -i 继续"：③ edit 分支已把 habits.yaml 与子目录落盘，
    // SoT 根非空，重跑 init -i 会在 resolveFreshSoTRoot 直接抛 ConfigError(2)。
    '必须先删除以上内容，才能重新运行 aforge init -i',
  ];
}
