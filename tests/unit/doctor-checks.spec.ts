/**
 * Doctor 检查引擎单测（Spec §9，fake host + 宿主平台路径）：
 * 聚合退出码（doctorExitCode）/ 初始化 / 坏 YAML / 未解析模板 / OneDrive /
 * 投影 hash 三方比对（§8.2-4 基准）/ 声明 vs detected / merge_json 损坏 /
 * 目标目录不可写（EACCES → 4）。
 *
 * 注：路径一律经 node:path 动态构造（Windows / POSIX CI 均可跑，同 engine.spec）。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type DoctorCheckResult,
  type DoctorReport,
  doctorExitCode,
  runDoctorChecks,
} from '../../src/core/doctor/checks';
import { readEnv } from '../../src/core/env';
import { currentOs } from '../../src/core/paths';
import { syncOnce } from '../../src/core/project/engine';
import { createFakeHost, errnoError, type FakeHost } from './test-utils';

const OS = currentOs();
const HOME = path.resolve('/home/u');
const CWD = path.resolve('/proj');
const USER_SOT = path.join(HOME, '.agentforge');
const PROJECT_SOT = path.join(CWD, '.agentforge');
const CLAUDE_MD = path.join(CWD, 'CLAUDE.md');
const USER_CLAUDE_MD = path.join(HOME, '.claude', 'CLAUDE.md');
const CLAUDE_MCP = path.join(CWD, '.mcp.json');

const PROFILE_YAML = 'version: 1\nscope: project\ntargets: [claude]\n';
const HABITS_YAML = 'version: 1\n';

/** 目录感知 listDir 的 fake host（Windows 反斜杠 key 兼容，同 engine.spec）。 */
function createDoctorHost(env: Record<string, string> = {}): FakeHost {
  const base = createFakeHost({ USERPROFILE: HOME, ...env });
  const host: FakeHost = {
    ...base,
    async listDir(p) {
      const prefix = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
      const names = new Set<string>();
      for (const key of base.files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (rest === '') {
            continue;
          }
          const sep = rest.search(/[\\/]/);
          names.add(sep === -1 ? rest : rest.slice(0, sep));
        }
      }
      return [...names].sort();
    },
  };
  return host;
}

/** 布置一个已初始化的 project SoT（profile + habits）。 */
async function seedProjectSoT(host: FakeHost, profile = PROFILE_YAML): Promise<void> {
  await host.writeFile(path.join(PROJECT_SOT, 'profile.yaml'), profile);
  await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
}

function doctorOpts(host: FakeHost): {
  host: FakeHost;
  env: ReturnType<typeof readEnv>;
  os: typeof OS;
  cwd: string;
} {
  return { host, env: readEnv(host), os: OS, cwd: CWD };
}

/** 取指定 item 的检查结果（不存在 → 断言失败并打印全部 item 便于定位）。 */
function resultOf(report: DoctorReport, item: string): DoctorCheckResult {
  const found = report.results.find((r) => r.item === item);
  if (found === undefined) {
    throw new Error(
      `doctor result not found: ${item} (items: ${report.results.map((r) => r.item).join(', ')})`,
    );
  }
  return found;
}

/** 建立已 sync 基准：seed → syncOnce（写 CLAUDE.md + sync-meta）。 */
async function seedSynced(host: FakeHost): Promise<void> {
  await seedProjectSoT(host);
  await syncOnce({
    host,
    env: readEnv(host),
    os: OS,
    cwd: CWD,
    agentforgeVersion: 'test-0.1.0',
    dryRun: false,
  });
}

describe('doctorExitCode — 聚合退出码（§6.1 映射）', () => {
  const entry = (
    level: DoctorCheckResult['level'],
    code?: DoctorCheckResult['code'],
  ): DoctorCheckResult => ({
    section: 'config',
    level,
    item: 'x',
    detail: '',
    ...(code === undefined ? {} : { code }),
  });

  it('空结果 → 0', () => {
    expect(doctorExitCode([])).toBe(0);
  });

  it('仅 ok / warn → 0', () => {
    expect(doctorExitCode([entry('ok'), entry('warn')])).toBe(0);
  });

  it('单个 error(2) → 2；error 无 code → 默认 2', () => {
    expect(doctorExitCode([entry('error', 2)])).toBe(2);
    expect(doctorExitCode([entry('error')])).toBe(2);
  });

  it('error(3) 与 error(2) 并存 → 3（Conflict 高于 Config）', () => {
    expect(doctorExitCode([entry('error', 2), entry('error', 3)])).toBe(3);
  });

  it('error(4) 与 error(3) 并存 → 4（Permission 最高）', () => {
    expect(doctorExitCode([entry('error', 3), entry('error', 4), entry('warn')])).toBe(4);
  });
});

describe('runDoctorChecks — 初始化与坏 YAML', () => {
  it('未初始化（两层均无）→ initialization error(2)，exitCode 2，提前终止', async () => {
    const report = await runDoctorChecks(doctorOpts(createDoctorHost()));
    const init = resultOf(report, 'initialization');
    expect(init.level).toBe('error');
    expect(init.code).toBe(2);
    expect(init.hint).toContain('aforge init');
    // 提前返回：除 user-sot-root / initialization 外不应有其他条目
    const others = report.results.filter(
      (r) => r.item !== 'initialization' && r.item !== 'user-sot-root',
    );
    expect(others).toEqual([]);
    expect(report.exitCode).toBe(2);
  });

  it('坏 profile.yaml → yaml/project/profile.yaml error(2)，后续装配跳过', async () => {
    const host = createDoctorHost();
    await host.writeFile(path.join(PROJECT_SOT, 'profile.yaml'), 'version: 1\ntargets: [claude\n');
    await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
    const report = await runDoctorChecks(doctorOpts(host));
    const bad = resultOf(report, 'yaml/project/profile.yaml');
    expect(bad.level).toBe('error');
    expect(bad.code).toBe(2);
    expect(report.results.some((r) => r.item === 'path/claude')).toBe(false);
    expect(report.exitCode).toBe(2);
  });

  it('坏 habits.yaml（user 层）→ yaml/user/habits.yaml error(2)', async () => {
    const host = createDoctorHost();
    await host.writeFile(path.join(USER_SOT, 'profile.yaml'), 'version: 1\ntargets: [claude]\n');
    await host.writeFile(path.join(USER_SOT, 'habits.yaml'), 'version: 1\nruntime: [\n');
    const report = await runDoctorChecks(doctorOpts(host));
    const bad = resultOf(report, 'yaml/user/habits.yaml');
    expect(bad.level).toBe('error');
    expect(bad.code).toBe(2);
    expect(report.exitCode).toBe(2);
  });
});

describe('runDoctorChecks — 健康 SoT 全绿', () => {
  it('初始化 + 路径 + 模板 + sync-meta + 环境均 ok，exitCode 0', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host);
    const report = await runDoctorChecks(doctorOpts(host));

    expect(resultOf(report, 'initialization').level).toBe('ok');

    const paths = resultOf(report, 'path/claude');
    expect(paths.level).toBe('ok');
    expect(paths.detail).toContain(CLAUDE_MD);
    expect(paths.detail).toContain(USER_CLAUDE_MD);

    expect(resultOf(report, 'templates').level).toBe('ok');
    expect(resultOf(report, 'sync-meta').level).toBe('ok'); // 尚未 sync（不存在 → 信息性 ok）
    expect(resultOf(report, 'declared-vs-detected').level).toBe('ok');
    expect(resultOf(report, 'onedrive').level).toBe('ok');
    expect(report.exitCode).toBe(0);
  });

  it('目标目录可写（探针写删成功）→ writable ok', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host);
    const report = await runDoctorChecks(doctorOpts(host));
    const writables = report.results.filter((r) => r.item === 'writable');
    expect(writables.length).toBeGreaterThan(0);
    expect(writables.every((r) => r.level === 'ok')).toBe(true);
    // 探针文件不应残留
    expect([...host.files.keys()].some((k) => k.includes('.agf-doctor-probe-'))).toBe(false);
  });
});

describe('runDoctorChecks — 未解析模板（§9 第 5 条）', () => {
  it('profile.templates 引用不存在的 id → template/<id> error(2)，exitCode 2', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(
      host,
      'version: 1\nscope: project\ntargets: [claude]\ntemplates: [no-such-template]\n',
    );
    const report = await runDoctorChecks(doctorOpts(host));
    const bad = resultOf(report, 'template/no-such-template');
    expect(bad.level).toBe('error');
    expect(bad.code).toBe(2);
    expect(bad.detail).toContain('no-such-template');
    expect(report.exitCode).toBe(2);
  });
});

describe('runDoctorChecks — OneDrive（§2.1.1）', () => {
  it('用户目录在 OneDrive 下 → onedrive warn（不影响退出码）', async () => {
    const odHome = path.resolve('/home/OneDrive/u');
    const host = createDoctorHost({ USERPROFILE: odHome });
    const odSot = path.join(odHome, '.agentforge');
    await host.writeFile(path.join(odSot, 'profile.yaml'), PROFILE_YAML);
    await host.writeFile(path.join(odSot, 'habits.yaml'), HABITS_YAML);
    const report = await runDoctorChecks(doctorOpts(host));
    const od = resultOf(report, 'onedrive');
    expect(od.level).toBe('warn');
    expect(od.detail).toContain(odHome);
    expect(od.hint).toContain('OneDrive');
  });
});

describe('runDoctorChecks — 投影 hash 三方比对（§8.2-4 基准）', () => {
  it('刚 sync 完 → projection-hash/claude ok（区间 = 记录 = 当前渲染）', async () => {
    const host = createDoctorHost();
    await seedSynced(host);
    const report = await runDoctorChecks(doctorOpts(host));
    expect(resultOf(report, 'projection-hash/claude').level).toBe('ok');
    expect(report.exitCode).toBe(0);
  });

  it('marker 区间被手动修改 → warn（hash 与上次 sync 记录不符）', async () => {
    const host = createDoctorHost();
    await seedSynced(host);
    const content = host.files.get(CLAUDE_MD) as string;
    host.files.set(CLAUDE_MD, content.replace('# AgentForge Rules', '# Tampered Rules'));
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'projection-hash/claude');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('hash 不一致');
    expect(r.hint).toContain('--force');
    expect(report.exitCode).toBe(0); // warn 不抬升退出码（§9：提示级）
  });

  it('SoT 在上次 sync 后变更 → warn（投影可能过期）', async () => {
    const host = createDoctorHost();
    await seedSynced(host);
    await host.writeFile(path.join(PROJECT_SOT, 'custom', 'extra.md'), '# Extra\n');
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'projection-hash/claude');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('过期');
    expect(r.hint).toContain('aforge sync');
  });

  it('投影文件被删除 → warn（投影文件不存在）', async () => {
    const host = createDoctorHost();
    await seedSynced(host);
    await host.rm(CLAUDE_MD);
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'projection-hash/claude');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('不存在');
  });

  it('投影文件 marker 区间被整体移除 → warn（无 marker 区间）', async () => {
    const host = createDoctorHost();
    await seedSynced(host);
    host.files.set(CLAUDE_MD, '# Unrelated content\n');
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'projection-hash/claude');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('无 marker 区间');
  });
});

describe('runDoctorChecks — marker_mode: none 时 plan 与 sync 一致（buildPlanCtx 必须注入 markerMode）', () => {
  const NONE_PROFILE = [
    'version: 1',
    'scope: project',
    'targets: [claude]',
    'projection:',
    '  marker_mode: none',
    '',
  ].join('\n');

  it('marker_mode: none → 主规则动作降级为 write，doctor 不再按 merge_marker 比对（无 marker 误报）', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host, NONE_PROFILE);
    await syncOnce({
      host,
      env: readEnv(host),
      os: OS,
      cwd: CWD,
      agentforgeVersion: 'test-0.1.0',
      dryRun: false,
    });

    // sync 的实际产物：整文件 write，无 marker 区间
    const projected = host.files.get(CLAUDE_MD) ?? '';
    expect(projected).not.toContain('BEGIN AGENTFORGE');

    const report = await runDoctorChecks(doctorOpts(host));
    // buildPlanCtx 漏传 markerMode 时 plan 仍产出 merge_marker →
    // checkOneProjectionFile 会在这份无 marker 的投影上误报"无 marker 区间"
    const markerChecks = report.results.filter((r) => r.item.startsWith('projection-hash/'));
    expect(markerChecks).toEqual([]);
    expect(report.results.some((r) => r.detail.includes('无 marker 区间'))).toBe(false);
    expect(report.exitCode).toBe(0);
  });

  it('缺省 marker_mode（replace_between_markers）仍按 marker 区间比对 → projection-hash/claude ok', async () => {
    const host = createDoctorHost();
    await seedSynced(host);
    expect(host.files.get(CLAUDE_MD) ?? '').toContain('BEGIN AGENTFORGE');
    const report = await runDoctorChecks(doctorOpts(host));
    expect(resultOf(report, 'projection-hash/claude').level).toBe('ok');
  });
});

describe('runDoctorChecks — 声明 vs detected（§4.1 声明优先，仅提示）', () => {
  it('声明 fnm 但 detected 快照为 nvm → declared-vs-detected/node warn', async () => {
    const host = createDoctorHost();
    await host.writeFile(path.join(PROJECT_SOT, 'profile.yaml'), PROFILE_YAML);
    await host.writeFile(
      path.join(PROJECT_SOT, 'habits.yaml'),
      [
        'version: 1',
        'runtime:',
        '  node:',
        '    manager: fnm',
        'detected:',
        '  node:',
        '    manager: nvm',
        '',
      ].join('\n'),
    );
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'declared-vs-detected/node');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('fnm');
    expect(r.detail).toContain('nvm');
    expect(r.hint).toContain('aforge detect');
  });
});

describe('runDoctorChecks — merge_json 投影损坏（硬项 error(3)）', () => {
  it('claude .mcp.json 无法解析 → merge-json/claude error(3)，exitCode 3', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host);
    await host.writeFile(CLAUDE_MCP, '{ broken json');
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'merge-json/claude');
    expect(r.level).toBe('error');
    expect(r.code).toBe(3);
    expect(report.exitCode).toBe(3);
  });
});

describe('runDoctorChecks — 可写性（§9 第 2 条）', () => {
  it('目标目录不可写（EACCES）→ writable error(4)，exitCode 4', async () => {
    const base = createDoctorHost();
    await seedProjectSoT(base);
    const hostile: FakeHost = {
      ...base,
      async writeFile(p, content) {
        if (p.startsWith(`${CWD}${path.sep}`)) {
          throw errnoError('EACCES', `permission denied: ${p}`);
        }
        await base.writeFile(p, content);
      },
    };
    const report = await runDoctorChecks(doctorOpts(hostile));
    const broken = report.results.filter((r) => r.item === 'writable' && r.level === 'error');
    expect(broken.length).toBeGreaterThan(0);
    expect(broken.every((r) => r.code === 4)).toBe(true);
    expect(broken[0]?.detail).toContain('不可写');
    expect(report.exitCode).toBe(4);
  });
});

describe('runDoctorChecks — 可写性探针（P3：残留清理 + 并发安全）', () => {
  /** 记录所有探针文件名的 host（探针 = 以 .agf-doctor-probe- 开头的写入）。 */
  function withProbeRecorder(base: FakeHost, probes: string[]): FakeHost {
    return {
      ...base,
      async writeFile(p, content) {
        if (path.basename(p).startsWith('.agf-doctor-probe-')) {
          probes.push(path.basename(p));
        }
        await base.writeFile(p, content);
      },
    };
  }

  it('探针文件名带随机后缀 → 两次（并发）doctor 的探针互不撞名', async () => {
    const base = createDoctorHost();
    await seedProjectSoT(base);
    const probes: string[] = [];
    const host = withProbeRecorder(base, probes);

    await runDoctorChecks(doctorOpts(host));
    await runDoctorChecks(doctorOpts(host));

    expect(probes.length).toBeGreaterThan(1);
    expect(new Set(probes).size).toBe(probes.length); // 全部唯一（仅毫秒时间戳会撞名）
    expect(probes.every((name) => /^\.agf-doctor-probe-\d+-[0-9a-f]{12}$/.test(name))).toBe(true);
    expect([...base.files.keys()].some((k) => k.includes('.agf-doctor-probe-'))).toBe(false);
  });

  it('探针删除失败 → 仍判定可写（写入成功即可写；清理失败不改变结论）', async () => {
    const base = createDoctorHost();
    await seedProjectSoT(base);
    const host: FakeHost = {
      ...base,
      async rm(p) {
        if (path.basename(p).startsWith('.agf-doctor-probe-')) {
          throw errnoError('EPERM', `permission denied: ${p}`);
        }
        await base.rm(p);
      },
    };

    const report = await runDoctorChecks(doctorOpts(host));
    const writables = report.results.filter((r) => r.item === 'writable');
    expect(writables.length).toBeGreaterThan(0);
    expect(writables.every((r) => r.level === 'ok')).toBe(true);
    expect(report.exitCode).toBe(0);
  });

  it('探针写入抛错（不可写）→ error(4)，且不留探针残留（finally 清理）', async () => {
    const base = createDoctorHost();
    await seedProjectSoT(base);
    const host: FakeHost = {
      ...base,
      async writeFile(p, content) {
        if (
          path.basename(p).startsWith('.agf-doctor-probe-') &&
          p.startsWith(`${CWD}${path.sep}`)
        ) {
          throw errnoError('EACCES', `permission denied: ${p}`);
        }
        await base.writeFile(p, content);
      },
    };

    const report = await runDoctorChecks(doctorOpts(host));
    expect(report.results.some((r) => r.item === 'writable' && r.level === 'error')).toBe(true);
    expect([...base.files.keys()].some((k) => k.includes('.agf-doctor-probe-'))).toBe(false);
  });
});

describe('runDoctorChecks — broken symlink（§9 symlink 失败检查）', () => {
  it('skills/ 目录无 symlink → broken-symlink ok', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host);
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'broken-symlink');
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('未发现断开');
  });

  it('skills/ 目录有断开的 symlink → broken-symlink warn', async () => {
    const base = createDoctorHost();
    await seedProjectSoT(base);
    // 模拟一个 broken symlink：lstat 返回 isSymbolicLink=true，exists 返回 false
    const brokenLink = path.join(PROJECT_SOT, 'skills', 'broken-skill');
    const host: FakeHost = {
      ...base,
      async listDir(p) {
        if (p === path.join(PROJECT_SOT, 'skills')) {
          return ['broken-skill'];
        }
        return base.listDir(p);
      },
      async lstat(p) {
        if (p === brokenLink) {
          return { isFile: false, isDirectory: false, isSymbolicLink: true, size: 0, mtimeMs: 0 };
        }
        return base.lstat(p);
      },
      async readlink(p) {
        if (p === brokenLink) {
          return '/nonexistent/target';
        }
        return base.readlink(p);
      },
      async exists(p) {
        if (p === brokenLink) {
          return false; // symlink 目标不存在
        }
        return base.exists(p);
      },
    };
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'broken-symlink');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('断开');
    expect(r.detail).toContain('broken-skill');
    expect(r.hint).toContain('copy_mode');
    expect(report.exitCode).toBe(0); // warn 不抬升退出码
  });

  it('PI_CODING_AGENT_DIR 置位 → warn（未置位时不产出该项）', async () => {
    const withVar = createFakeHost({
      HOME,
      PI_CODING_AGENT_DIR: path.join(HOME, 'custom-pi'),
    });
    await seedProjectSoT(withVar);
    const withVarReport = await runDoctorChecks(doctorOpts(withVar));
    const r = resultOf(withVarReport, 'pi-coding-agent-dir');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('custom-pi');
    expect(r.hint).toContain('user scope');
    expect(withVarReport.exitCode).toBe(0); // warn 不抬升退出码

    // 未置位：不产出该项（避免给没用 pi 的用户增加噪音）
    const without = createFakeHost({ HOME });
    await seedProjectSoT(without);
    const withoutReport = await runDoctorChecks(doctorOpts(without));
    expect(withoutReport.results.some((x) => x.item === 'pi-coding-agent-dir')).toBe(false);
  });
});
