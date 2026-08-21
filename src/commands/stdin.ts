/**
 * 命令层 stdin/TTY 工具（CLI 边缘：允许触碰 process，core 层不感知）。
 *
 * - readStdinText：读全部 stdin（UTF-8）——`--file -` 与 `mcp add --json` 的
 *   输入通道；管道与重定向均可（TTY 挂起由调用方先行判定）；
 * - isInteractiveStdin：stdin 是否为交互终端（无 --file / --json 时交互粘贴
 *   或多行录入的前提；非 TTY 报错走 ConfigError(2)）。
 */

/** 读取 stdin 全部内容（UTF-8 解码；进程 stdin 为流，命令层专用）。 */
export async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** stdin 是否为交互终端（process.stdin.isTTY；缺省 undefined 视为非 TTY）。 */
export function isInteractiveStdin(): boolean {
  return process.stdin.isTTY === true;
}
