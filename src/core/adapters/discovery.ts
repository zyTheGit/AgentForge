/**
 * 声明式适配器的**发现与解析**（issue #53 安全边界 1）。
 *
 * 发现来源只有两处，且**默认只读 user 层**：
 * - `<userSoT>/adapters/*.yaml`：恒加载（用户自己的主目录，与手写 profile.yaml 同信任级）；
 * - `<projectSoT>/adapters/*.yaml`：**默认忽略**，需 `AGF_ALLOW_PROJECT_ADAPTERS=1`。
 *
 * 为什么 project 层要默认关：即便没有代码执行，一份 project 层适配器也能声明
 * 「往 `{userHome}/.ssh/config` 写文件」。`git clone` 一个仓库然后 `aforge sync`
 * 不该自动获得往用户主目录写文件的能力——这不是「更安全一点」，而是能否被当成
 * 供应链投递面的分界线。被忽略的条目会进报告（doctor 列出、schema 提示引用），
 * 不静默消失。
 *
 * 本模块**不抛异常**：每个文件的失败都归类进 `failures`，让 doctor 能报完所有问题
 * （PR #59 的教训）。真正的 fail-fast 由 ./gate 在 sync 侧执行。
 *
 * 只做「读 + 解析 + schema 校验 + 模板语法校验」；symlink 逃逸与注册在 ./loader。
 */
import path from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { listDirSafe } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import { type AdapterDoc, AdapterSchema } from '../../schema/adapter';
import { issuePath } from '../config/load';
import { BUILTIN_TARGET_IDS } from '../project/target-ids';
import type {
  AdapterFailureKind,
  AdapterIgnored,
  AdapterLayer,
  AdapterLoadFailure,
} from './diagnostics';
import { ADAPTER_MAX_FILE_BYTES, ADAPTER_MAX_FILES_PER_LAYER, ADAPTERS_DIRNAME } from './limits';
import { type ParsedAdapterScope, parseAdapterScopes } from './resolve';

/** 通过全部静态校验的候选适配器（还未做 symlink 校验、未注册）。 */
export interface DiscoveredAdapter {
  readonly id: string;
  readonly file: string;
  readonly layer: AdapterLayer;
  readonly doc: AdapterDoc;
  readonly scopes: Readonly<Partial<Record<'project' | 'user', ParsedAdapterScope>>>;
}

/** 一次发现的结果（三类结局 + 扫过的目录）。 */
export interface AdapterDiscoveryResult {
  readonly candidates: readonly DiscoveredAdapter[];
  readonly ignored: readonly AdapterIgnored[];
  readonly failures: readonly AdapterLoadFailure[];
  readonly scanned: readonly string[];
}

export interface DiscoverAdaptersOptions {
  readonly host: Host;
  readonly userSoTRoot: string | undefined;
  readonly projectSoTRoot: string;
  /** `AGF_ALLOW_PROJECT_ADAPTERS=1` 才为 true（判定在 ./loader）。 */
  readonly allowProject: boolean;
}

/** 适配器文件的扩展名（与 habits/profile 一致，两种都认）。 */
const YAML_EXTENSIONS = ['.yaml', '.yml'] as const;

/** 文件名 → id（去掉扩展名）；非 yaml 文件返回 undefined。 */
function idFromFileName(name: string): string | undefined {
  for (const ext of YAML_EXTENSIONS) {
    if (name.endsWith(ext)) {
      return name.slice(0, -ext.length);
    }
  }
  return undefined;
}

function failure(
  id: string,
  file: string,
  layer: AdapterLayer,
  kind: AdapterFailureKind,
  message: string,
  hint: string,
): AdapterLoadFailure {
  return { id, file, layer, kind, message, hint };
}

/** 扫描一层的 `adapters/` 目录，返回 `(id, file)` 列表（按文件名序，超限的记 failure）。 */
async function listLayer(
  host: Host,
  sotRoot: string,
  layer: AdapterLayer,
  failures: AdapterLoadFailure[],
): Promise<readonly { id: string; file: string }[]> {
  const dir = path.join(sotRoot, ADAPTERS_DIRNAME);
  const names = (await listDirSafe(host, dir)).slice().sort();
  const entries: { id: string; file: string }[] = [];
  for (const name of names) {
    const id = idFromFileName(name);
    if (id === undefined) {
      continue; // 非 yaml 文件（README 之类）：不是错误，静默跳过
    }
    const file = path.join(dir, name);
    if (entries.length >= ADAPTER_MAX_FILES_PER_LAYER) {
      failures.push(
        failure(
          id,
          file,
          layer,
          'limit',
          `${layer} 层适配器数量超过上限 ${ADAPTER_MAX_FILES_PER_LAYER}，该文件未加载`,
          `删掉不用的 ${ADAPTERS_DIRNAME}/*.yaml；上限用来挡「一次注册几百个 target」`,
        ),
      );
      continue;
    }
    entries.push({ id, file });
  }
  return entries;
}

/** 读一个适配器文件并跑完全部静态校验。 */
async function loadOne(
  host: Host,
  entry: { id: string; file: string },
  layer: AdapterLayer,
): Promise<DiscoveredAdapter | AdapterLoadFailure> {
  const { id, file } = entry;
  const fail = (kind: AdapterFailureKind, message: string, hint: string): AdapterLoadFailure =>
    failure(id, file, layer, kind, message, hint);

  let text: string;
  try {
    text = await host.readFile(file);
  } catch (err) {
    return fail(
      'io',
      `读取失败: ${err instanceof Error ? err.message : String(err)}`,
      '检查该文件与所在目录的读权限，或它是否被其他进程独占打开',
    );
  }
  if (text.length > ADAPTER_MAX_FILE_BYTES) {
    return fail(
      'limit',
      `文件正文 ${text.length} 字节超过上限 ${ADAPTER_MAX_FILE_BYTES}`,
      '适配器只描述路径与开关，不该有兆级正文——确认这个文件没被写错',
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      const at = err.linePos?.[0];
      const where = at === undefined ? '' : `（第 ${at.line} 行，第 ${at.col} 列）`;
      return fail(
        'yaml',
        `${err.message}${where}`,
        `检查该文件的缩进、引号与冒号后的空格${where === '' ? '' : `，错误位于${where}`}`,
      );
    }
    return fail('yaml', err instanceof Error ? err.message : String(err), '检查该文件的 YAML 语法');
  }

  const parsed = AdapterSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `${issuePath(issue)}: ${issue.message}`);
    return fail(
      'schema',
      `共 ${parsed.error.issues.length} 处问题——${lines.join('; ')}`,
      '字段结构、枚举与默认值见 schemas/adapter.schema.json 与 docs/profile.md 的「声明式适配器」一节',
    );
  }
  const doc = parsed.data;

  if (doc.id !== id) {
    return fail(
      'id-mismatch',
      `文件名推导的 id 是 ${id}，yaml 里写的是 ${doc.id}`,
      `把文件重命名为 ${doc.id}.yaml，或把 id 改成 ${id}——发现来源必须能由文件名唯一定位`,
    );
  }
  if ((BUILTIN_TARGET_IDS as readonly string[]).includes(doc.id)) {
    return fail(
      'builtin-id',
      `${doc.id} 是内置 target id，不能被声明式适配器占用`,
      `换一个 id（内置: ${BUILTIN_TARGET_IDS.join(', ')}）——内置 target 的投影逻辑不是声明式的，覆盖它只会产出错误落点`,
    );
  }

  try {
    return { id: doc.id, file, layer, doc, scopes: parseAdapterScopes(doc) };
  } catch (err) {
    return fail(
      'template',
      err instanceof Error ? err.message : String(err),
      err instanceof Error && 'hint' in err && typeof err.hint === 'string'
        ? err.hint
        : '路径模板必须以 {projectRoot} / {userHome} / {env:NAME} 开头，不允许 .. 与自由绝对路径',
    );
  }
}

/**
 * 扫描并解析两层的 `adapters/*.yaml`。
 *
 * @returns 候选 + 被忽略 + 失败 + 扫过的目录（**不抛异常**，见文件头）。
 */
export async function discoverAdapters(
  opts: DiscoverAdaptersOptions,
): Promise<AdapterDiscoveryResult> {
  const { host, userSoTRoot, projectSoTRoot, allowProject } = opts;
  const failures: AdapterLoadFailure[] = [];
  const ignored: AdapterIgnored[] = [];
  const candidates: DiscoveredAdapter[] = [];
  const scanned: string[] = [];
  const seen = new Set<string>();

  const layers: readonly { layer: AdapterLayer; root: string }[] = [
    ...(userSoTRoot === undefined ? [] : [{ layer: 'user' as const, root: userSoTRoot }]),
    { layer: 'project' as const, root: projectSoTRoot },
  ];

  for (const { layer, root } of layers) {
    scanned.push(path.join(root, ADAPTERS_DIRNAME));
    const entries = await listLayer(host, root, layer, failures);
    for (const entry of entries) {
      if (layer === 'project' && !allowProject) {
        ignored.push({
          id: entry.id,
          file: entry.file,
          layer: 'project',
          reason: 'project-layer-not-authorized',
        });
        continue;
      }
      const result = await loadOne(host, entry, layer);
      if ('kind' in result) {
        failures.push(result);
        continue;
      }
      // user 层先扫，同 id 时 project 层的那份记为重复而不是覆盖：user 层是更可信的
      // 来源，让 project 层「顶掉」它等于把默认忽略 project 层的边界从后门放开
      if (seen.has(result.id)) {
        failures.push(
          failure(
            result.id,
            result.file,
            layer,
            'duplicate-id',
            `id ${result.id} 已被另一层的适配器占用（user 层优先）`,
            '两层不要用同一个 id；需要覆盖请直接改 user 层那份',
          ),
        );
        continue;
      }
      seen.add(result.id);
      candidates.push(result);
    }
  }

  return { candidates, ignored, failures, scanned };
}
