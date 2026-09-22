---
'omniharness': patch
---

性能与安全加固（2026-09-22 全量盘点后收尾，全部带实测数字与回归测试）

**性能**

- `Bm25Index` 补倒排表：`search` 原为「每个查询词 × 每篇文档 × 每个 token」的全量扫描
  （实测真实 `src/` 语料 563 文件 / 98.6 万 token：英文 5 词 **18.6 ms**、中文 22 词 **252 ms**，
  且按 token 数严格线性 ⇒ 32 MiB 配置上限外推 **≈2.6 s/步**）。改为 `addDocuments` 期建 postings
  后实测 **0.9 ms / 1.8 ms（20×–138×）**，`query()` 生产链路高热后 **33–223 ms → 2.7–5.6 ms**。
- 顺带修一处**既有缺陷**：`addDocuments` 分批调用时 `averageLength` 只用「本批 token / 全部文档数」，
  平均长度被算小（由新回归测试「分批 ≡ 单批」逐位对拍暴露）。生产调用点均为单批，故零行为变更。
- `ConcurrencyLimiter.release` 的 `waiters.shift()` 改游标 + 过半压缩：`parallelMap` 会先为全部条目建
  promise ⇒ 原为 O(N²/concurrency)，实测 n=20k/40k **576 / 927 ms → 45 / 63 ms（≈14.8×）**。
- `TokenEstimator.countCjk` 由 `match(/CJK/g)`（为计数分配整个命中数组）改码点区间循环：
  实测 170 KB 文本 **101.0 → 48.2 µs（2.10×）**，零分配、计数逐字相等。
- `ContextBreakdownEstimator.toolTokens` 增按定义对象的 WeakMap 缓存：原先每步对 33 个工具
  重新 `JSON.stringify`（该步实测占 2.53–34.41 ms 的一部分）。

**安全**

- **SsrfGuard 元数据拦截被 IPv6 写法绕过（实测复现）**：`inspectUrl('http://[::ffff:169.254.169.254]/…')`
  在默认策略下返回 `blocked:false`，与「云元数据地址永远拦截」的声明矛盾（`[::ffff:7f00:1]`、
  `[0:0:0:0:0:ffff:a9fe:a9fe]` 同理）。现按 IPv6 数值分组解析内嵌 IPv4（mapped / compatible / NAT64 / 6to4，
  含尾部点分写法），不可解析一律 fail-closed。
- **`safeReadFile` 缺 realpath 校验（实测复现越权读）**：工作区内指向外部的 junction/symlink 可读到宿主任意
  文件（RPC `fs.read` 与 HTTP `/files` 共用该函数），而同路径 `WorkspaceGuard.isInside` 为 false——
  属漏用既有守卫。现改为复用 `WorkspaceGuard.resolveSafe`（词法 + realpath 双层），对外文案不变。

**回归测试**：新增 `tests/unit/bm25Index.test.ts`（与暴力实现逐位对拍 / 分批等价 / df·idf 同源）、
`tests/unit/concurrencyLimiter.test.ts`（FIFO 链式移交 / 5000 等待者 / 异常释放）；
`ssrfGuard.test.ts` 与 `safeFs.test.ts` 补绕过用例。检索零回归：生产默认档命中率仍为
**78.8%**（对抗口径）/ **100%**（自然口径）。
