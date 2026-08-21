/**
 * marker 冲突检测 + doctor + status 集成测试（Spec §8.2-4 / §9 / §6 / §11.2.4 /
 * §11.2.9）：
 * 1) 进程内（真实临时目录 + realHost）：init → sync → 手改区间 → ConflictError(3)
 *    且文件零修改 → --force 覆盖恢复；脏投影 doctor warn（§11.2.4）；
 *    status 展示 lastSyncAt 与 targets 路径；
 * 2) 子进程端到端：aforge sync 退出码 3（§11.2.9）→ aforge sync --force 退出码 0 →
 *    aforge doctor 输出 hash 不一致 warn；
 * 3) POSIX 真实只读目录：doctor → 退出码 4（Windows 目录只读属性不生效，
 *    fault-injection 已由 doctor-checks.spec 覆盖）。
 */
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInit } from '../../src/commands/init';
import { runSync } from '../../src/commands/sync';
import { runDoctor } from '../../src/commands/doctor';
import { runStatus } from '../../src/commands/status';
import { currentOs } from '../../src/core/paths';
import { ConflictError, ExitCode, toExitCode } from '../../src/core/errors';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END, splitByMarkers } from '../../src/core/markers';
import { realHost } from '../../src/infra/real-host';
import type { Host } from '../../src/infra/host';

const OS = currentOs();
const VERSION = 'test-0.1.0';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainTs = path.join(repoRoot, 'src', 'main.ts');
/** tsx loader 的绝对 file URL（子进程 cwd 在临时目录，相对说明符不可解析）。 */
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

interface Workspace {
  readonly root: string;
  readonly home: string;
  readonly host: Host;
  readonly claudeMd: string;
  readonly sotRoot: string;
  readonly syncMetaPath: string;
}

/** mkdtemp 前缀含中文与空格：§11.2.10 全流程覆盖（同 sync.spec 模式）。 */
async function createWorkspace(label: string): Promise<Workspace> {
  const base = await mkdtemp(path.join(tmpdir(), `aforge-冲突 ${label}-`));
  const root = path.join(base, 'proj');
  const home = path.join(base, 'home');
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });

  const overrides: Record<string, string | undefined> = {
    USERPROFILE: home,
    HOME: home,
    AGF_HOME: undefined,
    AGF_SCOPE: undefined,
    AGF_LINE_ENDING: undefined,
    AGF_OFFLINE: undefined,
    CI: undefined,
    CODEX_HOME: undefined,
  };
  const host: Host = {
    ...realHost,
    env(key) {
      return key in overrides ? overrides[key] : realHost.env(key);
    },
  };

  const sotRoot = path.join(root, '.agentforge');
  return {
    root,
    home,
    host,
    claudeMd: path.join(root, 'CLAUDE.md'),
    sotRoot,
    syncMetaPath: path.join(sotRoot, 'sync-meta.json'),
  };
}

async function disposeWorkspace(ws: Workspace): Promise<void> {
  await rm(path.dirname(ws.root), { recursive: true, force: true });
}

/** 把 CLAUDE.md marker 区间内的首节标题改掉（模拟手动修改，§11.2.9）。 */
async function tamperSection(ws: Workspace): Promise<string> {
  const claude = await readFile(ws.claudeMd, 'utf8');
  const tampered = claude.replace('# AgentForge Rules', '# Manually edited rules');
  await writeFile(ws.claudeMd, tampered, 'utf8');
  return tampered;
}

// ---------------------------------------------------------------------------
// 进程内：真实临时目录 + realHost
// ---------------------------------------------------------------------------

describe('init → sync → 手改区间 → 冲突（进程内，真实 fs）', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await createWorkspace('inproc');
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    await runSync({ host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION });
  });

  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('区间内手动修改 → ConflictError(3)，退出码语义成立，文件逐字节未被修改（§8.2-4/§11.2.9）', async () => {
    const tampered = await tamperSection(ws);

    const err = await runSync({
      host: ws.host,
      cwd: ws.root,
      os: OS,
      agentforgeVersion: VERSION,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    const conflict = err as ConflictError;
    expect(conflict.code).toBe(ExitCode.Conflict);
    expect(toExitCode(conflict)).toBe(3);
    expect(conflict.message).toContain('aforge doctor');
    expect(conflict.hint).toContain('--force');
    // 零副作用：预检查在任何写入/备份之前，篡改内容原样保留
    expect(await readFile(ws.claudeMd, 'utf8')).toBe(tampered);
  }, 30_000);

  it('sync --force → 跳过预检查成功覆盖，区间恢复最新渲染（§8.2-4）', async () => {
    await tamperSection(ws);

    const result = await runSync(
      { host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION },
      { force: true },
    );

    expect(result.targets.map((t) => t.targetId)).toContain('claude');
    const claude = await readFile(ws.claudeMd, 'utf8');
    const split = splitByMarkers(claude, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END);
    expect(split.inside).toContain('# AgentForge Rules');
    expect(split.inside).not.toContain('Manually edited');
    // 冲突解决后 sync-meta 基准与投影区间重新对齐
    const meta = JSON.parse(await readFile(ws.syncMetaPath, 'utf8')) as {
      targets: Record<string, { contentHash: string }>;
    };
    expect(meta.targets.claude?.contentHash).toBe(result.contentHash);
  }, 30_000);

  it('脏投影 doctor → projection-hash warn "hash 不一致"，退出码仍 0（§11.2.4/§9）', async () => {
    await tamperSection(ws);
    const report = await runDoctor({ host: ws.host, cwd: ws.root, os: OS });

    const hashCheck = report.results.find((r) => r.item === 'projection-hash/claude');
    expect(hashCheck).toBeDefined();
    expect(hashCheck?.level).toBe('warn');
    expect(hashCheck?.detail).toContain('hash 不一致');
    expect(hashCheck?.detail).toContain(ws.claudeMd);
    expect(report.exitCode).toBe(0); // warn 提示级，不抬升退出码
  }, 30_000);

  it('--force 重新 sync 后 doctor → projection-hash/claude 恢复 ok', async () => {
    await tamperSection(ws);
    await runSync(
      { host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION },
      { force: true },
    );
    const report = await runDoctor({ host: ws.host, cwd: ws.root, os: OS });
    const hashCheck = report.results.find((r) => r.item === 'projection-hash/claude');
    expect(hashCheck?.level).toBe('ok');
  }, 30_000);

  it('status → scope / targets 绝对路径 / lastSyncAt / 计数（§6/§2.2）', async () => {
    const result = await runStatus({ host: ws.host, cwd: ws.root, os: OS });
    expect(result.effectiveScope).toBe('project');
    expect(result.projectSoTRoot).toBe(ws.sotRoot);
    expect(result.enabledTargets).toEqual(['opencode', 'codex', 'claude', 'pi']);
    const claude = result.targets.find((t) => t.targetId === 'claude');
    expect(claude?.paths).toContain(ws.claudeMd);
    expect(result.lastSyncAt).not.toBeNull();
    // init 建骨架（SOT_SUBDIRS 五目录）但无素材 → 计数 0
    expect(result.counts).toEqual({ custom: 0, learnings: 0, templates: 0 });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 子进程端到端：node --import tsx src/main.ts
// ---------------------------------------------------------------------------

describe('aforge sync 冲突 / --force / doctor（子进程端到端）', () => {
  let base: string;
  let tmpHome: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'aforge-conflict-e2e-'));
    tmpHome = path.join(base, 'home');
    await mkdir(tmpHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith('AGF_')) {
        delete env[key];
      }
    }
    env.USERPROFILE = tmpHome;
    env.HOME = tmpHome;
    return env;
  }

  function runCli(args: readonly string[], cwd: string) {
    return spawnSync(process.execPath, ['--import', tsxImport, mainTs, ...args], {
      cwd,
      env: childEnv(),
      encoding: 'utf8',
    });
  }

  it('手改区间 → sync 退出码 3（§11.2.9）→ --force 退出码 0 覆盖 → doctor 输出 warn（§11.2.4）', () => {
    const root = path.join(base, 'proj 冲突 e2e');
    mkdirSync(root);

    const init = runCli(['init'], root);
    expect(init.status).toBe(0);
    const sync1 = runCli(['sync'], root);
    expect(sync1.status).toBe(0);

    // 手改 marker 区间内一行（§11.2.9 场景）
    const claudeMd = path.join(root, 'CLAUDE.md');
    const claude = readFileSync(claudeMd, 'utf8');
    const tampered = claude.replace('# AgentForge Rules', '# Manually edited');
    writeFileSync(claudeMd, tampered, 'utf8');

    // sync → 退出码 3，stderr 引导 doctor；文件未被修改
    const sync2 = runCli(['sync'], root);
    expect(sync2.status).toBe(3);
    expect(sync2.stderr).toContain('aforge doctor');
    expect(readFileSync(claudeMd, 'utf8')).toBe(tampered);

    // doctor（人类可读）→ hash 不一致 warn，退出码 0（§11.2.4）
    const doctor1 = runCli(['doctor'], root);
    expect(doctor1.status).toBe(0);
    expect(doctor1.stdout).toContain('[WARN]');
    expect(doctor1.stdout).toContain('projection-hash/claude');
    expect(doctor1.stdout).toContain('hash 不一致');

    // sync --force → 退出码 0，区间恢复
    const sync3 = runCli(['sync', '--force'], root);
    expect(sync3.status).toBe(0);
    const restored = readFileSync(claudeMd, 'utf8');
    expect(restored).toContain('# AgentForge Rules');
    expect(restored).not.toContain('# Manually edited');

    // doctor 恢复全绿
    const doctor2 = runCli(['doctor'], root);
    expect(doctor2.status).toBe(0);
    expect(doctor2.stdout).toContain('[OK  ] projection-hash/claude');
  }, 180_000);

  it('doctor --json → 结构化结果（results 数组 + exitCode），status --json 可解析', () => {
    const root = path.join(base, 'proj json');
    mkdirSync(root);

    expect(runCli(['init'], root).status).toBe(0);
    expect(runCli(['sync'], root).status).toBe(0);

    const doctor = runCli(['doctor', '--json'], root);
    expect(doctor.status).toBe(0);
    const report = JSON.parse(doctor.stdout) as {
      results: { level: string; item: string }[];
      exitCode: number;
    };
    expect(Array.isArray(report.results)).toBe(true);
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.exitCode).toBe(0);

    const status = runCli(['status', '--json'], root);
    expect(status.status).toBe(0);
    const st = JSON.parse(status.stdout) as {
      effectiveScope: string;
      targets: { targetId: string }[];
      lastSyncAt: string | null;
    };
    expect(st.effectiveScope).toBe('project');
    expect(st.targets.map((t) => t.targetId)).toContain('claude');
    expect(st.lastSyncAt).not.toBeNull();
  }, 180_000);
});

// ---------------------------------------------------------------------------
// POSIX：真实只读目录（Windows 上目录只读属性不影响写入；EACCES 注入已由
// doctor-checks.spec 覆盖，此处验证真实 fs 权限语义）
// ---------------------------------------------------------------------------

const isPosix = process.platform !== 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe.skipIf(!isPosix || isRoot)('真实只读项目目录 doctor → 退出码 4（POSIX chmod 0555）', () => {
  it('init 后项目目录去写权限 → doctor 不可写 error(4)，退出码 4（§9/§6.1）', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'aforge-doctor-ro-'));
    const root = path.join(base, 'proj');
    const home = path.join(base, 'home');
    await mkdir(root, { recursive: true });
    await mkdir(home, { recursive: true });

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith('AGF_')) delete env[key];
    }
    env.USERPROFILE = home;
    env.HOME = home;

    try {
      const init = spawnSync(process.execPath, ['--import', tsxImport, mainTs, 'init'], {
        cwd: root,
        env,
        encoding: 'utf8',
      });
      expect(init.status).toBe(0);

      await chmod(root, 0o555); // 项目目录去写权限：目标目录探针失败

      const doctor = spawnSync(process.execPath, ['--import', tsxImport, mainTs, 'doctor'], {
        cwd: root,
        env,
        encoding: 'utf8',
      });
      expect(doctor.status).toBe(4);
      expect(doctor.stdout).toContain('[FAIL]');
      expect(doctor.stdout).toContain('不可写');
      expect(doctor.stdout).toContain('exit code 4');
    } finally {
      await chmod(root, 0o755); // 恢复以便清理
      await rm(base, { recursive: true, force: true });
    }
  }, 120_000);
});
