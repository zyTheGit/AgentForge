/**
 * 路径模板的语法与白名单校验（issue #53 安全边界 2）。
 *
 * 这层与 containment 分工明确：本模块只看**字符串**（能不能写、变量是否白名单），
 * containment 看**求值结果落在哪**。两道都必须有——只有前者，环境变量值里带 `..`
 * 就能绕过；只有后者，`{env:PATH}` 这种非白名单变量会被当成合法输入。
 *
 * 覆盖的绕过尝试：自由绝对路径、相对路径、`..` 段、`.` 段、盘符跳变（靠段内 `:`
 * 非法字符）、非白名单环境变量、`{env:}` 空名、`{base}` 自引用、未知变量、
 * 段数超限、段长超限、控制字符与 Windows 保留符号。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADAPTER_MAX_PATH_DEPTH } from '../../../src/core/adapters/limits';
import {
  AdapterTemplateError,
  baseCandidatesOf,
  parsePathTemplate,
  renderBase,
  renderPathTemplate,
  type TemplateBindings,
} from '../../../src/core/adapters/templates';

const api = path.win32;
const FIELD = 'scopes.user.main_rule';

/** 解析（默认允许 {base}，与 base 之外的模板一致）。 */
function parse(template: string, allowBase = true) {
  return parsePathTemplate(template, { allowBase, field: FIELD });
}

function expectRejected(template: string, allowBase = true): AdapterTemplateError {
  let caught: unknown;
  try {
    parse(template, allowBase);
  } catch (err) {
    caught = err;
  }
  expect(caught, `模板 ${JSON.stringify(template)} 应被拒绝`).toBeInstanceOf(AdapterTemplateError);
  const error = caught as AdapterTemplateError;
  expect(error.message).toContain(FIELD); // 提示必须能定位到字段
  return error;
}

describe('parsePathTemplate — 合法形态', () => {
  it('{userHome} 开头 + 字面量段；反斜杠与正斜杠等价', () => {
    expect(parse('{userHome}/.my/AGENTS.md')).toEqual({
      source: '{userHome}/.my/AGENTS.md',
      root: { kind: 'userHome' },
      segments: ['.my', 'AGENTS.md'],
    });
    expect(parse('{userHome}\\.my\\AGENTS.md').segments).toEqual(['.my', 'AGENTS.md']);
  });

  it('{projectRoot} / {base} / {env:CODEX_HOME} 均可作根变量', () => {
    expect(parse('{projectRoot}/.my').root).toEqual({ kind: 'projectRoot' });
    expect(parse('{base}/skills').root).toEqual({ kind: 'base' });
    expect(parse('{env:CODEX_HOME}/skills').root).toEqual({ kind: 'env', name: 'CODEX_HOME' });
  });

  it('只有变量、没有字面量段 → 段为空（base 常见写法）', () => {
    expect(parse('{base}').segments).toEqual([]);
  });

  it('重复分隔符不产生空段（{base}//skills 与 {base}/skills 等价）', () => {
    expect(parse('{base}//skills').segments).toEqual(['skills']);
  });
});

describe('parsePathTemplate — 绕过尝试', () => {
  it('自由绝对路径（C:\\Windows\\...）→ 拒', () => {
    const err = expectRejected('C:\\Windows\\System32\\drivers\\etc\\hosts');
    expect(err.message).toContain('必须以变量开头');
  });

  it('相对路径（../../evil）→ 拒', () => {
    expectRejected('../../evil.md');
  });

  it('UNC 直写（\\\\server\\share）→ 拒（不以变量开头）', () => {
    expectRejected('\\\\server\\share\\evil.md');
  });

  it('`..` 段 → 拒（目录穿越入口）', () => {
    const err = expectRejected('{userHome}/../../Windows/evil.md');
    expect(err.message).toContain('".."');
  });

  it('`.` 段 → 拒（不是穿越，但也不该出现在声明里）', () => {
    expectRejected('{userHome}/./AGENTS.md');
  });

  it('段内含 `:`（盘符跳变 {userHome}/C:\\evil）→ 拒', () => {
    const err = expectRejected('{userHome}/C:\\evil.md');
    expect(err.message).toContain('非法字符');
  });

  it('非白名单环境变量 {env:PATH} → 拒，且提示列出白名单', () => {
    const err = expectRejected('{env:PATH}/evil.md');
    expect(err.message).toContain('不在白名单内');
    expect(err.hint).toContain('CODEX_HOME');
  });

  it('{env:} 缺变量名 → 拒', () => {
    // 注意：`{env:}` 不匹配 ROOT_RE（冒号后要求标识符），落到「必须以变量开头」
    expectRejected('{env:}/evil.md');
  });

  it('未知变量 {home} → 拒（白名单之外一个都不认）', () => {
    const err = expectRejected('{home}/evil.md');
    expect(err.message).toContain('未知变量');
  });

  it('冒号形式只对 env 开放（{userHome:X} → 拒）', () => {
    expectRejected('{userHome:X}/evil.md');
  });

  it('base 自身的模板里引用 {base} → 拒（自引用）', () => {
    const err = expectRejected('{base}/skills', false);
    expect(err.message).toContain('不能引用 {base}');
  });

  it('段数超过上限 → 拒（挡超深路径）', () => {
    const deep = `{userHome}/${Array.from({ length: ADAPTER_MAX_PATH_DEPTH + 1 }, () => 'x').join('/')}`;
    const err = expectRejected(deep);
    expect(err.message).toContain('超过上限');
  });

  it('单段过长（>128）→ 拒', () => {
    const err = expectRejected(`{userHome}/${'x'.repeat(129)}`);
    expect(err.message).toContain('路径段过长');
  });

  it('段内含通配符 / 引号 / 控制字符 → 拒', () => {
    for (const bad of ['*', '?', '"', '<', '>', '|', '\u0001']) {
      expectRejected(`{userHome}/a${bad}b/x.md`);
    }
  });
});

describe('renderPathTemplate / renderBase — 求值', () => {
  const bindings: TemplateBindings = {
    projectRoot: 'C:\\repo',
    userHome: 'C:\\Users\\user',
    env: { CODEX_HOME: 'D:\\codex' },
  };

  it('按绑定拼出绝对路径', () => {
    expect(renderPathTemplate(parse('{userHome}/.my/AGENTS.md'), bindings, api)).toBe(
      'C:\\Users\\user\\.my\\AGENTS.md',
    );
    expect(renderPathTemplate(parse('{env:CODEX_HOME}/skills'), bindings, api)).toBe(
      'D:\\codex\\skills',
    );
  });

  it('根变量取不到值 → undefined（不是抛错，也不是拼出半截路径）', () => {
    const noHome: TemplateBindings = { ...bindings, userHome: undefined };
    expect(renderPathTemplate(parse('{userHome}/.my'), noHome, api)).toBeUndefined();
    expect(renderPathTemplate(parse('{env:XDG_CONFIG_HOME}/x'), bindings, api)).toBeUndefined();
  });

  it('根变量取到的值不是绝对路径 → undefined（env 被塞相对路径时不能拼出相对落点）', () => {
    const relEnv: TemplateBindings = { ...bindings, env: { CODEX_HOME: '..\\elsewhere' } };
    expect(renderPathTemplate(parse('{env:CODEX_HOME}/skills'), relEnv, api)).toBeUndefined();
  });

  it('base 候选：取第一个可解析的（这就是 CODEX_HOME ?? ~/.codex 的声明式写法）', () => {
    const candidates = baseCandidatesOf(['{env:CODEX_HOME}', '{userHome}/.codex']).map((t) =>
      parsePathTemplate(t, { allowBase: false, field: 'scopes.user.base' }),
    );
    expect(renderBase(candidates, bindings, api)).toBe('D:\\codex');
    // 环境变量没设 → 落到第二候选
    expect(renderBase(candidates, { ...bindings, env: {} }, api)).toBe('C:\\Users\\user\\.codex');
    // 全部不可解析 → undefined（由调用方报「该 scope 无落点」）
    expect(
      renderBase(candidates, { ...bindings, env: {}, userHome: undefined }, api),
    ).toBeUndefined();
  });

  it('baseCandidatesOf：单字符串与数组归一为数组', () => {
    expect(baseCandidatesOf('{base}')).toEqual(['{base}']);
    expect(baseCandidatesOf(['a', 'b'])).toEqual(['a', 'b']);
  });
});
