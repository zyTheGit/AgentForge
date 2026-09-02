/**
 * 声明式适配器的**加载与注册**（issue #53）：发现 → 校验 → 注册进 projector 注册表。
 *
 * 调用时机：CLI 装配阶段（`cli.runCli`）**一次**，在任何命令 action 之前。必须在
 * 这么早：`profile.yaml` 的 `targets` 取值域（`schema/profile.TargetEnum`）与
 * `--targets` 校验（`sync-prepare.filterTargets`）都要看到已注册的第三方 id。
 *
 * 注册进两处（一次调用写两边，不存在「注册了却写不进 profile」的分叉）：
 * - `projectorRegistry`：运行时 target 全集（`--targets` / engine / doctor / status）；
 * - `core/project/target-ids` 的声明式 id 表：`profile.yaml` 的取值域。
 *
 * 本函数**不抛异常**（除编程错误）：全部失败进报告。`aforge doctor` 必须在适配器
 * 坏掉时把它报成一条 error 并跑完其余检查；`aforge sync` 的 fail-fast 由 ./gate 做。
 */
import type { Host } from '../../infra/host';
import type { EnvSnapshot } from '../env';
import { type OsContext, pathApiFor, resolveProjectSoT, resolveUserSoT } from '../paths';
import { projectorRegistry } from '../project/projectors/registry';
import { registerDeclarativeTargetId, resetDeclarativeTargetIds } from '../project/target-ids';
import type { Projector } from '../project/types';
import type { Registry } from '../registry';
import { assertNoSymlinkEscape } from './containment';
import {
  type AdapterLoaded,
  type AdapterLoadFailure,
  type AdapterLoadReport,
  setAdapterLoadReport,
} from './diagnostics';
import { type DiscoveredAdapter, discoverAdapters } from './discovery';
import {
  ADAPTER_ALLOW_PROJECT_ENV,
  ADAPTER_ENV_WHITELIST,
  ADAPTERS_DIRNAME,
  type AdapterEnvName,
} from './limits';
import { buildDeclarativeProjector } from './projector';
import { type AdapterRuntime, resolveAdapterScope } from './resolve';

export interface LoadDeclarativeAdaptersOptions {
  readonly host: Host;
  readonly env: EnvSnapshot;
  readonly os: OsContext;
  /** 当前工作目录（= project scope 的投影基准）。 */
  readonly cwd: string;
  /**
   * 注册目标（缺省 = 全局 `projectorRegistry`）。
   *
   * 可注入是为了测试：`Registry` 刻意没有 unregister（重复注册即编码错误），
   * 所以同一个 spec 文件里要跑多轮加载只能换容器。生产恒用全局单例。
   */
  readonly registry?: Registry<Projector>;
}

/** 读取白名单环境变量的当前取值（plan 是纯函数，环境只在这里读一次）。 */
function readWhitelistedEnv(host: Host): Readonly<Partial<Record<AdapterEnvName, string>>> {
  const values: Partial<Record<AdapterEnvName, string>> = {};
  for (const name of ADAPTER_ENV_WHITELIST) {
    const raw = host.env(name)?.trim();
    if (raw !== undefined && raw !== '') {
      values[name] = raw;
    }
  }
  return values;
}

/** 用户级 SoT 根（不可解析——无用户目录 / UNC AGF_HOME——时按「没有 user 层」处理）。 */
function tryResolveUserSoT(env: EnvSnapshot, os: OsContext): string | undefined {
  try {
    return resolveUserSoT(env, os);
  } catch {
    return undefined;
  }
}

/**
 * 落点全量校验：两个 scope 各自求值（纯路径 containment）+ symlink 逃逸校验。
 *
 * symlink 只在这里查一次（要读 fs），plan 阶段只做纯路径判定——落点路径上的
 * symlink 结构在一次 sync 期间不会变，而 plan 会被调用很多次。
 *
 * @returns 校验失败的原因（成功 → undefined）。
 */
async function verifyLandingSites(
  host: Host,
  runtime: AdapterRuntime,
  os: OsContext,
): Promise<{ kind: 'containment' | 'template'; message: string; hint: string } | undefined> {
  const api = pathApiFor(os);
  for (const scope of ['project', 'user'] as const) {
    if (runtime.scopes[scope] === undefined) {
      continue;
    }
    const rootDir = scope === 'project' ? runtime.projectRoot : runtime.userHome;
    if (rootDir === undefined || rootDir === '') {
      // user scope 声明了但当前环境取不到用户目录：不是适配器的错，跳过该 scope 的
      // 预校验（真到投影时 engine 侧的 requireUserProfileForProjection 会报）
      continue;
    }
    try {
      const resolved = resolveAdapterScope(runtime, scope, rootDir, os, api);
      if (resolved === undefined) {
        continue;
      }
      const sites = [
        resolved.base,
        resolved.skillsDir,
        resolved.mainRule,
        resolved.commandsDir,
        resolved.mcpFile,
      ].filter((site): site is string => site !== undefined);
      for (const site of sites) {
        await assertNoSymlinkEscape(
          host,
          site,
          resolved.allowed,
          os,
          api,
          `${runtime.doc.id}.${scope}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint =
        err instanceof Error && 'hint' in err && typeof err.hint === 'string'
          ? err.hint
          : '检查该 scope 的 base 与各落点模板';
      const kind =
        err instanceof Error && err.name === 'AdapterTemplateError' ? 'template' : 'containment';
      return { kind, message, hint };
    }
  }
  return undefined;
}

/** 造 runtime（把加载时刻的根目录与环境快照钉进去，plan 从此不再读环境）。 */
function toRuntime(
  candidate: DiscoveredAdapter,
  projectRoot: string,
  userHome: string | undefined,
  envValues: Readonly<Partial<Record<AdapterEnvName, string>>>,
): AdapterRuntime {
  return {
    doc: candidate.doc,
    file: candidate.file,
    layer: candidate.layer,
    projectRoot,
    userHome,
    envValues,
    scopes: candidate.scopes,
  };
}

/**
 * 加载并注册全部声明式适配器。
 *
 * **契约：永不抛异常。** 调用点是 CLI 装配阶段，在那里抛异常会让每一条命令
 * （包括最需要它的 `aforge doctor`）都起不来。意外错误也折叠成一条 `io` 失败进报告。
 *
 * @returns 本次加载报告（同时写进 core/adapters/diagnostics 的进程级单例）。
 */
export async function loadDeclarativeAdapters(
  opts: LoadDeclarativeAdaptersOptions,
): Promise<AdapterLoadReport> {
  let report: AdapterLoadReport;
  try {
    report = await loadAll(opts);
  } catch (err) {
    report = {
      loaded: [],
      ignored: [],
      failures: [
        {
          id: '(all)',
          file: `<${ADAPTERS_DIRNAME}>`,
          layer: 'user',
          kind: 'io',
          message: `适配器加载过程异常中断: ${err instanceof Error ? err.message : String(err)}`,
          hint: '这属于内部错误，请带上 aforge doctor --json 的输出提 issue',
        },
      ],
      scanned: [],
    };
  }
  setAdapterLoadReport(report);
  return report;
}

async function loadAll(opts: LoadDeclarativeAdaptersOptions): Promise<AdapterLoadReport> {
  const { host, env, os, cwd } = opts;
  const registry = opts.registry ?? projectorRegistry;
  const userSoTRoot = tryResolveUserSoT(env, os);
  const projectSoTRoot = resolveProjectSoT(cwd, os);
  const allowProject = host.env(ADAPTER_ALLOW_PROJECT_ENV)?.trim() === '1';
  const envValues = readWhitelistedEnv(host);

  const discovery = await discoverAdapters({
    host,
    userSoTRoot,
    projectSoTRoot,
    allowProject,
  });

  const failures: AdapterLoadFailure[] = [...discovery.failures];
  const loaded: AdapterLoaded[] = [];

  for (const candidate of discovery.candidates) {
    const runtime = toRuntime(candidate, cwd, env.userProfile, envValues);
    const problem = await verifyLandingSites(host, runtime, os);
    if (problem !== undefined) {
      failures.push({
        id: candidate.id,
        file: candidate.file,
        layer: candidate.layer,
        kind: problem.kind,
        message: problem.message,
        hint: problem.hint,
      });
      continue;
    }
    try {
      const projector = buildDeclarativeProjector(runtime);
      registry.register(candidate.id, () => projector);
    } catch (err) {
      // Registry 对重复 id 抛 GenericError(1)：复用它的语义，归 duplicate-id
      failures.push({
        id: candidate.id,
        file: candidate.file,
        layer: candidate.layer,
        kind: 'duplicate-id',
        message: err instanceof Error ? err.message : String(err),
        hint: '换一个 id——同一个 target id 只能有一个 projector',
      });
      continue;
    }
    registerDeclarativeTargetId(candidate.id);
    loaded.push({ id: candidate.id, file: candidate.file, layer: candidate.layer });
  }

  return {
    loaded,
    ignored: discovery.ignored,
    failures,
    scanned: discovery.scanned,
  };
}

/**
 * 复位声明式 target id 表与报告（**测试用**）。
 *
 * 注意它不会把 projector 从注册表里摘掉——`Registry` 没有 unregister（重复注册即
 * 编码错误，见 core/registry 的 JSDoc）。同一 spec 文件里跑多轮加载请用
 * `registry` 注入一个新容器。
 */
export function resetDeclarativeAdapterState(): void {
  resetDeclarativeTargetIds();
  setAdapterLoadReport({ loaded: [], ignored: [], failures: [], scanned: [] });
}
