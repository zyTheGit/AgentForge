/**
 * 泛型注册表（M6）：id → 工厂 → 惰性实例 + 缓存。
 *
 * 用途：projector 四件套（engine / status / doctor 统一经注册表获取），
 * 后续 adapter 插件化（Spec Phase 3）复用同一容器语义。
 *
 * 约定：
 * - register 的工厂只在首次 get 时调用（惰性），实例按 id 缓存；
 * - 重复注册同一 id → GenericError(1)（编码期错误，fail-fast 暴露装配问题）；
 * - list() 按注册顺序返回全部实例（未实例化的工厂此时触发实例化）；
 * - get() 对未知 id 返回 undefined，由调用方决定报错或降级
 *   （engine 将其记入 skippedTargets 而非失败，Spec §7.3）。
 */
import { GenericError } from './errors';

export class Registry<T> {
  private readonly factories = new Map<string, () => T>();
  private readonly instances = new Map<string, T>();

  /** 注册 id 与实例工厂；重复注册同一 id → GenericError(1)。 */
  register(id: string, factory: () => T): void {
    if (this.factories.has(id)) {
      throw new GenericError(`registry: id 已注册: ${id}`, {
        hint: '检查注册表装配代码，同一 id 只允许注册一次',
        details: { id, registeredIds: [...this.factories.keys()] },
      });
    }
    this.factories.set(id, factory);
  }

  /** 按 id 取实例（首次访问触发工厂调用并缓存）；未知 id → undefined。 */
  get(id: string): T | undefined {
    const factory = this.factories.get(id);
    if (factory === undefined) {
      return undefined;
    }
    let instance = this.instances.get(id);
    if (instance === undefined) {
      instance = factory();
      this.instances.set(id, instance);
    }
    return instance;
  }

  /** id 是否已注册（不触发实例化）。 */
  has(id: string): boolean {
    return this.factories.has(id);
  }

  /** 全部已注册实例（按注册顺序；惰性工厂在此实例化）。 */
  list(): readonly T[] {
    return [...this.factories.keys()].map((id) => this.get(id) as T);
  }
}
