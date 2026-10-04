---
'@mylong227/omniharness': patch
---

目录遍历切成**可让出档**：报告口径的「单次不让出 ≤100 ms」上限就此收回（G8-c）。

## 背景

G8 把"逐文件解析"与"装配"都切了块，但**目录遍历仍是同步段**（`ContextEngine.walkInto`：
`readdirSync` + 逐项 `lstatSync`，`src/` 上实测 ~54 ms 不让出）⇒ "单次不让出 ≤100 ms"这个
报告口径上限一直收不回来（遍历叠加首块解析就顶穿）。

## 改动

1. **新增公开 `ContextEngine.walkAsync`**：与 `walk` **同产物、同闸门**（共用新抽出的
   `buildWalkState` 与 `assertWalkRoot`），但每处理若干目录项就 `EventLoopYield.turn()` 交回宏任务。
   与公开的同步 `walk` 对称，调用方（后台索引 / 语料重建）可直接选让出档。
2. **让出粒度按"跨目录累计"计数**（`WALK_ASYNC_CHUNK_ENTRIES = 256`）。
   首版按**每个目录各自**计数 ⇒ 真实源码树全是小目录，计数器永远到不了阈值 ⇒ 实测几乎不让出
   （`src/` 925 文件只让出 3 次、最长阻塞与同步持平）——这是本轮抓出的真缺陷。
3. **`indexCorpusAsync` 接入** `walkAsync`（同步 `indexCorpus` 路径**逐位不变**）。

## 判据（`nativeTokenAndYield.test.ts` 用例 ⑥，四条）

① **产物逐位相同**：可让出遍历的文件列表 / `truncated` / `totalBytes` / `skippedLargeFiles`
与同步遍历完全一致（换让出档不改结果）；
② **仪器自证**：先证明心跳探针看得见已知的 200 ms 阻塞（否则"没超过 100ms"这类断言可能只是探针瞎）；
③ **绝对目标 ≤100 ms 达成**（实测 **31.9 ms**，两次取小）；
④ **相对判据**：同步基线**重复 5 次**放大到 506 ms，可让出档仍是 31.9 ms ⇒ **15.9×**。

**变异**：把 `walkAsync` 内部退回同步遍历 ⇒ 219.5 ms、比值 1.6×，**绝对与相对两条同时变红** ✓。
（本轮吸取的教训：单次遍历只有 ~46 ms、而 20 ms 心跳间隔自带 ~30 ms 测量地板 ⇒ 单次比值只有 1.4×，
**区分不出让出是否生效**；必须放大基线。）

## 顺带拆类（铁律要求，非可选）

加上遍历实现后 `contextEngine.ts` 涨到 **890 行**，触发上帝类门禁（500 行上限）⇒ 按本仓纪律**拆类**
而不是抬阈值：新增 `src/context/corpusWalker.ts`（`CorpusWalker`，一个类一个文件），把遍历相关类型
（`WalkLimits`/`WalkOutcome`/`WalkState`）、常量与两条路径全部迁入；`ContextEngine` 保留**同名常量与
同名静态方法**并转发 ⇒ 公开 API 面不变（`api:check` 无需改快照）。`contextEngine.ts` 回到 **606 行**。

## 验证

`tsc --noEmit` 零错误；`npm test` **2,593 项：2,586 过 / 0 失败**；`runGates --tier=all` 两层跑通；
`api:check` / `rust:test` / `web:test` 全绿。看板第二十七轮横幅与报告 §4 G8 行同步
（该行原写"剩余同步段＝目录遍历 54 ms，见遗留 G8-c"，现改为已落地实测值）。
