/**
 * 配置默认值与三层装配单测（Spec §4.2 Windows 安装默认值 / §2.4 env 覆盖）。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultHabits,
  resolveEffectiveConfig,
  windowsDefaultProfile,
} from '../../src/core/config/defaults';
import { serializeYamlDoc } from '../../src/core/config/serialize';
import { readEnv } from '../../src/core/env';
import { ConfigError } from '../../src/core/errors';
import { createFakeHost } from './test-utils';

const USER_SOT = path.resolve('C:\\Users\\u\\.agentforge');
const PROJECT_SOT = path.resolve('C:\\proj\\.agentforge');

const USER_PROFILE = path.join(USER_SOT, 'profile.yaml');
const USER_HABITS = path.join(USER_SOT, 'habits.yaml');
const PROJECT_PROFILE = path.join(PROJECT_SOT, 'profile.yaml');
const PROJECT_HABITS = path.join(PROJECT_SOT, 'habits.yaml');

/** readEnv(createFakeHost(map)) 的简写。 */
const envOf = (map: Readonly<Record<string, string>> = {}) => readEnv(createFakeHost(map));

describe('内置默认值（Spec §4.2 Windows 安装默认值 / §7.1）', () => {
  it('windowsDefaultProfile 逐字段对齐 Spec 代码块', () => {
    expect(windowsDefaultProfile()).toEqual({
      version: 1,
      scope: 'project',
      targets: ['opencode', 'codex', 'claude', 'pi'],
      templates: ['base/default'],
      skills: { copy_mode: 'copy' },
      projection: { marker_mode: 'replace_between_markers', line_ending: 'lf' },
      learning: { default_scope: 'project', auto_capture: 'off', auto_promote: false },
    });
  });

  it('defaultHabits → 空骨架 + detected: {}', () => {
    expect(defaultHabits()).toEqual({ version: 1, detected: {} });
  });

  // 裸 `off` 在 YAML 1.1 是 boolean false、在 1.2 core schema 才是字符串。init 落盘的
  // profile.yaml 走的就是这条路径，档位被读成 false 会让每次装配都 ConfigError(2)。
  it('落盘的 auto_capture: off 经 YAML 往返仍是字符串档位（不退化成 boolean）', async () => {
    const host = createFakeHost();
    host.files.set(PROJECT_PROFILE, serializeYamlDoc(windowsDefaultProfile()));
    const cfg = await resolveEffectiveConfig(envOf(), USER_SOT, PROJECT_SOT, host);
    expect(cfg.profile.learning.auto_capture).toBe('off');
  });
});

describe('resolveEffectiveConfig 三层装配（env > project > user > 内置默认）', () => {
  it('无任何配置文件 → 返回内置默认（供 init / 全新环境使用）', async () => {
    const host = createFakeHost();
    const cfg = await resolveEffectiveConfig(envOf(), USER_SOT, PROJECT_SOT, host);

    expect(cfg.profile).toMatchObject({
      version: 1,
      scope: 'project',
      targets: ['opencode', 'codex', 'claude', 'pi'],
      templates: ['base/default'],
      skills: { copy_mode: 'copy' },
      projection: { marker_mode: 'replace_between_markers', line_ending: 'lf' },
      learning: { default_scope: 'project', auto_promote: false, include_promoted_in_sync: true },
    });
    expect(cfg.habits).toEqual({
      version: 1,
      runtime: {},
      tools: {},
      ai: {},
      detected: {},
      extensions: {},
    });
    expect(cfg.effectiveScope).toBe('project');
    expect(cfg.userSoTRoot).toBe(USER_SOT);
    expect(cfg.projectSoTRoot).toBe(PROJECT_SOT);
  });

  it('AGF_LINE_ENDING=crlf 覆盖内置默认（env 最高优先级）', async () => {
    const host = createFakeHost();
    const cfg = await resolveEffectiveConfig(
      envOf({ AGF_LINE_ENDING: 'crlf' }),
      USER_SOT,
      PROJECT_SOT,
      host,
    );
    expect(cfg.profile.projection.line_ending).toBe('crlf');
  });

  it('AGF_LINE_ENDING 覆盖文件声明（env > project 文件 > 内置默认）', async () => {
    const host = createFakeHost();
    host.files.set(
      PROJECT_PROFILE,
      'version: 1\ntargets: [claude]\nprojection:\n  line_ending: crlf\n',
    );
    const cfg = await resolveEffectiveConfig(
      envOf({ AGF_LINE_ENDING: 'lf' }),
      USER_SOT,
      PROJECT_SOT,
      host,
    );
    expect(cfg.profile.projection.line_ending).toBe('lf');
  });

  it('文件声明覆盖内置默认（project > 内置默认，env 不设置）', async () => {
    const host = createFakeHost();
    host.files.set(
      PROJECT_PROFILE,
      'version: 1\ntargets: [claude]\nprojection:\n  line_ending: crlf\n',
    );
    const cfg = await resolveEffectiveConfig(envOf(), USER_SOT, PROJECT_SOT, host);
    expect(cfg.profile.projection.line_ending).toBe('crlf');
  });

  it('只有 user 层 → effectiveScope=user，字段继承 user', async () => {
    const host = createFakeHost();
    host.files.set(
      USER_PROFILE,
      [
        'version: 1',
        'scope: user',
        'targets: [opencode, codex]',
        'skills:',
        '  copy_mode: symlink',
      ].join('\n'),
    );
    host.files.set(USER_HABITS, 'version: 1\ntools:\n  shell: pwsh\n');

    const cfg = await resolveEffectiveConfig(envOf(), USER_SOT, PROJECT_SOT, host);
    expect(cfg.effectiveScope).toBe('user');
    expect(cfg.profile.targets).toEqual(['opencode', 'codex']);
    expect(cfg.profile.skills.copy_mode).toBe('symlink'); // user 显式声明
    expect(cfg.habits.tools.shell).toBe('pwsh');
  });

  it('project 层出现 → effectiveScope=project，project targets 覆盖 user（Spec 示例经装配层复现）', async () => {
    const host = createFakeHost();
    host.files.set(USER_PROFILE, 'version: 1\nscope: user\ntargets: [opencode, codex]\n');
    host.files.set(PROJECT_PROFILE, 'version: 1\ntargets: [claude]\n');

    const cfg = await resolveEffectiveConfig(envOf(), USER_SOT, PROJECT_SOT, host);
    expect(cfg.effectiveScope).toBe('project');
    expect(cfg.profile.targets).toEqual(['claude']);
    // project 未声明 scope → 继承 user 层声明（overlay 语义）
    expect(cfg.profile.scope).toBe('user');
  });

  it('project 显式声明 scope → 覆盖 user 层声明', async () => {
    const host = createFakeHost();
    host.files.set(USER_PROFILE, 'version: 1\nscope: user\ntargets: [opencode]\n');
    host.files.set(PROJECT_PROFILE, 'version: 1\nscope: project\ntargets: [claude]\n');
    const cfg = await resolveEffectiveConfig(envOf(), USER_SOT, PROJECT_SOT, host);
    expect(cfg.profile.scope).toBe('project');
  });

  it('AGF_SCOPE=user 强制（即使 project 层存在）', async () => {
    const host = createFakeHost();
    host.files.set(PROJECT_PROFILE, 'version: 1\ntargets: [claude]\n');
    const cfg = await resolveEffectiveConfig(
      envOf({ AGF_SCOPE: 'user' }),
      USER_SOT,
      PROJECT_SOT,
      host,
    );
    expect(cfg.effectiveScope).toBe('user');
  });

  it('合并选项取自 project 层 merge 声明：arrays=append → templates 串联', async () => {
    const host = createFakeHost();
    host.files.set(
      USER_PROFILE,
      ['version: 1', 'targets: [opencode]', 'templates: [base/default]'].join('\n'),
    );
    host.files.set(
      PROJECT_PROFILE,
      [
        'version: 1',
        'targets: [claude]',
        'templates: [custom/strict]',
        'merge:',
        '  arrays: append',
      ].join('\n'),
    );

    const cfg = await resolveEffectiveConfig(envOf(), USER_SOT, PROJECT_SOT, host);
    expect(cfg.profile.templates).toEqual(['base/default', 'custom/strict']);
  });

  it('user 层声明 arrays、project 未声明 → 沿用 user 层声明', async () => {
    const host = createFakeHost();
    host.files.set(
      USER_PROFILE,
      [
        'version: 1',
        'targets: [opencode]',
        'templates: [u-tpl]',
        'merge:',
        '  arrays: append',
      ].join('\n'),
    );
    host.files.set(PROJECT_PROFILE, 'version: 1\ntargets: [claude]\ntemplates: [p-tpl]\n');

    const cfg = await resolveEffectiveConfig(envOf(), USER_SOT, PROJECT_SOT, host);
    expect(cfg.profile.templates).toEqual(['u-tpl', 'p-tpl']);
  });

  it('habits 两层合并：runtime 深合并 + detected 以 project 为准', async () => {
    const host = createFakeHost();
    host.files.set(
      USER_HABITS,
      ['version: 1', 'runtime:', '  node:', '    manager: fnm', 'detected:', '  editor: vim'].join(
        '\n',
      ),
    );
    host.files.set(
      PROJECT_HABITS,
      [
        'version: 1',
        'runtime:',
        '  python:',
        '    manager: uv',
        'detected:',
        '  node:',
        '    manager: fnm',
      ].join('\n'),
    );

    const cfg = await resolveEffectiveConfig(envOf(), USER_SOT, PROJECT_SOT, host);
    expect(cfg.habits.runtime).toEqual({
      node: { manager: 'fnm' },
      python: { manager: 'uv' },
    });
    expect(cfg.habits.detected).toEqual({ node: { manager: 'fnm' } });
    expect(cfg.effectiveScope).toBe('project'); // habits 也算 project 层在用
  });

  it('profile 在 user、habits 在 project：两层均在用，字段各取合并结果', async () => {
    const host = createFakeHost();
    host.files.set(USER_PROFILE, 'version: 1\nscope: user\ntargets: [opencode]\n');
    host.files.set(PROJECT_HABITS, 'version: 1\ntools:\n  shell: pwsh\n');

    const cfg = await resolveEffectiveConfig(envOf(), USER_SOT, PROJECT_SOT, host);
    expect(cfg.profile.targets).toEqual(['opencode']); // project 无 profile → user 原样
    expect(cfg.habits.tools.shell).toBe('pwsh');
    expect(cfg.effectiveScope).toBe('project');
  });

  it('输出为完整形态：未声明字段均已填充 schema 默认值', async () => {
    const host = createFakeHost();
    host.files.set(PROJECT_PROFILE, 'version: 1\ntargets: [claude]\n');
    const cfg = await resolveEffectiveConfig(envOf(), USER_SOT, PROJECT_SOT, host);
    expect(cfg.profile.merge).toEqual({ strategy: 'overlay', arrays: 'replace' });
    expect(cfg.profile.projection.marker_mode).toBe('replace_between_markers');
    expect(cfg.profile.learning.auto_promote).toBe(false);
    expect(cfg.habits.detected).toEqual({});
  });

  it('project 层配置损坏 → ConfigError(2) fail-fast（不静默降级）', async () => {
    const host = createFakeHost();
    host.files.set(USER_PROFILE, 'version: 1\ntargets: [opencode]\n');
    host.files.set(PROJECT_PROFILE, 'version: 1\ntargets: []\n'); // 校验失败

    await expect(
      resolveEffectiveConfig(envOf(), USER_SOT, PROJECT_SOT, host),
    ).rejects.toMatchObject({ name: 'ConfigError', code: 2 });
  });

  it('user 层坏 YAML → ConfigError(2) 附行列', async () => {
    const host = createFakeHost();
    host.files.set(USER_PROFILE, 'version: 1\ntargets: [claude\n');
    await expect(
      resolveEffectiveConfig(envOf(), USER_SOT, PROJECT_SOT, host),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
