/**
 * esbuild 轨道：src/main.ts → dist/aforge.js（单文件 bundle，无 npm 包 external）。
 * 产物即 package.json "bin.aforge"，shebang 由 banner 注入。
 *
 * 用 esbuild JS API 而非 npm script 内联 --banner，规避 Windows cmd 的引号解析问题。
 *
 * banner 中注入 createRequire：CJS 依赖（commander/handlebars 等）对 node:* 内置模块的
 * require 在 ESM 产物中会走 esbuild 的 __require shim 并抛
 * "Dynamic require of ... is not supported"，定义模块级 require 即可让 shim 回退到真实现。
 */
import { stat } from 'node:fs/promises';
import { build } from 'esbuild';

const outfile = 'dist/aforge.js';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  sourcemap: false,
  minify: false,
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __aforgeCreateRequire } from 'node:module';",
      'const require = __aforgeCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  legalComments: 'none',
  logLevel: 'info',
});

const { size } = await stat(outfile);
console.log(`esbuild: wrote ${outfile} (${(size / 1024).toFixed(1)} kB)`);
