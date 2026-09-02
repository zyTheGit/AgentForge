/**
 * `profile.skills.*` 的「声明 vs 实际」诊断单测（core/doctor/check-skills）。
 *
 * 重点是两条契约：
 * 1) **逐项失败不中断**：`SKILL.md` 读不出来时报一条 error 而不是让 await 抛穿
 *    `runConfigDependentChecks`——那会丢掉整份诊断报告、退出码退化成 GenericError(1)；
 * 2) **与 sync 同口径**：doctor 说「按需已生效」的前提必须与 sync 实际注入成功一致，
 *    否则 SoT 里写了 `disable-model-invocation: false` 时 doctor 报 ok 而产物没生效。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EffectiveConfig } from '../../src/core/config/defaults';
import type { DoctorRoots } from '../../src/core/doctor/check-config';
import { checkSkillsOnDemand } from '../../src/core/doctor/check-skills';
import type { DoctorCheckResult } from '../../src/core/doctor/check-types';
import { ExitCode } from '../../src/core/errors';
import { HabitsSchema, ProfileSchema } from '../../src/schema';
import { createFakeHost, errnoError, type FakeHost } from './test-utils';

const HOME = path.resolve('/home/u');
const CWD = path.resolve('/proj');
const USER_SOT = path.join(HOME, '.agentforge');
const PROJECT_SOT = path.join(CWD, '.agentforge');

const ROOTS: DoctorRoots = {
  userSoTRoot: USER_SOT,
  projectSoTRoot: PROJECT_SOT,
  userRootForLoad: USER_SOT,
};

const DOC = ['---', 'name: lazy', 'description: 备货技能', '---', '', '# Lazy', ''].join('\n');

function config(profileInput: Record<string, unknown>): EffectiveConfig {
  return {
    profile: ProfileSchema.parse({ version: 1, targets: ['claude'], ...profileInput }),
    habits: HabitsSchema.parse({ version: 1 }),
    userSoTRoot: USER_SOT,
    projectSoTRoot: PROJECT_SOT,
    effectiveScope: 'project',
  };
}

function skillDoc(name: string): string {
  return path.join(PROJECT_SOT, 'skills', name, 'SKILL.md');
}

async function run(
  host: FakeHost,
  profileInput: Record<string, unknown>,
): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];
  await checkSkillsOnDemand(host, results, ROOTS, config(profileInput));
  return results;
}

/** 指定 item 的那条结果（找不到 → undefined，便于断言「没有这一条」）。 */
function byItem(results: DoctorCheckResult[], item: string): DoctorCheckResult | undefined {
  return results.find((entry) => entry.item === item);
}

describe('checkSkillsOnDemand', () => {
  it('未声明 → 单条 ok', async () => {
    const results = await run(createFakeHost(), {});
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ level: 'ok', item: 'skills-on-demand' });
  });

  it('装好且 frontmatter 合法 → 名字进 effective 的 ok 行', async () => {
    const host = createFakeHost();
    await host.writeFile(skillDoc('lazy'), DOC);

    const results = await run(host, { skills: { on_demand: ['lazy'] } });
    expect(byItem(results, 'skills-on-demand')).toMatchObject({ level: 'ok' });
    expect(byItem(results, 'skills-on-demand')?.detail).toContain('lazy');
  });

  it('未安装 → warn（备货清单语义，与 sync 的 skip 同口径）', async () => {
    const results = await run(createFakeHost(), { skills: { on_demand: ['ghost'] } });
    expect(byItem(results, 'skills-on-demand/ghost')).toMatchObject({ level: 'warn' });
    // 没有生效的名字 → 不产出那条会撒谎的 ok
    expect(byItem(results, 'skills-on-demand')).toBeUndefined();
  });

  it('SoT 显式 disable-model-invocation: false → warn，且**不**并进 effective', async () => {
    const host = createFakeHost();
    await host.writeFile(
      skillDoc('optout'),
      ['---', 'name: optout', 'disable-model-invocation: false', '---', 'body'].join('\n'),
    );

    const results = await run(host, { skills: { on_demand: ['optout'] } });
    const warn = byItem(results, 'skills-on-demand/optout');
    expect(warn?.level).toBe('warn');
    expect(warn?.detail).toContain('启用按需语义');
    // 这是本轮修的核心矛盾：过去这里会同时输出「ok：已生效」
    expect(byItem(results, 'skills-on-demand')).toBeUndefined();
  });

  it('frontmatter 不是合法 YAML 顶层映射 → warn（注入被拒绝）', async () => {
    const host = createFakeHost();
    await host.writeFile(
      skillDoc('weird'),
      ['---', '# 标题', '---', '', '正文 key: value', ''].join('\n'),
    );

    const results = await run(host, { skills: { on_demand: ['weird'] } });
    expect(byItem(results, 'skills-on-demand/weird')?.level).toBe('warn');
    expect(byItem(results, 'skills-on-demand')).toBeUndefined();
  });

  it('BOM 开头的 SKILL.md 不再被误判为「没有 frontmatter」', async () => {
    const host = createFakeHost();
    await host.writeFile(skillDoc('bom'), `\uFEFF${DOC}`);

    const results = await run(host, { skills: { on_demand: ['bom'] } });
    expect(byItem(results, 'skills-on-demand/bom')).toBeUndefined();
    expect(byItem(results, 'skills-on-demand')?.level).toBe('ok');
  });

  it('SKILL.md 读取失败 → 记一条 error 并继续，不让整次 doctor 崩掉', async () => {
    const base = createFakeHost();
    await base.writeFile(skillDoc('broken'), DOC);
    await base.writeFile(skillDoc('fine'), DOC);
    const host: FakeHost = {
      ...base,
      async readFile(p) {
        if (p === skillDoc('broken')) {
          // SKILL.md 被换成目录 / 权限不可读 / UNC 断链都会这样抛
          throw errnoError('EISDIR', `illegal operation on a directory: ${p}`);
        }
        return base.readFile(p);
      },
    };

    // 关键：整个调用不抛
    const results = await run(host, { skills: { on_demand: ['broken', 'fine'] } });

    const err = byItem(results, 'skills-on-demand/broken');
    expect(err?.level).toBe('error');
    expect(err?.detail).toContain(skillDoc('broken'));
    expect(err?.code).toBe(ExitCode.Config);
    // 后一个名字照常被检查（逐项收集，不中断）
    expect(byItem(results, 'skills-on-demand')?.detail).toContain('fine');
  });

  it('启用 opencode 且有生效名字 → 追加一条如实表述的降级 warn', async () => {
    const host = createFakeHost();
    await host.writeFile(skillDoc('lazy'), DOC);

    const results = await run(host, {
      targets: ['claude', 'opencode'],
      skills: { on_demand: ['lazy'] },
    });
    const warn = byItem(results, 'skills-on-demand/opencode-unsupported');
    expect(warn?.level).toBe('warn');
    // 不再断言「一律忽略」——那条行为未实机验证
    expect(warn?.detail).toContain('未实机验证');
  });

  it('没有生效的名字时不产出 opencode 降级 warn（无从降级）', async () => {
    const results = await run(createFakeHost(), {
      targets: ['claude', 'opencode'],
      skills: { on_demand: ['ghost'] },
    });
    expect(byItem(results, 'skills-on-demand/opencode-unsupported')).toBeUndefined();
  });
});
