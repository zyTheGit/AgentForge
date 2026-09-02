/**
 * 声明式适配器的加载诊断（Phase 3 第二层，issue #53）——**零 import 的叶子模块**。
 *
 * 为什么必须是叶子：`schema/profile` 的 `TargetEnum` 要在「profile.yaml 里写了一个
 * 未注册的 target id」时给出能区分成因的提示（打错了 / 适配器文件坏了 / project 层
 * 被忽略），而适配器的加载链路（`core/adapters/loader` → `schema/adapter` →
 * `schema/index` → `schema/profile`）反向依赖 schema。把「报告的类型 + 存放处 +
 * 提示文案」放在一个不 import 任何东西的叶子上，两侧都能取，且不成环。
 *
 * 报告是**进程级单例**：加载在 CLI 装配阶段发生一次（`cli.runCli`），此后
 * schema 校验、doctor、status 都读同一份。测试用 `resetAdapterLoadReport()` 复位。
 *
 * 关键设计：加载失败**不抛异常**。`aforge doctor` 必须在适配器坏掉时仍跑完其余
 * 几十项检查（PR #59 的教训：一条 ConfigError 冒到 runDoctorChecks 之外，把整份
 * 报告一起带走）。因此加载阶段只**收集**失败，由各命令自行决定处置：
 * - `sync` 读报告后 fail-fast（见 core/adapters/gate）；
 * - `doctor` 把每条失败报成一条 error 条目并继续。
 */

/** 适配器文件所在的 SoT 层。 */
export type AdapterLayer = 'user' | 'project';

/**
 * 加载失败的成因分类（决定退出码归属与提示文案，两者都不能糊成一句「加载失败」）。
 *
 * - `io`：文件读不出来（权限 / 被独占打开）；
 * - `yaml`：YAML 语法错误；
 * - `schema`：结构/枚举校验失败（含 `action: merge_toml` 这类不开放的取值）；
 * - `id-mismatch`：文件名与 `id` 字段不一致（发现来源必须可由文件名唯一定位）；
 * - `builtin-id`：`id` 撞内置 target id；
 * - `duplicate-id`：`id` 撞另一个已加载的适配器；
 * - `template`：路径模板非法（未白名单变量 / 自由绝对路径 / `..` 段 / 深度超限）；
 * - `containment`：模板解析后越界（盘符跳变 / UNC / symlink 逃逸 / 落在白名单根之外）；
 * - `limit`：超出数量上限（适配器文件数 / 单适配器产物数）。
 *
 * `builtin-id` / `duplicate-id` 归**退出码 1**（复用 Registry 的 GenericError 语义：
 * 这是装配冲突而非用户配置内容错误）；其余归退出码 2。
 */
export type AdapterFailureKind =
  | 'io'
  | 'yaml'
  | 'schema'
  | 'id-mismatch'
  | 'builtin-id'
  | 'duplicate-id'
  | 'template'
  | 'containment'
  | 'limit';

/** 单条加载失败。 */
export interface AdapterLoadFailure {
  /** 由**文件名**推导的 id（yaml 内 id 可能与它不同，见 `id-mismatch`）。 */
  readonly id: string;
  /** 适配器文件绝对路径。 */
  readonly file: string;
  readonly layer: AdapterLayer;
  readonly kind: AdapterFailureKind;
  /** 人类可读原因（已含足够定位信息，可直接进 doctor 的 detail）。 */
  readonly message: string;
  /** 可操作的修复建议。 */
  readonly hint: string;
}

/** 被忽略的适配器（project 层默认不加载，见 docs/profile.md 的安全边界一节）。 */
export interface AdapterIgnored {
  readonly id: string;
  readonly file: string;
  /** 目前只有 project 层会被忽略（user 层是用户自己的主目录，恒加载）。 */
  readonly layer: 'project';
  readonly reason: 'project-layer-not-authorized';
}

/** 成功加载并注册的适配器。 */
export interface AdapterLoaded {
  readonly id: string;
  readonly file: string;
  readonly layer: AdapterLayer;
}

/** 一次加载的完整结果（doctor / status / schema 提示共用同一份事实）。 */
export interface AdapterLoadReport {
  readonly loaded: readonly AdapterLoaded[];
  readonly ignored: readonly AdapterIgnored[];
  readonly failures: readonly AdapterLoadFailure[];
  /** 扫过的 `adapters/` 目录绝对路径（不存在的也列出，便于用户确认放对了位置）。 */
  readonly scanned: readonly string[];
}

/** 空报告（未加载过 / 已复位时的取值；恒返回同一个不可变对象）。 */
const EMPTY_REPORT: AdapterLoadReport = {
  loaded: [],
  ignored: [],
  failures: [],
  scanned: [],
};

let current: AdapterLoadReport = EMPTY_REPORT;

/** 记录本进程的适配器加载报告（由 core/adapters/loader 在加载结束时调用一次）。 */
export function setAdapterLoadReport(report: AdapterLoadReport): void {
  current = report;
}

/** 读取本进程的适配器加载报告（未加载过 → 空报告，不是 undefined）。 */
export function adapterLoadReport(): AdapterLoadReport {
  return current;
}

/** 复位（测试用；生产路径只在进程启动时写一次）。 */
export function resetAdapterLoadReport(): void {
  current = EMPTY_REPORT;
}

/** 失败分类 → 退出码（1 = 装配冲突，2 = 配置内容错误）。 */
export function adapterFailureExitCode(kind: AdapterFailureKind): 1 | 2 {
  return kind === 'builtin-id' || kind === 'duplicate-id' ? 1 : 2;
}

/** 失败分类 → 面向用户的一句话归类（doctor detail 与 schema 提示共用）。 */
export function describeAdapterFailureKind(kind: AdapterFailureKind): string {
  switch (kind) {
    case 'io':
      return '适配器文件读不出来';
    case 'yaml':
      return '适配器文件 YAML 解析失败';
    case 'schema':
      return '适配器文件 schema 校验失败';
    case 'id-mismatch':
      return '适配器文件名与 id 字段不一致';
    case 'builtin-id':
      return '适配器 id 撞内置 target id';
    case 'duplicate-id':
      return '适配器 id 与另一个已加载的适配器重复';
    case 'template':
      return '适配器路径模板非法';
    case 'containment':
      return '适配器路径解析后越出允许的根目录';
    case 'limit':
      return '适配器超出数量上限';
    default:
      return '适配器加载失败';
  }
}

/** 单个字符的编辑距离上限内是否"像"（只做长度差 + 一次编辑的粗判，够拼写纠错用）。 */
function looksLikeTypo(a: string, b: string): boolean {
  if (a === b) {
    return false;
  }
  if (Math.abs(a.length - b.length) > 1) {
    return false;
  }
  // 经典 O(n) 单次编辑判定：至多一处增/删/改
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) {
      return false;
    }
    if (a.length > b.length) {
      i += 1;
    } else if (a.length < b.length) {
      j += 1;
    } else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * 「profile.yaml 写了一个未注册的 target id」的诊断文案。
 *
 * 这条提示是本层最容易踩坑的地方：同一个症状（schema 拒收）有四类完全不同的成因，
 * 只报「不是有效的 target」会让用户对着一个没问题的 yaml 反复检查。按优先级判：
 *
 * 1. 该 id 的适配器**加载失败**了 → 报具体成因（YAML / schema / 路径越界 / id 冲突）；
 * 2. 该 id 的适配器在 **project 层被忽略** → 报怎么授权（`AGF_ALLOW_PROJECT_ADAPTERS=1`）；
 * 3. 与某个已注册 id **只差一个字符** → 报「是否想写 X」；
 * 4. 都不是 → 报可用取值 + 声明式适配器该放哪。
 *
 * @param id profile.yaml 里写的那个 id。
 * @param knownIds 当前允许写进 profile.yaml 的 id 全集（内置 + 已加载的声明式适配器）。
 */
export function describeUnknownTargetId(id: string, knownIds: readonly string[]): string {
  const report = current;
  const valid = `当前可用: ${knownIds.join(', ')}`;

  const failure = report.failures.find((f) => f.id === id);
  if (failure !== undefined) {
    return `未注册的 target: ${id}——${describeAdapterFailureKind(failure.kind)}（${failure.file}）: ${failure.message}；修好该文件后 ${id} 才能写进 profile.yaml。${valid}`;
  }

  const ignored = report.ignored.find((entry) => entry.id === id);
  if (ignored !== undefined) {
    return `未注册的 target: ${id}——适配器文件存在但位于 project 层，默认被忽略（${ignored.file}）：project 层适配器能声明往用户主目录写文件，git clone 一个仓库不该自动获得这个能力。确认来源可信后设 AGF_ALLOW_PROJECT_ADAPTERS=1 再重试。${valid}`;
  }

  const typo = knownIds.find((known) => looksLikeTypo(id, known));
  if (typo !== undefined) {
    return `未注册的 target: ${id}——是否想写 ${typo}？${valid}`;
  }

  const dirs = report.scanned.length === 0 ? '<userSoT>/adapters/' : report.scanned.join(' / ');
  return `未注册的 target: ${id}——既不是内置 target，也没有对应的声明式适配器文件（已扫描: ${dirs}）。第三方 target 需要在 user 层 SoT 放 adapters/${id}.yaml。${valid}`;
}
