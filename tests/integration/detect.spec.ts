/**
 * detect 集成测试：真实临时目录放假可执行文件（空文件即可，path-scan 只 listDir）
 * + PATH 注入 → node 子进程跑 aforge detect --json，断言输出（Spec §7.2 端到端）。
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainTs = path.join(repoRoot, 'src', 'main.ts');

/**
 * tsx loader 的绝对 file URL：子进程 cwd 在临时目录，无法按相对说明符解析 tsx，
 * 需与 cwd 无关的绝对入口（smoke.spec.ts 的 cwd 恒为 repoRoot 故可用 '--import tsx'）。
 */
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const isWin32 = process.platform === 'win32';
const exeExt = isWin32 ? '.exe' : '';

let workspace: string;
let binDir: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'aforge-detect-'));
  binDir = path.join(workspace, 'bin');
  await mkdir(binDir, { recursive: true });
  // 假可执行文件：零进程探测只 listDir，不执行，空文件即可
  await writeFile(path.join(binDir, `fnm${exeExt}`), '');
  await writeFile(path.join(binDir, `uv${exeExt}`), '');
  // 版本文件（cwd = workspace）
  await writeFile(path.join(workspace, '.node-version'), '22.11.0\n');
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** 构造注入 PATH 的子进程 env：先清掉所有大小写变体的 PATH 键，再统一写入新值。 */
function envWithInjectedPath(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') {
      delete env[key];
    }
  }
  env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  return env;
}

interface DetectJsonOutput {
  readonly node: { readonly manager: string; readonly version?: string; readonly path?: string };
  readonly python: { readonly manager: string; readonly path?: string };
  readonly shell: string;
  readonly existing_rules: readonly string[];
}

describe('aforge detect --json（真实子进程 + 真实临时目录）', () => {
  it('探测注入的 fnm/uv 与 .node-version，输出合法 JSON 与绝对路径', () => {
    const result = spawnSync(process.execPath, ['--import', tsxImport, mainTs, 'detect', '--json'], {
      cwd: workspace,
      env: envWithInjectedPath(),
      encoding: 'utf8',
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);

    const snapshot = JSON.parse(result.stdout) as DetectJsonOutput;

    // fnm 在注入的 binDir（PATH 最前）且优先级最高
    expect(snapshot.node.manager).toBe('fnm');
    expect(snapshot.node.version).toBe('22.11.0');
    expect(snapshot.node.path?.toLowerCase()).toContain(path.basename(binDir).toLowerCase());

    // uv 在注入的 binDir
    expect(snapshot.python.manager).toBe('uv');
    expect(snapshot.python.path?.toLowerCase()).toContain(path.basename(binDir).toLowerCase());

    // shell 为合法枚举值
    expect(['powershell', 'pwsh', 'cmd', 'zsh', 'bash', 'fish', 'nushell', 'other']).toContain(
      snapshot.shell,
    );

    // 临时 workspace 下无规则文件
    expect(snapshot.existing_rules).toEqual([]);
  }, 60_000);
});

describe('aforge detect（人类可读输出）', () => {
  it('默认输出分节文本且退出码 0', () => {
    const result = spawnSync(process.execPath, ['--import', tsxImport, mainTs, 'detect'], {
      cwd: workspace,
      env: envWithInjectedPath(),
      encoding: 'utf8',
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('aforge detect - toolchain probe');
    expect(result.stdout).toContain('Node.js');
    expect(result.stdout).toContain('manager');
    expect(result.stdout).toContain('fnm');
    expect(result.stdout).toContain('Package managers');
  }, 60_000);
});
