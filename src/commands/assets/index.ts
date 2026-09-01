/**
 * `commands/assets` 的对外出口：往 SoT 里装素材的命令——source / skill / template / mcp。
 *
 * 只导出四个命令入口，不导出 skill-remove / mcp-prompt：它们分别是 skill 与 mcp 的
 * 实现拆分，公开面已由 skill.ts / mcp.ts 的 re-export 定义，重复导出会撞名。
 */
export * from './mcp';
export * from './skill';
export * from './source';
export * from './template';
