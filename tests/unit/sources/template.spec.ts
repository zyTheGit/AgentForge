/**
 * template 单测（Spec §7.6 / §5.2 / §6 命令表）。
 *
 * 覆盖：listTemplates 三类来源（builtin / SoT 扫描 / manifest 源）与 enabled
 * 判定；setTemplateEnabled 只改 profile.templates（enable 追加 / disable 移除 /
 * 幂等 no-op / 禁到空数组）。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadProfile } from '../../../src/core/config/load';
import type { TargetLayer } from '../../../src/core/config/target-layer';
import type { EnvSnapshot } from '../../../src/core/env';
import { currentOs } from '../../../src/core/paths';
import { addLocalSource, type SourceManagerContext } from '../../../src/core/sources/manager';
import { listTemplates, setTemplateEnabled } from '../../../src/core/sources/template';
import { abs } from '../test-utils';
import { createDirAwareHost } from './helpers';

// 夹具走宿主平台语义：被测代码（load / template / manager）用宿主 path.join 拼
// 内存 fs 的键，夹具必须同语义，否则 posix 上键错位（见 test-utils.abs）。
const USER_SOT = abs('user-sot');
const PROJECT_ROOT = abs('proj');
const PROJECT_SOT = path.join(PROJECT_ROOT, '.agentforge');
const VENDOR = path.join(PROJECT_ROOT, 'vendor-src');

function envFor(): EnvSnapshot {
  return {
    agfHome: USER_SOT,
    agfScope: undefined,
    offline: false,
    lineEnding: undefined,
    ci: false,
    codexHome: undefined,
    userProfile: abs('user'),
  };
}

function tplCtx(host: ReturnType<typeof createDirAwareHost>, effectiveTemplates: string[]) {
  return {
    host,
    env: envFor(),
    os: currentOs(),
    cwd: PROJECT_ROOT,
    userSoTRoot: USER_SOT,
    projectSoTRoot: PROJECT_SOT,
    effectiveTemplates,
  };
}

function mgrCtx(host: ReturnType<typeof createDirAwareHost>): SourceManagerContext {
  return { host, env: envFor(), userSoTRoot: USER_SOT, cwd: PROJECT_ROOT };
}

function projectLayer(): TargetLayer {
  return {
    scope: 'project',
    sotRoot: PROJECT_SOT,
    profileFile: path.join(PROJECT_SOT, 'profile.yaml'),
  };
}

describe('listTemplates', () => {
  it('内置 base/default 恒在（§3.4），enabled 随 effectiveTemplates', async () => {
    const host = createDirAwareHost();
    const items = await listTemplates(tplCtx(host, ['base/default']));
    expect(items).toEqual([{ id: 'base/default', origin: 'builtin', enabled: true }]);
  });

  it('builtin 未启用 → enabled false', async () => {
    const host = createDirAwareHost();
    const items = await listTemplates(tplCtx(host, []));
    expect(items[0]).toMatchObject({ id: 'base/default', enabled: false });
  });

  it('两层 SoT templates\\ 递归扫描（相对路径去 .md 为 id，/ 分隔）', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(PROJECT_SOT, 'templates', 'review.md'), 'a');
    host.files.set(path.join(PROJECT_SOT, 'templates', 'team', 'style.md'), 'b');
    host.files.set(path.join(USER_SOT, 'templates', 'global.md'), 'c');

    const items = await listTemplates(tplCtx(host, ['review']));
    expect(items.find((i) => i.id === 'review')).toMatchObject({
      origin: 'project',
      enabled: true,
    });
    expect(items.find((i) => i.id === 'team/style')).toMatchObject({
      origin: 'project',
      enabled: false,
    });
    expect(items.find((i) => i.id === 'global')).toMatchObject({ origin: 'user', enabled: false });
  });

  it('源 manifest.templates 进清单（origin source，带 sourceId 与 description）', async () => {
    const host = createDirAwareHost();
    host.files.set(
      path.join(VENDOR, 'manifest.yaml'),
      [
        'name: v',
        "version: '1.0.0'",
        'min_agentforge: 1',
        'templates:',
        '  - id: team/review',
        '    path: templates/review.md',
        '    description: review rules',
        '',
      ].join('\n'),
    );
    await addLocalSource(mgrCtx(host), { path: VENDOR });

    const items = await listTemplates(tplCtx(host, []));
    expect(items.find((i) => i.id === 'team/review')).toMatchObject({
      origin: 'source',
      sourceId: 'vendor-src',
      description: 'review rules',
      enabled: false,
    });
  });
});

describe('setTemplateEnabled', () => {
  it('enable：追加到 profile.templates 末尾；其他字段原样保留（只改 templates）', async () => {
    const host = createDirAwareHost();
    host.files.set(
      projectLayer().profileFile,
      'version: 1\ntargets: [claude, opencode]\nprojection:\n  line_ending: crlf\n',
    );

    const result = await setTemplateEnabled(host, projectLayer(), 'team/review', true);
    expect(result.changed).toBe(true);
    expect(result.templates).toEqual(['team/review']);

    const profile = await loadProfile(host, PROJECT_SOT);
    expect(profile?.templates).toEqual(['team/review']);
    // 只改 templates：targets 与 projection.line_ending 保留
    expect(profile?.targets).toEqual(['claude', 'opencode']);
    expect(profile?.projection?.line_ending).toBe('crlf');
  });

  it('disable：从数组移除', async () => {
    const host = createDirAwareHost();
    host.files.set(
      projectLayer().profileFile,
      'version: 1\ntargets: [claude]\ntemplates: [base/default, team/review]\n',
    );

    const result = await setTemplateEnabled(host, projectLayer(), 'team/review', false);
    expect(result.changed).toBe(true);
    expect(result.templates).toEqual(['base/default']);
    expect((await loadProfile(host, PROJECT_SOT))?.templates).toEqual(['base/default']);
  });

  it('enable 已含 → changed:false（幂等，不重复追加）', async () => {
    const host = createDirAwareHost();
    host.files.set(
      projectLayer().profileFile,
      'version: 1\ntargets: [claude]\ntemplates: [team/review]\n',
    );
    const result = await setTemplateEnabled(host, projectLayer(), 'team/review', true);
    expect(result.changed).toBe(false);
    expect(result.templates).toEqual(['team/review']);
  });

  it('disable 未含 → changed:false', async () => {
    const host = createDirAwareHost();
    host.files.set(projectLayer().profileFile, 'version: 1\ntargets: [claude]\n');
    const result = await setTemplateEnabled(host, projectLayer(), 'ghost', false);
    expect(result.changed).toBe(false);
  });

  it('禁用到空 → 写入 templates: []（合法；base/default 仍恒渲染）', async () => {
    const host = createDirAwareHost();
    host.files.set(
      projectLayer().profileFile,
      'version: 1\ntargets: [claude]\ntemplates: [base/default]\n',
    );
    const result = await setTemplateEnabled(host, projectLayer(), 'base/default', false);
    expect(result.templates).toEqual([]);
    const raw = parseYaml(host.files.get(projectLayer().profileFile) ?? '');
    expect(raw.templates).toEqual([]);
  });

  it('profile 不存在 → 以最小骨架创建（version+targets）后写入', async () => {
    const host = createDirAwareHost();
    const result = await setTemplateEnabled(host, projectLayer(), 'x', true);
    expect(result.templates).toEqual(['x']);
    const profile = await loadProfile(host, PROJECT_SOT);
    expect(profile?.targets).toEqual(['opencode']);
  });

  it('user 层 targetLayer：写 user 层 profile.yaml', async () => {
    const host = createDirAwareHost();
    const userLayer: TargetLayer = {
      scope: 'user',
      sotRoot: USER_SOT,
      profileFile: path.join(USER_SOT, 'profile.yaml'),
    };
    await setTemplateEnabled(host, userLayer, 'global', true);
    expect((await loadProfile(host, USER_SOT))?.templates).toEqual(['global']);
  });
});
