/**
 * `commands/lifecycle` 的对外出口：SoT 从「建起来」到「投影出去」再到「查状态」的
 * 主干命令——init / sync / status / detect / doctor。
 *
 * 只导出 `./init`，不导出 init-scaffold / init-interactive / init-artifacts：后三者是
 * init 的实现拆分，公开面由 init.ts 的 re-export 定义（scaffold 的物化原语如
 * materializeSoT 刻意不在其中）。需要那些内部原语的测试按具体模块路径深引用。
 */
export * from './detect';
export * from './doctor';
export * from './init';
export * from './status';
export * from './sync';
