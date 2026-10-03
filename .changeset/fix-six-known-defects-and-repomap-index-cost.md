---
'@mylong227/omniharness': patch
---

清偿 `docs/PROJECT_BOARD.md` §3 登记的 6 项已知缺陷 + 修掉让**官方门禁 `npm test` 变红**的
repo-map 索引性能缺陷（7 项，全部本机可复核）。

## 0. 官方门禁 `npm test` 不再红（blocking）

**现象**：`npm test` 报 `fail 0` 却 **exit 1**——`sessionLifecycle` / `workflowRunner` 两个
测试文件在并发全量跑法下被 120s 文件级超时 cancelled。实测单文件：sessionLifecycle **100.4s**。

**根因**：`RepoMapContextEngine` 的全部价值都在进程内长寿命缓存上（全仓语料索引，本仓 902
文件 **8.6s** 量级），而装配层在每个组合根与**每个子代理**里 `new` 一个实例 ⇒
① 缓存生命期退化成「一次装配」；② 写类工具成功后走 `clear()` **硬删**，而 `shell` 里跑
`echo` / `git status` / `npm test` 并不改被索引的源码 ⇒ 一个回合把全仓索引两遍（8.5s + 8.5s）。

**改动**：

- 新增 `context/repoMap/repoMapEngineProvider.ts`：**进程级唯一引擎**，`memoryStackAssembler`
  与 `subagentRuntimeFactory` 改用它（缓存生命期回到进程级，与 `CorpusIndexCache` 文档声明的
  「进程级复用」一致）；子代理数量不再线性放大索引成本。
- `CorpusIndexCache.invalidate(root)`：**软失效**（保留内容签名，下次 `get` 强制复核），
  `StepToolExecutor.maybeInvalidateRepoMap` 改走它；`clear()` 保留为硬删（契约不变，测试不动）。

**实测**：sessionLifecycle **100.4s → 14.2s**、workflowRunner **超时 → 10.5s**；
`npm test` 全量复跑见下。

## 1. P1 — `rollback` 不截断内存事件流

**缺陷**：`CheckpointManager.rollback` 只写磁盘，运行中会话的内存日志仍是全量 ⇒ 下一步
write-behind 落盘把回滚**原样覆盖**（用户看到「已回滚」而历史没变）。

**改动**：新增端口 `ports/runtime/liveSessionRewindPort.ts` + 进程级登记表
`core/liveSessionRewindRegistry.ts`；`AppendOnlyEventLog.rewindTo`（唯一允许的删减操作，
越界 fail-closed 抛错）、`SessionRecorder.rewindTo`（同步夹回合起点下标、重算检索 seq、
反注册被撤销文档）、`EventPersister.rewindTo`（**先等在飞全量写落地再强制重写**，
长度恰好相等时靠独立的 `forceWrite` 判脏）；`Agent` 按 sessionId 登记/身份一致反注册。

**顺带补齐**：`RetrievalPort.remove?`（可选方法，不破坏既有实现）+ `Bm25MemoryIndex.remove`——
否则被撤销的 assistant/tool_result 仍能被 `memory_search` 召回。不支持反注册的后端
**如实告警**，不谎称已彻底回滚。

## 2. P2 — `TurnDiffHooks` 基线跨回合不重置

**缺陷**：钩子自持一张 `Map<path, before>`，回合末只有 `TurnRunner` 调 `tracker.reset()` ⇒
那张表从不清理且只增不减 ⇒ 回合 2 再写同一文件时 diff 的 before 侧是**回合 1 之前**的内容
（呈现跨回合累计差异）。

**改动**：**基线只在 tracker 里存一份**（新增 `hasBaseline` / `recordBaseline`，
`noteWrite(path, after)` 取 tracker 自己的基线），钩子退化为「本回合是否已为该路径读过盘」。
跨回合复用因此在**结构上不可能**发生。

## 3. P2 — 压缩阈值 token 记账系统性偏低

**缺陷**：`estimateMessages` 只计 `content`，toolCalls 参数 / reasoning 回传 / 附件信封 /
工具 schema / repo-map 尾段**全部不入账** ⇒ 长工具链会话越过真实窗口才触发压缩（fail-open 到 400）。

**改动**：

- `TokenEstimator.estimateMessage` + 静态 `accountableText` 成为记账**唯一实现**
  （content → reasoningContent → toolCalls JSON → 附件信封，NUL 分隔）；
  `ContextBreakdownEstimator` 改为委派（此前两处各算一套，面板与压缩判据可能不是同一个数）。
  二进制载荷仍不计（既有决策：无法从 base64 长度反推视觉 token，按长度折算会严重高估）。
- `ContextCompactor.compact(messages, state, overhead?)`：工具 schema + **尚未拼入**的
  repo-map 尾段作为每请求固定开销与消息**共用同一预算**（缺省不传 ⇒ 与改造前逐字一致）；
  `StepRunner.requestModel` 先算工具集再组装消息把开销交进去。预留超过预算时夹到
  20% 下限——宁可让上游看到一次偏大的请求，也不静默清空用户历史。
- **Rust FFI 同步**（`crates/omni-napi/src/handler.rs::handle_context_estimate` 新增
  `accountable_text`）：TS 与原生**逐位一致**由 `nativeTokenEstimator.test.ts` 的富载荷用例
  实测通过（本机 `npm run native:build` 后 0 skipped）。

## 4. P3 — Ollama 流式工具调用按函数名合并

**缺陷**：同批同名并行调用被吞并、参数片段后到覆盖；且每片参数单独 `JSON.parse` ⇒
分片 JSON 全部回退 `{}`（调用带着空参数发出去）。

**改动**：有 `index` 时按槽位分桶（与 OpenAI 兼容适配器同构）；字符串参数**按片段累积、
流末只解析一次**；`id` 逐条唯一（旧实现直接用函数名当配对键，两次 `read_file` 的调用与结果
两两不可区分）。无 `index` 时保留按名合并的既有行为——**本机无 ollama 样本，不推断该形态的
并行语义**（遵仓内「无样本不改协议解析」纪律）。

## 5. P3 — `SkillSparsifier` 在 BM25 生产路径上空转

**缺陷**：生产是 `selectForPrompt()`（已截到 5 条）→ `sparsify()`（预算 5 + 强命中豁免）⇒
预算判据**恒真**、豁免**永不生效**，且稀疏化的排序键把 BM25 相关性序覆盖成「按名称字典序」。

**改动**：`SkillRegistry.rankForPrompt()` 拆出**不截断**的比率过滤排名；生产改用它 +
`sparsify(..., relevance)`（相关性作主序，命中强度只在同分时分先后并触发豁免）。
`selectForPrompt()` 契约不变（同分数 + 截断）。
`evals/skill-routing-ab.mjs` 的判定档同步改为**生产真实两段管线**并重跑：
召回 **92.3%**、噪声 **1.50** 条/查询、Δ **+65.38pp**、CI95 **[46.15, 84.62]pp**、留出折 0/40 为负
——三关齐过（`npm run eval:skill-routing -- --gate` exit 0）。

## 6. P3 — `apply_patch` 多文件落盘非原子

**缺陷**：旧实现只保证解析期原子——第 2 个目标写失败时第 1 个已落盘且无回滚，用户收到
「失败」而工作区留下半份补丁；也没有 `write_file` / `edit` 都有的 `.bak` 备份。

**改动**：两阶段提交（准备：建父目录 + 已存在目标写 `.bak`；提交：逐个落盘，任一次失败即
**回滚**已写文件——存在过的还原原文、新建的删除，并如实报告回滚件数）；
「不存在」与「空文件」分离（只把 ENOENT 当不存在，EACCES/EISDIR 一律 fail-closed 上抛），
否则「读不到」会被伪装成「新建文件」而把目标覆盖掉。

## 顺带：拆掉被门禁抓到的上帝类

上述修复给 `core/agent.ts` 加了 3 个方法，把它推过编码标准的上帝类阈值（>25 方法），
`pre-commit` 的 `audit:standard:delta` 当场拦下。按要求拆而非豁免：

- 新增 `core/sessionInjector.ts`（`SessionInjector`）：把**只做「往 recorder 追加 system 事件」**
  的 5 个私有方法（`injectSkills` / `injectedContents` / `injectSessionPreamble` / `hasInjection` /
  `injectMemoryPrimer`）与相关常量整体迁出，依赖面仅「技能注册表 + 长期记忆端口」。
  `Agent` 由 **28 方法 → 21 方法**（744 → 561 行），注入逻辑也获得了独立单测的落点。
- `session_meta` 仍**只**在 `mode === 'run'` 时写：`observability/traceCollectingEventPort` 把它当作
  「新会话首条事件」用来冲刷上一会话 span ⇒ 在 resume 中途补写会被误判为会话切换（已写进 JSDoc）。

## 兼容性

- `TurnDiffTrackerPort.noteWrite` 签名由 `(path, before, after)` 改为 `(path, after)`，
  新增 `hasBaseline` / `recordBaseline`（该端口仅 core ↔ 适配器内部使用，非 `index.ts` 导出面）。
- `RetrievalPort.remove?` 为**可选**方法（`@beta` 端口，新增必需方法会破坏第三方实现）。
- `TokenEstimator.setNativeEstimator` / `ContextCompactor.setNativeEstimator` 的入参类型
  由 `{content}[]` 放宽为结构子集 `TokenAccountableMessage[]`（旧实参仍可赋值）。
- `ContextCompactor.compact` 第三参数可选，不传即与改造前逐字一致。
- 其余对外行为、文案与默认值不变。
