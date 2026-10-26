---
'@mylong227/omniharness': minor
---

多会话并发：文件读写协调 + 会话公平资源闸门。

## 修掉的真实失败面

- **跨会话丢写**：旧内容账本只有全局一份指纹，`A 读 → B 写 → A 写` 会把 B 的改动静默覆盖。
  现在按 `owner`（会话 id）保存基线；写前在锁内复核，冲突拒绝并提示先重读。
- **同文件并发写**：`write_file` / `edit` / `apply_patch` 现在经工作区级
  `WorkspaceFileCoordinator`（进程内读写锁 + 跨进程租约 + 原子 rename）。等锁期间被其他
  会话改过：锚点仍唯一命中 / 三方合并不冲突则自动合并，否则拒绝。
- **行级 diff3 + 字符级细化**：`SessionBaselineStore` 保存会话基线全文（有界 LRU），
  `TextThreeWayMerge` 做 LCS 差分 + 区间合并，同一行冲突再用 `TextCharacterMerge` 按字符
  LCS 细化；三条写路径在双方改不同区域时自动合并、同区域冲突时拒绝。
- **OT / CRDT / 向量时钟原语**：insert-only OT（`TextOperationalTransform`、交换律判据）、
  RGA 文本 CRDT（`TextCrdt`、并发插入/墓碑/merge 收敛）、向量时钟
  （`VectorClock`、before/after/concurrent）——均作为独立可测原语，未改变文件写入语义。
- **构建/测试共享租约**：`scripts/workspaceLease.mjs`（共享 FS 租约 + TTL/心跳/fencing），
  接入 `npm run build` 与 `test:fast` / `test:web` / `coverage`，消除 dist 换入窗口的假红。
- **fsync 分层**：`AtomicFileWriter.durable`、晋升台账每条 append、`AuditSink.close()`；
  `durable:true` 时审计每条也 fsync。
- **有界模型检查**：读写锁可达状态穷举 + 有序加锁无环（`modelChecking.test.ts`）。
- **可观测分位数**：GK 草图接入 `Metrics`，暴露 p50/p95/p99（O(1/ε·log εn) 内存，
  不再只靠 min/max 看长尾）。
- **技能预算精确解**：`SkillActivationPlanner` 用 0/1 背包替代贪心，预算内不再因先遇到
  贵项错失更优组合（`budgetedKnapsack` 5 例 + 规划器反例）。
- **自适应模型路由**：`ModelRouter` 新增 `ucb1` 策略，按成功/延迟在线学习
  （`ucb1Bandit` 4 例 + 路由集成 1 例）。
- **撕裂读**：落盘改为同目录 tmp + rename；并发读者只会看到完整旧版本或完整新版本。
- **`apply_patch` 共享实例字段**：`existing` 从工具实例字段改为每次调用局部集合——旧实现
  在两个会话并发补丁时会互相污染「哪些目标原本存在」。
- **多文件死锁**：多目标按归一化绝对路径排序后一次性持锁。
- **一个会话饿死其他会话**：shell 增加 `FairSessionScheduler`（SFQ）总量 + 会话公平闸门，
  默认 8 路；`OMNI_SHELL_CONCURRENCY` / `OMNI_SHELL_QUEUE_PER_SESSION` /
  `OMNI_SHELL_QUEUE_TOTAL` 可调，未注入闸门时语义不变。
- **重复读盘**：同路径并发读单飞（共享在飞 Promise）。

## 判据（真文件 / 真并发 / 真跨进程）

新增 `keyedReadWriteLock`（8）、`fairSessionScheduler`（8）、`asyncFileLock`（4）、
`workspaceFileCoordinator`（12，含两个真 Node 进程各 5 次读—改—写、断言 10 次自增不丢）、
`shellGovernor`（5）、`textThreeWayMerge`（10）、`textCharacterMerge`（5）、
`fileThreeWayMerge`（8）、`sessionBaselineStore`（4）、`textCrdt`（5）、
`textOperationalTransform`（4）、`vectorClock`（5）、`workspaceLease`（3）、
`modelChecking`（3）、`atomicFileWriterDurable`（2）、`auditDurability`（1）、
`concurrencyProperties`（3）；既有 `staleReadGuard` / `editFileTool` / `readFileTool` /
`fileLock` / `fileLockCrossProcess` / `patchCandidates` / `shellTool` 全绿。
数学扩展新增 `quantileSketch`（4）、`metricsQuantiles`（2）、`budgetedKnapsack`（5）、
`ucb1Bandit`（4），并给 `skillActivationPlanner` 加 1 例背包反例、`router` 加 1 例 ucb1。

## 边界（未做，已在文档登记）

不做 delete/富文本 OT、整文件字符级合并、CRDT 接入文件写入与 GC；向量时钟只做原语，
多机文件同步/跨机 quorum 锁未做；全局 fsync 未开（只对账本/审计/durable 原子写）；
有界模型检查不是 TLA+/Coq 全量证明；直接 `npx vitest` 会绕过构建/测试租约。
数学调研与逐条映射见 `docs/CONCURRENCY_MATH_2026-10-25.md`。
