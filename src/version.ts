/**
 * CLI 版本号 —— 由 scripts/gen-version.mjs 从 package.json "version" 生成，请勿手改。
 *
 * 独立模块以避免 cli <-> commands 循环依赖；cli.ts 对外 re-export 保持既有导出面。
 * 不在运行时读取 package.json：bun --compile 产物中该文件不存在。
 */
export const VERSION = '0.2.2-rc.1';
