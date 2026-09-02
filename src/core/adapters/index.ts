/**
 * 声明式适配器层的汇总导出（Phase 3 第二层，issue #53）。
 *
 * 模块划分（本文件只做再导出，不放实现）：
 * - `limits`：数量上限与环境变量白名单（零 import 的常量叶子）；
 * - `diagnostics`：加载报告的类型 + 进程级存放处 + 「未注册 target id」的诊断文案
 *   （零 import 的叶子——`schema/profile` 要用它，不能反向依赖 core/adapters）；
 * - `templates`：路径模板的语法/白名单校验与求值（纯计算）；
 * - `containment`：允许根的组装、纯路径 containment 判定、symlink 逃逸判定；
 * - `resolve`：把 AdapterDoc 的模板解析一次，并按运行时绑定求值成绝对落点；
 * - `projector`：由已解析的适配器造 `Projector`（产出 ProjectionPlan）；
 * - `discovery`：扫描两层 `adapters/*.yaml`，读 + 解析 + 静态校验（不抛异常）；
 * - `loader`：注册进 projector 注册表与 profile 取值域，产出报告；
 * - `gate`：sync 侧的 fail-fast 闸门（只拦装配冲突）。
 */
export {
  AdapterContainmentError,
  type AllowedRoots,
  assertNoSymlinkEscape,
  assertWithinAllowedRoots,
  buildAllowedRoots,
} from './containment';
export {
  type AdapterFailureKind,
  type AdapterIgnored,
  type AdapterLayer,
  type AdapterLoaded,
  type AdapterLoadFailure,
  type AdapterLoadReport,
  adapterFailureExitCode,
  adapterLoadReport,
  describeAdapterFailureKind,
  describeUnknownTargetId,
  resetAdapterLoadReport,
  setAdapterLoadReport,
} from './diagnostics';
export { type AdapterDiscoveryResult, discoverAdapters } from './discovery';
export { assertNoAdapterAssemblyConflicts } from './gate';
export {
  ADAPTER_ALLOW_PROJECT_ENV,
  ADAPTER_ENV_WHITELIST,
  ADAPTER_MAX_FILES_PER_LAYER,
  ADAPTER_MAX_PATH_DEPTH,
  ADAPTER_MAX_PLAN_ITEMS,
  ADAPTERS_DIRNAME,
} from './limits';
export {
  type LoadDeclarativeAdaptersOptions,
  loadDeclarativeAdapters,
  resetDeclarativeAdapterState,
} from './loader';
export { adapterMcpPayload, buildDeclarativeProjector } from './projector';
export {
  type AdapterRuntime,
  type ParsedAdapterScope,
  parseAdapterScopes,
  type ResolvedAdapterScope,
  resolveAdapterScope,
} from './resolve';
export {
  AdapterTemplateError,
  type ParsedPathTemplate,
  parsePathTemplate,
  renderBase,
  renderPathTemplate,
  type TemplateBindings,
} from './templates';
