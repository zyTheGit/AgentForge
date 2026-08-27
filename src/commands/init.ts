/**
 * aforge init 命令（Spec §7.1 非交互路径；§7.1.1 -i 交互五步，M9）。
 *
 * 非交互：确定 scope 与 SoT 根 → 探测（快照进 habits.detected）→ 创建目录结构
 * （custom/learnings/templates/skills/mcp）→ 原子写 habits.yaml（声明字段空骨架 +
 * detected 快照）与 profile.yaml（windowsDefaultProfile 按 scope 调整）→
 * 打印创建的绝对路径列表。
 *
 * 交互（-i，Spec §7.1.1 五步 ≤5 次确认）：
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
 * - `init-scaffold`：SoT 根解析 / 目录与骨架文件物化 / 非交互入口 runInit；
 * - `init-interactive`：-i 交互五步编排与 targetMainRulePaths；
 * - `init-artifacts`：取消时的产物清单（挂载 / 取回 / 文案）。
 *
 * 这些符号在此 re-export：既有调用方（cli.ts / 测试）继续从 `./commands/init`
 * 单点 import，拆分不改变对外导出面。
 */
import type { Command } from 'commander';
import type { DetectedSnapshot } from '../core/detector/engine';
import type { Scope } from '../core/env';
import { ConfigError } from '../core/errors';
import { assertTty, createClackPrompt, isCancelledError } from '../infra/prompt';
import { VERSION } from '../version';
import { defaultCommandContext, printJson } from './context';
import { resolveJsonFlag } from './flags';
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

/** 探测摘要行（ASCII，两列对齐）。 */
function detectionSummary(d: DetectedSnapshot): string[] {
  const pms = d.package_managers.map((p) => p.name).join(', ');
  const rules = d.existing_rules.length === 0 ? '(none)' : d.existing_rules.join(', ');
  return [
    `  node manager     : ${d.node.manager}`,
    `  python manager   : ${d.python.manager}`,
    `  package managers : ${pms === '' ? '(none)' : pms}`,
    `  shell            : ${d.shell}`,
    `  existing rules   : ${rules}`,
  ];
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('initialize the SoT directory (habits/profile skeletons + detect snapshot)')
    .option('--scope <scope>', 'SoT scope: project or user (default: project)')
    .option('-i, --interactive', 'interactive five-step init (requires a TTY)')
    .option('--json', 'print machine-readable JSON (absolute paths)')
    .action(
      async (
        options: { scope?: string; interactive?: boolean; json?: boolean },
        command: Command,
      ) => {
        const json = resolveJsonFlag(command, options.json);
        let scope: Scope | undefined;
        if (options.scope !== undefined) {
          if (options.scope !== 'project' && options.scope !== 'user') {
            throw new ConfigError(`非法 scope: ${options.scope}`, {
              hint: '有效值: project, user',
            });
          }
          scope = options.scope;
        }

        const baseCtx = defaultCommandContext();

        if (options.interactive === true) {
          // 交互模式：TTY 前置断言（CI / 管道 → ConfigError(2)）→ clack 动态加载
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
            if (json) {
              printJson({ cancelled: true });
            } else {
              console.log('aforge init - cancelled at write confirmation, nothing written');
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

          const lines: string[] = [
            `aforge init - scope: ${result.scope}`,
            `SoT root: ${result.sotRoot}`,
            `targets: ${result.targets.join(', ')}`,
            '',
            'created files:',
            ...result.createdFiles.map((f) => `  ${f}`),
            '',
            'created dirs:',
            ...result.createdDirs.map((d) => `  ${d}`),
            '',
            'detected (snapshot saved to habits.yaml):',
            ...detectionSummary(result.detection),
            '',
            result.synced
              ? 'init complete (sync already executed above)'
              : 'next: run `aforge sync` to project rules to agent targets',
          ];
          console.log(lines.join('\n'));
          return;
        }

        const result = await runInit(baseCtx, { scope });

        if (json) {
          printJson({
            scope: result.scope,
            sotRoot: result.sotRoot,
            createdFiles: result.createdFiles,
            createdDirs: result.createdDirs,
            detection: result.detection,
          });
          return;
        }

        const lines: string[] = [
          `aforge init - scope: ${result.scope}`,
          `SoT root: ${result.sotRoot}`,
          '',
          'created files:',
          ...result.createdFiles.map((f) => `  ${f}`),
          '',
          'created dirs:',
          ...result.createdDirs.map((d) => `  ${d}`),
          '',
          'detected (snapshot saved to habits.yaml):',
          ...detectionSummary(result.detection),
          '',
          'next: run `aforge sync` to project rules to agent targets',
        ];
        console.log(lines.join('\n'));
      },
    );
}
