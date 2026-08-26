/**
 * 全局标志读取（Spec §6.2）。
 *
 * `--json` 是 **program 级**全局标志（`aforge --json status`），同时若干子命令
 * 仍各自声明 `--json` 以兼容 `aforge status --json` 这种既有写法。两种位置都要
 * 生效，故统一经 resolveJsonFlag 判定：先看子命令自身的解析结果，再沿 commander
 * 的 parent 链向上找（`aforge --json source list` 的标志挂在 program 上）。
 */
import type { Command } from 'commander';

/**
 * 本次调用是否要求机器可读输出（Spec §6.2 `--json`）。
 *
 * @param command commander 传给 action 的 Command（最后一个参数）。
 * @param localJson 子命令自身 options 里的 json 字段（有则优先为真）。
 */
export function resolveJsonFlag(command: Command | undefined, localJson?: boolean): boolean {
  if (localJson === true) {
    return true;
  }
  let current: Command | null = command ?? null;
  while (current !== null) {
    if ((current.opts() as { json?: boolean }).json === true) {
      return true;
    }
    current = current.parent;
  }
  return false;
}
