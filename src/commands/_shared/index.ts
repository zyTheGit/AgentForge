/**
 * `commands/_shared` 的对外出口。
 *
 * 命令层内部按 SoT 生命周期分了三个域文件夹（lifecycle / assets / knowledge），本
 * 文件夹是它们共用的第四块：注入上下文、标志判定、stdin/TTY 探测。三者都不注册命令，
 * 也不属于任何单一域，故单列并以 `_` 前缀与域文件夹区分。
 *
 * 外部（cli.ts / main.ts / tests）一律 import 到文件夹级；域内文件继续按具体模块
 * 路径引用（`../_shared/context`），以免 barrel 造成域内循环依赖。
 */
export * from './context';
export * from './flags';
export * from './stdin';
