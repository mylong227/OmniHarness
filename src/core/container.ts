/** 服务容器：注册/覆盖/获取任意端口实现（定制接入的入口）。 */
export class Container {
  /** 服务注册表（key → 实例），定制接入的端口实现都挂在这里。 */
  private readonly services = new Map<string, unknown>();

  /**
   * 注册服务；重名即抛错。
   * @param key 服务键（端口/契约名）。
   * @param instance 服务实例。
   */
  public register<T>(key: string, instance: T): void {
    if (this.services.has(key)) {
      throw new Error(`服务重复注册: ${key}`);
    }
    this.services.set(key, instance);
  }

  /**
   * 覆盖服务（自定义接入时替换默认实现）。
   * @param key 服务键（须已注册或首次注册均可）。
   * @param instance 替换后的服务实例。
   */
  public overwrite<T>(key: string, instance: T): void {
    this.services.set(key, instance);
  }

  /**
   * 获取服务；不存在即抛错。
   * @param key 服务键。
   * @returns 注册表中的服务实例（按调用方标注的类型收窄）。
   */
  public get<T>(key: string): T {
    const value = this.services.get(key);
    if (value === undefined) {
      throw new Error(`服务未注册: ${key}`);
    }
    return value as T;
  }

  /**
   * 服务是否存在。
   * @param key 服务键。
   * @returns 已注册时为 true。
   */
  public has(key: string): boolean {
    return this.services.has(key);
  }
}
