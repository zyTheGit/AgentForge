/**
 * projectors/shared 单测：四个 projector 共享的 skills 约定。
 *
 * skillDocPath 只负责 `<skillsRoot>/<name>/SKILL.md` 的末两段拼装；平台分隔符
 * 由传入的 pathApi 决定（Spec §2.1）。同时断言四个 projector 的 skill 路径
 * 与该函数一致（提取后行为不变的护栏）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../../../../src/core/markers';
import { pathApiFor } from '../../../../src/core/paths';
import { claudeSkillPath } from '../../../../src/core/project/projectors/claude';
import { codexSkillPath } from '../../../../src/core/project/projectors/codex';
import { opencodeSkillPath } from '../../../../src/core/project/projectors/opencode';
import { piSkillPath } from '../../../../src/core/project/projectors/pi';
import {
  SKILL_DOC_FILENAME,
  SKILLS_DIRNAME,
  skillDocPath,
} from '../../../../src/core/project/projectors/shared';
import type { ProjectContext } from '../../../../src/core/project/types';
import { HabitsSchema, ProfileSchema } from '../../../../src/schema';

function buildCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    os: { platform: 'win32' },
    scope: 'project',
    rootDir: 'C:\\proj',
    renderedRulesMd: '',
    habits: HabitsSchema.parse({ version: 1 }),
    profile: ProfileSchema.parse({ version: 1, targets: ['claude'] }),
    skillsToMaterialize: [],
    commandsToExpose: [],
    mcpServers: [],
    dryRun: true,
    lineEnding: 'lf',
    markerBegin: DEFAULT_MARKER_BEGIN,
    markerEnd: DEFAULT_MARKER_END,
    ...overrides,
  };
}

describe('shared skills 常量（单一声明）', () => {
  it('目录名与文件名', () => {
    expect(SKILLS_DIRNAME).toBe('skills');
    expect(SKILL_DOC_FILENAME).toBe('SKILL.md');
  });
});

describe('skillDocPath', () => {
  it('win32：反斜杠拼接 <skillsRoot>\\<name>\\SKILL.md', () => {
    expect(skillDocPath(pathApiFor({ platform: 'win32' }), 'C:\\proj\\.claude\\skills', 'a')).toBe(
      'C:\\proj\\.claude\\skills\\a\\SKILL.md',
    );
  });

  it('posix：正斜杠拼接（Spec §2.1 路径随注入平台）', () => {
    expect(skillDocPath(pathApiFor({ platform: 'linux' }), '/home/u/.claude/skills', 'a')).toBe(
      '/home/u/.claude/skills/a/SKILL.md',
    );
  });

  it('skill 名中的点号与连字符原样保留（不做归一化）', () => {
    expect(skillDocPath(pathApiFor({ platform: 'linux' }), '/r/skills', 'my-skill.v2')).toBe(
      '/r/skills/my-skill.v2/SKILL.md',
    );
  });
});

describe('四个 projector 的 skill 路径与 skillDocPath 一致', () => {
  const cases: ReadonlyArray<
    readonly [string, (ctx: ProjectContext, name: string) => string, string]
  > = [
    ['claude', claudeSkillPath, 'C:\\proj\\.claude\\skills'],
    ['codex', codexSkillPath, 'C:\\proj\\.agents\\skills'],
    ['opencode', opencodeSkillPath, 'C:\\proj\\.opencode\\skills'],
    ['pi', piSkillPath, 'C:\\proj\\.pi\\skills'],
  ];

  for (const [id, fn, skillsRoot] of cases) {
    it(`${id}：project scope skills 根 = ${skillsRoot}`, () => {
      const api = pathApiFor({ platform: 'win32' });
      expect(fn(buildCtx(), 'demo')).toBe(skillDocPath(api, skillsRoot, 'demo'));
    });
  }
});
