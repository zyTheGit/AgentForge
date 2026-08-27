/**
 * bun 轨道：src/main.ts → dist/aforge-<os>-<arch>[.exe]（单文件可执行，内嵌 bun runtime）。
 *
 * 为什么不把 bun 命令内联进 package.json：目标平台有 5 个，逐个写成 npm script
 * 会得到 5 条几乎相同的长命令；且 CI 需要"一次编译出全部目标"的入口。
 *
 * 交叉编译：bun 的 --compile 支持从任一宿主平台产出任一目标（--target=bun-<os>-<arch>），
 * 所以 release 只用一个 ubuntu runner 就能出全部资产。代价是**产出的非宿主平台
 * 二进制无法在编译机上冒烟**：冒烟要在对应平台的 runner 上单独做，没有对应 runner 的
 * 用 docker + QEMU 模拟，矩阵由 `--list` 输出给 release.yml 的 smoke-binaries。
 *
 * 体积说明：产物体积由内嵌的 bun runtime 决定（具体数值见 README），其中 JS 载荷不足
 * 1 MB —— --minify 只影响那不足 1 MB 的部分。想要小体积请走 npm 轨道（dist/aforge.js）。
 */
import { spawnSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';

/** 目标键（`<os>-<arch>`，同时用作产物文件名后缀）→ bun --target 值与冒烟方式。
 *
 * smoke 描述该目标怎么冒烟，也是 release.yml 冒烟矩阵的唯一来源（见 --list）：
 * - `os`：跑冒烟的 GitHub runner 标签；
 * - `platform`：非空表示宿主架构不匹配，要靠 docker + QEMU 在该平台的容器里跑；
 * - `null`：没有免费 runner 也无法模拟，保持"编译产出但不冒烟"。
 */
const TARGETS = {
  'win32-x64': { bunTarget: 'bun-windows-x64', smoke: { os: 'windows-latest', platform: '' } },
  'linux-x64': { bunTarget: 'bun-linux-x64', smoke: { os: 'ubuntu-latest', platform: '' } },
  'linux-arm64': {
    bunTarget: 'bun-linux-arm64',
    smoke: { os: 'ubuntu-latest', platform: 'linux/arm64' },
  },
  // macos runner 自 macos-14 起全是 arm64，x64 冒烟既无 runner 也无法用容器模拟
  'darwin-x64': { bunTarget: 'bun-darwin-x64', smoke: null },
  'darwin-arm64': { bunTarget: 'bun-darwin-arm64', smoke: { os: 'macos-latest', platform: '' } },
};

/** 产物路径：win32 目标带 .exe 后缀（bun 自身也会补），其余无后缀。 */
function outfileFor(key) {
  return `dist/aforge-${key}${key.startsWith('win32') ? '.exe' : ''}`;
}

/**
 * `--list`：按 GitHub Actions `strategy.matrix` 的形状打印冒烟矩阵，
 * 让 release.yml 不必把平台清单再写一遍（`{"include":[{key,bin,os,platform}]}`）。
 */
function smokeMatrix() {
  const include = Object.entries(TARGETS)
    .filter(([, spec]) => spec.smoke !== null)
    .map(([key, spec]) => ({
      key,
      bin: outfileFor(key).slice('dist/'.length),
      os: spec.smoke.os,
      platform: spec.smoke.platform,
    }));
  return { include };
}

function hostKey() {
  const key = `${process.platform}-${process.arch}`;
  if (!(key in TARGETS)) {
    throw new Error(`当前宿主平台无对应 bun target: ${key}；用 --all 或显式指定目标键`);
  }
  return key;
}

function selectedKeys(argv) {
  if (argv.includes('--all')) {
    return Object.keys(TARGETS);
  }
  const explicit = argv.filter((arg) => !arg.startsWith('-'));
  for (const key of explicit) {
    if (!(key in TARGETS)) {
      throw new Error(`未知目标键: ${key}；可选 ${Object.keys(TARGETS).join(' / ')}`);
    }
  }
  return explicit.length > 0 ? explicit : [hostKey()];
}

const argv = process.argv.slice(2);

if (argv.includes('--list')) {
  console.log(JSON.stringify(smokeMatrix()));
  process.exit(0);
}

const keys = selectedKeys(argv);
await mkdir('dist', { recursive: true });

for (const key of keys) {
  const outfile = outfileFor(key);
  const { bunTarget } = TARGETS[key];
  const result = spawnSync(
    'bun',
    [
      'build',
      '--compile',
      `--target=${bunTarget}`,
      '--minify',
      '--outfile',
      outfile,
      'src/main.ts',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' },
  );
  if (result.error !== undefined) {
    throw new Error(`bun 未安装或不可执行（${result.error.message}）；见 https://bun.sh`);
  }
  if (result.status !== 0) {
    throw new Error(`bun build 失败（target=${bunTarget}，exit=${result.status}）`);
  }
  const { size } = await stat(outfile);
  console.log(`bun: wrote ${outfile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}
