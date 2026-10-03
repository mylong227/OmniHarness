---
'@mylong227/omniharness': patch
---

修复**回滚后压缩游标悬空**（G4-L4，对应调研报告 §1.4 发现 3 与看板 §8.2）。

## 问题（本机复核）

`StepContextBuilder` 的 `compactionState` 是**进程内**状态，只在构造后首次 `buildMessages` 时从事件日志恢复
一次（`stepContextBuilder.ts:101-104`）；而 `stateRestored = ` 在全仓**只有两处**（L46 初始化为 `false`、
L102 置 `true`），**没有任何地方置回 false，也没有 reset()/setter**。`checkpoint` 回滚会把
`OMNI_COMPACTION_V1` 游标事件经 `eventsFrom` 从日志里截掉 ⇒ 内存游标**悬空**（引用了一个日志中已不存在的
折叠点）。症状是"同一进程内不对、重启后对了"（重启后新实例会重新恢复），属最难查的一类。

另外三层回滚对齐本身**是做对的**（内存事件流 / 检索索引 / 磁盘 + 在飞写，且端口不支持 `remove` 时
显式告警而非静默）——本缺陷是**第四层**（上下文游标）漏了。

## 改动

- `StepContextBuilder.rewindCompactionState()`：**就地重新推导**游标——取"截断后日志里的最后一条标记"，
  没有即 `undefined`；
- `StepRunner` / `TurnRunner` 逐级透传；
- `Agent.registerRewinder` 在 `recorder.rewindTo(size)` **之后**调用它（`activeRunner` 用延迟绑定，
  因为回卷登记发生在 `buildTurnRunner` 之前）。

**刻意不把 `stateRestored` 置回 `false`**：那会让下一次构建走"首次恢复"路径并把 `previous` 当 `undefined`
处理，可能多付一次摘要 LLM 调用（正是该文件 L100-137 注释记录的旧缺陷 P0-1）。

## 判据（本机离线、无 key）

`tests/unit/contextIntegrityFixes.test.ts` 新增 ⑤：先用真压缩器产出**真实**游标事件（不猜 `CompactionState`
形状），再用记录型压缩器观察每次构建传入的 `previous`——① 首次构建恢复出游标；② **截断游标事件但不复位**
⇒ 仍复用被移除的游标（复现缺陷形态）；③ 调用 `rewindCompactionState()` 后 ⇒ `previous === undefined`
（即"承认截断后的日志里没有游标"，已完成重新对齐）。

## 遗留（如实登记）

接线（`Agent → TurnRunner → StepRunner → StepContextBuilder`）目前由**类型检查 + 上述单测**覆盖语义，
**缺一条端到端断言**（真实回合里跑 `checkpoint` 回滚后核对下一次请求的消息）；已并入 G1「最小行为回归守卫」用例清单。
