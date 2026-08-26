/**
 * 模板清单与启停（Spec §7.6 / §5.2 / §6 命令表）。
 *
 * - listTemplates：内置 base/default（§3.4 恒可用）+ 两层 SoT templates\
 *   递归扫描（相对路径去 .md 即模板 id）+ 各源 manifest.templates（§4.5）；
 * - setTemplateEnabled：**只改 profile.templates 数组**（§7.6），编辑目标层
 *   自己的 profile.yaml（z.input 原始形态往返，不展开默认值）；写入前经
 *   ProfileSchema 全量校验防写坏。
 */
import path from 'node:path';
import { BASE_DEFAULT_TEMPLATE_ID } from '../../assets/templates';
import { listDirSafe } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import { editProfile } from '../config/edit-profile';
import type { TargetLayer } from '../config/target-layer';
import type { EnvSnapshot } from '../env';
import { type OsContext, toPosixSeparators } from '../paths';
import { listSources, loadSourceManifest, type SourceManagerContext } from './manager';

/** 模板清单项。 */
export interface TemplateListItem {
  readonly id: string;
  /** builtin / project / user / source（同 id 多处出现时逐条列出，启用判断取并集）。 */
  readonly origin: 'builtin' | 'project' | 'user' | 'source';
  /** source 项的来源源 id。 */
  readonly sourceId?: string;
  /** manifest 声明的描述（无则 undefined）。 */
  readonly description?: string;
  /** 是否在生效 profile.templates 中（两层合并后）。 */
  readonly enabled: boolean;
}

/** 模板上下文。 */
export interface TemplateContext {
  readonly host: Host;
  readonly env: EnvSnapshot;
  readonly os: OsContext;
  readonly cwd: string;
  readonly userSoTRoot: string;
  readonly projectSoTRoot: string;
  /** 生效 profile（判定 enabled；命令层经 resolveEffectiveConfig 装配后注入）。 */
  readonly effectiveTemplates: readonly string[];
}

/** 递归扫描 <root>/templates 下的 .md 文件 → 模板 id 列表（相对路径去 .md，/ 分隔）。 */
async function scanSoTTemplates(host: Host, sotRoot: string): Promise<string[]> {
  const ids: string[] = [];
  const baseDir = path.join(sotRoot, 'templates');

  async function walk(relDir: string): Promise<void> {
    for (const entry of (await listDirSafe(host, path.join(baseDir, relDir))).sort()) {
      const rel = relDir === '' ? entry : `${relDir}/${entry}`;
      const abs = path.join(baseDir, rel);
      const stat = await host.stat(abs).catch(() => undefined);
      if (stat?.isDirectory === true) {
        await walk(rel);
      } else if (entry.endsWith('.md')) {
        ids.push(toPosixSeparators(rel.replace(/\.md$/, '')));
      }
    }
  }

  await walk('');
  return ids;
}

/**
 * 模板清单（§6 命令表 aforge template list）。
 * 同一 id 在多处存在时逐条列出（查找优先级由 resolver 决定，此处如实呈现）。
 */
export async function listTemplates(ctx: TemplateContext): Promise<TemplateListItem[]> {
  const enabledSet = new Set(ctx.effectiveTemplates);
  const items: TemplateListItem[] = [
    {
      id: BASE_DEFAULT_TEMPLATE_ID,
      origin: 'builtin',
      enabled: enabledSet.has(BASE_DEFAULT_TEMPLATE_ID),
    },
  ];

  for (const layer of [
    { origin: 'project' as const, root: ctx.projectSoTRoot },
    { origin: 'user' as const, root: ctx.userSoTRoot },
  ]) {
    for (const id of await scanSoTTemplates(ctx.host, layer.root)) {
      items.push({ id, origin: layer.origin, enabled: enabledSet.has(id) });
    }
  }

  const mgr: SourceManagerContext = {
    host: ctx.host,
    env: ctx.env,
    userSoTRoot: ctx.userSoTRoot,
    cwd: ctx.cwd,
  };
  for (const source of await listSources(mgr)) {
    if (source.enabled === false) {
      continue;
    }
    const manifest = await loadSourceManifest(mgr, source);
    for (const tpl of manifest?.templates ?? []) {
      items.push({
        id: tpl.id,
        origin: 'source',
        sourceId: source.id,
        description: tpl.description,
        enabled: enabledSet.has(tpl.id),
      });
    }
  }

  return items;
}

/** setTemplateEnabled 结果。 */
export interface SetTemplateResult {
  readonly id: string;
  readonly enabled: boolean;
  /** 编辑的 profile.yaml 绝对路径。 */
  readonly profileFile: string;
  /** 修改后的 templates 数组（写入值）。 */
  readonly templates: string[];
  /** 本次是否实际改动（enable 已含 / disable 本就不含 → false）。 */
  readonly changed: boolean;
}

/**
 * 启用 / 禁用模板（§7.6：只改 profile.templates）。
 *
 * 编辑目标层（targetLayer 经命令层解析：AGF_SCOPE > project 在用 > user 在用）
 * 自己的 profile.yaml：templates 缺省视为 []；enable 追加到末尾、disable 移除；
 * 禁用到空数组写入 `templates: []`（合法；base/default 仍恒渲染，§5.2 第 ④ 层）。
 *
 * @throws ConfigError(2) 目标层 profile.yaml 损坏 / 修改后校验失败。
 */
export async function setTemplateEnabled(
  host: Host,
  targetLayer: TargetLayer,
  id: string,
  enabled: boolean,
): Promise<SetTemplateResult> {
  let next: string[] = [];
  let changed = false;
  const { profileFile } = await editProfile(host, targetLayer, (profile) => {
    const current = profile.templates ?? [];
    next = enabled
      ? current.includes(id)
        ? current
        : [...current, id]
      : current.filter((t) => t !== id);
    changed = next.length !== current.length;
    return { ...profile, templates: next };
  });

  return {
    id,
    enabled,
    profileFile,
    templates: next,
    changed,
  };
}
