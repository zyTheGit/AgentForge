/**
 * composer 单测（Spec §5.1 / §5.2 / §13.1→§13.2）：
 * 四层优先级装配顺序、Spec §13.1 habits → §13.2 投影片段逐字复现、
 * 空变量省略小节、空输入最小骨架、缺失/非法模板 fail-fast（ConfigError 2）、
 * 幂等与内置模板资产同步性。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASE_DEFAULT_TEMPLATE } from '../../../src/assets/templates';
import { ConfigError, ExitCode } from '../../../src/core/errors';
import { composeRules, renderRules } from '../../../src/core/generate/composer';
import type { ComposeInput } from '../../../src/core/generate/composer';
import { HabitsSchema, ProfileSchema } from '../../../src/schema';
import type { Habits } from '../../../src/schema';

/** Spec §13.1 的 habits 数据。 */
function habits131(): Habits {
  return HabitsSchema.parse({
    version: 1,
    runtime: {
      node: { manager: 'fnm', version: 'lts' },
      python: { manager: 'uv', version: '3.12+' },
      package_managers: ['pnpm', 'bun', 'npm'],
    },
    tools: {
      shell: 'powershell',
      git: { conventional_commits: true },
    },
    ai: {
      language: ['zh-CN', 'en'],
      style: 'concise, surgical changes, no speculative features',
      verification: ['test', 'lint', 'typecheck'],
      forbid: [
        'Do not suggest nvm when fnm is available',
        'Do not use pip install for project deps when uv is configured',
      ],
    },
  });
}

/** 最小 profile（targets 必填；templates 可选）。 */
function profileWith(templates?: readonly string[]) {
  return ProfileSchema.parse({
    version: 1,
    targets: ['claude'],
    ...(templates === undefined ? {} : { templates: [...templates] }),
  });
}

function composeInput(
  habits: Habits,
  templates: readonly string[] | undefined,
  overrides: Partial<Omit<ComposeInput, 'habits' | 'profile'>> = {},
): ComposeInput {
  return {
    habits,
    profile: profileWith(templates),
    customContents: [],
    promotedLearnings: [],
    templateContents: [],
    ...overrides,
  };
}

/** Spec §13.2 marker 区间内的期望正文（LF、单换行结尾）。 */
const EXPECTED_132 = `${[
  '# AgentForge Rules',
  '',
  '## Toolchain',
  '- Node: use **fnm** only (version preference: lts).',
  '- Python: use **uv** for envs and dependencies (3.12+).',
  '- JS packages: prefer **pnpm**, then bun, then npm.',
  '',
  '## Style',
  'concise, surgical changes, no speculative features',
  '',
  '## Verification',
  'Before finishing: run test, lint, and typecheck when applicable.',
  '',
  '## Forbidden',
  '- Do not suggest nvm when fnm is available',
  '- Do not use pip install for project deps when uv is configured',
].join('\n')}\n`;

/** 断言 promise 拒绝为 ConfigError(code 2)，并返回错误供进一步检查。 */
async function expectConfigError(promise: Promise<unknown>): Promise<ConfigError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    const e = err as ConfigError;
    expect(e.code).toBe(ExitCode.Config);
    return e;
  }
  throw new Error('期望抛出 ConfigError，但 promise 正常完成');
}

describe('§13.1 → §13.2 逐字复现（仅 base/default）', () => {
  it('composeRules：custom/promoted/templates 为空 → 输出与 §13.2 投影片段逐字一致', async () => {
    const rules = await composeRules(composeInput(habits131(), undefined));
    expect(rules).toBe(EXPECTED_132);
  });

  it('包含 §13.2 全部要点（Node fnm only / Python uv / prefer pnpm then bun then npm / style / 三项 verification / 两条 forbid）', async () => {
    const rules = await renderRules(habits131());
    for (const point of [
      '- Node: use **fnm** only (version preference: lts).',
      '- Python: use **uv** for envs and dependencies (3.12+).',
      '- JS packages: prefer **pnpm**, then bun, then npm.',
      'concise, surgical changes, no speculative features',
      'Before finishing: run test, lint, and typecheck when applicable.',
      '- Do not suggest nvm when fnm is available',
      '- Do not use pip install for project deps when uv is configured',
    ]) {
      expect(rules).toContain(point);
    }
    // §13.2 片段不含 shell/git 段（tools 不在 base/default 骨架中）
    expect(rules).not.toContain('powershell');
    expect(rules).not.toContain('conventional');
  });

  it('renderRules 便捷函数输出同一段正文（不含 marker）', async () => {
    const rules = await renderRules(habits131());
    expect(rules).toBe(EXPECTED_132);
    expect(rules).not.toContain('AGENTFORGE -->');
  });
});

describe('§5.2 四层优先级（输出自上而下）', () => {
  it('custom（按序）→ promoted learnings → 模板（按 profile.templates 序）→ base/default', async () => {
    const habits = HabitsSchema.parse({ version: 1, ai: { style: 's' } });
    const rules = await composeRules(
      composeInput(habits, ['extra/one', 'extra/two'], {
        customContents: ['# Custom A\n\nfirst file', '# Custom B\n\nsecond file'],
        promotedLearnings: ['Always run pnpm install after touching package.json.', 'Prefer vitest.'],
        templateContents: [
          { id: 'extra/one', content: '# Extra One\n\nfrom template' },
          { id: 'extra/two', content: '# Extra Two' },
        ],
      }),
    );

    const positions = [
      rules.indexOf('# Custom A'),
      rules.indexOf('# Custom B'),
      rules.indexOf('## Learnings'),
      rules.indexOf('# Extra One'),
      rules.indexOf('# Extra Two'),
      rules.indexOf('# AgentForge Rules'),
    ];
    expect(positions.every((p) => p >= 0)).toBe(true);
    // 顺序严格递增 = 四层优先级成立
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // learnings 段：统一 ## Learnings 标题，条目空行分隔
    expect(rules).toContain(
      '## Learnings\n\nAlways run pnpm install after touching package.json.\n\nPrefer vitest.',
    );
  });

  it('templateContents 含 base/default → ③ 层跳过，④ 层恒用内置版（不重复、不被外部内容替换）', async () => {
    const habits = HabitsSchema.parse({ version: 1 });
    const rules = await composeRules(
      composeInput(habits, ['base/default'], {
        templateContents: [{ id: 'base/default', content: '# forged skeleton' }],
      }),
    );
    expect(rules).toBe('# AgentForge Rules\n');
    expect(rules).not.toContain('forged');
  });
});

describe('空变量省略小节（Spec §5.1，禁止编造 / "Not specified"）', () => {
  it('node.manager=none 且其余 runtime 条目为空 → 无 Node 行，整个 Toolchain 节省略', async () => {
    const habits = HabitsSchema.parse({
      version: 1,
      runtime: { node: { manager: 'none' }, package_managers: [] },
    });
    const rules = await renderRules(habits);
    expect(rules).toBe('# AgentForge Rules\n');
    expect(rules).not.toContain('Node');
    expect(rules).not.toContain('Toolchain');
    expect(rules).not.toContain('Not specified');
  });

  it('node 未声明 + python 有 → Toolchain 节存在但无 Node 行（含 rust/go/包管理器变体）', async () => {
    const habits = HabitsSchema.parse({
      version: 1,
      runtime: {
        python: { manager: 'uv', version: '3.12' },
        rust: { manager: 'rustup', toolchain: 'stable' },
        go: { manager: 'mise' },
      },
    });
    const rules = await renderRules(habits);
    expect(rules).toContain('## Toolchain');
    expect(rules).toContain('- Python: use **uv** for envs and dependencies (3.12).');
    expect(rules).toContain('- Rust: use **rustup** (toolchain: stable).');
    expect(rules).toContain('- Go: use **mise**.');
    expect(rules).not.toContain('- Node:');
    expect(rules).not.toContain('JS packages');
  });

  it('ai.forbid 空 → 无 Forbidden 节', async () => {
    const habits = HabitsSchema.parse({
      version: 1,
      ai: { style: 's', verification: ['test'], forbid: [] },
    });
    const rules = await renderRules(habits);
    expect(rules).toContain('## Style');
    expect(rules).toContain('## Verification');
    expect(rules).not.toContain('Forbidden');
  });

  it('version 缺省的 Node 行不带括号后缀', async () => {
    const habits = HabitsSchema.parse({ version: 1, runtime: { node: { manager: 'volta' } } });
    const rules = await renderRules(habits);
    expect(rules).toContain('- Node: use **volta** only.');
    expect(rules).not.toContain('version preference');
  });
});

describe('fail-fast（Spec §5.2：未解析 id / 模板语法错误 → 退出码 2）', () => {
  it('profile.templates 声明但 templateContents 缺失 → ConfigError(2)，hint 指向 template list', async () => {
    const habits = HabitsSchema.parse({ version: 1 });
    const err = await expectConfigError(
      composeRules(composeInput(habits, ['extra/missing'])),
    );
    expect(err.message).toContain('extra/missing');
    expect(err.hint).toContain('aforge template list');
  });

  it('templateContents 含非法 Handlebars → ConfigError(2)，message 带模板 id 与解析位置', async () => {
    const habits = HabitsSchema.parse({ version: 1 });
    const err = await expectConfigError(
      composeRules(
        composeInput(habits, ['extra/broken'], {
          templateContents: [{ id: 'extra/broken', content: '{{#if unclosed' }],
        }),
      ),
    );
    expect(err.message).toContain('extra/broken');
    expect(err.message).toMatch(/line \d/);
  });
});

describe('边界与幂等', () => {
  it('全空输入 → 最小骨架（仅 # AgentForge Rules 标题）', async () => {
    const habits = HabitsSchema.parse({ version: 1 });
    const rules = await composeRules(composeInput(habits, undefined));
    expect(rules).toBe('# AgentForge Rules\n');
  });

  it('promoted learnings 全为空白内容 → 不产生 Learnings 段', async () => {
    const habits = HabitsSchema.parse({ version: 1 });
    const rules = await composeRules(
      composeInput(habits, undefined, { promotedLearnings: ['\n\n', '   '] }),
    );
    expect(rules).not.toContain('Learnings');
  });

  it('custom 内容首尾多余空行被剥除，小节间空行分隔', async () => {
    const habits = HabitsSchema.parse({ version: 1 });
    const rules = await composeRules(
      composeInput(habits, undefined, { customContents: ['\n\n# Custom\n\n\n'] }),
    );
    expect(rules).toBe('# Custom\n\n# AgentForge Rules\n');
  });

  it('幂等：同输入两次装配输出完全一致', async () => {
    const habits = habits131();
    const input = composeInput(habits, ['extra/one'], {
      customContents: ['# Custom A\n'],
      promotedLearnings: ['learned something'],
      templateContents: [{ id: 'extra/one', content: '# Extra One\n{{ai.style}}' }],
    });
    expect(await composeRules(input)).toBe(await composeRules(input));
  });
});

describe('内置模板资产同步', () => {
  it('templates/base/default.md 与 BASE_DEFAULT_TEMPLATE 常量逐字一致（防两份漂移；CRLF 归一化后比较）', () => {
    const fileContent = readFileSync(
      new URL('../../../templates/base/default.md', import.meta.url),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(fileContent).toBe(BASE_DEFAULT_TEMPLATE);
  });
});
