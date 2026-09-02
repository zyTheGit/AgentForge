/**
 * resolver 单测（Spec §5.2 / §3.4 / §4.5）：内置 base/default → 项目 SoT →
 * 用户 SoT → 已启用源的查找优先级、非法 id 防逃逸与未命中 ConfigError(2)。
 *
 * 第 4 层的源清单由调用方注入（生产侧是 core/sources/render-scope 读 sources.json）；
 * 本文件直接构造清单，以便逐条断言"启用/禁用/命中顺序"而不牵扯登记表格式。
 * 「禁用源不参与解析」的端到端行为见 tests/unit/sources/disabled-source-render.spec.ts。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_DEFAULT_TEMPLATE } from '../../../src/assets/templates';
import { ConfigError, ExitCode } from '../../../src/core/errors';
import type { ResolveContext } from '../../../src/core/generate/resolver';
import { resolveTemplate } from '../../../src/core/generate/resolver';
import type { TemplateSourceEntry } from '../../../src/core/sources/render-scope';
import { createFakeHost, type FakeHost } from '../test-utils';

const PROJECT_SOT = path.resolve('C:\\proj\\.agentforge');
const USER_SOT = path.resolve('C:\\user\\.agentforge');
const STORE = path.resolve('C:\\store');

/** 一条已启用的 git 源（源根即 `store\<id>`，与生产侧 sourceRootDir 同布局）。 */
function enabled(id: string): TemplateSourceEntry {
  return { id, root: path.join(STORE, id), enabled: true };
}

/**
 * 目录感知 listDir 的 fake host：返回**直接子项名**（对齐真实 host 的 readdir
 * 语义；test-utils 原版为 `/` 前缀扁平扫描，与 resolver 的 path.join 拼接产物
 * 分隔符不一致）。files 表仍以 path.join 形态的完整文件路径为 key。
 */
function createDirAwareHost(): FakeHost {
  const base = createFakeHost();
  const host: FakeHost = {
    ...base,
    async listDir(p) {
      const prefix = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
      const names = new Set<string>();
      for (const key of base.files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (rest === '') {
            continue;
          }
          const sep = rest.search(/[\\/]/);
          names.add(sep === -1 ? rest : rest.slice(0, sep));
        }
      }
      return [...names].sort();
    },
  };
  return host;
}

function ctxFor(host: FakeHost, sources: readonly TemplateSourceEntry[] = []): ResolveContext {
  return {
    host,
    userSoTRoot: USER_SOT,
    projectSoTRoot: PROJECT_SOT,
    sources: async () => sources,
  };
}

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

describe('resolveTemplate 查找优先级', () => {
  it('base/default → 内置常量（项目/用户 SoT 的同名文件不可覆盖，Spec §3.4 只读）', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(PROJECT_SOT, 'templates', 'base', 'default.md'), '# fake override');
    host.files.set(path.join(USER_SOT, 'templates', 'base', 'default.md'), '# user override');
    const resolved = await resolveTemplate('base/default', ctxFor(host));
    expect(resolved).toEqual({ id: 'base/default', content: BASE_DEFAULT_TEMPLATE });
  });

  it('base/default → 内置常量优先于官方源 store 里的同名模板（§12 Phase 2 官方模板源）', async () => {
    const host = createDirAwareHost();
    // 官方源就是本仓库，其 templates/base/default.md 与内置模板同 id：启用官方源
    // 只应**新增**它独有的模板，不该改变现有投影
    host.files.set(
      path.join(STORE, 'official', 'templates', 'base', 'default.md'),
      '# official override',
    );
    const resolved = await resolveTemplate('base/default', ctxFor(host, [enabled('official')]));
    expect(resolved.content).toBe(BASE_DEFAULT_TEMPLATE);
  });

  it('项目 SoT 优先于用户 SoT 与源', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(PROJECT_SOT, 'templates', 'extra', 'one.md'), '# project');
    host.files.set(path.join(USER_SOT, 'templates', 'extra', 'one.md'), '# user');
    host.files.set(path.join(STORE, 'src-a', 'templates', 'extra', 'one.md'), '# store');
    const resolved = await resolveTemplate('extra/one', ctxFor(host, [enabled('src-a')]));
    expect(resolved).toEqual({ id: 'extra/one', content: '# project' });
  });

  it('仅用户 SoT 有 → 用户内容', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(USER_SOT, 'templates', 'extra', 'one.md'), '# user');
    const resolved = await resolveTemplate('extra/one', ctxFor(host));
    expect(resolved.content).toBe('# user');
  });

  it('仅源里有 → 源内容（<源根>/templates/<id>.md，Spec §4.5 布局）', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(STORE, 'src-a', 'templates', 'extra', 'one.md'), '# from store');
    const resolved = await resolveTemplate('extra/one', ctxFor(host, [enabled('src-a')]));
    expect(resolved.content).toBe('# from store');
  });

  it('多个已启用源命中 → 按源 id 字典序取首个', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(STORE, 'zeta', 'templates', 'extra', 'one.md'), '# zeta');
    host.files.set(path.join(STORE, 'alpha', 'templates', 'extra', 'one.md'), '# alpha');
    // 清单由 render-scope 按 id 排序后注入；此处按乱序传入以证明顺序取自清单
    const resolved = await resolveTemplate(
      'extra/one',
      ctxFor(host, [enabled('alpha'), enabled('zeta')]),
    );
    expect(resolved.content).toBe('# alpha');
  });

  it('没有任何登记源 → 落入未命中分支（第 4 层不扫 store 目录）', async () => {
    const host = createDirAwareHost();
    // 目录在、但没有登记项：孤儿缓存不参与解析（issue #55）
    host.files.set(path.join(STORE, 'ghost', 'templates', 'extra', 'one.md'), '# orphan');
    await expectConfigError(resolveTemplate('extra/one', ctxFor(host)));
  });

  it('四处均未命中 → ConfigError(2)，message 含 id，hint 指向 template list', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(STORE, 'src-a', 'templates', 'other', 'tpl.md'), '# unrelated');
    const err = await expectConfigError(
      resolveTemplate('missing/tpl', ctxFor(host, [enabled('src-a')])),
    );
    expect(err.message).toContain('missing/tpl');
    expect(err.hint).toContain('aforge template list');
  });

  it('命中的源已禁用 → ConfigError(2) 点名该源，并给出 enable / 改 templates 两条动作', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(STORE, 'vendor', 'templates', 'extra', 'one.md'), '# disabled');
    const err = await expectConfigError(
      resolveTemplate(
        'extra/one',
        ctxFor(host, [{ id: 'vendor', root: path.join(STORE, 'vendor'), enabled: false }]),
      ),
    );
    expect(err.message).toContain('vendor');
    expect(err.hint).toContain('aforge source enable vendor');
    expect(err.hint).toContain('aforge template disable extra/one');
  });

  it('同一 id 同时存在于已禁用与已启用源 → 取已启用那份（禁用项只影响错误提示）', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(STORE, 'alpha', 'templates', 'extra', 'one.md'), '# disabled alpha');
    host.files.set(path.join(STORE, 'zeta', 'templates', 'extra', 'one.md'), '# enabled zeta');
    const resolved = await resolveTemplate(
      'extra/one',
      ctxFor(host, [
        { id: 'alpha', root: path.join(STORE, 'alpha'), enabled: false },
        enabled('zeta'),
      ]),
    );
    expect(resolved.content).toBe('# enabled zeta');
  });

  it('源清单读取失败（登记表损坏）→ 错误原样上抛，不被吞成"未解析"', async () => {
    const host = createDirAwareHost();
    const boom = new ConfigError('sources.json 解析失败');
    await expect(
      resolveTemplate('extra/one', {
        host,
        userSoTRoot: USER_SOT,
        projectSoTRoot: PROJECT_SOT,
        sources: () => Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
  });
});

describe('resolveTemplate 非法 id（防路径逃逸）', () => {
  it.each([
    '../escape',
    'a/../../etc/passwd',
    'back\\slash',
    '',
    '/absolute',
    'a//b',
    '.',
  ])('id "%s" → ConfigError(2)', async (id) => {
    await expectConfigError(resolveTemplate(id, ctxFor(createDirAwareHost())));
  });
});
