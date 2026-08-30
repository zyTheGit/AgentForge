/**
 * Commands 薄壳派生单测（Spec §8.8）：SKILL.md frontmatter 透传、薄壳渲染、
 * expose_as_command 子集校验（退出码 2），以及 §8.8.2 的命名空间解析、扁平化降级、
 * `command-body` 的 `$1..$9` 占位符白名单。
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, ExitCode } from '../../../src/core/errors';
import {
  assertAllowedPlaceholders,
  commandCanonicalName,
  flattenCommandName,
  parseCommandEntry,
  parseSkillFrontmatter,
  renderCommandShell,
  resolveCommandsToExpose,
} from '../../../src/core/project/commands';
import type { SkillArtifact } from '../../../src/core/project/types';
import { ProfileSchema } from '../../../src/schema';

function skill(name: string, content: string): SkillArtifact {
  return { name, content };
}

/** 断言调用抛 ConfigError(2)，且 message 含给定片段。 */
function expectConfigError(fn: () => unknown, fragment: string): void {
  try {
    fn();
    expect.unreachable('应抛 ConfigError');
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe(ExitCode.Config);
    expect((err as Error).message).toContain(fragment);
  }
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
    const out = renderCommandShell({ name: 'code-review', namespace: [] });
    expect(out).toBe('加载 `code-review` 技能，按其工作流执行。\n\n用户输入：$ARGUMENTS\n');
    expect(out.startsWith('---')).toBe(false);
  });

  it('两个透传键都写进 frontmatter', () => {
    const out = renderCommandShell({
      name: 'code-review',
      namespace: [],
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
    const out = renderCommandShell({ name: 's', namespace: [], description: 'a: "b" #c' });
    expect(parseSkillFrontmatter(out).description).toBe('a: "b" #c');
  });

  it('给了 body → 用它替换内置模板（§8.8.2 位置参数）', () => {
    const out = renderCommandShell({
      name: 'code-review',
      namespace: ['review'],
      body: '审查 $1 分支上的 $2',
    });
    expect(out).toBe('审查 $1 分支上的 $2\n');
  });

  it('body 与 frontmatter 并存 → frontmatter 在前，正文用 body', () => {
    const out = renderCommandShell({
      name: 's',
      namespace: [],
      description: 'd',
      body: '只看 $1',
    });
    expect(out).toBe(['---', 'description: d', '---', '', '只看 $1', ''].join('\n'));
  });
});

describe('parseCommandEntry / 命名空间（§8.8.2）', () => {
  it('平铺名 → 空命名空间', () => {
    expect(parseCommandEntry('code-review')).toEqual({ namespace: [], name: 'code-review' });
  });

  it('多级前缀 → 最后一段是技能名', () => {
    expect(parseCommandEntry('team/review/code-review')).toEqual({
      namespace: ['team', 'review'],
      name: 'code-review',
    });
  });

  it('段首尾空白被裁掉（YAML 里手写空格不算错）', () => {
    expect(parseCommandEntry(' review / code-review ')).toEqual({
      namespace: ['review'],
      name: 'code-review',
    });
  });

  it.each([
    ['', '空字符串'],
    ['/code-review', '空段'],
    ['review//code-review', '空段'],
    ['code-review/', '空段'],
    ['../code-review', '目录树之外'],
    ['review/./code-review', '目录树之外'],
    ['re:view/code-review', '非法字符'],
    ['review\\code-review', '非法字符'],
  ])('非法条目 %s → ConfigError(2)', (entry, fragment) => {
    expectConfigError(() => parseCommandEntry(entry), fragment);
  });

  it('canonical 用 /，扁平化用 -（pi / codex 目录平铺）', () => {
    const parsed = parseCommandEntry('team/review/code-review');
    expect(commandCanonicalName(parsed)).toBe('team/review/code-review');
    expect(flattenCommandName(parsed)).toBe('team-review-code-review');
  });
});

describe('assertAllowedPlaceholders（§8.8.2 四家交集）', () => {
  it('$ARGUMENTS 与 $1..$9 通过', () => {
    expect(() => assertAllowedPlaceholders('$ARGUMENTS $1 $9 无占位符文本', 's')).not.toThrow();
  });

  it.each([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 被测的 pi 专有占位符字面量，不是模板插值
    '${1:-默认}',
    '$0',
    '$10',
    '$@',
    '$*',
    '$ARGS',
  ])('pi 专有 / 越界占位符 %s → ConfigError(2)', (token) => {
    expectConfigError(() => assertAllowedPlaceholders(`看 ${token}`, 'code-review'), token);
  });

  it('报错列出所有越界记号（去重）', () => {
    expectConfigError(() => assertAllowedPlaceholders('$0 $0 $@', 's'), '$0, $@');
  });
});

describe('resolveCommandsToExpose（§4.2 子集校验 / §8.8.2 命名空间）', () => {
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
      { name: 'tdd', namespace: [] },
      { name: 'code-review', namespace: [], description: '审查改动' },
    ]);
  });

  it('带命名空间的条目：技能名取最后一段，前缀进 namespace', () => {
    const profile = ProfileSchema.parse({
      version: 1,
      targets: ['claude'],
      skills: { always: ['code-review'], expose_as_command: ['team/review/code-review'] },
    });
    expect(resolveCommandsToExpose(profile, skills)).toEqual([
      { name: 'code-review', namespace: ['team', 'review'], description: '审查改动' },
    ]);
  });

  it('SKILL.md 的 command-body 被透传为正文', () => {
    const withBody = [
      skill('code-review', '---\ndescription: d\ncommand-body: 审查 $1 的 $2\n---\n\n# CR\n'),
    ];
    const profile = ProfileSchema.parse({
      version: 1,
      targets: ['claude'],
      skills: { always: ['code-review'], expose_as_command: ['code-review'] },
    });
    expect(resolveCommandsToExpose(profile, withBody)).toEqual([
      { name: 'code-review', namespace: [], description: 'd', body: '审查 $1 的 $2' },
    ]);
  });

  it('command-body 含 pi 专有占位符 → ConfigError(2)', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${1:-HEAD} 是被测的 pi 语法字面量，不是模板插值
    const withBody = [skill('code-review', '---\ncommand-body: "看 ${1:-HEAD}"\n---\n')];
    const profile = ProfileSchema.parse({
      version: 1,
      targets: ['claude'],
      skills: { always: ['code-review'], expose_as_command: ['code-review'] },
    });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 同上
    expectConfigError(() => resolveCommandsToExpose(profile, withBody), '${1:-HEAD}');
  });

  it('点名的 skill 不在已解析清单中 → ConfigError(2)，message 列出缺失名', () => {
    const profile = ProfileSchema.parse({
      version: 1,
      targets: ['claude'],
      skills: { always: ['code-review'], expose_as_command: ['code-review', 'nope'] },
    });
    expectConfigError(() => resolveCommandsToExpose(profile, skills), 'nope');
  });

  it('同一命令名声明两遍 → ConfigError(2)（后写的会覆盖前一份产物）', () => {
    const profile = ProfileSchema.parse({
      version: 1,
      targets: ['claude'],
      skills: {
        always: ['code-review'],
        expose_as_command: ['review/code-review', 'review/code-review'],
      },
    });
    expectConfigError(() => resolveCommandsToExpose(profile, skills), '重复命令名');
  });

  it('扁平化后撞车 → ConfigError(2)（pi / codex 下两条抢同一个文件）', () => {
    const skillsWithClash = [...skills, skill('review-code-review', '# x\n')];
    const profile = ProfileSchema.parse({
      version: 1,
      targets: ['pi'],
      skills: {
        always: ['code-review', 'review-code-review'],
        expose_as_command: ['review/code-review', 'review-code-review'],
      },
    });
    expectConfigError(
      () => resolveCommandsToExpose(profile, skillsWithClash),
      'review-code-review.md',
    );
  });
});
