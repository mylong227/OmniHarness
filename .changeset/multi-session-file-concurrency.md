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
- **行级 diff3 三方合并**：`SessionBaselineStore` 保存会话基线全文（有界 LRU），
  `TextThreeWayMerge` 做 LCS 差分 + 区间合并；三条写路径在双方改不同区域时自动合并、
  同区域冲突时拒绝。字符级 / OT / CRDT 仍未做（见边界）。
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
`shellGovernor`（5）、`textThreeWayMerge`（10）、`fileThreeWayMerge`（8）、
`sessionBaselineStore`（4）、`concurrencyProperties`（3）；既有 `staleReadGuard` /
`editFileTool` / `readFileTool` / `fileLock` / `fileLockCrossProcess` / `patchCandidates` /
`shellTool` 全绿。

## 边界（未做，已在文档登记）

不做字符级合并/OT/CRDT（行级 diff3 已覆盖真实并发；文件是整文件语义）；未做多机向量时钟、
fsync、模型配额调度与形式化验证。数学调研与逐条映射见
`docs/CONCURRENCY_MATH_2026-10-25.md`。
