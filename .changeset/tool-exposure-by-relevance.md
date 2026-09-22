---
'omniharness': minor
---

工具按需暴露：默认 33 个工具的完整 schema **不再每步全量注入**（opt-in `OMNI_TOOL_EXPOSURE=plan`）。

**动机（借鉴 Laya 的高基数实测）**

- Laya（Apache-2.0 System 1 决策模型）实测：选项数固定、token 预算固定时，**每个选项分到的 token 就是准确率天花板**——77 个选项共享 `head_max_len` ⇒ 每标签仅 3–4 token ⇒ 准确率 0.870 塌到 0.425；其处方是 **coarse-to-fine**（先粗分类相关组、再组内细选）。
- 工具集同形：`ConfigFactory.build` 默认装配 **33 个工具且全部直载**（`listDirect()` 无一个 deferred），实测 **6937 token（`tokenize` 口径）** 的固定开销**与任务无关**地出现在每一步。

**改动**

- 新增 `src/core/toolExposurePlanner.ts`（纯函数、零依赖、确定性）：按任务文本判**类别相关性**（英文按词边界、中文按子串），产出 `visible`/`deferred`/`matchedCategories`/可读 `reason`；`modeFromEnv()` 解析 `OMNI_TOOL_EXPOSURE`，**默认 `off`**。
- `stepContextBuilder.effectiveTools()` 增 `exposeByRelevance()`：仅 `plan` 模式下按相关性裁剪**直载**集；**经 `tool_search` 发现的工具无条件保留**（不打断 #M1 闭环）。
- 新增 `evals/tool-exposure-ab.mjs` + npm `metrics:tool-exposure`（免网络免模型，走生产装配本体）。

**为什么隐藏不等于能力删除（接线安全性的前提）**

- `ToolIndex` 建自 `registry.list()`（**全部**工具，非 `listDirect()`），且命中经 `discovery.add()` 使后续回合可见 ⇒ 被延迟的工具**仍可经 `tool_search` 找回**。

**三护栏（方向与权限门禁相反：此处宁多给不少给）**

- ① 未登记进任何类别的工具**恒可见**（新工具忘登记只会更保守）；② `alwaysVisible` = `tool_search`/`ask_user`/`spill_read`（找回/澄清/回读三通道）**恒可见**；③ **无类别命中 ⇒ 全部可见**（fail-safe，理由如实写进 `reason`）。

**实测（`npm run metrics:tool-exposure`）**

- 平均 **33→10.0 个工具、6937→2167 token（−68.8%）**；逐条 −64.9% ~ −86.7%；**无信号任务 33→33、−0.0%**（fail-safe 在数字里可见）。
- 类别表登记 30 个工具，与真实注册表**零脱节**（不一致即中止，防假绿灯）；未覆盖的恰为恒可见三通道本身。
- 三护栏回归 10/10、10/10、10/10。

**行为变更提示**：默认**无**行为变更（`OMNI_TOOL_EXPOSURE` 未设 ⇒ `off`，与本次之前逐字等价）；显式置 `plan` 时，与任务不相关类别的工具将从直载集移出、改为经 `tool_search` 按需发现。
