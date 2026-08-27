/**
 * sync 引擎单测（Spec §7.3，fake host + 宿主平台路径）：
 * 初始化检查 / 渲染装配（custom 两层合并）/ plan+apply / 幂等 / dry-run /
 * --targets 过滤 / sync-meta 写入 / 换行与 scope 行为。
 *
 * 注：engine 的文件 IO（path.join/dirname → Host）使用宿主平台 api，
 * 故本文件路径一律经 node:path 动态构造（Windows / POSIX CI 均可跑）；
 * 跨平台路径计算本身由 paths.spec 覆盖，projector 的 os 分派由 claude.spec 覆盖。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type EnvSnapshot, readEnv } from '../../../src/core/env';
import { ConfigError } from '../../../src/core/errors';
import {
  DEFAULT_MARKER_BEGIN,
  DEFAULT_MARKER_END,
  renderedSectionHash,
  splitByMarkers,
} from '../../../src/core/markers';
import { currentOs } from '../../../src/core/paths';
import { buildGitignoreItem, filterTargets, syncOnce } from '../../../src/core/project/engine';
import { syncMetaPath } from '../../../src/core/project/sync-meta';
import { createFakeHost, type FakeHost } from '../test-utils';

const OS = currentOs();
const HOME = path.resolve('/home/u');
const CWD = path.resolve('/proj');
const USER_SOT = path.join(HOME, '.agentforge');
const PROJECT_SOT = path.join(CWD, '.agentforge');
const CLAUDE_MD = path.join(CWD, 'CLAUDE.md');
const USER_CLAUDE_MD = path.join(HOME, '.claude', 'CLAUDE.md');

/** 最小可同步 profile（M5 仅 claude 生效）。 */
const PROFILE_YAML = ['version: 1', 'scope: project', 'targets: [claude]', ''].join('\n');
const HABITS_YAML = ['version: 1', ''].join('\n');

/** 空声明 habits + base/default 的渲染结果（composer 规范化后）。 */
const RENDERED_MINIMAL = '# AgentForge Rules\n';

function createSyncHost(env: Record<string, string> = {}): FakeHost {
  // 目录感知 listDir：engine 的 readCustomLayer 用宿主 path.join 拼路径后调
  // host.listDir，test-utils 原版的 `/` 前缀扁平扫描在 Windows 上匹配不到
  // 反斜杠 key（同 resolver.spec 的处理方式）。files 表仍为共享引用。
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
async function seedProjectSoT(host: FakeHost): Promise<void> {
  await host.writeFile(path.join(PROJECT_SOT, 'profile.yaml'), PROFILE_YAML);
  await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
}

function syncOptions(host: FakeHost, overrides: Record<string, unknown> = {}) {
  return {
    host,
    env: readEnv(host),
    os: OS,
    cwd: CWD,
    agentforgeVersion: 'test-0.1.0',
    dryRun: false,
    ...overrides,
  };
}

describe('filterTargets', () => {
  it('未过滤 → profile.targets 全量', () => {
    expect(filterTargets(['opencode', 'claude'], undefined)).toEqual(['opencode', 'claude']);
    expect(filterTargets(['opencode', 'claude'], [])).toEqual(['opencode', 'claude']);
  });

  it('合法过滤 → 只保留指定的 target（保持 profile 顺序）', () => {
    expect(filterTargets(['opencode', 'codex', 'claude', 'pi'], ['claude', 'pi'])).toEqual([
      'claude',
      'pi',
    ]);
  });

  it('未知 target id → ConfigError(2)', () => {
    expect(() => filterTargets(['claude'], ['foo'])).toThrow(ConfigError);
  });

  it('过滤后与 profile.targets 无交集 → ConfigError(2)', () => {
    expect(() => filterTargets(['claude'], ['codex'])).toThrow(/未在 profile.targets 中启用/);
  });
});

describe('syncOnce — 前置检查', () => {
  it('未初始化（两层均无 SoT 配置）→ ConfigError(2)，hint 引导 aforge init', async () => {
    const host = createSyncHost();
    const err = await syncOnce(syncOptions(host)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    const configErr = err as ConfigError;
    expect(configErr.code).toBe(2);
    expect(configErr.hint).toContain('aforge init');
  });

  it('仅 user 层初始化 → 允许（effectiveScope=user，投影落 ~/.claude）', async () => {
    const host = createSyncHost();
    await host.writeFile(path.join(USER_SOT, 'profile.yaml'), 'version: 1\ntargets: [claude]\n');
    await host.writeFile(path.join(USER_SOT, 'habits.yaml'), HABITS_YAML);
    const result = await syncOnce(syncOptions(host));
    expect(result.scope).toBe('user');
    expect(result.sotRoot).toBe(USER_SOT);
    expect(host.files.has(CLAUDE_MD)).toBe(false); // user scope 不写项目根
    expect(host.files.has(USER_CLAUDE_MD)).toBe(true);
  });

  it('user scope 但用户目录缺失（AGF_HOME 指向有效 SoT）→ ConfigError(2)', async () => {
    // AGF_HOME 经 validatePath（宿主 api）解析；USERPROFILE/HOME 均缺 → 投影 rootDir 无法确定
    const host = createFakeHost();
    const agfHome = path.resolve('agf-home-投影测试');
    await host.writeFile(path.join(agfHome, 'profile.yaml'), 'version: 1\ntargets: [claude]\n');
    await host.writeFile(path.join(agfHome, 'habits.yaml'), 'version: 1\n');
    const env: EnvSnapshot = {
      agfHome,
      agfScope: 'user',
      offline: false,
      lineEnding: undefined,
      ci: false,
      codexHome: undefined,
      userProfile: undefined,
    };
    const err = await syncOnce(syncOptions(host, { env })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain('用户目录');
  });
});

describe('syncOnce — 单 target 闭环（claude）', () => {
  it('init 后 sync：CLAUDE.md 存在且 marker 区间 = 渲染结果', async () => {
    const host = createSyncHost();
    await seedProjectSoT(host);

    const result = await syncOnce(syncOptions(host));

    expect(result.scope).toBe('project');
    expect(result.targets.map((t) => t.targetId)).toEqual(['claude']);
    expect(result.skippedTargets).toEqual([]);

    const claude = host.files.get(CLAUDE_MD) as string;
    const split = splitByMarkers(claude, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END);
    expect(split.hasMarkers).toBe(true);
    expect(split.inside).toBe(`\n${RENDERED_MINIMAL}`);
    // marker 独占行（块从文件头开始，尾换行收束）
    expect(claude.startsWith(`${DEFAULT_MARKER_BEGIN}\n`)).toBe(true);
    expect(claude.endsWith(`${DEFAULT_MARKER_END}\n`)).toBe(true);
  });

  it('声明字段进入渲染（fnm → Toolchain 行，变量注入非写死，Spec §5.1）', async () => {
    const host = createSyncHost();
    await host.writeFile(path.join(PROJECT_SOT, 'profile.yaml'), PROFILE_YAML);
    await host.writeFile(
      path.join(PROJECT_SOT, 'habits.yaml'),
      ['version: 1', 'runtime:', '  node:', '    manager: fnm', ''].join('\n'),
    );
    await syncOnce(syncOptions(host));
    expect(host.files.get(CLAUDE_MD)).toContain('use **fnm** only');
  });

  it('幂等：两次 sync 后 CLAUDE.md 逐字节一致', async () => {
    const host = createSyncHost();
    await seedProjectSoT(host);
    await syncOnce(syncOptions(host));
    const first = host.files.get(CLAUDE_MD);
    await syncOnce(syncOptions(host));
    expect(host.files.get(CLAUDE_MD)).toBe(first);
  });

  it('marker 外用户内容保留（Spec §8.2）', async () => {
    const host = createSyncHost();
    await seedProjectSoT(host);
    await host.writeFile(
      CLAUDE_MD,
      `# 我的项目说明\n\n${DEFAULT_MARKER_BEGIN}\nold\n${DEFAULT_MARKER_END}\n\n尾部备注\n`,
    );
    await syncOnce(syncOptions(host));
    const claude = host.files.get(CLAUDE_MD) as string;
    expect(claude.startsWith('# 我的项目说明\n\n')).toBe(true);
    expect(claude.endsWith('\n\n尾部备注\n')).toBe(true);
  });

  it('custom 两层合并：同名 project 覆盖 user，异名都保留（按文件名序）', async () => {
    const host = createSyncHost();
    await seedProjectSoT(host);
    await host.writeFile(path.join(USER_SOT, 'custom', 'a.md'), 'user A\n');
    await host.writeFile(path.join(USER_SOT, 'custom', 'b.md'), 'user B\n');
    await host.writeFile(path.join(PROJECT_SOT, 'custom', 'b.md'), 'project B\n');
    await syncOnce(syncOptions(host));
    const claude = host.files.get(CLAUDE_MD) as string;
    expect(claude).toContain('user A');
    expect(claude).toContain('project B');
    expect(claude).not.toContain('user B');
  });

  it('M6 四 projector 全注册：opencode/claude/pi 均同步且 skipped 为空（共享根 AGENTS.md）', async () => {
    const host = createSyncHost();
    await host.writeFile(
      path.join(PROJECT_SOT, 'profile.yaml'),
      'version: 1\ntargets: [opencode, claude, pi]\n',
    );
    await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
    const result = await syncOnce(syncOptions(host));
    expect(result.skippedTargets).toEqual([]);
    expect(result.targets.map((t) => t.targetId)).toEqual(['opencode', 'claude', 'pi']);
    expect(host.files.has(CLAUDE_MD)).toBe(true);
    // opencode / pi 主规则共用根 AGENTS.md（投影矩阵 §8.7）；各自 MCP 配置独立
    expect(host.files.has(path.join(CWD, 'AGENTS.md'))).toBe(true);
    expect(host.files.has(path.join(CWD, 'opencode.json'))).toBe(true);
    expect(host.files.has(path.join(CWD, '.pi', 'mcp.json'))).toBe(true);
    expect(host.files.has(path.join(CWD, '.mcp.json'))).toBe(true); // claude 在 targets 内
    expect(host.files.has(path.join(CWD, '.codex', 'config.toml'))).toBe(false); // codex 未启用
  });

  it('仅 codex → 单 target 同步：根 AGENTS.md + .codex 下的 config.toml 标记段（M6 全注册）', async () => {
    const host = createSyncHost();
    await host.writeFile(path.join(PROJECT_SOT, 'profile.yaml'), 'version: 1\ntargets: [codex]\n');
    await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
    const result = await syncOnce(syncOptions(host));
    expect(result.targets.map((t) => t.targetId)).toEqual(['codex']);
    expect(host.files.has(path.join(CWD, 'AGENTS.md'))).toBe(true);
    expect(host.files.get(path.join(CWD, '.codex', 'config.toml'))).toContain(
      '# BEGIN AGENTFORGE MCP',
    );
    expect(host.files.has(CLAUDE_MD)).toBe(false);
  });

  it('AGF_LINE_ENDING=crlf → CLAUDE.md 与 sync-meta 均为 CRLF（Spec §2.4/§2.5）', async () => {
    const host = createSyncHost({ AGF_LINE_ENDING: 'crlf' });
    await seedProjectSoT(host);
    await syncOnce(syncOptions(host));
    const claude = host.files.get(CLAUDE_MD) as string;
    expect(claude).toContain('\r\n');
    expect(claude).not.toMatch(/[^\r]\n/);
    const meta = host.files.get(syncMetaPath(PROJECT_SOT)) as string;
    expect(meta).not.toMatch(/[^\r]\n/);
  });

  it('--targets 过滤：只 sync 指定 target（M5 单 projector 下仍走过滤校验）', async () => {
    const host = createSyncHost();
    await seedProjectSoT(host);
    const result = await syncOnce(syncOptions(host, { targetsFilter: ['claude'] }));
    expect(result.targets.map((t) => t.targetId)).toEqual(['claude']);
  });

  it('--targets 非法 id → ConfigError(2)', async () => {
    const host = createSyncHost();
    await seedProjectSoT(host);
    await expect(syncOnce(syncOptions(host, { targetsFilter: ['nope'] }))).rejects.toThrow(
      ConfigError,
    );
  });
});

describe('syncOnce — dry-run', () => {
  it('不写任何文件（CLAUDE.md / sync-meta 均不存在），结果含将写入的路径', async () => {
    const host = createSyncHost();
    await seedProjectSoT(host);
    const result = await syncOnce(syncOptions(host, { dryRun: true }));

    expect(result.dryRun).toBe(true);
    expect(result.targets[0]?.items[0]?.path).toBe(CLAUDE_MD);
    expect(host.files.has(CLAUDE_MD)).toBe(false);
    expect(host.files.has(syncMetaPath(PROJECT_SOT))).toBe(false);
  });
});

describe('buildGitignoreItem（Spec §4.2 projection.gitignore_generated）', () => {
  const plan = (items: readonly string[]) => ({
    plan: {
      targetId: 'claude' as const,
      items: items.map((p) => ({ path: p, action: 'write' as const, content: '' })),
    },
  });

  /**
   * AgentForge 自身的运行时产物（§3.2）：锁 / 备份 / 回滚失败保留副本。
   * 排序上 `.agf-backup-failed-` 系列在 `.agf-backup` 之前（`-` 小于 `/`）。
   */
  const RUNTIME_IGNORES = [
    '/.agentforge/.agf-backup-failed-*/',
    '/.agentforge/.agf-backup/',
    '/.agentforge/.sync.lock/',
  ];

  it('项目内产物 → 根锚定 posix 模式，去重且排序', () => {
    const item = buildGitignoreItem(
      [
        plan([CLAUDE_MD, path.join(CWD, '.mcp.json')]),
        plan([path.join(CWD, '.claude', 'skills', 's', 'SKILL.md'), CLAUDE_MD]),
      ],
      CWD,
      PROJECT_SOT,
      OS,
    );
    expect(item?.path).toBe(path.join(CWD, '.gitignore'));
    expect(item?.action).toBe('merge_marker');
    expect(item?.content).toBe(
      [...RUNTIME_IGNORES, '/.claude/skills/s/SKILL.md', '/.mcp.json', '/CLAUDE.md'].join('\n'),
    );
  });

  it('项目根之外的产物（user scope / CODEX_HOME）被过滤', () => {
    const item = buildGitignoreItem([plan([USER_CLAUDE_MD, CLAUDE_MD])], CWD, PROJECT_SOT, OS);
    expect(item?.content).toBe([...RUNTIME_IGNORES, '/CLAUDE.md'].join('\n'));
  });

  it('SoT 根在项目根之外（AGF_HOME 指向别处）→ 运行时产物不写入 .gitignore', () => {
    const item = buildGitignoreItem([plan([CLAUDE_MD])], CWD, USER_SOT, OS);
    expect(item?.content).toBe('/CLAUDE.md');
  });

  it('无任何项目内产物（且 SoT 也在项目外）→ undefined（不写空标记段）', () => {
    expect(buildGitignoreItem([plan([USER_CLAUDE_MD])], CWD, USER_SOT, OS)).toBeUndefined();
  });
});

describe('syncOnce — .gitignore 投影（Spec §4.2 projection.gitignore_generated）', () => {
  const GITIGNORE = path.join(CWD, '.gitignore');
  const PROFILE_WITH_GITIGNORE = [
    'version: 1',
    'scope: project',
    'targets: [claude]',
    'projection:',
    '  gitignore_generated: true',
    '',
  ].join('\n');

  async function seedWithGitignore(host: FakeHost): Promise<void> {
    await host.writeFile(path.join(PROJECT_SOT, 'profile.yaml'), PROFILE_WITH_GITIGNORE);
    await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
  }

  it('默认（未开启）→ 不写 .gitignore，result.gitignore = null（既有行为不变）', async () => {
    const host = createSyncHost();
    await seedProjectSoT(host);
    const result = await syncOnce(syncOptions(host));
    expect(result.gitignore).toBeNull();
    expect(host.files.has(GITIGNORE)).toBe(false);
  });

  it('开启 → 标记段内列出全部项目内产物，段外用户条目保留', async () => {
    const host = createSyncHost();
    await seedWithGitignore(host);
    await host.writeFile(GITIGNORE, 'node_modules/\n');
    const result = await syncOnce(syncOptions(host));

    const content = host.files.get(GITIGNORE) as string;
    expect(content).toContain('node_modules/');
    expect(content).toContain('# BEGIN AGENTFORGE');
    expect(content).toContain('/CLAUDE.md');
    expect(content).toContain('/.mcp.json');
    expect(content).toContain('# END AGENTFORGE');
    expect(result.gitignore?.targetId).toBe('gitignore');
    expect(result.gitignore?.statuses).toEqual(['written']);
  });

  it('开启 → 标记段内含 AgentForge 自身运行时产物（锁 / 备份 / 失败备份，§3.2）', async () => {
    const host = createSyncHost();
    await seedWithGitignore(host);
    await syncOnce(syncOptions(host));

    const content = host.files.get(GITIGNORE) as string;
    const inside = splitByMarkers(content, '# BEGIN AGENTFORGE', '# END AGENTFORGE').inside;
    expect(inside).toContain('/.agentforge/.sync.lock/');
    expect(inside).toContain('/.agentforge/.agf-backup/');
    expect(inside).toContain('/.agentforge/.agf-backup-failed-*/');
  });

  it('幂等：第二次 sync → unchanged 且内容逐字节一致', async () => {
    const host = createSyncHost();
    await seedWithGitignore(host);
    await syncOnce(syncOptions(host));
    const once = host.files.get(GITIGNORE);
    const again = await syncOnce(syncOptions(host));
    expect(host.files.get(GITIGNORE)).toBe(once);
    expect(again.gitignore?.statuses).toEqual(['unchanged']);
  });

  it('dry-run → 计划里出现 .gitignore 项但不落盘', async () => {
    const host = createSyncHost();
    await seedWithGitignore(host);
    const result = await syncOnce(syncOptions(host, { dryRun: true }));
    expect(result.gitignore?.items[0]?.path).toBe(GITIGNORE);
    expect(result.gitignore?.statuses).toEqual(['planned']);
    expect(host.files.has(GITIGNORE)).toBe(false);
  });

  it('effective scope=user → 不写（项目根之外的投影不该进项目 .gitignore）', async () => {
    const host = createSyncHost();
    await host.writeFile(
      path.join(USER_SOT, 'profile.yaml'),
      [
        'version: 1',
        'scope: user',
        'targets: [claude]',
        'projection:',
        '  gitignore_generated: true',
        '',
      ].join('\n'),
    );
    await host.writeFile(path.join(USER_SOT, 'habits.yaml'), HABITS_YAML);
    const result = await syncOnce(syncOptions(host));
    expect(result.scope).toBe('user');
    expect(result.gitignore).toBeNull();
    expect(host.files.has(GITIGNORE)).toBe(false);
  });
});

describe('syncOnce — profile.projection.marker_mode 端到端（Spec §4.2）', () => {
  it('marker_mode: none → CLAUDE.md 为裸正文（无 marker 包裹）', async () => {
    const host = createSyncHost();
    await host.writeFile(
      path.join(PROJECT_SOT, 'profile.yaml'),
      [
        'version: 1',
        'scope: project',
        'targets: [claude]',
        'projection:',
        '  marker_mode: none',
        '',
      ].join('\n'),
    );
    await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
    await syncOnce(syncOptions(host));
    expect(host.files.get(CLAUDE_MD)).toBe(RENDERED_MINIMAL);
    expect(host.files.get(CLAUDE_MD)).not.toContain(DEFAULT_MARKER_BEGIN);
  });

  it('marker_mode: append_below_marker → 旧区间内容保留在新正文之后', async () => {
    const host = createSyncHost();
    await host.writeFile(
      path.join(PROJECT_SOT, 'profile.yaml'),
      [
        'version: 1',
        'scope: project',
        'targets: [claude]',
        'projection:',
        '  marker_mode: append_below_marker',
        '',
      ].join('\n'),
    );
    await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
    await host.writeFile(CLAUDE_MD, `${DEFAULT_MARKER_BEGIN}\n# 历史正文\n${DEFAULT_MARKER_END}\n`);
    await syncOnce(syncOptions(host, { force: true }));
    const inside = splitByMarkers(
      host.files.get(CLAUDE_MD) as string,
      DEFAULT_MARKER_BEGIN,
      DEFAULT_MARKER_END,
    ).inside;
    expect(inside).toContain('# AgentForge Rules');
    expect(inside).toContain('# 历史正文');
  });
});

describe('syncOnce — sync-meta.json（Spec §3.3）', () => {
  it('结构与语义：lastSyncAt/os/agentforgeVersion/targets.claude.contentHash', async () => {
    const host = createSyncHost();
    await seedProjectSoT(host);
    const result = await syncOnce(syncOptions(host));

    const meta = JSON.parse(host.files.get(syncMetaPath(PROJECT_SOT)) as string) as {
      version: number;
      lastSyncAt: string;
      os: string;
      agentforgeVersion: string;
      targets: Record<string, { contentHash: string; writtenAt: string }>;
    };
    expect(meta.version).toBe(1);
    expect(meta.os).toBe(OS.platform);
    expect(meta.agentforgeVersion).toBe('test-0.1.0');
    expect(meta.lastSyncAt).toBe('1970-01-01T00:00:00.000Z'); // fake host 冻结时钟
    // M7：contentHash 基准统一为 marker 区间形态（renderedSectionHash），
    // 与投影文件读回的 markerSectionHash 可直接相等比较（见 markers.ts 调整说明）
    expect(meta.targets.claude?.contentHash).toBe(renderedSectionHash(RENDERED_MINIMAL));
    expect(meta.targets.claude?.writtenAt).toBe('1970-01-01T00:00:00.000Z');
    // result.contentHash 与 meta 一致（doctor 一致性检测基准）
    expect(result.contentHash).toBe(meta.targets.claude?.contentHash);
  });

  it('保留其他 target 的既有记录（增量合并，不整表覆盖）', async () => {
    const host = createSyncHost();
    await seedProjectSoT(host);
    const staleHash = 'f'.repeat(64);
    await host.writeFile(
      syncMetaPath(PROJECT_SOT),
      JSON.stringify({
        version: 1,
        lastSyncAt: '2026-01-01T00:00:00.000Z',
        os: 'win32',
        agentforgeVersion: 'older',
        targets: { opencode: { contentHash: staleHash, writtenAt: '2026-01-01T00:00:00.000Z' } },
      }),
    );
    await syncOnce(syncOptions(host));
    const meta = JSON.parse(host.files.get(syncMetaPath(PROJECT_SOT)) as string) as {
      targets: Record<string, { contentHash: string }>;
    };
    expect(meta.targets.opencode?.contentHash).toBe(staleHash);
    expect(meta.targets.claude).toBeTruthy();
  });
});
