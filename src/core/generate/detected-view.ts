/**
 * `habits.detected` → 渲染视图（内置 `base/context` 的唯一数据源，Spec §4.1 / §5.1）。
 *
 * 为什么 detected 能进渲染层：它是**落在 SoT 里的持久快照**（`aforge init` /
 * `aforge detect` 写入 habits.yaml），不是渲染时读环境得到的现场信息。同一份
 * habits.yaml 在 CI 与本机渲染出的正文因此字节一致，`doctor` 的 contentHash 比对
 * 依旧成立——这与「模板拿不到 OS / 环境变量 / CI」那条约束不冲突（见 docs/rules.md）。
 *
 * 为什么单独成文件：composer 已承担装配 + 声明侧视图两件事，detected 的**防御式收窄**
 * （schema 侧是 `z.looseObject({})`，值可以是任意 JSON）自带一批窄化 helper，
 * 放进 composer 会把它推到 500 行卡口边上（Spec §11.3）。
 *
 * 收窄口径（探测器写出的形状见 core/detector/types.ts 的 DetectedSnapshot）：
 * - 只认本文件白名单里的键，未知键一律忽略——detected 是 passthrough，
 *   用户手写的任意键不该被当成探测结论渲染出去；
 * - 值不是期望类型（用户手改坏、旧版本遗留）→ 当作「没探到」静默省略，不抛错：
 *   渲染路径上抛错等于让一段参考信息把整个 `sync` 拖挂；
 * - `manager` 为 `'none'` / 空串 → 整条省略（与声明侧 visibleRuntime 同口径）。
 */

/** 探测到的语言运行时条目（label 是固定展示名，不是用户工具名）。 */
export interface DetectedRuntimeView {
  /** 展示名（`Node` / `Python` / …，本模块常量，非用户输入）。 */
  readonly label: string;
  /** 探测到的管理器 / 工具名。 */
  readonly manager: string;
  readonly version?: string;
  /** 结论来源（`path` / `version-file` / …；`none` 归一为省略）。 */
  readonly source?: string;
}

/** 探测到的工具条目（monorepo / CI：只有「谁在管这件事」+ 来源）。 */
export interface DetectedToolView {
  readonly manager: string;
  readonly source?: string;
}

/** detected 快照的渲染视图。 */
export interface DetectedView {
  /** 语言运行时（按 RUNTIME_LABELS 顺序，未探到的不出现）。 */
  readonly runtimes?: readonly DetectedRuntimeView[];
  /** JS 包管理器名（按探测顺序）。 */
  readonly package_managers?: readonly string[];
  readonly monorepo?: DetectedToolView;
  readonly ci?: DetectedToolView;
  /** 派生：Project Context 节可见性（上面任一条存在）。 */
  readonly has_any: boolean;
}

/**
 * 参与渲染的运行时键与展示名。
 *
 * java / dotnet 在这里出现，正是 docs/direction-review.md §2.2 那条探测器冻结的
 * 解锁点：它们此前只写 detected、没有任何渲染出口。
 */
const RUNTIME_LABELS: readonly (readonly [key: string, label: string])[] = [
  ['node', 'Node'],
  ['python', 'Python'],
  ['java', 'Java'],
  ['dotnet', '.NET'],
  ['rust', 'Rust'],
  ['go', 'Go'],
];

/** 非空且非 `'none'` 的字符串，否则 undefined（`'none'` 是探测器的「没探到」哨兵）。 */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'none' ? undefined : trimmed;
}

/** 收窄成普通对象（数组与 null 都不算）。 */
function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** `{ manager, source }` 形态的条目（manager 缺失 / 为 none → 整条省略）。 */
function toolEntry(value: unknown): DetectedToolView | undefined {
  const obj = record(value);
  const manager = text(obj?.manager);
  if (manager === undefined) {
    return undefined;
  }
  return { manager, source: text(obj?.source) };
}

/** 运行时条目（在 toolEntry 之上多带一个 version）。 */
function runtimeEntry(label: string, value: unknown): DetectedRuntimeView | undefined {
  const entry = toolEntry(value);
  if (entry === undefined) {
    return undefined;
  }
  return { label, ...entry, version: text(record(value)?.version) };
}

/**
 * 包管理器名列表。
 *
 * 兼容两种形态：探测器写的 `[{ name, source }]`，以及有人手写成 `['pnpm']`
 * 的裸字符串数组——两者语义相同，没必要因为形状差异就丢掉这行上下文。
 */
function packageManagers(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const names: string[] = [];
  for (const item of value) {
    const name = typeof item === 'string' ? text(item) : text(record(item)?.name);
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names.length === 0 ? undefined : names;
}

/**
 * detected 快照 → 渲染视图。
 *
 * @param detected `habits.detected`（passthrough 对象；任意形状都不抛错）。
 */
export function buildDetectedView(detected: Record<string, unknown>): DetectedView {
  const runtimes: DetectedRuntimeView[] = [];
  for (const [key, label] of RUNTIME_LABELS) {
    const entry = runtimeEntry(label, detected[key]);
    if (entry !== undefined) {
      runtimes.push(entry);
    }
  }
  const pkgs = packageManagers(detected.package_managers);
  const monorepo = toolEntry(detected.monorepo);
  const ci = toolEntry(detected.ci);
  return {
    runtimes: runtimes.length === 0 ? undefined : runtimes,
    package_managers: pkgs,
    monorepo,
    ci,
    has_any:
      runtimes.length > 0 || pkgs !== undefined || monorepo !== undefined || ci !== undefined,
  };
}
