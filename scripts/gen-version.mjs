/**
 * package.json "version" → src/version.ts（版本号单一来源）。
 *
 * 发布流水线以 git tag 为版本唯一来源（tag v1.2.3 → npm version 1.2.3），构建前跑
 * 本脚本把该版本写进源码，避免 package.json 与 --version 输出漂移。
 *
 * 为什么不在运行时读 package.json：bun --compile 产物中该文件不存在（见 src/version.ts）。
 * 为什么不用 esbuild define：bun 轨道不共享 esbuild 配置，且 Windows cmd 下 --define
 * 的引号转义易出错；生成源码文件对两条构建轨道同时生效。
 *
 * --check 模式只校验不写入（供 CI 拦截"改了 package.json 忘了重新生成"）。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionFile = path.join(repoRoot, 'src', 'version.ts');

const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
  console.error('gen-version: package.json 缺少 "version"');
  process.exit(1);
}

const content = `/**
 * CLI 版本号 —— 由 scripts/gen-version.mjs 从 package.json "version" 生成，请勿手改。
 *
 * 独立模块以避免 cli <-> commands 循环依赖；cli.ts 对外 re-export 保持既有导出面。
 * 不在运行时读取 package.json：bun --compile 产物中该文件不存在。
 */
export const VERSION = '${pkg.version}';
`;

const current = await readFile(versionFile, 'utf8').catch(() => null);

if (process.argv.includes('--check')) {
  if (current !== content) {
    console.error(
      `gen-version --check: src/version.ts 与 package.json (${pkg.version}) 不一致，请运行 npm run gen:version`,
    );
    process.exit(1);
  }
  console.log(`gen-version --check: ok (${pkg.version})`);
} else if (current === content) {
  console.log(`gen-version: src/version.ts 已是 ${pkg.version}，跳过写入`);
} else {
  await writeFile(versionFile, content, 'utf8');
  console.log(`gen-version: wrote src/version.ts (${pkg.version})`);
}
