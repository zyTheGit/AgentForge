/**
 * project/sync-prune 的纯函数单测（Spec §7.6）。
 *
 * 整条 prune 链路（删产物 / 摘 MCP 键 / 跳过手改文件）由集成用例覆盖
 * （tests/integration/learn-promote-sync.spec.ts）；这里只钉住三个纯计算的边界：
 * 记账口径（只收 write 项）、server 名口径（enabled=false 不算）、以及
 * stripServerKeys 的"只在管理键之下删、一个都没命中就不重写"。
 */
import { describe, expect, it } from 'vitest';
import type { PlannedTarget } from '../../../src/core/project/sync-prepare';
import {
  accountArtifacts,
  accountMcpServers,
  stripServerKeys,
} from '../../../src/core/project/sync-prune';
import type { ProjectContext, ProjectionPlanItem } from '../../../src/core/project/types';
import { sha256Hex } from '../../../src/infra/fsutil';

function plannedTarget(targetId: string, items: readonly ProjectionPlanItem[]): PlannedTarget {
  return {
    targetId,
    plan: { targetId, items },
    statuses: [],
    completed: true,
    started: true,
  };
}

describe('accountArtifacts（§7.6 记账口径）', () => {
  it('只收 action=write 的项，hash 由 item.content 算', () => {
    const artifacts = accountArtifacts([
      plannedTarget('claude', [
        { path: 'C:\\p\\CLAUDE.md', action: 'merge_marker', content: 'rules' },
        { path: 'C:\\p\\.mcp.json', action: 'merge_json', content: '{"mcpServers":{}}' },
        { path: 'C:\\p\\.claude\\skills\\pdf\\SKILL.md', action: 'write', content: '# pdf\n' },
      ]),
      plannedTarget('codex', [
        { path: 'C:\\p\\.codex\\config.toml', action: 'merge_toml', content: '' },
      ]),
    ]);

    // merge_* 的文件与用户内容共处，整文件删除永不成立 → 不进表
    expect(artifacts).toEqual([
      {
        path: 'C:\\p\\.claude\\skills\\pdf\\SKILL.md',
        contentHash: sha256Hex('# pdf\n'),
        targetId: 'claude',
      },
    ]);
  });

  it('无 write 项 → 空数组（不是 undefined，缺席语义留给 schema）', () => {
    expect(
      accountArtifacts([
        plannedTarget('claude', [
          { path: 'C:\\p\\CLAUDE.md', action: 'merge_marker', content: '' },
        ]),
      ]),
    ).toEqual([]);
  });
});

describe('accountMcpServers（口径与 merge_json 载荷同源）', () => {
  function ctxWith(servers: ProjectContext['mcpServers']): ProjectContext {
    return { mcpServers: servers } as ProjectContext;
  }

  it('enabled=false 不算投影过（与 enabledMcpServerNames 同一判据）', () => {
    const names = accountMcpServers(
      ctxWith([
        { name: 'ctx7', transport: 'stdio', command: 'npx' },
        { name: 'off', transport: 'stdio', command: 'npx', enabled: false },
      ]),
    );
    expect(names).toEqual(['ctx7']);
  });

  it('空 servers → 空数组', () => {
    expect(accountMcpServers(ctxWith([]))).toEqual([]);
  });
});

describe('stripServerKeys（只在管理键之下删）', () => {
  const CLAUDE_PAYLOAD = '{"mcpServers":{"ctx7":{"command":"npx"}}}';

  it('摘掉 stale server，其余键与用户自定义键逐字保留', () => {
    const existing = JSON.stringify(
      {
        mcpServers: { ctx7: { command: 'npx' }, jenkins: { command: 'node' } },
        myOwnKey: { keep: true },
      },
      null,
      2,
    );
    const result = stripServerKeys(existing, CLAUDE_PAYLOAD, ['jenkins']);

    expect(result?.removed).toEqual(['jenkins']);
    expect(JSON.parse(result?.text ?? '')).toEqual({
      mcpServers: { ctx7: { command: 'npx' } },
      myOwnKey: { keep: true },
    });
  });

  it('opencode 的载荷键是 mcp → 只动 mcp 之下（同名顶层键不受影响）', () => {
    const existing = JSON.stringify({ mcp: { jenkins: {} }, mcpServers: { jenkins: {} } });
    const result = stripServerKeys(existing, '{"mcp":{}}', ['jenkins']);

    expect(result?.removed).toEqual(['jenkins']);
    // mcpServers 不在 opencode 的管理载荷里 → 原样留着
    expect(JSON.parse(result?.text ?? '')).toEqual({ mcp: {}, mcpServers: { jenkins: {} } });
  });

  it('一个都没命中 → null（调用方据此不重写文件）', () => {
    const existing = JSON.stringify({ mcpServers: { ctx7: {} } });
    expect(stripServerKeys(existing, CLAUDE_PAYLOAD, ['jenkins'])).toBeNull();
  });

  it('顶层不是对象 → null（不猜结构，交由 §8.2 的合并路径报冲突）', () => {
    expect(stripServerKeys('[1,2]', CLAUDE_PAYLOAD, ['jenkins'])).toBeNull();
  });

  it('JSON 损坏 → 抛（调用方转成 prune skipped，绝不覆盖坏文件）', () => {
    expect(() => stripServerKeys('{ not json', CLAUDE_PAYLOAD, ['jenkins'])).toThrow();
  });
});
