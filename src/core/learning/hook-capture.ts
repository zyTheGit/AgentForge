/**
 * `learning.auto_capture: hook` 的钩子产物构造（Spec §4.2 / §7.4，§12 Phase 3）。
 *
 * 与 `auto-capture.ts` 的分工：那边只回答"声明档位 → 有效档位"（不知道 target），
 * 这边只回答"hook 档要往 target 配置里写什么"（不知道路径）。落点（哪个文件、
 * 什么动作）归各 projector——三层各自单一职责，新增 target 不必改这里。
 *
 * ---------------------------------------------------------------------------
 * 钩子做什么：把 `## Learning Protocol` 正文在**会话开始时**投递给 agent
 * ---------------------------------------------------------------------------
 *
 * `prompt` 档把协议正文静态嵌进投影规则文件（CLAUDE.md / AGENTS.md 的 marker
 * 区间），模型要在一篇长文档里读到它；`hook` 档改由 target 的 `SessionStart`
 * 钩子在每次会话开始时把同一份正文**动态注入**上下文。两者互斥：
 * `rendersLearningProtocol` 只对 `prompt` 为真，hook 档不再往规则文件里插段
 * （同时注入等于同一份协议出现两遍）。
 *
 * 为什么不在 `SessionEnd` 触发 `aforge learn`：钩子进程在会话结束时拿到的只有
 * transcript 路径，而 §7.4 护栏 4 明确禁止把会话原文写进 learnings（凭据泄漏面 +
 * 条目体积）；此刻模型也已经不能再说话，没有任何东西能产出结构化的条目正文。
 * 会话结束后"自动 capture"在护栏内无法成立，因此本档只做确定性的**协议投递**，
 * 内容仍由 agent 在会话中经 `aforge learn` 自己写。
 *
 * ---------------------------------------------------------------------------
 * 三条硬约束
 * ---------------------------------------------------------------------------
 *
 * 1. **命令是常量，不含任何本机路径**（HOOK_COMMAND）。
 *    - 命令注入面为零：不拼接 rootDir、profile 字段或任何用户数据，因此路径里的
 *      空格 / 引号 / 中文都进不了命令串（见 hook-capture.spec.ts 的注入用例）；
 *    - contentHash 与 sync 产物跨环境稳定：若写 `process.execPath` 或安装目录，
 *      同一份 SoT 在两台机器上会产出不同的钩子文件。裸 `aforge` 交给 PATH 解析，
 *      是**声明驱动**而非探测驱动——sync 不去看本机装没装、装在哪。
 * 2. **钩子命令只读、不取锁**：`aforge learn --print-protocol` 只往 stdout 打印
 *    常量正文，不读 SoT、不写盘、不 promote。因此
 *    - 不与人工 `aforge sync` 争 `.sync.lock`（取锁的是 `promote`，见
 *      `core/learning/promote.withSotLock`）；
 *    - 不触发 `store.ts` 的 CI 守卫（那道守卫只挡 `createLearning`）；
 *    - 无 TTY 也不会挂住（`learn` 的交互采集只在无 `--file` 且 stdin 为 TTY 时进入）。
 * 3. **产物必须可被 prune 完整移除**：`auto_capture` 改回 `off` / `prompt` 后
 *    projector 不再产出该项，§7.6 的 artifacts 差集清理据此删掉整个文件
 *    （前提是产物为独占文件 + `write` 动作，见 codex projector 的落点说明）。
 */
import { LEARNING_PROTOCOL_SECTION } from './auto-capture';

/**
 * 钩子进程执行的命令行（**常量**，不含任何本机路径 / 用户数据）。
 *
 * 裸 `aforge` 而非绝对路径，两条理由：
 * 1. 产物稳定（见文件头约束 1）：写 `process.execPath` 或安装目录会让同一份 SoT 在两台
 *    机器上产出不同的钩子文件，contentHash 与 diff 全都跟着环境变；
 * 2. **PATH 劫持不构成新增攻击面**：能往 PATH 目录里放一个恶意 `aforge` 的攻击者，本来
 *    就有权限直接改 `hooks.json` 的 `command` 字段（两者都是当前用户可写的文件），写绝对
 *    路径挡不住他，只是把入口从「PATH 里放假 aforge」换成「改钩子文件」。因此这里不为
 *    「防劫持」付出产物不稳定的代价。可溯源性另有两处兜底：钩子文件自带
 *    `SESSION_HOOK_DESCRIPTION` 自述行（打开文件即知是谁写的、怎么关），`aforge status`
 *    也会打印钩子的落点路径。
 *
 * 用户若没把 `aforge` 放进 PATH，钩子会静默失败（target 侧把非零退出当作"该钩子没产出
 * 上下文"），不影响会话——这比硬编码一个会在版本切换后失效的路径要好。
 */
export const SESSION_HOOK_COMMAND = 'aforge learn --print-protocol';

/**
 * 钩子事件名（claude / codex 同名，实测见 docs/learning.md 的支持矩阵）。
 *
 * 取 `SessionStart` 而非 `SessionEnd`：会话结束时无法在护栏内产出条目正文
 * （见文件头）。会话开始注入协议才是 hook 档相对 prompt 档的真实增量。
 */
export const SESSION_HOOK_EVENT = 'SessionStart';

/**
 * 事件的 matcher（`startup|resume`）：新会话与 `--resume` / `/resume` 都注入。
 *
 * 刻意**不含** `compact`：压缩后的续跑属于同一会话，协议已经在开头注入过一次，
 * 再注入只是重复占用上下文预算。
 */
export const SESSION_HOOK_MATCHER = 'startup|resume';

/** 钩子在 target UI 上的状态提示（让用户看得见是 AgentForge 在跑，而非来源不明的命令）。 */
export const SESSION_HOOK_STATUS_MESSAGE = 'AgentForge: injecting learning protocol';

/**
 * 注入上下文的字符上限（codex 的 `additionalContextLimit`）。
 *
 * 取值只需覆盖 `LEARNING_PROTOCOL_SECTION` 的长度并留出余量：正文是常量，
 * 不会因 SoT 增长而变长，因此这里是固定值而非按内容计算——计算出来的值会让
 * 钩子文件随正文微调而变，白白制造 diff。
 */
export const SESSION_HOOK_CONTEXT_LIMIT = 4000;

/** 钩子文件里的自述行（用户打开文件时立刻知道是谁写的、怎么关掉）。 */
export const SESSION_HOOK_DESCRIPTION =
  'Managed by AgentForge (learning.auto_capture: hook). Set it back to off or prompt and run aforge sync to remove this file.';

/**
 * 单个钩子条目（claude / codex 共用的 `{ type, command }` 形状）。
 *
 * 抽出类型而不直接构对象字面量：两家的**外层**分组结构不同（见各自 projector），
 * 但内层条目同构，写成一个类型能让"命令 / 状态提示 / 上下文上限只有一处定义"
 * 这件事被类型系统盯住。
 */
export interface SessionHookEntry {
  readonly type: 'command';
  readonly command: string;
  readonly statusMessage: string;
  readonly additionalContextLimit: number;
}

/** AgentForge 声明的钩子条目（常量对象，纯函数每次现造以免调用方改写共享实例）。 */
export function sessionHookEntry(): SessionHookEntry {
  return {
    type: 'command',
    command: SESSION_HOOK_COMMAND,
    statusMessage: SESSION_HOOK_STATUS_MESSAGE,
    additionalContextLimit: SESSION_HOOK_CONTEXT_LIMIT,
  };
}

/**
 * codex `hooks.json` 的完整文件内容（Spec §8.4；实测 codex 0.147.0 接受该形状，
 * 结构非法时 `codex doctor` 直接报 "config could not be loaded"）。
 *
 * 形状：`{ description, hooks: { SessionStart: [{ matcher, hooks: [entry] }] } }`。
 *
 * 为什么是**整文件**而不是往 `config.toml` 里合并标记段：codex 同时支持
 * `hooks.json` 与 inline `[hooks]`，取独立文件后该文件由 AgentForge 独占 →
 * 可以走 `write` 动作，直接落进 §7.6 的 `artifacts` 记账，`auto_capture` 改回
 * `off` 时被 prune 整文件删掉。写 `config.toml` 则要在同一个 plan 里再引入一对
 * 与 MCP 段不同的 TOML 标记，而 `ProjectionPlan.tomlMarkers` 是 plan 级的，
 * 一个 plan 放不下两对标记。
 *
 * 缩进 2 空格 + 尾换行：与 writer.mergeJsonContent 的输出规范一致，避免同一
 * 仓库里两种 JSON 风格。
 */
export function codexSessionHooksJson(): string {
  return `${JSON.stringify(
    {
      description: SESSION_HOOK_DESCRIPTION,
      hooks: {
        [SESSION_HOOK_EVENT]: [{ matcher: SESSION_HOOK_MATCHER, hooks: [sessionHookEntry()] }],
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * 钩子命令要打印的正文（`aforge learn --print-protocol` 的 stdout）。
 *
 * 与 `prompt` 档嵌进规则文件的是**同一个常量**：两档只在投递通道上不同，协议
 * 内容必须一致，否则用户切换档位会拿到两套措辞不同的规则。故这里不加任何包装
 * （不补尾换行——由命令层的 console.log 补，避免多出一个空行）。
 */
export function sessionHookProtocolText(): string {
  return LEARNING_PROTOCOL_SECTION;
}
