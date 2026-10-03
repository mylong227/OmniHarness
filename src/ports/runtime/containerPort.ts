import type { ServiceKeyLike } from './serviceKeyLike.js';

/**
 * @beta
 * 服务容器端口：注册/覆盖/获取任意端口实现（定制接入的入口）。
 *
 * 由 `core/container.ts` 的 `Container` 实现；插件上下文、组合根、子代理运行时等仅依赖本端口契约，
 * 不再反向依赖 core 层，从而解除 `ports→core` 的 `[3.5]` 禁边。
 *
 * ## 两种键形态（G26/TS2，2026-10-03 第十三轮）
 *
 * 每个方法都有**两条重载**：
 *  1. **泛型令牌**（{@link ServiceKeyLike}，实现类是 `core/serviceKey.ts` 的 `ServiceKey<T>`）——
 *     **推荐**：键与值类型绑定，注册类型不符即**编译失败**，取用无需调用点断言；
 *  2. **字符串键**——保留给第三方插件作者用自造键扩展（此时类型由调用方负责，容器无法校验）。
 * 新增令牌形态是**加法式**改动：既有字符串调用点零改动。
 */
export interface ContainerPort {
  /**
   * 注册服务；重名即抛错（令牌形态：`instance` 必须与令牌的值类型一致）。
   * @param key 服务令牌。
   * @param instance 服务实例。
   * @returns 无返回值。
   */
  register<T>(key: ServiceKeyLike<T>, instance: T): void;

  /**
   * 注册服务；重名即抛错（字符串键形态：类型由调用方负责）。
   * @param key 服务键（端口/契约名）。
   * @param instance 服务实例。
   * @returns 无返回值。
   */
  register(key: string, instance: unknown): void;

  /**
   * 覆盖服务（令牌形态）。
   * @param key 服务令牌。
   * @param instance 替换后的服务实例。
   * @returns 无返回值。
   */
  overwrite<T>(key: ServiceKeyLike<T>, instance: T): void;

  /**
   * 覆盖服务（字符串键形态）。
   * @param key 服务键（须已注册或首次注册均可）。
   * @param instance 替换后的服务实例。
   * @returns 无返回值。
   */
  overwrite(key: string, instance: unknown): void;

  /**
   * 获取服务；不存在即抛错（令牌形态：返回类型由令牌推导，**无需**调用点断言）。
   * @param key 服务令牌。
   * @returns 该键下的服务实例。
   */
  get<T>(key: ServiceKeyLike<T>): T;

  /**
   * 获取服务；不存在即抛错（字符串键形态：类型由调用方标注，属**调用点断言**）。
   * @param key 服务键。
   * @returns 注册表中的服务实例（按调用方标注的类型收窄）。
   */
  get<T>(key: string): T;

  /**
   * 服务是否存在（令牌与字符串键皆可）。
   * @param key 服务令牌或服务键。
   * @returns 已注册时为 true。
   */
  has(key: ServiceKeyLike<unknown> | string): boolean;
}
