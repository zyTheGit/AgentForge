/**
 * habits.yaml schema（Spec §4.1）：开发者习惯声明（SoT 的"数据"侧）。
 *
 * - 声明字段优先于 detected（Spec §4.1 规则）；生成规则时模板只通过变量注入，
 *   本模块不管渲染。
 * - 输出形态 Habits：容器对象（runtime/tools/ai/detected/extensions）与 Spec 标注
 *   默认值的字段均已填充；其余标量保持 optional（用户未声明 = 未指定，
 *   渲染层据此省略小节，禁止编造，Spec §5.1）。
 * - 输入形态 HabitsInput：全字段可省略，供合并层保留"未设置"语义。
 */
import { z } from 'zod';
import { SchemaVersion } from './common';

/** Spec §4.1 runtime.node.manager。 */
export const NodeManager = z.enum(['fnm', 'nvm', 'asdf', 'mise', 'n', 'volta', 'system', 'none']);

/** Spec §4.1 runtime.python.manager。 */
export const PythonManager = z.enum([
  'uv',
  'poetry',
  'pipenv',
  'conda',
  'pyenv',
  'asdf',
  'mise',
  'system',
  'none',
]);

/** Spec §4.1 runtime.package_managers 元素（按优先级排列）。 */
export const PackageManager = z.enum(['pnpm', 'bun', 'npm', 'yarn', 'yarn-berry']);

/** Spec §4.1 runtime.rust.manager。 */
export const RustManager = z.enum(['rustup', 'system', 'none']);

/** Spec §4.1 runtime.go.manager。 */
export const GoManager = z.enum(['goenv', 'asdf', 'mise', 'system', 'none']);

/** Spec §4.1 tools.shell。 */
export const Shell = z.enum([
  'powershell',
  'pwsh',
  'cmd',
  'zsh',
  'bash',
  'fish',
  'nushell',
  'other',
]);

/** Spec §4.1 tools.container。 */
export const ContainerTool = z.enum(['docker', 'podman', 'none', 'other']);

/** Spec §4.1 ai.verification 元素。 */
export const VerificationStep = z.enum(['test', 'lint', 'typecheck', 'build', 'format']);

export const HabitsSchema = z.object({
  version: SchemaVersion,
  runtime: z
    .object({
      node: z
        .object({
          manager: NodeManager.optional(),
          version: z.string().optional(),
          notes: z.string().optional(),
        })
        .optional(),
      python: z
        .object({
          manager: PythonManager.optional(),
          version: z.string().optional(),
          notes: z.string().optional(),
        })
        .optional(),
      /** JS 包管理器优先级（数组参与 §4.2 merge.arrays 合并）。 */
      package_managers: z.array(PackageManager).optional(),
      rust: z
        .object({
          toolchain: z.string().optional(),
          manager: RustManager.optional(),
        })
        .optional(),
      go: z
        .object({
          version: z.string().optional(),
          manager: GoManager.optional(),
        })
        .optional(),
    })
    .default({}),
  tools: z
    .object({
      shell: Shell.optional(),
      editor: z.string().optional(),
      git: z
        .object({
          conventional_commits: z.boolean().optional(),
          sign_commits: z.boolean().optional(),
          default_branch: z.string().optional(),
          notes: z.string().optional(),
        })
        .optional(),
      container: ContainerTool.optional(),
    })
    .default({}),
  ai: z
    .object({
      language: z.array(z.string()).optional(),
      style: z.string().optional(),
      verification: z.array(VerificationStep).optional(),
      forbid: z.array(z.string()).optional(),
    })
    .default({}),
  /**
   * 自由文本沉淀（Spec §4.1 notes）：promote(habits_note) 的正式落点，
   * 由 composer 渲染成 `## Notes` 段。
   *
   * 为什么是顶层数组而不是 detected 下的键：`detected` 按 §4.1 是"探测器只读快照"，
   * 往里塞用户沉淀会让 declared/detected 的边界失效（声明字段优先于 detected 这条
   * 规则对它无从适用），也让 doctor 的 declared-vs-detected 比对多出噪声。
   * 内容型数组 → 合并走 merge.arrays（append/replace），与 templates 等一致。
   */
  notes: z.array(z.string()).optional(),
  /** 探测器只读快照（Spec §4.1）：passthrough，键结构由探测器自定。 */
  detected: z.looseObject({}).default({}),
  /** 用户扩展键（Spec §4.1）：passthrough。 */
  extensions: z.looseObject({}).default({}),
});

/** habits.yaml 解析后的完整形态（默认值已填充）。 */
export type Habits = z.output<typeof HabitsSchema>;

/** habits.yaml 的输入形态（字段可省略，合并层使用）。 */
export type HabitsInput = z.input<typeof HabitsSchema>;
