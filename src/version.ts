/**
 * CLI 版本号（与 package.json "version" 保持同步）。
 *
 * 独立模块以避免 cli ↔ commands 循环依赖；cli.ts 对外 re-export 保持既有导出面。
 * 不在运行时读取 package.json：bun --compile 产物中该文件不存在。
 */
export const VERSION = '0.1.0';
