/**
 * resolver 单测（Spec §5.2 / §3.4 / §4.5）：内置 base/default → 项目 SoT →
 * 用户 SoT → 源 store 的查找优先级、非法 id 防逃逸与未命中 ConfigError(2)。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_DEFAULT_TEMPLATE } from '../../../src/assets/templates';
import { ConfigError, ExitCode } from '../../../src/core/errors';
import { resolveTemplate } from '../../../src/core/generate/resolver';
import type { ResolveContext } from '../../../src/core/generate/resolver';
import { createFakeHost, type FakeHost } from '../test-utils';

const PROJECT_SOT = path.resolve('C:\\proj\\.agentforge');
const USER_SOT = path.resolve('C:\\user\\.agentforge');
const STORE = path.resolve('C:\\store');

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
          if (rest === '') continue;
          const sep = rest.search(/[\\/]/);
          names.add(sep === -1 ? rest : rest.slice(0, sep));
        }
      }
      return [...names].sort();
    },
  };
  return host;
}

function ctxFor(host: FakeHost): ResolveContext {
  return { host, userSoTRoot: USER_SOT, projectSoTRoot: PROJECT_SOT, storeRoot: STORE };
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

  it('项目 SoT 优先于用户 SoT 与源 store', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(PROJECT_SOT, 'templates', 'extra', 'one.md'), '# project');
    host.files.set(path.join(USER_SOT, 'templates', 'extra', 'one.md'), '# user');
    host.files.set(path.join(STORE, 'src-a', 'templates', 'extra', 'one.md'), '# store');
    const resolved = await resolveTemplate('extra/one', ctxFor(host));
    expect(resolved).toEqual({ id: 'extra/one', content: '# project' });
  });

  it('仅用户 SoT 有 → 用户内容', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(USER_SOT, 'templates', 'extra', 'one.md'), '# user');
    const resolved = await resolveTemplate('extra/one', ctxFor(host));
    expect(resolved.content).toBe('# user');
  });

  it('仅源 store 有 → store 内容（store/<source>/templates/<id>.md，Spec §4.5 布局）', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(STORE, 'src-a', 'templates', 'extra', 'one.md'), '# from store');
    const resolved = await resolveTemplate('extra/one', ctxFor(host));
    expect(resolved.content).toBe('# from store');
  });

  it('store 多个源目录命中 → 按源目录名字典序取首个', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(STORE, 'zeta', 'templates', 'extra', 'one.md'), '# zeta');
    host.files.set(path.join(STORE, 'alpha', 'templates', 'extra', 'one.md'), '# alpha');
    const resolved = await resolveTemplate('extra/one', ctxFor(host));
    expect(resolved.content).toBe('# alpha');
  });

  it('store 目录为空 / 不存在 → 落入未命中分支', async () => {
    const host = createDirAwareHost();
    await expectConfigError(resolveTemplate('extra/one', ctxFor(host)));
  });

  it('四处均未命中 → ConfigError(2)，message 含 id，hint 指向 template list', async () => {
    const host = createDirAwareHost();
    host.files.set(path.join(STORE, 'src-a', 'templates', 'other', 'tpl.md'), '# unrelated');
    const err = await expectConfigError(resolveTemplate('missing/tpl', ctxFor(host)));
    expect(err.message).toContain('missing/tpl');
    expect(err.hint).toContain('aforge template list');
  });
});

describe('resolveTemplate 非法 id（防路径逃逸）', () => {
  it.each(['../escape', 'a/../../etc/passwd', 'back\\slash', '', '/absolute', 'a//b', '.'])(
    'id "%s" → ConfigError(2)',
    async (id) => {
      await expectConfigError(resolveTemplate(id, ctxFor(createDirAwareHost())));
    },
  );
});
