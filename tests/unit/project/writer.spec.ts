/**
 * writer 单测（Spec §8.1 / §8.2 / §2.5）：四种投影动作 + dryRunItem + 权限错误映射。
 * 全部用 fake host（内存 fs）——真实 IO 路径由集成测试覆盖。
 */
import { describe, expect, it } from 'vitest';
import { ConflictError, GenericError, PermissionError } from '../../../src/core/errors';
import { DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END } from '../../../src/core/markers';
import type { ProjectionPlanItem } from '../../../src/core/project/types';
import {
  applyItem,
  DEFAULT_PROJECTION_MARKERS,
  dryRunItem,
  mergeJsonContent,
} from '../../../src/core/project/writer';
import type { Host } from '../../../src/infra/host';
import { createFakeHost, errnoError } from '../test-utils';

const B = DEFAULT_MARKER_BEGIN;
const E = DEFAULT_MARKER_END;

/** 跨平台安全的绝对路径构造（win32 / posix host 下均可作 Map 键）。 */
const p = (...segments: string[]): string =>
  [process.platform === 'win32' ? 'C:' : '', ...segments].join(
    process.platform === 'win32' ? '\\' : '/',
  );

describe('applyItem — write', () => {
  it('写入新文件（LF）且内容原样', async () => {
    const host = createFakeHost();
    const target = p('proj', 'AGENTS.md');
    await applyItem(host, { path: target, action: 'write', content: '# rules\n' }, 'lf');
    expect(host.files.get(target)).toBe('# rules\n');
  });

  it('换行按 lineEnding=crlf 展开（Spec §2.5）', async () => {
    const host = createFakeHost();
    const target = p('proj', 'AGENTS.md');
    await applyItem(host, { path: target, action: 'write', content: '# a\n- b\n' }, 'crlf');
    expect(host.files.get(target)).toBe('# a\r\n- b\r\n');
  });

  it('覆盖已有文件（整体替换）', async () => {
    const host = createFakeHost();
    const target = p('proj', 'AGENTS.md');
    await host.writeFile(target, 'old\n');
    await applyItem(host, { path: target, action: 'write', content: 'new\n' }, 'lf');
    expect(host.files.get(target)).toBe('new\n');
  });
});

describe('applyItem — merge_marker', () => {
  it('目标不存在 → 新建为 marker 包裹块（含尾换行）', async () => {
    const host = createFakeHost();
    const target = p('proj', 'CLAUDE.md');
    await applyItem(host, { path: target, action: 'merge_marker', content: '# Rules\n' }, 'lf');
    expect(host.files.get(target)).toBe(`${B}\n# Rules\n${E}\n`);
  });

  it('marker 外用户内容原样保留（Spec §8.2）', async () => {
    const host = createFakeHost();
    const target = p('proj', 'CLAUDE.md');
    await host.writeFile(target, `# 用户手写标题\n\n${B}\nold\n${E}\n\n尾部说明\n`);
    await applyItem(host, { path: target, action: 'merge_marker', content: 'new rules\n' }, 'lf');
    expect(host.files.get(target)).toBe(`# 用户手写标题\n\n${B}\nnew rules\n${E}\n\n尾部说明\n`);
  });

  it('无 marker 的现有文件 → EOF 追加块，原内容保留', async () => {
    const host = createFakeHost();
    const target = p('proj', 'CLAUDE.md');
    await host.writeFile(target, '# user doc\n');
    await applyItem(host, { path: target, action: 'merge_marker', content: 'rules' }, 'lf');
    expect(host.files.get(target)).toBe(`# user doc\n${B}\nrules\n${E}\n`);
  });

  it('幂等：同一内容应用两次结果逐字节一致', async () => {
    const host = createFakeHost();
    const target = p('proj', 'CLAUDE.md');
    const item: ProjectionPlanItem = { path: target, action: 'merge_marker', content: 'rules\n' };
    await applyItem(host, item, 'lf');
    const once = host.files.get(target);
    await applyItem(host, item, 'lf');
    expect(host.files.get(target)).toBe(once);
  });

  it('自定义 marker（profile.projection.marker_begin/end）生效', async () => {
    const host = createFakeHost();
    const target = p('proj', 'CLAUDE.md');
    await applyItem(host, { path: target, action: 'merge_marker', content: 'x' }, 'lf', {
      ...DEFAULT_PROJECTION_MARKERS,
      begin: '<!-- AF-S -->',
      end: '<!-- AF-E -->',
    });
    expect(host.files.get(target)).toBe('<!-- AF-S -->\nx\n<!-- AF-E -->\n');
  });

  it('现有文件含 CRLF → 全文按 lineEnding 统一（Spec §2.5：整个文件按换行设置写出）', async () => {
    const host = createFakeHost();
    const target = p('proj', 'CLAUDE.md');
    await host.writeFile(target, `head\r\n${B}\r\nold\r\n${E}\r\ntail`);
    await applyItem(host, { path: target, action: 'merge_marker', content: 'new' }, 'lf');
    expect(host.files.get(target)).toBe(`head\n${B}\nnew\n${E}\ntail`);
    // lineEnding=crlf → 全文 CRLF
    await applyItem(host, { path: target, action: 'merge_marker', content: 'new' }, 'crlf');
    expect(host.files.get(target)).toBe(`head\r\n${B}\r\nnew\r\n${E}\r\ntail`);
  });
});

describe('applyItem — merge_json', () => {
  it('目标不存在 → 以管理键为全文（2 空格缩进 + 末尾换行）', async () => {
    const host = createFakeHost();
    const target = p('proj', '.mcp.json');
    await applyItem(
      host,
      { path: target, action: 'merge_json', content: '{"mcpServers":{"a":{"enabled":true}}}' },
      'lf',
    );
    expect(host.files.get(target)).toBe(
      '{\n  "mcpServers": {\n    "a": {\n      "enabled": true\n    }\n  }\n}\n',
    );
  });

  it('未知键保留、管理键覆盖（Spec §8.2）', async () => {
    const host = createFakeHost();
    const target = p('proj', '.mcp.json');
    await host.writeFile(target, '{"userKey": 1, "mcpServers": {"old": {"command": "x"}}}');
    await applyItem(
      host,
      { path: target, action: 'merge_json', content: '{"mcpServers":{"new":{"command":"y"}}}' },
      'lf',
    );
    const parsed = JSON.parse(host.files.get(target) as string) as Record<string, unknown>;
    expect(parsed.userKey).toBe(1);
    expect(parsed.mcpServers).toEqual({
      old: { command: 'x' },
      new: { command: 'y' },
    });
  });

  it('对象深合并（嵌套键递归）、数组整体替换', async () => {
    const host = createFakeHost();
    const target = p('proj', '.mcp.json');
    await host.writeFile(target, '{"a": {"x": 1, "keep": true}, "list": [1, 2]}');
    await applyItem(
      host,
      { path: target, action: 'merge_json', content: '{"a": {"x": 2}, "list": [9]}' },
      'lf',
    );
    const parsed = JSON.parse(host.files.get(target) as string) as Record<string, unknown>;
    expect(parsed.a).toEqual({ x: 2, keep: true });
    expect(parsed.list).toEqual([9]);
  });

  it('现有文件损坏 → ConflictError(3)，不覆盖文件', async () => {
    const host = createFakeHost();
    const target = p('proj', '.mcp.json');
    await host.writeFile(target, '{ broken');
    await expect(
      applyItem(host, { path: target, action: 'merge_json', content: '{"a":1}' }, 'lf'),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(host.files.get(target)).toBe('{ broken');
  });

  it('现有文件顶层非对象 → ConflictError(3)', async () => {
    const host = createFakeHost();
    const target = p('proj', '.mcp.json');
    await host.writeFile(target, '[1, 2]');
    await expect(
      applyItem(host, { path: target, action: 'merge_json', content: '{"a":1}' }, 'lf'),
    ).rejects.toThrow(/顶层不是对象/);
  });

  it('载荷非法（坏 JSON / 非对象）→ GenericError(1)（内部错误）', () => {
    expect(() => mergeJsonContent('', 'not json', 'f.json')).toThrow(GenericError);
    expect(() => mergeJsonContent('', '[1]', 'f.json')).toThrow(GenericError);
  });
});

describe('applyItem — merge_toml', () => {
  const TB = '# BEGIN AGENTFORGE';
  const TE = '# END AGENTFORGE';

  it('目标不存在 → 新建为标记段', async () => {
    const host = createFakeHost();
    const target = p('proj', '.codex', 'config.toml');
    await applyItem(host, { path: target, action: 'merge_toml', content: 'key = "v"\n' }, 'lf');
    expect(host.files.get(target)).toBe(`${TB}\nkey = "v"\n${TE}\n`);
  });

  it('标记段外的用户 TOML 保留，段内替换（Spec §8.4 / §8.2）', async () => {
    const host = createFakeHost();
    const target = p('proj', '.codex', 'config.toml');
    await host.writeFile(target, `user_setting = 1\n\n${TB}\nold = "x"\n${TE}\n\n# tail\n`);
    await applyItem(host, { path: target, action: 'merge_toml', content: 'new = "y"' }, 'lf');
    expect(host.files.get(target)).toBe(`user_setting = 1\n\n${TB}\nnew = "y"\n${TE}\n\n# tail\n`);
  });

  it('自定义 TOML 标记段前缀（M8 codex MCP 变体）', async () => {
    const host = createFakeHost();
    const target = p('proj', 'config.toml');
    await applyItem(host, { path: target, action: 'merge_toml', content: 'x = 1' }, 'lf', {
      ...DEFAULT_PROJECTION_MARKERS,
      tomlBegin: '# BEGIN AGENTFORGE MCP',
      tomlEnd: '# END AGENTFORGE MCP',
    });
    expect(host.files.get(target)).toBe('# BEGIN AGENTFORGE MCP\nx = 1\n# END AGENTFORGE MCP\n');
  });

  it('默认标记不误命中 MCP 变体段：`# BEGIN AGENTFORGE` 与 `# BEGIN AGENTFORGE MCP` 互不干扰', async () => {
    // 默认 TOML 标记是 MCP 变体的字面量前缀，但 markers 行锚定（`^<marker>[ \t]*$`）后
    // 不会命中更长的那一行；两个段各自独立替换，互不吞并。
    const host = createFakeHost();
    const target = p('proj', 'config.toml');
    const mcpMarkers = {
      ...DEFAULT_PROJECTION_MARKERS,
      tomlBegin: '# BEGIN AGENTFORGE MCP',
      tomlEnd: '# END AGENTFORGE MCP',
    };
    // 先写入 MCP 变体段
    await applyItem(
      host,
      { path: target, action: 'merge_toml', content: 'mcp = 1' },
      'lf',
      mcpMarkers,
    );
    // 再用默认标记写入：MCP 段原样保留，默认段追加在 EOF
    await applyItem(host, { path: target, action: 'merge_toml', content: 'plain = 2' }, 'lf');
    expect(host.files.get(target)).toBe(
      `# BEGIN AGENTFORGE MCP\nmcp = 1\n# END AGENTFORGE MCP\n${TB}\nplain = 2\n${TE}\n`,
    );

    // 反向：再次以 MCP 标记替换，只动 MCP 段
    await applyItem(
      host,
      { path: target, action: 'merge_toml', content: 'mcp = 9' },
      'lf',
      mcpMarkers,
    );
    expect(host.files.get(target)).toBe(
      `# BEGIN AGENTFORGE MCP\nmcp = 9\n# END AGENTFORGE MCP\n${TB}\nplain = 2\n${TE}\n`,
    );
  });
});

describe('applyItem — 渲染正文含 marker 字面量 → ConflictError(3)（Spec §8.2）', () => {
  it('merge_marker：正文含 END marker → 抛错且不落盘（避免自我嵌套区间逐次累积）', async () => {
    const host = createFakeHost();
    const target = p('proj', 'CLAUDE.md');
    await host.writeFile(target, `# 用户标题\n${B}\nold\n${E}\n尾部\n`);
    await expect(
      applyItem(
        host,
        { path: target, action: 'merge_marker', content: `rules\n${E}\n伪造尾部\n` },
        'lf',
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    // 现有文件保持原样
    expect(host.files.get(target)).toBe(`# 用户标题\n${B}\nold\n${E}\n尾部\n`);
  });

  it('错误信息点名 marker 与目标文件（来源上下文取 item.path）', async () => {
    const host = createFakeHost();
    const target = p('proj', 'AGENTS.md');
    try {
      await applyItem(
        host,
        { path: target, action: 'merge_marker', content: `${B}\n嵌套\n` },
        'lf',
      );
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      const e = err as ConflictError;
      expect(e.code).toBe(3);
      expect(e.message).toContain(B);
      expect(e.message).toContain(target);
    }
  });

  it('merge_toml：正文含 TOML 标记 → ConflictError(3)', async () => {
    const host = createFakeHost();
    const target = p('proj', 'config.toml');
    await expect(
      applyItem(
        host,
        { path: target, action: 'merge_toml', content: `x = 1\n# END AGENTFORGE\n` },
        'lf',
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(host.files.has(target)).toBe(false);
  });

  it('write 动作不受守卫约束（整文件覆盖，不涉及 marker 区间）', async () => {
    const host = createFakeHost();
    const target = p('proj', 'RULES.md');
    await applyItem(host, { path: target, action: 'write', content: `${B}\nx\n${E}\n` }, 'lf');
    expect(host.files.get(target)).toBe(`${B}\nx\n${E}\n`);
  });
});

describe('applyItem — 权限错误映射', () => {
  it('读现有文件遇 EACCES → PermissionError(4)', async () => {
    const base = createFakeHost();
    const failing: Host = {
      ...base,
      readFile: async (file) => {
        throw errnoError('EACCES', `permission denied: ${file}`);
      },
    };
    const target = p('proj', 'CLAUDE.md');
    await base.writeFile(target, 'old\n');
    await expect(
      applyItem(failing, { path: target, action: 'merge_marker', content: 'new' }, 'lf'),
    ).rejects.toBeInstanceOf(PermissionError);
  });
});

describe('applyItem — marker_mode 分派（Spec §4.2 projection.marker_mode）', () => {
  const item = (target: string, content: string): ProjectionPlanItem => ({
    path: target,
    action: 'merge_marker',
    content,
  });

  it('mode 缺省 → 与 replace_between_markers 完全一致（历史默认行为不变）', async () => {
    const host = createFakeHost();
    const a = p('proj', 'a.md');
    const b = p('proj', 'b.md');
    await host.writeFile(a, `head\n${B}\nold\n${E}\ntail\n`);
    await host.writeFile(b, `head\n${B}\nold\n${E}\ntail\n`);
    await applyItem(host, item(a, 'new\n'), 'lf');
    await applyItem(host, item(b, 'new\n'), 'lf', {
      ...DEFAULT_PROJECTION_MARKERS,
      mode: 'replace_between_markers',
    });
    expect(host.files.get(a)).toBe(`head\n${B}\nnew\n${E}\ntail\n`);
    expect(host.files.get(b)).toBe(host.files.get(a));
  });

  it('append_below_marker：新正文插在 marker_begin 之后，原区间内容保留在其后', async () => {
    const host = createFakeHost();
    const target = p('proj', 'CLAUDE.md');
    await host.writeFile(target, `head\n${B}\nold rules\n${E}\ntail\n`);
    await applyItem(host, item(target, 'new rules\n'), 'lf', {
      ...DEFAULT_PROJECTION_MARKERS,
      mode: 'append_below_marker',
    });
    expect(host.files.get(target)).toBe(`head\n${B}\nnew rules\n\nold rules\n${E}\ntail\n`);
  });

  it('append_below_marker 幂等：同一正文再 sync 不重复追加（区间不会无界增长）', async () => {
    const host = createFakeHost();
    const target = p('proj', 'CLAUDE.md');
    const markers = { ...DEFAULT_PROJECTION_MARKERS, mode: 'append_below_marker' as const };
    await host.writeFile(target, `head\n${B}\nold rules\n${E}\n`);
    await applyItem(host, item(target, 'new rules\n'), 'lf', markers);
    const once = host.files.get(target);
    await applyItem(host, item(target, 'new rules\n'), 'lf', markers);
    expect(host.files.get(target)).toBe(once);
  });

  it('append_below_marker：文件尚无 marker → 退化为建段（等同 replace 分支）', async () => {
    const host = createFakeHost();
    const target = p('proj', 'CLAUDE.md');
    await host.writeFile(target, '# user doc\n');
    await applyItem(host, item(target, 'rules'), 'lf', {
      ...DEFAULT_PROJECTION_MARKERS,
      mode: 'append_below_marker',
    });
    expect(host.files.get(target)).toBe(`# user doc\n${B}\nrules\n${E}\n`);
  });

  it('none：不做 marker 包裹，整文件写出（marker 外的用户内容被覆盖——契约如此）', async () => {
    const host = createFakeHost();
    const target = p('proj', 'CLAUDE.md');
    await host.writeFile(target, `head\n${B}\nold\n${E}\ntail\n`);
    await applyItem(host, item(target, '# only rules\n'), 'lf', {
      ...DEFAULT_PROJECTION_MARKERS,
      mode: 'none',
    });
    expect(host.files.get(target)).toBe('# only rules\n');
  });

  it('none：正文含 marker 字面量也不再抛 ConflictError（无区间可被自我嵌套）', async () => {
    const host = createFakeHost();
    const target = p('proj', 'CLAUDE.md');
    await applyItem(host, item(target, `${B}\nx\n${E}\n`), 'lf', {
      ...DEFAULT_PROJECTION_MARKERS,
      mode: 'none',
    });
    expect(host.files.get(target)).toBe(`${B}\nx\n${E}\n`);
  });
});

describe('dryRunItem', () => {
  it('四种动作的描述（含绝对路径，不落盘）', () => {
    expect(dryRunItem({ path: 'C:\\a\\AGENTS.md', action: 'write', content: '' })).toBe(
      'write: C:\\a\\AGENTS.md',
    );
    expect(dryRunItem({ path: 'C:\\a\\CLAUDE.md', action: 'merge_marker', content: '' })).toBe(
      'merge (marker): C:\\a\\CLAUDE.md',
    );
    expect(dryRunItem({ path: 'C:\\a\\.mcp.json', action: 'merge_json', content: '' })).toBe(
      'merge (json): C:\\a\\.mcp.json',
    );
    expect(dryRunItem({ path: 'C:\\a\\c.toml', action: 'merge_toml', content: '' })).toBe(
      'merge (toml): C:\\a\\c.toml',
    );
  });
});
