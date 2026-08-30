/**
 * M8 集成测试：learn → promote → sync（§11.2.3）、skill add 实体落地
 * （§11.2.6）、离线降级退出码 5（§11.2.7 / §7.8）、真 git 仓库 fixture 的
 * source add git pin / local 全流程，以及 cli.ts M8 命令注册的子进程端到端。
 *
 * 两层策略（同 sync.spec.ts）：
 * 1) 进程内：真实临时目录 + realHost（env 经包装 host 覆盖指向临时 home；
 *    mkdtemp 前缀含中文与空格，天然覆盖 §11.2.10）；
 * 2) 子进程：node --import tsx main.ts 端到端（learn --file - stdin /
 *    promote / sync / source add / skill add / AGF_OFFLINE 退出码）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { runInit } from '../../src/commands/init';
import { runLearn } from '../../src/commands/learn';
import { runMcpAdd, runMcpRemove } from '../../src/commands/mcp';
import { runPromote } from '../../src/commands/promote';
import { runSkillAdd, runSkillRemove } from '../../src/commands/skill';
import {
  runSourceAdd,
  runSourceList,
  runSourceRemove,
  runSourceUpdate,
} from '../../src/commands/source';
import { runSync } from '../../src/commands/sync';
import { OfflineError, toExitCode } from '../../src/core/errors';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END, splitByMarkers } from '../../src/core/markers';
import { currentOs } from '../../src/core/paths';
import type { Host } from '../../src/infra/host';
import { realHost } from '../../src/infra/real-host';

const OS = currentOs();
const VERSION = 'test-0.1.0';
const LEARNING_CONTENT = '包管理器统一使用 pnpm，禁止 npm install 直装依赖。';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainTs = path.join(repoRoot, 'src', 'main.ts');
/** tsx loader 的绝对 file URL（子进程 cwd 在临时目录，相对说明符不可解析）。 */
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

interface Workspace {
  readonly root: string;
  readonly home: string;
  readonly host: Host;
  readonly claudeMd: string;
  readonly agentsMd: string;
  readonly sotRoot: string;
  readonly userSoTRoot: string;
}

/** mkdtemp 前缀含中文与空格：§11.2.10 全流程覆盖。 */
async function createWorkspace(label: string): Promise<Workspace> {
  const base = await mkdtemp(path.join(tmpdir(), `aforge-集成 ${label}-`));
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
    agentsMd: path.join(root, 'AGENTS.md'),
    sotRoot,
    userSoTRoot: path.join(home, '.agentforge'),
  };
}

async function disposeWorkspace(ws: Workspace): Promise<void> {
  await rm(path.dirname(ws.root), { recursive: true, force: true });
}

/** 临时真 git 仓库 fixture（ASCII 目录；init + commit + 分支改名 main）。 */
async function createGitFixture(): Promise<{ dir: string; url: string; commit: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aforge-gitfixture-'));
  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'aforge-test',
    GIT_AUTHOR_EMAIL: 'aforge@test.local',
    GIT_COMMITTER_NAME: 'aforge-test',
    GIT_COMMITTER_EMAIL: 'aforge@test.local',
  };
  const git = (args: readonly string[]) =>
    spawnSync('git', [...args], { cwd: dir, encoding: 'utf8', env: gitEnv });

  expect(git(['init']).status).toBe(0);
  await writeFile(
    path.join(dir, 'manifest.yaml'),
    [
      'name: fixture',
      "version: '1.0.0'",
      'min_agentforge: 1',
      'skills:',
      '  - name: pdf',
      'templates:',
      '  - id: fixture/review',
      '    path: templates/review.md',
      '    description: fixture review template',
      '',
    ].join('\n'),
    'utf8',
  );
  await mkdir(path.join(dir, 'skills', 'pdf'), { recursive: true });
  await writeFile(path.join(dir, 'skills', 'pdf', 'SKILL.md'), '# fixture pdf skill\n', 'utf8');
  await mkdir(path.join(dir, 'templates'), { recursive: true });
  await writeFile(path.join(dir, 'templates', 'review.md'), 'fixture review rules\n', 'utf8');

  expect(git(['add', '-A']).status).toBe(0);
  expect(git(['commit', '-m', 'fixture init']).status).toBe(0);
  expect(git(['branch', '-M', 'main']).status).toBe(0);
  const commit = git(['rev-parse', 'HEAD']).stdout.trim();
  expect(commit).toMatch(/^[0-9a-f]{40}$/);

  return { dir, url: pathToFileURL(dir).href, commit };
}

// ---------------------------------------------------------------------------
// 进程内：learn → promote → sync（§11.2.3）
// ---------------------------------------------------------------------------

describe('learn → promote → sync（进程内，真实 fs）', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await createWorkspace('learn');
  });

  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('learn --file：learnings/<id>.yaml 落地（promoted:false）；未 promote 时 sync 投影不含该内容（§7.4）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    await writeFile(path.join(ws.root, 'notes.md'), `${LEARNING_CONTENT}\n`, 'utf8');

    const learned = await runLearn(
      { host: ws.host, cwd: ws.root, os: OS },
      { file: 'notes.md', id: 'e2e-rule', trigger: 'installing deps', category: 'tooling' },
    );
    expect(learned.learning.id).toBe('e2e-rule');
    expect(learned.learning.promoted).toBe(false);

    const entryFile = path.join(ws.sotRoot, 'learnings', 'e2e-rule.yaml');
    expect(existsSync(entryFile)).toBe(true);
    const entry = parseYaml(await readFile(entryFile, 'utf8')) as Record<string, unknown>;
    expect(entry.content).toBe(`${LEARNING_CONTENT}\n`);
    expect(entry.promoted).toBe(false);

    await runSync({ host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION });

    const claude = await readFile(ws.claudeMd, 'utf8');
    expect(claude).toContain('# AgentForge Rules');
    expect(claude).not.toContain(LEARNING_CONTENT);
    expect(claude).not.toContain('## Learnings');
  }, 30_000);

  it('§11.2.3 全流程：promote → custom/<id>.md 落地 + 条目保留；sync 后 CLAUDE.md/AGENTS.md 出现 learning 内容', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    await writeFile(path.join(ws.root, 'notes.md'), `${LEARNING_CONTENT}\n`, 'utf8');
    await runLearn(
      { host: ws.host, cwd: ws.root, os: OS },
      { file: 'notes.md', id: 'e2e-rule', category: 'tooling' },
    );

    const promoted = await runPromote({ host: ws.host, cwd: ws.root, os: OS }, 'e2e-rule');
    expect(promoted.fromScope).toBe('project');
    expect(promoted.targetScope).toBe('project');
    expect(promoted.targetFile).toBe(path.join(ws.sotRoot, 'custom', 'e2e-rule.md'));

    // 产物 = learning content 原文；条目保留（promoted:true + promoted_at）
    expect(await readFile(promoted.targetFile, 'utf8')).toBe(`${LEARNING_CONTENT}\n`);
    const entry = parseYaml(
      await readFile(path.join(ws.sotRoot, 'learnings', 'e2e-rule.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    expect(entry.promoted).toBe(true);
    expect(typeof entry.promoted_at).toBe('string');

    await runSync({ host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION });

    // CLAUDE.md 与 AGENTS.md（opencode 共享根）marker 区间都出现 learning 内容
    for (const file of [ws.claudeMd, ws.agentsMd]) {
      const text = await readFile(file, 'utf8');
      const split = splitByMarkers(text, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END);
      expect(split.hasMarkers).toBe(true);
      expect(split.inside).toContain('## Learnings');
      expect(split.inside).toContain(LEARNING_CONTENT);
    }
  }, 30_000);

  it('trigger 非空 → 该条投影带 **When:** 行；trigger 为空 → 正文原样（§4.3）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    const withTrigger = '依赖变更必须同步锁文件。';
    await writeFile(path.join(ws.root, 'a.md'), `${withTrigger}\n`, 'utf8');
    await writeFile(path.join(ws.root, 'b.md'), `${LEARNING_CONTENT}\n`, 'utf8');

    const ctx = { host: ws.host, cwd: ws.root, os: OS };
    await runLearn(ctx, { file: 'a.md', id: 'with-trigger', trigger: 'when adding dependencies' });
    await runLearn(ctx, { file: 'b.md', id: 'no-trigger' });
    await runPromote(ctx, 'with-trigger');
    await runPromote(ctx, 'no-trigger');

    await runSync({ ...ctx, agentforgeVersion: VERSION });

    const claude = await readFile(ws.claudeMd, 'utf8');
    // trigger 非空：正文前加一行 **When:** <trigger>
    expect(claude).toContain(`**When:** when adding dependencies\n\n${withTrigger}`);
    // trigger 为空：不生成空的 **When:** 行（§4.3 只投影 content + trigger）
    expect(claude).toContain(LEARNING_CONTENT);
    expect(claude).not.toContain('**When:** \n');
  }, 30_000);

  it('promote_target=habits_note → habits.notes 落地，sync 后投影出现 ## Notes 段（§4.1）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    const note = '团队约定：PR 必须双人评审。';
    await writeFile(path.join(ws.root, 'notes.md'), `${note}\n`, 'utf8');

    const ctx = { host: ws.host, cwd: ws.root, os: OS };
    await runLearn(ctx, { file: 'notes.md', id: 'note-1' });

    // learn 无 --promote-target 开关，直接改条目 YAML（用户手改 SoT 的等价路径）
    const entryFile = path.join(ws.sotRoot, 'learnings', 'note-1.yaml');
    const entryYaml = await readFile(entryFile, 'utf8');
    expect(entryYaml).toContain('promote_target: custom_rule');
    await writeFile(
      entryFile,
      entryYaml.replace('promote_target: custom_rule', 'promote_target: habits_note'),
      'utf8',
    );

    const promoted = await runPromote(ctx, 'note-1');
    expect(promoted.targetFile).toBe(path.join(ws.sotRoot, 'habits.yaml'));

    // 写的是顶层 notes（正式字段），不再是 detected.promote_notes 自由键
    const habits = parseYaml(await readFile(promoted.targetFile, 'utf8')) as {
      notes?: string[];
      detected?: Record<string, unknown>;
    };
    expect(habits.notes).toEqual([`note-1: ${note}`]);
    expect(habits.detected?.promote_notes).toBeUndefined();

    await runSync({ ...ctx, agentforgeVersion: VERSION });

    const claude = await readFile(ws.claudeMd, 'utf8');
    expect(claude).toContain('## Notes');
    expect(claude).toContain(`note-1: ${note}`);
  }, 30_000);

  /** profile.yaml 的 learning.auto_promote 打开（§4.2；init 落盘的是 false）。 */
  async function enableAutoPromote(): Promise<void> {
    const profileFile = path.join(ws.sotRoot, 'profile.yaml');
    const before = await readFile(profileFile, 'utf8');
    expect(before).toContain('auto_promote: false');
    await writeFile(
      profileFile,
      before.replace('auto_promote: false', 'auto_promote: true'),
      'utf8',
    );
  }

  it('auto_promote: true → learn 一步到位：custom/<id>.md 落地 + 条目 promoted:true（§4.2）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    await enableAutoPromote();

    const learned = await runLearn(
      { host: ws.host, cwd: ws.root, os: OS },
      { content: `${LEARNING_CONTENT}\n`, id: 'auto-rule', category: 'tooling' },
    );

    expect(learned.autoPromote?.ok).toBe(true);
    const promoted = learned.autoPromote?.ok === true ? learned.autoPromote.result : null;
    expect(promoted?.targetFile).toBe(path.join(ws.sotRoot, 'custom', 'auto-rule.md'));
    expect(await readFile(path.join(ws.sotRoot, 'custom', 'auto-rule.md'), 'utf8')).toBe(
      `${LEARNING_CONTENT}\n`,
    );

    // 条目已被标记（learn 返回的 learning 是 promote 前的快照，磁盘才是最终态）
    const entry = parseYaml(
      await readFile(path.join(ws.sotRoot, 'learnings', 'auto-rule.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    expect(entry.promoted).toBe(true);
    expect(typeof entry.promoted_at).toBe('string');

    // 仍不投影：进 CLAUDE.md 依旧要 sync（§7.4-3 未被破坏）
    expect(existsSync(ws.claudeMd)).toBe(false);
    await runSync({ host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION });
    expect(await readFile(ws.claudeMd, 'utf8')).toContain(LEARNING_CONTENT);
  }, 30_000);

  it('auto_promote: true + autoPromote:false 覆盖（--no-auto-promote）→ 只落条目不 promote', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    await enableAutoPromote();

    const learned = await runLearn(
      { host: ws.host, cwd: ws.root, os: OS },
      { content: `${LEARNING_CONTENT}\n`, id: 'no-auto', autoPromote: false },
    );

    expect(learned.autoPromote).toBeUndefined();
    expect(existsSync(path.join(ws.sotRoot, 'custom', 'no-auto.md'))).toBe(false);
    const entry = parseYaml(
      await readFile(path.join(ws.sotRoot, 'learnings', 'no-auto.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    expect(entry.promoted).toBe(false);
  }, 30_000);

  it('auto_promote 失败（目标文件已存在 → 3）：条目仍创建且 promoted:false，可续跑 promote', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    await enableAutoPromote();

    // 预置同名产物 → promote 侧的 ConflictError(3)
    await mkdir(path.join(ws.sotRoot, 'custom'), { recursive: true });
    const targetFile = path.join(ws.sotRoot, 'custom', 'clash.md');
    await writeFile(targetFile, '手写的既有规则\n', 'utf8');

    const learned = await runLearn(
      { host: ws.host, cwd: ws.root, os: OS },
      { content: `${LEARNING_CONTENT}\n`, id: 'clash' },
    );

    // learn 本身不失败：条目落盘（这是 runLearn 不把 promote 异常抛出去的理由）
    expect(learned.autoPromote?.ok).toBe(false);
    const error = learned.autoPromote?.ok === false ? learned.autoPromote.error : null;
    expect(toExitCode(error)).toBe(3);
    expect(await readFile(targetFile, 'utf8')).toBe('手写的既有规则\n');

    const entryFile = path.join(ws.sotRoot, 'learnings', 'clash.yaml');
    expect(existsSync(entryFile)).toBe(true);
    expect((parseYaml(await readFile(entryFile, 'utf8')) as { promoted: boolean }).promoted).toBe(
      false,
    );

    // 处理掉冲突后手动续跑 promote 即可（可重试性）
    await rm(targetFile);
    const retried = await runPromote({ host: ws.host, cwd: ws.root, os: OS }, 'clash');
    expect(retried.targetFile).toBe(targetFile);
    expect(await readFile(targetFile, 'utf8')).toBe(`${LEARNING_CONTENT}\n`);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// skill add → sync（§11.2.6 实体 copy）
// ---------------------------------------------------------------------------

describe('source add local + skill add → sync（§11.2.6）', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await createWorkspace('skill');
  });

  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  it('skill add 实体 copy 落地 SoT skills/（非 symlink）并自动登记 skills.always → sync 投影 .claude/skills/', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });

    const vendor = path.join(ws.root, 'vendor-src');
    await mkdir(path.join(vendor, 'skills', 'pdf', 'assets'), { recursive: true });
    await writeFile(path.join(vendor, 'skills', 'pdf', 'SKILL.md'), '# pdf skill V1\n', 'utf8');
    await writeFile(path.join(vendor, 'skills', 'pdf', 'assets', 'extra.md'), 'extra\n', 'utf8');

    await runSourceAdd({ host: ws.host, cwd: ws.root, os: OS }, 'vendor-src', { id: 'vendor' });
    const added = await runSkillAdd({ host: ws.host, cwd: ws.root, os: OS }, 'pdf', 'vendor');
    expect(added.targetDir).toBe(path.join(ws.sotRoot, 'skills', 'pdf'));

    // 实体文件（非 symlink）：stat 为普通文件；改源后副本不变
    const sotSkill = path.join(ws.sotRoot, 'skills', 'pdf', 'SKILL.md');
    expect(statSync(sotSkill).isFile()).toBe(true);
    expect(existsSync(path.join(ws.sotRoot, 'skills', 'pdf', 'assets', 'extra.md'))).toBe(true);
    await writeFile(path.join(vendor, 'skills', 'pdf', 'SKILL.md'), '# pdf skill V2\n', 'utf8');
    expect(await readFile(sotSkill, 'utf8')).toBe('# pdf skill V1\n');

    // 自动登记：skill add 已把名字写进安装层 profile.skills.always（无需手工点名）
    expect(added.registered?.always).toEqual(['pdf']);
    expect(added.registered?.profileFile).toBe(path.join(ws.sotRoot, 'profile.yaml'));
    const profileRaw = parseYaml(await readFile(path.join(ws.sotRoot, 'profile.yaml'), 'utf8')) as {
      skills?: { always?: string[] };
    };
    expect(profileRaw.skills?.always).toEqual(['pdf']);

    // 直接 sync：投影 target 侧 skills 落地（§8.5 .claude\skills\<name>\SKILL.md）
    await runSync({ host: ws.host, cwd: ws.root, os: OS, agentforgeVersion: VERSION });

    const projected = path.join(ws.root, '.claude', 'skills', 'pdf', 'SKILL.md');
    expect(statSync(projected).isFile()).toBe(true);
    expect(await readFile(projected, 'utf8')).toBe('# pdf skill V1\n');
  }, 30_000);

  it('--no-register：只 copy 不碰 profile.yaml（registered 缺席）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    const profileFile = path.join(ws.sotRoot, 'profile.yaml');
    const profileBefore = existsSync(profileFile) ? await readFile(profileFile, 'utf8') : null;

    const vendor = path.join(ws.root, 'vendor-src');
    await mkdir(path.join(vendor, 'skills', 'pdf'), { recursive: true });
    await writeFile(path.join(vendor, 'skills', 'pdf', 'SKILL.md'), '# pdf skill\n', 'utf8');
    await runSourceAdd({ host: ws.host, cwd: ws.root, os: OS }, 'vendor-src', { id: 'vendor' });

    const added = await runSkillAdd(
      { host: ws.host, cwd: ws.root, os: OS },
      'pdf',
      'vendor',
      false,
    );
    // copy 照做，登记这一步整段跳过：profile.yaml 逐字节未变（连重排格式都没有）
    expect(added.registered).toBeUndefined();
    expect(existsSync(path.join(ws.sotRoot, 'skills', 'pdf', 'SKILL.md'))).toBe(true);
    expect(existsSync(profileFile) ? await readFile(profileFile, 'utf8') : null).toBe(
      profileBefore,
    );
  }, 30_000);

  it('登记失败 → 撤销 copy（修好 profile 后重跑不被 ConflictError 挡死）', async () => {
    await runInit({ host: ws.host, cwd: ws.root, os: OS });
    const profileFile = path.join(ws.sotRoot, 'profile.yaml');
    const validProfile = existsSync(profileFile)
      ? await readFile(profileFile, 'utf8')
      : 'version: 1\n';

    const vendor = path.join(ws.root, 'vendor-src');
    await mkdir(path.join(vendor, 'skills', 'pdf'), { recursive: true });
    await writeFile(path.join(vendor, 'skills', 'pdf', 'SKILL.md'), '# pdf skill\n', 'utf8');
    await runSourceAdd({ host: ws.host, cwd: ws.root, os: OS }, 'vendor-src', { id: 'vendor' });

    // profile.yaml 损坏 → 登记步骤抛 ConfigError(2)，此时 copy 已经落盘
    await writeFile(profileFile, 'version: 1\nskills: [unclosed\n', 'utf8');
    const ctx = { host: ws.host, cwd: ws.root, os: OS };
    await expect(runSkillAdd(ctx, 'pdf', 'vendor')).rejects.toThrow(
      expect.objectContaining({ code: 2 }),
    );
    // 补偿回滚：SoT 里不留半装的 skill，否则下次 add 撞 ConflictError(3) 永久挡死
    expect(existsSync(path.join(ws.sotRoot, 'skills', 'pdf'))).toBe(false);

    await writeFile(profileFile, validProfile, 'utf8');
    const retry = await runSkillAdd(ctx, 'pdf', 'vendor');
    expect(retry.registered?.always).toEqual(['pdf']);
    expect(existsSync(path.join(ws.sotRoot, 'skills', 'pdf', 'SKILL.md'))).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 离线降级（§11.2.7 / §7.8）
// ---------------------------------------------------------------------------

describe('AGF_OFFLINE=1 → source add git → OfflineError(5)（§7.8）', () => {
  it('进程内：OfflineError 且 toExitCode = 5', async () => {
    const ws = await createWorkspace('offline');
    try {
      const overrides: Record<string, string | undefined> = { AGF_OFFLINE: '1' };
      const host: Host = {
        ...ws.host,
        env(key) {
          return key in overrides ? overrides[key] : ws.host.env(key);
        },
      };

      const err = await runSourceAdd(
        { host, cwd: ws.root, os: OS },
        'https://example.com/agentforge/rules.git',
        { ref: 'v1.2.0' },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(OfflineError);
      expect((err as OfflineError).code).toBe(5);
      expect(toExitCode(err as OfflineError)).toBe(5);
      // 离线检查在 git 调用前：sources.json 不应产生任何登记
      expect(existsSync(path.join(ws.userSoTRoot, 'sources.json'))).toBe(false);
    } finally {
      await disposeWorkspace(ws);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 真 git 仓库 fixture：source add git pin / local 全流程
// ---------------------------------------------------------------------------

describe('真 git 仓库 fixture：add git（file:// pin）→ skill add → update → remove', () => {
  it('git pin 全流程（clone --depth 1 + fetch ref + checkout + rev-parse 记录 commit）', async () => {
    const ws = await createWorkspace('gitpin');
    const fixture = await createGitFixture();
    try {
      await runInit({ host: ws.host, cwd: ws.root, os: OS });

      const added = await runSourceAdd({ host: ws.host, cwd: ws.root, os: OS }, fixture.url, {
        ref: 'main',
        id: 'fixture',
      });
      expect(added.source.type).toBe('git');
      expect(added.source.ref).toBe('main');
      expect(added.source.commit).toBe(fixture.commit);

      // store\<id> 缓存落地（真实 clone 产物）
      const storeDir = path.join(ws.userSoTRoot, 'store', 'fixture');
      expect(existsSync(path.join(storeDir, 'skills', 'pdf', 'SKILL.md'))).toBe(true);
      expect(existsSync(path.join(storeDir, 'manifest.yaml'))).toBe(true);

      // 源清单读取（--from fixture 定位 store）；git autocrlf 可能转换换行，断言前归一化
      const skills = await runSkillAdd({ host: ws.host, cwd: ws.root, os: OS }, 'pdf', 'fixture');
      expect(skills.fromSourceId).toBe('fixture');
      expect(
        (await readFile(path.join(ws.sotRoot, 'skills', 'pdf', 'SKILL.md'), 'utf8')).replace(
          /\r\n/g,
          '\n',
        ),
      ).toBe('# fixture pdf skill\n');

      // update：fetch + checkout pinned commit（本地仓库内容不变 → commit 不变）
      const updated = await runSourceUpdate({ host: ws.host, cwd: ws.root, os: OS }, 'fixture');
      expect(updated.commit).toBe(fixture.commit);

      // remove：登记删除 + store 缓存回收
      await runSourceRemove({ host: ws.host, cwd: ws.root, os: OS }, 'fixture');
      expect((await runSourceList({ host: ws.host, cwd: ws.root, os: OS })).length).toBe(0);
      expect(existsSync(storeDir)).toBe(false);
    } finally {
      await disposeWorkspace(ws);
      await rm(fixture.dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 子进程端到端：node --import tsx src/main.ts（cli.ts M8 注册验证）
// ---------------------------------------------------------------------------

describe('aforge learn/promote/source/skill（子进程端到端）', () => {
  let base: string;
  let tmpHome: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'aforge-m8-e2e-'));
    tmpHome = path.join(base, 'home');
    await mkdir(tmpHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith('AGF_')) {
        delete env[key];
      }
    }
    // CI 必须显式清除：store.ts 的 §10 守卫在 CI 为真时让 createLearning 抛
    // ConfigError(2)，而本套件在 CI 上跑时会从 process.env 继承 CI=true，导致
    // learn 用例整批失败。需要验证守卫本身的用例请通过 extraEnv 显式传 CI。
    delete env.CI;
    env.USERPROFILE = tmpHome;
    env.HOME = tmpHome;
    return { ...env, ...extra };
  }

  function runCli(
    args: readonly string[],
    cwd: string,
    opts: { input?: string; extraEnv?: Record<string, string> } = {},
  ) {
    return spawnSync(process.execPath, ['--import', tsxImport, mainTs, ...args], {
      cwd,
      env: childEnv(opts.extraEnv),
      encoding: 'utf8',
      input: opts.input,
    });
  }

  it('learn --file -（stdin）→ promote → sync：CLAUDE.md/AGENTS.md 出现 learning 内容（§11.2.3）', () => {
    const root = path.join(base, 'proj');
    mkdirSync(root);

    expect(runCli(['init'], root).status).toBe(0);

    const learn = runCli(['learn', '--file', '-', '--id', 'e2e-learn'], root, {
      input: `${LEARNING_CONTENT}\n`,
    });
    expect(learn.status).toBe(0);
    expect(learn.stdout).toContain('learning created: e2e-learn');
    expect(existsSync(path.join(root, '.agentforge', 'learnings', 'e2e-learn.yaml'))).toBe(true);

    const promote = runCli(['promote', 'e2e-learn'], root);
    expect(promote.status).toBe(0);
    expect(promote.stdout).toContain('learning promoted: e2e-learn');
    expect(existsSync(path.join(root, '.agentforge', 'custom', 'e2e-learn.md'))).toBe(true);

    const sync = runCli(['sync'], root);
    expect(sync.status).toBe(0);
    expect(sync.stdout).toContain('sync complete');

    const claude = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('## Learnings');
    expect(claude).toContain(LEARNING_CONTENT);
    const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('## Learnings');
    expect(agents).toContain(LEARNING_CONTENT);
  }, 120_000);

  it('learning.auto_promote: true → learn 一条命令产出 custom/；--no-auto-promote 单次关掉', async () => {
    const root = path.join(base, 'proj');
    mkdirSync(root);
    expect(runCli(['init'], root).status).toBe(0);

    // init 落盘的是 auto_promote: false，改成 true（§4.2）
    const profileFile = path.join(root, '.agentforge', 'profile.yaml');
    const profile = readFileSync(profileFile, 'utf8');
    expect(profile).toContain('auto_promote: false');
    await writeFile(profileFile, profile.replace('auto_promote: false', 'auto_promote: true'));

    const auto = runCli(['learn', '--file', '-', '--id', 'cli-auto'], root, {
      input: `${LEARNING_CONTENT}\n`,
    });
    expect(auto.status).toBe(0);
    expect(auto.stdout).toContain('learning created: cli-auto');
    expect(auto.stdout).toContain('learning.auto_promote=true');
    expect(existsSync(path.join(root, '.agentforge', 'custom', 'cli-auto.md'))).toBe(true);

    const off = runCli(['learn', '--file', '-', '--id', 'cli-off', '--no-auto-promote'], root, {
      input: `${LEARNING_CONTENT} 第二条\n`,
    });
    expect(off.status).toBe(0);
    expect(off.stdout).toContain('aforge promote cli-off');
    expect(existsSync(path.join(root, '.agentforge', 'custom', 'cli-off.md'))).toBe(false);
  }, 120_000);

  it('source add local + skill add：SoT skills/ 落地实体文件（§11.2.6）', async () => {
    const root = path.join(base, 'proj');
    const vendor = path.join(base, 'vendor-src');
    mkdirSync(root);
    await mkdir(path.join(vendor, 'skills', 'pdf'), { recursive: true });
    await writeFile(path.join(vendor, 'skills', 'pdf', 'SKILL.md'), '# vendor pdf skill\n', 'utf8');

    expect(runCli(['init'], root).status).toBe(0);

    const add = runCli(['source', 'add', vendor, '--id', 'vendor'], root);
    expect(add.status).toBe(0);
    expect(add.stdout).toContain('source added: vendor');

    const skill = runCli(['skill', 'add', 'pdf', '--from', 'vendor'], root);
    expect(skill.status).toBe(0);
    expect(skill.stdout).toContain('skill installed: pdf');
    // §8.8：codex 是唯一用 $ 的，提示里必须写清差异（否则用户以为 codex 没生效）
    expect(skill.stdout).toContain('/pdf (opencode, claude, pi)');
    expect(skill.stdout).toContain('$pdf (codex)');

    const sotSkill = path.join(root, '.agentforge', 'skills', 'pdf', 'SKILL.md');
    expect(statSync(sotSkill).isFile()).toBe(true);
    expect(await readFile(sotSkill, 'utf8')).toBe('# vendor pdf skill\n');
  }, 120_000);

  it('AGF_OFFLINE=1 → source add git → 退出码 5（§11.2.7）', () => {
    const root = path.join(base, 'proj');
    mkdirSync(root);

    const result = runCli(['source', 'add', 'https://example.com/x.git', '--ref', 'v1'], root, {
      extraEnv: { AGF_OFFLINE: '1' },
    });
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('离线');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// remove → sync：差集清理（Spec §7.6 prune）
//
// `skill remove` / `mcp remove` 只改 SoT，投影产物的清理由下一次 sync 按 sync-meta
// 的上一轮记账做差集完成：不再产出的整文件产物被删除，被摘掉的 MCP server 键从
// merge_json 配置里摘除（§8.2 的「未知键保留」仍然成立——摘的是记账里认领过的键）。
// ---------------------------------------------------------------------------

describe('remove 后 sync 清理上一轮残留（§7.6 prune）', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await createWorkspace('prune');
  });

  afterEach(async () => {
    await disposeWorkspace(ws);
  });

  function ctx() {
    return { host: ws.host, cwd: ws.root, os: OS };
  }

  /** vendor 源 + skill add pdf + 首轮 sync；返回实际落地的投影产物路径。 */
  async function seedProjectedSkill(): Promise<string[]> {
    await runInit(ctx());
    const vendor = path.join(ws.root, 'vendor-src');
    await mkdir(path.join(vendor, 'skills', 'pdf'), { recursive: true });
    await writeFile(path.join(vendor, 'skills', 'pdf', 'SKILL.md'), '# pdf skill\n', 'utf8');
    await runSourceAdd(ctx(), 'vendor-src', { id: 'vendor' });
    await runSkillAdd(ctx(), 'pdf', 'vendor');
    await runSync({ ...ctx(), agentforgeVersion: VERSION });

    // target 集合随 detect 结果变化，故按实测取
    const projected = ['.claude', '.opencode', '.agents', '.pi']
      .map((dir) => path.join(ws.root, dir, 'skills', 'pdf', 'SKILL.md'))
      .filter((p) => existsSync(p));
    expect(projected.length).toBeGreaterThan(0);
    return projected;
  }

  it('skill remove → sync：各 agent 侧 skills/<name>/SKILL.md 被清理', async () => {
    const projectedBefore = await seedProjectedSkill();

    // ① SoT 侧摘除（remove 不删 SoT 磁盘上的 skill 目录，按设计保留）
    const removed = await runSkillRemove(ctx(), 'pdf');
    expect(removed.always).toEqual([]);
    const profile = parseYaml(await readFile(path.join(ws.sotRoot, 'profile.yaml'), 'utf8')) as {
      skills?: { always?: string[] };
    };
    expect(profile.skills?.always).toEqual([]);
    expect(existsSync(path.join(ws.sotRoot, 'skills', 'pdf', 'SKILL.md'))).toBe(true);

    // ② 再 sync 一次：上一轮记账里有、本轮不再产出 → 全部被清理
    const synced = await runSync({ ...ctx(), agentforgeVersion: VERSION });
    expect(projectedBefore.filter((p) => existsSync(p))).toEqual([]);
    expect(synced.pruneSkipped).toEqual([]);
    expect(new Set(synced.pruned.map((p) => p.path))).toEqual(new Set(projectedBefore));
  }, 60_000);

  it('手工改过的产物不删，报进 pruneSkipped（只删内容与记账一致的文件）', async () => {
    const projectedBefore = await seedProjectedSkill();
    const edited = projectedBefore[0] as string;
    await writeFile(edited, '# pdf skill（我手动加了一句）\n', 'utf8');

    await runSkillRemove(ctx(), 'pdf');
    const synced = await runSync({ ...ctx(), agentforgeVersion: VERSION });

    // 手工改过的那份原样保留并报出来；其余照常清理
    expect(existsSync(edited)).toBe(true);
    expect(synced.pruneSkipped.map((s) => s.path)).toEqual([edited]);
    expect(synced.pruned.map((p) => p.path)).not.toContain(edited);
  }, 60_000);

  it('mcp remove → sync：各 agent 侧 MCP 配置里的 server 键被摘除', async () => {
    await runInit(ctx());
    await runMcpAdd(ctx(), { name: 'jenkins-config', transport: 'stdio', command: 'npx' });
    await runSync({ ...ctx(), agentforgeVersion: VERSION });

    const candidates = [
      path.join(ws.root, 'opencode.json'),
      path.join(ws.root, '.mcp.json'),
      path.join(ws.root, '.pi', 'mcp.json'),
    ];
    const containing = async (): Promise<string[]> => {
      const hit: string[] = [];
      for (const file of candidates) {
        if (existsSync(file) && (await readFile(file, 'utf8')).includes('jenkins-config')) {
          hit.push(file);
        }
      }
      return hit;
    };
    expect((await containing()).length).toBeGreaterThan(0);

    // ① SoT 侧 mcp.servers 已摘除
    const removed = await runMcpRemove(ctx(), 'jenkins-config');
    expect(removed.servers).toEqual([]);
    const profile = parseYaml(await readFile(path.join(ws.sotRoot, 'profile.yaml'), 'utf8')) as {
      mcp?: { servers?: unknown[] };
    };
    expect(profile.mcp?.servers).toEqual([]);

    // ② 再 sync 一次：上一轮记账过的 server 键被摘掉（文件本身保留）
    const synced = await runSync({ ...ctx(), agentforgeVersion: VERSION });
    expect(await containing()).toEqual([]);
    expect(synced.pruned.filter((p) => p.kind === 'mcp-server').map((p) => p.name)).toContain(
      'jenkins-config',
    );
  }, 60_000);
});
