/**
 * 声明式适配器的**路径模板**解析与求值（issue #53 安全边界 2）。
 *
 * 为什么路径必须是模板而不能是自由字符串：适配器文件是**数据**，但落点决定了
 * `aforge sync` 往哪写。允许 `C:\Windows\System32\drivers\etc\hosts` 这种自由绝对
 * 路径，等于把「往哪写」的决定权交给一份可以被 `git clone` 带进来的 yaml。
 *
 * 模板形态：`{<变量>}` 开头，后面接以 `/` 或 `\` 分隔的**字面量段**。
 *
 * 允许的变量（白名单，多一个都不认）：
 * - `{projectRoot}`：项目根（scope=project 的投影基准）；
 * - `{userHome}`：用户目录（scope=user 的投影基准）；
 * - `{base}`：本 scope `base` 求值后的目录（只能出现在 `base` **之外**的模板里，
 *   避免自引用）；
 * - `{env:NAME}`：环境变量，NAME 本身也走白名单（见 ./limits.ADAPTER_ENV_WHITELIST）。
 *
 * 本模块**只做语法与白名单**：解析后的绝对路径是否落在允许的根之下，由
 * ./containment 判定（两件事分开是因为前者是纯字符串校验、后者要知道运行时的
 * 根目录与 symlink 实况）。
 *
 * 纯计算模块：无 IO、不读环境（环境值由调用方在 bindings 里给）。
 */
import { ConfigError } from '../errors';
import type { PathApi } from '../paths';
import {
  ADAPTER_ENV_WHITELIST,
  ADAPTER_MAX_PATH_DEPTH,
  type AdapterEnvName,
  isWhitelistedEnvName,
} from './limits';

/** 模板语法 / 白名单违规 → ConfigError(2)，由 loader 归类为 `template` 失败。 */
export class AdapterTemplateError extends ConfigError {
  constructor(message: string, hint: string) {
    super(message, { hint });
    this.name = 'AdapterTemplateError';
  }
}

/** 模板的根变量。 */
export type TemplateRoot =
  | { readonly kind: 'projectRoot' }
  | { readonly kind: 'userHome' }
  | { readonly kind: 'base' }
  | { readonly kind: 'env'; readonly name: AdapterEnvName };

/** 解析后的模板：一个根变量 + 若干字面量段。 */
export interface ParsedPathTemplate {
  /** 原始模板文本（错误提示与 doctor 展示用）。 */
  readonly source: string;
  readonly root: TemplateRoot;
  readonly segments: readonly string[];
}

/** 模板求值所需的绑定（`base` 只在求值 base 之外的模板时提供）。 */
export interface TemplateBindings {
  readonly projectRoot: string;
  /** 用户目录（USERPROFILE / HOME 都取不到时为 undefined → 引用它的模板不可解析）。 */
  readonly userHome: string | undefined;
  /** 白名单环境变量的当前取值（未设置 / 空串 → 视为不可解析）。 */
  readonly env: Readonly<Partial<Record<AdapterEnvName, string>>>;
  readonly base?: string;
}

/** `{name}` / `{env:NAME}` 的头部匹配。 */
const ROOT_RE = /^\{([A-Za-z]+)(?::([A-Za-z_][A-Za-z0-9_]*))?\}(.*)$/s;

/** 段内非法字符：控制字符与 Windows 保留符号（`:` 同时挡掉 `C:` 这类盘符跳变）。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 路径段必须显式拒绝控制字符
const ILLEGAL_SEGMENT_CHARS = /[\u0000-\u001f<>:"|?*{}]/;

/** 单段长度上限（够表达任何真实目录名；挡掉「一段 3 万字符」的路径长度攻击）。 */
const MAX_SEGMENT_LENGTH = 128;

/**
 * 解析一条路径模板。
 *
 * @param template 模板文本（`{userHome}/.my/agent` 形态；`\` 与 `/` 等价）。
 * @param opts.allowBase 是否允许 `{base}` 变量（`base` 自身的模板里不允许）。
 * @param opts.field 出错时报的字段名（如 `scopes.user.main_rule`）。
 * @throws AdapterTemplateError 语法非法 / 变量不在白名单 / 含 `..` / 段数或段长超限。
 */
export function parsePathTemplate(
  template: string,
  opts: { readonly allowBase: boolean; readonly field: string },
): ParsedPathTemplate {
  const normalized = template.replace(/\\/g, '/').trim();
  const matched = ROOT_RE.exec(normalized);
  if (matched === null) {
    throw new AdapterTemplateError(
      `${opts.field}: 路径模板必须以变量开头（得到 ${JSON.stringify(template)}）`,
      `改写成 {projectRoot}/... 或 {userHome}/... 或 {env:NAME}/...；不接受自由绝对路径与相对路径（可用变量: projectRoot, userHome${opts.allowBase ? ', base' : ''}, env:${ADAPTER_ENV_WHITELIST.join('|')}）`,
    );
  }
  const [, name, envName, rest] = matched;
  const root = resolveRootVariable(name ?? '', envName, opts);
  const segments = parseSegments(rest ?? '', opts.field);
  return { source: template, root, segments };
}

/** 变量名 → 根变量（不在白名单即报错，含 `{base}` 的上下文限制）。 */
function resolveRootVariable(
  name: string,
  envName: string | undefined,
  opts: { readonly allowBase: boolean; readonly field: string },
): TemplateRoot {
  if (name === 'env') {
    if (envName === undefined) {
      throw new AdapterTemplateError(
        `${opts.field}: {env:...} 缺少变量名`,
        `写成 {env:NAME}，NAME 限于 ${ADAPTER_ENV_WHITELIST.join(' | ')}`,
      );
    }
    if (!isWhitelistedEnvName(envName)) {
      throw new AdapterTemplateError(
        `${opts.field}: 环境变量 ${envName} 不在白名单内`,
        `只接受 ${ADAPTER_ENV_WHITELIST.join(' | ')}——其余变量与「某个 agent 的配置根」无关，允许自由取值等于把落点交给环境`,
      );
    }
    return { kind: 'env', name: envName };
  }
  if (envName !== undefined) {
    throw new AdapterTemplateError(
      `${opts.field}: 变量 {${name}:${envName}} 无效`,
      '只有 {env:NAME} 接受冒号形式',
    );
  }
  if (name === 'projectRoot' || name === 'userHome') {
    return { kind: name };
  }
  if (name === 'base') {
    if (!opts.allowBase) {
      throw new AdapterTemplateError(
        `${opts.field}: base 自身的模板里不能引用 {base}`,
        'base 只能用 {projectRoot} / {userHome} / {env:NAME} 开头',
      );
    }
    return { kind: 'base' };
  }
  throw new AdapterTemplateError(
    `${opts.field}: 未知变量 {${name}}`,
    `可用变量: projectRoot, userHome${opts.allowBase ? ', base' : ''}, env:${ADAPTER_ENV_WHITELIST.join('|')}`,
  );
}

/** 校验并切分变量之后的字面量部分。 */
function parseSegments(rest: string, field: string): readonly string[] {
  const segments = rest.split('/').filter((seg) => seg !== '');
  if (segments.length > ADAPTER_MAX_PATH_DEPTH) {
    throw new AdapterTemplateError(
      `${field}: 路径段数 ${segments.length} 超过上限 ${ADAPTER_MAX_PATH_DEPTH}`,
      '缩短落点层级；上限用来挡「用超深路径把长路径处理逻辑撑爆」的写法',
    );
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new AdapterTemplateError(
        `${field}: 路径段不允许 ${JSON.stringify(segment)}`,
        '`..` 是目录穿越的入口，模板里一律不接受——落点必须由变量向下拼',
      );
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new AdapterTemplateError(
        `${field}: 路径段过长（${segment.length} > ${MAX_SEGMENT_LENGTH}）`,
        '单个目录/文件名请控制在 128 字符内',
      );
    }
    if (ILLEGAL_SEGMENT_CHARS.test(segment)) {
      throw new AdapterTemplateError(
        `${field}: 路径段 ${JSON.stringify(segment)} 含非法字符`,
        '不允许控制字符与 < > : " | ? * { }（冒号同时挡掉 C: 这类盘符跳变）',
      );
    }
  }
  return segments;
}

/**
 * 求值一条已解析的模板。
 *
 * @returns 绝对路径；根变量在当前环境下取不到值（用户目录缺失 / 环境变量未设置 /
 *          取到的值不是绝对路径）时返回 `undefined`——由调用方决定是「换下一个
 *          base 候选」还是「该 scope 不可用」。
 */
export function renderPathTemplate(
  parsed: ParsedPathTemplate,
  bindings: TemplateBindings,
  api: PathApi,
): string | undefined {
  const rootValue = rootValueOf(parsed.root, bindings);
  if (rootValue === undefined || rootValue === '' || !api.isAbsolute(rootValue)) {
    return undefined;
  }
  return api.join(api.resolve(rootValue), ...parsed.segments);
}

function rootValueOf(root: TemplateRoot, bindings: TemplateBindings): string | undefined {
  switch (root.kind) {
    case 'projectRoot':
      return bindings.projectRoot;
    case 'userHome':
      return bindings.userHome;
    case 'base':
      return bindings.base;
    case 'env':
      return bindings.env[root.name];
    default:
      return undefined;
  }
}

/**
 * 求值 `base` 候选列表：取第一个可解析的候选。
 *
 * 这就是「环境变量覆盖」的表达方式：`['{env:CODEX_HOME}', '{userHome}/.codex']`
 * 等价于内置 codex 的 `CODEX_HOME ?? ~/.codex`，不需要额外的 override 字段。
 *
 * @returns 第一个可解析的绝对路径；全部不可解析 → undefined。
 */
export function renderBase(
  candidates: readonly ParsedPathTemplate[],
  bindings: TemplateBindings,
  api: PathApi,
): string | undefined {
  for (const candidate of candidates) {
    const resolved = renderPathTemplate(candidate, bindings, api);
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return undefined;
}

/** `base` 字段的两种写法（单个模板 / 候选数组）归一为数组。 */
export function baseCandidatesOf(base: string | readonly string[]): readonly string[] {
  return typeof base === 'string' ? [base] : base;
}
