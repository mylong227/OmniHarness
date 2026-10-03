/**
 * **服务令牌契约**（TS2/G26，2026-10-03 第十三轮）。
 *
 * ## 为什么要它
 *
 * 容器原先是 `register(key: string, instance: unknown)` + `get<T>(key: string): T`：
 * **键与值的类型在类型层毫无关联**——`get<T>(...)` 的 `T` 完全是**调用点断言**
 * （实现里就是 `return value as T`）。后果有两类：注册时把 A 端口塞进 B 键不报错；
 * 取用时写错类型也不报错，直到运行期才炸。
 *
 * 本契约把"键"与"值的类型"绑在一起：`get`/`register` 接令牌即可**零断言**地拿到正确类型，
 * 且注册时**类型不符即编译失败**。
 *
 * ## 为什么这里只有接口、没有类
 *
 * 端口层纪律：`src/ports/**` 不允许出现 `class`（`architectureGate` 的 `[3] ports 纯度` 规则）——
 * 端口只声明契约不提供实现。故令牌的**实现类**在 `src/core/serviceKey.ts`，本文件只给结构契约；
 * 类在结构上满足本接口，两侧零耦合。
 *
 * ## 类型烙印为什么是可选属性
 *
 * `__serviceType` 只参与类型检查、运行期**不存在**（实现侧用 `declare` 声明）。做成可选属性是为了
 * 让结构兼容成立；同时它足以让 `ServiceKey<A>` 与 `ServiceKey<B>` **互不可赋值**（协变检查），
 * 从而真正拦住"注册类型不符"。
 */
export interface ServiceKeyLike<T> {
  /** 键名（容器注册表里的实际键）。 */
  readonly name: string;
  /**
   * 类型烙印：把该令牌指向的值类型钉在类型层（运行期不存在，故为可选）。
   *
   * 显式写出 `| undefined` 以配合 `exactOptionalPropertyTypes`：实现侧声明为 `declare ... | undefined`。
   */
  readonly __serviceType?: T | undefined;
}
