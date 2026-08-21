/**
 * sync-meta 单测（Spec §3.3）：读取（不存在 / 正常 / 损坏 / 结构不符）与写入（往返 / 默认值 / 换行）。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/core/errors';
import {
  SYNC_META_FILE,
  readSyncMeta,
  syncMetaPath,
  writeSyncMeta,
} from '../../../src/core/project/sync-meta';
import { createFakeHost } from '../test-utils';

const ROOT = '/home/u/.agentforge';

describe('readSyncMeta', () => {
  it('文件不存在 → null', async () => {
    const host = createFakeHost();
    expect(await readSyncMeta(host, ROOT)).toBeNull();
  });

  it('正常读取：完整形态（默认值已填充）', async () => {
    const host = createFakeHost();
    await host.writeFile(
      syncMetaPath(ROOT),
      JSON.stringify({
        version: 1,
        lastSyncAt: '2026-08-21T10:00:00.000Z',
        os: 'win32',
        agentforgeVersion: '0.1.0',
        targets: {
          claude: {
            contentHash: 'a'.repeat(64),
            writtenAt: '2026-08-21T10:00:00.000Z',
          },
        },
      }),
    );
    const meta = await readSyncMeta(host, ROOT);
    expect(meta).not.toBeNull();
    expect(meta?.version).toBe(1);
    expect(meta?.os).toBe('win32');
    expect(meta?.targets.claude?.contentHash).toBe('a'.repeat(64));
  });

  it('JSON 语法损坏 → ConfigError(2)，hint 可操作', async () => {
    const host = createFakeHost();
    await host.writeFile(syncMetaPath(ROOT), '{ broken');
    const err = await readSyncMeta(host, ROOT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe(2);
    expect((err as ConfigError).hint).toBeTruthy();
  });

  it('结构不符（contentHash 非 hex64）→ ConfigError(2)', async () => {
    const host = createFakeHost();
    await host.writeFile(
      syncMetaPath(ROOT),
      JSON.stringify({
        version: 1,
        lastSyncAt: '2026-08-21T10:00:00.000Z',
        os: 'win32',
        agentforgeVersion: '0.1.0',
        targets: { claude: { contentHash: 'not-hex', writtenAt: '2026-08-21T10:00:00.000Z' } },
      }),
    );
    await expect(readSyncMeta(host, ROOT)).rejects.toThrow(/§3\.3|contentHash/);
  });

  it('os 非法枚举 → ConfigError(2)', async () => {
    const host = createFakeHost();
    await host.writeFile(
      syncMetaPath(ROOT),
      JSON.stringify({
        version: 1,
        lastSyncAt: '2026-08-21T10:00:00.000Z',
        os: 'sunos',
        agentforgeVersion: '0.1.0',
      }),
    );
    await expect(readSyncMeta(host, ROOT)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('writeSyncMeta', () => {
  it('写入并往返：targets 缺省 → 填充 {}（完整落盘形态）', async () => {
    const host = createFakeHost();
    await writeSyncMeta(host, ROOT, {
      version: 1,
      lastSyncAt: '2026-08-21T10:00:00.000Z',
      os: 'linux',
      agentforgeVersion: '0.1.0',
    });

    const text = host.files.get(syncMetaPath(ROOT)) as string;
    expect(text.endsWith('\n')).toBe(true);
    // 落盘文本显式含 targets: {}（读取方无需判空）
    expect(JSON.parse(text)).toEqual({
      version: 1,
      lastSyncAt: '2026-08-21T10:00:00.000Z',
      os: 'linux',
      agentforgeVersion: '0.1.0',
      targets: {},
    });

    const meta = await readSyncMeta(host, ROOT);
    expect(meta?.targets).toEqual({});
  });

  it('带 targets 记录往返一致', async () => {
    const host = createFakeHost();
    const hash = 'b'.repeat(64);
    await writeSyncMeta(host, ROOT, {
      version: 1,
      lastSyncAt: '2026-08-21T10:00:00.000Z',
      os: 'win32',
      agentforgeVersion: '0.1.0',
      targets: { claude: { contentHash: hash, writtenAt: '2026-08-21T10:00:00.000Z' } },
    });
    const meta = await readSyncMeta(host, ROOT);
    expect(meta?.targets.claude).toEqual({
      contentHash: hash,
      writtenAt: '2026-08-21T10:00:00.000Z',
    });
  });

  it('lineEnding=crlf → 落盘文本为 CRLF（Spec §2.5：JSON 按换行设置写出）', async () => {
    const host = createFakeHost();
    await writeSyncMeta(
      host,
      ROOT,
      {
        version: 1,
        lastSyncAt: '2026-08-21T10:00:00.000Z',
        os: 'win32',
        agentforgeVersion: '0.1.0',
      },
      'crlf',
    );
    const text = host.files.get(syncMetaPath(ROOT)) as string;
    expect(text).toContain('\r\n');
    expect(text).not.toMatch(/[^\r]\n/);
  });

  it('文件名常量与路径拼接', () => {
    expect(SYNC_META_FILE).toBe('sync-meta.json');
    expect(syncMetaPath(ROOT)).toBe(path.join(ROOT, 'sync-meta.json'));
  });
});
