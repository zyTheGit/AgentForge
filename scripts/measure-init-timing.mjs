/**
 * 采集「干净环境 init → 四工具投影可用」的耗时，作为 PRD §8 L1 第 1 条的**主证据**。
 *
 * 为什么需要它：L1 原先写「P90 ≤ 5 分钟，基于 10 名首次用户测试」，那条测试从未执行、
 * 也没有任何可重复的采集手段。方向评审（docs/direction-review.md §3.1）把主证据改成这个
 * 脚本，dogfood 人数降为佐证——脚本负责「同一路径重复跑，数字可核查」，人负责暴露交互卡点。
 *
 * 因此本脚本只测**非交互路径**（`aforge init` 静默档 + `aforge sync`）：
 * 交互耗时按定义无法脚本化，由 dogfood 参与者补。输出里明确标注这一点，避免被当成全量口径。
 *
 * 每一轮都在新的临时目录里跑，且强制离线（`AGF_OFFLINE=1`）：
 * - 临时 home 承担 user 层 SoT，临时 proj 承担项目层，互不污染真实机器；
 * - 「四工具投影可用」的判据不是硬编码四个产物路径（那会随 projector 变），而是
 *   `aforge doctor` 退出码 0——它本身就在比对 SoT 与投影的一致性。doctor 是验证、
 *   不计入门禁耗时，单独打印。
 *
 * 用法：node scripts/measure-init-timing.mjs [--runs N] [--json] [--keep]
 *   --runs N   采集轮数，默认 3（PRD §8 L1 要求 >= 3 名独立 dogfood，脚本侧同口径）
 *   --json     输出机器可读的单行 JSON（供后续回填 PRD / issue）
 *   --keep     保留临时目录（排查用），默认跑完即删
 *
 * 退出码：0 = 达标；1 = 未达标或采集失败（init / sync / doctor 任一非 0）。
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = 'measure-init-timing';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainTs = path.join(repoRoot, 'src', 'main.ts');

/** PRD §8 L1 第 1 条的两个判据（毫秒）：全员 <= 5 分钟，且 P50 <= 3 分钟。 */
const GATE_ALL_MS = 5 * 60 * 1000;
const GATE_P50_MS = 3 * 60 * 1000;
const DEFAULT_RUNS = 3;

/** 认 `--runs N` 与 `--runs=N` 两种形式（与 check-file-size.mjs 同口径）。 */
function parseRuns(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const matched = /^--runs(?:=(.*))?$/.exec(argv[i]);
    if (matched === null) {
      continue;
    }
    return Number.parseInt(matched[1] ?? argv[i + 1], 10);
  }
  return DEFAULT_RUNS;
}

/**
 * 最近秩 P50：排序后取第 ceil(n / 2) 个（1-based）。
 *
 * 不做插值：3–5 个样本下插值出来的小数没有额外信息，反而让「哪一轮是中位」不可回溯。
 */
function p50(sortedMs) {
  return sortedMs[Math.ceil(sortedMs.length / 2) - 1];
}

/** tsx loader 的绝对 file URL——子进程 cwd 在临时目录，相对说明符解析不到。 */
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/**
 * 在临时工作区里跑一次真实 CLI，返回耗时与退出码。
 *
 * 环境隔离与 e2e 同口径：`USERPROFILE` / `HOME` 指向临时 home，`AGF_HOME` 与 `CI`
 * 置空串（readEnv 把全空白当未设置），因此本机的真实配置与 CI 判定都不参与。
 */
function runCli(args, cwd, home) {
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(process.execPath, ['--import', tsxImport, mainTs, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      AGF_HOME: '',
      CI: '',
      AGF_OFFLINE: '1',
    },
  });
  const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
  return { elapsedMs, status: result.status ?? 1, stderr: result.stderr ?? '' };
}

/** 一轮采集：init + sync 计入门禁耗时，doctor 只作「投影可用」判据。 */
async function measureOnce(index, keep) {
  const base = await mkdtemp(path.join(tmpdir(), `aforge-timing-${index}-`));
  const home = path.join(base, 'home');
  try {
    const init = runCli(['init'], base, home);
    if (init.status !== 0) {
      return { failed: `init 退出码 ${init.status}: ${init.stderr.trim()}` };
    }
    // init 在 cwd 落项目层 SoT，因此 sync 的 cwd 与 init 一致
    const sync = runCli(['sync'], base, home);
    if (sync.status !== 0) {
      return { failed: `sync 退出码 ${sync.status}: ${sync.stderr.trim()}` };
    }
    const doctor = runCli(['doctor'], base, home);
    if (doctor.status !== 0) {
      return { failed: `doctor 退出码 ${doctor.status}: ${doctor.stderr.trim()}` };
    }
    return {
      initMs: init.elapsedMs,
      syncMs: sync.elapsedMs,
      doctorMs: doctor.elapsedMs,
      totalMs: init.elapsedMs + sync.elapsedMs,
    };
  } finally {
    if (!keep) {
      await rm(base, { recursive: true, force: true });
    }
  }
}

const runs = parseRuns(process.argv);
if (!Number.isInteger(runs) || runs <= 0) {
  console.error(`${SCRIPT}: --runs 需要正整数`);
  process.exit(1);
}
const asJson = process.argv.includes('--json');
const keep = process.argv.includes('--keep');

const samples = [];
for (let i = 1; i <= runs; i += 1) {
  const result = await measureOnce(i, keep);
  if (result.failed !== undefined) {
    console.error(`${SCRIPT}: 第 ${i} 轮采集失败 — ${result.failed}`);
    process.exit(1);
  }
  samples.push(result);
  if (!asJson) {
    console.log(
      `${SCRIPT}: run ${i} — init ${result.initMs}ms + sync ${result.syncMs}ms ` +
        `= ${result.totalMs}ms (doctor ${result.doctorMs}ms, 不计入门禁)`,
    );
  }
}

const totals = samples.map((sample) => sample.totalMs).sort((a, b) => a - b);
const maxMs = totals[totals.length - 1];
const medianMs = p50(totals);
const passed = maxMs <= GATE_ALL_MS && medianMs <= GATE_P50_MS;

if (asJson) {
  console.log(
    JSON.stringify({
      script: SCRIPT,
      scope: 'non-interactive',
      runs,
      totalsMs: totals,
      maxMs,
      p50Ms: medianMs,
      gateAllMs: GATE_ALL_MS,
      gateP50Ms: GATE_P50_MS,
      passed,
    }),
  );
} else {
  console.log(
    `${SCRIPT}: ${runs} 轮 — max ${maxMs}ms (门禁 ${GATE_ALL_MS}ms)、` +
      `P50 ${medianMs}ms (门禁 ${GATE_P50_MS}ms)`,
  );
  console.warn(`${SCRIPT}: 仅覆盖非交互路径；交互耗时须由 dogfood 参与者补（PRD §8 L1）`);
}

if (!passed) {
  console.error(`${SCRIPT}: 未达标 — 见上方 max / P50 与门禁值`);
  process.exit(1);
}
if (!asJson) {
  console.log(`${SCRIPT}: ok (${runs} 轮均达标)`);
}
