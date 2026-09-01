/**
 * mcp 单测（Spec §4.2 mcp.servers / §6 命令表）。
 *
 * 覆盖：validateMcpServer transport 条件依赖（stdio 需 command / http·sse 需
 * url）、addMcpServer 新增与同名 upsert、removeMcpServerLocked 摘除与其失败判据、
 * profile 往返、命令层 parseMcpServerJson 的 JSON 与 schema 校验。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMcpServerJson } from '../../../src/commands/assets';
import { loadProfile } from '../../../src/core/config/load';
import type { TargetLayer } from '../../../src/core/config/target-layer';
import {
  addMcpServer,
  removeMcpServerLocked,
  validateMcpServer,
} from '../../../src/core/sources/mcp';
import type { McpServerInput } from '../../../src/schema';
import { abs } from '../test-utils';
import { createDirAwareHost } from './helpers';

// 夹具走宿主平台语义：被测代码（mcp / config.load）用宿主 path.join 拼内存 fs 的
// 键，夹具必须同语义，否则 posix 上键错位（见 test-utils.abs）。
const USER_SOT = abs('user-sot');
const PROJECT_SOT = abs('proj', '.agentforge');

function projectLayer(): TargetLayer {
  return {
    scope: 'project',
    sotRoot: PROJECT_SOT,
    profileFile: path.join(PROJECT_SOT, 'profile.yaml'),
  };
}

describe('validateMcpServer', () => {
  it('stdio 缺 command → ConfigError(2)', () => {
    expect(() => validateMcpServer({ name: 'fs', transport: 'stdio' }, '')).toThrow(
      expect.objectContaining({ code: 2 }),
    );
    expect(() => validateMcpServer({ name: 'fs', transport: 'stdio', command: '' }, '')).toThrow(
      expect.objectContaining({ code: 2 }),
    );
  });

  it('http / sse 缺 url → ConfigError(2)', () => {
    expect(() => validateMcpServer({ name: 'a', transport: 'http' }, '')).toThrow(
      expect.objectContaining({ code: 2 }),
    );
    expect(() => validateMcpServer({ name: 'a', transport: 'sse', url: '' }, '')).toThrow(
      expect.objectContaining({ code: 2 }),
    );
  });

  it('字段齐备 → 通过', () => {
    expect(() =>
      validateMcpServer({ name: 'fs', transport: 'stdio', command: 'npx' }, ''),
    ).not.toThrow();
    expect(() =>
      validateMcpServer({ name: 'a', transport: 'http', url: 'https://x' }, ''),
    ).not.toThrow();
  });
});

describe('addMcpServer', () => {
  const stdioServer: McpServerInput = {
    name: 'fs',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-fs'],
    env: { FOO: 'bar' },
  };

  it('新条目写入 profile.mcp.servers（loadProfile 读回一致；profile 预存在时其他字段保留）', async () => {
    const host = createDirAwareHost();
    host.files.set(
      projectLayer().profileFile,
      'version: 1\ntargets: [claude]\ntemplates: [base/default]\n',
    );

    const result = await addMcpServer(host, projectLayer(), stdioServer);
    expect(result.replaced).toBe(false);
    // result 为 parse 后完整形态（enabled 默认值已填充）
    expect(result.server).toEqual({
      name: 'fs',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-fs'],
      env: { FOO: 'bar' },
    });
    expect(result.servers).toHaveLength(1);

    // 落盘为 input 原始形态（enabled 省略 = 默认 true，§4.2）
    const profile = await loadProfile(host, PROJECT_SOT);
    expect(profile?.targets).toEqual(['claude']);
    expect(profile?.templates).toEqual(['base/default']);
    expect(profile?.mcp?.servers).toEqual([
      {
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-fs'],
        env: { FOO: 'bar' },
      },
    ]);
  });

  it('同名 upsert：替换条目（replaced:true），总数不变', async () => {
    const host = createDirAwareHost();
    host.files.set(
      projectLayer().profileFile,
      [
        'version: 1',
        'targets: [claude]',
        'mcp:',
        '  servers:',
        '    - name: fs',
        '      transport: stdio',
        '      command: old-cmd',
        '',
      ].join('\n'),
    );

    const result = await addMcpServer(host, projectLayer(), stdioServer);
    expect(result.replaced).toBe(true);
    expect(result.servers).toHaveLength(1);
    expect((await loadProfile(host, PROJECT_SOT))?.mcp?.servers?.[0]?.command).toBe('npx');
  });

  it('不同名追加（多条共存）', async () => {
    const host = createDirAwareHost();
    host.files.set(projectLayer().profileFile, 'version: 1\ntargets: [claude]\n');
    await addMcpServer(host, projectLayer(), stdioServer);
    await addMcpServer(host, projectLayer(), { name: 'web', transport: 'http', url: 'https://x' });

    const servers = (await loadProfile(host, PROJECT_SOT))?.mcp?.servers ?? [];
    expect(servers.map((s) => s.name)).toEqual(['fs', 'web']);
  });

  it('profile 不存在 → 最小骨架创建后写入', async () => {
    const host = createDirAwareHost();
    await addMcpServer(host, projectLayer(), stdioServer);
    const profile = await loadProfile(host, PROJECT_SOT);
    expect(profile?.targets).toEqual(['opencode']);
    expect(profile?.mcp?.servers).toHaveLength(1);
  });

  it('transport 条件缺失在写入前拦截 → ConfigError(2)，profile 不被写坏', async () => {
    const host = createDirAwareHost();
    host.files.set(projectLayer().profileFile, 'version: 1\ntargets: [claude]\n');
    await expect(
      addMcpServer(host, projectLayer(), { name: 'bad', transport: 'stdio' }),
    ).rejects.toMatchObject({ code: 2 });
    // 原 profile 未被改写
    expect(await loadProfile(host, PROJECT_SOT)).toMatchObject({ targets: ['claude'] });
  });

  it('user 层 targetLayer：写 user 层 profile.yaml', async () => {
    const host = createDirAwareHost();
    const userLayer: TargetLayer = {
      scope: 'user',
      sotRoot: USER_SOT,
      profileFile: path.join(USER_SOT, 'profile.yaml'),
    };
    await addMcpServer(host, userLayer, stdioServer);
    expect((await loadProfile(host, USER_SOT))?.mcp?.servers).toHaveLength(1);
  });
});

describe('removeMcpServerLocked', () => {
  /** 两条 server 的已 init project 层（fs 为 raw YAML，走 input 原始形态）。 */
  function seedTwo(): ReturnType<typeof createDirAwareHost> {
    const host = createDirAwareHost();
    host.files.set(
      projectLayer().profileFile,
      [
        'version: 1',
        'targets: [claude]',
        'templates: [base/default]',
        'mcp:',
        '  servers:',
        '    - name: fs',
        '      transport: stdio',
        '      command: npx',
        '    - name: web',
        '      transport: http',
        '      url: https://x',
        '',
      ].join('\n'),
    );
    return host;
  }

  it('命中：摘掉该条，其余条目与其他字段保留', async () => {
    const host = seedTwo();

    const result = await removeMcpServerLocked(host, projectLayer(), 'fs');

    expect(result.removed.name).toBe('fs');
    expect(result.servers.map((s) => s.name)).toEqual(['web']);
    expect(result.profileFile).toBe(projectLayer().profileFile);
    const profile = await loadProfile(host, PROJECT_SOT);
    expect(profile?.mcp?.servers?.map((s) => s.name)).toEqual(['web']);
    expect(profile?.templates).toEqual(['base/default']);
  });

  it('removed 为移除前的条目且已填充默认值（enabled:true，与 add 的 server 同形态）', async () => {
    const host = seedTwo();

    const result = await removeMcpServerLocked(host, projectLayer(), 'fs');

    expect(result.removed).toEqual({
      name: 'fs',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
    });
  });

  it('移除最后一条 → servers 为空数组（profile 仍合法）', async () => {
    const host = createDirAwareHost();
    host.files.set(
      projectLayer().profileFile,
      [
        'version: 1',
        'targets: [claude]',
        'mcp:',
        '  servers:',
        '    - name: fs',
        '      transport: stdio',
        '      command: npx',
        '',
      ].join('\n'),
    );

    const result = await removeMcpServerLocked(host, projectLayer(), 'fs');

    expect(result.servers).toEqual([]);
    expect((await loadProfile(host, PROJECT_SOT))?.mcp?.servers).toEqual([]);
  });

  it('该层不存在该名字 → ConfigError(2)，profile 一字未改（消息带现有名单）', async () => {
    const host = seedTwo();
    const before = host.files.get(projectLayer().profileFile);

    await expect(removeMcpServerLocked(host, projectLayer(), 'nope')).rejects.toMatchObject({
      code: 2,
    });
    await expect(removeMcpServerLocked(host, projectLayer(), 'nope')).rejects.toThrow(/fs, web/);
    expect(host.files.get(projectLayer().profileFile)).toBe(before);
  });

  it('该层没有任何 server（mcp 字段缺失）→ ConfigError(2)，且不写盘', async () => {
    const host = createDirAwareHost();
    host.files.set(projectLayer().profileFile, 'version: 1\ntargets: [claude]\n');

    await expect(removeMcpServerLocked(host, projectLayer(), 'fs')).rejects.toMatchObject({
      code: 2,
    });
    expect(host.files.get(projectLayer().profileFile)).toBe('version: 1\ntargets: [claude]\n');
  });

  it('空白名 → ConfigError(2)，在读 profile 之前抛（profile 不存在也报同一码）', async () => {
    const host = createDirAwareHost();

    await expect(removeMcpServerLocked(host, projectLayer(), '   ')).rejects.toMatchObject({
      code: 2,
    });
    // 未走到 editProfileLocked → 不会为缺失的 profile 创建最小骨架
    expect(host.files.has(projectLayer().profileFile)).toBe(false);
  });

  it('profile.yaml 损坏 → ConfigError(2)', async () => {
    const host = createDirAwareHost();
    host.files.set(projectLayer().profileFile, 'version: 1\ntargets: [claude\n  bad: : :\n');

    await expect(removeMcpServerLocked(host, projectLayer(), 'fs')).rejects.toMatchObject({
      code: 2,
    });
  });

  it('user 层 targetLayer：只动 user 层 profile.yaml', async () => {
    const host = createDirAwareHost();
    const userLayer: TargetLayer = {
      scope: 'user',
      sotRoot: USER_SOT,
      profileFile: path.join(USER_SOT, 'profile.yaml'),
    };
    await addMcpServer(host, userLayer, { name: 'fs', transport: 'stdio', command: 'npx' });
    await addMcpServer(host, projectLayer(), { name: 'fs', transport: 'stdio', command: 'npx' });

    await removeMcpServerLocked(host, userLayer, 'fs');

    expect((await loadProfile(host, USER_SOT))?.mcp?.servers).toEqual([]);
    expect((await loadProfile(host, PROJECT_SOT))?.mcp?.servers).toHaveLength(1);
  });
});

describe('parseMcpServerJson（命令层 --from-json stdin 入口）', () => {
  it('合法 JSON → McpServerInput（enabled 由 zod 默认值填充）', () => {
    const server = parseMcpServerJson('{"name":"fs","transport":"stdio","command":"npx"}');
    expect(server).toEqual({ name: 'fs', enabled: true, transport: 'stdio', command: 'npx' });
  });

  it('非法 JSON → ConfigError(2)', () => {
    expect(() => parseMcpServerJson('{not json')).toThrow(expect.objectContaining({ code: 2 }));
  });

  it('缺必填字段（transport）→ ConfigError(2)', () => {
    expect(() => parseMcpServerJson('{"name":"fs"}')).toThrow(expect.objectContaining({ code: 2 }));
  });

  // 0.1.0 改名：输入标志 --json → --from-json（`--json` 归还 Spec §6.2 输出契约）。
  // 报错信息须指向新标志名，否则用户会照抄旧提示再次失败。
  it('报错信息使用 --from-json 而非 --json（Spec §6.2 语义不冲突）', () => {
    expect(() => parseMcpServerJson('{not json')).toThrow(/--from-json/);
    expect(() => parseMcpServerJson('{"name":"fs"}')).toThrow(/--from-json/);
  });
});
