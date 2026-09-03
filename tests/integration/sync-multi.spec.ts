/**
 * sync 多 target 集成测试（M6，Spec §8.7 投影矩阵 / §7.3-6 事务回滚 / §8.2-8.6 /
 * §11.2.12 回滚验收 / §11.2.10 中文与空格路径）：
 *
 * 1) 四 target 全量 sync：AGENTS.md×1（opencode/codex/pi 共享）+ CLAUDE.md +
 *    opencode.json + .mcp.json + .codex\config.toml + .pi\mcp.json，
 *    内容一致共享同一渲染正文；
 * 2) custom/*.md 修改再 sync：marker 区间更新、marker 外保留（§11.2.2）；
 * 3) 回滚：目录/写入异常 → 退出码 4 → 其余 target 文件全部恢复
 *    （含"新建文件被删除"场景；Windows 注入 EPERM + POSIX 真实 chmod 0555）；
 * 4) MCP servers 配置：opencode.json 与 .mcp.json 深合并保留未知键、
 *    config.toml 标记段替换保注释；
 * 5) Pi MCP 目录异常 → sync 成功但输出 warning（§8.6 soft）。
 */
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit, runSync } from '../../src/commands/lifecycle';
import { PermissionError, toExitCode } from '../../src/core/errors';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END, splitByMarkers } from '../../src/core/markers';
import { currentOs } from '../../src/core/paths';
import { getSyncFailureReport } from '../../src/core/project/engine';
import { CODEX_MCP_TOML_BEGIN, CODEX_MCP_TOML_END } from '../../src/core/project/projectors/codex';
import type { Host } from '../../src/infra/host';
import { realHost } from '../../src/infra/real-host';

const OS = currentOs();
const VERSION = 'test-0.1.0';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainTs = path.join(repoRoot, 'src', 'main.ts');
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/** 去除首尾空行的对照基线（与 sync.spec 同一规范）。 */
function stripBlankEdges(s: string): string {
  return s.replace(/^\n+/, '').replace(/\n+$/, '');
}

/** EPERM 注入错误。 */
function eperm(message: string): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = 'EPERM';
  return e;
}

/** 带 mcp.servers 的 profile（stdio fs + http docs）。 */
const PROFILE_WITH_MCP = [
  'version: 1',
  'scope: project',
  'targets: [opencode, codex, claude, pi]',
  'mcp:',
  '  servers:',
  '    - name: fs',
  '      transport: stdio',
  '      command: npx',
  '      args: ["-y", "server-fs"]',
  '      env:',
  '        KEY: v',
  '    - name: docs',
  '      transport: http',
  '      url: https://example.com/mcp',
  '      headers:',
  '        Authorization: Bearer x',
  '',
].join('\n');

interface Workspace {
  readonly root: string;
  readonly home: string;
  readonly host: Host;
  readonly agentsMd: string;
  readonly claudeMd: string;
  readonly opencodeJson: string;
  readonly mcpJson: string;
  readonly codexToml: string;
  readonly piMcp: string;
  readonly sotRoot: string;
  readonly syncMetaPath: string;
}

/** mkdtemp 前缀含中文与空格：§11.2.10 全流程覆盖。 */
async function createWorkspace(label: string): Promise<Workspace> {
  const base = await mkdtemp(path.join(tmpdir(), `aforge-多target ${label}-`));
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
    agentsMd: path.join(root, 'AGENTS.md'),
    claudeMd: path.join(root, 'CLAUDE.md'),
    opencodeJson: path.join(root, 'opencode.json'),
    mcpJson: path.join(root, '.mcp.json'),
    codexToml: path.join(root, '.codex', 'config.toml'),
    piMcp: path.join(root, '.pi', 'mcp.json'),
    sotRoot,
    syncMetaPath: path.join(sotRoot, 'sync-meta.json'),
  };
}

async function disposeWorkspace(ws: Workspace): Promise<void> {
  await rm(path.dirname(ws.root), { recursive: true, force: true });
}

/** rename(to === denyPath) 抛 EPERM（atomicWrite 最终一步失败）。 */
function withDeniedRename(base: Host, denyPath: string): Host {
  return {
    ...base,
    async rename(from, to) {
      if (to === denyPath) {
        throw eperm(`injected EPERM: rename to ${denyPath}`);
      }
      return base.rename(from, to);
    },
  };
}

/** 对 denyPath 本体及其 atomicWrite 临时文件的 writeFile 抛 EPERM。 */
function withDeniedWrite(base: Host, denyPath: string): Host {
  return {
    ...base,
    async writeFile(p, content) {
      if (p === denyPath || p.startsWith(`${denyPath}.agf-`)) {
        throw eperm(`injected EPERM: write to ${p}`);
      }
      return base.writeFile(p, content);
    },
  };
}

// ---------------------------------------------------------------------------
// 进程内：真实临时目录 + realHost（env 覆盖）
// ---------------------------------------------------------------------------

describe('四 target 全量 sync（§8.7 投影矩阵）', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await createWorkspace('full');
  });

  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('六个投影文件全部生成，AGENTS.md×3（共享一份）+ CLAUDE.md 内容一致共享同一渲染正文', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });

    // dry-run 拿到精确 renderedRulesMd（渲染是纯函数）
    const dry = await runSync(
      { host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION },
      { dryRun: true },
    );
    const rendered = dry.targets[0]?.items[0]?.content as string;
    expect(rendered.length).toBeGreaterThan(0);

    const result = await runSync({
      host: ws.host,
      cwd: ws.root,
      os: OS,
      agentforgeVersion: VERSION,
    });
    expect(result.targets.map((t) => t.targetId)).toEqual(['opencode', 'codex', 'claude', 'pi']);
    expect(result.skippedTargets).toEqual([]);
    expect(result.warnings).toEqual([]);

    // §8.7：AGENTS.md 仅一份（opencode/codex/pi 共享），claude 独立 CLAUDE.md
    for (const file of [
      ws.agentsMd,
      ws.claudeMd,
      ws.opencodeJson,
      ws.mcpJson,
      ws.codexToml,
      ws.piMcp,
    ]) {
      expect(await stat(file)).toBeTruthy();
    }

    // AGENTS.md 与 CLAUDE.md 的 marker 区间一致且 = 统一渲染正文（§8.2）
    const agents = await readFile(ws.agentsMd, 'utf8');
    const claude = await readFile(ws.claudeMd, 'utf8');
    const agentsSplit = splitByMarkers(agents, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END);
    const claudeSplit = splitByMarkers(claude, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END);
    expect(agentsSplit.hasMarkers).toBe(true);
    expect(claudeSplit.hasMarkers).toBe(true);
    expect(agentsSplit.inside).toBe(claudeSplit.inside);
    expect(stripBlankEdges(agentsSplit.inside as string)).toBe(stripBlankEdges(rendered));

    // MCP 管理键（无 servers → 空管理键声明）；config.toml 标记段
    expect(JSON.parse(await readFile(ws.opencodeJson, 'utf8'))).toEqual({ mcp: {} });
    expect(JSON.parse(await readFile(ws.mcpJson, 'utf8'))).toEqual({ mcpServers: {} });
    expect(JSON.parse(await readFile(ws.piMcp, 'utf8'))).toEqual({ mcpServers: {} });
    const toml = await readFile(ws.codexToml, 'utf8');
    expect(toml).toContain(CODEX_MCP_TOML_BEGIN);
    expect(toml).toContain(CODEX_MCP_TOML_END);

    // 共享 AGENTS.md：opencode 实写、codex/pi 幂等跳写
    expect(result.targets[0]?.statuses[0]).toBe('written');
    expect(result.targets[1]?.statuses[0]).toBe('unchanged');
    expect(result.targets[3]?.statuses[0]).toBe('unchanged');
  }, 30_000);

  it('custom/*.md 修改再 sync：四 target 的 marker 区间均更新、marker 外保留（§11.2.2）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    await runSync({ host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION });

    // 两个主规则文件的 marker 外加用户内容
    const agentsV1 = await readFile(ws.agentsMd, 'utf8');
    const claudeV1 = await readFile(ws.claudeMd, 'utf8');
    await writeFile(
      ws.agentsMd,
      `# AGENTS 用户开头\n\n${agentsV1}<!-- AGENTS 尾部备注 -->\n`,
      'utf8',
    );
    await writeFile(
      ws.claudeMd,
      `# CLAUDE 用户开头\n\n${claudeV1}<!-- CLAUDE 尾部备注 -->\n`,
      'utf8',
    );

    // SoT custom 层增加内容（渲染结果变化）
    await mkdir(path.join(ws.sotRoot, 'custom'), { recursive: true });
    await writeFile(
      path.join(ws.sotRoot, 'custom', 'extra.md'),
      '## 额外约定\n- 测试追加规则\n',
      'utf8',
    );

    await runSync({ host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION });

    const agentsV2 = await readFile(ws.agentsMd, 'utf8');
    const claudeV2 = await readFile(ws.claudeMd, 'utf8');

    // marker 区间更新（新 custom 内容进入全部主规则）
    expect(agentsV2).toContain('额外约定');
    expect(claudeV2).toContain('额外约定');
    // marker 外保留
    expect(agentsV2).toContain('# AGENTS 用户开头');
    expect(agentsV2).toContain('<!-- AGENTS 尾部备注 -->');
    expect(claudeV2).toContain('# CLAUDE 用户开头');
    expect(claudeV2).toContain('<!-- CLAUDE 尾部备注 -->');
    // 两个文件的 marker 区间仍共享同一渲染正文
    const agentsSplit = splitByMarkers(agentsV2, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END);
    const claudeSplit = splitByMarkers(claudeV2, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END);
    expect(agentsSplit.inside).toBe(claudeSplit.inside);
    expect(agentsSplit.inside).toContain('额外约定');
  }, 30_000);
});

describe('MCP servers 配置后的投影（§8.3/§8.4/§8.5/§8.6 管理键）', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await createWorkspace('mcp');
  });

  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('opencode.json 与 .mcp.json 深合并保留未知键；config.toml 标记段替换保注释', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });

    // profile 配置 MCP servers（两层合并：project 层覆盖）
    await writeFile(path.join(ws.sotRoot, 'profile.yaml'), PROFILE_WITH_MCP, 'utf8');

    // 预置用户配置（验证未知键保留 / 深合并不覆盖）
    await writeFile(
      ws.opencodeJson,
      `${JSON.stringify(
        { theme: 'dark', mcp: { fs: { type: 'local', command: ['old'], enabled: false } } },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await writeFile(
      ws.mcpJson,
      `${JSON.stringify({ otherKey: [1, 2], mcpServers: { fs: { command: 'old' } } }, null, 2)}\n`,
      'utf8',
    );
    await mkdir(path.join(ws.root, '.codex'), { recursive: true });
    await writeFile(
      ws.codexToml,
      [
        '# 用户注释（必须保留）',
        'model = "gpt-5"',
        '',
        CODEX_MCP_TOML_BEGIN,
        '[mcp_servers.old]',
        'command = "old"',
        CODEX_MCP_TOML_END,
        '',
        '# 尾部注释（必须保留）',
        '',
      ].join('\n'),
      'utf8',
    );

    await runSync({ host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION });

    // opencode.json：theme 保留、mcp 深合并（fs 覆盖为管理形态、docs 新增）
    expect(JSON.parse(await readFile(ws.opencodeJson, 'utf8'))).toEqual({
      theme: 'dark',
      mcp: {
        fs: {
          type: 'local',
          command: ['npx', '-y', 'server-fs'],
          enabled: true,
          environment: { KEY: 'v' },
        },
        docs: {
          type: 'remote',
          url: 'https://example.com/mcp',
          enabled: true,
          headers: { Authorization: 'Bearer x' },
        },
      },
    });

    // .mcp.json：otherKey 保留、mcpServers 覆盖管理键（claude 每条显式带 type）
    expect(JSON.parse(await readFile(ws.mcpJson, 'utf8'))).toEqual({
      otherKey: [1, 2],
      mcpServers: {
        fs: { type: 'stdio', command: 'npx', args: ['-y', 'server-fs'], env: { KEY: 'v' } },
        docs: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer x' },
        },
      },
    });

    // config.toml：用户注释 / model 保留，标记段内替换为新表块、旧 server 消失
    const toml = await readFile(ws.codexToml, 'utf8');
    expect(toml).toContain('# 用户注释（必须保留）');
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain('# 尾部注释（必须保留）');
    expect(toml).toContain('[mcp_servers.fs]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('args = ["-y", "server-fs"]');
    expect(toml).toContain('env = { KEY = "v" }');
    expect(toml).toContain('[mcp_servers.docs]');
    expect(toml).toContain('url = "https://example.com/mcp"');
    expect(toml).toContain('http_headers = { Authorization = "Bearer x" }');
    expect(toml).not.toContain('[mcp_servers.old]');
    expect(toml).not.toContain('command = "old"');

    // pi .pi\mcp.json：顶层键与 .mcp.json 同名，但条目无 type（transport 由字段互斥判定）；
    // 远端条目显式带 httpTransport（留空会让上一轮的 "sse" 在深合并里活下来，issue #69）
    expect(JSON.parse(await readFile(ws.piMcp, 'utf8'))).toEqual({
      mcpServers: {
        fs: { command: 'npx', args: ['-y', 'server-fs'], env: { KEY: 'v' } },
        docs: {
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer x' },
          httpTransport: 'streamable-http',
        },
      },
    });

    // 幂等：再 sync 全部 unchanged（深合并结果稳定）
    const second = await runSync({
      host: ws.host,
      cwd: ws.root,
      os: OS,
      agentforgeVersion: VERSION,
    });
    for (const target of second.targets) {
      expect(target.statuses.every((s) => s === 'unchanged')).toBe(true);
    }
  }, 30_000);
});

describe('事务回滚（§7.3-6 / §11.2.12）', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await createWorkspace('rollback');
  });

  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('target 写入失败（rename EPERM 注入）→ 退出码 4，其余 target 文件全部恢复到 sync 前内容', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });

    // 预置用户内容：AGENTS.md（marker 外 + 旧区间）、opencode.json（未知键）
    const agentsPreset = `# 项目说明\n\n${DEFAULT_MARKER_BEGIN}\n旧规则\n${DEFAULT_MARKER_END}\n\n尾部备注\n`;
    const opencodePreset = '{"theme": "dark"}\n';
    await writeFile(ws.agentsMd, agentsPreset, 'utf8');
    await writeFile(ws.opencodeJson, opencodePreset, 'utf8');

    // codex 的 config.toml rename 失败（opencode 两项已写入、claude/pi 未开始）
    const denied = withDeniedRename(ws.host, ws.codexToml);
    const err = await runSync({
      host: denied,
      cwd: ws.root,
      os: OS,
      agentforgeVersion: VERSION,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PermissionError);
    expect(toExitCode(err as PermissionError)).toBe(4);

    // 已写文件逐字节恢复到 sync 前内容
    expect(await readFile(ws.agentsMd, 'utf8')).toBe(agentsPreset);
    expect(await readFile(ws.opencodeJson, 'utf8')).toBe(opencodePreset);

    // 未开始的 target（claude/pi）无任何文件
    expect(await realHost.exists(ws.claudeMd)).toBe(false);
    expect(await realHost.exists(ws.mcpJson)).toBe(false);
    expect(await realHost.exists(ws.piMcp)).toBe(false);

    // 失败汇总报告：每 target 状态表 + 回滚声明
    const report = getSyncFailureReport(err);
    expect(report?.failedTargetId).toBe('codex');
    expect(report?.failedPath).toBe(ws.codexToml);
    expect(report?.targetStatuses).toEqual([
      { targetId: 'opencode', status: 'ok-rolled-back' },
      { targetId: 'codex', status: 'failed' },
      { targetId: 'claude', status: 'not-started' },
      { targetId: 'pi', status: 'not-started' },
    ]);
    expect(report?.rolledBack.map((r) => r.path)).toEqual([ws.opencodeJson, ws.agentsMd]);
    expect(report?.rolledBack.every((r) => r.restored)).toBe(true);

    // 回滚则不更新 sync-meta
    expect(await realHost.exists(ws.syncMetaPath)).toBe(false);
  }, 30_000);

  it('全新目录失败回滚：本次新建的文件被删除（含共享 AGENTS.md）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });

    const denied = withDeniedRename(ws.host, ws.codexToml);
    const err = await runSync({
      host: denied,
      cwd: ws.root,
      os: OS,
      agentforgeVersion: VERSION,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PermissionError);
    expect(toExitCode(err as PermissionError)).toBe(4);

    // 新建文件被删除（备份为 null → rm）
    expect(await realHost.exists(ws.agentsMd)).toBe(false);
    expect(await realHost.exists(ws.opencodeJson)).toBe(false);
    expect(await realHost.exists(ws.claudeMd)).toBe(false);

    const report = getSyncFailureReport(err);
    expect(report?.rolledBack.map((r) => r.path)).toEqual([ws.opencodeJson, ws.agentsMd]);
    expect(report?.rolledBack.every((r) => r.restored)).toBe(true);
    expect(await realHost.exists(ws.syncMetaPath)).toBe(false);
  }, 30_000);
});

describe('Pi soft（§8.6 MVP best-effort）', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await createWorkspace('soft');
  });

  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('mcp.json 目录异常（写入注入失败）→ sync 成功但输出 warning，其余 target 正常', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });

    const denied = withDeniedWrite(ws.host, ws.piMcp);
    const result = await runSync({
      host: denied,
      cwd: ws.root,
      os: OS,
      agentforgeVersion: VERSION,
    });

    // 整体成功：四 target 全部执行
    expect(result.targets.map((t) => t.targetId)).toEqual(['opencode', 'codex', 'claude', 'pi']);
    expect(result.warnings).toEqual([expect.objectContaining({ targetId: 'pi', path: ws.piMcp })]);

    // 其余 target 文件正常；mcp.json 未写入
    expect(await realHost.exists(ws.agentsMd)).toBe(true);
    expect(await realHost.exists(ws.opencodeJson)).toBe(true);
    expect(await realHost.exists(ws.codexToml)).toBe(true);
    expect(await realHost.exists(ws.claudeMd)).toBe(true);
    expect(await realHost.exists(ws.piMcp)).toBe(false);

    // sync-meta：pi 不记录（投影不完整不提供 doctor 基准）
    const meta = JSON.parse(await readFile(ws.syncMetaPath, 'utf8')) as {
      targets: Record<string, unknown>;
    };
    expect(Object.keys(meta.targets).sort()).toEqual(['claude', 'codex', 'opencode']);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// POSIX：真实 chmod（Windows 目录只读属性不阻止写入，注入版已由上方用例覆盖）
// ---------------------------------------------------------------------------

const isPosix = process.platform !== 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe.skipIf(!isPosix || isRoot)('真实只读 target 目录（POSIX chmod 0555，§11.2.12）', () => {
  it('.codex 只读 → 子进程 sync 退出码 4，其余 target 文件恢复到 sync 前内容', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'aforge-m6-rollback-'));
    const root = path.join(base, 'proj');
    const home = path.join(base, 'home');
    await mkdir(root, { recursive: true });
    await mkdir(home, { recursive: true });

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith('AGF_')) {
        delete env[key];
      }
    }
    env.USERPROFILE = home;
    env.HOME = home;

    const runCli = (args: readonly string[]) =>
      spawnSync(process.execPath, ['--import', tsxImport, mainTs, ...args], {
        cwd: root,
        env,
        encoding: 'utf8',
      });

    try {
      expect(runCli(['init']).status).toBe(0);
      expect(runCli(['sync']).status).toBe(0);

      const agentsMd = path.join(root, 'AGENTS.md');
      const opencodeJson = path.join(root, 'opencode.json');
      const claudeMd = path.join(root, 'CLAUDE.md');
      const mcpJson = path.join(root, '.mcp.json');
      const agentsV1 = await readFile(agentsMd, 'utf8');
      const opencodeV1 = await readFile(opencodeJson, 'utf8');
      const claudeV1 = await readFile(claudeMd, 'utf8');
      const mcpV1 = await readFile(mcpJson, 'utf8');

      // 渲染变化（custom）+ MCP 变化（profile）→ AGENTS.md 与 opencode.json 均需重写
      await writeFile(
        path.join(root, '.agentforge', 'custom', 'extra.md'),
        '## 追加规则\n',
        'utf8',
      );
      await writeFile(path.join(root, '.agentforge', 'profile.yaml'), PROFILE_WITH_MCP, 'utf8');

      await chmod(path.join(root, '.codex'), 0o555); // target 目录只读

      const sync = runCli(['sync']);
      expect(sync.status).toBe(4);
      expect(sync.stderr).toContain('rolled back');

      // 其余 target 文件恢复到 sync 前内容（逐字节）
      expect(await readFile(agentsMd, 'utf8')).toBe(agentsV1);
      expect(await readFile(opencodeJson, 'utf8')).toBe(opencodeV1);
      // 未开始的 target（claude/pi）：v1 的产物原样留着，本次 sync 的新内容一个字节都没进去
      // （init 已把四个 target 全部投影，所以这里不是"文件不存在"，而是"内容仍是 v1"）
      expect(await readFile(claudeMd, 'utf8')).toBe(claudeV1);
      expect(await readFile(mcpJson, 'utf8')).toBe(mcpV1);
      // v2 profile 新增的 MCP server 只应出现在 sync 成功的产物里，claude 侧不该有
      expect(mcpV1).not.toContain('server-fs');
    } finally {
      await chmod(path.join(root, '.codex'), 0o755);
      await rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('.pi 目录只读（mcp.json 尚不存在）→ sync 成功 + warning（§8.6 soft，真实 EACCES）', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'aforge-m6-soft-'));
    const root = path.join(base, 'proj');
    const home = path.join(base, 'home');
    await mkdir(root, { recursive: true });
    await mkdir(home, { recursive: true });
    const piDir = path.join(root, '.pi');

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

    try {
      await runInit({ host, cwd: root, os: OS });
      await mkdir(piDir, { recursive: true });
      await chmod(piDir, 0o555); // mcp.json 写入将失败（EACCES）

      const result = await runSync({ host, cwd: root, os: OS, agentforgeVersion: VERSION });

      expect(result.warnings).toEqual([
        expect.objectContaining({ targetId: 'pi', path: path.join(piDir, 'mcp.json') }),
      ]);
      expect(await realHost.exists(path.join(root, 'AGENTS.md'))).toBe(true);
      expect(await realHost.exists(path.join(root, 'CLAUDE.md'))).toBe(true);
      expect(await realHost.exists(path.join(piDir, 'mcp.json'))).toBe(false);

      const meta = JSON.parse(
        await readFile(path.join(root, '.agentforge', 'sync-meta.json'), 'utf8'),
      ) as {
        targets: Record<string, unknown>;
      };
      expect(Object.keys(meta.targets).sort()).toEqual(['claude', 'codex', 'opencode']);
    } finally {
      await chmod(piDir, 0o755);
      await rm(base, { recursive: true, force: true });
    }
  }, 60_000);
});
