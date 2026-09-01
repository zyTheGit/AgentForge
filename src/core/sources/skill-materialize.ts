/**
 * skills 物化数据源（Spec §4.2 / §5.3 / §7.6；`always` + Phase 2 `on_demand`）。
 *
 * 从 `core/sources/skill` 拆出来的理由：那个模块管的是「把源里的 skill 目录搬进
 * SoT」（IO 密集、有回滚与安全边界），本模块管的是「sync 该把哪些 SKILL.md 正文
 * 交给 projector」——两件事唯一的共享物是 `skills\<name>\SKILL.md` 这条路径约定
 * （定义在 `core/paths`）。`core/sources/skill` 仍原样再导出本模块的符号，既有
 * 调用点（engine / 测试）不必改 import 路径。
 *
 * ## 两张名单的区别（Phase 2 的核心设计决定）
 *
 * 四家客户端的 skill 加载机制**原生就是按需的**：常驻上下文的只有
 * `name` + `description`，正文只在该技能被选中时才读（claude 的 listing 预算为
 * 上下文窗口 1%、codex 为 2% 或 8000 字符、opencode 把清单放在 `skill` 工具的
 * description 里、pi 明写 "only descriptions are always in context"）。因此
 * 「按需装载」不可能是「AgentForge 自己延迟投影正文」——正文不投影，客户端就
 * 根本找不到它。真正可控的差异只有一件事：**这个技能要不要进模型的自动路由清单。**
 *
 * 于是：
 * - `skills.always`：投影产物**逐字节等于 SoT 的 `SKILL.md`**（本模块不加工），
 *   技能进模型清单，模型自行判断何时使用；
 * - `skills.on_demand`：正文照常投影（否则 `/name` 也调不出来），但在 frontmatter
 *   里注入 `disable-model-invocation: true`（见 `injectOnDemandMarker`）。该键是
 *   Agent Skills 规范里的字段，claude 与 pi 都明确实现：claude 文档的
 *   「Frontmatter / When loaded into context」表写明该键为 true 时
 *   *"Description not in context, full skill loads when you invoke"*，pi 的
 *   frontmatter 表写明 *"skill is hidden from system prompt. Users must use
 *   `/skill:name`"*。codex 的等价开关不在 frontmatter 而在 sidecar
 *   `agents\openai.yaml` 的 `policy.allow_implicit_invocation: false`，由 codex
 *   projector 额外产出一个 write 项。opencode 只认
 *   `name` / `description` / `license` / `compatibility` / `metadata`，未知键一律
 *   忽略——注入对它是**安全的空操作**（技能仍可用，只是仍进模型清单），该降级由
 *   `aforge doctor` 的 `skills-on-demand/opencode-unsupported` 显式告警，不静默。
 *
 * ## 缺失语义（与 `always` 刻意不同）
 *
 * `always` 点名却没装 → `ConfigError(2)` fail-fast（同「未解析的 template id」）。
 * `on_demand` 点名却没装 → **不失败**：跳过该名字、记进 `skips` 由 sync 输出与
 * doctor warn 呈现。这两张名单的定位不同——`on_demand` 就是「备货清单」，允许先
 * 写名字再逐个 `aforge skill add`，用 fail-fast 会让「列了想装的东西」变成
 * 「sync 全线阻塞」。
 */
import path from 'node:path';
import type { Host } from '../../infra/host';
import type { Profile } from '../../schema';
import { ConfigError } from '../errors';
import { SKILL_DOC_FILENAME, SKILLS_DIRNAME } from '../paths';
import { frontmatterRange } from '../project/commands';
import type { SkillArtifact } from '../project/types';

/**
 * 「不进模型自动路由清单」的 frontmatter 键（Agent Skills 规范；claude / pi 实现）。
 *
 * 取值恒为 `true`：本键只在 `on_demand` 的产物里出现，而 `on_demand` 的语义就是
 * 「别自动用它」。`always` 的产物永远不带这一行（回归守卫见 skill-on-demand 单测）。
 */
export const ON_DEMAND_FRONTMATTER_KEY = 'disable-model-invocation';

/** 该键在 frontmatter 顶层的行形态（顶格，不含缩进——缩进的是别的映射的子键）。 */
const ON_DEMAND_KEY_LINE = new RegExp(`^${ON_DEMAND_FRONTMATTER_KEY}[ \\t]*:`);

/** 注入产物的整行文本（单一事实源：断言与实现取同一个常量）。 */
export const ON_DEMAND_FRONTMATTER_LINE = `${ON_DEMAND_FRONTMATTER_KEY}: true`;

/** 参照行的行尾 `\r`（CRLF 文档里插一行纯 LF 会让 frontmatter 出现混合行尾）。 */
function crOf(reference: string | undefined): string {
  return reference?.endsWith('\r') === true ? '\r' : '';
}

/** 某个 `on_demand` 名字未能按预期物化的原因（sync 输出与 doctor 共用同一口径）。 */
export type SkillMaterializeSkipReason =
  /** SoT 两层都没有该技能的 `SKILL.md`：本轮不投影（不像 always 那样 fail-fast）。 */
  | 'not-installed'
  /** 同名已在 `skills.always` 里：按 always 投影（进模型清单），不注入按需标记。 */
  | 'shadowed-by-always'
  /** `SKILL.md` 没有 frontmatter，无处注入：正文照常投影，但按需语义不生效。 */
  | 'no-frontmatter';

/** 单条跳过记录（命令层与 doctor 原样呈现 detail）。 */
export interface SkillMaterializeSkip {
  readonly name: string;
  readonly reason: SkillMaterializeSkipReason;
  /** 人类可读补充（查找过的路径 / 命中的文件），拼进输出与诊断详情。 */
  readonly detail: string;
}

/** 物化结果：交给 projector 的产物 + 未按预期物化的 `on_demand` 名字。 */
export interface SkillsToMaterialize {
  readonly artifacts: readonly SkillArtifact[];
  readonly skips: readonly SkillMaterializeSkip[];
}

/**
 * 在 frontmatter 里注入 `disable-model-invocation: true`（纯函数，幂等）。
 *
 * 做法是**文本行插入**而不是「解析 YAML → 加键 → 重新序列化」：后者会重排键顺序、
 * 丢注释、改引号风格，让投影产物与 SoT 原文出现一堆与本功能无关的差异，`§7.6`
 * prune 的 hash 判据也随 yaml 库版本漂移。行插入只多一行，其余逐字不动。
 *
 * 三种输入：
 * - 有 frontmatter 且无该键 → 在结束 fence 之前插入一行，`injected: true`；
 * - 有 frontmatter 且**已有**该键 → 原样返回、`injected: true`：SoT 自己声明过
 *   （可能显式写了 `false`），尊重用户的显式取值，不覆盖也不重复插入；
 * - 无 frontmatter（首行不是 `---`，或没有结束 fence）→ 原样返回、
 *   `injected: false`。此时四家客户端本来就加载不了这个技能（`description` 必填），
 *   调用方据此记一条 `no-frontmatter` 跳过，但仍照常投影正文——不投影只会让技能
 *   彻底消失，比「投影了但按需语义没生效」更难排查。
 */
export function injectOnDemandMarker(content: string): {
  readonly content: string;
  readonly injected: boolean;
} {
  const range = frontmatterRange(content);
  if (range === null) {
    return { content, injected: false };
  }
  const lines = content.split('\n');
  for (let i = range.start + 1; i < range.end; i += 1) {
    if (ON_DEMAND_KEY_LINE.test(lines[i] ?? '')) {
      return { content, injected: true };
    }
  }
  lines.splice(range.end, 0, `${ON_DEMAND_FRONTMATTER_LINE}${crOf(lines[range.end])}`);
  return { content: lines.join('\n'), injected: true };
}

/**
 * 一层 SoT 里某个 skill 的 `SKILL.md` 候选路径（§5.3：project 优先于 user）。
 *
 * 导出给 doctor：它要判断 `on_demand` 的名字装了没有，但**不能**调
 * readSkillsToMaterialize——那个函数在 `always` 缺失时会抛 ConfigError(2)，而 doctor
 * 的契约是「逐项收集、单项失败不中断」。两处各拼一遍候选路径则会在「哪层优先」上
 * 漂移，故共用这一个纯函数。
 */
export function skillDocCandidates(
  userSoTRoot: string,
  projectSoTRoot: string,
  name: string,
): [string, string] {
  return [
    path.join(projectSoTRoot, SKILLS_DIRNAME, name, SKILL_DOC_FILENAME),
    path.join(userSoTRoot, SKILLS_DIRNAME, name, SKILL_DOC_FILENAME),
  ];
}

/** 按 §5.3 优先级读取 `SKILL.md` 正文；两层都没有 → undefined。 */
async function readSkillDoc(
  host: Host,
  candidates: readonly string[],
): Promise<{ file: string; content: string } | undefined> {
  for (const file of candidates) {
    if (await host.exists(file)) {
      return { file, content: await host.readFile(file) };
    }
  }
  return undefined;
}

/**
 * 读取本轮要物化的 skill 列表（sync 引擎数据源，§5.3：project SoT > user SoT）。
 *
 * 仅消费 `SKILL.md` 正文（projector 产出 write 项；附属文件不投影）。名单顺序即
 * 产物顺序：先 `skills.always`（原文），再 `skills.on_demand`（注入按需标记）。
 *
 * @throws ConfigError(2) `profile.skills.always` 声明的名字两层均不存在
 *         （声明但未安装，fail-fast 同「未解析的 template id」语义）。
 */
export async function readSkillsToMaterialize(
  host: Host,
  userSoTRoot: string,
  projectSoTRoot: string,
  profile: Profile,
): Promise<SkillsToMaterialize> {
  const artifacts: SkillArtifact[] = [];
  const skips: SkillMaterializeSkip[] = [];
  const alwaysNames = profile.skills.always ?? [];

  for (const name of alwaysNames) {
    const candidates = skillDocCandidates(userSoTRoot, projectSoTRoot, name);
    const found = await readSkillDoc(host, candidates);
    if (found === undefined) {
      throw new ConfigError(`profile.skills.always 声明的 skill 未安装: ${name}`, {
        hint: '运行 aforge skill add 安装，或从 profile.yaml 的 skills.always 中移除该名字',
        details: { name, candidates },
      });
    }
    // 逐字节等于 SoT 原文：always 的产物形态不因本功能改变（回归守卫）
    artifacts.push({ name, content: found.content });
  }

  const always = new Set(alwaysNames);
  for (const name of profile.skills.on_demand ?? []) {
    if (always.has(name)) {
      skips.push({
        name,
        reason: 'shadowed-by-always',
        detail: '同名已在 skills.always 中，按 always 投影（仍进模型的自动路由清单）',
      });
      continue;
    }
    const candidates = skillDocCandidates(userSoTRoot, projectSoTRoot, name);
    const found = await readSkillDoc(host, candidates);
    if (found === undefined) {
      skips.push({ name, reason: 'not-installed', detail: candidates.join(' / ') });
      continue;
    }
    const marked = injectOnDemandMarker(found.content);
    if (!marked.injected) {
      skips.push({ name, reason: 'no-frontmatter', detail: found.file });
    }
    artifacts.push({ name, content: marked.content, onDemand: true });
  }

  return { artifacts, skips };
}
