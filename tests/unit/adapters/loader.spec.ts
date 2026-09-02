/**
 * 适配器的发现、层授权与加载报告（issue #53 安全边界 1 / 4 / 7）。
 *
 * 三条边界在这里落地：
 * - 边界 1：只从 **user 层** SoT 的 `adapters/*.yaml` 发现；project 层默认忽略，
 *   需 `AGF_ALLOW_PROJECT_ADAPTERS=1`。这是「clone 一个仓库不该自动获得往用户
 *   主目录写文件的能力」的分界线；
 * - 边界 4：单层适配器文件数上限 + 单文件字节上限；
 * - 边界 7：id 撞内置 → 退出码 1 归属的 `builtin-id` 失败。
 *
 * 还有一条贯穿性契约：**loadDeclarativeAdapters 永不抛异常**。它跑在 CLI 装配阶段，
 * 在那里抛异常会让每条命令（包括最需要它的 `aforge doctor`）都起不来。
 */
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AdapterFailureKind,
  type AdapterLoadReport,
  adapterFailureExitCode,
  adapterLoadReport,
} from '../../../src/core/adapters/diagnostics';
import { assertNoAdapterAssemblyConflicts } from '../../../src/core/adapters/gate';
import {
  ADAPTER_MAX_FILE_BYTES,
  ADAPTER_MAX_FILES_PER_LAYER,
} from '../../../src/core/adapters/limits';
import {
  loadDeclarativeAdapters,
  resetDeclarativeAdapterState,
} from '../../../src/core/adapters/loader';
import { readEnv } from '../../../src/core/env';
import { GenericError } from '../../../src/core/errors';
import { currentOs } from '../../../src/core/paths';
import { declarativeTargetIds, knownTargetIds } from '../../../src/core/project/target-ids';
import type { Projector } from '../../../src/core/project/types';
import { Registry } from '../../../src/core/registry';
import { abs, createFakeHost, type FakeHost } from '../test-utils';

const CWD = abs('proj');
const HOME = abs('Users', 'u');
const USER_ADAPTERS = path.join(HOME, '.agentforge', 'adapters');
const PROJECT_ADAPTERS = path.join(CWD, '.agentforge', 'adapters');

/** 一份最小可用的适配器 yaml。 */
function adapterYaml(id: string, extra = ''): string {
  return [
    'version: 1',
    `id: ${id}`,
    'scopes:',
    '  user:',
    '    base: "{userHome}/.my"',
    '    skills_dir: "{base}/skills"',
    '    main_rule: "{base}/AGENTS.md"',
    extra,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * 适配器加载用 fake host。
 *
 * `listDir` 必须覆盖：test-utils 的实现用 `'/'` 拼前缀，在 win32 路径上恒返回空，
 * 于是「发现」这件事在夹具层就静默失效了（用例会全绿但什么都没测到）。
 */
function createAdapterHost(
  files: Readonly<Record<string, string>>,
  envMap: Readonly<Record<string, string>> = {},
): FakeHost {
  const host = createFakeHost({ USERPROFILE: HOME, HOME, ...envMap });
  for (const [file, content] of Object.entries(files)) {
    host.files.set(file, content);
  }
  return {
    ...host,
    async listDir(dir: string): Promise<string[]> {
      const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
      return [...host.files.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .filter((name) => !name.includes(path.sep))
        .sort();
    },
  };
}

async function load(
  host: FakeHost,
  registry = new Registry<Projector>(),
): Promise<AdapterLoadReport> {
  return loadDeclarativeAdapters({
    host,
    env: readEnv(host, currentOs()),
    os: currentOs(),
    cwd: CWD,
    registry,
  });
}

/** 取唯一失败项（断言分类时用；多于一条即用例前提有误）。 */
function onlyFailure(report: AdapterLoadReport): { kind: AdapterFailureKind; message: string } {
  expect(report.failures).toHaveLength(1);
  const failure = report.failures[0];
  return { kind: failure?.kind as AdapterFailureKind, message: failure?.message ?? '' };
}

beforeEach(() => {
  resetDeclarativeAdapterState();
});

describe('loadDeclarativeAdapters — 边界 1：只从 user 层发现', () => {
  it('user 层适配器：加载 + 注册进注册表 + 进 profile 取值域', async () => {
    const host = createAdapterHost({
      [path.join(USER_ADAPTERS, 'my-agent.yaml')]: adapterYaml('my-agent'),
    });
    const registry = new Registry<Projector>();
    const report = await load(host, registry);

    expect(report.failures).toEqual([]);
    expect(report.loaded).toEqual([
      { id: 'my-agent', file: path.join(USER_ADAPTERS, 'my-agent.yaml'), layer: 'user' },
    ]);
    expect(registry.get('my-agent')?.id).toBe('my-agent');
    expect(declarativeTargetIds()).toEqual(['my-agent']);
    expect(knownTargetIds()).toContain('my-agent');
    // 报告写进进程级单例（doctor / status / schema 提示读同一份）
    expect(adapterLoadReport()).toBe(report);
  });

  it('project 层适配器默认**忽略**：不加载、不注册，但进 ignored 名单（不静默消失）', async () => {
    const host = createAdapterHost({
      [path.join(PROJECT_ADAPTERS, 'evil.yaml')]: adapterYaml('evil'),
    });
    const registry = new Registry<Projector>();
    const report = await load(host, registry);

    expect(report.loaded).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.ignored).toEqual([
      {
        id: 'evil',
        file: path.join(PROJECT_ADAPTERS, 'evil.yaml'),
        layer: 'project',
        reason: 'project-layer-not-authorized',
      },
    ]);
    expect(registry.has('evil')).toBe(false);
    expect(knownTargetIds()).not.toContain('evil');
    // 两层目录都列进 scanned：用户要能确认「我放对位置了吗」
    expect(report.scanned).toEqual([USER_ADAPTERS, PROJECT_ADAPTERS]);
  });

  it('AGF_ALLOW_PROJECT_ADAPTERS=1 → project 层才加载（显式授权）', async () => {
    const host = createAdapterHost(
      { [path.join(PROJECT_ADAPTERS, 'team-agent.yaml')]: adapterYaml('team-agent') },
      { AGF_ALLOW_PROJECT_ADAPTERS: '1' },
    );
    const report = await load(host);
    expect(report.ignored).toEqual([]);
    expect(report.loaded.map((e) => `${e.id}@${e.layer}`)).toEqual(['team-agent@project']);
  });

  it('AGF_ALLOW_PROJECT_ADAPTERS 取非 1 的值不算授权（只认精确的 "1"）', async () => {
    for (const value of ['0', 'true', 'yes', '']) {
      resetDeclarativeAdapterState();
      const host = createAdapterHost(
        { [path.join(PROJECT_ADAPTERS, 'x.yaml')]: adapterYaml('x') },
        { AGF_ALLOW_PROJECT_ADAPTERS: value },
      );
      const report = await load(host);
      expect(report.ignored, value).toHaveLength(1);
    }
  });

  it('两层同 id（已授权）→ user 层胜出，project 层记 duplicate-id 而不是覆盖', async () => {
    const host = createAdapterHost(
      {
        [path.join(USER_ADAPTERS, 'dup.yaml')]: adapterYaml('dup'),
        [path.join(PROJECT_ADAPTERS, 'dup.yaml')]: adapterYaml('dup'),
      },
      { AGF_ALLOW_PROJECT_ADAPTERS: '1' },
    );
    const report = await load(host);
    expect(report.loaded.map((e) => e.layer)).toEqual(['user']);
    expect(onlyFailure(report).kind).toBe('duplicate-id');
  });

  it('adapters/ 目录不存在 → 空报告，不是错误（绝大多数用户没有第三方 target）', async () => {
    const report = await load(createAdapterHost({}));
    expect(report).toMatchObject({ loaded: [], ignored: [], failures: [] });
  });

  it('非 yaml 文件（README 之类）静默跳过', async () => {
    const host = createAdapterHost({
      [path.join(USER_ADAPTERS, 'README.md')]: '# notes',
      [path.join(USER_ADAPTERS, 'my-agent.yml')]: adapterYaml('my-agent'),
    });
    const report = await load(host);
    expect(report.failures).toEqual([]);
    expect(report.loaded.map((e) => e.id)).toEqual(['my-agent']);
  });
});

describe('loadDeclarativeAdapters — 失败分类与退出码归属', () => {
  async function failOn(fileName: string, content: string): Promise<AdapterLoadReport> {
    return load(createAdapterHost({ [path.join(USER_ADAPTERS, fileName)]: content }));
  }

  it('YAML 语法错 → kind=yaml（退出码 2），且带行列定位', async () => {
    const report = await failOn('broken.yaml', 'version: 1\nid: broken\n  bad: [\n');
    const failure = onlyFailure(report);
    expect(failure.kind).toBe('yaml');
    expect(adapterFailureExitCode(failure.kind)).toBe(2);
  });

  it('schema 校验失败（action: merge_toml）→ kind=schema', async () => {
    const report = await failOn(
      'toml-agent.yaml',
      `${adapterYaml('toml-agent')}\nmain_rule:\n  action: merge_toml\n`,
    );
    expect(onlyFailure(report).kind).toBe('schema');
  });

  it('文件名与 id 不一致 → kind=id-mismatch（来源必须能由文件名唯一定位）', async () => {
    const report = await failOn('a.yaml', adapterYaml('b'));
    expect(onlyFailure(report).kind).toBe('id-mismatch');
  });

  it('边界 7：id 撞内置 → kind=builtin-id，退出码归 1（装配冲突，复用 Registry 语义）', async () => {
    const report = await failOn('claude.yaml', adapterYaml('claude'));
    const failure = onlyFailure(report);
    expect(failure.kind).toBe('builtin-id');
    expect(adapterFailureExitCode(failure.kind)).toBe(1);
  });

  it('路径模板非法（自由绝对路径）→ kind=template', async () => {
    const report = await failOn(
      'free.yaml',
      [
        'version: 1',
        'id: free',
        'scopes:',
        '  user:',
        '    base: "C:/Windows"',
        '    skills_dir: "{base}/skills"',
      ].join('\n'),
    );
    expect(onlyFailure(report).kind).toBe('template');
  });

  it('边界 4：单文件超字节上限 → kind=limit（不进 YAML 解析）', async () => {
    const report = await failOn('fat.yaml', 'x'.repeat(ADAPTER_MAX_FILE_BYTES + 1));
    expect(onlyFailure(report).kind).toBe('limit');
  });

  it('边界 4：单层文件数超上限 → 超出的记 limit，上限内的照常加载', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < ADAPTER_MAX_FILES_PER_LAYER + 3; i += 1) {
      const id = `a${String(i).padStart(2, '0')}`;
      files[path.join(USER_ADAPTERS, `${id}.yaml`)] = adapterYaml(id);
    }
    const report = await load(createAdapterHost(files));
    expect(report.loaded).toHaveLength(ADAPTER_MAX_FILES_PER_LAYER);
    expect(report.failures).toHaveLength(3);
    expect(report.failures.every((f) => f.kind === 'limit')).toBe(true);
  });

  it('读文件失败 → kind=io（权限 / 被独占打开）', async () => {
    const base = createAdapterHost({
      [path.join(USER_ADAPTERS, 'my-agent.yaml')]: adapterYaml('my-agent'),
    });
    const host: FakeHost = {
      ...base,
      async readFile(): Promise<string> {
        throw new Error('EACCES: permission denied');
      },
    };
    const report = await load(host);
    expect(onlyFailure(report).kind).toBe('io');
  });

  it('每条失败都带 file / layer / hint（doctor 要能直接照着修）', async () => {
    const report = await failOn('a.yaml', adapterYaml('b'));
    expect(report.failures[0]).toMatchObject({
      file: path.join(USER_ADAPTERS, 'a.yaml'),
      layer: 'user',
    });
    expect(report.failures[0]?.hint).not.toBe('');
  });
});

describe('loadDeclarativeAdapters — 永不抛异常', () => {
  it('内部意外错误折叠成一条 io 失败（CLI 装配阶段抛异常会让所有命令都起不来）', async () => {
    const base = createAdapterHost({});
    const host: FakeHost = {
      ...base,
      env(): string | undefined {
        // 模拟装配期的意外错误（真实场景可能是 os / 路径解析层的边界）
        throw new Error('boom');
      },
    };
    // readEnv 也会踩到同一个抛错的 env()，所以这里直接构造 env 快照
    const report = await loadDeclarativeAdapters({
      host,
      env: { offline: false, ci: false, userProfile: HOME },
      os: currentOs(),
      cwd: CWD,
      registry: new Registry<Projector>(),
    });
    expect(onlyFailure(report).kind).toBe('io');
    expect(report.failures[0]?.message).toContain('boom');
  });

  it('listDir 抛错 → 视为该层无适配器（探测失败不阻塞 CLI）', async () => {
    const base = createAdapterHost({});
    const host: FakeHost = {
      ...base,
      async listDir(): Promise<string[]> {
        throw new Error('EPERM');
      },
    };
    const report = await load(host);
    expect(report).toMatchObject({ loaded: [], failures: [] });
  });
});

describe('gate.assertNoAdapterAssemblyConflicts — sync 侧 fail-fast', () => {
  it('无 id 冲突 → 不抛（内容类失败不在这里拦，由 TargetEnum 更精确地报）', async () => {
    await load(createAdapterHost({ [path.join(USER_ADAPTERS, 'broken.yaml')]: 'id: [oops\n' }));
    expect(adapterLoadReport().failures[0]?.kind).toBe('yaml');
    expect(() => assertNoAdapterAssemblyConflicts()).not.toThrow();
  });

  it('id 撞内置 → GenericError(1)（sync 不能带着装配冲突往下写盘）', async () => {
    await load(
      createAdapterHost({ [path.join(USER_ADAPTERS, 'claude.yaml')]: adapterYaml('claude') }),
    );
    let caught: unknown;
    try {
      assertNoAdapterAssemblyConflicts();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GenericError);
    expect((caught as GenericError).message).toContain('claude');
  });
});
