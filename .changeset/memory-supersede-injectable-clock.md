---
'@mylong227/omniharness': patch
---

**修复时间敏感判据**（看板 §8.0，第二十八轮登记的偶发假红）：`MemoryExtractor` 注入可替换时钟，
`memoryWriteQuality.test.ts` 第 ② 例改为受控时钟判据。

## 缺陷（本机复核，与登记一致）

`supersede`（值位冲突替代）把旧事实的 `expiresAt` 置为**调用时刻**（`memoryExtractor.ts` 的
`new Date().toISOString()`，零余量），而判据 ② 在替代**之前**采样 `const now = Date.now()`、
再用 `Date.parse(f.expiresAt) > now` 过滤"可召回"——毫秒跨界时（门禁机器忙、全量并行跑），
替代落在**晚于采样**的毫秒里 ⇒ 旧事实被误判为"仍可召回" ⇒ "可召回只 +1"与"旧事实已失效"
两条断言互相打架。实测形态与登记一致：全量 3 跑偶发 1 红、单跑全绿、复跑又绿——
偶发假红与偶发假绿同样是缺陷（`CODE_STANDARD.md` §11.3），不靠重跑掩盖。

## 改动

1. `MemoryExtractorOptions` 新增可选 `now?: () => number`（默认 `Date.now`，缺省行为逐字节不变）：
   `createdAt` 与冲突替代 `expiresAt` 的时间源改走该缝（JSDoc 记录 why）；
2. 判据 ② 注入受控时钟：时间前进一分钟后再写冲突结论，断言"失效时刻 = 替代发生的受控时刻"
   且"受控时刻上可召回恰一条"——判据恢复确定性，不再依赖机器快慢；
3. ③④⑥ 等其余用例的 `liveFacts(store, Date.now())` 采样点本就在替代**之后**（单调墙上必然
   `expiresAt ≤ now`），本就确定，不动。

API 面：仅向 `@beta` 选项接口**追加可选成员**，`api:check` 全绿；既有装配点
（`memoryStackAssembler` 等）零改动。
