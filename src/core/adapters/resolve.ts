/**
 * 声明式适配器的**模板解析与 scope 求值**（issue #53）。
 *
 * 职责边界：
 * - `parseAdapterScopes`：把 `AdapterDoc` 里的路径模板字符串**一次性**解析成
 *   `ParsedPathTemplate`（语法与白名单校验在此发生，失败即 AdapterTemplateError）。
 *   只在加载阶段跑一次——plan 是每次 sync / doctor / status 都要跑的热路径，
 *   不该反复做正则解析；
 * - `resolveAdapterScope`：把已解析的模板按运行时绑定求值成绝对路径，并逐个过
 *   containment 校验。plan 阶段调用（纯函数、零 IO）。
 *
 * 不在这里做的事：产出 ProjectionPlan（见 ./projector）、读 fs 判 symlink（见
 * ./containment.assertNoSymlinkEscape）。
 */
import type { AdapterDoc, AdapterScope } from '../../schema/adapter';
import type { Scope } from '../env';
import type { OsContext, PathApi } from '../paths';
import { type AllowedRoots, assertWithinAllowedRoots, buildAllowedRoots } from './containment';
import type { AdapterEnvName } from './limits';
import {
  AdapterTemplateError,
  baseCandidatesOf,
  type ParsedPathTemplate,
  parsePathTemplate,
  renderBase,
  renderPathTemplate,
  type TemplateBindings,
} from './templates';

/** 一个 scope 的模板集合（已解析，可反复求值）。 */
export interface ParsedAdapterScope {
  /** base 候选（按声明顺序；取第一个可解析的）。 */
  readonly base: readonly ParsedPathTemplate[];
  /** 缺省（yaml 里没写 `skills_dir`）→ `undefined`；与「写了但解析失败」不是一回事。 */
  readonly skillsDir: ParsedPathTemplate | undefined;
  readonly mainRule: ParsedPathTemplate | undefined;
  readonly commandsDir: ParsedPathTemplate | undefined;
  readonly mcpFile: ParsedPathTemplate | undefined;
}

/** 已解析的适配器（注册进 projectorRegistry 的载体）。 */
export interface AdapterRuntime {
  readonly doc: AdapterDoc;
  /** 适配器文件绝对路径（doctor / status 展示来源）。 */
  readonly file: string;
  readonly layer: 'user' | 'project';
  /**
   * 加载时刻的项目根与用户目录。
   *
   * plan 阶段 `ctx.rootDir` 只给出**当前 scope** 的基准（project scope 是项目根、
   * user scope 是用户目录），另一侧的取值必须来自这里——否则 user scope 的模板里
   * 写 `{projectRoot}` 会解析成用户目录。
   */
  readonly projectRoot: string;
  readonly userHome: string | undefined;
  /** 加载时刻白名单环境变量的取值（plan 是纯函数，不能自己读环境）。 */
  readonly envValues: Readonly<Partial<Record<AdapterEnvName, string>>>;
  readonly scopes: Readonly<Partial<Record<Scope, ParsedAdapterScope>>>;
}

/**
 * 单个落点模板的求值结果。
 *
 * `absent`（yaml 里没写）与 `unresolved`（写了但当前环境算不出，如 `{env:APPDATA}`
 * 在 macOS 上）必须分开：前者是「不投影这类产物」的正常声明，后者可能是笔误、
 * 也可能是跨平台适配器有意为之（非 base 字段没有候选列表机制表达 fallback）。
 */
type SiteRender = { kind: 'absent' } | { kind: 'unresolved' } | { kind: 'ok'; path: string };

/** 现行口径：`absent` 与 `unresolved` 都当作「该类产物不投影」。 */
function pathOf(site: SiteRender): string | undefined {
  return site.kind === 'ok' ? site.path : undefined;
}

/** 一个 scope 求值后的绝对落点。 */
export interface ResolvedAdapterScope {
  readonly base: string;
  /** 缺省（未声明 `skills_dir`）→ `undefined`：本 scope 不投影技能。 */
  readonly skillsDir: string | undefined;
  readonly mainRule: string | undefined;
  readonly commandsDir: string | undefined;
  readonly mcpFile: string | undefined;
  readonly allowed: AllowedRoots;
}

/**
 * 解析一份适配器声明里的全部路径模板。
 *
 * @throws AdapterTemplateError 任一模板语法非法 / 变量不在白名单 / 含 `..` / 超限。
 */
export function parseAdapterScopes(
  doc: AdapterDoc,
): Readonly<Partial<Record<Scope, ParsedAdapterScope>>> {
  const parsed: Partial<Record<Scope, ParsedAdapterScope>> = {};
  for (const scope of ['project', 'user'] as const) {
    const declared = doc.scopes[scope];
    if (declared !== undefined) {
      parsed[scope] = parseOneScope(declared, `scopes.${scope}`);
    }
  }
  return parsed;
}

function parseOneScope(scope: AdapterScope, field: string): ParsedAdapterScope {
  // base 自身不能引用 {base}（自引用），其余模板可以——这是「一处写 base，四处复用」
  const base = baseCandidatesOf(scope.base).map((candidate, index) =>
    parsePathTemplate(candidate, { allowBase: false, field: `${field}.base[${index}]` }),
  );
  const artifact = (value: string | undefined, name: string): ParsedPathTemplate | undefined =>
    value === undefined
      ? undefined
      : parsePathTemplate(value, { allowBase: true, field: `${field}.${name}` });
  return {
    base,
    skillsDir: artifact(scope.skills_dir, 'skills_dir'),
    mainRule: artifact(scope.main_rule, 'main_rule'),
    commandsDir: artifact(scope.commands_dir, 'commands_dir'),
    mcpFile: artifact(scope.mcp_file, 'mcp_file'),
  };
}

/** plan / 加载两处共用的绑定装配（另一侧的根取加载时刻快照，见 AdapterRuntime）。 */
export function bindingsFor(
  runtime: AdapterRuntime,
  scope: Scope,
  rootDir: string,
): TemplateBindings {
  return {
    projectRoot: scope === 'project' ? rootDir : runtime.projectRoot,
    userHome: scope === 'user' ? rootDir : runtime.userHome,
    env: runtime.envValues,
  };
}

/**
 * 求值一个 scope 的全部落点并逐个过 containment 校验。
 *
 * @param rootDir 本 scope 的投影基准（= `ProjectContext.rootDir`）。
 * @returns 求值结果；该 scope 未声明 → `undefined`。
 * @throws AdapterContainmentError 任一落点越出允许根 / 是 UNC。
 * @throws AdapterTemplateError base 的全部候选都不可解析（该 scope 在当前环境无落点）。
 */
export function resolveAdapterScope(
  runtime: AdapterRuntime,
  scope: Scope,
  rootDir: string,
  os: OsContext,
  api: PathApi,
): ResolvedAdapterScope | undefined {
  const parsed = runtime.scopes[scope];
  if (parsed === undefined) {
    return undefined;
  }
  const bindings = bindingsFor(runtime, scope, rootDir);
  const allowed = buildAllowedRoots(
    bindings.projectRoot,
    bindings.userHome,
    runtime.envValues,
    api,
  );

  const base = renderBase(parsed.base, bindings, api);
  if (base === undefined) {
    throw new AdapterTemplateError(
      `${runtime.doc.id}.${scope}: base 的全部候选都不可解析`,
      '至少留一个不依赖环境变量的候选（如 {userHome}/.my/agent）',
    );
  }
  const withBase: TemplateBindings = { ...bindings, base };

  // 三态而非 string | undefined：「压根没声明」与「声明了但当前环境算不出」是两件事，
  // 折叠成同一个 undefined 后调用方无法区分。目前四个字段都按「都不投影」处理（见下方
  // pathOf），只有 skills_dir 额外对 unresolved 报错——把区分能力留在这里，口径要统一
  // 时只改调用处
  const render = (template: ParsedPathTemplate | undefined, name: string): SiteRender => {
    if (template === undefined) {
      return { kind: 'absent' };
    }
    const resolved = renderPathTemplate(template, withBase, api);
    if (resolved === undefined) {
      return { kind: 'unresolved' };
    }
    assertWithinAllowedRoots(resolved, allowed, os, api, `${runtime.doc.id}.${scope}.${name}`);
    return { kind: 'ok', path: resolved };
  };

  assertWithinAllowedRoots(base, allowed, os, api, `${runtime.doc.id}.${scope}.base`);
  const skillsDir = render(parsed.skillsDir, 'skills_dir');
  // 声明了却算不出落点 → 报错：用户写了 skills_dir 却静默不投影，比没写更难查。
  // 压根没声明 → undefined，与 commands_dir / mcp_file 同口径（本 scope 不投影技能）。
  // 注意这条口径与另三个字段不一致（它们的 unresolved 也静默跳过），统一口径的取舍见
  // issue「声明式适配器四个落点字段的 unresolved 口径统一」
  if (skillsDir.kind === 'unresolved') {
    throw new AdapterTemplateError(
      `${runtime.doc.id}.${scope}: skills_dir 不可解析`,
      '已声明的 skills_dir 其变量必须在当前环境可解析；确实不想投影技能就整行删掉',
    );
  }
  return {
    base,
    skillsDir: pathOf(skillsDir),
    mainRule: pathOf(render(parsed.mainRule, 'main_rule')),
    commandsDir: pathOf(render(parsed.commandsDir, 'commands_dir')),
    mcpFile: pathOf(render(parsed.mcpFile, 'mcp_file')),
    allowed,
  };
}
