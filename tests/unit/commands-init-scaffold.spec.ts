/**
 * commands/lifecycle/init-scaffold 的两个共享构造器单测。
 *
 * 二者的存在理由都是"同一份事实只算一次"：
 * - sotSubdirPaths：物化落盘、交互第⑤步 note 文案、取消清单三处共用同一份子目录
 *   绝对路径；各自 `path.join(sotRoot, dir)` 时，SOT_SUBDIRS 一改就会分叉；
 * - habitsSkeleton：非交互 runInit 与 `init -i` 的 ③ edit 分支共用同一份初始骨架，
 *   类型断言（DetectedSnapshot → looseObject 的索引签名输入）只收敛在这一处。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  habitsSkeleton,
  SOT_SUBDIRS,
  sotSubdirPaths,
} from '../../src/commands/lifecycle/init-scaffold';
import { defaultHabits } from '../../src/core/config/defaults';
import type { DetectedSnapshot } from '../../src/core/detector/engine';
import { HabitsSchema } from '../../src/schema';
import { abs } from './test-utils';

const SOT = abs('proj', '.agentforge');

/** 最小探测快照（字段齐全即可，本用例不关心探测逻辑）。 */
function detection(): DetectedSnapshot {
  return {
    node: { manager: 'fnm', source: 'path' },
    python: { manager: 'uv', source: 'path' },
    package_managers: [{ name: 'pnpm', source: 'package.json' }],
    shell: 'pwsh',
    existing_rules: ['AGENTS.md'],
    rust: { manager: 'none', source: 'none' },
    go: { manager: 'none', source: 'none' },
  };
}

describe('sotSubdirPaths', () => {
  it('逐项等于 SOT_SUBDIRS 在 sotRoot 下的 join（顺序一致）', () => {
    expect(sotSubdirPaths(SOT)).toEqual(SOT_SUBDIRS.map((dir) => path.join(SOT, dir)));
  });

  it('返回绝对路径且数量与 SOT_SUBDIRS 相同（三处调用点不会各算一份）', () => {
    const paths = sotSubdirPaths(SOT);
    expect(paths).toHaveLength(SOT_SUBDIRS.length);
    for (const p of paths) {
      expect(path.isAbsolute(p)).toBe(true);
      expect(path.dirname(p)).toBe(SOT);
    }
  });

  it('每次返回新数组（调用方可安全 push / sort）', () => {
    expect(sotSubdirPaths(SOT)).not.toBe(sotSubdirPaths(SOT));
  });
});

describe('habitsSkeleton', () => {
  it('= 声明字段缺省 + detected 快照原样（键与顺序均与 defaultHabits 一致）', () => {
    const snapshot = detection();
    const skeleton = habitsSkeleton(snapshot);
    expect(skeleton).toEqual({ ...defaultHabits(), detected: snapshot });
    expect(Object.keys(skeleton)).toEqual(Object.keys({ ...defaultHabits(), detected: {} }));
  });

  it('detected 承载探测快照的全部键（passthrough，不裁字段）', () => {
    const skeleton = habitsSkeleton(detection());
    expect(Object.keys(skeleton.detected ?? {}).sort()).toEqual(
      Object.keys(detection()).sort() as string[],
    );
  });

  it('产物可过 HabitsSchema 校验（断言收敛未绕过运行时校验）', () => {
    const parsed = HabitsSchema.parse(habitsSkeleton(detection()));
    expect(parsed.version).toBe(1);
    expect(parsed.detected).toMatchObject({ shell: 'pwsh' });
  });
});
