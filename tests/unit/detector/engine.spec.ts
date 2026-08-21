/**
 * engine 单测：mock host 注入 PATH 与版本文件，断言 DetectedSnapshot 各字段；
 * 含探测矩阵（node manager × python 工具链 × shell，32 组合）与 schema 枚举兼容校验。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EnvSnapshot } from '../../../src/core/env';
import {
  NODE_MANAGER_PRIORITY,
  PACKAGE_MANAGER_PRIORITY,
  PYTHON_MANAGER_PRIORITY,
  runDetection,
  type DetectedSnapshot,
} from '../../../src/core/detector/engine';
import { NodeManager, PackageManager, PythonManager } from '../../../src/schema/habits';
import { makeDetectHost } from './helpers';

const CWD = 'C:/proj';

/** win32 下 engine 内部用 path.win32.join 拼版本文件路径，fixture key 保持同款。 */
function projFile(name: string): string {
  return path.win32.join(CWD, name);
}

const ENV_SNAPSHOT: EnvSnapshot = {
  agfHome: undefined,
  agfScope: undefined,
  offline: false,
  lineEnding: undefined,
  ci: false,
  codexHome: undefined,
  userProfile: 'C:/Users/tester',
};

async function detectWin32(
  fixture: Parameters<typeof makeDetectHost>[0],
): Promise<DetectedSnapshot> {
  const host = makeDetectHost(fixture);
  return runDetection({ host, os: 'win32', cwd: CWD, env: ENV_SNAPSHOT });
}

describe('runDetection：探测矩阵（fnm/nvm/volta/system × uv/poetry/pipenv/system × powershell/cmd）', () => {
  const NODE_CASES = ['fnm', 'nvm', 'volta', 'system'] as const;
  const PYTHON_CASES = ['uv', 'poetry', 'pipenv', 'system'] as const;
  const SHELL_CASES = ['powershell', 'cmd'] as const;

  const matrix = NODE_CASES.flatMap((node) =>
    PYTHON_CASES.flatMap((python) => SHELL_CASES.map((shell) => ({ node, python, shell }))),
  );

  it.each(matrix)('$node × $python × $shell', async ({ node, python, shell }) => {
    const binFiles =
      node === 'system' ? ['node.exe'] : [`${node}.exe`];
    binFiles.push(python === 'system' ? 'python.exe' : `${python}.exe`);

    const env: Record<string, string> = { PATH: 'C:/bin' };
    if (shell === 'powershell') {
      env.PSModulePath = 'C:\\Users\\x\\Documents\\PowerShell\\Modules';
    } else {
      env.ComSpec = 'C:\\Windows\\system32\\cmd.exe';
    }

    const snapshot = await detectWin32({ dirs: { 'C:/bin': binFiles }, files: {}, env });

    expect(snapshot.node.manager).toBe(node);
    expect(snapshot.node.source).toBe('path');
    expect(snapshot.node.path).toBe(path.win32.resolve('C:/bin', binFiles[0] ?? ''));
    expect(snapshot.python.manager).toBe(python);
    expect(snapshot.python.source).toBe('path');
    expect(snapshot.shell).toBe(shell);
  });
});

describe('runDetection：Node 探测', () => {
  it('PATH 命中优先级 fnm > nvm > volta > mise > asdf > n', async () => {
    const cases: Array<[string[], string]> = [
      [['fnm.exe', 'nvm.exe'], 'fnm'],
      [['nvm.exe', 'volta.exe'], 'nvm'],
      [['volta.exe', 'mise.exe'], 'volta'],
      [['mise.exe', 'asdf.exe'], 'mise'],
      [['asdf.exe', 'n.exe'], 'asdf'],
      [['n.exe'], 'n'],
    ];
    for (const [binFiles, expected] of cases) {
      const snapshot = await detectWin32({ dirs: { 'C:/bin': binFiles }, files: {}, env: { PATH: 'C:/bin' } });
      expect(snapshot.node.manager, `binFiles=${binFiles.join(',')}`).toBe(expected);
    }
  });

  it('manager 命中时 .node-version 交叉出 version', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/bin': ['fnm.exe'] },
      files: { [projFile('.node-version')]: '22.11.0\n' },
      env: { PATH: 'C:/bin' },
    });
    expect(snapshot.node).toEqual({
      manager: 'fnm',
      source: 'path',
      version: '22.11.0',
      path: path.win32.resolve('C:/bin', 'fnm.exe'),
    });
  });

  it('无 manager、node 本体在 PATH、有 .node-version → system + version-file', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/bin': ['node.exe'] },
      files: { [projFile('.node-version')]: 'v22.11.0\n' },
      env: { PATH: 'C:/bin' },
    });
    expect(snapshot.node).toEqual({
      manager: 'system',
      source: 'version-file',
      version: '22.11.0',
      path: path.win32.resolve('C:/bin', 'node.exe'),
    });
  });

  it('.node-version 存在但 PATH 无 node 无 manager → manager none', async () => {
    const snapshot = await detectWin32({
      dirs: {},
      files: { [projFile('.node-version')]: '22.11.0' },
      env: {},
    });
    expect(snapshot.node).toEqual({ manager: 'none', source: 'version-file', version: '22.11.0' });
  });

  it('无 manager、无版本文件、node 本体在 PATH → system + path', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/bin': ['node.exe'] },
      files: {},
      env: { PATH: 'C:/bin' },
    });
    expect(snapshot.node).toEqual({
      manager: 'system',
      source: 'path',
      path: path.win32.resolve('C:/bin', 'node.exe'),
    });
  });

  it('坏 .node-version 内容 → 无 version，不影响 manager 判定', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/bin': ['fnm.exe'] },
      files: { [projFile('.node-version')]: '# comment only\n' },
      env: { PATH: 'C:/bin' },
    });
    expect(snapshot.node.manager).toBe('fnm');
    expect(snapshot.node.version).toBeUndefined();
  });
});

describe('runDetection：Python 探测', () => {
  it('PATH 命中优先级 uv > poetry > pipenv > conda > pyenv > mise', async () => {
    const cases: Array<[string[], string]> = [
      [['uv.exe', 'poetry.exe'], 'uv'],
      [['poetry.exe', 'pipenv.exe'], 'poetry'],
      [['pipenv.exe', 'conda.exe'], 'pipenv'],
      [['conda.exe', 'pyenv.exe'], 'conda'],
      [['pyenv.exe'], 'pyenv'],
      [['mise.exe'], 'mise'],
    ];
    for (const [binFiles, expected] of cases) {
      const snapshot = await detectWin32({ dirs: { 'C:/bin': binFiles }, files: {}, env: { PATH: 'C:/bin' } });
      expect(snapshot.python.manager, `binFiles=${binFiles.join(',')}`).toBe(expected);
    }
  });

  it('pyproject [tool.poetry] 线索 → poetry + source pyproject（PATH 无 manager 时）', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/bin': ['python.exe'] },
      files: { [projFile('pyproject.toml')]: '[tool.poetry]\nname = "x"\n' },
      env: { PATH: 'C:/bin' },
    });
    expect(snapshot.python).toEqual({ manager: 'poetry', source: 'pyproject' });
  });

  it('PATH 的 uv 命中优先于 pyproject poetry 线索', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/bin': ['uv.exe'] },
      files: { [projFile('pyproject.toml')]: '[tool.poetry]\n' },
      env: { PATH: 'C:/bin' },
    });
    expect(snapshot.python).toEqual({
      manager: 'uv',
      source: 'path',
      path: path.win32.resolve('C:/bin', 'uv.exe'),
    });
  });

  it('pyproject 线索 + .python-version 交叉出 version', async () => {
    const snapshot = await detectWin32({
      dirs: {},
      files: {
        [projFile('pyproject.toml')]: '[tool.uv]\n',
        [projFile('.python-version')]: '3.12\n',
      },
      env: {},
    });
    expect(snapshot.python).toEqual({ manager: 'uv', source: 'pyproject', version: '3.12' });
  });

  it('.python-version + python 本体 → system + version-file', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/bin': ['python.exe'] },
      files: { [projFile('.python-version')]: '3.12' },
      env: { PATH: 'C:/bin' },
    });
    expect(snapshot.python).toEqual({
      manager: 'system',
      source: 'version-file',
      version: '3.12',
      path: path.win32.resolve('C:/bin', 'python.exe'),
    });
  });

  it('无任何 python 线索 → none', async () => {
    const snapshot = await detectWin32({ dirs: {}, files: {}, env: {} });
    expect(snapshot.python).toEqual({ manager: 'none', source: 'none' });
  });
});

describe('runDetection：包管理器探测', () => {
  it('PATH 命中按 pnpm > bun > npm > yarn 排序', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/bin': ['yarn.cmd', 'npm.cmd', 'bun.exe', 'pnpm.exe'] },
      files: {},
      env: { PATH: 'C:/bin' },
    });
    expect(snapshot.package_managers.map((p) => [p.name, p.source])).toEqual([
      ['pnpm', 'path'],
      ['bun', 'path'],
      ['npm', 'path'],
      ['yarn', 'path'],
    ]);
  });

  it('package.json#packageManager 声明优先置首', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/bin': ['npm.cmd', 'pnpm.exe'] },
      files: { [projFile('package.json')]: '{"packageManager": "pnpm@9.1.0"}' },
      env: { PATH: 'C:/bin' },
    });
    expect(snapshot.package_managers.map((p) => [p.name, p.source, p.path])).toEqual([
      ['pnpm', 'package.json', path.win32.resolve('C:/bin', 'pnpm.exe')],
      ['npm', 'path', path.win32.resolve('C:/bin', 'npm.cmd')],
    ]);
  });

  it('package.json 声明的管理器不在 PATH 也置首（path 省略）', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/bin': ['npm.cmd'] },
      files: { [projFile('package.json')]: '{"packageManager": "pnpm@9.1.0"}' },
      env: { PATH: 'C:/bin' },
    });
    expect(snapshot.package_managers).toEqual([
      { name: 'pnpm', source: 'package.json' },
      { name: 'npm', source: 'path', path: path.win32.resolve('C:/bin', 'npm.cmd') },
    ]);
  });

  it('yarn@>=2 → yarn-berry（复用 yarn 的 PATH 命中）', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/bin': ['yarn.cmd'] },
      files: { [projFile('package.json')]: '{"packageManager": "yarn@4.1.1"}' },
      env: { PATH: 'C:/bin' },
    });
    expect(snapshot.package_managers).toEqual([
      { name: 'yarn-berry', source: 'package.json', path: path.win32.resolve('C:/bin', 'yarn.cmd') },
    ]);
  });

  it('yarn@1.x → yarn', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/bin': ['yarn.cmd'] },
      files: { [projFile('package.json')]: '{"packageManager": "yarn@1.22.0"}' },
      env: { PATH: 'C:/bin' },
    });
    expect(snapshot.package_managers.map((p) => p.name)).toEqual(['yarn']);
  });

  it('非枚举 manager（如 deno）忽略，不影响 PATH 命中', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/bin': ['npm.cmd'] },
      files: { [projFile('package.json')]: '{"packageManager": "deno@2.0.0"}' },
      env: { PATH: 'C:/bin' },
    });
    expect(snapshot.package_managers.map((p) => p.name)).toEqual(['npm']);
  });

  it('PATH 无包管理器且 package.json 无声明 → 空数组', async () => {
    const snapshot = await detectWin32({ dirs: {}, files: {}, env: {} });
    expect(snapshot.package_managers).toEqual([]);
  });
});

describe('runDetection：rust / go / 规则文件', () => {
  it('rustup 在 PATH → rustup；仅 cargo → system；都无 → none', async () => {
    const rustup = await detectWin32({
      dirs: { 'C:/bin': ['rustup.exe', 'cargo.exe'] },
      files: {},
      env: { PATH: 'C:/bin' },
    });
    expect(rustup.rust).toEqual({
      manager: 'rustup',
      source: 'path',
      path: path.win32.resolve('C:/bin', 'rustup.exe'),
    });

    const cargoOnly = await detectWin32({
      dirs: { 'C:/bin': ['cargo.exe'] },
      files: {},
      env: { PATH: 'C:/bin' },
    });
    expect(cargoOnly.rust).toEqual({
      manager: 'system',
      source: 'path',
      path: path.win32.resolve('C:/bin', 'cargo.exe'),
    });

    const none = await detectWin32({ dirs: {}, files: {}, env: {} });
    expect(none.rust).toEqual({ manager: 'none', source: 'none' });
  });

  it('go 在 PATH → system；无 → none', async () => {
    const withGo = await detectWin32({
      dirs: { 'C:/bin': ['go.exe'] },
      files: {},
      env: { PATH: 'C:/bin' },
    });
    expect(withGo.go).toEqual({
      manager: 'system',
      source: 'path',
      path: path.win32.resolve('C:/bin', 'go.exe'),
    });

    const noGo = await detectWin32({ dirs: {}, files: {}, env: {} });
    expect(noGo.go).toEqual({ manager: 'none', source: 'none' });
  });

  it('existing_rules：AGENTS.md / CLAUDE.md 存在性（固定顺序）', async () => {
    const both = await detectWin32({
      dirs: {},
      files: { [projFile('AGENTS.md')]: '# rules', [projFile('CLAUDE.md')]: '# rules' },
      env: {},
    });
    expect(both.existing_rules).toEqual(['AGENTS.md', 'CLAUDE.md']);

    const claudeOnly = await detectWin32({
      dirs: {},
      files: { [projFile('CLAUDE.md')]: '# rules' },
      env: {},
    });
    expect(claudeOnly.existing_rules).toEqual(['CLAUDE.md']);

    const none = await detectWin32({ dirs: {}, files: {}, env: {} });
    expect(none.existing_rules).toEqual([]);
  });
});

describe('runDetection：posix 与坏环境', () => {
  it('posix：无扩展名命中 + SHELL=zsh + 版本文件', async () => {
    const host = makeDetectHost({
      dirs: { '/usr/local/bin': ['fnm', 'uv', 'node'] },
      files: { '/proj/.node-version': '22.11.0\n' },
      env: { PATH: '/usr/local/bin', SHELL: '/bin/zsh' },
    });
    const snapshot = await runDetection({ host, os: 'linux', cwd: '/proj', env: ENV_SNAPSHOT });

    expect(snapshot.node).toEqual({
      manager: 'fnm',
      source: 'path',
      version: '22.11.0',
      path: '/usr/local/bin/fnm',
    });
    expect(snapshot.python).toEqual({
      manager: 'uv',
      source: 'path',
      path: '/usr/local/bin/uv',
    });
    expect(snapshot.shell).toBe('zsh');
  });

  it('空环境（无 PATH）→ 全部未检出且不抛错', async () => {
    const snapshot = await detectWin32({ dirs: {}, files: {}, env: {} });
    expect(snapshot.node).toEqual({ manager: 'none', source: 'none' });
    expect(snapshot.python).toEqual({ manager: 'none', source: 'none' });
    expect(snapshot.package_managers).toEqual([]);
    expect(snapshot.rust).toEqual({ manager: 'none', source: 'none' });
    expect(snapshot.go).toEqual({ manager: 'none', source: 'none' });
    expect(snapshot.shell).toBe('other');
    expect(snapshot.existing_rules).toEqual([]);
  });

  it('PATH 含不可读目录与存在目录混合 → 正常命中', async () => {
    const snapshot = await detectWin32({
      dirs: { 'C:/ok': ['fnm.exe'] },
      files: {},
      env: { PATH: 'C:/nope;C:/ok' },
    });
    expect(snapshot.node.manager).toBe('fnm');
  });
});

describe('探测枚举与 habits schema 对齐（防漂移）', () => {
  it('node/python/package manager 候选都在 schema 枚举内', () => {
    for (const m of NODE_MANAGER_PRIORITY) {
      expect(NodeManager.options, `node manager ${m}`).toContain(m);
    }
    for (const m of PYTHON_MANAGER_PRIORITY) {
      expect(PythonManager.options, `python manager ${m}`).toContain(m);
    }
    for (const m of PACKAGE_MANAGER_PRIORITY) {
      expect(PackageManager.options, `package manager ${m}`).toContain(m);
    }
    // engine 推断用的附加枚举值
    expect(NodeManager.options).toContain('system');
    expect(NodeManager.options).toContain('none');
    expect(PythonManager.options).toContain('system');
    expect(PythonManager.options).toContain('none');
    expect(PackageManager.options).toContain('yarn-berry');
  });
});
