import type { ContainerPort } from '../ports/runtime/containerPort.js';
import type { ServiceKeyLike } from '../ports/runtime/serviceKeyLike.js';

/** 服务容器：注册/覆盖/获取任意端口实现（定制接入的入口）。 */
export class Container implements ContainerPort {
  /** 服务注册表（键名 → 实例），定制接入的端口实现都挂在这里。 */
  private readonly services = new Map<string, unknown>();

  /**
   * 键的字符串化：令牌取 `name`，字符串键原样。
   *
   * 为什么做成静态私有方法而不是模块级函数：本仓铁律不允许 `src/**` 出现顶层函数
   * （`auditTopLevelFunctions` 门禁），且该转换只有本类用得上。
   * @param key 服务令牌或字符串键。
   * @returns 注册表里使用的实际键名。
   */
  private static nameOf(key: ServiceKeyLike<unknown> | string): string {
    return typeof key === 'string' ? key : key.name;
  }

  /**
   * 注册服务；重名即抛错（令牌形态：`instance` 必须与令牌的值类型一致）。
   *
   * **必须在此重复声明重载**：只写实现签名（联合类型 + `instance: unknown`）会让调用点
   * 走实现签名 ⇒ `unknown` 接受一切 ⇒ 令牌的类型检查在**类实例**上完全失效
   * （2026-10-03 实测：`@ts-expect-error` 指令被判"未使用"才发现）。接口与类必须同形。
   * @param key 服务令牌。
   * @param instance 服务实例。
   * @returns 无返回值。
   */
  public register<T>(key: ServiceKeyLike<T>, instance: T): void;
  /**
   * 注册服务；重名即抛错（字符串键形态：类型由调用方负责）。
   * @param key 服务键。
   * @param instance 服务实例。
   * @returns 无返回值。
   */
  public register(key: string, instance: unknown): void;
  /**
   * 注册实现（两条重载共用）。
   * @param key 服务令牌或字符串键。
   * @param instance 服务实例。
   * @returns 无返回值。
   */
  public register(key: ServiceKeyLike<unknown> | string, instance: unknown): void {
    const name = Container.nameOf(key);
    if (this.services.has(name)) {
      throw new Error(`服务重复注册: ${name}`);
    }
    this.services.set(name, instance);
  }

  /**
   * 覆盖服务（令牌形态）。
   * @param key 服务令牌。
   * @param instance 替换后的服务实例。
   * @returns 无返回值。
   */
  public overwrite<T>(key: ServiceKeyLike<T>, instance: T): void;
  /**
   * 覆盖服务（字符串键形态）。
   * @param key 服务键（须已注册或首次注册均可）。
   * @param instance 替换后的服务实例。
   * @returns 无返回值。
   */
  public overwrite(key: string, instance: unknown): void;
  /**
   * 覆盖实现（两条重载共用）。
   * @param key 服务令牌或字符串键。
   * @param instance 替换后的服务实例。
   * @returns 无返回值。
   */
  public overwrite(key: ServiceKeyLike<unknown> | string, instance: unknown): void {
    this.services.set(Container.nameOf(key), instance);
  }

  /**
   * 获取服务；不存在即抛错（令牌形态：返回类型由令牌推导，**无需**调用点断言）。
   * @param key 服务令牌。
   * @returns 该键下的服务实例。
   */
  public get<T>(key: ServiceKeyLike<T>): T;
  /**
   * 获取服务；不存在即抛错（字符串键形态：类型由调用方标注，属**调用点断言**）。
   * @param key 服务键。
   * @returns 注册表中的服务实例（按调用方标注的类型收窄）。
   */
  public get<T>(key: string): T;
  /**
   * 取实现（两条重载共用）：令牌形态返回**由令牌推导**的类型（零调用点断言）；
   * 字符串键形态仍按调用方标注收窄（历史用法保留：第三方插件用自造键扩展时容器无从校验）。
   * @param key 服务令牌或字符串键。
   * @returns 注册表中的服务实例。
   */
  public get<T>(key: ServiceKeyLike<T> | string): T {
    const name = Container.nameOf(key);
    const value = this.services.get(name);
    if (value === undefined) {
      throw new Error(`服务未注册: ${name}`);
    }
    return value as T;
  }

  /**
   * 服务是否存在。
   * @param key 服务令牌或字符串键。
   * @returns 已注册时为 true。
   */
  public has(key: ServiceKeyLike<unknown> | string): boolean {
    return this.services.has(Container.nameOf(key));
  }
}

export type { ContainerPort } from '../ports/runtime/containerPort.js';
