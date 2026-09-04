/**
 * `adapters/<id>.yaml` 的 schema 契约（issue #53 安全边界 5 / 6）。
 *
 * 重点固化两条**不能放开**的取值域：
 * - `action` 只有 `write` / `merge_marker`（`merge_toml` 连字段都不存在）；
 * - `mcp.dialect` 是内置枚举（`mcpServers` / `opencode`），不接受自由字段映射。
 *
 * 其余为默认值与必填项：只有 `base` 必填（`skills_dir` 等四项缺省 = 不投影该类产物）、
 * 至少一个 scope、`mcp_file` 与 `mcp.dialect` 成对。
 */
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_ALLOWED_ACTIONS,
  ADAPTER_ID_PATTERN,
  type AdapterDocInput,
  AdapterSchema,
} from '../../../src/schema/adapter';

/** 最小可用声明（只有 user scope 的必填项）。 */
function minimal(overrides: Partial<AdapterDocInput> = {}): AdapterDocInput {
  return {
    version: 1,
    id: 'my-agent',
    scopes: { user: { base: '{userHome}/.my', skills_dir: '{base}/skills' } },
    ...overrides,
  } as AdapterDocInput;
}

describe('AdapterSchema — 默认值与必填项', () => {
  it('最小声明可解析，默认值齐备（prefix / toggle / action / namespace）', () => {
    const doc = AdapterSchema.parse(minimal());
    expect(doc.skill_invoke_prefix).toBe('/');
    expect(doc.main_rule).toEqual({ toggle: 'always', action: 'merge_marker' });
    expect(doc.commands).toEqual({ namespace: 'subdir' });
    expect(doc.mcp).toBeUndefined();
  });

  it('skills_dir 可缺省——「与 codex 并存时删掉它借道 .agents/skills/」得是合法配置', () => {
    const doc = AdapterSchema.parse(
      minimal({ scopes: { user: { base: '{userHome}/.my' } } } as never),
    );
    expect(doc.scopes.user?.skills_dir).toBeUndefined();
  });

  it('base 仍必填——说不出根目录的 scope 无处落盘', () => {
    expect(() =>
      AdapterSchema.parse(minimal({ scopes: { user: { skills_dir: '{userHome}/s' } } } as never)),
    ).toThrow();
  });

  it('两个 scope 都不声明 → 拒（不产出任何投影的 target 没有意义）', () => {
    expect(() => AdapterSchema.parse(minimal({ scopes: {} }))).toThrow(/至少要声明一个 scope/);
  });

  it('未知字段 → 拒（strict：拼错字段名不能静默失效）', () => {
    expect(() => AdapterSchema.parse(minimal({ hooks: true } as never))).toThrow();
    expect(() =>
      AdapterSchema.parse(
        minimal({
          scopes: { user: { base: '{userHome}/.my', skills_dir: '{base}/s', rules_dir: 'x' } },
        } as never),
      ),
    ).toThrow();
  });

  it('base 可以是候选数组（环境变量覆盖的表达方式），上限 4 个', () => {
    const doc = AdapterSchema.parse(
      minimal({
        scopes: {
          user: { base: ['{env:CODEX_HOME}', '{userHome}/.my'], skills_dir: '{base}/skills' },
        },
      }),
    );
    expect(doc.scopes.user?.base).toEqual(['{env:CODEX_HOME}', '{userHome}/.my']);
    expect(() =>
      AdapterSchema.parse(
        minimal({
          scopes: { user: { base: ['a', 'b', 'c', 'd', 'e'], skills_dir: '{base}/s' } },
        }),
      ),
    ).toThrow();
  });
});

describe('AdapterSchema — id 取值域（= 跨平台安全的文件名）', () => {
  it('小写字母 / 数字 / 连字符通过；大小写混用、下划线、点、首位连字符拒', () => {
    for (const id of ['a', 'my-agent', 'agent2', 'x'.repeat(32)]) {
      expect(ADAPTER_ID_PATTERN.test(id), id).toBe(true);
      expect(() => AdapterSchema.parse(minimal({ id }))).not.toThrow();
    }
    for (const id of ['My-Agent', 'my_agent', 'my.agent', '-agent', '', 'x'.repeat(33), 'a b']) {
      expect(ADAPTER_ID_PATTERN.test(id), id).toBe(false);
      expect(() => AdapterSchema.parse(minimal({ id })), id).toThrow();
    }
  });
});

describe('AdapterSchema — 安全边界 5：action 取值域不含 merge_toml', () => {
  it('允许动作集合恰为 write / merge_marker / merge_json', () => {
    expect(ADAPTER_ALLOWED_ACTIONS).toEqual(['write', 'merge_marker', 'merge_json']);
    expect(ADAPTER_ALLOWED_ACTIONS as readonly string[]).not.toContain('merge_toml');
  });

  it('main_rule.action 只接受 write / merge_marker', () => {
    for (const action of ['write', 'merge_marker']) {
      expect(() => AdapterSchema.parse(minimal({ main_rule: { action } as never }))).not.toThrow();
    }
    for (const action of ['merge_toml', 'merge_json', 'delete', 'exec']) {
      expect(
        () => AdapterSchema.parse(minimal({ main_rule: { action } as never })),
        action,
      ).toThrow();
    }
  });
});

describe('AdapterSchema — 安全边界 6：mcp.dialect 是内置枚举', () => {
  it('mcpServers / opencode 通过；自由映射或别的名字拒', () => {
    for (const dialect of ['mcpServers', 'opencode']) {
      const doc = AdapterSchema.parse(minimal({ mcp: { dialect } as never }));
      expect(doc.mcp).toEqual({ dialect, soft: false });
    }
    for (const dialect of ['codex', 'toml', 'custom', '']) {
      expect(() => AdapterSchema.parse(minimal({ mcp: { dialect } as never })), dialect).toThrow();
    }
  });

  it('mcp 下不接受自由字段映射（strict 挡住 fields / mapping 之类）', () => {
    expect(() =>
      AdapterSchema.parse(minimal({ mcp: { dialect: 'mcpServers', fields: {} } as never })),
    ).toThrow();
  });

  it('声明了 mcp_file 却没有顶层 mcp.dialect → 拒（只给落点无从决定 payload 形状）', () => {
    expect(() =>
      AdapterSchema.parse(
        minimal({
          scopes: {
            user: { base: '{userHome}/.my', skills_dir: '{base}/s', mcp_file: '{base}/mcp.json' },
          },
        }),
      ),
    ).toThrow(/没有顶层 mcp\.dialect/);
  });

  it('soft 只能是布尔（复用引擎既有语义，不能自定义"失败时怎么办"）', () => {
    expect(
      AdapterSchema.parse(minimal({ mcp: { dialect: 'opencode', soft: true } })).mcp?.soft,
    ).toBe(true);
    expect(() =>
      AdapterSchema.parse(minimal({ mcp: { dialect: 'opencode', soft: 'warn' } as never })),
    ).toThrow();
  });
});
