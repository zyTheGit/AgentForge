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
import type { EffectiveConfig } from '../../src/core/config/defaults';
import {
  checkCommandsExposure,
  checkLearningAutoCapture,
  SESSION_HOOK_INLINE_ITEM,
} from '../../src/core/doctor/check-consistency';
import { checkClaudeUserScopeMcp } from '../../src/core/doctor/check-mcp-transport';
import {
  type DoctorCheckResult,
  type DoctorReport,
  doctorExitCode,
  runDoctorChecks,
} from '../../src/core/doctor/checks';
import { readEnv } from '../../src/core/env';
import { ExitCode } from '../../src/core/errors';
import { currentOs } from '../../src/core/paths';
import { syncOnce } from '../../src/core/project/engine';
import { projectorRegistry } from '../../src/core/project/projectors/registry';
import { CLAUDE_USER_MCP_NOTICE_ITEM } from '../../src/core/project/sync-notices';
import { BUILTIN_TARGET_IDS } from '../../src/core/project/target-ids';
import { HabitsSchema, type Profile, ProfileSchema } from '../../src/schema';
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

describe('runDoctorChecks — skills.copy_mode: symlink 恒被忽略且不实现（§4.2）', () => {
  it('copy_mode: symlink → skills-copy-mode warn，且不影响退出码', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(
      host,
      'version: 1\nscope: project\ntargets: [claude]\nskills:\n  copy_mode: symlink\n',
    );
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'skills-copy-mode');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('symlink');
    expect(r.hint).toContain('copy');
    // 投影结果本身是正确的（恒实体 copy），只是与声明不符 → warn 不参与 §6.1 码聚合
    expect(report.exitCode).toBe(0);
  });

  it('copy_mode 未声明（schema 默认 copy）→ skills-copy-mode ok', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host);
    const r = resultOf(await runDoctorChecks(doctorOpts(host)), 'skills-copy-mode');
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('copy');
  });
});

describe('runDoctorChecks — skills.on_demand 按需装载（Phase 2，§4.2）', () => {
  /** 布置一个已安装的 skill（project 层）。 */
  async function installSkill(host: FakeHost, name: string, doc: string): Promise<void> {
    await host.writeFile(path.join(PROJECT_SOT, 'skills', name, 'SKILL.md'), doc);
  }

  const GOOD_DOC = '---\nname: lazy\ndescription: 备货技能\n---\n正文\n';

  it('未声明 → skills-on-demand ok（单条，不产出逐名条目）', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host);
    const r = resultOf(await runDoctorChecks(doctorOpts(host)), 'skills-on-demand');
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('未声明');
  });

  it('声明且已安装 → ok 并说明"投影正文 + 不进模型自动路由清单"', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(
      host,
      'version: 1\nscope: project\ntargets: [claude]\nskills:\n  on_demand: [lazy]\n',
    );
    await installSkill(host, 'lazy', GOOD_DOC);

    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'skills-on-demand');
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('lazy');
    expect(r.detail).toContain('disable-model-invocation');
    expect(report.exitCode).toBe(0);
  });

  it('声明但未安装 → 逐名 warn（列出查找路径 + skill add 提示），不影响退出码', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(
      host,
      'version: 1\nscope: project\ntargets: [claude]\nskills:\n  on_demand: [ghost]\n',
    );

    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'skills-on-demand/ghost');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain(path.join(PROJECT_SOT, 'skills', 'ghost', 'SKILL.md'));
    expect(r.hint).toContain('aforge skill add');
    // 与 always 的 fail-fast 刻意不同：备货清单缺项不该阻塞 sync
    expect(report.exitCode).toBe(0);
  });

  it('同名同时在 always 与 on_demand → profile 直接校验失败（error 2），不再是 warn', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(
      host,
      'version: 1\nscope: project\ntargets: [claude]\nskills:\n  always: [lazy]\n  on_demand: [lazy]\n',
    );
    await installSkill(host, 'lazy', GOOD_DOC);

    // 两张名单语义互斥，属于声明层的不变式违反 → schema superRefine 在加载阶段就拒掉
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'yaml/project/profile.yaml');
    expect(r.level).toBe('error');
    expect(r.detail).toContain('skills.on_demand');
    expect(r.detail).toContain('lazy');
    expect(report.exitCode).toBe(ExitCode.Config);
  });

  it('SKILL.md 无 frontmatter → warn（正文照常投影，但无处注入按需标记）', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(
      host,
      'version: 1\nscope: project\ntargets: [claude]\nskills:\n  on_demand: [bare]\n',
    );
    await installSkill(host, 'bare', '# 裸文档\n');

    const r = resultOf(await runDoctorChecks(doctorOpts(host)), 'skills-on-demand/bare');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('frontmatter');
  });

  it('opencode 启用 + 有生效的 on_demand → 降级 warn（该 target 无对应开关）', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(
      host,
      'version: 1\nscope: project\ntargets: [claude, opencode]\nskills:\n  on_demand: [lazy]\n',
    );
    await installSkill(host, 'lazy', GOOD_DOC);

    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'skills-on-demand/opencode-unsupported');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('lazy');
    expect(r.hint).toContain('permission.skill');
    expect(report.exitCode).toBe(0);
  });

  it('opencode 未启用 → 不产出降级 warn', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(
      host,
      'version: 1\nscope: project\ntargets: [claude]\nskills:\n  on_demand: [lazy]\n',
    );
    await installSkill(host, 'lazy', GOOD_DOC);

    const report = await runDoctorChecks(doctorOpts(host));
    expect(
      report.results.some((item) => item.item === 'skills-on-demand/opencode-unsupported'),
    ).toBe(false);
  });
});

describe('runDoctorChecks — learning.auto_capture（§7.4 / §9）', () => {
  const profileWithCapture = (value: string) =>
    `version: 1\nscope: project\ntargets: [claude]\nlearning:\n  auto_capture: ${value}\n`;

  it('hook + 仅启用 claude → learning-auto-capture-hook warn（等同 off），不影响退出码', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host, profileWithCapture('hook'));
    const report = await runDoctorChecks(doctorOpts(host));
    // 档位本身如实报 ok（三档都生效），降级发生在 target 粒度
    const tier = resultOf(report, 'learning-auto-capture');
    expect(tier.level).toBe('ok');
    expect(tier.detail).toContain('hook');
    const hook = resultOf(report, 'learning-auto-capture-hook');
    expect(hook.level).toBe('warn');
    expect(hook.detail).toContain('claude');
    expect(hook.hint).toContain('prompt');
    expect(report.exitCode).toBe(0);
  });

  it('hook + 启用 codex → 无降级 warn，ok 里点名钩子落在 codex', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(
      host,
      'version: 1\nscope: project\ntargets: [codex]\nlearning:\n  auto_capture: hook\n',
    );
    const report = await runDoctorChecks(doctorOpts(host));
    const tier = resultOf(report, 'learning-auto-capture');
    expect(tier.level).toBe('ok');
    expect(tier.detail).toContain('codex');
    expect(tier.detail).toContain('SessionStart');
    expect(report.results.some((r) => r.item === 'learning-auto-capture-hook')).toBe(false);
    expect(report.exitCode).toBe(0);
  });

  it('prompt → ok 并说明投影正文含 Learning Protocol 段', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host, profileWithCapture('prompt'));
    const r = resultOf(await runDoctorChecks(doctorOpts(host)), 'learning-auto-capture');
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('Learning Protocol');
  });

  it('CI 为真 → 生效档位不变，仅补一句"本次不会写入"（护栏 3 只挡写入）', async () => {
    const host = createDoctorHost({ CI: '1' });
    await seedProjectSoT(host, profileWithCapture('prompt'));
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'learning-auto-capture');
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('prompt');
    expect(r.detail).toContain('Learning Protocol');
    expect(r.detail).toContain('CI');
    expect(report.exitCode).toBe(0);
  });

  it('缺省（off）→ ok，且不提 Learning Protocol', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host);
    const r = resultOf(await runDoctorChecks(doctorOpts(host)), 'learning-auto-capture');
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('off');
    expect(r.detail).not.toContain('Learning Protocol');
  });

  it('hook + CI → ok 里仍带上"本次不会写入"（与 status 的 ciNote 口径一致）', async () => {
    const host = createDoctorHost({ CI: '1' });
    await seedProjectSoT(host, profileWithCapture('hook'));
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'learning-auto-capture');
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('CI');
    expect(report.exitCode).toBe(0);
  });

  it('prompt + auto_promote: true → 额外一条撞锁 warn，不影响退出码', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(
      host,
      'version: 1\nscope: project\ntargets: [claude]\nlearning:\n  auto_capture: prompt\n  auto_promote: true\n',
    );
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'learning-auto-capture-lock');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('.sync.lock');
    expect(r.hint).toContain('--no-auto-promote');
    expect(report.exitCode).toBe(0);
  });

  it('prompt + auto_promote 缺省（false）→ 不报撞锁 warn', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host, profileWithCapture('prompt'));
    const report = await runDoctorChecks(doctorOpts(host));
    expect(report.results.some((r) => r.item === 'learning-auto-capture-lock')).toBe(false);
  });
});

describe('runDoctorChecks — MCP transport 能力落差（Phase 2「MCP 字段与上游对齐」）', () => {
  const profileWithServers = (targets: string, servers: string) =>
    `version: 1\nscope: project\ntargets: [${targets}]\nmcp:\n  servers:\n${servers}`;
  const SSE_SERVER = '    - name: docs\n      transport: sse\n      url: https://example.com/sse\n';
  const HTTP_SERVER =
    '    - name: docs\n      transport: http\n      url: https://example.com/mcp\n';

  it('未声明 mcp.servers → 单条 ok', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host);
    const r = resultOf(await runDoctorChecks(doctorOpts(host)), 'mcp-transport');
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('profile.mcp.servers');
  });

  it('全部 transport 都可无损表达 → 单条 ok（不逐 server 刷屏）', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host, profileWithServers('claude, opencode, codex', HTTP_SERVER));
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'mcp-transport');
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('无损表达');
    expect(report.results.some((x) => x.item.startsWith('mcp-transport/'))).toBe(false);
  });

  it('sse × codex → warn 且说明整条跳过；warn 不影响退出码', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host, profileWithServers('codex', SSE_SERVER));
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'mcp-transport/codex/docs');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('SSE');
    expect(r.detail).toContain('整条跳过');
    expect(r.hint).toContain('transport: http');
    expect(report.exitCode).toBe(0);
  });

  it('sse × opencode → warn 且说明仍投影但降级', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host, profileWithServers('opencode', SSE_SERVER));
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'mcp-transport/opencode/docs');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('降级');
    expect(report.exitCode).toBe(0);
  });

  it('同一 server 在多 target 各出一条（codex 跳过 + opencode 降级），claude / pi 无落差', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host, profileWithServers('claude, opencode, codex, pi', SSE_SERVER));
    const report = await runDoctorChecks(doctorOpts(host));
    const items = report.results
      .filter((r) => r.item.startsWith('mcp-transport/'))
      .map((r) => r.item);
    expect(items).toEqual(['mcp-transport/opencode/docs', 'mcp-transport/codex/docs']);
  });

  it('enabled: false 的 server 不报落差', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host, profileWithServers('codex', `${SSE_SERVER}      enabled: false\n`));
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'mcp-transport');
    expect(r.level).toBe('ok');
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

  it('AGF_HOME 落在 OneDrive 下、用户目录不在 → 仍然 warn（Issue #51 第 4 条）', async () => {
    // 修好之前 checkOneDrive 只看 env.userProfile，这条完全沉默——而它的 hint 恰恰叫用户
    // 「把 AGF_HOME 与项目目录移出 OneDrive」，检查面比承诺的窄一圈
    const odSotRoot = path.resolve('/od/OneDrive/af-home');
    const host = createDoctorHost({ AGF_HOME: odSotRoot });
    await seedProjectSoT(host);
    const od = resultOf(await runDoctorChecks(doctorOpts(host)), 'onedrive');
    expect(od.level).toBe('warn');
    expect(od.detail).toContain('用户级 SoT 根');
    expect(od.detail).toContain(odSotRoot);
  });

  it('ok 文案列出实际检查过的三条路径（用户目录 / 用户级 SoT 根 / 项目目录）', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host);
    const od = resultOf(await runDoctorChecks(doctorOpts(host)), 'onedrive');
    expect(od.level).toBe('ok');
    expect(od.detail).toContain('项目目录');
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

describe('runDoctorChecks — skills/ symlink（§9）', () => {
  it('skills/ 目录无 symlink → skills-symlink ok', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host);
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'skills-symlink');
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('未发现 symlink');
  });

  /** skills/ 下放一个 symlink 条目：targetExists 决定它是断开的还是仍有效的。 */
  function hostWithSkillSymlink(
    base: FakeHost,
    name: string,
    target: string,
    targetExists: boolean,
  ): FakeHost {
    const link = path.join(PROJECT_SOT, 'skills', name);
    return {
      ...base,
      async listDir(p) {
        if (p === path.join(PROJECT_SOT, 'skills')) {
          return [name];
        }
        return base.listDir(p);
      },
      async lstat(p) {
        if (p === link) {
          return { isFile: false, isDirectory: false, isSymbolicLink: true, size: 0, mtimeMs: 0 };
        }
        return base.lstat(p);
      },
      async readlink(p) {
        if (p === link) {
          return target;
        }
        return base.readlink(p);
      },
      async exists(p) {
        if (p === link) {
          return targetExists;
        }
        return base.exists(p);
      },
    };
  }

  it('skills/ 目录有断开的 symlink → skills-symlink warn', async () => {
    const base = createDoctorHost();
    await seedProjectSoT(base);
    const host = hostWithSkillSymlink(base, 'broken-skill', '/nonexistent/target', false);
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'skills-symlink');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('断开');
    expect(r.detail).toContain('broken-skill');
    expect(r.hint).toContain('copy_mode');
    expect(report.exitCode).toBe(0); // warn 不抬升退出码
  });

  it('仍有效的 symlink 同样报 warn，并点明不会被 bundle export 带走', async () => {
    const base = createDoctorHost();
    await seedProjectSoT(base);
    const host = hostWithSkillSymlink(base, 'linked-skill', '/elsewhere/linked-skill', true);
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'skills-symlink');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('仍有效');
    expect(r.detail).toContain('linked-skill');
    expect(r.hint).toContain('bundle export');
    expect(report.exitCode).toBe(0);
  });

  it('PI_CODING_AGENT_DIR 置位 → ok 并打出生效目录（未置位时不产出该项）', async () => {
    const withVar = createFakeHost({
      HOME,
      PI_CODING_AGENT_DIR: path.join(HOME, 'custom-pi'),
    });
    await seedProjectSoT(withVar);
    const withVarReport = await runDoctorChecks(doctorOpts(withVar));
    const r = resultOf(withVarReport, 'pi-coding-agent-dir');
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('custom-pi');
    expect(withVarReport.exitCode).toBe(0);

    // 未置位：不产出该项（避免给没用 pi 的用户增加噪音）
    const without = createFakeHost({ HOME });
    await seedProjectSoT(without);
    const withoutReport = await runDoctorChecks(doctorOpts(without));
    expect(withoutReport.results.some((x) => x.item === 'pi-coding-agent-dir')).toBe(false);
  });

  it('CODEX_HOME 置位 → codex-home ok（此前根本没有对应条目，Issue #51 第 2 条）', async () => {
    const host = createFakeHost({ HOME, CODEX_HOME: path.join(HOME, 'codex-alt') });
    await seedProjectSoT(host);
    const r = resultOf(await runDoctorChecks(doctorOpts(host)), 'codex-home');
    expect(r.level).toBe('ok');
    expect(r.detail).toContain('codex-alt');

    const without = createFakeHost({ HOME });
    await seedProjectSoT(without);
    const report = await runDoctorChecks(doctorOpts(without));
    expect(report.results.some((x) => x.item === 'codex-home')).toBe(false);
  });

  it('CODEX_HOME 是相对路径 → warn（落点随 cwd 漂移，但不拦）', async () => {
    const host = createFakeHost({ HOME, CODEX_HOME: 'codex-alt' });
    await seedProjectSoT(host);
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'codex-home');
    expect(r.level).toBe('warn');
    expect(r.detail).toContain('相对路径');
    expect(report.exitCode).toBe(0); // warn 不抬升退出码
  });

  it('CODEX_HOME 写成 `~user` → error(2)（sync 会撞同一个守卫）', async () => {
    const host = createFakeHost({ HOME, CODEX_HOME: '~alice/.codex' });
    await seedProjectSoT(host);
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, 'codex-home');
    expect(r.level).toBe('error');
    expect(r.code).toBe(ExitCode.Config);
    expect(report.exitCode).toBe(ExitCode.Config);
    // 报告不因非法取值被截断：依赖 projector.plan 的检查项照常产出（按默认落点解析）
    const paths = resultOf(report, 'path/codex');
    expect(paths.detail).toContain('.codex');
    expect(paths.detail).not.toContain('~alice');
  });
});

describe('skills.expose_as_command 诊断（§8.8）', () => {
  function config(
    scope: 'project' | 'user',
    profileInput: Record<string, unknown>,
  ): EffectiveConfig {
    return {
      profile: ProfileSchema.parse({ version: 1, ...profileInput }),
      habits: HabitsSchema.parse({ version: 1 }),
      userSoTRoot: USER_SOT,
      projectSoTRoot: PROJECT_SOT,
      effectiveScope: scope,
    };
  }

  it('未声明 → 单条 ok', () => {
    const results: DoctorCheckResult[] = [];
    checkCommandsExposure(results, config('project', { targets: ['claude'] }));
    expect(results).toHaveLength(1);
    expect(results[0]?.level).toBe('ok');
    expect(results[0]?.detail).toContain('未声明');
  });

  it('名单不是 skills.always 子集 → error(2) 并列出缺失名', () => {
    const results: DoctorCheckResult[] = [];
    checkCommandsExposure(
      results,
      config('project', {
        targets: ['claude'],
        skills: { always: ['tdd'], expose_as_command: ['tdd', 'nope'] },
      }),
    );
    const r = results.find((x) => x.item === 'skills-expose-as-command');
    expect(r?.level).toBe('error');
    expect(r?.code).toBe(ExitCode.Config);
    expect(r?.detail).toContain('nope');
  });

  it('project scope + codex 启用 → warn（该 target 的命令薄壳被跳过）', () => {
    const results: DoctorCheckResult[] = [];
    checkCommandsExposure(
      results,
      config('project', {
        targets: ['claude', 'codex'],
        skills: { always: ['tdd'], expose_as_command: ['tdd'] },
      }),
    );
    const warn = results.find((x) => x.item === 'commands/codex-project-unsupported');
    expect(warn?.level).toBe('warn');
    expect(doctorExitCode(results)).toBe(0); // warn 不抬升退出码
  });

  it('user scope → 不产出 codex 告警（user 级 prompts 目录是生效落点）', () => {
    const results: DoctorCheckResult[] = [];
    checkCommandsExposure(
      results,
      config('user', {
        targets: ['codex'],
        skills: { always: ['tdd'], expose_as_command: ['tdd'] },
      }),
    );
    expect(results.some((x) => x.item === 'commands/codex-project-unsupported')).toBe(false);
  });

  it('命名空间 + 平铺目录 target → warn 列出改名后的形态（§8.8.2）', () => {
    const results: DoctorCheckResult[] = [];
    checkCommandsExposure(
      results,
      config('user', {
        targets: ['claude', 'pi'],
        skills: { always: ['tdd'], expose_as_command: ['review/tdd'] },
      }),
    );
    const warn = results.find((x) => x.item === 'commands/namespace-flattened');
    expect(warn?.level).toBe('warn');
    expect(warn?.detail).toContain('review/tdd → review-tdd');
    expect(warn?.detail).toContain('pi');
    expect(doctorExitCode(results)).toBe(0); // warn 不抬升退出码
  });

  it('命名空间但没启用平铺 target → 不产出该 warn', () => {
    const results: DoctorCheckResult[] = [];
    checkCommandsExposure(
      results,
      config('user', {
        targets: ['claude', 'opencode'],
        skills: { always: ['tdd'], expose_as_command: ['review/tdd'] },
      }),
    );
    expect(results.some((x) => x.item === 'commands/namespace-flattened')).toBe(false);
  });

  it('条目形态非法（.. 段）→ error(2)，且不再继续判子集', () => {
    const results: DoctorCheckResult[] = [];
    checkCommandsExposure(
      results,
      config('project', {
        targets: ['claude'],
        skills: { always: ['tdd'], expose_as_command: ['../tdd'] },
      }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.level).toBe('error');
    expect(results[0]?.code).toBe(ExitCode.Config);
    expect(results[0]?.detail).toContain('目录树之外');
  });
});

describe('runDoctorChecks — codex 同层并存 inline [hooks]（§7.4 / §9 第 12 条）', () => {
  const CODEX_CONFIG = path.join(CWD, '.codex', 'config.toml');
  const CODEX_HOOKS = path.join(CWD, '.codex', 'hooks.json');
  const codexProfile = (autoCapture: string) =>
    `version: 1\nscope: project\ntargets: [codex]\nlearning:\n  auto_capture: ${autoCapture}\n`;

  it('hook + codex + config.toml 里有 [hooks] → warn，点名两个落点，不抬升退出码', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host, codexProfile('hook'));
    await host.writeFile(CODEX_CONFIG, 'model = "gpt-5"\n\n[hooks]\n');
    const report = await runDoctorChecks(doctorOpts(host));
    const r = resultOf(report, SESSION_HOOK_INLINE_ITEM);
    expect(r.level).toBe('warn');
    expect(r.detail).toContain(CODEX_CONFIG);
    expect(r.detail).toContain(CODEX_HOOKS);
    expect(r.hint).toContain('[hooks]');
    expect(report.exitCode).toBe(0);
  });

  it('hook + codex + config.toml 无 [hooks] → 不报（不能对着正常配置刷噪音）', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host, codexProfile('hook'));
    await host.writeFile(CODEX_CONFIG, 'model = "gpt-5"\n# [hooks] 早先注释掉了\n');
    const report = await runDoctorChecks(doctorOpts(host));
    expect(report.results.some((r) => r.item === SESSION_HOOK_INLINE_ITEM)).toBe(false);
  });

  it('hook + codex + config.toml 不存在 → 不报（首次 sync 会新建，无从并存）', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host, codexProfile('hook'));
    const report = await runDoctorChecks(doctorOpts(host));
    expect(report.results.some((r) => r.item === SESSION_HOOK_INLINE_ITEM)).toBe(false);
  });

  it('off 档 + 有 [hooks] → 不报（本档不投 hooks.json，并存不是我们造成的）', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(host, codexProfile('off'));
    await host.writeFile(CODEX_CONFIG, '[hooks]\n');
    const report = await runDoctorChecks(doctorOpts(host));
    expect(report.results.some((r) => r.item === SESSION_HOOK_INLINE_ITEM)).toBe(false);
  });

  it('hook 档但没启用 codex → 不报（钩子不落 codex 层）', async () => {
    const host = createDoctorHost();
    await seedProjectSoT(
      host,
      'version: 1\nscope: project\ntargets: [claude]\nlearning:\n  auto_capture: hook\n',
    );
    await host.writeFile(CODEX_CONFIG, '[hooks]\n');
    const report = await runDoctorChecks(doctorOpts(host));
    expect(report.results.some((r) => r.item === SESSION_HOOK_INLINE_ITEM)).toBe(false);
  });
});

describe('checkLearningAutoCapture — 支持度切分只看注册表命中的 target', () => {
  function hookConfig(targets: readonly string[]): EffectiveConfig {
    const profile = ProfileSchema.parse({
      version: 1,
      targets: ['claude'],
      learning: { auto_capture: 'hook' },
    });
    return {
      // 绕过 schema 造出「注册表没有该 id」的 profile：TargetEnum 是闭集，正常配置进不来，
      // 但注册表与 enum 是两套清单（enum 先加名字、projector 后落地时二者就会分叉）
      profile: { ...profile, targets: targets as unknown as Profile['targets'] },
      habits: HabitsSchema.parse({ version: 1 }),
      userSoTRoot: USER_SOT,
      projectSoTRoot: PROJECT_SOT,
      effectiveScope: 'project',
    };
  }

  it('注册表没有的 target 不进降级 warn（它连产物都没有，替它报"没钩子落点"是错的）', () => {
    const results: DoctorCheckResult[] = [];
    checkLearningAutoCapture(results, hookConfig(['claude', 'ghost']), readEnv(createDoctorHost()));
    const warn = results.find((r) => r.item === 'learning-auto-capture-hook');
    expect(warn?.level).toBe('warn');
    expect(warn?.detail).toContain('claude');
    expect(warn?.detail).not.toContain('ghost');
  });

  it('只有注册表外的 target → 完全不报降级 warn', () => {
    const results: DoctorCheckResult[] = [];
    checkLearningAutoCapture(results, hookConfig(['ghost']), readEnv(createDoctorHost()));
    expect(results.some((r) => r.item === 'learning-auto-capture-hook')).toBe(false);
  });

  it('内置四个 target id 当前都在注册表里（因此该过滤对合法配置是恒等的）', () => {
    const registered = projectorRegistry.list().map((p) => p.id);
    // 第二层放开 TargetEnum 后取值域不再是闭集（声明式适配器运行时注册），
    // 因此这里遍历内置元组而不是 enum 的 options——后者已经不存在了。
    for (const id of BUILTIN_TARGET_IDS) {
      expect(registered).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// issue #52：user scope × claude × 有 server → MCP 整项不投影，doctor 必须明说
// ---------------------------------------------------------------------------

describe('checkClaudeUserScopeMcp — user scope 的 claude MCP 不投影（issue #52）', () => {
  function mcpConfig(
    scope: 'project' | 'user',
    targets: readonly string[],
    servers: readonly Record<string, unknown>[],
  ): EffectiveConfig {
    return {
      profile: ProfileSchema.parse({ version: 1, targets, mcp: { servers } }),
      habits: HabitsSchema.parse({ version: 1 }),
      userSoTRoot: USER_SOT,
      projectSoTRoot: PROJECT_SOT,
      effectiveScope: scope,
    };
  }

  const FS_SERVER = { name: 'fs', transport: 'stdio', command: 'npx' };

  it('三条件齐备 → 一条 warn，指明上游落点与手工登记命令', () => {
    const results: DoctorCheckResult[] = [];
    checkClaudeUserScopeMcp(results, mcpConfig('user', ['claude'], [FS_SERVER]));

    expect(results).toHaveLength(1);
    expect(results[0]?.level).toBe('warn');
    expect(results[0]?.item).toBe(CLAUDE_USER_MCP_NOTICE_ITEM);
    expect(results[0]?.detail).toContain('.claude.json');
    expect(results[0]?.detail).toContain('claude mcp add --scope user');
    // hint 给出「改走 project scope」这条真正能被投影的出路
    expect(results[0]?.hint).toContain('--scope project');
  });

  it('project scope / claude 未启用 / 无 server → 都不报（该层落点与上游一致）', () => {
    const cases: EffectiveConfig[] = [
      mcpConfig('project', ['claude'], [FS_SERVER]),
      mcpConfig('user', ['codex'], [FS_SERVER]),
      mcpConfig('user', ['claude'], []),
    ];
    for (const config of cases) {
      const results: DoctorCheckResult[] = [];
      checkClaudeUserScopeMcp(results, config);
      expect(results).toEqual([]);
    }
  });
});
