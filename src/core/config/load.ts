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
 * 错误映射（Spec §6.1 退出码 2）：
 * - YAML/JSON 语法错误 → ConfigError，YAML 附行列号；
 * - schema 校验失败 → ConfigError，附字段路径与逐条 issue 摘要。
 */
import path from 'node:path';
import { YAMLParseError, parse as parseYaml } from 'yaml';
import type { ZodIssue, ZodType, z } from 'zod';
import type { Host } from '../../infra/host';
import { ConfigError } from '../errors';
import { HabitsSchema, ProfileSchema, SourcesFileSchema } from '../../schema';
import type { HabitsInput, ProfileInput, SourcesFile } from '../../schema';

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
function issuePath(issue: ZodIssue): string {
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
 * 读取并校验 YAML 配置文件。
 *
 * @returns 原始解析对象（z.input 形态）；文件不存在时返回 null。
 * @throws ConfigError(2) YAML 语法错误（附行列）或 schema 校验失败（附字段路径）。
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
  const text = await host.readFile(filePath);

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
  const text = await host.readFile(filePath);

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
