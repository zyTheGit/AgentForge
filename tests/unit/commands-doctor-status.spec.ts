/**
 * doctor / status 命令层单测（fake host）：
 * formatDoctorReport / formatStatus 纯函数输出格式 + runDoctor / runStatus
 * 装配 wiring（readEnv 注入、计数口径、未初始化 fail-fast）。
 *
 * 核心检查项语义已由 doctor-checks.spec / engine-marker-conflict.spec 覆盖，
 * 此处聚焦命令层的输入输出契约（纯 ASCII、绝对路径、--json 序列化形态）。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLearn } from '../../src/commands/knowledge';
import {
  attachExitCodeOverride,
  EXIT_CODE_ROLLBACK_INCOMPLETE,
  formatDoctorReport,
  formatFailureReport,
  formatStatus,
  getExitCodeOverride,
  runDoctor,
  runInit,
  runStatus,
  runSync,
} from '../../src/commands/lifecycle';
import type { DoctorReport } from '../../src/core/doctor/checks';
import { readEnv } from '../../src/core/env';
import { ConfigError } from '../../src/core/errors';
import { currentOs } from '../../src/core/paths';
import { getSyncFailureReport, syncOnce } from '../../src/core/project/engine';
import { createFakeHost, type FakeHost } from './test-utils';

const OS = currentOs();
const HOME = path.resolve('/home/u');
const CWD = path.resolve('/proj');
const USER_SOT = path.join(HOME, '.agentforge');
const PROJECT_SOT = path.join(CWD, '.agentforge');
const CLAUDE_MD = path.join(CWD, 'CLAUDE.md');
const CLAUDE_MCP = path.join(CWD, '.mcp.json');

const PROFILE_YAML = 'version: 1\nscope: project\ntargets: [claude]\n';
const HABITS_YAML = 'version: 1\n';

/** 目录感知 listDir 的 fake host（Windows 反斜杠 key 兼容，同 engine.spec）。 */
function createCommandHost(env: Record<string, string> = { USERPROFILE: HOME }): FakeHost {
  const base = createFakeHost(env);
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

async function seedProjectSoT(host: FakeHost): Promise<void> {
  await host.writeFile(path.join(PROJECT_SOT, 'profile.yaml'), PROFILE_YAML);
  await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
}

describe('formatDoctorReport — 人类可读输出（纯 ASCII 分节）', () => {
  const report: DoctorReport = {
    exitCode: 4,
    results: [
      {
        section: 'config',
        level: 'ok',
        item: 'initialization',
        detail: 'user SoT    : /x\nproject SoT : /y',
      },
      {
        section: 'paths',
        level: 'error',
        code: 4,
        item: 'writable',
        detail: 'not writable: /proj',
        hint: 'check permissions',
      },
      {
        section: 'consistency',
        level: 'warn',
        item: 'projection-hash/claude',
        detail: 'stale projection',
      },
      {
        section: 'environment',
        level: 'ok',
        item: 'onedrive',
        detail: 'no onedrive',
      },
    ],
  };

  it('分节标题 + 级别前缀 + summary 尾行', () => {
    const text = formatDoctorReport(report);
    expect(text).toContain('aforge doctor');
    expect(text).toContain('== Configuration ==');
    expect(text).toContain('== Paths & writability ==');
    expect(text).toContain('== Consistency ==');
    expect(text).toContain('== Environment ==');
    expect(text).toContain('[OK  ] initialization');
    expect(text).toContain('[FAIL] writable');
    expect(text).toContain('[WARN] projection-hash/claude');
    expect(text).toContain('hint: check permissions');
    expect(text).toContain('summary: 2 ok, 1 warn, 1 error, exit code 4');
    // 纯 ASCII（Windows GBK 控制台安全）
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言输出仅含 ASCII，字符类必须显式覆盖控制字符区间（\x00-\x1F）
    expect(text).toMatch(/^[\x00-\x7F]*$/);
  });

  it('多行 detail 逐行缩进对齐', () => {
    const text = formatDoctorReport(report);
    const lines = text.split('\n');
    const detailIndex = lines.findIndex((l) => l.includes('user SoT'));
    expect(lines[detailIndex]).toMatch(/^ {9}user SoT/);
  });

  it('空结果 → 仅 header + summary（0 项）', () => {
    const text = formatDoctorReport({ results: [], exitCode: 0 });
    expect(text).toContain('summary: 0 ok, 0 warn, 0 error, exit code 0');
    expect(text).not.toContain('==');
  });
});

describe('formatStatus — 人类可读输出（纯 ASCII）', () => {
  it('scope / targets 路径 / last sync / counts 全部呈现', () => {
    const text = formatStatus({
      effectiveScope: 'project',
      userSoTRoot: USER_SOT,
      projectSoTRoot: PROJECT_SOT,
      initialized: { user: false, project: true },
      enabledTargets: ['claude'],
      targets: [
        { targetId: 'claude', paths: [CLAUDE_MD, CLAUDE_MCP], skillInvokePrefix: '/' },
        { targetId: 'codex', paths: [], skillInvokePrefix: '$' },
      ],
      skippedTargets: ['future-target'],
      lastSyncAt: '2026-08-21T00:00:00.000Z',
      counts: { custom: 3, learnings: 5, templates: 2 },
      // Spec §4.2 skills.always / skills.on_demand（新增展示字段）
      alwaysSkills: ['code-review'],
      onDemandSkills: ['deep-research'],
      autoCapture: {
        declared: 'off',
        effective: 'off',
        reason: null,
        ciNote: null,
        hookTargets: [],
        hookUnsupportedTargets: [],
      },
      sources: [
        {
          id: 'official',
          type: 'git',
          enabled: false,
          ref: 'v0.2.2',
          commit: null,
          materialized: false,
          official: true,
        },
      ],
      sourcesUnreadable: false,
    });
    expect(text).toContain('aforge status');
    expect(text).toContain(USER_SOT);
    expect(text).toContain(PROJECT_SOT);
    expect(text).toContain('effective: project');
    expect(text).toContain(CLAUDE_MD);
    expect(text).toContain('last sync: 2026-08-21T00:00:00.000Z');
    expect(text).toContain('custom    : 3');
    expect(text).toContain('learnings : 5');
    expect(text).toContain('templates : 2');
    expect(text).toContain('future-target: (no projector in this version)');
    // §4.2：always 由 sync 物化；on_demand 在 MVP 只登记不物化，status 需说明这点
    expect(text).toContain('always    : code-review (materialized by sync)');
    expect(text).toContain('on_demand : deep-research (declared only - not projected in MVP)');
    // §12 Phase 2：默认注册的官方源以 disabled 落盘，status 必须让"登记了但不生效"可见
    expect(text).toContain('sources (user-level sources.json):');
    expect(text).toContain('official [official]  git  disabled pin v0.2.2');
    // §6.1 / §8.8：技能调用前缀必须打印——codex 是 `$<name>`，其余三家 `/<name>`
    expect(text).toContain('claude (invoke skills as /<name>):');
    expect(text).toContain('codex (invoke skills as $<name>):');
    // §7.4：auto_capture 生效档位（缺省 off，无附加说明行）
    expect(text).toContain('auto_capture: off');
    expect(text).not.toContain('## Learning Protocol');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言输出仅含 ASCII，字符类必须显式覆盖控制字符区间（\x00-\x1F）
    expect(text).toMatch(/^[\x00-\x7F]*$/);
  });

  it('user 根不可解析 / 从未 sync 的展示形态', () => {
    const text = formatStatus({
      effectiveScope: 'project',
      userSoTRoot: null,
      projectSoTRoot: PROJECT_SOT,
      initialized: { user: false, project: true },
      enabledTargets: [],
      targets: [],
      skippedTargets: [],
      lastSyncAt: null,
      counts: { custom: 0, learnings: 0, templates: 0 },
      alwaysSkills: [],
      onDemandSkills: [],
      autoCapture: {
        declared: 'off',
        effective: 'off',
        reason: null,
        ciNote: null,
        hookTargets: [],
        hookUnsupportedTargets: [],
      },
      sources: [],
      sourcesUnreadable: false,
    });
    expect(text).toContain('(unresolvable - see aforge doctor)');
    expect(text).toContain('last sync: (never - run aforge sync)');
    // 空清单 → (none)，不产生裸行
    expect(text).toContain('always    : (none)');
    expect(text).toContain('on_demand : (none)');
    expect(text).toContain('(none registered)');
  });

  it('登记表读不出来 → (unreadable)，不冒充"没有登记"', () => {
    const text = formatStatus({
      effectiveScope: 'project',
      userSoTRoot: USER_SOT,
      projectSoTRoot: PROJECT_SOT,
      initialized: { user: true, project: true },
      enabledTargets: [],
      targets: [],
      skippedTargets: [],
      lastSyncAt: null,
      counts: { custom: 0, learnings: 0, templates: 0 },
      alwaysSkills: [],
      onDemandSkills: [],
      autoCapture: {
        declared: 'off',
        effective: 'off',
        reason: null,
        ciNote: null,
        hookTargets: [],
        hookUnsupportedTargets: [],
      },
      sources: [],
      sourcesUnreadable: true,
    });
    expect(text).toContain('sources (user-level sources.json):');
    expect(text).toContain('(unreadable - see aforge doctor)');
    expect(text).not.toContain('(none registered)');
  });

  it('auto_capture: hook 时列出装钩子的 target 与等同 off 的 target（§7.4）', () => {
    const text = formatStatus({
      effectiveScope: 'project',
      userSoTRoot: USER_SOT,
      projectSoTRoot: PROJECT_SOT,
      initialized: { user: false, project: true },
      enabledTargets: ['codex', 'claude'],
      targets: [],
      skippedTargets: [],
      lastSyncAt: null,
      counts: { custom: 0, learnings: 0, templates: 0 },
      alwaysSkills: [],
      onDemandSkills: [],
      autoCapture: {
        declared: 'hook',
        effective: 'hook',
        reason: null,
        ciNote: null,
        hookTargets: ['codex'],
        hookUnsupportedTargets: ['claude'],
      },
      sources: [],
      sourcesUnreadable: false,
    });
    // 三档恒等 → 不打箭头；两张名单各一行
    expect(text).toContain('auto_capture: hook');
    expect(text).not.toContain('->');
    expect(text).toContain('session hook (SessionStart) written for: codex');
    expect(text).toContain('no session hook target: claude (behaves as off)');
    // hook 与 prompt 互斥：不再往规则文件里插协议段
    expect(text).not.toContain('projected rules include');
  });

  it('auto_capture: hook 但一家都装不上时给出整体降级原因（§7.4）', () => {
    const text = formatStatus({
      effectiveScope: 'project',
      userSoTRoot: USER_SOT,
      projectSoTRoot: PROJECT_SOT,
      initialized: { user: false, project: true },
      enabledTargets: ['claude'],
      targets: [],
      skippedTargets: [],
      lastSyncAt: null,
      counts: { custom: 0, learnings: 0, templates: 0 },
      alwaysSkills: [],
      onDemandSkills: [],
      autoCapture: {
        declared: 'hook',
        effective: 'hook',
        reason: 'no enabled target supports session hooks - behaves as off',
        ciNote: null,
        hookTargets: [],
        hookUnsupportedTargets: ['claude'],
      },
      sources: [],
      sourcesUnreadable: false,
    });
    expect(text).toContain('no enabled target supports session hooks - behaves as off');
    expect(text).not.toContain('written for');
  });

  it('auto_capture: prompt 时说明投影正文含 Learning Protocol 段（§5.2）', () => {
    const text = formatStatus({
      effectiveScope: 'project',
      userSoTRoot: USER_SOT,
      projectSoTRoot: PROJECT_SOT,
      initialized: { user: false, project: true },
      enabledTargets: [],
      targets: [],
      skippedTargets: [],
      lastSyncAt: null,
      counts: { custom: 0, learnings: 0, templates: 0 },
      alwaysSkills: [],
      onDemandSkills: [],
      autoCapture: {
        declared: 'prompt',
        effective: 'prompt',
        reason: null,
        ciNote: null,
        hookTargets: [],
        hookUnsupportedTargets: [],
      },
      sources: [],
      sourcesUnreadable: false,
    });
    expect(text).toContain('auto_capture: prompt');
    expect(text).toContain('projected rules include a ## Learning Protocol section');
  });

  it('CI 下 prompt 仍生效，仅追加"不会写入"提示（投影正文不变）', () => {
    const text = formatStatus({
      effectiveScope: 'project',
      userSoTRoot: USER_SOT,
      projectSoTRoot: PROJECT_SOT,
      initialized: { user: false, project: true },
      enabledTargets: [],
      targets: [],
      skippedTargets: [],
      lastSyncAt: null,
      counts: { custom: 0, learnings: 0, templates: 0 },
      alwaysSkills: [],
      onDemandSkills: [],
      autoCapture: {
        declared: 'prompt',
        effective: 'prompt',
        reason: null,
        ciNote: 'CI detected - no learnings will be written (projected rules are unchanged)',
        hookTargets: [],
        hookUnsupportedTargets: [],
      },
      sources: [],
      sourcesUnreadable: false,
    });
    // 生效档位不变 → 不打箭头；只多一行环境说明
    expect(text).toContain('auto_capture: prompt');
    expect(text).not.toContain('->');
    expect(text).toContain('projected rules include a ## Learning Protocol section');
    expect(text).toContain('CI detected - no learnings will be written');
  });
});

describe('runDoctor — 命令装配 wiring', () => {
  it('健康 SoT → exitCode 0（readEnv / os / cwd 注入正确）', async () => {
    const host = createCommandHost();
    await seedProjectSoT(host);
    const report = await runDoctor({ host, cwd: CWD, os: OS });
    expect(report.exitCode).toBe(0);
    expect(report.results.some((r) => r.item === 'path/claude' && r.level === 'ok')).toBe(true);
  });
});

describe('runStatus — 状态装配', () => {
  it('未初始化 → ConfigError(2)', async () => {
    const host = createCommandHost();
    const err = await runStatus({ host, cwd: CWD, os: OS }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe(2);
  });

  it('sync 后：scope / targets 路径 / lastSyncAt / counts（两层合并去重口径）', async () => {
    const host = createCommandHost();
    await seedProjectSoT(host);
    // 素材：custom 两层同名合并（a + b = 2）、learnings 2、templates 含嵌套 = 2
    await host.writeFile(path.join(PROJECT_SOT, 'custom', 'a.md'), '# A\n');
    await host.writeFile(path.join(PROJECT_SOT, 'custom', 'b.md'), '# B\n');
    await host.writeFile(path.join(USER_SOT, 'custom', 'a.md'), '# A user\n');
    await host.writeFile(
      path.join(PROJECT_SOT, 'learnings', 'l1.yaml'),
      [
        'id: l1',
        'scope: project',
        'confidence: 0.5',
        "trigger: ''",
        "content: '# L1'",
        'category: other',
        'source: manual',
        "created_at: '2026-01-01T00:00:00.000Z'",
        "updated_at: '2026-01-01T00:00:00.000Z'",
        'promoted: false',
        'promoted_at: null',
        'promote_target: custom_rule',
        '',
      ].join('\n'),
    );
    await host.writeFile(
      path.join(USER_SOT, 'learnings', 'l2.yml'),
      [
        'id: l2',
        'scope: user',
        'confidence: 0.5',
        "trigger: ''",
        "content: '# L2'",
        'category: other',
        'source: manual',
        "created_at: '2026-01-01T00:00:00.000Z'",
        "updated_at: '2026-01-01T00:00:00.000Z'",
        'promoted: false',
        'promoted_at: null',
        'promote_target: custom_rule',
        '',
      ].join('\n'),
    );
    await host.writeFile(path.join(PROJECT_SOT, 'templates', 't1.md'), '# T1\n');
    await host.writeFile(path.join(USER_SOT, 'templates', 'nested', 't2.md'), '# T2\n');

    await syncOnce({
      host,
      env: readEnv(host),
      os: OS,
      cwd: CWD,
      agentforgeVersion: 'test-0.1.0',
      dryRun: false,
    });

    const result = await runStatus({ host, cwd: CWD, os: OS });
    expect(result.effectiveScope).toBe('project');
    expect(result.userSoTRoot).toBe(USER_SOT);
    expect(result.projectSoTRoot).toBe(PROJECT_SOT);
    expect(result.initialized).toEqual({ user: false, project: true });
    expect(result.enabledTargets).toEqual(['claude']);

    const claude = result.targets.find((t) => t.targetId === 'claude');
    expect(claude?.paths).toContain(CLAUDE_MD);
    expect(claude?.paths).toContain(CLAUDE_MCP);
    expect(result.skippedTargets).toEqual([]);

    expect(result.lastSyncAt).not.toBeNull(); // sync-meta.lastSyncAt（fake 时钟 epoch）
    expect(result.counts).toEqual({ custom: 2, learnings: 2, templates: 2 });
  });

  it('user 目录不可解析 → userSoTRoot null，status 仍可用（project 层信息完整）', async () => {
    const host = createCommandHost({}); // 无 USERPROFILE：用户目录不可解析
    await seedProjectSoT(host);
    const result = await runStatus({ host, cwd: CWD, os: OS });
    expect(result.userSoTRoot).toBeNull();
    expect(result.effectiveScope).toBe('project');
    expect(result.counts.custom).toBe(0);
  });

  it('--json 序列化形态：字段齐全且路径为绝对路径字符串', async () => {
    const host = createCommandHost();
    await seedProjectSoT(host);
    const result = await runStatus({ host, cwd: CWD, os: OS });
    const json = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(json.effectiveScope).toBe('project');
    expect(typeof json.projectSoTRoot).toBe('string');
    expect(json.lastSyncAt).toBeNull();
    expect(json.counts).toEqual({ custom: 0, learnings: 0, templates: 0 });
  });
});

describe('runInit — --json 序列化形态', () => {
  it('init 结果可 JSON 序列化：scope / sotRoot / targets / createdFiles / createdDirs / detection 字段齐全', async () => {
    const host = createCommandHost();
    const result = await runInit({ host, cwd: CWD, os: OS }, { scope: 'project' });
    const json = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(json.scope).toBe('project');
    expect(typeof json.sotRoot).toBe('string');
    expect(Array.isArray(json.createdFiles)).toBe(true);
    expect(Array.isArray(json.createdDirs)).toBe(true);
    expect(typeof json.detection).toBe('object');
    expect((json.createdFiles as string[]).length).toBeGreaterThan(0);
    expect((json.createdDirs as string[]).length).toBeGreaterThan(0);
    // 静默路径未询问 target，默认投影给全部四个——必须回报，否则用户不知道装到哪了
    expect(json.targets).toEqual(['opencode', 'codex', 'claude', 'pi']);
  });
});

describe('runInit — SoT 根非空（Spec §6.1「init 目录非空」→ 退出码 2）', () => {
  it('已初始化（profile.yaml 存在）→ ConfigError(2)，措辞点名「已初始化」', async () => {
    const host = createCommandHost();
    await host.writeFile(path.join(PROJECT_SOT, 'profile.yaml'), PROFILE_YAML);
    await expect(runInit({ host, cwd: CWD, os: OS }, { scope: 'project' })).rejects.toThrow(
      /已初始化/,
    );
  });

  it('SoT 根存在但只有无关文件 → 仍 ConfigError(2)，措辞点名「目录非空」', async () => {
    // 之前只检查 profile.yaml，导致 §6.1 声明的「目录非空」触发条件形同虚设：
    // 半初始化目录（例如手工建了 custom/）会被 init 继续写入。
    const host = createCommandHost();
    await host.writeFile(path.join(PROJECT_SOT, 'custom', 'a.md'), '# a\n');
    const err = await runInit({ host, cwd: CWD, os: OS }, { scope: 'project' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe(2);
    expect((err as ConfigError).message).toContain('目录非空');
  });

  it('SoT 根不存在 → 正常初始化（既有行为不变）', async () => {
    const host = createCommandHost();
    const result = await runInit({ host, cwd: CWD, os: OS }, { scope: 'project' });
    expect(result.sotRoot).toBe(PROJECT_SOT);
  });
});

describe('runLearn — learning.default_scope（Spec §4.2）', () => {
  /** 两层都已初始化；project 层声明 default_scope: user。 */
  async function seedBothLayers(host: FakeHost, defaultScope: string): Promise<void> {
    await host.writeFile(
      path.join(PROJECT_SOT, 'profile.yaml'),
      `version: 1\nscope: project\ntargets: [claude]\nlearning:\n  default_scope: ${defaultScope}\n`,
    );
    await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
    await host.writeFile(path.join(USER_SOT, 'profile.yaml'), PROFILE_YAML);
    await host.writeFile(path.join(USER_SOT, 'habits.yaml'), HABITS_YAML);
  }

  it('缺省 --scope → 取 profile.learning.default_scope（此前硬编码 project，该配置项失效）', async () => {
    const host = createCommandHost();
    await seedBothLayers(host, 'user');
    const result = await runLearn({ host, cwd: CWD, os: OS }, { content: '# 学到一条\n' });
    expect(result.scope).toBe('user');
    expect(result.sotRoot).toBe(USER_SOT);
  });

  it('显式 --scope 优先于 default_scope', async () => {
    const host = createCommandHost();
    await seedBothLayers(host, 'user');
    const result = await runLearn(
      { host, cwd: CWD, os: OS },
      { content: '# 学到一条\n', scope: 'project' },
    );
    expect(result.scope).toBe('project');
    expect(result.sotRoot).toBe(PROJECT_SOT);
  });

  it('default_scope 未声明 → 仍为 project（schema 默认值，行为不变）', async () => {
    const host = createCommandHost();
    await host.writeFile(path.join(PROJECT_SOT, 'profile.yaml'), PROFILE_YAML);
    await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
    const result = await runLearn({ host, cwd: CWD, os: OS }, { content: '# 学到一条\n' });
    expect(result.scope).toBe('project');
  });
});

describe('sync 失败汇总措辞与退出码（P2）', () => {
  const targetStatuses = [
    { targetId: 'opencode', status: 'ok-rolled-back' },
    { targetId: 'codex', status: 'failed' },
    { targetId: 'claude', status: 'not-started' },
  ];

  it('全部恢复 → 首行声明已完全回滚，无 incomplete 措辞与退出码提示', () => {
    const text = formatFailureReport({
      targetStatuses,
      rolledBack: [
        { path: '/proj/opencode.json', restored: true },
        { path: '/proj/AGENTS.md', restored: true },
      ],
    });
    expect(text.split('\n')[0]).toBe(
      'aforge sync failed - all written files have been rolled back',
    );
    expect(text).toContain('rollback: 2 file(s) restored');
    expect(text).not.toContain('rollback incomplete');
    expect(text).not.toContain('exit code');
  });

  it('存在未恢复 → 首行 rollback incomplete + 未恢复清单前置 + 退出码 6 提示', () => {
    const text = formatFailureReport({
      targetStatuses,
      rolledBack: [
        { path: '/proj/opencode.json', restored: false, error: 'EPERM: rm failed' },
        { path: '/proj/AGENTS.md', restored: true },
      ],
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      'aforge sync failed - rollback incomplete - 1 file(s) could not be restored',
    );
    // 未恢复清单在 target summary 之前（用户先看到留在改动状态的文件）
    const listIndex = lines.findIndex((l) => l.includes('/proj/opencode.json'));
    const summaryIndex = lines.indexOf('target summary:');
    expect(listIndex).toBeGreaterThan(0);
    expect(listIndex).toBeLessThan(summaryIndex);
    expect(text).toContain('EPERM: rm failed');
    expect(text).toContain('rollback: 1 file(s) restored, 1 restore error(s)');
    expect(text).toContain(`exit code: ${EXIT_CODE_ROLLBACK_INCOMPLETE} (rollback incomplete)`);
  });

  it('退出码覆盖：6 未被 Spec §6.1 占用，attach/get 往返且不污染枚举属性', () => {
    expect(EXIT_CODE_ROLLBACK_INCOMPLETE).toBe(6);
    const err = new Error('boom');
    expect(getExitCodeOverride(err)).toBeUndefined();
    attachExitCodeOverride(err, EXIT_CODE_ROLLBACK_INCOMPLETE);
    expect(getExitCodeOverride(err)).toBe(6);
    expect(Object.keys(err)).not.toContain('agentforgeExitCodeOverride');
    expect(getExitCodeOverride(undefined)).toBeUndefined();
  });

  it('引擎真实失败报告 → 回滚失败条目落进 incomplete 措辞', async () => {
    const base = createCommandHost();
    await seedProjectSoT(base);
    const denied: FakeHost = {
      ...base,
      async rm(p) {
        if (p === CLAUDE_MD) {
          const err = new Error(`EPERM: rm ${p}`) as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        await base.rm(p);
      },
      async rename(from, to) {
        if (to === CLAUDE_MCP) {
          const err = new Error(`EPERM: rename ${to}`) as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        await base.rename(from, to);
      },
    };

    const err = await runSync({ host: denied, cwd: CWD, os: OS, agentforgeVersion: 't' }).catch(
      (e: unknown) => e,
    );
    const report = getSyncFailureReport(err);
    expect(report).toBeDefined();
    expect(report?.rolledBack.some((r) => !r.restored)).toBe(true);
    expect(formatFailureReport(report as NonNullable<typeof report>)).toContain(
      'rollback incomplete',
    );
  });
});

describe('runSync — --json 序列化形态', () => {
  it('sync 结果可 JSON 序列化：scope / contentHash / targets / warnings 字段齐全', async () => {
    const host = createCommandHost();
    await seedProjectSoT(host);
    const result = await runSync({
      host,
      cwd: CWD,
      os: OS,
      agentforgeVersion: 'test-0.1.0',
    });
    const json = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(json.scope).toBe('project');
    expect(typeof json.contentHash).toBe('string');
    expect(Array.isArray(json.targets)).toBe(true);
    expect(Array.isArray(json.warnings)).toBe(true);
    expect(json.dryRun).toBe(false);
    expect(typeof json.sotRoot).toBe('string');
  });
});
