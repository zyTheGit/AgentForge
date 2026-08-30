/**
 * codex projector 单测（Spec §8.4 / §2.3 / §2.2）：plan 纯函数（路径 / 动作 /
 * tomlMarkers / CODEX_HOME 覆盖）、TOML 手写序列化（表块 / basic string 转义 /
 * inline table / 数组 / enabled 过滤）、skills write 项。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../../../../src/core/markers';
import {
  CODEX_MCP_TOML_BEGIN,
  CODEX_MCP_TOML_END,
  codexConfigPath,
  codexMainRulePath,
  codexProjector,
  codexSkillPath,
  serializeMcpServersToml,
  tomlBasicString,
} from '../../../../src/core/project/projectors/codex';
import type { ProjectContext } from '../../../../src/core/project/types';
import {
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

  it('plan 为纯函数：同一 ctx 多次调用结果一致，不改写 ctx', () => {
    const ctx = buildCtx();
    const first = codexProjector.plan(ctx);
    expect(codexProjector.plan(ctx)).toEqual(first);
    expect(ctx.renderedRulesMd).toBe('# AgentForge Rules\n- use fnm\n');
  });
});

describe('serializeMcpServersToml（[[mcp_servers.<name>]] 手写序列化）', () => {
  it('空 servers → 空字符串（标记段为空块，保留管理段声明）', () => {
    expect(serializeMcpServersToml([])).toBe('');
  });

  it('stdio → [[mcp_servers.fs]] + command / args 数组', () => {
    const toml = serializeMcpServersToml([stdioServer()]);
    expect(toml).toBe('[[mcp_servers.fs]]\ncommand = "npx"\nargs = ["-y", "server-fs"]');
  });

  it('stdio + env → env inline table', () => {
    const toml = serializeMcpServersToml([stdioServer({ env: { KEY: 'v', 'weird key': 'x' } })]);
    expect(toml).toContain('env = { KEY = "v", "weird key" = "x" }');
  });

  it('http → url + headers（inline table）', () => {
    const toml = serializeMcpServersToml([httpServer({ headers: { Authorization: 'Bearer x' } })]);
    expect(toml).toBe(
      '[[mcp_servers.docs]]\nurl = "https://example.com/mcp"\nheaders = { Authorization = "Bearer x" }',
    );
  });

  it('多个 server：表块之间以空行分隔', () => {
    const toml = serializeMcpServersToml([stdioServer(), httpServer()]);
    const blocks = toml.split('\n\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('[[mcp_servers.fs]]');
    expect(blocks[1]).toContain('[[mcp_servers.docs]]');
  });

  it('enabled=false 的 server 不投影', () => {
    const toml = serializeMcpServersToml([stdioServer({ enabled: false }), stdioServer()]);
    expect(toml).not.toContain('enabled');
    expect(toml).toBe('[[mcp_servers.fs]]\ncommand = "npx"\nargs = ["-y", "server-fs"]');
  });

  it('含点/空格的 server 名 → quoted key', () => {
    const toml = serializeMcpServersToml([stdioServer({ name: 'my.server x' })]);
    expect(toml).toContain('[[mcp_servers."my.server x"]]');
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
