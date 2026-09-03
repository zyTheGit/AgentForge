/**
 * aforge init 命令（Spec §7.1 静默路径；§7.1.1 交互五步，M9）。
 *
 * **模式默认值：TTY 下走交互，非 TTY / `--yes` / `--json` 走静默**（判定见
 * flags.resolveInitMode）。裸 `aforge init` 原先静默选定 scope=project 且把规则投影
 * 给全部四个 target，两者都写进 profile.yaml，而 init 拒绝在非空 SoT 上重跑——默认值
 * 不可撤回，所以有人能应答时先问。
 *
 * 静默：确定 scope 与 SoT 根 → 探测（快照进 habits.detected）→ 创建目录结构
 * （custom/learnings/templates/skills/mcp）→ 原子写 habits.yaml（声明字段空骨架 +
 * detected 快照）与 profile.yaml（windowsDefaultProfile 按 scope 调整）→
 * 打印创建的绝对路径列表、生效的 scope 与 targets（均标注 default 来源）。
 *
 * 交互（Spec §7.1.1 五步 ≤5 次确认）：
 * ① Scope 选择（select，默认 project；--scope / AGF_SCOPE 已给则跳过询问）
 * ② Detector 运行并打印探测结果
 * ③ 确认探测结果（Y 确认 / n 重新探测 / edit 手动编辑——先落盘 habits.yaml
 *    骨架与全部子目录，confirm 等待编辑完成后重新读取）
 * ④ 目标 Agent multiselect（默认全选，hint 显示各 target 主规则绝对路径）
 * ⑤ 写入确认（将创建的文件列表；选 n → cancelled，profile.yaml 不写盘，但 ③
 *    edit 分支已落盘的 habits.yaml 与子目录保留并在结果中回报）→ 可选立即 sync
 *
 * 任一提问处 Ctrl-C / Esc：此前已落盘的产物清单挂到取消错误上回传，命令层打印
 * 后重抛（退出码 130 由 main.ts 统一出口给出）。
 *
 * 交互结果持久化：habits.yaml（探测确认后的 detected 快照 / edit 后的用户
 * 编辑内容）与 profile.yaml（④ 选择的 targets）。
 *
 * SoT 根已存在且非空 → ConfigError(2)（Spec §6.1「init 目录非空」），不覆盖用户
 * 已有内容。正常输出纯 ASCII（Windows GBK 控制台兼容，见 cli.ts 约定）；交互 UI 文案
 * 随 clack 渲染（TTY 环境下 UTF-8）。
 *
 * 模块划分（本文件只留 CLI 装配与输出格式化，其余在同目录）：
 * - `init-scaffold`：SoT 根解析 / 目录与骨架文件物化 / 静默入口 runInit；
 * - `init-interactive`：交互五步编排与 targetMainRulePaths；
 * - `init-artifacts`：取消时的产物清单（挂载 / 取回 / 文案）。
 *
 * 这些符号在此 re-export：既有调用方（cli.ts / 测试）继续从 `./commands/init`
 * 单点 import，拆分不改变对外导出面。
 */
import type { Command } from 'commander';
import type { DetectedSnapshot } from '../../core/detector/engine';
import {
  assertTty,
  createClackPrompt,
  defaultTtyProbe,
  isCancelledError,
} from '../../infra/prompt';
import { getUi, type Ui } from '../../infra/ui';
import { VERSION } from '../../version';
import { defaultCommandContext, printJson } from '../_shared/context';
import { parseScopeOption, resolveInitMode, resolveJsonFlag } from '../_shared/flags';
import { extractInitArtifacts, formatCancelledInitArtifacts } from './init-artifacts';
import { type InitInteractiveResult, runInitInteractive } from './init-interactive';
import { runInit } from './init-scaffold';

export {
  type CancelledInitArtifacts,
  extractInitArtifacts,
  formatCancelledInitArtifacts,
} from './init-artifacts';
export {
  type DetectConfirmAction,
  type InitInteractiveResult,
  type InteractiveInitContext,
  runInitInteractive,
  targetMainRulePaths,
} from './init-interactive';
export {
  type InitContext,
  type InitOptions,
  type InitResult,
  runInit,
  SOT_SUBDIRS,
} from './init-scaffold';

// ---------------------------------------------------------------------------
// CLI 装配（打印逻辑只在 action 层）
// ---------------------------------------------------------------------------

/** 探测摘要行的 label 宽度（`package managers` 最长，冒号同列）。 */
const DETECTION_LABEL_WIDTH = 17;

/** 探测摘要行（两列对齐；未检出项暗色）。 */
function detectionSummary(d: DetectedSnapshot, ui: Ui): string[] {
  const pms = d.package_managers.map((p) => p.name).join(', ');
  const rules = d.existing_rules.length === 0 ? ui.dim('(none)') : d.existing_rules.join(', ');
  const row = (label: string, value: string): string => ui.kv(label, value, DETECTION_LABEL_WIDTH);
  return [
    row('node manager', d.node.manager),
    row('python manager', d.python.manager),
    row('package managers', pms === '' ? ui.dim('(none)') : pms),
    row('shell', d.shell),
    row('existing rules', rules),
  ];
}

/**
 * init 成功输出的公共骨架（scope / SoT 根 / targets / 产物清单 / 探测摘要）。
 *
 * 交互与静默两条路径的这一段完全一致，只有末尾的下一步提示不同（交互可能已顺带
 * sync 过，静默要提醒 targets 取了默认值），故差异由 tail 传入。
 */
function initSummaryLines(
  result: {
    readonly scope: string;
    readonly sotRoot: string;
    readonly targets: readonly string[];
    readonly createdFiles: readonly string[];
    readonly createdDirs: readonly string[];
    readonly detection: DetectedSnapshot;
  },
  tail: readonly string[],
  ui: Ui,
): string[] {
  return [
    `${ui.bold('aforge init')} - scope: ${ui.cyan(result.scope)}`,
    `SoT root: ${ui.path(result.sotRoot)}`,
    `targets: ${ui.cyan(result.targets.join(', '))}`,
    '',
    ui.bold('created files:'),
    ...result.createdFiles.map((f) => `  ${ui.path(f)}`),
    '',
    ui.bold('created dirs:'),
    ...result.createdDirs.map((d) => `  ${ui.path(d)}`),
    '',
    ui.bold('detected (snapshot saved to habits.yaml):'),
    ...detectionSummary(result.detection, ui),
    '',
    ...tail,
  ];
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('initialize the SoT directory (habits/profile skeletons + detect snapshot)')
    .option('--scope <scope>', 'SoT scope: project or user (asked on a TTY; else project)')
    .option('-i, --interactive', 'force the interactive five-step init (default on a TTY)')
    .option('-y, --yes', 'skip all prompts: scope=project, all four targets')
    .option('--json', 'print machine-readable JSON (absolute paths; silent unless -i is given)')
    .action(
      async (
        options: { scope?: string; interactive?: boolean; yes?: boolean; json?: boolean },
        command: Command,
      ) => {
        const json = resolveJsonFlag(command, options.json);
        const scope = parseScopeOption(options.scope);
        const mode = resolveInitMode({
          interactive: options.interactive,
          yes: options.yes,
          json,
          isTty: defaultTtyProbe().isInteractive(),
        });

        const baseCtx = defaultCommandContext();

        if (mode === 'interactive') {
          // TTY 前置断言：`-i` 显式指定但环境非 TTY（CI / 管道）→ ConfigError(2)。
          // 无 `-i` 时 resolveInitMode 已按 isTty 判定，此处必然通过。
          assertTty();
          const prompt = await createClackPrompt();
          let result: InitInteractiveResult;
          try {
            result = await runInitInteractive(
              { ...baseCtx, prompt, agentforgeVersion: VERSION },
              { scope },
            );
          } catch (err) {
            // Ctrl-C / Esc：打印已落盘产物清单后重抛（退出码 130 由 main.ts 给出）
            if (isCancelledError(err)) {
              const artifacts = extractInitArtifacts(err);
              if (json) {
                printJson({
                  cancelled: true,
                  interrupted: true,
                  createdFiles: artifacts?.createdFiles ?? [],
                  createdDirs: artifacts?.createdDirs ?? [],
                });
              } else {
                console.error(formatCancelledInitArtifacts(artifacts).join('\n'));
              }
            }
            throw err;
          }

          if (result.cancelled) {
            // 写入确认处选 n 时产物已在交互侧回滚（committed 恒 false），result 的
            // 两个清单此时是**残留**项（常态空）。不能无条件打印 "nothing written"——
            // 回滚失败时磁盘上确有东西，而 SoT 根非空会让重跑 init 撞
            // ConfigError(2)，用户必须看见。
            const leftover = {
              createdFiles: result.createdFiles,
              createdDirs: result.createdDirs,
              committed: false,
            };
            if (json) {
              printJson({ cancelled: true, ...leftover });
            } else {
              console.log(formatCancelledInitArtifacts(leftover).join('\n'));
            }
            return;
          }

          if (json) {
            printJson({
              scope: result.scope,
              sotRoot: result.sotRoot,
              targets: result.targets,
              createdFiles: result.createdFiles,
              createdDirs: result.createdDirs,
              detection: result.detection,
              cancelled: false,
              synced: result.synced,
            });
            return;
          }

          const ui = getUi();
          const lines = initSummaryLines(
            result,
            [
              result.synced
                ? ui.green('init complete (sync already executed above)')
                : ui.next(`run ${ui.code('aforge sync')} to project rules to agent targets`),
            ],
            ui,
          );
          console.log(lines.join('\n'));
          return;
        }

        const result = await runInit(baseCtx, { scope });

        if (json) {
          printJson({
            scope: result.scope,
            sotRoot: result.sotRoot,
            targets: result.targets,
            createdFiles: result.createdFiles,
            createdDirs: result.createdDirs,
            detection: result.detection,
          });
          return;
        }

        const ui = getUi();
        const lines = initSummaryLines(
          result,
          [
            // 静默路径未经询问就把 targets 定成全部四个并写进 profile.yaml，而 init
            // 拒绝在非空 SoT 上重跑——必须告诉用户改法。只说 targets 不说 scope：
            // scope 可能来自 --scope 或 AGF_SCOPE，声称它「取了默认」会是假话；
            // targets 在静默路径恒为默认（windowsDefaultProfile），说它永远成立。
            // 指引给「删目录后重跑」而非直接 `init -i`：SoT 已非空，直接重跑必被
            // resolveFreshSoTRoot 抛 ConfigError(2)（与 init-artifacts 同一口径）。
            // `-y` 是用户自己点名要默认值，不再复述。
            ...(options.yes === true
              ? []
              : [
                  ui.yellow(
                    `note: targets took the default (all four) - to choose, delete ${result.sotRoot} and rerun \`aforge init\` on a TTY`,
                  ),
                ]),
            ui.next(`run ${ui.code('aforge sync')} to project rules to agent targets`),
          ],
          ui,
        );
        console.log(lines.join('\n'));
      },
    );
}
