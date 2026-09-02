/**
 * `aforge status` 的源登记一节（§12 Phase 2 官方模板源在 status 的呈现）。
 *
 * 单独成模块的理由是文件预算：status.ts 已接近 `npm run lint:size` 的 500 行卡口，
 * 而"源登记怎么读、怎么排版"与 status 的其余部分（scope / 投影路径 / 计数 /
 * learning）没有共享状态，是一条干净的缝。
 *
 * 两条硬约束：
 * - **零网络**：只读 `sources.json` 与 `store\<id>` 的存在性。status 是"看一眼当前
 *   状态"的命令，不该因为登记了一个远端源就去联网；
 * - **不让 status 失败**：登记表缺失 / 损坏 / user 根不可解析时不抛错。但"读不出来"
 *   与"没有登记"必须**分开呈现**——两者都打 `(none registered)` 会让登记表损坏的用户
 *   以为自己真的没登记过任何源，而正主（`aforge source *` 会以退出码 2 失败）无人指向。
 *   详细诊断仍归 `aforge doctor` 的 `sources/*` 检查项（那里会说清原因）。
 */
import type { EnvSnapshot } from '../../core/env';
import type { OsContext } from '../../core/paths';
import { listSources, type SourceManagerContext, sourceStoreDir } from '../../core/sources/manager';
import { isDefaultSourceId } from '../../core/sources/official';
import type { Host } from '../../infra/host';
import { getUi, type Ui } from '../../infra/ui';

/** 单个登记源在 status 里的呈现（`--json` 的对外结构）。 */
export interface StatusSourceInfo {
  readonly id: string;
  readonly type: 'local' | 'git';
  /** 是否生效（禁用源不进 template list、不参与模板解析）。 */
  readonly enabled: boolean;
  /** git 源 pin 的 ref（local 源为 null）。 */
  readonly ref: string | null;
  /** git 源已落定的 commit；尚未拉取过则为 null。 */
  readonly commit: string | null;
  /** 内容是否已在本机就绪（local 源恒 true；git 源看 `store\<id>` 是否存在）。 */
  readonly materialized: boolean;
  /** 是否为内置声明的默认注册项（官方源）。 */
  readonly official: boolean;
}

/** collectStatusSources 结果：清单 + "登记表读不出来"这一态。 */
export interface StatusSourcesReport {
  readonly sources: readonly StatusSourceInfo[];
  /**
   * `sources.json` 存在但读取失败（坏 JSON / 越界 id）。
   *
   * 与 `sources: []`（真的没登记）分开的理由：两者在 status 里长得一样的话，登记表
   * 损坏会被显示成"没有登记过任何源"——用户不会去查 doctor，而 `aforge source *`
   * 已经在以退出码 2 失败。这与 doctor 的 `sources/registry` warn 是同一件事的两处呈现。
   */
  readonly unreadable: boolean;
}

/** 读取登记源状态（失败降级为 `unreadable`，绝不抛错，见文件头）。 */
export async function collectStatusSources(
  host: Host,
  env: EnvSnapshot,
  os: OsContext,
  cwd: string,
  userSoTRoot: string | null,
): Promise<StatusSourcesReport> {
  if (userSoTRoot === null) {
    return { sources: [], unreadable: false };
  }
  // 显式标注类型：与 doctor 侧 check-sources.managerContextForDoctor 同一契约，
  // 少一个字段应当在此处报错，而不是等到传进 listSources 时才被推断出来
  const mgr: SourceManagerContext = { host, env, userSoTRoot, cwd, os };
  try {
    const sources = await listSources(mgr);
    const infos: StatusSourceInfo[] = [];
    for (const source of sources) {
      infos.push({
        id: source.id,
        type: source.type,
        enabled: source.enabled,
        ref: source.type === 'git' ? (source.ref ?? null) : null,
        commit: source.type === 'git' ? (source.commit ?? null) : null,
        materialized:
          source.type === 'local' ? true : await host.exists(sourceStoreDir(mgr, source.id)),
        official: isDefaultSourceId(source.id),
      });
    }
    return { sources: infos, unreadable: false };
  } catch {
    return { sources: [], unreadable: true };
  }
}

/** 单个源的状态短语（enabled / 是否已拉取，一眼看出"登记了但不生效"）。 */
function sourceState(info: StatusSourceInfo, ui: Ui): string {
  if (!info.enabled) {
    return ui.dim('disabled');
  }
  return info.materialized ? ui.green('enabled') : ui.yellow('enabled, not fetched');
}

/**
 * status 的 `sources:` 一节（空登记表也打一行，避免"这个特性存不存在"的疑问）。
 *
 * 三态分开：读不出来 → `(unreadable - see aforge doctor)`（措辞与 status 里 SoT 根
 * 不可解析那行同源）；空表 → `(none registered)`；否则逐条列出。
 */
export function formatStatusSources(report: StatusSourcesReport, ui: Ui = getUi()): string[] {
  const lines = [ui.bold('sources (user-level sources.json):')];
  if (report.unreadable) {
    lines.push(`  ${ui.yellow('(unreadable - see aforge doctor)')}`);
    return lines;
  }
  if (report.sources.length === 0) {
    lines.push(`  ${ui.dim('(none registered)')}`);
    return lines;
  }
  for (const info of report.sources) {
    const tag = info.official ? ui.dim(' [official]') : '';
    const pin = info.ref === null ? '' : ` ${ui.dim(`pin ${info.ref}`)}`;
    lines.push(`  ${ui.bold(info.id)}${tag}  ${info.type}  ${sourceState(info, ui)}${pin}`);
  }
  return lines;
}
