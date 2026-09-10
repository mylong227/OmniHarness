/** 服务容器：注册/覆盖/获取任意端口实现（定制接入的入口）。 */
export class Container {
  private readonly services = new Map<string, unknown>();

  /** 注册服务；重名即抛错。 */
  public register<T>(key: string, instance: T): void {
    if (this.services.has(key)) {
      throw new Error(`服务重复注册: ${key}`);
    }
    this.services.set(key, instance);
  }

  /** 覆盖服务（自定义接入时替换默认实现）。 */
  public overwrite<T>(key: string, instance: T): void {
    this.services.set(key, instance);
  }

  /** 获取服务；不存在即抛错。 */
  public get<T>(key: string): T {
    const value = this.services.get(key);
    if (value === undefined) {
      throw new Error(`服务未注册: ${key}`);
    }
    return value as T;
  }

  /** 服务是否存在。 */
  public has(key: string): boolean {
    return this.services.has(key);
  }
}
