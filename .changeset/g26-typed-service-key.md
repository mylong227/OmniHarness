---
'@mylong227/omniharness': patch
---

**泛型服务令牌**：容器注册/取用从"调用点断言"变为"类型受检"（G26，TS2）。

## 问题

`Container` 此前是 `register(key: string, instance: unknown)` + `get<T>(key: string): T`：
**键与值的类型在类型层毫无关联**——`get<T>` 的 `T` 纯属调用点断言（实现就是 `return value as T`）。
于是"把 A 端口注册到 B 键"与"取用时写错类型"都要到**运行期**才炸。

## 改动

1. 新增端口契约 `src/ports/runtime/serviceKeyLike.ts`（`ServiceKeyLike<T>`，含**类型烙印**
   `__serviceType`；端口层不许有 class，故此处只有接口）+ 实现类 `src/core/serviceKey.ts`
   （`ServiceKey<T>`，烙印用 `declare` ⇒ 运行期**不产生字段**，只有一个 `name`）。
2. `ContainerPort` / `Container` 每个方法新增**令牌重载**（保留字符串重载 ⇒ 第三方插件用自造键扩展不受影响）：
   注册时 `instance` 必须匹配令牌的值类型；`get(令牌)` 直接推导类型、**零断言**。
3. `ServiceKeys` 的六个键由字符串常量升级为 `ServiceKey<对应端口>`：`model`/`tools`/`storage`/
   `events`/`sandbox`/`approvals`。**令牌名与历史字符串键逐字一致**（`'port.model'` …），
   故既有注册点（`runtime.ts` / `pluginHost.ts` / `subagentRuntimeFactory.ts` / 测试）**零改动**通过。

## 判据（`tests/unit/typedServiceKey.test.ts` 4 例 + 编译期断言）

- **类型层**（写在**不执行**的函数里）：错键注册、错类型覆盖、自造令牌与标准键混用 —— 三处
  `@ts-expect-error`；若类型系统**没**拦住，`tsc` 会因"未使用的 `@ts-expect-error` 指令"而红
  （`npm run typecheck` 是门禁的一部分）。正例同时断言"令牌形态无需显式泛型参数即得正确类型"。
- **运行期**：① 令牌名与历史键名逐字一致（兼容）；② 令牌与字符串键指向同一桶（互操作）；
  ③ 重名/未注册抛错、覆盖生效（语义不变）；④ 令牌是 `{ name }` 单字段对象（烙印不落地）。

## 过程记录（两处真问题，都已修）

1. **只在类上写实现签名 ⇒ 类型检查被吃掉**：`Container.register` 起初只写联合类型实现签名
   （`instance: unknown`），调用点于是走实现签名，`unknown` 接受一切 ⇒ 令牌检查在**类实例上完全失效**。
   是那三条 `@ts-expect-error` 被判"**未使用**"（`TS2578 × 3`）才暴露的——这本身就是本判据的
   **变异证据**：把重载去掉，门禁立刻变红。修法：接口与类**同形重复声明重载**。
2. 我的用例首版把"未注册抛错"写成 `has('port.nope') && get('port.nope')`——`has` 返回 false **短路**，
   `get` 根本没执行 ⇒ 判据假绿（运行时报 "Missing expected exception" 才发现）。已拆成两条断言。

## 验证

`tsc --noEmit` 零错误；`npm test` 全绿（新 4 例 + 既有 `container.test.ts` 全过，注册点零改动）；
`arch:gate`（ports 纯度：新增端口文件只有接口，无 class）/ `check --strict` / `lint`（0 告警）/
`audit:config-wiring` / `audit:maturity` / `check:doc-links` / `api:check` / `audit:standard:delta` /
`rust:test` / `web:test` 全绿。
