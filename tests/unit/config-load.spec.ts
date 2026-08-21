/**
 * 配置加载单测（Spec §3.1/§3.2/§4 / §6.1 退出码 2）：
 * 不存在 → null；坏 YAML → ConfigError 附行列；校验失败 → ConfigError 附字段路径。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, ExitCode } from '../../src/core/errors';
import type { ProfileInput } from '../../src/schema';
import { HabitsSchema, ProfileSchema } from '../../src/schema';
import {
  loadHabits,
  loadJson,
  loadProfile,
  loadSourcesFile,
  loadYaml,
} from '../../src/core/config/load';
import { createFakeHost } from './test-utils';

const SOT = path.resolve('C:\\soT');
const PROFILE_PATH = path.join(SOT, 'profile.yaml');
const HABITS_PATH = path.join(SOT, 'habits.yaml');
const SOURCES_PATH = path.join(SOT, 'sources.json');

/** 断言 promise 拒绝为 ConfigError(code 2)，并返回错误供进一步检查。 */
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

describe('loadYaml / loadProfile / loadHabits', () => {
  it('文件不存在 → null（profile 与 habits 相互独立）', async () => {
    const host = createFakeHost();
    expect(await loadProfile(host, SOT)).toBeNull();
    expect(await loadHabits(host, SOT)).toBeNull();
    expect(await loadYaml(host, PROFILE_PATH, ProfileSchema, 'profile.yaml')).toBeNull();
  });

  it('合法 YAML → 返回原始对象（不填充默认值，保留"未设置"语义供合并层）', async () => {
    const host = createFakeHost();
    host.files.set(
      PROFILE_PATH,
      ['version: 1', 'scope: project', 'targets: [claude]'].join('\n'),
    );
    const profile = await loadProfile(host, SOT);
    expect(profile).toEqual({ version: 1, scope: 'project', targets: ['claude'] });
    // 未声明的 merge/skills 等保持 undefined（区别于"显式设置为默认值"）
    expect((profile as ProfileInput).merge).toBeUndefined();
    expect((profile as ProfileInput).projection).toBeUndefined();
  });

  it('合法 habits YAML（Spec §13.1 风格）→ 原样返回', async () => {
    const host = createFakeHost();
    host.files.set(
      HABITS_PATH,
      [
        'version: 1',
        'runtime:',
        '  node:',
        '    manager: fnm',
        '    version: "lts"',
        'ai:',
        '  verification: [test, lint]',
      ].join('\n'),
    );
    const habits = await loadHabits(host, SOT);
    expect(habits).toEqual({
      version: 1,
      runtime: { node: { manager: 'fnm', version: 'lts' } },
      ai: { verification: ['test', 'lint'] },
    });
  });

  it('坏 YAML → ConfigError(2)，message 附行列号，details 保留 linePos', async () => {
    const host = createFakeHost();
    host.files.set(PROFILE_PATH, 'version: 1\ntargets: [claude\n'); // 未闭合 flow 序列
    const err = await expectConfigError(loadProfile(host, SOT));
    expect(err.message).toContain('不是合法的 YAML');
    expect(err.message).toMatch(/第 \d+ 行，第 \d+ 列/);
    const details = err.details as { linePos?: Array<{ line: number; col: number }> };
    expect(details.linePos?.[0]?.line).toBeGreaterThan(0);
  });

  it('缩进错误 → ConfigError(2) 且行列指向出错行', async () => {
    const host = createFakeHost();
    host.files.set(PROFILE_PATH, 'version: 1\n  targets: [claude]\n');
    const err = await expectConfigError(loadProfile(host, SOT));
    const details = err.details as { linePos?: Array<{ line: number; col: number }> };
    expect(details.linePos?.[0]?.line).toBe(1); // yaml 报在嵌套映射起点
  });

  it('schema 违反 → ConfigError(2)，message 附字段路径', async () => {
    const host = createFakeHost();
    host.files.set(PROFILE_PATH, 'version: 1\ntargets: []\n');
    const err = await expectConfigError(loadProfile(host, SOT));
    expect(err.message).toContain('targets');
    expect(err.message).toContain('校验失败');
  });

  it('嵌套字段路径：runtime.node.manager 非法 → 错误信息含完整路径', async () => {
    const host = createFakeHost();
    host.files.set(HABITS_PATH, 'runtime:\n  node:\n    manager: nvmx\n');
    const err = await expectConfigError(loadHabits(host, SOT));
    expect(err.message).toContain('runtime.node.manager');
  });

  it('多 issue 汇总：一次报出全部问题', async () => {
    const host = createFakeHost();
    host.files.set(
      PROFILE_PATH,
      'targets: []\nprojection:\n  line_ending: cr\n',
    );
    const err = await expectConfigError(loadProfile(host, SOT));
    expect(err.message).toContain('共 2 处问题');
    expect(err.message).toContain('targets');
    expect(err.message).toContain('projection.line_ending');
  });

  it('空文件（YAML null）→ ConfigError(2)（配置文件不允许为空文档）', async () => {
    const host = createFakeHost();
    host.files.set(PROFILE_PATH, '');
    await expectConfigError(loadProfile(host, SOT));
  });

  it('hint 可操作：指向 JSON Schema 工件', async () => {
    const host = createFakeHost();
    host.files.set(PROFILE_PATH, 'targets: []\n');
    const err = await expectConfigError(loadProfile(host, SOT));
    expect(err.hint).toContain('schemas');
  });

  it('loadYaml 泛型：直接以 schema 调用（habits 示例）', async () => {
    const host = createFakeHost();
    host.files.set(HABITS_PATH, 'version: 1\ndetected:\n  editor: code\n');
    const habits = await loadYaml(host, HABITS_PATH, HabitsSchema, 'habits.yaml');
    expect(habits).toEqual({ version: 1, detected: { editor: 'code' } });
  });
});

describe('loadJson / loadSourcesFile', () => {
  it('合法 sources.json → 完整形态（默认值填充，直接可消费）', async () => {
    const host = createFakeHost();
    host.files.set(
      SOURCES_PATH,
      JSON.stringify({
        version: 1,
        sources: [{ id: 'tpl', type: 'local', path: 'D:\\templates' }],
      }),
    );
    const sources = await loadSourcesFile(host, SOT);
    expect(sources).toEqual({
      version: 1,
      sources: [{ id: 'tpl', type: 'local', path: 'D:\\templates', enabled: true, kind: [] }],
    });
  });

  it('不存在 → null', async () => {
    const host = createFakeHost();
    expect(await loadSourcesFile(host, SOT)).toBeNull();
    expect(await loadJson(host, SOURCES_PATH, ProfileSchema, 'sources.json')).toBeNull();
  });

  it('坏 JSON → ConfigError(2)（sources.json 损坏，Spec §6.1）', async () => {
    const host = createFakeHost();
    host.files.set(SOURCES_PATH, '{ "version": 1, ');
    const err = await expectConfigError(loadSourcesFile(host, SOT));
    expect(err.message).toContain('不是合法的 JSON');
  });

  it('JSON 含注释语法 → ConfigError(2)', async () => {
    const host = createFakeHost();
    host.files.set(SOURCES_PATH, '// comment\n{ "version": 1 }');
    await expectConfigError(loadSourcesFile(host, SOT));
  });

  it('校验失败（local 携带 url，字段互斥）→ ConfigError(2) 附路径', async () => {
    const host = createFakeHost();
    host.files.set(
      SOURCES_PATH,
      JSON.stringify({
        sources: [{ id: 'x', type: 'local', path: 'D:\\t', url: 'https://e.com' }],
      }),
    );
    const err = await expectConfigError(loadSourcesFile(host, SOT));
    expect(err.message).toMatch(/sources\.0/);
  });
});
