---
'@mylong227/omniharness': patch
---

**自观测计数器**：把 OTLP span 的"静默丢弃"变成可断言的数字，并新增离线对账脚本（G24，O3+O4）。

## 问题

`OtlpTraceExporter.flush()` 的契约是"失败静默、绝不反噬业务"——这是对的，但它让**丢弃不可见**：
端点打错、Collector 挂了、网络被拦，都会安静地丢 span，没人知道。另有一条**完全没判**的路径：
只看"有没有抛错"，于是 HTTP 404/500 被当成**发送成功**。

## 改动

1. `OtlpTraceExporter` 新增自观测快照 `stats(): OtlpExporterStats`（`batchesSent/batchesDropped/
spansSent/spansDropped/lastDropReason`），照抄本仓 `CacheHitRateCollector` 的范式：
   **只读字段、无样本给 0、不发警告、不改任何业务分支**；并以
   `batchesSent + batchesDropped === 0` 表达"从未尝试发送"（与"跑过且全丢"区分开）。
2. `flush()` 关闭静默路径：响应**明确** `ok === false` 也计入丢弃、原因 `http_<状态码>`。
   判定用**显式**判否（`=== false`）而非"无 `ok` 即失败"，故注入的极简桩（返回 `{}`）与既有用法
   保持兼容——既有 `otlpTraceExporter` / `otlpTraceWiring` 测试（10 例）零改动通过。
3. 新增 `scripts/observabilityReconcile.mjs`（O4，一次性离线对账、不进 CI、不联网）：
   读 JSONL 事件 → 跑 `TokenAttribution` → 交叉校验两条恒等式 + 单列"没有 usage 的模型调用"；
   退出码 0/1。**缓存读不计入 total** 的口径写进脚本头（它是 prompt 的子集，相加会把同一批 token 数两遍）。

## 判据（`tests/unit/selfObservability.test.ts`，6 例，离线零 key）

① 注入**必失败** `fetchImpl` ⇒ `spansDropped`/`batchesDropped` 严格递增，且 `flush()` **不抛错**；
② HTTP 明确失败（`ok:false`, 500）⇒ 计入丢弃且 `lastDropReason='http_500'`（新增覆盖的路径）；
③ 成功路径走 sent、丢弃保持 0；无 `ok` 字段的极简桩仍按成功计（兼容性）；
④ 从未尝试发送 ⇒ 全 0（区分"没跑过"与"跑过且全丢"）；
⑤ 对账脚本：合法文件退出 0、缺失文件退出 1、无参数退出 1 并打印用法；⑤b 单列"无 usage 的调用"；
⑥ 归因两条恒等式（**独立算路的交叉校验**：分桶求和 vs 汇总字段；Σtotal == prompt + completion；
缓存读不计入 total）。

**变异测试**：把 `recordDrop` 改成不计数（回到原"静默丢弃"）⇒ ①② **双双变红**；回滚后全绿。

## 口径边界（如实登记）

- ⑥ 的两条恒等式由 `TokenAttribution.build()` 的聚合方式**结构性地**保证，因此它抓的是"**聚合实现被改坏**"
  （独立算路交叉校验），**不是**对输入数据的校验——输入侧的真实缺口由"无 usage 的调用"计数单列出来
  （它**不进任何桶**，是归因覆盖面的诚实缺口）。
- 计数器只是**进程内**数字：没有导出到 OTLP/metrics，也没有告警（O3 明确要求"不发警告、不改业务分支"）。
  需要跨进程汇总时由调用方读 `stats()` 自行处理。
