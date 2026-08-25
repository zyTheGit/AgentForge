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
import { formatDoctorReport, runDoctor } from '../../src/commands/doctor';
import { formatStatus, runStatus } from '../../src/commands/status';
import { runInit } from '../../src/commands/init';
import { runSync } from '../../src/commands/sync';
import type {
  DoctorCheckResult,
  DoctorReport,
} from '../../src/core/doctor/checks';
import { readEnv } from '../../src/core/env';
import { currentOs } from '../../src/core/paths';
import { ConfigError } from '../../src/core/errors';
import { syncOnce } from '../../src/core/project/engine';
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
          if (rest === '') continue;
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
      targets: [{ targetId: 'claude', paths: [CLAUDE_MD, CLAUDE_MCP] }],
      skippedTargets: ['future-target'],
      lastSyncAt: '2026-08-21T00:00:00.000Z',
      counts: { custom: 3, learnings: 5, templates: 2 },
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
    });
    expect(text).toContain('(unresolvable - see aforge doctor)');
    expect(text).toContain('last sync: (never - run aforge sync)');
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
        'created_at: \'2026-01-01T00:00:00.000Z\'',
        'updated_at: \'2026-01-01T00:00:00.000Z\'',
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
        'created_at: \'2026-01-01T00:00:00.000Z\'',
        'updated_at: \'2026-01-01T00:00:00.000Z\'',
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
  it('init 结果可 JSON 序列化：scope / sotRoot / createdFiles / createdDirs / detection 字段齐全', async () => {
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
