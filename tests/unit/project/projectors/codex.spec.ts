/**
 * codex projector 单测（Spec §8.4 / §2.3 / §2.2）：plan 纯函数（路径 / 动作 /
 * tomlMarkers / CODEX_HOME 覆盖）、TOML 手写序列化（表块 / basic string 转义 /
 * inline table / 数组 / enabled 过滤）、skills write 项、§7.4 hook 档的钩子项。
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, GenericError } from '../../../../src/core/errors';
import { codexSessionHooksJson } from '../../../../src/core/learning/hook-capture';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../../../../src/core/markers';
import {
  CODEX_MCP_TOML_BEGIN,
  CODEX_MCP_TOML_END,
  CODEX_SKILL_ON_DEMAND_POLICY,
  codexConfigPath,
  codexHooksPath,
  codexMainRulePath,
  codexProjector,
  codexSkillPath,
  codexSkillPolicyPath,
  codexTomlHasInlineHooks,
  serializeMcpServersToml,
  tomlBasicString,
} from '../../../../src/core/project/projectors/codex';
import type { ProjectContext } from '../../../../src/core/project/types';
import {
  type AutoCapture,
  HabitsSchema,
  type McpServer,
  McpServerSchema,
  ProfileSchema,
} from '../../../../src/schema';

function buildCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    os: { platform: 'win32' },
    scope: 'project',
    rootDir: 'C:\\proj',
    renderedRulesMd: '# AgentForge Rules\n- use fnm\n',
    habits: HabitsSchema.parse({ version: 1 }),
    profile: ProfileSchema.parse({ version: 1, targets: ['codex'] }),
    skillsToMaterialize: [],
    commandsToExpose: [],
    mcpServers: [],
    dryRun: false,
    lineEnding: 'lf',
    markerBegin: DEFAULT_MARKER_BEGIN,
    markerEnd: DEFAULT_MARKER_END,
    ...overrides,
  };
}

/** 指定 auto_capture 档位的 ctx（§7.4 hook 档的钩子项判据）。 */
function buildCtxWithAutoCapture(
  autoCapture: AutoCapture,
  overrides: Partial<ProjectContext> = {},
): ProjectContext {
  return buildCtx({
    profile: ProfileSchema.parse({
      version: 1,
      targets: ['codex'],
      learning: { auto_capture: autoCapture },
    }),
    ...overrides,
  });
}

function stdioServer(overrides: Partial<McpServer> = {}): McpServer {
  return McpServerSchema.parse({
    name: 'fs',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'server-fs'],
    ...overrides,
  });
}

function httpServer(overrides: Partial<McpServer> = {}): McpServer {
  return McpServerSchema.parse({
    name: 'docs',
    transport: 'http',
    url: 'https://example.com/mcp',
    ...overrides,
  });
}

describe('codexProjector.plan（Spec §8.4 主规则 / MCP 标记段 / skills）', () => {
  it('project scope：主规则 = <root>\\AGENTS.md（merge_marker）；MCP = .codex\\config.toml（merge_toml + 专用标记段）', () => {
    const ctx = buildCtx();
    const plan = codexProjector.plan(ctx);
    expect(plan.targetId).toBe('codex');
    expect(plan.items).toEqual([
      {
        path: 'C:\\proj\\AGENTS.md',
        action: 'merge_marker',
        content: ctx.renderedRulesMd,
      },
      {
        path: 'C:\\proj\\.codex\\config.toml',
        action: 'merge_toml',
        content: '', // 空 servers → 空标记段正文
      },
    ]);
    expect(plan.tomlMarkers).toEqual({ begin: CODEX_MCP_TOML_BEGIN, end: CODEX_MCP_TOML_END });
    expect(CODEX_MCP_TOML_BEGIN).toBe('# BEGIN AGENTFORGE MCP');
    expect(CODEX_MCP_TOML_END).toBe('# END AGENTFORGE MCP');
  });

  it('user scope 无 CODEX_HOME：主规则与 config 均落 <home>\\.codex\\', () => {
    const ctx = buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' });
    const plan = codexProjector.plan(ctx);
    expect(plan.items[0]?.path).toBe('C:\\Users\\u\\.codex\\AGENTS.md');
    expect(plan.items[1]?.path).toBe('C:\\Users\\u\\.codex\\config.toml');
  });

  it('user scope + CODEX_HOME：全局根被覆盖（Spec §2.2 env 覆盖）', () => {
    const ctx = buildCtx({
      scope: 'user',
      rootDir: 'C:\\Users\\u',
      env: {
        agfHome: undefined,
        agfScope: undefined,
        offline: false,
        lineEnding: undefined,
        ci: false,
        codexHome: 'C:\\codexhome',
        userProfile: 'C:\\Users\\u',
      },
    });
    const plan = codexProjector.plan(ctx);
    expect(plan.items[0]?.path).toBe('C:\\codexhome\\AGENTS.md');
    expect(plan.items[1]?.path).toBe('C:\\codexhome\\config.toml');
  });

  it('CODEX_HOME 过统一守卫：UNC 直接拒绝（Issue #51 第 1 条）', () => {
    // PR #50 之后 hooks.json 与 config.toml 共用 codexConfigDir，而 hooks.json 是整文件
    // write——未校验的 CODEX_HOME 等于把一次整文件覆盖导向任意目录
    const ctx = buildCtx({
      scope: 'user',
      rootDir: 'C:\\Users\\u',
      env: {
        agfHome: undefined,
        agfScope: undefined,
        offline: false,
        lineEnding: undefined,
        ci: false,
        codexHome: '\\\\wsl.localhost\\Ubuntu\\home\\x\\.codex',
        userProfile: 'C:\\Users\\u',
      },
    });
    expect(() => codexProjector.plan(ctx)).toThrow(GenericError);
  });

  it('CODEX_HOME 写 posix 绝对路径（win32）→ ConfigError(2)，不静默补盘符', () => {
    const ctx = buildCtx({
      scope: 'user',
      rootDir: 'C:\\Users\\u',
      env: {
        agfHome: undefined,
        agfScope: undefined,
        offline: false,
        lineEnding: undefined,
        ci: false,
        codexHome: '/home/x/.codex',
        userProfile: 'C:\\Users\\u',
      },
    });
    expect(() => codexProjector.plan(ctx)).toThrow(ConfigError);
  });

  it('CODEX_HOME 的 `~` 展开（此前会落出字面名为 `~` 的目录）', () => {
    const ctx = buildCtx({
      scope: 'user',
      rootDir: 'C:\\Users\\u',
      env: {
        agfHome: undefined,
        agfScope: undefined,
        offline: false,
        lineEnding: undefined,
        ci: false,
        codexHome: '~/codex-alt',
        userProfile: 'C:\\Users\\u',
      },
    });
    expect(codexProjector.plan(ctx).items[0]?.path).toBe('C:\\Users\\u\\codex-alt\\AGENTS.md');
  });

  it('posix os：分隔符为 /（Spec §2.1 路径随平台）', () => {
    const ctx = buildCtx({ os: { platform: 'linux' }, rootDir: '/home/u/proj' });
    const plan = codexProjector.plan(ctx);
    expect(plan.items[0]?.path).toBe('/home/u/proj/AGENTS.md');
    expect(plan.items[1]?.path).toBe('/home/u/proj/.codex/config.toml');
  });

  it('skills：write 实体 copy 项落在 .agents\\skills\\<name>\\SKILL.md（project，Spec §2.3）', () => {
    const ctx = buildCtx({
      skillsToMaterialize: [
        { name: 'my-skill', content: '# My Skill\n' },
        { name: 'other', content: '# Other\n' },
      ],
    });
    const plan = codexProjector.plan(ctx);
    expect(plan.items[1]).toEqual({
      path: 'C:\\proj\\.agents\\skills\\my-skill\\SKILL.md',
      action: 'write',
      content: '# My Skill\n',
    });
    expect(plan.items[2]?.path).toBe('C:\\proj\\.agents\\skills\\other\\SKILL.md');
  });

  it('skills（user scope + CODEX_HOME）：落 CODEX_HOME\\skills\\<name>\\SKILL.md', () => {
    const ctx = buildCtx({
      scope: 'user',
      rootDir: 'C:\\Users\\u',
      env: {
        agfHome: undefined,
        agfScope: undefined,
        offline: false,
        lineEnding: undefined,
        ci: false,
        codexHome: 'C:\\codexhome',
        userProfile: 'C:\\Users\\u',
      },
      skillsToMaterialize: [{ name: 's1', content: 'x' }],
    });
    const plan = codexProjector.plan(ctx);
    expect(plan.items[1]?.path).toBe('C:\\codexhome\\skills\\s1\\SKILL.md');
  });

  it('on_demand 技能：SKILL.md 之后额外产出 agents\\openai.yaml sidecar（关闭隐式调用）', () => {
    const ctx = buildCtx({
      skillsToMaterialize: [
        { name: 'always-one', content: '# A\n' },
        { name: 'lazy', content: '# L\n', onDemand: true },
      ],
    });
    const plan = codexProjector.plan(ctx);
    // always 的技能不带 sidecar（产物形态与本功能之前完全一致）
    expect(plan.items[1]).toEqual({
      path: 'C:\\proj\\.agents\\skills\\always-one\\SKILL.md',
      action: 'write',
      content: '# A\n',
    });
    expect(plan.items[2]).toEqual({
      path: 'C:\\proj\\.agents\\skills\\lazy\\SKILL.md',
      action: 'write',
      content: '# L\n',
    });
    expect(plan.items[3]).toEqual({
      path: 'C:\\proj\\.agents\\skills\\lazy\\agents\\openai.yaml',
      action: 'write',
      content: CODEX_SKILL_ON_DEMAND_POLICY,
    });
    expect(CODEX_SKILL_ON_DEMAND_POLICY).toBe('policy:\n  allow_implicit_invocation: false\n');
    // sidecar 也是 write 项 → 自动进 §7.6 记账，迁回 always 时由 prune 删除
    expect(codexSkillPolicyPath(ctx, 'lazy')).toBe(plan.items[3]?.path);
  });

  it('plan 为纯函数：同一 ctx 多次调用结果一致，不改写 ctx', () => {
    const ctx = buildCtx();
    const first = codexProjector.plan(ctx);
    expect(codexProjector.plan(ctx)).toEqual(first);
    expect(ctx.renderedRulesMd).toBe('# AgentForge Rules\n- use fnm\n');
  });
});

describe('serializeMcpServersToml（[mcp_servers.<name>] 单表手写序列化）', () => {
  it('空 servers → 空字符串（标记段为空块，保留管理段声明）', () => {
    expect(serializeMcpServersToml([])).toBe('');
  });

  it('stdio → [mcp_servers.fs] + command / args 数组', () => {
    const toml = serializeMcpServersToml([stdioServer()]);
    expect(toml).toBe('[mcp_servers.fs]\ncommand = "npx"\nargs = ["-y", "server-fs"]');
  });

  it('stdio + env → env inline table', () => {
    const toml = serializeMcpServersToml([stdioServer({ env: { KEY: 'v', 'weird key': 'x' } })]);
    expect(toml).toContain('env = { KEY = "v", "weird key" = "x" }');
  });

  it('http → url + http_headers（codex 的 header 键名；写 headers 会被静默忽略）', () => {
    const toml = serializeMcpServersToml([httpServer({ headers: { Authorization: 'Bearer x' } })]);
    expect(toml).toBe(
      '[mcp_servers.docs]\nurl = "https://example.com/mcp"\nhttp_headers = { Authorization = "Bearer x" }',
    );
  });

  it('sse → 整条跳过（codex 只支持 STDIO 与 Streamable HTTP）', () => {
    const sse = McpServerSchema.parse({
      name: 'ev',
      transport: 'sse',
      url: 'https://example.com/sse',
    });
    expect(serializeMcpServersToml([sse])).toBe('');
    expect(serializeMcpServersToml([stdioServer(), sse])).toBe(
      '[mcp_servers.fs]\ncommand = "npx"\nargs = ["-y", "server-fs"]',
    );
  });

  it('多个 server：表块之间以空行分隔', () => {
    const toml = serializeMcpServersToml([stdioServer(), httpServer()]);
    const blocks = toml.split('\n\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('[mcp_servers.fs]');
    expect(blocks[1]).toContain('[mcp_servers.docs]');
  });

  it('enabled=false 的 server 不投影', () => {
    const toml = serializeMcpServersToml([stdioServer({ enabled: false }), stdioServer()]);
    expect(toml).not.toContain('enabled');
    expect(toml).toBe('[mcp_servers.fs]\ncommand = "npx"\nargs = ["-y", "server-fs"]');
  });

  it('含点/空格的 server 名 → quoted key', () => {
    const toml = serializeMcpServersToml([stdioServer({ name: 'my.server x' })]);
    expect(toml).toContain('[mcp_servers."my.server x"]');
  });

  it('command 中的特殊字符 → basic string 转义', () => {
    const toml = serializeMcpServersToml([stdioServer({ command: 'C:\\tools\\run "app"' })]);
    expect(toml).toContain('command = "C:\\\\tools\\\\run \\"app\\""');
  });
});

describe('tomlBasicString（basic string 转义子集）', () => {
  it('双引号与反斜杠转义', () => {
    expect(tomlBasicString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('控制字符转义（\\b \\t \\n \\f \\r 与 \\uXXXX）', () => {
    expect(tomlBasicString('x\ty\nz\br\fc\rd')).toBe('"x\\ty\\nz\\br\\fc\\rd"');
    expect(tomlBasicString('a\u0001b')).toBe('"a\\u0001b"');
    expect(tomlBasicString('a\u007fb')).toBe('"a\\u007fb"');
  });

  it('非 ASCII（中文等）原样输出', () => {
    expect(tomlBasicString('中文 测试')).toBe('"中文 测试"');
  });
});

describe('codex 路径函数（status/init 打印共用）', () => {
  it('codexMainRulePath / codexConfigPath 与 plan 产出的路径一致（project）', () => {
    const ctx = buildCtx({ os: { platform: 'linux' }, rootDir: '/proj' });
    const plan = codexProjector.plan(ctx);
    expect(codexMainRulePath(ctx)).toBe(plan.items[0]?.path);
    expect(codexConfigPath(ctx)).toBe(plan.items.at(-1)?.path);
  });

  it('codexMainRulePath：user 两态（默认 <home>\\.codex 与 CODEX_HOME 覆盖）', () => {
    const env = {
      agfHome: undefined,
      agfScope: undefined,
      offline: false,
      lineEnding: undefined,
      ci: false,
      codexHome: 'C:\\codexhome',
      userProfile: 'C:\\Users\\u',
    };
    expect(codexMainRulePath(buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' }))).toBe(
      'C:\\Users\\u\\.codex\\AGENTS.md',
    );
    expect(codexMainRulePath(buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u', env }))).toBe(
      'C:\\codexhome\\AGENTS.md',
    );
  });

  it('codexSkillPath：project / user 两态', () => {
    expect(codexSkillPath(buildCtx(), 's')).toBe('C:\\proj\\.agents\\skills\\s\\SKILL.md');
    expect(codexSkillPath(buildCtx({ scope: 'user', rootDir: 'C:\\Users\\u' }), 's')).toBe(
      'C:\\Users\\u\\.codex\\skills\\s\\SKILL.md',
    );
  });
});

describe('会话钩子项（§7.4 learning.auto_capture: hook / §12 Phase 3）', () => {
  it('hook 档：末位追加 .codex\\hooks.json（write 整文件），内容 = codexSessionHooksJson()', () => {
    const plan = codexProjector.plan(buildCtxWithAutoCapture('hook'));
    expect(plan.items.at(-1)).toEqual({
      path: 'C:\\proj\\.codex\\hooks.json',
      action: 'write',
      content: codexSessionHooksJson(),
    });
    // 独占文件 + write 动作 → 直接落进 §7.6 artifacts 记账，档位改回后被 prune 整文件删掉
    expect(plan.items.filter((item) => item.path.endsWith('hooks.json'))).toHaveLength(1);
  });

  it.each(['off', 'prompt'] as const)('%s 档：不产出任何钩子项', (autoCapture) => {
    const plan = codexProjector.plan(buildCtxWithAutoCapture(autoCapture));
    expect(plan.items.some((item) => item.path.endsWith('hooks.json'))).toBe(false);
    // 其余产物不受影响（主规则 + config.toml 两项）
    expect(plan.items).toHaveLength(2);
  });

  it('钩子项与 MCP 段落在同一个 config 层目录（codex 只在 config 层旁发现 hooks）', () => {
    const ctx = buildCtxWithAutoCapture('hook');
    const plan = codexProjector.plan(ctx);
    expect(codexHooksPath(ctx)).toBe('C:\\proj\\.codex\\hooks.json');
    expect(plan.items.at(-1)?.path).toBe(codexHooksPath(ctx));
    expect(codexConfigPath(ctx)).toBe('C:\\proj\\.codex\\config.toml');
  });

  it('user scope 无 CODEX_HOME：落 <home>\\.codex\\hooks.json', () => {
    const ctx = buildCtxWithAutoCapture('hook', { scope: 'user', rootDir: 'C:\\Users\\u' });
    expect(codexProjector.plan(ctx).items.at(-1)?.path).toBe('C:\\Users\\u\\.codex\\hooks.json');
  });

  it('user scope + CODEX_HOME：钩子跟着全局根被覆盖（Spec §2.2 env 覆盖）', () => {
    const ctx = buildCtxWithAutoCapture('hook', {
      scope: 'user',
      rootDir: 'C:\\Users\\u',
      env: {
        agfHome: undefined,
        agfScope: undefined,
        offline: false,
        lineEnding: undefined,
        ci: false,
        codexHome: 'C:\\codexhome',
        userProfile: 'C:\\Users\\u',
      },
    });
    expect(codexProjector.plan(ctx).items.at(-1)?.path).toBe('C:\\codexhome\\hooks.json');
  });

  it('posix os：分隔符随平台，但钩子**内容**逐字相同（产物与平台无关）', () => {
    const win = codexProjector.plan(buildCtxWithAutoCapture('hook'));
    const posix = codexProjector.plan(
      buildCtxWithAutoCapture('hook', { os: { platform: 'linux' }, rootDir: '/home/u/proj' }),
    );
    expect(posix.items.at(-1)?.path).toBe('/home/u/proj/.codex/hooks.json');
    expect(posix.items.at(-1)?.content).toBe(win.items.at(-1)?.content);
  });

  it('CI 环境不改变钩子产出（声明驱动，非探测驱动 → contentHash 跨环境稳定）', () => {
    const env = {
      agfHome: undefined,
      agfScope: undefined,
      offline: false,
      lineEnding: undefined,
      ci: true,
      codexHome: undefined,
      userProfile: undefined,
    };
    expect(codexProjector.plan(buildCtxWithAutoCapture('hook', { env }))).toEqual(
      codexProjector.plan(buildCtxWithAutoCapture('hook')),
    );
  });

  it('钩子产物不含任何本机路径（不写 execPath / 安装目录）', () => {
    const content =
      codexProjector.plan(buildCtxWithAutoCapture('hook')).items.at(-1)?.content ?? '';
    expect(content).not.toContain('C:\\');
    expect(content).not.toContain('proj');
    expect(content).not.toContain(process.execPath);
  });
});

describe('codexTomlHasInlineHooks（doctor 的同层并存判定，§7.4）', () => {
  it.each([
    '[hooks]\n',
    '  [hooks]\n',
    '[hooks.SessionStart]\nmatcher = "startup"\n',
    '[[hooks.SessionStart]]\n',
    'model = "gpt-5"\n\n[hooks]\n',
  ])('命中表头：%j', (toml) => {
    expect(codexTomlHasInlineHooks(toml)).toBe(true);
  });

  it.each([
    '',
    'model = "gpt-5"\n',
    '# [hooks] 之前配过，现已注释掉\n',
    '  # [hooks.SessionStart]\n',
    '[hooks_legacy]\n', // 前缀相同但不是 hooks 表
    'description = "see [hooks] docs"\n', // 值里出现方括号不算表头
  ])('不命中：%j', (toml) => {
    expect(codexTomlHasInlineHooks(toml)).toBe(false);
  });
});
