/**
 * 「禁用即不渲染」（issue #55 后半：`disable` 挡不住 `resolveTemplate`）。
 *
 * 设计意图取自 `docs/commands.md`「官方模板源（默认注册、默认禁用）」那节：
 * 禁用态下该源**不联网、不进 template list、不参与渲染**。因此渲染侧的模板解析
 * 第 4 层必须以 `sources.json` 的登记项为准（登记且 `enabled` 才参与），而不是
 * 扫 `store\` 下的目录名。
 *
 * 覆盖（全部走 sync 的真实渲染入口 `sync-prepare.renderRulesMd`，
 * 与 doctor 的 `checkTemplates` 同一条解析链路）：
 * - 已禁用的 git 源：缓存在、模板 id 也在 profile.templates → ConfigError(2)，
 *   且错误提示同时给出「启用该源」与「改 templates」两条修复动作；
 * - 已启用的 git 源 → 照常渲染（回归保护，避免修过头把正常路径也挡了）；
 * - 已启用的 local 源 → 也能解析（与 `template list` 的口径对齐，见下方用例注释）；
 * - store 下有目录但登记表里没有该源（孤儿缓存）→ 不参与渲染；
 * - 登记表损坏且模板只能从源解析 → 报登记表那条 ConfigError（不是"未解析的 id"）；
 * - doctor 的 `template/<id>` 项如实报 error(2) 并带同一条 hint。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EffectiveConfig } from '../../../src/core/config/defaults';
import type { DoctorRoots } from '../../../src/core/doctor/check-config';
import { checkTemplates } from '../../../src/core/doctor/check-consistency';
import type { DoctorCheckResult } from '../../../src/core/doctor/check-types';
import { ConfigError, ExitCode } from '../../../src/core/errors';
import { currentOs } from '../../../src/core/paths';
import { renderRulesMd } from '../../../src/core/project/sync-prepare';
import type { Habits, Profile, SourcesFileInput } from '../../../src/schema';
import { HabitsSchema, ProfileSchema } from '../../../src/schema';
import { abs } from '../test-utils';
import { createDirAwareHost, type DirAwareHost } from './helpers';

const USER_SOT = abs('user-sot');
const PROJECT_SOT = path.join(abs('proj'), '.agentforge');
const VENDOR = path.join(abs('proj'), 'vendor-src');
const TEMPLATE_ID = 'extra/one';
const TEMPLATE_BODY = '## From source\n\n- 源里的模板正文\n';

function habits(): Habits {
  return HabitsSchema.parse({ version: 1 });
}

function profileWithTemplate(): Profile {
  return ProfileSchema.parse({ version: 1, targets: ['claude'], templates: [TEMPLATE_ID] });
}

/** 写 user 层 sources.json（登记表是渲染侧第 4 层的唯一判据）。 */
function writeRegistry(host: DirAwareHost, sources: SourcesFileInput['sources']): void {
  host.files.set(
    path.join(USER_SOT, 'sources.json'),
    `${JSON.stringify({ version: 1, sources }, null, 2)}\n`,
  );
}

/** 在 `store\<id>\templates\<TEMPLATE_ID>.md` 放一份模板（git 源缓存布局，§4.5）。 */
function writeStoreTemplate(host: DirAwareHost, id: string): void {
  host.files.set(path.join(USER_SOT, 'store', id, 'templates', `${TEMPLATE_ID}.md`), TEMPLATE_BODY);
}

function render(host: DirAwareHost): Promise<string> {
  return renderRulesMd(host, USER_SOT, PROJECT_SOT, habits(), profileWithTemplate(), currentOs());
}

async function expectConfigError(promise: Promise<unknown>): Promise<ConfigError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    const e = err as ConfigError;
    expect(e.code).toBe(ExitCode.Config);
    return e;
  }
  throw new Error('期望抛出 ConfigError，但 promise 正常完成');
}

describe('renderRulesMd 第 4 层以 sources.json 的 enabled 为准（issue #55）', () => {
  it('已禁用的 git 源：缓存里的模板不参与渲染 → ConfigError(2)，hint 同时给两条修复动作', async () => {
    const host = createDirAwareHost();
    writeRegistry(host, [
      {
        id: 'vendor',
        type: 'git',
        url: 'https://example.com/vendor.git',
        ref: 'v1.0.0',
        commit: 'abc123',
        enabled: false,
        kind: ['templates'],
      },
    ]);
    writeStoreTemplate(host, 'vendor');

    const err = await expectConfigError(render(host));
    expect(err.message).toContain(TEMPLATE_ID);
    expect(err.message).toContain('vendor');
    // 「启用该源」与「从 templates 移除」都是有效修复，提示必须同时给出
    expect(err.hint).toContain('aforge source enable vendor');
    expect(err.hint).toContain(`aforge template disable ${TEMPLATE_ID}`);
  });

  it('已启用的 git 源 → 照常渲染（不能把正常路径一起挡了）', async () => {
    const host = createDirAwareHost();
    writeRegistry(host, [
      {
        id: 'vendor',
        type: 'git',
        url: 'https://example.com/vendor.git',
        ref: 'v1.0.0',
        commit: 'abc123',
        enabled: true,
        kind: ['templates'],
      },
    ]);
    writeStoreTemplate(host, 'vendor');

    expect(await render(host)).toContain('源里的模板正文');
  });

  it('已启用的 local 源 → 也能解析（口径与 template list 一致）', async () => {
    // listTemplates 对 local 源扫的是登记的 path（sourceRootDir），而旧实现的第 4 层
    // 只扫 `store\`，于是 local 源独有的模板 id 会"列得出、渲染不出"（sync 报未解析）。
    // 以登记项推导源根之后两处天然同源。
    const host = createDirAwareHost();
    writeRegistry(host, [{ id: 'vendor-src', type: 'local', path: VENDOR, enabled: true }]);
    host.files.set(path.join(VENDOR, 'templates', `${TEMPLATE_ID}.md`), TEMPLATE_BODY);

    expect(await render(host)).toContain('源里的模板正文');
  });

  it('禁用的 local 源 → 不参与渲染', async () => {
    const host = createDirAwareHost();
    writeRegistry(host, [{ id: 'vendor-src', type: 'local', path: VENDOR, enabled: false }]);
    host.files.set(path.join(VENDOR, 'templates', `${TEMPLATE_ID}.md`), TEMPLATE_BODY);

    const err = await expectConfigError(render(host));
    expect(err.hint).toContain('aforge source enable vendor-src');
  });

  it('孤儿缓存（store 下有目录但登记表无该源）→ 不参与渲染', async () => {
    const host = createDirAwareHost();
    writeRegistry(host, []);
    writeStoreTemplate(host, 'ghost');

    const err = await expectConfigError(render(host));
    expect(err.message).toContain(TEMPLATE_ID);
    // 未登记的目录不是"被禁用的源"，提示走通用的未解析文案
    expect(err.hint).toContain('aforge template list');
  });

  it('登记表损坏且模板只能从源解析 → 报登记表损坏（而不是含糊的"未解析 id"）', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(USER_SOT, 'sources.json'), '{ not json');
    writeStoreTemplate(host, 'vendor');

    const err = await expectConfigError(render(host));
    expect(err.message).toContain('sources.json');
  });

  it('模板在 SoT 层就命中 → 登记表损坏也不影响渲染（第 4 层是懒求值的）', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(USER_SOT, 'sources.json'), '{ not json');
    host.files.set(path.join(USER_SOT, 'templates', `${TEMPLATE_ID}.md`), '## From SoT\n');

    expect(await render(host)).toContain('From SoT');
  });
});

describe('aforge doctor：templates 引用了已禁用源的模板 → template/<id> 报 error(2)', () => {
  it('detail 说明来自哪个禁用源，hint 给出 enable / 改 templates 两条动作', async () => {
    const host = createDirAwareHost();
    writeRegistry(host, [
      {
        id: 'vendor',
        type: 'git',
        url: 'https://example.com/vendor.git',
        ref: 'v1.0.0',
        commit: 'abc123',
        enabled: false,
        kind: ['templates'],
      },
    ]);
    writeStoreTemplate(host, 'vendor');

    const results: DoctorCheckResult[] = [];
    const roots: DoctorRoots = {
      userSoTRoot: USER_SOT,
      projectSoTRoot: PROJECT_SOT,
      userRootForLoad: USER_SOT,
    };
    const config: EffectiveConfig = {
      profile: profileWithTemplate(),
      habits: habits(),
      userSoTRoot: USER_SOT,
      projectSoTRoot: PROJECT_SOT,
      effectiveScope: 'project',
    };

    await checkTemplates(host, results, roots, config);

    const item = results.find((r) => r.item === `template/${TEMPLATE_ID}`);
    expect(item).toBeDefined();
    expect(item?.level).toBe('error');
    expect(item?.code).toBe(ExitCode.Config);
    expect(item?.detail).toContain('vendor');
    expect(item?.hint).toContain('aforge source enable vendor');
  });
});
