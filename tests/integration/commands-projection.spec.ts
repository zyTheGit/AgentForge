/**
 * §8.8 Commands 投影集成测试（验收 §11.2-14）：
 * 1. `skills.expose_as_command` 点名后 sync 在各 target 的命令目录落盘薄壳；
 * 2. 从名单里摘掉后，下一轮 sync 按 §7.6 记账清理这些薄壳；
 * 3. 手工改过的薄壳不删，报进 `pruneSkipped`；
 * 4. 点名未安装的 skill → sync 退出码 2。
 *
 * 用真实临时目录 + realHost（env 经包装 host 指向临时 home），与 prune 用例同一套
 * 工作区约定；启用的 target 随 detect 结果变化，故落点按实测过滤而不写死清单。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { runInit } from '../../src/commands/init';
import { runSkillAdd } from '../../src/commands/skill';
import { runSourceAdd } from '../../src/commands/source';
import { runSync } from '../../src/commands/sync';
import { ExitCode } from '../../src/core/errors';
import { currentOs } from '../../src/core/paths';
import type { Host } from '../../src/infra/host';
import { realHost } from '../../src/infra/real-host';

const OS = currentOs();
const VERSION = 'test-0.1.0';
const SKILL_NAME = 'code-review';
const SKILL_MD = [
  '---',
  `name: ${SKILL_NAME}`,
  'description: 审查改动，输出按优先级排序的问题清单',
  'argument-hint: "[commit-ish]"',
  'allowed-tools: Bash(git diff:*)',
  '---',
  '',
  '# Code Review',
  '',
  '逐维度检查 diff。',
  '',
].join('\n');

interface Workspace {
  readonly root: string;
  readonly host: Host;
  readonly sotRoot: string;
}

async function createWorkspace(): Promise<Workspace> {
  const base = await mkdtemp(path.join(tmpdir(), 'aforge-集成 commands-'));
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

  return { root, host, sotRoot: path.join(root, '.agentforge') };
}

describe('Commands 投影（§8.8 / 验收 §11.2-14）', () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await createWorkspace();
  });

  afterEach(async () => {
    await rm(path.dirname(ws.root), { recursive: true, force: true });
  });

  function ctx() {
    return { host: ws.host, cwd: ws.root, os: OS };
  }

  /** 四家的命令薄壳落点（project scope；codex 不产出，故不在列）。 */
  function commandCandidates(): string[] {
    return [
      path.join(ws.root, '.claude', 'commands', `${SKILL_NAME}.md`),
      path.join(ws.root, '.opencode', 'command', `${SKILL_NAME}.md`),
      path.join(ws.root, '.pi', 'prompts', `${SKILL_NAME}.md`),
    ];
  }

  /** 改写 SoT profile.yaml 的 skills.expose_as_command。 */
  async function setExposeAsCommand(names: readonly string[]): Promise<void> {
    const file = path.join(ws.sotRoot, 'profile.yaml');
    const profile = parseYaml(await readFile(file, 'utf8')) as {
      skills?: { expose_as_command?: string[] };
    };
    profile.skills = { ...profile.skills, expose_as_command: [...names] };
    await writeFile(file, stringifyYaml(profile), 'utf8');
  }

  /** init + vendor 源 + skill add + expose_as_command 点名（不 sync）。 */
  async function seed(): Promise<void> {
    await runInit(ctx());
    const vendor = path.join(path.dirname(ws.root), 'vendor-src');
    await mkdir(path.join(vendor, 'skills', SKILL_NAME), { recursive: true });
    await writeFile(path.join(vendor, 'skills', SKILL_NAME, 'SKILL.md'), SKILL_MD, 'utf8');
    await runSourceAdd(ctx(), vendor, { id: 'vendor' });
    await runSkillAdd(ctx(), SKILL_NAME, 'vendor');
    await setExposeAsCommand([SKILL_NAME]);
  }

  it('点名后 sync：各 target 命令目录落盘薄壳（frontmatter 透传 + $ARGUMENTS，不复制技能正文）', async () => {
    await seed();
    const synced = await runSync({ ...ctx(), agentforgeVersion: VERSION });
    const written = commandCandidates().filter((p) => existsSync(p));
    expect(written.length).toBeGreaterThan(0);

    for (const file of written) {
      const content = await readFile(file, 'utf8');
      expect(content).toContain('description: 审查改动，输出按优先级排序的问题清单');
      expect(content).toContain('argument-hint: "[commit-ish]"');
      expect(content).toContain('$ARGUMENTS');
      expect(content).toContain(SKILL_NAME);
      // §8.8.2：只透传两个键，技能正文不复制
      expect(content).not.toContain('allowed-tools');
      expect(content).not.toContain('逐维度检查 diff');
    }

    // §8.8.4：codex 的 project scope 整项跳过（不写 .codex\prompts\，也不写用户目录）
    expect(existsSync(path.join(ws.root, '.codex', 'prompts'))).toBe(false);
    if (synced.targets.some((t) => t.targetId === 'codex')) {
      // 跳过要说出来（sync 输出 / --json 都读这个字段），否则用户以为 codex 也生效了
      expect(synced.commandSkips.map((s) => s.targetId)).toContain('codex');
    }
  }, 120_000);

  it('从 expose_as_command 摘名 → 下一轮 sync 清理薄壳（§7.6 记账差集）', async () => {
    await seed();
    await runSync({ ...ctx(), agentforgeVersion: VERSION });
    const written = commandCandidates().filter((p) => existsSync(p));

    await setExposeAsCommand([]);
    const synced = await runSync({ ...ctx(), agentforgeVersion: VERSION });

    expect(written.filter((p) => existsSync(p))).toEqual([]);
    expect(synced.pruneSkipped).toEqual([]);
    for (const file of written) {
      expect(synced.pruned.map((p) => p.path)).toContain(file);
    }
    // 技能本体仍在 always 里 → SKILL.md 投影不受影响
    expect(existsSync(path.join(ws.sotRoot, 'skills', SKILL_NAME, 'SKILL.md'))).toBe(true);
  }, 120_000);

  it('手工改过的薄壳不删，报进 pruneSkipped', async () => {
    await seed();
    await runSync({ ...ctx(), agentforgeVersion: VERSION });
    const written = commandCandidates().filter((p) => existsSync(p));
    const edited = written[0] as string;
    await writeFile(edited, '# 我自己重写了这条命令\n', 'utf8');

    await setExposeAsCommand([]);
    const synced = await runSync({ ...ctx(), agentforgeVersion: VERSION });

    expect(existsSync(edited)).toBe(true);
    expect(await readFile(edited, 'utf8')).toContain('我自己重写了这条命令');
    expect(synced.pruneSkipped.map((s) => s.path)).toContain(edited);
    expect(synced.pruned.map((p) => p.path)).not.toContain(edited);
  }, 120_000);

  it('点名未安装的 skill → sync 退出码 2（§4.2 子集校验）', async () => {
    await runInit(ctx());
    await setExposeAsCommand(['not-installed']);

    await expect(runSync({ ...ctx(), agentforgeVersion: VERSION })).rejects.toMatchObject({
      code: ExitCode.Config,
    });
  }, 120_000);

  it('命名空间（§8.8.2）：claude / opencode 落子目录，pi 拼进文件名；摘名后同样被 prune', async () => {
    await seed();
    await setExposeAsCommand([`review/${SKILL_NAME}`]);
    await runSync({ ...ctx(), agentforgeVersion: VERSION });

    const nested = [
      path.join(ws.root, '.claude', 'commands', 'review', `${SKILL_NAME}.md`),
      path.join(ws.root, '.opencode', 'command', 'review', `${SKILL_NAME}.md`),
      path.join(ws.root, '.pi', 'prompts', `review-${SKILL_NAME}.md`),
    ];
    const written = nested.filter((p) => existsSync(p));
    expect(written.length).toBeGreaterThan(0);
    // 平铺名不应同时存在（命名空间不是"额外再来一份"）
    expect(commandCandidates().filter((p) => existsSync(p))).toEqual([]);

    await setExposeAsCommand([]);
    const synced = await runSync({ ...ctx(), agentforgeVersion: VERSION });
    expect(written.filter((p) => existsSync(p))).toEqual([]);
    expect(synced.pruneSkipped).toEqual([]);
  }, 120_000);

  it('SKILL.md 的 command-body 透传（§8.8.2 位置参数）：$1 原样落盘，内置模板不出现', async () => {
    await seed();
    const skillDoc = path.join(ws.sotRoot, 'skills', SKILL_NAME, 'SKILL.md');
    await writeFile(
      skillDoc,
      [
        '---',
        `name: ${SKILL_NAME}`,
        'description: 审查改动',
        'command-body: 审查 $1 分支上的 $2，其余上下文见 $ARGUMENTS',
        '---',
        '',
        '# Code Review',
        '',
      ].join('\n'),
      'utf8',
    );
    await runSync({ ...ctx(), agentforgeVersion: VERSION });

    const written = commandCandidates().filter((p) => existsSync(p));
    expect(written.length).toBeGreaterThan(0);
    for (const file of written) {
      const content = await readFile(file, 'utf8');
      expect(content).toContain('审查 $1 分支上的 $2，其余上下文见 $ARGUMENTS');
      expect(content).not.toContain('用户输入：$ARGUMENTS');
      // command-body 是正文来源，不进 frontmatter
      expect(content).not.toContain('command-body');
    }
  }, 120_000);
});
