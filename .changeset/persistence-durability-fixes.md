---
'omniharness': patch
---

**持久化耐久性两处缺陷修复**（审计 §1.7 P3 批次，第十轮）：`EventPersister` 会**丢弃**在飞期间到达的落盘请求；`JsonlStorage` 一行坏 JSON 就让 `load` **静默返回空历史**。两处均带窗口复现级回归测试。

- **`EventPersister` 落盘竞态（修 bug）**：原 `flush()` 在「已有 flush 在飞」时**直接 return**，
  该请求即被丢弃——write-behind 定时器触发时若上一次写仍在飞，期间新增的事件要等**下一次** `schedule()`
  才可能落盘；回合末的 `await persister.flush()` 也会在在飞写完成**之前**返回，调用方误以为已持久化。
  改为 **flush 串行队列**（每个 flush 排在上一次之后）：既不丢请求，又保证 `flush()` 返回时
  **它自己的快照确已写入**。失败仍降级为 `session.persist.failed` warn 且不推进 `lastSavedCount`
  （下一次 flush 自动重试同一批），dispose 后不再接受新请求但**已排队**的落盘照常完成。
  回归：`tests/unit/eventPersister.test.ts`（5 例）——用可控存储替身把写入挂在闸门上，
  真实复现「在飞期间的新事件」与「await flush 早于写入完成」两个窗口；另覆盖增量跳过、空事件、
  fail-soft 重试、定时器落盘与 dispose 语义。
- **`JsonlStorage` 静默空历史（修 bug）**：原 `load` 把整文件 `JSON.parse` 放在同一个 `catch` 里，
  **一行**非法 JSON（崩溃残行/截断）就让 `load` 返回 `[]`，调用方无法区分「没有历史」与「读不出来」
  ⇒ 会话续跑与回放会**悄悄丢光全部上下文**。改为逐行解析：坏行**跳过并告警**（`storage.jsonl.bad_line`，
  带行号），其余事件照常返回；有内容却全部行失败时另发 `storage.jsonl.all_lines_corrupt`（文件级损坏信号）；
  非 ENOENT 的读取失败改为 `storage.jsonl.unreadable` 告警后返回 `[]`（对外契约不变，但不再无声）。
- **`JsonlStorage.save` 原子写（同轮顺带）**：原为整文件 `writeFile` 覆盖，崩在半途会留下**半截文件**
  （读方要么解析失败、要么读到看似完整却缺尾的历史）。改为先写 `<file>.tmp` 再 **`rename`** 覆盖
  （同目录 rename 原子），失败时清理半成品，不留 `.tmp` 堆积。
  回归：`tests/unit/storageDurability.test.ts`（5 例：往返保序、覆盖写不留 `.tmp`、
  **个别坏行只丢那一行**、全坏行仍返回 `[]` 不抛错、文件缺失/不可读均返回 `[]`）。
- **仍未清（审计 §1.7 剩余 2 条，下一轮）**：shell 不消费取消信号（`shellTool.ts` 不传 `signal`，
  最长跑满 600 s 且只杀直接子进程）；spill 产物与涡环包无回收（`fileSpill` 文件只增不减、
  `vortexRingSpillAdapter` 的 `rings` 表只增不减）——收口须按本项目纪律把**限额进配置**而非硬编码常数。
- **覆盖率门禁两处政策修正（工具）**：新增测试文件会让**未被改动**的文件覆盖率抖动
  （实测第三次：`evalHarness.js` 87.78↔87.28，源码未动、去掉新测试文件即精确回到 87.78）⇒ 不再逐个登记豁免，改为
  ① **1 点度量漂移容差**（容差内的下浮如实列出、不阻断；真实回退远大于 1 点），
  ② **基线棘轮**：`--dump-baseline` 默认只升不降（新值更低时保留旧值，`--force` 才可下调）。
  本轮实测：收紧 3 个（`jsonlStorage` 96.61→100、`eventPersister` 95.7→100、`browserSession` 91.75→92.41），
  棘轮拒绝对 `evalHarness` 下调；聚合 **90.58% / 509 文件**。
