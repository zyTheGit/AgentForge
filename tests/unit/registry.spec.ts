/**
 * 泛型 Registry 单测：register / get / has / list、重复注册冲突、惰性工厂、缓存。
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
});
