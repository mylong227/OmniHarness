---
'@mylong227/omniharness': patch
---

把**缓存未命中的分因**真正接进容量面板（销掉看板 §8.11 登记的那条遗留），并修掉同一片里
「日志分因恒报 `not-reported`」的真缺陷。

## 之前缺的到底是什么

分因器（`CacheMissAttributionAnalyst`）与观测器自 2026-10-11 就在，但**它们拿不到逐条信号**：

- `StepContextBuilder.measurePrefixReuse` 早就在真实请求路径上量前缀复用率，却**只打一条 debug 日志**
  ⇒ 前缀这一路信号从未落进事件日志，容量面板（`ContextUsageReport.cache`）只有聚合 token 数，
  于是命中率低时只能显示一个数字、**说不出原因**；
- 观测器读的字段是 `cachedPromptTokensReported`，而服务端传的是 `ContextCacheStat`
  （字段名是 `cachedPromptTokens`）⇒ 生产日志**恒判 `not-reported`**：明明是"上报了、只是没命中"，
  却被写成"端点没给字段，0% 是假读数"。判据当时只钉了 `hitRate/promptTokens/cachedPromptTokens/calls`
  四个数字，**没钉 `cause`**，所以这条一直没人发现。

## 现在

- **信号落盘**：`ModelContextSnapshot` 新增可选 `prefixReuseRatio`（只存数值证据），
  `StepContextBuilder.prefixReuseRatioOfLastBuild` 把它交给 `StepRunner.snapshotOf`；
  **首次请求写缺省**而不是 0——0 的含义是"前缀被完全改写"，与"没有基准"完全相反。
  四舍五入**先算再两处共用**（日志与快照逐位一致）。
- **面板结论**：`ContextCacheStat` 新增 `lastCall: { cause, reason, evidence, promptTokens, cachedPromptTokens }`。
  口径刻意与聚合数字分开：**token 数与信号取自同一条 model 事件**（该次调用自己的 usage + 它自己的前缀比），
  而不是"聚合 token 配最后一条事件的信号"（那会在"最后一次没上报"时张冠李戴）。
  `gapMs` 取最近两次**上报**调用的时间戳之差；时间戳非法或倒序时**不给信号**（宁缺勿编）。
- **日志与面板同源**：`CacheHitRateSample` 新增可选 `attribution`，服务把算好的结论透传给观测器
  ⇒ 同一场会话里日志与面板不会再各说一套 `cause`。
- **不冒充"查过了"**：分因器在缺前缀占比 / 缺间隔时改用
  `有上报但缺…信号 ⇒ 无法归因（不是"没问题"，是"没测到"）`，不再无条件说"前缀稳定"；
  新增 `reportedCalls: 0` 让"还没跑过模型调用"与"跑过了但端点不给字段"在理由里可分辨。
- **前端**：容量面板缓存行显示 `缓存命中 57.8% · 前缀被改写`，悬停给
  `基于 N 次调用 · <一句话理由>`；`hit` 与无数据**不给标签**（命中不需要运维动作）；
  服务端没发 `lastCall`（旧版本）时按"没有分因"渲染，**不显示 `undefined`**。

## 判据（含变异自证）

- `tests/unit/prefixReuseSnapshot.test.ts`（新，真跑 Agent 回合）：快照里必须有实测值、
  首次请求必须缺省、每条值必须与 `PrefixStability.prefixReuse` 对"上一次实际发出的 messages"算出的值**逐位相同**。
  **变异**：把 `StepRunner` 里的字段去掉 ⇒ 本判据当场红。
- `tests/unit/contextUsageCache.test.ts`（+9 例）：逐因可单独触发（`cold-start` / `prefix-rewrite` /
  `ttl-expired` / `unknown` / `hit` / `not-reported`）、TTL 边界（恰好等于不算过期）、
  **信号取"最近一次上报调用"那条事件**（尾随一条低比值的辅助调用不得被借用）、RPC 序列化字段稳定、
  以及**回归判据**：上报了但命中率低时日志分因不得是 `not-reported`。**变异**：撤掉 `attribution` 透传 ⇒ 该例红。
- `tests/unit/cacheMissAttributionAnalyst.test.ts`（+2 例）：信号不全时不得出现"前缀稳定"（附正对照）、
  `reportedCalls=0` 的理由必须点明 0 次（附旧口径正对照）。
- `tests/unit/cacheHitRateWatch.test.ts`（+1 例）：透传的结论优先，且不得改动坍塌判定用的四个数字（附正对照）。
- `tests/unit/stepContextBuilderPrefix.test.ts`（+1 例）：`prefixReuseRatioOfLastBuild` 首建缺省、同输入恒 1、
  改写头部必须落到下限之下（否则面板永远报不出 `prefix-rewrite`）。
- `web/test/contextUsageCacheView.test.mjs`（+3 例）：标签映射、命中/无数据不给标签、
  悬停文案含样本量与理由、旧服务端缺 `lastCall` 时不得出现 `undefined`。

**真机**（真 Chrome + 真 SPA + 桩数据）：`node web/test/visualProbe.mjs --themes=dark --widths=1280`
实测容量弹层页脚渲染 `MCP 6 · 系统 14    缓存命中 62% · 前缀被改写`；探针夹具的 `context.usage.cache`
同步补成真实形状（含 `lastCall`），否则截图只会走到"旧服务端没有分因"的降级分支。

## 诚实边界

- `lastCall` 描述的是**最近一次上报调用**，不是会话聚合——聚合命中率仍是原来的
  `Σ cached / Σ prompt`（口径未变）；前端文案写的是"最近一次"，两者不会被读成一回事。
- `gapMs` 只在**两次上报调用**之间可算；辅助调用（记忆抽取等）不参与，也不影响该结论。
- 旧会话的事件里没有 `prefixReuseRatio` ⇒ 结论会是 `unknown` 且理由明写"缺前缀占比"，
  **不会**因为"没测到"而报成"前缀稳定"。
- 没有改动 `hitRate` 的计算、告警阈值（`OMNI_CACHE_HIT_WARN`）与任何默认行为。
