/**
 * 命令层共享上下文与输出契约。
 *
 * 各命令的核心逻辑（runXxx）都以「注入 host / cwd / os」的方式实现，方便测试换
 * fake host 与任意平台；CLI action 层再用真实实现装配。原先这套三件套的类型声明
 * 与 `{ host: realHost, cwd: process.cwd(), os: currentOs() }` 字面量在 13 个命令
 * 文件里各写一遍，此处收敛为单一声明。
 *
 * 与 flags.ts 的分工：flags.ts 负责**判定**是否要 JSON 输出（resolveJsonFlag），
 * 本模块的 printJson 只负责**格式化并打印**，两者不重叠。
 */
import type { EnvSnapshot, Scope } from '../core/env';
import { currentOs, type OsContext, resolveProjectSoT, resolveUserSoT } from '../core/paths';
import type { Host } from '../infra/host';
import { realHost } from '../infra/real-host';

/**
 * 命令核心逻辑的注入上下文。
 *
 * - host：全部文件 / 进程 / 环境副作用的唯一出入口；
 * - cwd：项目根（project scope 的 SoT 位置与探测基准）；
 * - os：目标平台（测试可注入 win32/posix 以覆盖两套路径分支）。
 *
 * 需要额外字段的命令（如 sync 的 agentforgeVersion、init -i 的 prompt）
 * 以 `extends CommandContext` 扩展，不要另起一套三件套。
 */
export interface CommandContext {
  readonly host: Host;
  readonly cwd: string;
  readonly os: OsContext;
}

/** 生产装配：真实 Host + 当前进程 cwd 与平台。 */
export function defaultCommandContext(): CommandContext {
  return { host: realHost, cwd: process.cwd(), os: currentOs() };
}

/**
 * `--json` 输出（Spec §6.2 机器可读契约）：2 空格缩进，单次 console.log。
 *
 * 是否走 JSON 分支由 `resolveJsonFlag` 判定，本函数只统一格式。
 */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * 人类可读输出里的「名字列表」一行：空列表 → `(none)`，否则 `', '` 连接。
 *
 * 为什么不直接 `join(', ')`：删到空时（`skill remove` 摘掉最后一个 always、
 * `mcp remove` 移除最后一个 server）裸 join 得到空串，那一行看起来像被截断的
 * 输出而不是「现在这层什么都没有了」。两条 remove 命令都要这个语义，故收敛在此。
 */
export function renderList(items: readonly string[]): string {
  return items.length === 0 ? '(none)' : items.join(', ');
}

/**
 * scope → 该层 SoT 根（纯路径计算，不落盘、不判存在性）。
 *
 * 与 init-scaffold.sotRootForScope 同语义，但入参是通用的 CommandContext 而不是
 * InitContext，故不能直接复用那一个；两条 remove 命令要算「另一层」的 SoT 根来生成
 * 「层选错了」的 hint，各写一遍三元式会让同一判定散在命令层多处。
 */
export function sotRootFor(ctx: CommandContext, env: EnvSnapshot, scope: Scope): string {
  return scope === 'project' ? resolveProjectSoT(ctx.cwd, ctx.os) : resolveUserSoT(env, ctx.os);
}

/** 两层模型里的「另一层」（project ↔ user）。 */
export function otherScope(scope: Scope): Scope {
  return scope === 'project' ? 'user' : 'project';
}
