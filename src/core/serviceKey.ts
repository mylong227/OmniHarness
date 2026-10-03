import type { ServiceKeyLike } from '../ports/runtime/serviceKeyLike.js';

/**
 * **泛型服务令牌**（TS2/G26，2026-10-03 第十三轮）：把一个键与"该键下的值类型"绑定。
 *
 * ## 它解决了什么
 *
 * 此前 `get<T>(key: string): T` 的 `T` 是**调用点断言**（实现就是 `value as T`），
 * 键与类型在类型层毫无关系 ⇒ 注册串键、取用写错类型都不报错，直到运行期才炸。
 * 用令牌后：
 *  - `container.register(ServiceKeys.tools, toolPort)`：**类型不符即编译失败**（拿 A 端口注册到 B 键直接红）；
 *  - `const tools = container.get(ServiceKeys.tools)`：**无需显式泛型参数**、无需断言，类型自动推导。
 *
 * ## 为什么类在 core 而不在 ports
 *
 * `src/ports/**` 不允许有 `class`（端口只声明契约）⇒ 契约是 `ServiceKeyLike<T>`（结构接口，见其 JSDoc），
 * 实现类住在这里，结构上满足它。
 *
 * ## 运行期开销
 *
 * 只有一个 `name` 字符串字段。类型烙印 `__serviceType` 用 `declare` 声明 ⇒ **不产生任何字段**，
 * 编译后等价于 `{ name }`。
 */
export class ServiceKey<T> implements ServiceKeyLike<T> {
  /**
   * 类型烙印：仅参与类型检查，运行期不存在（`declare` 不生成字段）。
   *
   * 显式写出 `| undefined` 以配合 `exactOptionalPropertyTypes`。
   */
  declare public readonly __serviceType?: T | undefined;

  /**
   * @param name 键名（容器注册表里的实际键，建议用 `port.<域>` 形式）。
   */
  public constructor(public readonly name: string) {}

  /**
   * 字符串化：便于日志与错误消息里直接引用令牌（不必到处写 `.name`）。
   * @returns 键名。
   */
  public toString(): string {
    return this.name;
  }
}
