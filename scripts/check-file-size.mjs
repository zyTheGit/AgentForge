/**
 * 源码文件体积卡口：src/ 下任一 .ts 文件不得超过 MAX_LINES 行。
 *
 * 为什么要卡：单文件越长，人和 AI 读它的成本都是超线性上涨——定位一处改动要先
 * 翻完整个文件，评审 diff 也看不出改的是哪一层职责。行数是个粗糙但零成本的代理
 * 指标，超标即说明该文件承担了多个职责，应按职责拆模块（而不是把注释删掉凑行数）。
 *
 * 只管 src/：tests/ 里一个 spec 文件对应一个被测模块，用例堆叠导致的长度不代表
 * 职责不清。统计范围是 src/ 下**全部** .ts（含生成的 version.ts 与 .d.ts），
 * dist/ 与 tests/ 不在范围内；当前不提供豁免名单。
 *
 * 用法：node scripts/check-file-size.mjs [--max N | --max=N]
 * 退出码：0 = 全部合规；1 = 有超标文件（打印清单与行数）。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 默认上限（与 AGENTS.md / Spec §11.3 的约定保持一致）。 */
const DEFAULT_MAX_LINES = 500;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');

/**
 * 解析 `--max`：同时认 `--max N`（空格分隔）与 `--max=N`（等号形式）。
 * 只认前者时 `--max=300` 会静默回落默认值并打印一条与实际不符的 ok。
 * 取值本身交下方的整数校验兜住（`--max=abc` → 报错退出）。
 */
function parseMaxLines(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const matched = /^--max(?:=(.*))?$/.exec(argv[i]);
    if (matched === null) {
      continue;
    }
    return Number.parseInt(matched[1] ?? argv[i + 1], 10);
  }
  return DEFAULT_MAX_LINES;
}

const maxLines = parseMaxLines(process.argv);
if (!Number.isInteger(maxLines) || maxLines <= 0) {
  console.error('check-file-size: --max 需要正整数');
  process.exit(1);
}

/** 递归收集 src/ 下的 .ts 文件（不跟随 symlink，目录顺序稳定化便于输出可比对）。 */
async function collectTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** 行数按换行符切分后去掉末尾空串（与 `wc -l` / 编辑器行号一致）。 */
function lineCountOf(content) {
  const lines = content.split(/\r?\n/);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

const files = await collectTsFiles(srcRoot);
const offenders = [];
for (const file of files) {
  const lines = lineCountOf(await readFile(file, 'utf8'));
  if (lines > maxLines) {
    offenders.push({ file: path.relative(repoRoot, file), lines });
  }
}

if (offenders.length > 0) {
  console.error(`check-file-size: ${offenders.length} 个文件超过 ${maxLines} 行上限：`);
  for (const { file, lines } of offenders.sort((a, b) => b.lines - a.lines)) {
    console.error(`  ${lines} 行  ${file}`);
  }
  console.error('按职责拆成多个模块（保持导出面不变），不要靠删注释凑行数。');
  process.exit(1);
}

console.log(`check-file-size: ok (${files.length} 个文件，均 <= ${maxLines} 行)`);
