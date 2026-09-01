/**
 * 探测快照的类型面（DetectedSnapshot 及其分项、DetectContext、DetectionSource）。
 *
 * 单独成文件的理由：engine（编排）、probes-runtime（java/dotnet）、probes-workspace
 * （monorepo/ci）三方都要引用这些类型，若继续留在 engine 里，判定模块就得反向 import
 * 编排层，形成（哪怕只是类型的）依赖环。engine 原样 re-export 全部类型，
 * `core/detector/engine` 这个 import 路径对外不变。
 */
import type { Host } from '../../infra/host';
import type { EnvSnapshot } from '../env';
import type { ShellName } from './probes';

/**
 * 探测结论来源。
 *
 * - `path`：PATH 上扫到可执行文件；
 * - `version-file`：版本文件线索（`.node-version` / `.java-version` / `.sdkmanrc` /
 *   `global.json` 等「钉版本」的文件）；
 * - `package.json` / `pyproject`：生态自有的声明位；
 * - `config-file`：工具/服务的配置文件或目录存在（monorepo 配置、CI 流水线定义）；
 * - `env`：只能靠环境变量判断（sdkman 的 `sdk` 是 shell 函数，PATH 上没有本体）；
 * - `none`：无任何线索。
 */
export type DetectionSource =
  | 'path'
  | 'version-file'
  | 'package.json'
  | 'pyproject'
  | 'config-file'
  | 'env'
  | 'none';

export interface DetectContext {
  readonly host: Host;
  /** 宿主平台（process.platform：'win32' | 'darwin' | 'linux' | ...）。 */
  readonly os: string;
  /** 探测基准目录（版本文件 / 规则文件相对此解析）。 */
  readonly cwd: string;
  /** AgentForge 环境快照（预留：未来 doctor / offline 场景使用）。 */
  readonly env: EnvSnapshot;
}

/** node / python / java / dotnet 探测结论（manager + 版本文件交叉出的 version）。 */
export interface DetectedRuntime {
  readonly manager: string;
  readonly source: DetectionSource;
  readonly version?: string;
  readonly path?: string;
}

/**
 * 工具形态的探测结论（rust / go / monorepo / ci 共用）。
 *
 * `manager` 对 rust/go 是版本管理器，对 monorepo 是工具名（`nx` / `turbo` ...），
 * 对 ci 是提供方（`github-actions` / `gitlab-ci` ...）——都是「谁在管这件事」的答案，
 * 故不为后两类另立形状，命令层与 `--json` 消费方也就不用多认两种结构。
 */
export interface DetectedTool {
  readonly manager: string;
  readonly source: DetectionSource;
  readonly path?: string;
}

/** 包管理器探测结论（数组按优先级排列，package.json 声明置首）。 */
export interface DetectedPackageManager {
  readonly name: string;
  readonly source: 'path' | 'package.json';
  readonly path?: string;
}

/** habits.detected 快照（Spec §4.1 passthrough 结构；JSON 序列化即落盘形态）。 */
export interface DetectedSnapshot {
  readonly node: DetectedRuntime;
  readonly python: DetectedRuntime;
  readonly package_managers: readonly DetectedPackageManager[];
  readonly shell: ShellName;
  readonly existing_rules: readonly string[];
  readonly rust: DetectedTool;
  readonly go: DetectedTool;
  readonly java: DetectedRuntime;
  readonly dotnet: DetectedRuntime;
  readonly monorepo: DetectedTool;
  readonly ci: DetectedTool;
}
