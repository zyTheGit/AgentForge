/**
 * 配置加载（Spec §3.1/§3.2/§4）：读文件 → 解析 → schema 校验，全部经 Host 注入。
 *
 * 返回形态约定（关键设计，与 schema 层"双形态"配套）：
 * - loadYaml：校验通过后返回**原始 YAML 对象**（z.input 形态，字段缺省保留
 *   undefined）。合并层（./merge）依赖"未设置"与"显式设置"的区分来实现
 *   §4.2 overlay 继承；需要完整默认值的消费端请走
 *   defaults.resolveEffectiveConfig（其出口统一做 Schema.parse 填充）。
 * - loadJson（sources.json 不参与 profile/habits 合并）：返回填充默认值后的
 *   z.output 形态，可直接消费。
 *
 * 错误映射（Spec §6.1 退出码）：
 * - 文件读取失败且 errno 属权限/占用域（EPERM/EACCES/EROFS/EBUSY）→
 *   PermissionError(4)，见 readConfigText；
 * - YAML/JSON 语法错误 → ConfigError(2)，YAML 附行列号；
 * - schema 校验失败 → ConfigError(2)，附字段路径与逐条 issue 摘要。
 */
import path from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import type { ZodIssue, ZodType, z } from 'zod';
import { isPermissionErrno } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import type { HabitsInput, ProfileInput, SourcesFile } from '../../schema';
import { HabitsSchema, ProfileSchema, SourcesFileSchema } from '../../schema';
import { ConfigError, PermissionError } from '../errors';

/** Spec §3.1/§3.2 SoT 目录内的配置文件名。 */
export const HABITS_FILE = 'habits.yaml';
export const PROFILE_FILE = 'profile.yaml';
export const SOURCES_FILE = 'sources.json';

/** yaml 包的 YAMLParseError.linePos（1-based {line, col}，可能缺失；取首个区间起点）。 */
function yamlLinePos(err: YAMLParseError): string | undefined {
  const first = err.linePos?.[0];
  if (first !== undefined && Number.isFinite(first.line) && Number.isFinite(first.col)) {
    return `（第 ${first.line} 行，第 ${first.col} 列）`;
  }
  return undefined;
}

/** issue.path → 展示用字段路径（symbol 段过滤；根位置显示 "(根)"）。 */
export function issuePath(issue: ZodIssue): string {
  const segments = issue.path.filter((seg) => typeof seg !== 'symbol');
  return segments.length > 0 ? segments.join('.') : '(根)';
}

/** schema 校验：失败时抛 ConfigError(2)，附字段路径与逐条友好摘要；成功返回填充默认值的结果。 */
function parseOrThrow<S extends ZodType>(
  schema: S,
  data: unknown,
  filePath: string,
  label: string,
): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues;
    const lines = issues.map((issue) => `  - ${issuePath(issue)}: ${issue.message}`);
    throw new ConfigError(
      `${label} 校验失败（${filePath}），共 ${issues.length} 处问题:\n${lines.join('\n')}`,
      {
        hint: `按上述字段路径修正 ${filePath}；字段结构、枚举与默认值见 schemas/ 目录下的 JSON Schema 工件`,
        details: { file: filePath, issues },
      },
    );
  }
  return result.data;
}

/**
 * 读配置文件正文；「打不开」的 errno 映射为 **PermissionError(4)**，ENOENT 归为
 * 「文件不存在」并返回 null。
 *
 * 为什么不让裸 errno 上抛：errors.toExitCode 对非 AgentForgeError 返回 Generic(1)，
 * 于是「profile.yaml 被编辑器 / 杀毒独占打开」这种纯环境问题会以退出码 1 + 裸堆栈
 * 结束，与各命令文档承诺的「目标不可读写 → 4」不符，用户也拿不到可操作提示。
 *
 * 判据在 fsutil.isPermissionErrno（EPERM/EACCES/EROFS，与写路径同源）之外多收一个
 * **EBUSY**：这是 Windows 上「文件被另一进程独占打开」的典型 errno，只出现在读路径，
 * 故不去放宽共享判据（写路径的 rename 遇 EBUSY 语义不同，属 fsutil 的职责范围）。
 *
 * ENOENT 单独归到「不存在」而不是照原样上抛：调用方是 `host.exists()` 通过后再读，
 * 两次系统调用之间文件可能被删除或被原子替换（编辑器保存、并发 sync 的 rename），
 * 此时裸 ENOENT 同样会退化成退出码 1 + 裸堆栈，还与 loadYaml/loadJson 文档承诺的
 * 「文件不存在时返回 null」自相矛盾。返回 null 让这条竞态收敛到既有的不存在分支。
 *
 * @returns 文件正文；文件不存在（含 exists 通过后被删除的竞态）时返回 null。
 */
async function readConfigText(host: Host, filePath: string, label: string): Promise<string | null> {
  try {
    return await host.readFile(filePath);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') {
      return null;
    }
    if (isPermissionErrno(err) || code === 'EBUSY') {
      throw new PermissionError(`无法读取 ${label}: ${filePath}`, {
        hint: '文件可能被其他进程独占打开（关闭编辑器 / 等待杀毒扫描结束），或检查该文件与所在目录的读权限',
        details: err,
      });
    }
    throw err;
  }
}

/**
 * 读取并校验 YAML 配置文件。
 *
 * @returns 原始解析对象（z.input 形态）；文件不存在时返回 null。
 * @throws ConfigError(2) YAML 语法错误（附行列）或 schema 校验失败（附字段路径）。
 * @throws PermissionError(4) 文件存在但读不出来（权限 / 被独占打开，见 readConfigText）。
 */
export async function loadYaml<S extends ZodType>(
  host: Host,
  filePath: string,
  schema: S,
  label: string,
): Promise<z.input<S> | null> {
  if (!(await host.exists(filePath))) {
    return null;
  }
  const text = await readConfigText(host, filePath, label);
  if (text === null) {
    return null;
  }

  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      const at = yamlLinePos(err);
      throw new ConfigError(`${label} 不是合法的 YAML：${err.message}${at ?? ''}`, {
        hint: `检查 ${filePath} 的缩进、引号与冒号后的空格${at ? `，错误位于${at}` : ''}`,
        details: { file: filePath, message: err.message, linePos: err.linePos },
      });
    }
    throw err;
  }

  // 只取校验结果，不取填充后的 data——保留"未设置"语义（见文件头注释）
  parseOrThrow(schema, data, filePath, label);
  return data as z.input<S>;
}

/**
 * 读取并校验 JSON 配置文件（sources.json 等）。
 *
 * @returns 填充默认值后的完整对象（z.output 形态）；文件不存在时返回 null。
 * @throws ConfigError(2) JSON 语法错误（sources.json 损坏，Spec §6.1）或校验失败。
 * @throws PermissionError(4) 文件存在但读不出来（权限 / 被独占打开，见 readConfigText）。
 */
export async function loadJson<S extends ZodType>(
  host: Host,
  filePath: string,
  schema: S,
  label: string,
): Promise<z.output<S> | null> {
  if (!(await host.exists(filePath))) {
    return null;
  }
  const text = await readConfigText(host, filePath, label);
  if (text === null) {
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new ConfigError(`${label} 不是合法的 JSON：${err.message}`, {
        hint: `检查 ${filePath} 的 JSON 语法（多余逗号、未闭合括号、注释都是常见错误）`,
        details: { file: filePath, message: err.message },
      });
    }
    throw err;
  }

  return parseOrThrow(schema, data, filePath, label);
}

/** 加载某层 SoT 的 habits.yaml（不存在 → null；返回原始形态供合并）。 */
export async function loadHabits(host: Host, sotRoot: string): Promise<HabitsInput | null> {
  return loadYaml(host, path.join(sotRoot, HABITS_FILE), HabitsSchema, 'habits.yaml');
}

/** 加载某层 SoT 的 profile.yaml（不存在 → null；返回原始形态供合并）。 */
export async function loadProfile(host: Host, sotRoot: string): Promise<ProfileInput | null> {
  return loadYaml(host, path.join(sotRoot, PROFILE_FILE), ProfileSchema, 'profile.yaml');
}

/** 加载某层 SoT 的 sources.json（不存在 → null；返回完整形态直接消费）。 */
export async function loadSourcesFile(host: Host, sotRoot: string): Promise<SourcesFile | null> {
  return loadJson(host, path.join(sotRoot, SOURCES_FILE), SourcesFileSchema, 'sources.json');
}
