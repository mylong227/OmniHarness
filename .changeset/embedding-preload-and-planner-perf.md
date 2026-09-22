---
'omniharness': minor
---

嵌入预热接线（L5）+ 工具暴露规划器热路径提速（7.3×）+ 修「嵌入冷启动失败后永久瘫痪」。

**L5 · 嵌入预热与冷启动可观测**

- 新增可注入 loader 接缝（`TransformersModuleLoader` / `TransformersModuleLike`）：生产缺省仍是真动态 `import('@huggingface/transformers')`；**唯一目的**是让冷启动/预热能在**离线**下被单测钉住（否则验证需真下载 2.2GB 依赖与模型权重）。
- 新增 `TransformersEmbeddingAdapter.preload()`：返回 `{ok, ms, built, error}`，`built` 区分「真由本次构建」与「本来就热」；成功记 `embedding.pipeline.built`、失败记 `embedding.pipeline.failed`。
- `EmbeddingPort` 增**可选**能力 `preload?(): Promise<EmbeddingPreloadOutcome>`（契约：**不得抛错**，失败以 `{ok:false}` 回报）。
- 装配接线：`configFactory` 抽出 `buildEmbeddingPort()`；`OMNI_EMBED_PRELOAD=1`（**默认关 ⇒ 零行为变更**）时**后台**触发预热——刻意不 `await`，不阻塞启动；可用性仍由首次真实 `embed` 的 fail-closed 决定。
- 开关解析 `shouldPreloadEmbedding(env)` 与 `resolveRemoteHostFromEnv` 同址（同一惯例）。

**修缺陷 · 嵌入冷启动失败后永久瘫痪**

- `getPipeline()` 原先把构建 Promise 直接缓存：**一次瞬时失败（下载/加载）会把已 reject 的 Promise 永久钉在字段上**，此后每一步都复用它 ⇒ 该适配器此后再不可能恢复，语义路整会话静默失效。
- 修法：失败即清空缓存以便重试，并以 `=== pending` 守卫避免误清新一轮尝试。

**优化 · `ToolExposurePlanner.plan()` 热路径**

- 问题：`plan()` **每步**调用一次，而原实现对「每类别 × 每关键词」都 `new RegExp(...)`（默认类别表约 **81** 个关键词）⇒ 每步重建约 81 个正则。
- 改法：① 同类 ASCII 关键词合并成**单条交替正则**（尾边界用前瞻，对布尔判定与原先的消费式等价）；② 按类别表对象引用用 `WeakMap` 缓存预编译匹配器。
- 实测：**47.53 µs → 6.49 µs/次（−86.3%，7.3×）**；**行为逐字不变**由差分回归测试钉住（测试内保留优化前的朴素匹配器，在 28 条含边界陷阱的语料上逐条比对）。

**顺带处理**

- `configFactory.ts` 文件尾一处**悬空 JSDoc**（后面无任何声明）会被**下一个**声明吸收、造成文档误挂，已降级为普通注释（内容一字未删）。

**行为变更提示**：默认**无**行为变更（`OMNI_EMBED_PRELOAD` 未设 ⇒ 不预热；语义路仍由 `OMNI_SEMANTIC_RECALL=1` 控制；`plan()` 输出逐字不变）。
新增 env `OMNI_EMBED_PRELOAD=1` 与端口可选方法 `EmbeddingPort.preload`。
