/**
 * 交互 init 取消时的残留产物清单：累加、挂到错误上、取回、格式化成提示文案。
 *
 * 为什么单独成模块：这组函数的唯一职责是在 CancelledError 上搬运一份「磁盘上还
 * 留下了什么」的清单——生产方是交互流程（init-interactive），消费方是命令层的打印
 * 分支（init.ts）。两侧都要用它，它只依赖 infra/ui 做上色；放在中间层让交互层与命令层
 * 保持单向依赖不成环，也让「清单挂载属性名」这个跨模块契约只有一个定义点。
 */
import { getUi, type Ui } from '../../infra/ui';

/**
 * 交互 init 被取消时的磁盘产物清单。
 *
 * 两种取消处置由 `committed` 区分——这是本模块存在的核心信息，缺了它命令层无从
 * 判断该劝用户删还是劝用户接着用：
 * - `committed: false`（写入确认之前取消）：③ edit 分支已落的 habits.yaml 与子目录
 *   会被回滚（rollbackOnCancel），清单是**回滚后仍残留**的项，常态为空。不回滚则
 *   SoT 根非空，重跑 `aforge init` 必被 resolveFreshSoTRoot 判为「目录非空」→
 *   ConfigError(2)，用户只能手删；交互已是默认模式，这条路径命中全部终端用户。
 * - `committed: true`（写入确认之后、在「立即 sync？」处取消）：habits.yaml 与
 *   profile.yaml 已原子写成功，SoT 是**有效已初始化**状态，清单是这批产物，绝不
 *   回滚——删掉用户刚确认写下的配置比留着糟得多。
 *
 * prompt 抛出的 CancelledError 只带退出码 130，故由 runInitInteractive 把清单挂到
 * 错误上回传。
 */
export interface CancelledInitArtifacts {
  readonly createdFiles: readonly string[];
  readonly createdDirs: readonly string[];
  /** true = 已写入的有效 SoT（未回滚）；false = 回滚后的残留。 */
  readonly committed: boolean;
}

/** CancelledError 上承载清单的属性名（普通属性：跨 bundle 边界安全，同 isCancelledError 的取舍）。 */
const CANCELLED_ARTIFACTS_PROP = 'agfInitArtifacts';

/** 累加中的产物清单（仅 runInitInteractive 内部可变；对外暴露为只读形态）。 */
export interface MutableInitArtifacts {
  readonly createdFiles: string[];
  readonly createdDirs: string[];
  /**
   * 写入确认之后的落盘是否已成功（第⑤步 materializeSoT 返回即置 true）。
   *
   * 取消处置的分水岭：true 之后取消不得回滚（见 CancelledInitArtifacts.committed）。
   * 刻意做成可变字段而不是另传一个布尔——它与两个清单必须同时更新、同时读取，拆开
   * 传就会出现「清单已累加但标志没跟上」的中间态。
   */
  committed: boolean;
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
  const { createdFiles, createdDirs, committed } = raw as Partial<CancelledInitArtifacts>;
  if (!Array.isArray(createdFiles) || !Array.isArray(createdDirs)) {
    return undefined;
  }
  // committed 缺失按 false（更安全的一侧：提示用户清理，而不是让他以为 SoT 可用）
  return { createdFiles, createdDirs, committed: committed === true };
}

/**
 * 取消提示文案（命令层打印）。三种形态与 CancelledInitArtifacts.committed 一一对应：
 * 已写入的有效 SoT / 回滚干净 / 回滚后仍有残留。
 *
 * 路径与提示分行输出，便于用户直接复制路径。
 */
export function formatCancelledInitArtifacts(
  artifacts: CancelledInitArtifacts | undefined,
  ui: Ui = getUi(),
): string[] {
  const files = artifacts?.createdFiles ?? [];
  const dirs = artifacts?.createdDirs ?? [];
  if (artifacts?.committed === true) {
    return [
      ui.yellow('aforge init - cancelled at the sync prompt; the SoT is already written:'),
      ...files.map((file) => `created file: ${ui.path(file)}`),
      ...dirs.map((dir) => `created dir: ${ui.path(dir)}`),
      '',
      ui.next(`run ${ui.code('aforge sync')} to project rules to agent targets`),
    ];
  }
  if (files.length === 0 && dirs.length === 0) {
    return [ui.yellow('aforge init - cancelled: rolled back, nothing was written')];
  }
  return [
    ui.red('aforge init - cancelled; rollback left the following on disk:'),
    ...files.map((file) => `leftover file: ${ui.path(file)}`),
    ...dirs.map((dir) => `leftover dir: ${ui.path(dir)}`),
    '',
    // 不写"或重新运行 init 继续"：残留使 SoT 根非空，重跑 init 会在
    // resolveFreshSoTRoot 直接抛 ConfigError(2)。
    ui.red('必须先删除以上残留，才能重新运行 aforge init'),
  ];
}
