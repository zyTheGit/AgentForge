/**
 * Commands 薄壳派生单测（Spec §8.8）：SKILL.md frontmatter 透传、薄壳渲染、
 * expose_as_command 子集校验（退出码 2）。
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, ExitCode } from '../../../src/core/errors';
import {
  parseSkillFrontmatter,
  renderCommandShell,
  resolveCommandsToExpose,
} from '../../../src/core/project/commands';
import type { SkillArtifact } from '../../../src/core/project/types';
import { ProfileSchema } from '../../../src/schema';

function skill(name: string, content: string): SkillArtifact {
  return { name, content };
}

describe('parseSkillFrontmatter（§8.8.1 透传白名单）', () => {
  it('取 description / argument-hint，其余键不透传', () => {
    const content = [
      '---',
      'name: code-review',
      'description: 审查改动',
      'argument-hint: "[commit]"',
      'allowed-tools: Bash(git diff:*)',
      '---',
      '',
      '# 正文',
      '',
    ].join('\n');
    expect(parseSkillFrontmatter(content)).toEqual({
      description: '审查改动',
      argumentHint: '[commit]',
    });
  });

  it('首行不是 --- → 视为无 frontmatter（不猜正文首段）', () => {
    expect(parseSkillFrontmatter('\n---\ndescription: x\n---\n')).toEqual({});
    expect(parseSkillFrontmatter('# 标题\n\ndescription: x\n')).toEqual({});
  });

  it('无结束分隔线 / YAML 损坏 / 顶层非映射 → 空对象（不阻断 sync）', () => {
    expect(parseSkillFrontmatter('---\ndescription: x\n')).toEqual({});
    expect(parseSkillFrontmatter('---\ndescription: "未闭合\n---\n')).toEqual({});
    expect(parseSkillFrontmatter('---\n- a\n- b\n---\n')).toEqual({});
  });

  it('非字符串 / 空白值不透传', () => {
    expect(parseSkillFrontmatter('---\ndescription: 42\nargument-hint: "   "\n---\n')).toEqual({});
  });

  it('CRLF 的 SKILL.md 也能解析（分隔线容忍 \\r 与行尾空白）', () => {
    const content = '---\r\ndescription: 审查改动\r\n---\r\n\r\n# 正文\r\n';
    expect(parseSkillFrontmatter(content)).toEqual({ description: '审查改动' });
  });
});

describe('renderCommandShell（§8.8 薄壳正文）', () => {
  it('正文只指向技能，不复制技能内容；参数占位为 $ARGUMENTS', () => {
    const out = renderCommandShell({ name: 'code-review' });
    expect(out).toBe('加载 `code-review` 技能，按其工作流执行。\n\n用户输入：$ARGUMENTS\n');
    expect(out.startsWith('---')).toBe(false);
  });

  it('两个透传键都写进 frontmatter', () => {
    const out = renderCommandShell({
      name: 'code-review',
      description: '审查改动',
      argumentHint: '[commit]',
    });
    expect(out).toBe(
      [
        '---',
        'description: 审查改动',
        'argument-hint: "[commit]"',
        '---',
        '',
        '加载 `code-review` 技能，按其工作流执行。',
        '',
        '用户输入：$ARGUMENTS',
        '',
      ].join('\n'),
    );
  });

  it('description 含 : / 引号 → 仍是合法 YAML（yaml.stringify 负责转义）', () => {
    const out = renderCommandShell({ name: 's', description: 'a: "b" #c' });
    expect(parseSkillFrontmatter(out).description).toBe('a: "b" #c');
  });
});

describe('resolveCommandsToExpose（§4.2 子集校验）', () => {
  const skills = [
    skill('code-review', '---\ndescription: 审查改动\n---\n\n# CR\n'),
    skill('tdd', '# TDD\n'),
  ];

  it('未声明 → 空清单（不产出任何命令项）', () => {
    const profile = ProfileSchema.parse({ version: 1, targets: ['claude'] });
    expect(resolveCommandsToExpose(profile, skills)).toEqual([]);
  });

  it('按声明顺序产出，元信息取自各自 SKILL.md 的 frontmatter', () => {
    const profile = ProfileSchema.parse({
      version: 1,
      targets: ['claude'],
      skills: { always: ['code-review', 'tdd'], expose_as_command: ['tdd', 'code-review'] },
    });
    expect(resolveCommandsToExpose(profile, skills)).toEqual([
      { name: 'tdd' },
      { name: 'code-review', description: '审查改动' },
    ]);
  });

  it('点名的 skill 不在已解析清单中 → ConfigError(2)，message 列出缺失名', () => {
    const profile = ProfileSchema.parse({
      version: 1,
      targets: ['claude'],
      skills: { always: ['code-review'], expose_as_command: ['code-review', 'nope'] },
    });
    try {
      resolveCommandsToExpose(profile, skills);
      expect.unreachable('应抛 ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe(ExitCode.Config);
      expect((err as Error).message).toContain('nope');
    }
  });
});
