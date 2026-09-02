/**
 * 整文件 `write` 项的冲突预检查单测（sync-verify.assertNoWriteConflicts，fake host）。
 *
 * 被守的缺口：`write` 是整文件替换，而 marker 预检查只看 `merge_marker` 项、§7.6 prune
 * 的「改过的不删」只作用于上一轮 `artifacts` 里已有的路径 —— 于是一条 `write` 项**第一次
 * 进记账**时，落点上用户手写的同名文件会被静默换掉（`learning.auto_capture: hook` 首次投出
 * `.codex\hooks.json` 是最容易撞上的一例）。
 *
 * 用 codex + `hook` 档取 `hooks.json` 这条 `write` 项做被测对象，同时覆盖三条豁免：
 * 路径已记账 / 老版本 sync-meta 无 `artifacts` 表 / 磁盘内容已等于将写入的内容。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEnv } from '../../../src/core/env';
import { ConflictError } from '../../../src/core/errors';
import { codexSessionHooksJson } from '../../../src/core/learning/hook-capture';
import { currentOs } from '../../../src/core/paths';
import { syncOnce } from '../../../src/core/project/engine';
import { syncMetaPath } from '../../../src/core/project/sync-meta';
import { createFakeHost, type FakeHost } from '../test-utils';

const OS = currentOs();
const HOME = path.resolve('/home/u');
const CWD = path.resolve('/proj');
const PROJECT_SOT = path.join(CWD, '.agentforge');
const HOOKS_JSON = path.join(CWD, '.codex', 'hooks.json');

const HABITS_YAML = 'version: 1\n';
/** 用户手写的 hooks.json（codex 支持的合法配置，与 AgentForge 的产物不同）。 */
const USER_HOOKS_JSON = '{\n  "hooks": {\n    "SessionEnd": []\n  }\n}\n';

function profileYaml(autoCapture: 'off' | 'hook'): string {
  return `version: 1\nscope: project\ntargets: [codex]\nlearning:\n  auto_capture: ${autoCapture}\n`;
}

async function seedSoT(host: FakeHost, autoCapture: 'off' | 'hook'): Promise<void> {
  await host.writeFile(path.join(PROJECT_SOT, 'profile.yaml'), profileYaml(autoCapture));
  await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
}

function syncOptions(host: FakeHost, overrides: Record<string, unknown> = {}) {
  return {
    host,
    env: readEnv(host),
    os: OS,
    cwd: CWD,
    agentforgeVersion: 'test-0.1.0',
    dryRun: false,
    ...overrides,
  };
}

/** 把 sync-meta 退化成「老版本」形态：删掉 §7.6 的 artifacts 记账表。 */
function dropArtifactsLedger(host: FakeHost): void {
  const file = syncMetaPath(PROJECT_SOT);
  const meta = JSON.parse(host.files.get(file) as string) as Record<string, unknown>;
  delete meta.artifacts;
  host.files.set(file, JSON.stringify(meta, null, 2));
}

describe('整文件 write 项的冲突预检查（§7.6 / §8.2-4）', () => {
  it('首次进 hook 档：落点已有用户手写文件 → ConflictError(3)，列出路径', async () => {
    const host = createFakeHost({ USERPROFILE: HOME });
    await seedSoT(host, 'off');
    await syncOnce(syncOptions(host)); // 先建立记账（此时还没有 hooks.json 这一项）
    await host.writeFile(HOOKS_JSON, USER_HOOKS_JSON);
    await seedSoT(host, 'hook');

    const err = await syncOnce(syncOptions(host)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    const conflict = err as ConflictError;
    expect(conflict.code).toBe(3);
    expect(conflict.hint).toContain('--force');
    expect((conflict.details as { conflicts: string[] }).conflicts).toContain(HOOKS_JSON);
    // 预检查在备份 / mkdirp 之前：用户文件逐字未动
    expect(host.files.get(HOOKS_JSON)).toBe(USER_HOOKS_JSON);
  });

  it('从未 sync 过（无 sync-meta）也检查：首次 sync 同样不静默换掉既有文件', async () => {
    const host = createFakeHost({ USERPROFILE: HOME });
    await seedSoT(host, 'hook');
    await host.writeFile(HOOKS_JSON, USER_HOOKS_JSON);

    const err = await syncOnce(syncOptions(host)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(host.files.get(HOOKS_JSON)).toBe(USER_HOOKS_JSON);
  });

  it('dry-run 同样检查（不因"什么都不写"而放宽，与 marker 预检查同口径）', async () => {
    const host = createFakeHost({ USERPROFILE: HOME });
    await seedSoT(host, 'hook');
    await host.writeFile(HOOKS_JSON, USER_HOOKS_JSON);

    const err = await syncOnce(syncOptions(host, { dryRun: true })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
  });

  it('--force 跳过检查并整文件覆盖', async () => {
    const host = createFakeHost({ USERPROFILE: HOME });
    await seedSoT(host, 'hook');
    await host.writeFile(HOOKS_JSON, USER_HOOKS_JSON);

    await syncOnce(syncOptions(host, { force: true }));
    expect(host.files.get(HOOKS_JSON)).toBe(codexSessionHooksJson());
  });

  it('落点为空 → 正常写入（绝大多数用户的路径，不该被这道检查挡住）', async () => {
    const host = createFakeHost({ USERPROFILE: HOME });
    await seedSoT(host, 'hook');

    const result = await syncOnce(syncOptions(host));
    expect(host.files.get(HOOKS_JSON)).toBe(codexSessionHooksJson());
    expect(result.targets[0]?.statuses).toContain('written');
  });

  it('磁盘内容恰好等于本轮将写入的内容 → 不报冲突（覆盖不丢东西）', async () => {
    const host = createFakeHost({ USERPROFILE: HOME });
    await seedSoT(host, 'hook');
    await host.writeFile(HOOKS_JSON, codexSessionHooksJson());

    await expect(syncOnce(syncOptions(host))).resolves.toBeDefined();
    expect(host.files.get(HOOKS_JSON)).toBe(codexSessionHooksJson());
  });

  it('路径已在上一轮 artifacts 记账里 → 不进这道检查（存量产物的 SoT 演进不报冲突）', async () => {
    const host = createFakeHost({ USERPROFILE: HOME });
    await seedSoT(host, 'hook');
    await syncOnce(syncOptions(host)); // hooks.json 进记账
    host.files.set(HOOKS_JSON, '{ "hooks": {} }\n'); // 手工改动已认领的产物

    // 检查范围只覆盖「新进记账」的落点：已认领产物的覆盖仍按原语义走（不抛错）
    await expect(syncOnce(syncOptions(host))).resolves.toBeDefined();
    expect(host.files.get(HOOKS_JSON)).toBe(codexSessionHooksJson());
  });

  it('老版本 sync-meta（无 artifacts 表）→ 整段跳过，升级用户不会被大面积拦下', async () => {
    const host = createFakeHost({ USERPROFILE: HOME });
    await seedSoT(host, 'off');
    await syncOnce(syncOptions(host));
    dropArtifactsLedger(host);
    await host.writeFile(HOOKS_JSON, USER_HOOKS_JSON);
    await seedSoT(host, 'hook');

    await expect(syncOnce(syncOptions(host))).resolves.toBeDefined();
    expect(host.files.get(HOOKS_JSON)).toBe(codexSessionHooksJson());
  });
});
