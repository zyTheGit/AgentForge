/**
 * M9 集成测试：init -i 交互五步流程（Spec §7.1.1）与 import 命令（§7.7）。
 *
 * 交互测试用脚本化 fake Prompt（tests/unit/test-utils.ts 的
 * createScriptedPrompt）驱动 runInitInteractive——探测 / 写入 / sync 全走
 * 真实临时目录 + realHost（env 经包装 host 覆盖指向临时 home）；mkdtemp
 * 前缀含中文与空格（沿用既有约定）。
 *
 * import 测试覆盖：§7.7-1 文件存在性 / §7.7-2 文件名识别 / §7.7-4 映射
 * （detected.import 建议 + custom 素材）/ §7.7-6 不自动 sync（提示手动执行）/
 * 既有声明与探测快照不被覆盖 / 子进程端到端退出码。
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runImport } from '../../src/commands/import';
import { runInit, runInitInteractive, SOT_SUBDIRS } from '../../src/commands/init';
import { runSync } from '../../src/commands/sync';
import { currentOs } from '../../src/core/paths';
import { ConfigError } from '../../src/core/errors';
import { realHost } from '../../src/infra/real-host';
import type { Host } from '../../src/infra/host';
import { createScriptedPrompt } from '../unit/test-utils';

const OS = currentOs();
const VERSION = 'test-0.1.0';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainTs = path.join(repoRoot, 'src', 'main.ts');
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

interface Workspace {
  readonly root: string;
  readonly home: string;
  readonly host: Host;
  readonly sotRoot: string;
  readonly habitsFile: string;
  readonly profileFile: string;
}

async function createWorkspace(label: string): Promise<Workspace> {
  const base = await mkdtemp(path.join(tmpdir(), `aforge-M9交互 ${label}-`));
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
    sotRoot,
    habitsFile: path.join(sotRoot, 'habits.yaml'),
    profileFile: path.join(sotRoot, 'profile.yaml'),
  };
}

async function disposeWorkspace(ws: Workspace): Promise<void> {
  await rm(path.dirname(ws.root), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// init -i 交互五步（Spec §7.1.1）
// ---------------------------------------------------------------------------

describe('init -i 交互五步（Spec §7.1.1）', () => {
  let ws: Workspace;
  beforeEach(async () => {
    ws = await createWorkspace('init-i');
  });
  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  /** 默认全确认脚本：scope(project) → 探测确认 → targets 全选 → 写入 → 不 sync。 */
  const DEFAULT_SCRIPT = [
    { kind: 'select', value: 'project' },
    { kind: 'select', value: 'confirm' },
    { kind: 'multiselect', value: ['opencode', 'codex', 'claude', 'pi'] },
    { kind: 'confirm', value: true },
    { kind: 'confirm', value: false },
  ] as const;

  it('默认路径五步走通：产物齐备 + targets/快照持久化 + 未 sync（≤5 次确认）', async () => {
    const scripted = createScriptedPrompt(DEFAULT_SCRIPT);
    const result = await runInitInteractive(
      { host: ws.host, cwd: ws.root, os: OS, prompt: scripted.prompt, agentforgeVersion: VERSION },
      {},
    );

    // ≤5 次确认（scope → 探测确认 → targets → 写入 → sync，§7.1.1）
    expect(scripted.questionCount()).toBeLessThanOrEqual(5);
    expect(scripted.questionCount()).toBe(5);

    expect(result.cancelled).toBe(false);
    expect(result.synced).toBe(false);
    expect(result.scope).toBe('project');
    expect(result.targets).toEqual(['opencode', 'codex', 'claude', 'pi']);

    // 产物：habits/profile + 五个子目录
    expect(result.createdFiles).toEqual([ws.habitsFile, ws.profileFile]);
    expect(result.createdDirs).toEqual(SOT_SUBDIRS.map((d) => path.join(ws.sotRoot, d)));

    // habits.yaml：detected 快照（真实探测结果落盘）
    const habits = parseYaml(await readFile(ws.habitsFile, 'utf8'));
    expect(habits.version).toBe(1);
    expect(habits.detected).toHaveProperty('node');
    expect(habits.detected).toHaveProperty('shell');

    // profile.yaml：交互选择的 targets 持久化
    const profile = parseYaml(await readFile(ws.profileFile, 'utf8'));
    expect(profile.scope).toBe('project');
    expect(profile.targets).toEqual(['opencode', 'codex', 'claude', 'pi']);

    // 未选择立即 sync → 无投影产物、无 sync-meta
    const syncMeta = path.join(ws.sotRoot, 'sync-meta.json');
    expect(await ws.host.exists(path.join(ws.root, 'AGENTS.md'))).toBe(false);
    expect(await ws.host.exists(syncMeta)).toBe(false);
  });

  it('部分 targets 选择 → profile.targets 只含所选且顺序稳定', async () => {
    const scripted = createScriptedPrompt([
      { kind: 'select', value: 'project' },
      { kind: 'select', value: 'confirm' },
      // 用户乱序点选：claude 先、opencode 后 → 输出仍按固定顺序
      { kind: 'multiselect', value: ['claude', 'opencode'] },
      { kind: 'confirm', value: true },
      { kind: 'confirm', value: false },
    ]);
    const result = await runInitInteractive(
      { host: ws.host, cwd: ws.root, os: OS, prompt: scripted.prompt, agentforgeVersion: VERSION },
      {},
    );

    expect(result.targets).toEqual(['opencode', 'claude']);
    const profile = parseYaml(await readFile(ws.profileFile, 'utf8'));
    expect(profile.targets).toEqual(['opencode', 'claude']);
  });

  it('写入确认选 n → cancelled，不写任何文件', async () => {
    const scripted = createScriptedPrompt([
      { kind: 'select', value: 'project' },
      { kind: 'select', value: 'confirm' },
      { kind: 'multiselect', value: ['opencode', 'codex', 'claude', 'pi'] },
      { kind: 'confirm', value: false },
    ]);
    const result = await runInitInteractive(
      { host: ws.host, cwd: ws.root, os: OS, prompt: scripted.prompt, agentforgeVersion: VERSION },
      {},
    );

    expect(result.cancelled).toBe(true);
    expect(result.createdFiles).toEqual([]);
    expect(await ws.host.exists(ws.habitsFile)).toBe(false);
    expect(await ws.host.exists(ws.profileFile)).toBe(false);
  });

  it('n 重新探测 → 探测循环后再确认（交互步骤序列）', async () => {
    const scripted = createScriptedPrompt([
      { kind: 'select', value: 'project' },
      { kind: 'select', value: 'redetect' },
      { kind: 'select', value: 'confirm' },
      { kind: 'multiselect', value: ['opencode', 'codex', 'claude', 'pi'] },
      { kind: 'confirm', value: true },
      { kind: 'confirm', value: false },
    ]);
    const result = await runInitInteractive(
      { host: ws.host, cwd: ws.root, os: OS, prompt: scripted.prompt, agentforgeVersion: VERSION },
      {},
    );

    expect(result.cancelled).toBe(false);
    // 探测确认问了两次（redetect 一次 + confirm 一次）
    const confirms = scripted.calls.filter(
      (c) => c.kind === 'select' && c.message.includes('确认探测结果'),
    );
    expect(confirms).toHaveLength(2);
    // 6 次提问（重新探测多一次确认）
    expect(scripted.questionCount()).toBe(6);
  });

  it('edit 分支：habits.yaml 先落盘 → 等待期间用户编辑 → 编辑内容成为最终 habits', async () => {
    const scripted = createScriptedPrompt([
      { kind: 'select', value: 'project' },
      { kind: 'select', value: 'edit' },
      {
        kind: 'confirm',
        value: true,
        // 模拟用户在"等待编辑"期间改写 habits.yaml（声明字段覆盖探测）
        effect: async () => {
          await writeFile(
            ws.habitsFile,
            [
              'version: 1',
              'runtime:',
              '  node:',
              '    manager: fnm',
              '  python:',
              '    manager: uv',
              '',
            ].join('\n'),
            'utf8',
          );
        },
      },
      { kind: 'multiselect', value: ['opencode', 'codex', 'claude', 'pi'] },
      { kind: 'confirm', value: true },
      { kind: 'confirm', value: false },
    ]);
    const result = await runInitInteractive(
      { host: ws.host, cwd: ws.root, os: OS, prompt: scripted.prompt, agentforgeVersion: VERSION },
      {},
    );

    expect(result.cancelled).toBe(false);
    // edit 分支 habits 已在等待前写入 → 第⑤步只新写 profile
    expect(result.createdFiles).toEqual([ws.profileFile]);
    // 用户编辑的声明字段保留（不被覆盖回骨架）
    const habits = parseYaml(await readFile(ws.habitsFile, 'utf8'));
    expect(habits.runtime?.node?.manager).toBe('fnm');
    expect(habits.runtime?.python?.manager).toBe('uv');
  });

  it('立即 sync → synced=true，四 target 投影落地 + sync-meta 生成', async () => {
    const scripted = createScriptedPrompt([
      { kind: 'select', value: 'project' },
      { kind: 'select', value: 'confirm' },
      { kind: 'multiselect', value: ['opencode', 'codex', 'claude', 'pi'] },
      { kind: 'confirm', value: true },
      { kind: 'confirm', value: true },
    ]);
    const result = await runInitInteractive(
      { host: ws.host, cwd: ws.root, os: OS, prompt: scripted.prompt, agentforgeVersion: VERSION },
      {},
    );

    expect(result.synced).toBe(true);
    expect(await ws.host.exists(path.join(ws.root, 'AGENTS.md'))).toBe(true);
    expect(await ws.host.exists(path.join(ws.root, 'CLAUDE.md'))).toBe(true);
    expect(await ws.host.exists(path.join(ws.sotRoot, 'sync-meta.json'))).toBe(true);
  });

  it('--scope user 显式给出时跳过 scope 询问（仍 ≤4 次确认），产物在用户级 SoT', async () => {
    const scripted = createScriptedPrompt([
      { kind: 'select', value: 'confirm' },
      { kind: 'multiselect', value: ['opencode', 'codex', 'claude', 'pi'] },
      { kind: 'confirm', value: true },
      { kind: 'confirm', value: false },
    ]);
    const result = await runInitInteractive(
      { host: ws.host, cwd: ws.root, os: OS, prompt: scripted.prompt, agentforgeVersion: VERSION },
      { scope: 'user' },
    );

    expect(result.scope).toBe('user');
    expect(result.sotRoot).toBe(path.join(ws.home, '.agentforge'));
    expect(scripted.questionCount()).toBe(4);
    // 产物在用户级 SoT（而非项目级）
    const profile = parseYaml(await readFile(path.join(ws.home, '.agentforge', 'profile.yaml'), 'utf8'));
    expect(profile.scope).toBe('user');
    expect(profile.targets).toEqual(['opencode', 'codex', 'claude', 'pi']);
    expect(await ws.host.exists(ws.profileFile)).toBe(false); // 项目级 SoT 未创建
  });

  it('已初始化 → ConfigError(2)（scope 询问后、探测前 fail-fast）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS }, { scope: 'project' });

    const scripted = createScriptedPrompt(DEFAULT_SCRIPT);
    await expect(
      runInitInteractive(
        { host: ws.host, cwd: ws.root, os: OS, prompt: scripted.prompt, agentforgeVersion: VERSION },
        {},
      ),
    ).rejects.toMatchObject({ code: 2 });
    // 仅消耗 scope 询问（需先确定 scope 才能检查对应 SoT 是否已初始化），后续应答未消耗
    expect(scripted.questionCount()).toBe(1);
  });

  it('交互 init 产物可正常 sync（与后续命令链路衔接）', async () => {
    const scripted = createScriptedPrompt(DEFAULT_SCRIPT);
    await runInitInteractive(
      { host: ws.host, cwd: ws.root, os: OS, prompt: scripted.prompt, agentforgeVersion: VERSION },
      {},
    );

    const syncResult = await runSync(
      { host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION },
      {},
    );
    expect(syncResult.targets.map((t) => t.targetId)).toEqual([
      'opencode',
      'codex',
      'claude',
      'pi',
    ]);
    expect(await ws.host.exists(path.join(ws.root, 'CLAUDE.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// import（Spec §7.7）
// ---------------------------------------------------------------------------

/** 典型 AGENTS.md 导入样本：工具链块 + 风格块 + 用户文件头。 */
const IMPORT_SAMPLE = [
  '# 项目规则',
  '',
  '## 工具链',
  '- Node 版本用 fnm 管理。',
  '- Python 环境用 uv。',
  '- JS 包优先 pnpm。',
  '',
  '## 代码风格',
  '简洁，外科手术式修改。',
  '',
].join('\n');

describe('import 命令（Spec §7.7）', () => {
  let ws: Workspace;
  let agentsMd: string;
  beforeEach(async () => {
    ws = await createWorkspace('import');
    agentsMd = path.join(ws.root, 'AGENTS.md');
    await writeFile(agentsMd, IMPORT_SAMPLE, 'utf8');
  });
  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('未初始化 → ConfigError(2)', async () => {
    await expect(runImport({ host: ws.host, cwd: ws.root, os: OS }, agentsMd)).rejects.toMatchObject(
      {
        code: 2,
        name: 'ConfigError',
      },
    );
  });

  it('文件不存在 → ConfigError(2)', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS }, { scope: 'project' });
    await expect(
      runImport({ host: ws.host, cwd: ws.root, os: OS }, path.join(ws.root, 'nope.md')),
    ).rejects.toMatchObject({ code: 2 });
  });

  it('文件名不是 AGENTS.md / CLAUDE.md → ConfigError(2)', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS }, { scope: 'project' });
    const other = path.join(ws.root, 'RULES.md');
    await writeFile(other, IMPORT_SAMPLE, 'utf8');
    await expect(runImport({ host: ws.host, cwd: ws.root, os: OS }, other)).rejects.toMatchObject({
      code: 2,
    });
  });

  it('映射：工具链声明 → habits.detected.import；风格块 → custom/imported-*.md（§7.7-4/13）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS }, { scope: 'project' });

    const result = await runImport({ host: ws.host, cwd: ws.root, os: OS }, agentsMd);

    expect(result.kind).toBe('AGENTS.md');
    expect(result.suggestions.nodeManager).toBe('fnm');
    expect(result.suggestions.pythonManager).toBe('uv');
    expect(result.suggestions.packageManagers).toEqual(['pnpm']);

    // habits.detected.import 建议（source: 'import'）且既有声明/探测快照保留
    const habits = parseYaml(await readFile(ws.habitsFile, 'utf8'));
    expect(habits.detected.import).toMatchObject({
      source: 'import',
      imported_from: 'AGENTS.md',
      node: { manager: 'fnm', source: 'import' },
      python: { manager: 'uv', source: 'import' },
      package_managers: [{ name: 'pnpm', source: 'import' }],
    });
    expect(habits.detected.import.imported_at).toEqual(expect.any(String));
    expect(habits.detected).toHaveProperty('shell'); // 探测快照未被覆盖
    expect(habits.version).toBe(1);

    // custom 素材：风格块 + 文件头块（原样保留标题），无工具链块内容
    expect(result.customFile).not.toBeNull();
    const customContent = await readFile(result.customFile as string, 'utf8');
    expect(customContent).toContain('# 项目规则');
    expect(customContent).toContain('## 代码风格');
    expect(customContent).toContain('简洁，外科手术式修改。');
    expect(customContent).not.toContain('fnm');
    expect(path.basename(result.customFile as string)).toMatch(/^imported-\d{8}-\d{6}\.md$/);
  });

  it('含 AgentForge marker 区间的 AGENTS.md → 区间内容跳过（§7.7-7）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS }, { scope: 'project' });

    // 声明字段写入 fnm → sync 后 marker 区间内渲染 "- Node: use **fnm** only"
    await writeFile(
      ws.habitsFile,
      ['version: 1', 'runtime:', '  node:', '    manager: fnm', ''].join('\n'),
      'utf8',
    );
    // 清空 beforeEach 写入的样本，让 AGENTS.md 成为纯 AgentForge 投影产物（marker 区间外无用户内容）
    await writeFile(agentsMd, '', 'utf8');
    await runSync({ host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION }, {});

    // sync 后的 AGENTS.md 仅含 marker 区间（fnm 在区间内）+ 追加的手写工具链块
    const synced = await readFile(agentsMd, 'utf8');
    expect(synced).toContain('fnm');
    const withManual = `${synced}\n## 手写工具链\n用 volta。\n`;
    await writeFile(agentsMd, withManual, 'utf8');

    const result = await runImport({ host: ws.host, cwd: ws.root, os: OS }, agentsMd);

    // marker 区间内的 fnm 不产生建议；只有手写块的 volta
    expect(result.suggestions.nodeManager).toBe('volta');
    expect(result.suggestions.pythonManager).toBeUndefined();
  });

  it('重复 import → detected.import 被最新导入覆盖；既有声明字段不动', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS }, { scope: 'project' });
    await runImport({ host: ws.host, cwd: ws.root, os: OS }, agentsMd);

    // 用户把建议提升为声明字段
    await writeFile(
      ws.habitsFile,
      [
        'version: 1',
        'runtime:',
        '  node:',
        '    manager: fnm',
        'detected:',
        '  shell: powershell',
        '  import:',
        '    source: import',
        '    imported_from: AGENTS.md',
        '',
      ].join('\n'),
      'utf8',
    );

    const claudeMd = path.join(ws.root, 'CLAUDE.md');
    await writeFile(claudeMd, '## 工具\n使用 nvm 和 poetry\n', 'utf8');
    const result = await runImport({ host: ws.host, cwd: ws.root, os: OS }, claudeMd);

    expect(result.suggestions.nodeManager).toBe('nvm');
    const habits = parseYaml(await readFile(ws.habitsFile, 'utf8'));
    expect(habits.runtime?.node?.manager).toBe('fnm'); // 声明字段不动
    expect(habits.detected.import.node).toEqual({ manager: 'nvm', source: 'import' }); // 覆盖为最新
  });

  it('全部为工具链块 → 无 custom 文件（null）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS }, { scope: 'project' });
    const onlyToolchain = path.join(ws.root, 'CLAUDE.md');
    await writeFile(onlyToolchain, '## 工具链\nfnm + uv + pnpm\n', 'utf8');

    const result = await runImport({ host: ws.host, cwd: ws.root, os: OS }, onlyToolchain);
    expect(result.customFile).toBeNull();
  });

  it('子进程端到端：aforge import 输出摘要且退出码 0；不自动 sync', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS }, { scope: 'project' });

    const result = spawnSync(process.execPath, ['--import', tsxImport, mainTs, 'import', 'AGENTS.md'], {
      cwd: ws.root,
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: ws.home, HOME: ws.home, AGF_HOME: '', CI: '' },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('aforge import - AGENTS.md');
    expect(result.stdout).toContain('node manager     : fnm');
    expect(result.stdout).toContain('python manager   : uv');
    expect(result.stdout).toContain('aforge sync');
    // §7.7-6：不自动 sync——提示手动执行而非直接投影
    expect(await ws.host.exists(path.join(ws.root, 'CLAUDE.md'))).toBe(false);
  });

  it('子进程端到端：未初始化 → 退出码 2，stderr 引导先 init', async () => {
    const result = spawnSync(process.execPath, ['--import', tsxImport, mainTs, 'import', 'AGENTS.md'], {
      cwd: ws.root,
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: ws.home, HOME: ws.home, AGF_HOME: '', CI: '' },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('未初始化');
    expect(result.stderr).toContain('aforge init');
  });
});

// ---------------------------------------------------------------------------
// init -i 非 TTY 防护（子进程端到端：spawn 无 TTY）
// ---------------------------------------------------------------------------

describe('init -i 非 TTY 防护', () => {
  let ws: Workspace;
  beforeEach(async () => {
    ws = await createWorkspace('non-tty');
  });
  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('非 TTY 环境（CI / 管道）→ ConfigError(2)，hint 引导非交互参数', async () => {
    const result = spawnSync(
      process.execPath,
      ['--import', tsxImport, mainTs, 'init', '-i'],
      {
        cwd: ws.root,
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: ws.home, HOME: ws.home, AGF_HOME: '', CI: '' },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('非 TTY');
    expect(result.stderr).toContain('非交互');
    // 未写任何文件
    expect(await ws.host.exists(ws.habitsFile)).toBe(false);
  });
});
