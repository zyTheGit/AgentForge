/**
 * doctor 的声明式适配器检查项，以及**报告不被截断**这条硬要求（issue #53）。
 *
 * 背景（PR #59 的教训）：`checkTargetPaths` 里一条 ConfigError 冒到 `runDoctorChecks`
 * 之外，把整份报告一起带走了——诊断工具在最需要它的时刻整份消失，是最坏的失效模式。
 * 声明式适配器把「用户可写的数据」引进了路径计算链路，同类风险被显著放大，所以这里
 * 逐个失效点验证：报告条数只增不减。
 *
 * 三层防线各有用例：
 * 1. 加载阶段永不抛（见 loader.spec）；失败进进程级报告；
 * 2. `checkDeclarativeAdapters` 零 IO，只读报告 → 不可能自己失败；
 * 3. `checkTargetPaths` / `collectEnabledPlans` 逐 projector try/catch，
 *    `runConfigDependentChecks` 整块兜住。
 */
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetAdapterLoadReport,
  setAdapterLoadReport,
} from '../../../src/core/adapters/diagnostics';
import {
  loadDeclarativeAdapters,
  resetDeclarativeAdapterState,
} from '../../../src/core/adapters/loader';
import { checkDeclarativeAdapters } from '../../../src/core/doctor/check-adapters';
import type { DoctorCheckResult, DoctorReport } from '../../../src/core/doctor/check-types';
import { runDoctorChecks } from '../../../src/core/doctor/checks';
import { readEnv } from '../../../src/core/env';
import { ExitCode } from '../../../src/core/errors';
import { currentOs } from '../../../src/core/paths';
import type { Projector } from '../../../src/core/project/types';
import { Registry } from '../../../src/core/registry';
import { createFakeHost, type FakeHost } from '../test-utils';

const OS = currentOs();
const HOME = path.resolve('/home/u');
const CWD = path.resolve('/proj');
const USER_SOT = path.join(HOME, '.agentforge');
const PROJECT_SOT = path.join(CWD, '.agentforge');
const USER_ADAPTERS = path.join(USER_SOT, 'adapters');
const PROJECT_ADAPTERS = path.join(PROJECT_SOT, 'adapters');

/** 目录感知 listDir 的 fake host（同 doctor-checks.spec 的口径）。 */
function createDoctorHost(env: Record<string, string> = {}): FakeHost {
  const base = createFakeHost({ USERPROFILE: HOME, HOME, ...env });
  return {
    ...base,
    async listDir(p: string): Promise<string[]> {
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
}

async function seedProjectSoT(host: FakeHost, targets = '[claude]'): Promise<void> {
  await host.writeFile(
    path.join(PROJECT_SOT, 'profile.yaml'),
    `version: 1\nscope: project\ntargets: ${targets}\n`,
  );
  await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), 'version: 1\n');
}

function adapterYaml(id: string): string {
  return [
    'version: 1',
    `id: ${id}`,
    'scopes:',
    '  project:',
    '    base: "{projectRoot}/.my"',
    '    skills_dir: "{base}/skills"',
    '    main_rule: "{base}/AGENTS.md"',
  ].join('\n');
}

/** 用注入的容器加载（不污染全局 projectorRegistry，同文件可多轮）。 */
async function loadWith(host: FakeHost): Promise<void> {
  await loadDeclarativeAdapters({
    host,
    env: readEnv(host, OS),
    os: OS,
    cwd: CWD,
    registry: new Registry<Projector>(),
  });
}

async function doctor(host: FakeHost): Promise<DoctorReport> {
  return runDoctorChecks({ host, env: readEnv(host, OS), os: OS, cwd: CWD });
}

function itemsOf(report: DoctorReport): string[] {
  return report.results.map((r) => r.item);
}

function resultOf(report: DoctorReport, item: string): DoctorCheckResult {
  const found = report.results.find((r) => r.item === item);
  if (found === undefined) {
    throw new Error(`doctor result not found: ${item} (items: ${itemsOf(report).join(', ')})`);
  }
  return found;
}

beforeEach(() => {
  resetDeclarativeAdapterState();
});

describe('checkDeclarativeAdapters — 三类条目', () => {
  it('一个适配器都没有 → ok 条目 + 说明扫过哪些目录（"我明明放了文件"的第一线索）', () => {
    setAdapterLoadReport({
      loaded: [],
      ignored: [],
      failures: [],
      scanned: [USER_ADAPTERS, PROJECT_ADAPTERS],
    });
    const results: DoctorCheckResult[] = [];
    checkDeclarativeAdapters(results);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ level: 'ok', item: 'adapters/loaded' });
    expect(results[0]?.detail).toContain('declarative adapters: none');
    expect(results[0]?.detail).toContain(USER_ADAPTERS);
    expect(results[0]?.hint).toContain('adapters/');
  });

  it('已加载 → ok 条目逐条列出 id / 层 / 来源文件', () => {
    setAdapterLoadReport({
      loaded: [{ id: 'my-agent', file: path.join(USER_ADAPTERS, 'my-agent.yaml'), layer: 'user' }],
      ignored: [],
      failures: [],
      scanned: [USER_ADAPTERS],
    });
    const results: DoctorCheckResult[] = [];
    checkDeclarativeAdapters(results);
    expect(results[0]?.detail).toContain('my-agent (user) <-');
  });

  it('project 层被忽略 → warn 条目 + 授权办法（默默不加载会被当成文件写错了）', () => {
    setAdapterLoadReport({
      loaded: [],
      ignored: [
        {
          id: 'team-agent',
          file: path.join(PROJECT_ADAPTERS, 'team-agent.yaml'),
          layer: 'project',
          reason: 'project-layer-not-authorized',
        },
      ],
      failures: [],
      scanned: [USER_ADAPTERS, PROJECT_ADAPTERS],
    });
    const results: DoctorCheckResult[] = [];
    checkDeclarativeAdapters(results);
    const warn = results.find((r) => r.item === 'adapters/ignored/team-agent');
    expect(warn?.level).toBe('warn');
    expect(warn?.hint).toContain('AGF_ALLOW_PROJECT_ADAPTERS=1');
  });

  it('加载失败 → error 条目，退出码按成因分（装配冲突 1 / 内容 2）', () => {
    setAdapterLoadReport({
      loaded: [],
      ignored: [],
      failures: [
        { id: 'a', file: 'a.yaml', layer: 'user', kind: 'yaml', message: 'm', hint: 'h' },
        {
          id: 'claude',
          file: 'claude.yaml',
          layer: 'user',
          kind: 'builtin-id',
          message: 'm',
          hint: 'h',
        },
      ],
      scanned: [],
    });
    const results: DoctorCheckResult[] = [];
    checkDeclarativeAdapters(results);
    expect(resultLike(results, 'adapters/a')).toMatchObject({
      level: 'error',
      code: ExitCode.Config,
    });
    expect(resultLike(results, 'adapters/claude')).toMatchObject({
      level: 'error',
      code: ExitCode.Generic,
    });
  });

  function resultLike(results: DoctorCheckResult[], item: string): DoctorCheckResult {
    const found = results.find((r) => r.item === item);
    if (found === undefined) {
      throw new Error(`missing ${item}`);
    }
    return found;
  }
});

describe('runDoctorChecks — 适配器坏掉时报告不被截断', () => {
  /**
   * 基线条数：同样的 SoT、没有任何适配器时 doctor 报出多少条。
   *
   * 每条用例现算一遍而不是共享一个模块级变量：用例间共享可变状态会让「谁先跑」
   * 影响断言，而这组用例正是在验证「不该少报」——判据自己不能不稳。
   */
  async function baselineCount(): Promise<number> {
    resetAdapterLoadReport();
    const host = createDoctorHost();
    await seedProjectSoT(host);
    return (await doctor(host)).results.length;
  }

  it('基线：无适配器时 doctor 全绿，且已含 adapters/loaded 条目', async () => {
    resetAdapterLoadReport();
    const host = createDoctorHost();
    await seedProjectSoT(host);
    const report = await doctor(host);
    expect(report.exitCode).toBe(0);
    expect(itemsOf(report)).toContain('adapters/loaded');
    expect(report.results.length).toBeGreaterThan(10);
  });

  it('坏 YAML 适配器 → 多一条 adapters/<id> error，其余检查**全部照跑**', async () => {
    const baseline = await baselineCount();
    resetDeclarativeAdapterState();
    const host = createDoctorHost();
    await seedProjectSoT(host);
    await host.writeFile(path.join(USER_ADAPTERS, 'broken.yaml'), 'id: [oops\n');
    await loadWith(host);

    const report = await doctor(host);
    expect(resultOf(report, 'adapters/broken').level).toBe('error');
    expect(report.exitCode).toBe(ExitCode.Config);
    // 关键断言：条数只增不减（报告没被那条 ConfigError 带走）
    expect(report.results.length).toBeGreaterThanOrEqual(baseline);
    for (const item of ['adapters/loaded', 'onedrive']) {
      expect(itemsOf(report), item).toContain(item);
    }
  });

  it('id 撞内置的适配器 → error(1)，报告仍完整（gate 只在 sync 侧 fail-fast）', async () => {
    const baseline = await baselineCount();
    resetDeclarativeAdapterState();
    const host = createDoctorHost();
    await seedProjectSoT(host);
    await host.writeFile(path.join(USER_ADAPTERS, 'claude.yaml'), adapterYaml('claude'));
    await loadWith(host);

    const report = await doctor(host);
    expect(resultOf(report, 'adapters/claude')).toMatchObject({
      level: 'error',
      code: ExitCode.Generic,
    });
    expect(report.results.length).toBeGreaterThanOrEqual(baseline);
  });

  it('profile 写了未注册的 target → 报出可区分的成因，且报告其余部分照跑', async () => {
    resetDeclarativeAdapterState();
    const host = createDoctorHost();
    await seedProjectSoT(host, '[ghost]');
    await loadWith(host);

    const report = await doctor(host);
    // 坏 profile 由 YAML 检查逐文件报出，消息即 TargetEnum 的诊断文案——用户能直接
    // 看出是「打错了」还是「适配器文件没被加载」，而不是只知道「取值非法」
    const profileError = report.results.find(
      (r) => r.level === 'error' && r.detail.includes('ghost'),
    );
    expect(profileError?.detail).toContain('没有对应的声明式适配器文件');
    expect(profileError?.detail).toContain('adapters/ghost.yaml');
    // 适配器诊断条目仍在（「aforge 到底扫了哪儿」）
    expect(itemsOf(report)).toContain('adapters/loaded');
    // 装配失败之后的检查（不依赖配置的那批）照样跑完
    expect(itemsOf(report)).toContain('onedrive');
  });

  it('project 层未授权适配器 → warn 不影响退出码（0），且在报告里可见', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host);
    await host.writeFile(path.join(PROJECT_ADAPTERS, 'team-agent.yaml'), adapterYaml('team-agent'));
    await loadWith(host);

    const report = await doctor(host);
    expect(resultOf(report, 'adapters/ignored/team-agent').level).toBe('warn');
    expect(report.exitCode).toBe(0);
  });

  it('适配器报告为空（从未加载）→ doctor 照常给出 ok 条目，不报错', async () => {
    resetAdapterLoadReport();
    const host = createDoctorHost();
    await seedProjectSoT(host);
    const report = await doctor(host);
    expect(resultOf(report, 'adapters/loaded').level).toBe('ok');
    expect(report.exitCode).toBe(0);
  });
});

describe('runDoctorChecks — 声明式 id × MCP transport 矩阵（PRD 适配器扩展 Phase 0 护栏）', () => {
  /** 三种 transport 各一个 enabled server：unmeasured 仍应只报一条（不逐 server 刷屏）。 */
  const THREE_SERVERS = [
    '    - name: fs',
    '      transport: stdio',
    '      command: fs-server',
    '    - name: api',
    '      transport: http',
    '      url: https://example.com/mcp',
    '    - name: ev',
    '      transport: sse',
    '      url: https://example.com/sse',
  ].join('\n');

  async function seedWithMcp(host: FakeHost, targets: string, servers: string): Promise<void> {
    await host.writeFile(
      path.join(PROJECT_SOT, 'profile.yaml'),
      `version: 1\nscope: project\ntargets: ${targets}\nmcp:\n  servers:\n${servers}\n`,
    );
    await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), 'version: 1\n');
  }

  /** 声明了 `mcp_file` 的适配器（有 MCP 落点 → `writesMcp: true`）。 */
  function adapterYamlWithMcp(id: string): string {
    return [
      'version: 1',
      `id: ${id}`,
      'mcp:',
      '  dialect: mcpServers',
      'scopes:',
      '  project:',
      '    base: "{projectRoot}/.my"',
      '    skills_dir: "{base}/skills"',
      '    main_rule: "{base}/AGENTS.md"',
      '    mcp_file: "{base}/mcp.json"',
    ].join('\n');
  }

  it('声明式 id + enabled server → 不崩溃，且不把它算进「已实测」', async () => {
    const host = createDoctorHost();
    await host.writeFile(path.join(USER_ADAPTERS, 'my-agent.yaml'), adapterYamlWithMcp('my-agent'));
    await loadWith(host);
    await seedWithMcp(host, '[claude, my-agent]', THREE_SERVERS);

    const report = await doctor(host);
    // 此前这里是 TypeError：整份报告被带走，doctor 在最需要它的时刻整份消失
    expect(report.exitCode).toBe(0);
    // 已实测 target 的结论照常给，且只点名已实测的那些
    const ok = resultOf(report, 'mcp-transport');
    expect(ok.level).toBe('ok');
    expect(ok.detail).toContain('claude');
    expect(ok.detail).not.toContain('my-agent');
    // 本 spec 用注入的 Registry 加载（不污染全局 projectorRegistry），而 doctor 的能力
    // 查询走全局注册表——所以这里看不到 unmeasured warn。「有 mcp_file 就报一条」的
    // 正向断言在 sync-notices.spec.ts（那层可注入 projector 名单）
    expect(report.results.filter((r) => r.item.endsWith('-unmeasured'))).toEqual([]);
  });

  it('没有 mcp_file 的适配器 → 不出 unmeasured（它压根没有 MCP 产物）', async () => {
    const host = createDoctorHost();
    // adapterYaml 只声明 main_rule / skills_dir，无 mcp_file → writesMcp: false
    await host.writeFile(
      path.join(USER_ADAPTERS, 'no-mcp-agent.yaml'),
      adapterYaml('no-mcp-agent'),
    );
    await loadWith(host);
    await seedWithMcp(host, '[claude, no-mcp-agent]', THREE_SERVERS);

    const report = await doctor(host);
    expect(report.exitCode).toBe(0);
    // 报一条它无法消除、且 hint 指向不存在产物的提示，比不报更糟
    expect(report.results.filter((r) => r.item.endsWith('-unmeasured'))).toEqual([]);
  });

  it('声明式 id 但没有 MCP server → 不出 unmeasured（没内容就没得说）', async () => {
    const host = createDoctorHost();
    await host.writeFile(path.join(USER_ADAPTERS, 'my-agent.yaml'), adapterYamlWithMcp('my-agent'));
    await loadWith(host);
    await seedProjectSoT(host, '[claude, my-agent]');

    const report = await doctor(host);
    expect(report.exitCode).toBe(0);
    expect(report.results.filter((r) => r.item.endsWith('-unmeasured'))).toEqual([]);
  });

  it('声明了 server 但全部 enabled: false → 不把声明式 id 说成「已实测」', async () => {
    const host = createDoctorHost();
    await host.writeFile(path.join(USER_ADAPTERS, 'my-agent.yaml'), adapterYamlWithMcp('my-agent'));
    await loadWith(host);
    await seedWithMcp(
      host,
      '[claude, my-agent]',
      '    - name: fs\n      transport: stdio\n      command: fs-server\n      enabled: false',
    );

    const report = await doctor(host);
    expect(report.exitCode).toBe(0);
    // 一条都不投影：既不该报 unmeasured，也不该说「N 个 server 均可无损表达」
    expect(report.results.filter((r) => r.item.endsWith('-unmeasured'))).toEqual([]);
    const ok = resultOf(report, 'mcp-transport');
    expect(ok.level).toBe('ok');
    expect(ok.detail).toContain('全部 enabled: false');
    expect(ok.detail).not.toContain('my-agent');
    expect(ok.detail).not.toContain('无损表达');
  });
});
