/**
 * 模板清单与启停（Spec §7.6 / §5.2 / §6 命令表）。
 *
 * - listTemplates：内置 base/default（§3.4 恒可用）+ 两层 SoT templates\
 *   递归扫描（相对路径去 .md 即模板 id）+ 各源 manifest.templates（§4.5）；
 *   已启用但**尚无缓存**的 git 源在此按需首次拉取（见 materializeIfNeeded）；
 * - setTemplateEnabled：**只改 profile.templates 数组**（§7.6），编辑目标层
 *   自己的 profile.yaml（z.input 原始形态往返，不展开默认值）；写入前经
 *   ProfileSchema 全量校验防写坏。
 */
import path from 'node:path';
import { BASE_DEFAULT_TEMPLATE_ID } from '../../assets/templates';
import { listDirSafe } from '../../infra/fsutil';
import type { Host } from '../../infra/host';
import type { GitSource } from '../../schema';
import {
  editProfile,
  editProfileStringArray,
  type ProfileStringArrayField,
} from '../config/edit-profile';
import type { TargetLayer } from '../config/target-layer';
import type { EnvSnapshot } from '../env';
import { type OsContext, toPosixSeparators } from '../paths';
import {
  listSources,
  loadSourceManifest,
  materializeGitSource,
  type SourceManagerContext,
  sourceStoreDir,
} from './manager';

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

/** listTemplates 结果：清单 + 本次未能纳入清单的源的可操作说明。 */
export interface TemplateListResult {
  readonly items: TemplateListItem[];
  /**
   * 降级说明（不是错误）：某个已启用的源本次没能贡献模板，附原因与下一步。
   *
   * 为什么是 warning 而不是抛错：`template list` 是"看一眼有什么"的只读命令，
   * 一个源拉不下来不该让另外三类来源（内置 / 两层 SoT / 其他源）也看不见。
   * 机器可读输出（`--json`）的契约仍是纯清单数组，这些说明只进人类可读输出与
   * `aforge doctor`（见 core/doctor/check-sources）。
   */
  readonly warnings: string[];
}

/**
 * 已启用 git 源的按需首次拉取（"登记在先、内容后补"的落地点）。
 *
 * 默认注册的官方源在 `init` 时只登记不拉取（init 必须零网络），因此第一次
 * `aforge template list` 才是它真正被用到的时刻。三种情况下**不联网**，改为返回
 * 一句可操作的说明：
 * - 已有缓存 → 无需联网（绝大多数调用走这里，零开销）；
 * - `AGF_OFFLINE=1` → 离线声明优先于一切网络操作（§7.8）；
 * - CI 为真 → CI 里没有凭证、拉取可能挂住，且 CI 不该替用户做"第一次联网"这个决定。
 *   注意这与 §10 对 learnings 的 CI 护栏口径一致：CI 挡的是**外部副作用**，
 *   不挡纯配置读取。
 *
 * 拉取失败（网络 / 凭证 / ref 不存在 / git 超时 124）同样降级为说明——gitExec 自带
 * 30s 超时（infra/shell.GIT_TIMEOUT_MS），所以最坏情况是慢 30 秒，不会永久卡住。
 *
 * @returns undefined 表示该源可用；否则为降级说明。
 */
async function materializeIfNeeded(
  mgr: SourceManagerContext,
  source: GitSource,
): Promise<string | undefined> {
  if (await mgr.host.exists(sourceStoreDir(mgr, source.id))) {
    return undefined;
  }
  const nextStep = `aforge source update ${source.id}`;
  if (mgr.env.offline) {
    return `源 ${source.id} 尚未拉取，离线模式（AGF_OFFLINE=1）下不联网：本次清单不含它的模板。取消 AGF_OFFLINE 后重跑，或先执行 ${nextStep}`;
  }
  if (mgr.env.ci) {
    return `源 ${source.id} 尚未拉取，CI 环境下不自动联网：本次清单不含它的模板。需要时显式执行 ${nextStep}`;
  }
  try {
    await materializeGitSource(mgr, source.id);
    return undefined;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `源 ${source.id} 首次拉取失败，本次清单不含它的模板：${reason}。修复网络 / 凭证后执行 ${nextStep}`;
  }
}

/**
 * 模板清单（§6 命令表 aforge template list）。
 * 同一 id 在多处存在时逐条列出（查找优先级由 resolver 决定，此处如实呈现）。
 */
export async function listTemplates(ctx: TemplateContext): Promise<TemplateListResult> {
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
    os: ctx.os,
  };
  const warnings: string[] = [];
  for (const source of await listSources(mgr)) {
    if (source.enabled === false) {
      continue;
    }
    if (source.type === 'git') {
      const issue = await materializeIfNeeded(mgr, source);
      if (issue !== undefined) {
        warnings.push(issue);
        continue;
      }
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

  return { items, warnings };
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

/** `templates` 的字段访问器（与 skills.always 共用同一套幂等语义，见 editProfileStringArray）。 */
const TEMPLATES_FIELD: ProfileStringArrayField = {
  read: (profile) => profile.templates,
  write: (profile, next) => ({ ...profile, templates: next }),
};

/**
 * 启用 / 禁用模板（§7.6：只改 profile.templates）。
 *
 * 编辑目标层（targetLayer 经命令层解析：AGF_SCOPE > project 在用 > user 在用）
 * 自己的 profile.yaml：templates 缺省视为 []；enable 追加到末尾、disable 移除；
 * 禁用到空数组写入 `templates: []`（合法；base/default 仍恒渲染，§5.2 第 ④ 层）。
 *
 * @param os 宿主平台（透传给 editProfile 决定锁目录的长路径归一）；缺省由
 *        editProfile 取当前进程平台，跨平台用例必须显式注入。
 * @throws ConfigError(2) 目标层 profile.yaml 损坏 / 修改后校验失败。
 */
export async function setTemplateEnabled(
  host: Host,
  targetLayer: TargetLayer,
  id: string,
  enabled: boolean,
  os?: OsContext,
): Promise<SetTemplateResult> {
  const result = await editProfileStringArray(
    (mutate) => editProfile(host, targetLayer, mutate, os),
    TEMPLATES_FIELD,
    id,
    enabled,
  );

  return {
    id,
    enabled,
    profileFile: result.profileFile,
    templates: result.next,
    changed: result.changed,
  };
}
