/**
 * @beta
 * 服务容器端口：注册/覆盖/获取任意端口实现（定制接入的入口）。
 *
 * 由 `core/container.ts` 的 `Container` 实现；插件上下文、组合根、子代理运行时等仅依赖本端口契约，
 * 不再反向依赖 core 层，从而解除 `ports→core` 的 `[3.5]` 禁边。
 */
export interface ContainerPort {
  /**
   * 注册服务；重名即抛错。
   * @param key 服务键（端口/契约名）。
   * @param instance 服务实例。
   * @returns 无返回值。
   */
  register<T>(key: string, instance: T): void;

  /**
   * 覆盖服务（自定义接入时替换默认实现）。
   * @param key 服务键（须已注册或首次注册均可）。
   * @param instance 替换后的服务实例。
   * @returns 无返回值。
   */
  overwrite<T>(key: string, instance: T): void;

  /**
   * 获取服务；不存在即抛错。
   * @param key 服务键。
   * @returns 注册表中的服务实例（按调用方标注的类型收窄）。
   */
  get<T>(key: string): T;

  /**
   * 服务是否存在。
   * @param key 服务键。
   * @returns 已注册时为 true。
   */
  has(key: string): boolean;
}
