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
 * 除了「超标即失败」，还会把**接近上限**（默认 >= 上限的 90%）的文件打成 warn。
 * 动机来自一次真实事故：有人用 `Get-Content | Measure-Object -Line` 数行数，那个
 * 口径**不算空行**，比本脚本的物理行数少几十行，于是「离上限还很远」的结论建立在
 * 错数据上。卡口自己报预警值，就不必再有第二套口径去估算余量。
 *
 * 用法：node scripts/check-file-size.mjs [--max N | --max=N] [--report [N]]
 * - 默认：超标 → 退出 1；接近上限 → 打 warn 但退出 0。
 * - `--report`：额外打印行数 Top N（默认 10）的完整榜单，退出码语义不变。
 * 退出码：0 = 全部合规（可能带 warn）；1 = 有超标文件（打印清单与行数）。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 默认上限（与 AGENTS.md / Spec §11.3 的约定保持一致）。 */
const DEFAULT_MAX_LINES = 500;

/**
 * 预警比例：行数 >= 上限 * 0.9（500 → 450）即提示"接近上限"。
 * 90% 而不是 95%：留出的 50 行余量够写完一个中等函数再动手拆，95% 时往往
 * 已经是"这次改动就得先拆"，预警就失去了提前量的意义。
 */
const WARN_RATIO = 0.9;

/** `--report` 不带数值时的默认榜单长度。 */
const DEFAULT_REPORT_TOP_N = 10;

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

/**
 * 解析 `--report`：认 `--report`（用默认 N）、`--report N`、`--report=N`。
 * 与 `--max` 不同，数值是可选的，所以取不到整数时回落默认值而不是报错——
 * `--report --max=300` 这种组合里 `--max=300` 不该被当成榜单长度。
 * 返回 null 表示未开启榜单模式。
 */
function parseReportTopN(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const matched = /^--report(?:=(.*))?$/.exec(argv[i]);
    if (matched === null) {
      continue;
    }
    const parsed = Number.parseInt(matched[1] ?? argv[i + 1], 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REPORT_TOP_N;
  }
  return null;
}

const reportTopN = parseReportTopN(process.argv);
/** 预警线：向上取整，避免 90% 落在小数上时预警范围比声明的更宽。 */
const warnLines = Math.ceil(maxLines * WARN_RATIO);

/** 榜单行尾标记（纯 ASCII：Windows 控制台默认代码页对符号字体不友好）。 */
function flagOf(lines) {
  if (lines > maxLines) {
    return '  <- 超标';
  }
  if (lines >= warnLines) {
    return '  <- 接近上限';
  }
  return '';
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
/** 全量测量结果；按行数降序，超标清单 / 预警清单 / 榜单都从这一份数据切。 */
const measured = [];
for (const file of files) {
  measured.push({
    file: path.relative(repoRoot, file),
    lines: lineCountOf(await readFile(file, 'utf8')),
  });
}
measured.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));

if (reportTopN !== null) {
  console.log(`check-file-size: 行数 Top ${reportTopN}（上限 ${maxLines}，预警线 ${warnLines}）`);
  for (const { file, lines } of measured.slice(0, reportTopN)) {
    console.log(`  ${String(lines).padStart(4)} 行  ${file}${flagOf(lines)}`);
  }
}

const offenders = measured.filter((entry) => entry.lines > maxLines);

if (offenders.length > 0) {
  console.error(`check-file-size: ${offenders.length} 个文件超过 ${maxLines} 行上限：`);
  for (const { file, lines } of offenders) {
    console.error(`  ${lines} 行  ${file}`);
  }
  console.error('按职责拆成多个模块（保持导出面不变），不要靠删注释凑行数。');
  process.exit(1);
}

/** 预警不影响退出码：只是提前告知"下次动它之前先想拆法"。 */
const nearLimit = measured.filter((entry) => entry.lines >= warnLines);
if (nearLimit.length > 0) {
  console.warn(
    `check-file-size: ${nearLimit.length} 个文件接近 ${maxLines} 行上限（>= ${warnLines} 行，即 ${Math.round(WARN_RATIO * 100)}%）：`,
  );
  for (const { file, lines } of nearLimit) {
    console.warn(`  ${lines} 行（余 ${maxLines - lines}）  ${file}`);
  }
}

console.log(`check-file-size: ok (${files.length} 个文件，均 <= ${maxLines} 行)`);
