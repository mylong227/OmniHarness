---
'omniharness': minor
---

**适配器名与存储后端名各收成一张表**（用户指定，结项审计 §3.4 的两项遗留）。

**动机**：审计 §3.4 记的「扩展接缝是改一处漏一处」还剩两项——① 模型适配器名 → 构造器的分支散在三处；
② 会话存储后端名 → 实现 + 缺省落盘路径内联在 `cliBuildConfig`（而 KV 后端另有同形工厂）。

**改动 1：模型适配器注册表**（`src/adapters/model/modelAdapterRegistry.ts`）

- `modelAdapterRegistry`：`id → { defaultsId, create }` 的**一张表**；这是全仓唯一允许 `new` 模型适配器的地方。
  兜底端点/模型/凭据 env 名仍来自 `defaults/endpoints.json`（改数据不改代码），表只持有构造器与引用。
- 三处构造分支改为查表：`cliBuildConfig.buildModel`（原 4 分支）、`configBuilder.buildRouterAdapter`（原 3 分支）、
  `providerProbe.buildModelForProvider`（原 2 分支）。未知 id 由调用方定夺：路由条目/厂商预设**抛错**，
  CLI **回落 mock**（`MOCK_ADAPTER_ID`）——与历史语义逐字一致。
- **顺带修掉一个真缺陷**：`configError.ENUM_VALUES.modelAdapter` **漏了 `llamacpp`**，而 `FileConfig` 类型与
  `cliEnums.MODEL_ADAPTERS` 都早已包含它 ⇒ 配置文件写 `"modelAdapter": "llamacpp"` 会被判非法
  （与 `approval` 的 `'plan'` 同型：声明支持、校验拒绝）。现三方一致性由测试机械核对。

**改动 2：会话存储工厂**（`src/cli/storageFactory.ts`）

- `StorageFactory.createFor(adapter, dir)`：后端名 → 实现 + 缺省落盘路径的**单一实现来源**
  （`DEFAULT_SQLITE_FILE` 成命名常量；sqlite 懒加载保留）；`cliBuildConfig.buildStorage` 退化为一次转发。

**机械防线**（`tests/unit/adapterFactories.test.ts` 6 例）：① 注册表 ↔ `cliEnums.MODEL_ADAPTERS` ↔ 配置校验
白名单三方一致（每个适配器名都必须能通过 `normalizeConfig`）；② 表里每个 `defaultsId` 在数据文件中真实存在；
③ 探测/路由两条路径按表造出正确类；④ 存储工厂的选择与缺省；⑤ **构造守卫**：模型适配器的 `new` 只允许出现在
注册表内；⑤-2 存储后端名的字符串分支只允许出现在存储工厂内。

**兼容性**：所有对外行为与文案不变（护栏/兜底/报错口径逐字保留）；模型适配器构造从「三处分支」变为「一次查表」。
`buildModel` 的返回类型由具体类联合收敛为 `ModelPort`（`protected` 方法，唯一调用点在同一类内）。

**验证**：`npm test` 2099 例 / 2094 过 / 1 失败（本机 Chrome 环境用例，与基线同一条）/ 4 skip；
`typecheck`（含 web）/ `lint`（0 告警）/ `format:check` / `check --strict`（571 文件零违规）/
`arch:gate --strict` / `audit:config-wiring`（571 文件）/ `api:check` 全通过。
