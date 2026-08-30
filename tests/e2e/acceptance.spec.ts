/**
 * M9 最终验收 e2e（Spec §11.2）：覆盖需新增 / 补强的 5 条端到端——
 *
 * - §11.2.1 init -i 交互（edit 分支确认为声明）→ 真实探测 fnm/uv → 投影含
 *   变量渲染，且改声明后输出跟随变化（证明非内置写死）；
 * - §11.2.5 AGF_OFFLINE=1 下 init → sync 全走通（仅 base/default + 本地 habits）；
 * - §11.2.8 用户级 + 项目级 SoT 并存：custom 同名 project 覆盖 user、user 独有
 *   保留、habits overlay 合并（project 未设 → user 补缺）；
 * - §11.2.11 多模板启用：§5.2 顺序 custom → tpl-a → tpl-b → base/default，
 *   模板内变量渲染生效；
 * - §11.2.13 import 闭环：AGENTS.md 导入 → detected.import 映射 → 用户提升
 *   声明 → sync 投影（子进程端到端）。
 *
 * 其余各条（§11.2.2/3/4/6/7/9/10/12/14/15/16）由既有单元与集成测试覆盖，映射与
 * 结果见 tests/e2e/ACCEPTANCE.md。
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { runInit, runInitInteractive } from '../../src/commands/init';
import { runSync } from '../../src/commands/sync';
import { currentOs } from '../../src/core/paths';
import type { Host } from '../../src/infra/host';
import { realHost } from '../../src/infra/real-host';
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
  readonly userSoTRoot: string;
  readonly habitsFile: string;
  readonly profileFile: string;
  readonly agentsMd: string;
  readonly claudeMd: string;
}

/** mkdtemp 前缀含中文与空格（§11.2.10 对本文件全部用例同样生效）。 */
async function createWorkspace(
  label: string,
  envOverrides: Record<string, string | undefined> = {},
  stubExecutables: readonly string[] = [],
): Promise<Workspace> {
  const base = await mkdtemp(path.join(tmpdir(), `aforge-验收 ${label}-`));
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
    ...envOverrides,
  };

  // 探测器对 PATH 只做文件名匹配（core/detector/path-scan.ts：零子进程、不校验可执行位），
  // 所以空文件桩足以让"真实探测"在任意机器上确定命中。宿主是否装了 fnm/uv 不是被测属性，
  // 断言依赖它会让用例在 CI runner 上假失败。桩目录前置，真实 PATH 保留在后。
  if (stubExecutables.length > 0) {
    const win32 = process.platform === 'win32';
    const stubBin = path.join(base, 'stub-bin');
    await mkdir(stubBin, { recursive: true });
    for (const name of stubExecutables) {
      await writeFile(path.join(stubBin, `${name}${win32 ? '.exe' : ''}`), '', 'utf8');
    }
    overrides.PATH = [stubBin, realHost.env('PATH') ?? ''].join(win32 ? ';' : ':');
  }

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
    userSoTRoot: path.join(home, '.agentforge'),
    habitsFile: path.join(sotRoot, 'habits.yaml'),
    profileFile: path.join(sotRoot, 'profile.yaml'),
    agentsMd: path.join(root, 'AGENTS.md'),
    claudeMd: path.join(root, 'CLAUDE.md'),
  };
}

async function disposeWorkspace(ws: Workspace): Promise<void> {
  await rm(path.dirname(ws.root), { recursive: true, force: true });
}

/** 子进程跑真实 CLI（exit code / stdout 断言用）。 */
function runCli(
  args: readonly string[],
  cwd: string,
  home: string,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync(process.execPath, ['--import', tsxImport, mainTs, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: home, HOME: home, AGF_HOME: '', CI: '', ...extraEnv },
  });
}

/** 读 YAML → 改 → 写回（保留其余字段）。 */
async function patchYaml(
  file: string,
  patch: (data: Record<string, unknown>) => void,
): Promise<void> {
  const data = parseYaml(await readFile(file, 'utf8')) as Record<string, unknown>;
  patch(data);
  await writeFile(file, stringifyYaml(data, { lineWidth: 0 }), 'utf8');
}

// ---------------------------------------------------------------------------
// §11.2.1 init -i：探测 fnm/uv → 声明确认 → 变量渲染（非内置写死）
// ---------------------------------------------------------------------------

describe('§11.2.1 init -i 探测 fnm/uv + 投影变量渲染', () => {
  let ws: Workspace;
  beforeEach(async () => {
    ws = await createWorkspace('init-i-fnm-uv', {}, ['fnm', 'uv']);
  });
  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('探测快照含 fnm/uv；edit 分支确认为声明后 sync 渲染；改声明再 sync 输出跟随（非写死）', async () => {
    const scripted = createScriptedPrompt([
      { kind: 'select', value: 'project' },
      { kind: 'select', value: 'edit' },
      {
        kind: 'confirm',
        value: true,
        // 模拟用户核对探测结果后把 fnm/uv 写入声明字段（habits.yaml 已由 edit 分支落盘）
        effect: async () => {
          await patchYaml(ws.habitsFile, (data) => {
            const runtime = (data.runtime ?? {}) as Record<string, unknown>;
            runtime.node = { manager: 'fnm' };
            runtime.python = { manager: 'uv' };
            data.runtime = runtime;
          });
        },
      },
      { kind: 'multiselect', value: ['opencode', 'codex', 'claude', 'pi'] },
      { kind: 'confirm', value: true },
      { kind: 'confirm', value: true }, // 立即 sync
    ]);

    const result = await runInitInteractive(
      { host: ws.host, cwd: ws.root, os: OS, prompt: scripted.prompt, agentforgeVersion: VERSION },
      {},
    );

    // habits 正确：真实探测走完 PATH 扫描，命中桩目录中的 fnm / uv
    expect(result.cancelled).toBe(false);
    expect(result.synced).toBe(true);
    expect(result.detection.node.manager).toBe('fnm');
    expect(result.detection.python.manager).toBe('uv');

    // 投影含对应约定（模板变量渲染：use **fnm** / **uv**）
    const claude1 = await readFile(ws.claudeMd, 'utf8');
    expect(claude1).toContain('**fnm**');
    expect(claude1).toContain('**uv**');

    // 变量渲染证明（非内置写死）：改声明为 volta/conda → 再 sync → 输出跟随变化
    await patchYaml(ws.habitsFile, (data) => {
      const runtime = (data.runtime ?? {}) as Record<string, unknown>;
      runtime.node = { manager: 'volta' };
      runtime.python = { manager: 'conda' };
      data.runtime = runtime;
    });
    await runSync({ host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION }, {});
    const claude2 = await readFile(ws.claudeMd, 'utf8');
    expect(claude2).toContain('**volta**');
    expect(claude2).toContain('**conda**');
    expect(claude2).not.toContain('**fnm**');
    expect(claude2).not.toContain('**uv**');
  });
});

// ---------------------------------------------------------------------------
// §11.2.5 断网（AGF_OFFLINE=1）下 init → sync 走通
// ---------------------------------------------------------------------------

describe('§11.2.5 AGF_OFFLINE=1 断网走通', () => {
  let ws: Workspace;
  beforeEach(async () => {
    ws = await createWorkspace('offline', { AGF_OFFLINE: '1' });
  });
  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('离线环境（AGF_OFFLINE=1）init + sync 子进程端到端退出码 0，投影落地', async () => {
    const init = runCli(['init', '--scope', 'project'], ws.root, ws.home, { AGF_OFFLINE: '1' });
    expect(init.status).toBe(0);

    const sync = runCli(['sync'], ws.root, ws.home, { AGF_OFFLINE: '1' });
    expect(sync.status).toBe(0);
    expect(sync.stdout).toContain('CLAUDE.md');

    // 纯本地 base/default + habits 渲染完整落地
    const claude = await readFile(path.join(ws.root, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('# AgentForge Rules');
  });
});

// ---------------------------------------------------------------------------
// §11.2.8 两级 SoT 合并端到端（user + project 并存）
// ---------------------------------------------------------------------------

describe('§11.2.8 两级合并端到端', () => {
  let ws: Workspace;
  beforeEach(async () => {
    ws = await createWorkspace('merge');
  });
  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('custom 同名 project 覆盖 user；user 独有保留；habits overlay：project 未设字段由 user 补', async () => {
    // user 层：全局 style + 两份 custom（global 将被 project 同名覆盖，user-only 独有）
    await runInit({ host: ws.host, cwd: ws.root, os: OS }, { scope: 'user' });
    await writeFile(
      path.join(ws.userSoTRoot, 'custom', 'global.md'),
      'USER-GLOBAL 规则内容\n',
      'utf8',
    );
    await writeFile(
      path.join(ws.userSoTRoot, 'custom', 'user-only.md'),
      'USER-ONLY 规则内容\n',
      'utf8',
    );
    await patchYaml(path.join(ws.userSoTRoot, 'habits.yaml'), (data) => {
      const ai = (data.ai ?? {}) as Record<string, unknown>;
      ai.style = 'user-style（来自 user 层）';
      data.ai = ai;
    });

    // project 层：同名 global 覆盖（未声明 ai.style → 合并时由 user 层补缺）
    await runInit({ host: ws.host, cwd: ws.root, os: OS }, { scope: 'project' });
    await writeFile(
      path.join(ws.sotRoot, 'custom', 'global.md'),
      'PROJECT-GLOBAL 规则内容\n',
      'utf8',
    );

    // 两层并存 → effectiveScope=project（§4.2），素材取两层合并
    const syncResult = await runSync(
      { host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION },
      {},
    );
    expect(syncResult.scope).toBe('project');

    const claude = await readFile(ws.claudeMd, 'utf8');
    // custom 合并：同名 project 覆盖 user；user 独有保留
    expect(claude).toContain('PROJECT-GLOBAL 规则内容');
    expect(claude).toContain('USER-ONLY 规则内容');
    expect(claude).not.toContain('USER-GLOBAL 规则内容');
    // habits overlay 合并：project 层未声明 ai.style → user 层补缺并渲染
    expect(claude).toContain('user-style（来自 user 层）');
  });
});

// ---------------------------------------------------------------------------
// §11.2.11 多模板启用：§5.2 优先级顺序端到端
// ---------------------------------------------------------------------------

describe('§11.2.11 多模板优先级端到端', () => {
  let ws: Workspace;
  beforeEach(async () => {
    ws = await createWorkspace('templates');
  });
  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('custom → tpl-a → tpl-b → base/default 顺序正确，模板变量渲染生效', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS }, { scope: 'project' });

    // SoT 模板（templates/<id>.md）与 custom 素材
    await writeFile(
      path.join(ws.sotRoot, 'templates', 'tpl-a.md'),
      '# Section A (node={{runtime.node.manager}})\n',
      'utf8',
    );
    await writeFile(path.join(ws.sotRoot, 'templates', 'tpl-b.md'), '# Section B\n', 'utf8');
    await writeFile(path.join(ws.sotRoot, 'custom', 'my.md'), 'CUSTOM-CONTENT 素材\n', 'utf8');

    // 声明 node manager 供模板变量渲染
    await patchYaml(ws.habitsFile, (data) => {
      const runtime = (data.runtime ?? {}) as Record<string, unknown>;
      runtime.node = { manager: 'fnm' };
      data.runtime = runtime;
    });
    // profile.templates 启用两个 SoT 模板（列表序 = 渲染序）
    await patchYaml(ws.profileFile, (data) => {
      data.templates = ['tpl-a', 'tpl-b'];
    });

    await runSync({ host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION }, {});

    const claude = await readFile(ws.claudeMd, 'utf8');
    const customIdx = claude.indexOf('CUSTOM-CONTENT 素材');
    const aIdx = claude.indexOf('# Section A (node=fnm)');
    const bIdx = claude.indexOf('# Section B');
    const baseIdx = claude.indexOf('# AgentForge Rules');

    // §5.2：① custom → ③ templates（列表序）→ ④ base/default 恒最后
    expect(customIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(-1);
    expect(baseIdx).toBeGreaterThan(-1);
    expect(customIdx).toBeLessThan(aIdx);
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(baseIdx);
  });
});

// ---------------------------------------------------------------------------
// §11.2.13 import 闭环（导入 → 确认提升 → 投影，子进程端到端）
// ---------------------------------------------------------------------------

describe('§11.2.13 import 导入映射闭环', () => {
  let ws: Workspace;
  beforeEach(async () => {
    ws = await createWorkspace('import');
  });
  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('AGENTS.md 导入 → detected.import 映射 → 提升声明 → sync 投影（全程子进程）', async () => {
    await writeFile(
      ws.agentsMd,
      [
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
      ].join('\n'),
      'utf8',
    );

    const init = runCli(['init', '--scope', 'project'], ws.root, ws.home);
    expect(init.status).toBe(0);

    // 导入：工具链声明映射为 detected.import 建议（§7.7-4）
    const imported = runCli(['import', 'AGENTS.md'], ws.root, ws.home);
    expect(imported.status).toBe(0);
    expect(imported.stdout).toContain('fnm');
    expect(imported.stdout).toContain('uv');
    expect(imported.stdout).toContain('pnpm');

    // 建议字段已写入 habits.detected.import（用户核对后确认的依据）
    const habits = parseYaml(await readFile(ws.habitsFile, 'utf8')) as Record<string, unknown>;
    const detectedImport = (habits.detected as Record<string, unknown>).import as Record<
      string,
      unknown
    >;
    expect(detectedImport.node).toEqual({ manager: 'fnm', source: 'import' });
    expect(detectedImport.python).toEqual({ manager: 'uv', source: 'import' });

    // 用户确认：把建议提升为声明字段（模拟人工核对后的动作）
    await patchYaml(ws.habitsFile, (data) => {
      const runtime = (data.runtime ?? {}) as Record<string, unknown>;
      runtime.node = { manager: 'fnm' };
      runtime.python = { manager: 'uv' };
      runtime.package_managers = ['pnpm'];
      data.runtime = runtime;
    });

    const sync = runCli(['sync'], ws.root, ws.home);
    expect(sync.status).toBe(0);

    const claude = await readFile(ws.claudeMd, 'utf8');
    expect(claude).toContain('**fnm**');
    expect(claude).toContain('**uv**');
    expect(claude).toContain('**pnpm**');
    // 导入的风格素材写入 custom/imported-*.md（§7.7-4 剩余块），同样被投影
    const customEntries = await ws.host.listDir(path.join(ws.sotRoot, 'custom'));
    const importedFiles = customEntries.filter((name) => /^imported-\d{8}-\d{6}\.md$/.test(name));
    expect(importedFiles).toHaveLength(1);
    const importedContent = await readFile(
      path.join(ws.sotRoot, 'custom', importedFiles[0] as string),
      'utf8',
    );
    expect(importedContent).toContain('## 代码风格');
    expect(claude).toContain('简洁，外科手术式修改。');
  });
});
