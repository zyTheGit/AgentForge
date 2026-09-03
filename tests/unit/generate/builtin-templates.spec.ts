/**
 * 内置补缺模板单测（`base/tools` / `base/context`，见 docs/direction-review.md §2.1）：
 * - opt-in 生效链路：不登记 → 一个字都不产出；登记 → 在 ③ 层、base/default 之前；
 * - 纯变量渲染 + 空值整节省略（Spec §5.1）；
 * - `habits.detected` 的防御式收窄（passthrough 快照里什么脏数据都可能有）。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASE_CONTEXT_TEMPLATE_ID,
  BASE_DEFAULT_TEMPLATE_ID,
  BASE_TOOLS_TEMPLATE_ID,
  findBuiltinTemplate,
} from '../../../src/assets/templates';
import type { ComposeInput } from '../../../src/core/generate/composer';
import { buildTemplateView, composeRules } from '../../../src/core/generate/composer';
import { resolveTemplate } from '../../../src/core/generate/resolver';
import type { Habits, HabitsInput } from '../../../src/schema';
import { HabitsSchema, ProfileSchema } from '../../../src/schema';
import { createFakeHost } from '../test-utils';

/** 一份探测到 java / monorepo / CI 的快照（正是 §2.2 冻结探测器的那几类）。 */
const DETECTED_SNAPSHOT = {
  node: { manager: 'fnm', source: 'path', version: '22' },
  python: { manager: 'none', source: 'none' },
  package_managers: [
    { name: 'pnpm', source: 'package.json' },
    { name: 'npm', source: 'path' },
  ],
  java: { manager: 'sdkman', source: 'env' },
  monorepo: { manager: 'turbo', source: 'config-file' },
  ci: { manager: 'github-actions', source: 'config-file' },
};

function habits(input: HabitsInput): Habits {
  return HabitsSchema.parse(input);
}

/** 把内置模板按 id 取成 templateContents（生产侧由 resolver 提供同样的内容）。 */
function builtinContents(ids: readonly string[]): ComposeInput['templateContents'] {
  return ids.map((id) => {
    const tpl = findBuiltinTemplate(id);
    if (tpl === undefined) {
      throw new Error(`测试用例引用了不存在的内置模板: ${id}`);
    }
    return { id, content: tpl.content };
  });
}

function composeWith(h: Habits, templates: readonly string[]): Promise<string> {
  return composeRules({
    habits: h,
    profile: ProfileSchema.parse({ version: 1, targets: ['claude'], templates: [...templates] }),
    customContents: [],
    promotedLearnings: [],
    templateContents: builtinContents(templates.filter((id) => id !== BASE_DEFAULT_TEMPLATE_ID)),
  });
}

describe('base/tools', () => {
  it('不登记 → 正文里没有 Tools 节（opt-in，默认投影保持极薄）', async () => {
    const body = await composeWith(habits({ version: 1, tools: { shell: 'pwsh' } }), [
      BASE_DEFAULT_TEMPLATE_ID,
    ]);
    expect(body).not.toContain('## Tools');
  });

  it('登记后渲染 tools.*，且排在 base/default 之前（§5.2 ③ 层高于 ④ 层）', async () => {
    const body = await composeWith(
      habits({
        version: 1,
        tools: {
          shell: 'powershell',
          editor: 'vscode',
          container: 'docker',
          git: { conventional_commits: true, sign_commits: true, default_branch: 'main' },
        },
      }),
      [BASE_TOOLS_TEMPLATE_ID, BASE_DEFAULT_TEMPLATE_ID],
    );
    expect(body).toBe(
      `${[
        '## Tools',
        '- Shell: write commands in **powershell** syntax.',
        '- Editor: **vscode**.',
        '- Containers: use **docker**.',
        '- Git: default branch is `main`; land changes through a branch + PR.',
        '- Git: commit messages follow Conventional Commits.',
        '- Git: sign every commit.',
        '',
        '# AgentForge Rules',
      ].join('\n')}\n`,
    );
  });

  it('tools 全空 → 整节省略（不输出空标题，Spec §5.1）', async () => {
    const body = await composeWith(habits({ version: 1, tools: { container: 'none' } }), [
      BASE_TOOLS_TEMPLATE_ID,
      BASE_DEFAULT_TEMPLATE_ID,
    ]);
    expect(body).toBe('# AgentForge Rules\n');
  });

  it('git 四个子字段全空 → tools.git 归一为 undefined，has_any 不因它为真', () => {
    const view = buildTemplateView(habits({ version: 1, tools: { git: {} } }));
    expect(view.tools.git).toBeUndefined();
    expect(view.tools.has_any).toBe(false);
  });
});

describe('base/context', () => {
  it('渲染 detected 快照，措辞是「仅供参考」而非规则（§4.1 声明优先）', async () => {
    const body = await composeWith(habits({ version: 1, detected: DETECTED_SNAPSHOT }), [
      BASE_CONTEXT_TEMPLATE_ID,
      BASE_DEFAULT_TEMPLATE_ID,
    ]);
    expect(body).toBe(
      `${[
        '## Project Context (detected)',
        '',
        'Detected by AgentForge, **for reference only — not rules**. Declared habits above win on conflict.',
        '- Node: fnm (22) — from path',
        '- Java: sdkman — from env',
        '- JS package managers: pnpm, npm',
        '- Monorepo tooling: turbo — from config-file',
        '- CI: github-actions — from config-file',
        '',
        '# AgentForge Rules',
      ].join('\n')}\n`,
    );
  });

  it('manager: none 的条目整条省略（python 探到"没装"不该出现在上下文里）', async () => {
    const body = await composeWith(habits({ version: 1, detected: DETECTED_SNAPSHOT }), [
      BASE_CONTEXT_TEMPLATE_ID,
      BASE_DEFAULT_TEMPLATE_ID,
    ]);
    expect(body).not.toContain('Python');
  });

  it('detected 为空 → 整节省略', async () => {
    const body = await composeWith(habits({ version: 1 }), [
      BASE_CONTEXT_TEMPLATE_ID,
      BASE_DEFAULT_TEMPLATE_ID,
    ]);
    expect(body).toBe('# AgentForge Rules\n');
  });

  it('脏 detected（类型不符 / 未知键）不抛错，当作没探到', () => {
    const view = buildTemplateView(
      habits({
        version: 1,
        detected: {
          node: 'fnm',
          java: { manager: 42 },
          package_managers: 'pnpm',
          monorepo: null,
          promote_notes: ['旧键，不参与 detected 渲染'],
        },
      }),
    );
    expect(view.detected).toEqual({
      runtimes: undefined,
      package_managers: undefined,
      monorepo: undefined,
      ci: undefined,
      has_any: false,
    });
  });

  it('package_managers 也接受裸字符串数组（手写 SoT 的常见形态）', () => {
    const view = buildTemplateView(
      habits({ version: 1, detected: { package_managers: ['pnpm', '', 'npm'] } }),
    );
    expect(view.detected.package_managers).toEqual(['pnpm', 'npm']);
    expect(view.detected.has_any).toBe(true);
  });
});

describe('resolver：opt-in 内置模板同样恒可用（§3.4 不依赖 SoT 文件）', () => {
  it.each([BASE_TOOLS_TEMPLATE_ID, BASE_CONTEXT_TEMPLATE_ID])('%s 无需落盘即可解析', async (id) => {
    const host = createFakeHost();
    const resolved = await resolveTemplate(id, {
      host,
      userSoTRoot: path.resolve('C:\\user\\.agentforge'),
      projectSoTRoot: path.resolve('C:\\proj\\.agentforge'),
      sources: async () => [],
    });
    expect(resolved.content).toBe(findBuiltinTemplate(id)?.content);
  });
});
