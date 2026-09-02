/**
 * Commands 投影落点单测（Spec §8.8）：四个 target 各自的命令/prompt 文件目录、
 * project / user 两态、codex project scope 整项跳过，以及薄壳内容与
 * `renderCommandShell` 同源。
 *
 * 为什么单独成文件而不是塞进四个 projector 的 spec：§8.8 的价值在于「同一份
 * CommandArtifact 在四家落到不同目录名」这条横向约束（`commands` / `command` /
 * `prompts`），分散在四个文件里断言反而看不出差异，也容易改一处漏三处。
 * §8.8.2 的命名空间同理——claude / opencode 建子目录、pi / codex 拼文件名，
 * 这条差异也放在本文件里横向比对。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../../../../src/core/markers';
import { renderCommandShell } from '../../../../src/core/project/commands';
import { claudeCommandPath, claudeProjector } from '../../../../src/core/project/projectors/claude';
import { codexCommandPath, codexProjector } from '../../../../src/core/project/projectors/codex';
import {
  opencodeCommandPath,
  opencodeProjector,
} from '../../../../src/core/project/projectors/opencode';
import { piCommandPath, piProjector } from '../../../../src/core/project/projectors/pi';
import type { CommandArtifact, ProjectContext } from '../../../../src/core/project/types';
import { HabitsSchema, ProfileSchema } from '../../../../src/schema';

const REVIEW: CommandArtifact = { name: 'code-review', namespace: [], description: '审查改动' };
/** 带两级命名空间的同一技能（§8.8.2）。 */
const NESTED: CommandArtifact = { name: 'code-review', namespace: ['team', 'review'] };

function buildCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    os: { platform: 'win32' },
    scope: 'project',
    rootDir: 'C:\\proj',
    renderedRulesMd: '# AgentForge Rules\n',
    habits: HabitsSchema.parse({ version: 1 }),
    profile: ProfileSchema.parse({ version: 1, targets: ['claude'] }),
    skillsToMaterialize: [],
    commandsToExpose: [REVIEW],
    mcpServers: [],
    dryRun: false,
    lineEnding: 'lf',
    markerBegin: DEFAULT_MARKER_BEGIN,
    markerEnd: DEFAULT_MARKER_END,
    ...overrides,
  };
}

/** 计划中的命令项（按路径后缀识别；平铺名与扁平化后的名字都以 code-review 结尾）。 */
function commandItems(plan: { items: readonly { path: string; action: string }[] }) {
  return plan.items.filter((item) => item.path.endsWith('code-review.md'));
}

describe('claude commands（§8.5：.claude\\commands\\）', () => {
  it('project / user 两态路径', () => {
    expect(claudeCommandPath(buildCtx(), REVIEW)).toBe(
      'C:\\proj\\.claude\\commands\\code-review.md',
    );
    expect(claudeCommandPath(buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' }), REVIEW)).toBe(
      'C:\\Users\\u\\.claude\\commands\\code-review.md',
    );
  });

  it('命名空间 → 子目录（§8.8.2：/ns:name 由目录层级派生）', () => {
    expect(claudeCommandPath(buildCtx(), NESTED)).toBe(
      'C:\\proj\\.claude\\commands\\team\\review\\code-review.md',
    );
  });

  it('plan：write 项，内容与 renderCommandShell 同源（不复制技能正文）', () => {
    const items = commandItems(claudeProjector.plan(buildCtx()));
    expect(items).toEqual([
      {
        path: 'C:\\proj\\.claude\\commands\\code-review.md',
        action: 'write',
        content: renderCommandShell(REVIEW),
      },
    ]);
  });

  it('commandsToExpose 为空 → 不产出命令项', () => {
    expect(commandItems(claudeProjector.plan(buildCtx({ commandsToExpose: [] })))).toEqual([]);
  });
});

describe('opencode commands（§8.3：.opencode\\command\\ 单数）', () => {
  it('project / user 两态路径', () => {
    expect(opencodeCommandPath(buildCtx(), REVIEW)).toBe(
      'C:\\proj\\.opencode\\command\\code-review.md',
    );
    expect(opencodeCommandPath(buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' }), REVIEW)).toBe(
      'C:\\Users\\u\\.config\\opencode\\command\\code-review.md',
    );
  });

  it('命名空间 → 子目录（§8.8.2：/ns/name 由目录层级派生）', () => {
    expect(opencodeCommandPath(buildCtx(), NESTED)).toBe(
      'C:\\proj\\.opencode\\command\\team\\review\\code-review.md',
    );
  });

  it('plan：write 项，路径与 opencodeCommandPath 一致', () => {
    const ctx = buildCtx();
    expect(commandItems(opencodeProjector.plan(ctx))).toEqual([
      {
        path: opencodeCommandPath(ctx, REVIEW),
        action: 'write',
        content: renderCommandShell(REVIEW),
      },
    ]);
  });
});

describe('pi commands（§8.6：.pi\\prompts\\）', () => {
  it('project / user 两态路径', () => {
    expect(piCommandPath(buildCtx(), REVIEW)).toBe('C:\\proj\\.pi\\prompts\\code-review.md');
    expect(piCommandPath(buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' }), REVIEW)).toBe(
      'C:\\Users\\u\\.pi\\agent\\prompts\\code-review.md',
    );
  });

  it('命名空间 → 拼进文件名（§8.8.2 降级：prompts\\ 只扫一层）', () => {
    expect(piCommandPath(buildCtx(), NESTED)).toBe(
      'C:\\proj\\.pi\\prompts\\team-review-code-review.md',
    );
  });

  it('plan：命令项不标 soft（与 MCP 项不同——命令文件不依赖 pi-mcp-adapter）', () => {
    expect(commandItems(piProjector.plan(buildCtx()))).toEqual([
      {
        path: 'C:\\proj\\.pi\\prompts\\code-review.md',
        action: 'write',
        content: renderCommandShell(REVIEW),
      },
    ]);
  });
});

describe('codex commands（§8.4 / §8.8.4：只有 user scope 产出）', () => {
  it('project scope → 整项跳过（不写 %USERPROFILE%，避免项目级配置泄漏成全局）', () => {
    const ctx = buildCtx({ profile: ProfileSchema.parse({ version: 1, targets: ['codex'] }) });
    expect(commandItems(codexProjector.plan(ctx))).toEqual([]);
  });

  it('user scope → 落 <codexHome>\\prompts\\<name>.md', () => {
    const ctx = buildCtx({
      scope: 'user',
      rootDir: 'C:\\Users\\u',
      profile: ProfileSchema.parse({ version: 1, targets: ['codex'] }),
    });
    expect(codexCommandPath(ctx, REVIEW)).toBe('C:\\Users\\u\\.codex\\prompts\\code-review.md');
    expect(commandItems(codexProjector.plan(ctx))).toEqual([
      {
        path: 'C:\\Users\\u\\.codex\\prompts\\code-review.md',
        action: 'write',
        content: renderCommandShell(REVIEW),
      },
    ]);
  });

  it('命名空间 → 拼进文件名（§8.8.2：codex 无命名空间概念）', () => {
    const ctx = buildCtx({
      scope: 'user',
      rootDir: 'C:\\Users\\u',
      profile: ProfileSchema.parse({ version: 1, targets: ['codex'] }),
    });
    expect(codexCommandPath(ctx, NESTED)).toBe(
      'C:\\Users\\u\\.codex\\prompts\\team-review-code-review.md',
    );
  });

  it('user scope + CODEX_HOME → 命令目录随之改到覆盖目录', () => {
    const ctx = buildCtx({
      scope: 'user',
      rootDir: 'C:\\Users\\u',
      profile: ProfileSchema.parse({ version: 1, targets: ['codex'] }),
      env: {
        agfHome: undefined,
        agfScope: undefined,
        offline: false,
        lineEnding: undefined,
        ci: false,
        codexHome: 'D:\\codex',
        piCodingAgentDir: undefined,
        userProfile: 'C:\\Users\\u',
      },
    });
    expect(codexCommandPath(ctx, REVIEW)).toBe('D:\\codex\\prompts\\code-review.md');
  });
});
