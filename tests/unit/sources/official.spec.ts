/**
 * 默认注册源（官方模板源）单测（Spec §4.4 / §7.8 / §9 / §12 Phase 2）。
 *
 * 覆盖本特性的全部行为面，且**一条真网络请求都不发**（fake git 见 ./helpers）：
 * - 常量表与条目构造：显式 pin、默认禁用、播种时不编造 commit；
 * - 播种语义：`sources.json` 不存在才播种；已存在 → registry-exists；
 *   `remove` 之后再 `init` **不复活**（登记表的存在即墓碑）；
 * - enable/disable：翻位、幂等 no-op、老 SoT 的补登记（迁移路径）、disable 不补登记；
 * - 按需拉取：已就绪（有缓存 + 有 commit）→ 零 git 调用；AGF_OFFLINE / CI → 不联网且
 *   给可操作说明；拉取失败 → 降级为说明而不是抛错，且**清掉残留目录**；
 *   目录在但 commit 缺失（中途失败的存量残留）→ 重走完整 pin 序列；
 * - 源模板清单：有 manifest 以其为准，无 manifest 回落扫描 `templates\**.md`；
 * - doctor 的 `sources/default/official` 五态与 `sources/custom`（只读 fs、只 ok/warn）；
 * - status 的源一节（"登记了但不生效"必须可见；登记表读不出来 ≠ 没有登记）；
 * - bundle export/import 往返后登记状态与 pin 不漂移。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBundleExport, runBundleImport } from '../../../src/commands/knowledge';
import {
  collectStatusSources,
  formatStatusSources,
} from '../../../src/commands/lifecycle/status-sources';
import { checkDefaultSources } from '../../../src/core/doctor/check-sources';
import type { DoctorCheckResult } from '../../../src/core/doctor/check-types';
import type { EnvSnapshot } from '../../../src/core/env';
import { currentOs } from '../../../src/core/paths';
import {
  listSources,
  removeSource,
  type SourceManagerContext,
  sourceStoreDir,
} from '../../../src/core/sources/manager';
import {
  DEFAULT_SOURCES,
  defaultSourceEntry,
  findDefaultSource,
  isDefaultSourceId,
  OFFICIAL_TEMPLATES_SOURCE_ID,
  seedDefaultSources,
  setSourceEnabled,
} from '../../../src/core/sources/official';
import { listTemplates } from '../../../src/core/sources/template';
import type { Source } from '../../../src/schema';
import { VERSION } from '../../../src/version';
import { abs } from '../test-utils';
import { createDirAwareHost, type DirAwareHost } from './helpers';

const OS = currentOs();
// 夹具走宿主平台语义（被测代码用宿主 path.join 拼内存 fs 的键，见 test-utils.abs）
const USER_SOT = abs('user-sot');
const PROJECT_ROOT = abs('proj');
const PROJECT_SOT = path.join(PROJECT_ROOT, '.agentforge');
const SOURCES_JSON = path.join(USER_SOT, 'sources.json');

/** 官方源声明（常量表首项；断言里复用它的 url/ref，避免把字面量抄两遍）。 */
const OFFICIAL = DEFAULT_SOURCES[0];
if (OFFICIAL === undefined) {
  throw new Error('DEFAULT_SOURCES 至少应声明官方模板源');
}

function envFor(overrides: Partial<EnvSnapshot> = {}): EnvSnapshot {
  return {
    agfHome: USER_SOT,
    agfScope: undefined,
    offline: false,
    lineEnding: undefined,
    ci: false,
    codexHome: undefined,
    userProfile: abs('user'),
    ...overrides,
  };
}

function mgrCtx(host: DirAwareHost, envOverrides: Partial<EnvSnapshot> = {}): SourceManagerContext {
  return { host, env: envFor(envOverrides), userSoTRoot: USER_SOT, cwd: PROJECT_ROOT, os: OS };
}

function tplCtx(host: DirAwareHost, envOverrides: Partial<EnvSnapshot> = {}) {
  return {
    host,
    env: envFor(envOverrides),
    os: OS,
    cwd: PROJECT_ROOT,
    userSoTRoot: USER_SOT,
    projectSoTRoot: PROJECT_SOT,
    effectiveTemplates: [] as string[],
  };
}

/** 取官方源登记项（缺失 → 显式失败，失败信息可读）。 */
async function officialEntry(ctx: SourceManagerContext): Promise<Source> {
  const found = (await listSources(ctx)).find((s) => s.id === OFFICIAL_TEMPLATES_SOURCE_ID);
  expect(found).toBeDefined();
  if (found === undefined) {
    throw new Error('sources.json 应登记官方模板源');
  }
  return found;
}

// ---------------------------------------------------------------------------
// 常量表与条目构造
// ---------------------------------------------------------------------------

describe('DEFAULT_SOURCES / defaultSourceEntry', () => {
  it('官方源：显式 pin（非浮动 main）、kind=templates、默认禁用', () => {
    expect(OFFICIAL.id).toBe(OFFICIAL_TEMPLATES_SOURCE_ID);
    expect(OFFICIAL.enabledByDefault).toBe(false);
    expect(OFFICIAL.kind).toEqual(['templates']);
    expect(OFFICIAL.ref).not.toBe('main');
    expect(OFFICIAL.ref.trim()).not.toBe('');
  });

  it('条目形态为普通 git 源，且**不带 commit**（播种时还没 clone）', () => {
    const entry = defaultSourceEntry(OFFICIAL);
    expect(entry).toEqual({
      id: OFFICIAL.id,
      type: 'git',
      url: OFFICIAL.url,
      ref: OFFICIAL.ref,
      enabled: false,
      kind: ['templates'],
    });
    expect(entry.commit).toBeUndefined();
    // kind 是副本：调用方 push 不该污染常量表
    expect(entry.kind).not.toBe(OFFICIAL.kind);
  });

  it('enabled 可显式覆盖（enable 时补登记走这一支）', () => {
    expect(defaultSourceEntry(OFFICIAL, true).enabled).toBe(true);
  });

  it('pin 与 CLI 版本同源：ref 恒为 `v<package.json version>`', () => {
    // 常量表的 pin 与发行版本必须一起动。没有这条断言时，改了 package.json 的
    // version（或改了常量表的 ref）都不会有任何用例变红——本文件其余用例一律
    // 从 OFFICIAL.ref 取值，天然自洽。VERSION 由 scripts/gen-version.mjs 从
    // package.json 生成，CI 有 gen:version:check 卡住二者不漂移。
    expect(OFFICIAL.ref).toBe(`v${VERSION}`);
  });

  it('findDefaultSource / isDefaultSourceId 只认常量表里的 id', () => {
    expect(findDefaultSource(OFFICIAL_TEMPLATES_SOURCE_ID)).toBe(OFFICIAL);
    expect(findDefaultSource('vendor-src')).toBeUndefined();
    expect(isDefaultSourceId(OFFICIAL_TEMPLATES_SOURCE_ID)).toBe(true);
    expect(isDefaultSourceId('vendor-src')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 播种（init）
// ---------------------------------------------------------------------------

describe('seedDefaultSources', () => {
  it('登记表不存在 → 写入官方源（禁用态），且零 git 调用', async () => {
    const host = createDirAwareHost();
    const result = await seedDefaultSources(mgrCtx(host));

    expect(result.file).toBe(SOURCES_JSON);
    expect(result.registered).toEqual([OFFICIAL_TEMPLATES_SOURCE_ID]);
    expect(result.skipped).toBeNull();

    const entry = await officialEntry(mgrCtx(host));
    expect(entry).toMatchObject({ type: 'git', ref: OFFICIAL.ref, enabled: false });
    expect(host.gitCalls).toHaveLength(0);
    // store 下不该有任何东西：登记在先、内容后补
    expect(await host.exists(sourceStoreDir(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID))).toBe(
      false,
    );
  });

  it('登记表已存在 → skipped=registry-exists，不改一个字节（幂等）', async () => {
    const host = createDirAwareHost();
    await seedDefaultSources(mgrCtx(host));
    const before = host.files.get(SOURCES_JSON);

    const again = await seedDefaultSources(mgrCtx(host));
    expect(again.registered).toEqual([]);
    expect(again.skipped).toBe('registry-exists');
    expect(host.files.get(SOURCES_JSON)).toBe(before);
  });

  it('用户手动登记过别的源（老 SoT）→ 不追加官方源，用户的登记表不被改写', async () => {
    const host = createDirAwareHost();
    host.files.set(
      SOURCES_JSON,
      `${JSON.stringify({
        version: 1,
        sources: [{ id: 'vendor-src', type: 'local', path: abs('vendor') }],
      })}\n`,
    );
    const before = host.files.get(SOURCES_JSON);

    const result = await seedDefaultSources(mgrCtx(host));
    expect(result.skipped).toBe('registry-exists');
    expect(host.files.get(SOURCES_JSON)).toBe(before);
    expect((await listSources(mgrCtx(host))).map((s) => s.id)).toEqual(['vendor-src']);
  });

  it('remove 之后再播种 → **不复活**（登记表仍存在，内容为空数组）', async () => {
    const host = createDirAwareHost();
    await seedDefaultSources(mgrCtx(host));
    await removeSource(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID);
    expect(await listSources(mgrCtx(host))).toEqual([]);

    // 第二次 init（含在别的项目里跑的 project scope init：共享同一张 user 层登记表）
    const again = await seedDefaultSources(mgrCtx(host));
    expect(again.registered).toEqual([]);
    expect(again.skipped).toBe('registry-exists');
    expect(await listSources(mgrCtx(host))).toEqual([]);
  });

  it('禁用之后再播种 → 保持禁用（不被重置成"新装机"状态）', async () => {
    const host = createDirAwareHost();
    await seedDefaultSources(mgrCtx(host));
    await setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, true);
    await setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, false);

    await seedDefaultSources(mgrCtx(host));
    expect((await officialEntry(mgrCtx(host))).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

describe('setSourceEnabled', () => {
  it('已登记 → 翻 enabled 位并落盘（url/ref/commit 不动）', async () => {
    const host = createDirAwareHost();
    await seedDefaultSources(mgrCtx(host));

    const enabled = await setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, true);
    expect(enabled).toMatchObject({ changed: true, registered: false, file: SOURCES_JSON });
    expect(enabled.source).toMatchObject({ enabled: true, ref: OFFICIAL.ref, url: OFFICIAL.url });

    const disabled = await setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, false);
    expect(disabled.changed).toBe(true);
    expect((await officialEntry(mgrCtx(host))).enabled).toBe(false);
  });

  it('已是目标状态 → changed:false 且不写盘', async () => {
    const host = createDirAwareHost();
    await seedDefaultSources(mgrCtx(host));
    const before = host.files.get(SOURCES_JSON);

    const result = await setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, false);
    expect(result).toMatchObject({ changed: false, registered: false, file: SOURCES_JSON });
    expect(host.files.get(SOURCES_JSON)).toBe(before);
  });

  it('老 SoT（登记表存在但没有官方源）→ enable 按常量表补登记（迁移路径）', async () => {
    const host = createDirAwareHost();
    host.files.set(
      SOURCES_JSON,
      `${JSON.stringify({
        version: 1,
        sources: [{ id: 'vendor-src', type: 'local', path: abs('vendor') }],
      })}\n`,
    );

    const result = await setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, true);
    expect(result.registered).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.source).toMatchObject({
      id: OFFICIAL_TEMPLATES_SOURCE_ID,
      type: 'git',
      url: OFFICIAL.url,
      ref: OFFICIAL.ref,
      enabled: true,
    });
    // 补登记不动既有源，且不联网
    expect((await listSources(mgrCtx(host))).map((s) => s.id)).toEqual([
      'vendor-src',
      OFFICIAL_TEMPLATES_SOURCE_ID,
    ]);
    expect(host.gitCalls).toHaveLength(0);
  });

  it('未登记的默认项 disable → ConfigError(2)（不写一条用户没要求的禁用记录）', async () => {
    const host = createDirAwareHost();
    host.files.set(SOURCES_JSON, `${JSON.stringify({ version: 1, sources: [] })}\n`);

    await expect(
      setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, false),
    ).rejects.toMatchObject({ code: 2 });
    expect(await listSources(mgrCtx(host))).toEqual([]);
  });

  it('非默认项且未登记 → ConfigError(2)；非法 id 同样 2', async () => {
    const host = createDirAwareHost();
    await expect(setSourceEnabled(mgrCtx(host), 'ghost', true)).rejects.toMatchObject({ code: 2 });
    await expect(setSourceEnabled(mgrCtx(host), '../../evil', true)).rejects.toMatchObject({
      code: 2,
    });
  });

  it('禁用不删缓存（重新 enable 无需再联网）', async () => {
    const host = createDirAwareHost();
    await seedDefaultSources(mgrCtx(host));
    const cached = path.join(
      sourceStoreDir(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID),
      'templates',
      'base',
      'default.md',
    );
    host.files.set(cached, '# 官方模板\n');

    await setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, true);
    await setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, false);
    expect(host.files.has(cached)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 按需拉取（template list 是官方源真正被用到的时刻）
// ---------------------------------------------------------------------------

describe('listTemplates 对官方源的按需拉取', () => {
  /** 播种 + 启用官方源（登记态：有 ref、无 commit、无缓存）。 */
  async function enabledOfficial(host: DirAwareHost): Promise<void> {
    await seedDefaultSources(mgrCtx(host));
    await setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, true);
    host.gitCalls.length = 0;
  }

  it('默认（禁用态）→ 零 git 调用、零 warning，清单只有内置模板', async () => {
    const host = createDirAwareHost();
    await seedDefaultSources(mgrCtx(host));

    const result = await listTemplates(tplCtx(host));
    expect(result.items).toEqual([{ id: 'base/default', origin: 'builtin', enabled: false }]);
    expect(result.warnings).toEqual([]);
    expect(host.gitCalls).toHaveLength(0);
  });

  it('启用且无缓存 → 首次拉取（clone→fetch→checkout→rev-parse）并回写 commit', async () => {
    const host = createDirAwareHost();
    await enabledOfficial(host);

    const result = await listTemplates(tplCtx(host));
    expect(result.warnings).toEqual([]);
    expect(host.gitCalls.map((c) => c.args[0])).toEqual([
      'clone',
      'fetch',
      'checkout',
      'rev-parse',
    ]);
    expect(host.gitCalls[1]?.args).toEqual(['fetch', '--depth', '1', 'origin', OFFICIAL.ref]);
    expect((await officialEntry(mgrCtx(host))).commit).toBe('abc123def456');
  });

  it('已就绪（有缓存 + 登记项有 commit）→ 零 git 调用（绝大多数调用走这里）', async () => {
    const host = createDirAwareHost();
    await enabledOfficial(host);
    // 先走一次首次拉取把 commit 落定，再补一个缓存内文件（fake fs 无空目录概念）
    await listTemplates(tplCtx(host));
    host.files.set(
      path.join(sourceStoreDir(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID), '.git', 'HEAD'),
      'ref: v\n',
    );
    host.gitCalls.length = 0;

    const result = await listTemplates(tplCtx(host));
    expect(result.warnings).toEqual([]);
    expect(host.gitCalls).toHaveLength(0);
  });

  it('目录在但登记项没有 commit（中途失败的存量残留）→ 重新走完整 pin 序列', async () => {
    const host = createDirAwareHost();
    await enabledOfficial(host);
    // 模拟"clone 成功、fetch 失败"留下的残留：目录有内容，登记表无 commit
    const storeDir = sourceStoreDir(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID);
    host.files.set(path.join(storeDir, 'README.md'), '# 远端默认分支的内容\n');
    expect((await officialEntry(mgrCtx(host))).commit).toBeUndefined();

    await listTemplates(tplCtx(host));
    // 只判"目录存在"时这里会是 0 —— 那份未 pin 的内容会被永久当成缓存
    expect(host.gitCalls.map((c) => c.args[0])).toEqual([
      'clone',
      'fetch',
      'checkout',
      'rev-parse',
    ]);
    expect((await officialEntry(mgrCtx(host))).commit).toBe('abc123def456');
    // clonePinned 会先清掉残留目录
    expect(host.files.has(path.join(storeDir, 'README.md'))).toBe(false);
  });

  it('拉取中途失败（fetch）→ 清掉 clone 已落盘的内容，不留下未 pin 的缓存', async () => {
    const host = createDirAwareHost(
      {},
      { fetch: { stdout: '', stderr: 'fatal: ref 不存在', code: 128 } },
    );
    await enabledOfficial(host);
    const storeDir = sourceStoreDir(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID);
    // fake git 本身不落文件；让 clone 写一个文件，才能验证"失败后残留被清掉"
    // ——否则这条用例在没有 try/catch 的实现下也会绿。
    const passthrough = host.exec.bind(host);
    host.exec = async (cmd, args, opts) => {
      const result = await passthrough(cmd, args, opts);
      if (args[0] === 'clone') {
        host.files.set(path.join(storeDir, 'README.md'), '# 远端默认分支的内容\n');
      }
      return result;
    };

    const result = await listTemplates(tplCtx(host));
    expect(result.warnings[0]).toContain('首次拉取失败');
    expect(host.gitCalls.map((c) => c.args[0])).toEqual(['clone', 'fetch']);
    expect(await host.exists(storeDir)).toBe(false);
    expect((await officialEntry(mgrCtx(host))).commit).toBeUndefined();
  });

  it('源无 manifest.yaml → 回落扫描 store\\<id>\\templates\\**.md（否则清单一个都不新增）', async () => {
    const host = createDirAwareHost();
    await enabledOfficial(host);
    const storeDir = sourceStoreDir(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID);
    // 顺序要紧：clonePinned 会先清空 storeDir，故内容必须在首次拉取**之后**铺进去
    await listTemplates(tplCtx(host)); // 首次拉取落定 commit
    // 官方仓库当前的实际形态：有 templates/，没有 manifest.yaml
    host.files.set(path.join(storeDir, 'templates', 'base', 'default.md'), '# 官方 base\n');
    host.files.set(path.join(storeDir, 'templates', 'review.md'), '# 官方 review\n');
    host.gitCalls.length = 0;

    const result = await listTemplates(tplCtx(host));
    expect(result.warnings).toEqual([]);
    expect(host.gitCalls).toHaveLength(0);
    const fromSource = result.items.filter((i) => i.origin === 'source');
    expect(fromSource.map((i) => i.id)).toEqual(['base/default', 'review']);
    expect(fromSource.every((i) => i.sourceId === OFFICIAL_TEMPLATES_SOURCE_ID)).toBe(true);
  });

  it('源有 manifest.yaml → 以 manifest 声明为准（不叠加目录扫描）', async () => {
    const host = createDirAwareHost();
    await enabledOfficial(host);
    const storeDir = sourceStoreDir(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID);
    await listTemplates(tplCtx(host)); // 首次拉取落定 commit（会先清空 storeDir）
    host.files.set(
      path.join(storeDir, 'manifest.yaml'),
      [
        'name: official',
        'version: 1.0.0',
        'min_agentforge: 1',
        'templates:',
        '  - id: curated/one',
        '    path: templates/curated/one.md',
        '    description: 精选',
        '',
      ].join('\n'),
    );
    host.files.set(path.join(storeDir, 'templates', 'review.md'), '# 未登记进 manifest\n');
    host.gitCalls.length = 0;

    const result = await listTemplates(tplCtx(host));
    expect(result.items.filter((i) => i.origin === 'source')).toEqual([
      {
        id: 'curated/one',
        origin: 'source',
        sourceId: OFFICIAL_TEMPLATES_SOURCE_ID,
        description: '精选',
        enabled: false,
      },
    ]);
  });

  it('AGF_OFFLINE=1 → 不联网，降级为可操作说明（清单仍可用）', async () => {
    const host = createDirAwareHost({ AGF_OFFLINE: '1' });
    await enabledOfficial(host);

    const result = await listTemplates(tplCtx(host, { offline: true }));
    expect(host.gitCalls).toHaveLength(0);
    expect(result.items).toEqual([{ id: 'base/default', origin: 'builtin', enabled: false }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('AGF_OFFLINE');
    expect(result.warnings[0]).toContain(`aforge source update ${OFFICIAL_TEMPLATES_SOURCE_ID}`);
  });

  it('CI 为真 → 不自动联网，说明里给出显式命令', async () => {
    const host = createDirAwareHost({ CI: 'true' });
    await enabledOfficial(host);

    const result = await listTemplates(tplCtx(host, { ci: true }));
    expect(host.gitCalls).toHaveLength(0);
    expect(result.warnings[0]).toContain('CI');
    expect(result.warnings[0]).toContain(`aforge source update ${OFFICIAL_TEMPLATES_SOURCE_ID}`);
  });

  it('首次拉取失败 → 降级为说明而不是抛错（其余来源照常列出）', async () => {
    const host = createDirAwareHost(
      {},
      { clone: { stdout: '', stderr: 'fatal: 网络不可达', code: 128 } },
    );
    await enabledOfficial(host);
    host.files.set(path.join(PROJECT_SOT, 'templates', 'review.md'), '# 项目模板\n');

    const result = await listTemplates(tplCtx(host));
    expect(result.items.map((i) => i.id)).toEqual(['base/default', 'review']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('首次拉取失败');
  });
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

describe('checkDefaultSources（零网络、只 ok/warn）', () => {
  async function check(
    host: DirAwareHost,
    envOverrides: Partial<EnvSnapshot> = {},
    userSoTRoot: string = USER_SOT,
  ): Promise<DoctorCheckResult[]> {
    const results: DoctorCheckResult[] = [];
    await checkDefaultSources(host, results, envFor(envOverrides), OS, PROJECT_ROOT, userSoTRoot);
    return results;
  }

  /** 取指定 item（缺失 → 显式失败）。 */
  function itemOf(results: DoctorCheckResult[], item: string): DoctorCheckResult {
    const found = results.find((r) => r.item === item);
    if (found === undefined) {
      throw new Error(`未找到检查项 ${item}（现有：${results.map((r) => r.item).join(', ')}）`);
    }
    return found;
  }

  const OFFICIAL_ITEM = `sources/default/${OFFICIAL_TEMPLATES_SOURCE_ID}`;

  it('未登记（老 SoT / 已被 remove）→ ok + 启用命令，一条 git 都不发', async () => {
    const host = createDirAwareHost();
    const results = await check(host);
    const entry = itemOf(results, OFFICIAL_ITEM);
    expect(entry.level).toBe('ok');
    expect(entry.detail).toContain('未登记');
    expect(entry.hint).toContain(`aforge source enable ${OFFICIAL_TEMPLATES_SOURCE_ID}`);
    expect(host.gitCalls).toHaveLength(0);
  });

  it('已登记、禁用 → ok，说明"不联网、不进 template list"并给 pin', async () => {
    const host = createDirAwareHost();
    await seedDefaultSources(mgrCtx(host));
    const entry = itemOf(await check(host), OFFICIAL_ITEM);
    expect(entry.level).toBe('ok');
    expect(entry.detail).toContain('当前禁用');
    expect(entry.detail).toContain(OFFICIAL.ref);
  });

  it('已启用但无缓存 → warn（首次 template list 会拉；离线/CI 需显式 update）', async () => {
    const host = createDirAwareHost();
    await seedDefaultSources(mgrCtx(host));
    await setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, true);

    const entry = itemOf(await check(host), OFFICIAL_ITEM);
    expect(entry.level).toBe('warn');
    expect(entry.detail).toContain('尚未拉取');
    expect(entry.hint).toContain('AGF_OFFLINE=1');
  });

  it('已启用且缓存就绪 → ok，detail 含 pin 与 commit', async () => {
    const host = createDirAwareHost();
    await seedDefaultSources(mgrCtx(host));
    await setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, true);
    await listTemplates(tplCtx(host)); // 走一次首次拉取，回写 commit
    host.files.set(
      path.join(sourceStoreDir(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID), '.git', 'HEAD'),
      'ref: v\n',
    );

    const entry = itemOf(await check(host), OFFICIAL_ITEM);
    expect(entry.level).toBe('ok');
    expect(entry.detail).toContain(`${OFFICIAL.ref} @ abc123def456`);
  });

  it('缓存目录在但登记项无 commit → warn（不再谎报"缓存就绪"）', async () => {
    const host = createDirAwareHost();
    await seedDefaultSources(mgrCtx(host));
    await setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, true);
    host.files.set(
      path.join(sourceStoreDir(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID), 'README.md'),
      '# 中途失败的拉取残留\n',
    );

    const entry = itemOf(await check(host), OFFICIAL_ITEM);
    expect(entry.level).toBe('warn');
    expect(entry.detail).toContain('未记录 commit');
    expect(entry.hint).toContain(`aforge source update ${OFFICIAL_TEMPLATES_SOURCE_ID}`);
    expect(host.gitCalls).toHaveLength(0);
  });

  it('未登记且登记表不存在 → detail 点出"登记表尚不存在"（区分播种半成功与主动 remove）', async () => {
    const host = createDirAwareHost();
    const absent = itemOf(await check(host), OFFICIAL_ITEM);
    expect(absent.detail).toContain('登记表尚不存在');
    expect(absent.detail).toContain(SOURCES_JSON);

    // 登记表存在但没有该条目（remove 过 / 老 SoT）→ 另一句话
    host.files.set(SOURCES_JSON, `${JSON.stringify({ version: 1, sources: [] })}\n`);
    const removed = itemOf(await check(host), OFFICIAL_ITEM);
    expect(removed.detail).toContain('登记表已存在但无此条目');
    expect(removed.level).toBe('ok');
  });

  it('用户改过 pin → 仍是 ok，但点明"本机改写优先"', async () => {
    const host = createDirAwareHost();
    host.files.set(
      SOURCES_JSON,
      `${JSON.stringify({
        version: 1,
        sources: [
          {
            id: OFFICIAL_TEMPLATES_SOURCE_ID,
            type: 'git',
            url: OFFICIAL.url,
            ref: 'v9.9.9',
            enabled: false,
          },
        ],
      })}\n`,
    );
    const entry = itemOf(await check(host), OFFICIAL_ITEM);
    expect(entry.level).toBe('ok');
    expect(entry.detail).toContain('与内置声明不同');
  });

  it('登记表损坏 → warn（sources/registry）并指出文件路径，不抬退出码', async () => {
    const host = createDirAwareHost();
    host.files.set(SOURCES_JSON, '{ 坏 JSON');
    const results = await check(host);
    const entry = itemOf(results, 'sources/registry');
    expect(entry.level).toBe('warn');
    expect(entry.detail).toContain(SOURCES_JSON);
    expect(results.every((r) => r.level !== 'error')).toBe(true);
  });

  it('user 层根不可解析 → 单条 ok 说明，不重复报根因', async () => {
    // 直调而不走 check()：后者的 userSoTRoot 有默认值，显式传 undefined 会命中默认值
    const results: DoctorCheckResult[] = [];
    await checkDefaultSources(createDirAwareHost(), results, envFor(), OS, PROJECT_ROOT, undefined);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ item: 'sources/default', level: 'ok' });
  });

  it('sources/custom 只报个数（官方源不计入）', async () => {
    const host = createDirAwareHost();
    host.files.set(
      SOURCES_JSON,
      `${JSON.stringify({
        version: 1,
        sources: [
          defaultSourceEntry(OFFICIAL),
          { id: 'vendor-src', type: 'local', path: abs('vendor') },
        ],
      })}\n`,
    );
    const entry = itemOf(await check(host), 'sources/custom');
    expect(entry.detail).toContain('1 个自定义源');
    expect(entry.detail).toContain('vendor-src');
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('collectStatusSources / formatStatusSources', () => {
  it('禁用的官方源可见（official 标记 + disabled + pin），零 git 调用', async () => {
    const host = createDirAwareHost();
    await seedDefaultSources(mgrCtx(host));

    const report = await collectStatusSources(host, envFor(), OS, PROJECT_ROOT, USER_SOT);
    expect(report).toEqual({
      unreadable: false,
      sources: [
        {
          id: OFFICIAL_TEMPLATES_SOURCE_ID,
          type: 'git',
          enabled: false,
          ref: OFFICIAL.ref,
          commit: null,
          materialized: false,
          official: true,
        },
      ],
    });
    expect(host.gitCalls).toHaveLength(0);

    const text = formatStatusSources(report).join('\n');
    expect(text).toContain(`${OFFICIAL_TEMPLATES_SOURCE_ID} [official]  git  disabled`);
    expect(text).toContain(`pin ${OFFICIAL.ref}`);
  });

  it('启用但未拉取 → enabled, not fetched（"登记了但不生效"一眼可见）', async () => {
    const host = createDirAwareHost();
    await seedDefaultSources(mgrCtx(host));
    await setSourceEnabled(mgrCtx(host), OFFICIAL_TEMPLATES_SOURCE_ID, true);

    const report = await collectStatusSources(host, envFor(), OS, PROJECT_ROOT, USER_SOT);
    expect(report.sources[0]).toMatchObject({ enabled: true, materialized: false });
    expect(formatStatusSources(report).join('\n')).toContain('enabled, not fetched');
  });

  it('登记表损坏 → unreadable（不能与"没有登记"同形，否则用户以为自己真没登记过）', async () => {
    const broken = createDirAwareHost();
    broken.files.set(SOURCES_JSON, '{ 坏 JSON');

    const report = await collectStatusSources(broken, envFor(), OS, PROJECT_ROOT, USER_SOT);
    expect(report).toEqual({ sources: [], unreadable: true });
    const text = formatStatusSources(report).join('\n');
    expect(text).toContain('(unreadable - see aforge doctor)');
    expect(text).not.toContain('(none registered)');
  });

  it('user 根不可解析 / 登记表不存在 → 空表且非 unreadable', async () => {
    const host = createDirAwareHost();
    expect(await collectStatusSources(host, envFor(), OS, PROJECT_ROOT, null)).toEqual({
      sources: [],
      unreadable: false,
    });
    // 登记表尚未创建也算"空表"（loadSourcesFile 不存在 → 空数组，不抛错）
    expect(await collectStatusSources(host, envFor(), OS, PROJECT_ROOT, USER_SOT)).toEqual({
      sources: [],
      unreadable: false,
    });
    expect(formatStatusSources({ sources: [], unreadable: false }).join('\n')).toContain(
      '(none registered)',
    );
  });
});

// ---------------------------------------------------------------------------
// bundle 往返
// ---------------------------------------------------------------------------

describe('bundle export/import 往返', () => {
  const OUT_DIR = abs('out', 'bundle');
  const OTHER_ROOT = abs('proj2');
  const OTHER_SOT = path.join(OTHER_ROOT, '.agentforge');

  /**
   * 一份已 init 且播种过官方源的 SoT。
   *
   * 播种目标层显式指向 PROJECT_SOT：seedDefaultSources 写的是 ctx.userSoTRoot，
   * 而本用例要验证的是"这张登记表被 bundle 原样带走"，故让它落在被导出的那一层。
   */
  function seeded(): Promise<DirAwareHost> {
    const host = createDirAwareHost({ USERPROFILE: abs('home', 'u') });
    host.files.set(path.join(PROJECT_SOT, 'habits.yaml'), 'version: 1\n');
    host.files.set(path.join(PROJECT_SOT, 'profile.yaml'), 'version: 1\ntargets: [claude]\n');
    return seedDefaultSources({
      host,
      env: envFor(),
      userSoTRoot: PROJECT_SOT,
      cwd: PROJECT_ROOT,
      os: OS,
    }).then(() => host);
  }

  it('往返后官方源登记状态与 pin 逐字节不变，且不重复登记', async () => {
    const host = await seeded();
    const before = host.files.get(path.join(PROJECT_SOT, 'sources.json'));

    await runBundleExport({ host, cwd: PROJECT_ROOT, os: OS }, { out: OUT_DIR });
    const imported = await runBundleImport({ host, cwd: OTHER_ROOT, os: OS }, { from: OUT_DIR });

    expect(imported.manifest.files.map((f) => f.path)).toContain('sources.json');
    // 原文直拷（sources.json 不参与 redact / detected 裁剪）
    expect(host.files.get(path.join(OTHER_SOT, 'sources.json'))).toBe(before);

    const landed = await listSources({
      host,
      env: envFor(),
      userSoTRoot: OTHER_SOT,
      cwd: OTHER_ROOT,
      os: OS,
    });
    expect(landed).toEqual([defaultSourceEntry(OFFICIAL)]);
    expect(landed.filter((s) => s.id === OFFICIAL_TEMPLATES_SOURCE_ID)).toHaveLength(1);
  });

  it('store\\ 缓存不进 bundle（cache），换机后按需重拉', async () => {
    const host = await seeded();
    host.files.set(path.join(PROJECT_SOT, 'store', OFFICIAL_TEMPLATES_SOURCE_ID, 'a.md'), 'x\n');

    const result = await runBundleExport({ host, cwd: PROJECT_ROOT, os: OS }, { out: OUT_DIR });
    expect(result.manifest.excluded).toContainEqual({ path: 'store', reason: 'cache' });
  });
});
