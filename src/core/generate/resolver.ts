/**
 * 模板解析（Spec §5.2 / §3.4 / §4.5）：模板 id → 模板正文。
 *
 * 查找优先级（高 → 低）：
 * 1. 内置 base/default（发行包只读骨架，恒可用；不可被 SoT 覆盖，Spec §3.4）；
 * 2. 项目 SoT `<project>\.agentforge\templates\<id>.md`；
 * 3. 用户 SoT `<user>\templates\<id>.md`；
 * 4. 源 store `store\<source>\templates\<id>.md`（§4.5 外部模板包布局；
 *    M8 起才有真实 store 与 manifest 精确解析，本层先实现路径查找）。
 *
 * 全部未命中 → ConfigError(2)（Spec §5.2：未解析的 template id → sync 失败）。
 * 所有文件访问经注入的 Host；路径拼接一律 path.join（Spec §2.1）。
 */
import path from 'node:path';
import { BASE_DEFAULT_TEMPLATE, BASE_DEFAULT_TEMPLATE_ID } from '../../assets/templates';
import type { Host } from '../../infra/host';
import { ConfigError } from '../errors';

/** 模板解析上下文：路径由调用方经 core/paths 解析后注入。 */
export interface ResolveContext {
  readonly host: Host;
  readonly userSoTRoot: string;
  readonly projectSoTRoot: string;
  readonly storeRoot: string;
}

/** 解析结果：模板 id 与其正文（UTF-8 已由 Host 解码剥 BOM）。 */
export interface ResolvedTemplate {
  readonly id: string;
  readonly content: string;
}

const TEMPLATE_LIST_HINT = '检查 profile.templates 或运行 aforge template list';

/** 校验模板 id：`/` 分隔的相对 id；拒绝空段 / `.`、`..` 段 / 反斜杠 / 绝对路径（防逃逸）。 */
function validateTemplateId(id: string): void {
  const segments = id.split('/');
  const invalid =
    id === '' ||
    id.includes('\\') ||
    path.isAbsolute(id) ||
    segments.some((seg) => seg === '' || seg === '.' || seg === '..');
  if (invalid) {
    throw new ConfigError(`非法模板 id: "${id}"`, {
      hint: '模板 id 形如 base/default（以 / 分隔的相对路径，不含扩展名）',
      details: { id },
    });
  }
}

/** SoT 内模板文件路径：`<root>\templates\<id>.md`。 */
function sotTemplateFile(soTRoot: string, id: string): string {
  return path.join(soTRoot, 'templates', `${id}.md`);
}

/**
 * 源 store 查找：storeRoot 下各源目录（§4.5 布局）内的 `templates\<id>.md`，
 * 按源目录名字典序取首个命中。store 目录不存在（真实 host readdir 抛错）→ 无结果。
 */
async function lookupStore(id: string, ctx: ResolveContext): Promise<string | undefined> {
  let entries: readonly string[];
  try {
    entries = await ctx.host.listDir(ctx.storeRoot);
  } catch {
    return undefined;
  }
  const sources = new Set<string>();
  for (const entry of entries) {
    // 真实 host 返回直接子项名；防御性取首段，兼容前缀扫描式实现
    const first = entry.split(/[\\/]/)[0] ?? '';
    if (first !== '' && first !== '.' && first !== '..') {
      sources.add(first);
    }
  }
  for (const source of [...sources].sort()) {
    const candidate = path.join(ctx.storeRoot, source, 'templates', `${id}.md`);
    if (await ctx.host.exists(candidate)) {
      return ctx.host.readFile(candidate);
    }
  }
  return undefined;
}

/**
 * 按优先级解析模板 id（见文件头）。
 *
 * @throws ConfigError(2) id 非法或四处均未命中。
 */
export async function resolveTemplate(id: string, ctx: ResolveContext): Promise<ResolvedTemplate> {
  validateTemplateId(id);

  // 1. 内置 base/default（恒优先，Spec §3.4 只读）
  if (id === BASE_DEFAULT_TEMPLATE_ID) {
    return { id, content: BASE_DEFAULT_TEMPLATE };
  }

  // 2. 项目 SoT
  const projectFile = sotTemplateFile(ctx.projectSoTRoot, id);
  if (await ctx.host.exists(projectFile)) {
    return { id, content: await ctx.host.readFile(projectFile) };
  }

  // 3. 用户 SoT
  const userFile = sotTemplateFile(ctx.userSoTRoot, id);
  if (await ctx.host.exists(userFile)) {
    return { id, content: await ctx.host.readFile(userFile) };
  }

  // 4. 源 store
  const fromStore = await lookupStore(id, ctx);
  if (fromStore !== undefined) {
    return { id, content: fromStore };
  }

  throw new ConfigError(`未解析的模板 id: ${id}`, {
    hint: TEMPLATE_LIST_HINT,
    details: {
      id,
      projectSoTRoot: ctx.projectSoTRoot,
      userSoTRoot: ctx.userSoTRoot,
      storeRoot: ctx.storeRoot,
    },
  });
}
