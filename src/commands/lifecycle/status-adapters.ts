/**
 * status 的「声明式适配器来源」一节（issue #53）。
 *
 * 为什么单独一个模块：`status.ts` 的职责是编排各节，每一节的**取数 + 呈现**都自成
 * 一块（见同目录的 status-sources / status-learning）。适配器这节同理——它有自己的
 * 数据来源（进程级加载报告，零 IO）与自己的呈现规则（空则整节不打）。
 *
 * 为什么进 status：`targets` 一节只给出 id，看不出「claude 是内置、my-agent 是我上周
 * 放进 ~/.agentforge/adapters/ 的那份 yaml」。第三方 target 的**来源**是排查落点异常
 * 的第一条线索，与 sources / on_demand 两节同一理由（「登记了但不生效」「生效了但
 * 来源不明」都必须可见）。加载失败的详情归 `aforge doctor`。
 */
import { adapterLoadReport } from '../../core/adapters/diagnostics';
import { ADAPTER_ALLOW_PROJECT_ENV } from '../../core/adapters/limits';
import type { Ui } from '../../infra/ui';

/** 一个声明式适配器的来源（`--json` 输出：路径为绝对路径）。 */
export interface StatusAdapterInfo {
  readonly id: string;
  readonly layer: 'user' | 'project';
  readonly file: string;
}

/** 已加载 / 被忽略两张名单（两者都空时呈现层整节不打）。 */
export interface StatusAdapters {
  readonly loaded: readonly StatusAdapterInfo[];
  readonly ignored: readonly StatusAdapterInfo[];
}

/** 从进程级加载报告取两张名单（零 IO：加载在 CLI 装配阶段已完成）。 */
export function collectStatusAdapters(): StatusAdapters {
  const report = adapterLoadReport();
  const info = (entry: {
    id: string;
    layer: 'user' | 'project';
    file: string;
  }): StatusAdapterInfo => ({
    id: entry.id,
    layer: entry.layer,
    file: entry.file,
  });
  return {
    loaded: report.loaded.map(info),
    ignored: report.ignored.map(info),
  };
}

/**
 * 渲染这一节。
 *
 * 一个适配器都没有时**整节不打**——绝大多数用户只用内置四家，凭空多一个空标题
 * 只会让输出变长。被忽略的那批必须打：不打的话「文件放对了但没生效」完全不可见，
 * 用户只会反复检查 yaml 语法。
 */
export function formatStatusAdapters(adapters: StatusAdapters, ui: Ui): string[] {
  if (adapters.loaded.length === 0 && adapters.ignored.length === 0) {
    return [];
  }
  const lines: string[] = [ui.bold('declarative adapters (third-party targets):')];
  for (const adapter of adapters.loaded) {
    lines.push(`  ${ui.bold(adapter.id)} (${adapter.layer} layer): ${ui.path(adapter.file)}`);
  }
  for (const adapter of adapters.ignored) {
    lines.push(
      `  ${adapter.id} (${adapter.layer} layer): ${ui.yellow('ignored')} ${ui.dim(
        `(set ${ADAPTER_ALLOW_PROJECT_ENV}=1 to load project-layer adapters)`,
      )}`,
    );
    lines.push(`    ${ui.dim(adapter.file)}`);
  }
  lines.push('');
  return lines;
}
