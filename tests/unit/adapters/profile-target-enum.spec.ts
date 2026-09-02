/**
 * `profile.yaml` 的 `targets` 取值域放开后的**诊断可区分性**（issue #53）。
 *
 * 同一个症状（schema 拒收某个 target id）有四类完全不同的成因，修法互不相通：
 *  1. 打错了 → 改 profile.yaml；
 *  2. 适配器文件坏了（YAML / schema / 模板 / 落点越界）→ 改 adapters/<id>.yaml；
 *  3. 适配器在 project 层被忽略 → 设 AGF_ALLOW_PROJECT_ADAPTERS=1；
 *  4. 压根没有那个文件 → 去 user 层 SoT 放一份。
 *
 * 只报「不是有效的 target」会让用户对着一个**没问题的** yaml 反复检查，所以这四类
 * 必须给出不同的话。本文件逐类固化。
 *
 * 同时固化取值域本身：内置四个恒可用；声明式 id 只有 `registerDeclarativeTargetId`
 * 登记过才可用（裸注册进 projectorRegistry 不算）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AdapterLoadReport,
  describeUnknownTargetId,
  resetAdapterLoadReport,
  setAdapterLoadReport,
} from '../../../src/core/adapters/diagnostics';
import {
  BUILTIN_TARGET_IDS,
  knownTargetIds,
  registerDeclarativeTargetId,
  resetDeclarativeTargetIds,
} from '../../../src/core/project/target-ids';
import { ProfileSchema } from '../../../src/schema';

const USER_FILE = 'C:\\Users\\u\\.agentforge\\adapters\\my-agent.yaml';
const PROJECT_FILE = 'C:\\proj\\.agentforge\\adapters\\team-agent.yaml';

function report(overrides: Partial<AdapterLoadReport>): void {
  setAdapterLoadReport({ loaded: [], ignored: [], failures: [], scanned: [], ...overrides });
}

/** 取 ProfileSchema 拒收某个 target 时的消息（这是用户真正看到的那句话）。 */
function parseError(id: string): string {
  const result = ProfileSchema.safeParse({ version: 1, targets: [id] });
  expect(result.success, `${id} 应被拒收`).toBe(false);
  return result.success ? '' : result.error.issues.map((issue) => issue.message).join('\n');
}

afterEach(() => {
  resetDeclarativeTargetIds();
  resetAdapterLoadReport();
});

describe('TargetEnum — 取值域', () => {
  it('内置四个恒可用', () => {
    expect(() =>
      ProfileSchema.parse({ version: 1, targets: [...BUILTIN_TARGET_IDS] }),
    ).not.toThrow();
  });

  it('登记过的声明式 id 可写进 profile.targets（这就是"放开 TargetEnum"）', () => {
    expect(() => ProfileSchema.parse({ version: 1, targets: ['my-agent'] })).toThrow();
    registerDeclarativeTargetId('my-agent');
    expect(knownTargetIds()).toEqual([...BUILTIN_TARGET_IDS, 'my-agent']);
    expect(() => ProfileSchema.parse({ version: 1, targets: ['my-agent'] })).not.toThrow();
  });

  it('每次校验都现读 id 表（enum 会把取值域冻结在模块加载时刻，适配器晚于它加载）', () => {
    expect(() => ProfileSchema.parse({ version: 1, targets: ['late'] })).toThrow();
    registerDeclarativeTargetId('late');
    // 同一个 schema 对象，无需重建
    expect(() => ProfileSchema.parse({ version: 1, targets: ['late'] })).not.toThrow();
  });
});

describe('TargetEnum — 四类成因给出四种话', () => {
  it('1. 打错了：与已注册 id 只差一个字符 → 报"是否想写 X"', () => {
    registerDeclarativeTargetId('my-agent');
    const message = parseError('my-agnt');
    expect(message).toContain('是否想写 my-agent');
    expect(message).toContain('当前可用: opencode, codex, claude, pi, my-agent');
    // 不能把它说成「文件不存在」——用户会去建一个不该存在的文件
    expect(message).not.toContain('没有对应的声明式适配器文件');
  });

  it('2. 适配器文件坏了：报具体成因 + 文件路径 + "修好该文件后才能写进 profile"', () => {
    report({
      failures: [
        {
          id: 'my-agent',
          file: USER_FILE,
          layer: 'user',
          kind: 'yaml',
          message: '第 3 行缩进错误',
          hint: '检查缩进',
        },
      ],
      scanned: ['C:\\Users\\u\\.agentforge\\adapters'],
    });
    const message = parseError('my-agent');
    expect(message).toContain('YAML 解析失败');
    expect(message).toContain(USER_FILE);
    expect(message).toContain('第 3 行缩进错误');
    expect(message).toContain('修好该文件后 my-agent 才能写进 profile.yaml');
  });

  it('2b. 成因分类逐条落到不同文案（越界 / 模板 / id 冲突各说各的）', () => {
    const kinds = [
      ['containment', '越出允许的根目录'],
      ['template', '路径模板非法'],
      ['builtin-id', '撞内置 target id'],
      ['schema', 'schema 校验失败'],
      ['limit', '超出数量上限'],
      ['io', '读不出来'],
    ] as const;
    for (const [kind, expected] of kinds) {
      report({
        failures: [{ id: 'x', file: USER_FILE, layer: 'user', kind, message: 'm', hint: 'h' }],
      });
      expect(describeUnknownTargetId('x', [...BUILTIN_TARGET_IDS]), kind).toContain(expected);
    }
  });

  it('3. project 层被忽略：说清"文件存在但没授权"并给出授权办法', () => {
    report({
      ignored: [
        {
          id: 'team-agent',
          file: PROJECT_FILE,
          layer: 'project',
          reason: 'project-layer-not-authorized',
        },
      ],
    });
    const message = parseError('team-agent');
    expect(message).toContain('适配器文件存在但位于 project 层');
    expect(message).toContain(PROJECT_FILE);
    expect(message).toContain('AGF_ALLOW_PROJECT_ADAPTERS=1');
    // 关键：不能报成「文件不存在」，那会让用户以为自己放错了目录
    expect(message).not.toContain('没有对应的声明式适配器文件');
  });

  it('4. 压根没有：说清扫过哪些目录 + 该往哪放', () => {
    report({ scanned: ['C:\\Users\\u\\.agentforge\\adapters', 'C:\\proj\\.agentforge\\adapters'] });
    const message = parseError('ghost');
    expect(message).toContain('既不是内置 target，也没有对应的声明式适配器文件');
    expect(message).toContain('已扫描: C:\\Users\\u\\.agentforge\\adapters');
    expect(message).toContain('adapters/ghost.yaml');
  });

  it('4b. 从未加载过（空报告）→ 提示里给出默认位置而不是空括号', () => {
    expect(parseError('ghost')).toContain('<userSoT>/adapters/');
  });

  it('失败优先于忽略、忽略优先于拼写猜测（同一 id 命中多类时报最靠前的成因）', () => {
    registerDeclarativeTargetId('my-agent');
    report({
      failures: [
        { id: 'my-agnt', file: USER_FILE, layer: 'user', kind: 'schema', message: 'm', hint: 'h' },
      ],
    });
    // 既像 my-agent 的错拼、又确实有一个同名文件加载失败 → 报后者（那才是真正的阻塞点）
    expect(parseError('my-agnt')).toContain('schema 校验失败');
  });
});
