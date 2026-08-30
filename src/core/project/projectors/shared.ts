/**
 * 四个 projector 共享的 skills 约定（Spec §2.3 / §7.6）。
 *
 * 依赖方向说明：SKILLS_DIRNAME / SKILL_DOC_FILENAME 的**定义**已下沉到
 * `core/paths`（最底层纯路径模块）——SoT 侧消费者（core/sources/skill、
 * core/learning/promote、core/doctor/checks、commands/init）与投影侧消费者
 * （四个 projector）互不依赖，共享物必须落在两者共同的下游；若留在本文件，
 * SoT 侧就得反向 import 一个 projector 内部模块。本文件原样再导出这两个名字，
 * 投影侧调用点保持不变。此处只放"目录/文件名约定 + 纯路径拼装"，无 IO。
 */
import { type PathApi, SKILL_DOC_FILENAME, SKILLS_DIRNAME } from '../../paths';
import { flattenCommandName } from '../commands';
import type { CommandArtifact } from '../types';

export { SKILL_DOC_FILENAME, SKILLS_DIRNAME };

/**
 * 单个 skill 的目标说明文件路径：`<skillsRoot>/<name>/SKILL.md`。
 *
 * 各 target 的差异只在 `skillsRoot`（project / user scope 的 skills 根不同），
 * 末两段拼装完全一致，故由本函数统一。
 *
 * @param api 按目标平台选定的路径 api（`pathApiFor(ctx.os)`）。
 * @param skillsRoot skills 根目录绝对路径。
 * @param name skill 名（目录名）。
 */
export function skillDocPath(api: PathApi, skillsRoot: string, name: string): string {
  return api.join(skillsRoot, name, SKILL_DOC_FILENAME);
}

/**
 * 单个命令薄壳的目标路径（Spec §8.8.1 一名一文件）。
 *
 * 各 target 的差异有两处：`commandsRoot` 的目录名（opencode `command\`、claude
 * `commands\`、pi / codex `prompts\`），以及命名空间的呈现方式（§8.8.2）——
 * claude / opencode 支持子目录，故这里按段拼成 `<root>\<ns...>\<name>.md`；
 * 目录扁平的 pi / codex 用 `flatCommandFilePath`。
 */
export function commandFilePath(
  api: PathApi,
  commandsRoot: string,
  command: CommandArtifact,
): string {
  return api.join(commandsRoot, ...command.namespace, `${command.name}.md`);
}

/**
 * 目录扁平的 target（pi / codex）的命令薄壳路径：命名空间拼进文件名（§8.8.2）。
 *
 * 两家都只扫一层 `prompts\`，建子目录等于命令不存在，因此降级为 `ns-name.md`；
 * 拼接后撞车的情况已在 `resolveCommandsToExpose` 里拦成退出码 2。
 */
export function flatCommandFilePath(
  api: PathApi,
  commandsRoot: string,
  command: CommandArtifact,
): string {
  return api.join(commandsRoot, `${flattenCommandName(command)}.md`);
}
