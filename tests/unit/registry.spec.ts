/**
 * 泛型 Registry 单测：register / get / has / ids / list、重复注册冲突、惰性工厂、缓存，
 * 以及运行时**后补注册**的可见性语义（Phase 3 target 全集动态派生的前提）。
 */
import { describe, expect, it } from 'vitest';
import { GenericError } from '../../src/core/errors';
import { Registry } from '../../src/core/registry';

describe('Registry<T>', () => {
  it('register + get：工厂返回实例', () => {
    const registry = new Registry<{ id: string }>();
    registry.register('a', () => ({ id: 'a' }));
    expect(registry.get('a')).toEqual({ id: 'a' });
  });

  it('get 未知 id → undefined', () => {
    const registry = new Registry<number>();
    expect(registry.get('missing')).toBeUndefined();
  });

  it('has：已注册 true / 未注册 false（不触发实例化）', () => {
    let factoryCalls = 0;
    const registry = new Registry<number>();
    registry.register('a', () => {
      factoryCalls += 1;
      return 42;
    });
    expect(registry.has('a')).toBe(true);
    expect(registry.has('b')).toBe(false);
    expect(factoryCalls).toBe(0); // has 不实例化
  });

  it('重复注册同一 id → GenericError(1)', () => {
    const registry = new Registry<string>();
    registry.register('a', () => 'first');
    expect(() => registry.register('a', () => 'second')).toThrow(GenericError);
    expect(registry.get('a')).toBe('first'); // 首次注册仍生效
  });

  it('工厂惰性：首次 get 触发一次，后续 get 复用缓存实例', () => {
    let factoryCalls = 0;
    const registry = new Registry<object>();
    registry.register('a', () => {
      factoryCalls += 1;
      return { marker: true };
    });
    expect(factoryCalls).toBe(0);
    const first = registry.get('a');
    const second = registry.get('a');
    expect(factoryCalls).toBe(1);
    expect(second).toBe(first); // 同一实例（缓存）
  });

  it('list：按注册顺序返回全部实例（触发未实例化的工厂）', () => {
    const registry = new Registry<string>();
    registry.register('second', () => '2');
    registry.register('first', () => '1');
    expect(registry.get('second')).toBe('2');
    registry.register('third', () => '3');
    expect(registry.list()).toEqual(['2', '1', '3']);
  });

  it('空注册表：list 为空数组', () => {
    const registry = new Registry<unknown>();
    expect(registry.list()).toEqual([]);
  });

  it('ids：按注册顺序返回 id 且不触发实例化', () => {
    let factoryCalls = 0;
    const registry = new Registry<string>();
    registry.register('second', () => {
      factoryCalls += 1;
      return '2';
    });
    registry.register('first', () => '1');
    expect(registry.ids()).toEqual(['second', 'first']);
    expect(factoryCalls).toBe(0);
  });
});

/**
 * 后补注册（运行时 register）语义：容器内不存在「一次算好」的快照，
 * register 之后 ids / list / has / get 立刻反映新项——这是 Phase 3
 * 「target 全集从注册表动态派生」的前提（旧 REGISTERED_PROJECTORS 是模块级快照，
 * 后补注册永远不可见）。
 */
describe('Registry<T> 后补注册语义', () => {
  it('register 后 ids / list / has / get 立刻反映新项', () => {
    const registry = new Registry<string>();
    registry.register('a', () => 'A');
    // 先消费一次（旧实现在此刻算快照）
    expect(registry.list()).toEqual(['A']);
    expect(registry.ids()).toEqual(['a']);

    registry.register('late', () => 'LATE');
    expect(registry.ids()).toEqual(['a', 'late']);
    expect(registry.list()).toEqual(['A', 'LATE']);
    expect(registry.has('late')).toBe(true);
    expect(registry.get('late')).toBe('LATE');
  });

  it('后补注册撞已有 id → 仍是 GenericError(1)，原实例不被替换', () => {
    const registry = new Registry<string>();
    registry.register('a', () => 'A');
    expect(registry.get('a')).toBe('A');
    expect(() => registry.register('a', () => 'A2')).toThrow(GenericError);
    expect(registry.get('a')).toBe('A');
    expect(registry.ids()).toEqual(['a']);
  });

  it('后补注册不影响未知 id 的降级语义（get → undefined / has → false）', () => {
    const registry = new Registry<string>();
    registry.register('a', () => 'A');
    registry.register('late', () => 'LATE');
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.has('missing')).toBe(false);
  });
});
