---
'@mylong227/omniharness': patch
---

清偿 `docs/PROJECT_BOARD.md` §3.1 登记的**两项遗留缺陷**（都带本机实测判据）。

## 1. 写类工具后的全量重索引 → 增量重建（实测 9.4s → 0.96s）

**背景**：上一轮把「没真改源码」的常见情形收掉了（写工具后走软失效，签名未变即复用），但
**真改了源码**之后仍要全量重建一次。本机实测拆出三段成本（3227 文件 / 33.5 MB 语料）：
遍历 **0.3s** + 读盘/分词/抽符号 **3.9s** + BM25 建索引 **3.0s**（file 2.2s + symbol 0.8s）。

**改动**：

- `context/corpusFileParser.ts`：**解析规则单一实现**，全量路径与增量路径共用（两处各写一套
  会让增量与全量结果**静默**漂移，且不报错）。
- `context/corpusFileArtifact.ts` + `IndexOptions.artifactSink`：全量索引时把逐文件产物
  （内容哈希 / 文件文档词项 / 符号 / 符号文档词项 / 符号起始下标）写给语料缓存条目，
  生命期与条目一致（LRU 驱逐即释放）。
- `Bm25Index.setDocument(slot, tokens)`（并抽出 `addDocument` / `slotCount`）：**就地替换**
  槽位的 df / postings / 文档长度，槽位不变；越界 fail-closed 抛错。批量路径 `addDocuments`
  行为逐位不变（既有暴力对拍测试原样通过）。
- `context/corpusIncrementalUpdater.ts`：按内容哈希复用产物、就地更新两个索引，
  **只在必要时重建符号索引**（符号数变化时）。**不可增量就回落全量**：文件集合变化、
  缺产物表、`light: false`（full 模式）、文件不可读 ⇒ 返回 `null`。
- `CorpusIndexCache`：TTL 到期后的**签名复核与增量重建共用同一次读盘**（`contentHashes()` 的
  逐文件字节哈希直接喂给增量器，只重读真的变了的文件），内容与文件集都没变时**复用原语料
  对象**（身份不变 ⇒ 下游 memo / 语义缓存不必失效）。

**实测（TTL=0 强制复核）**：

| 场景                       | 修前     | 修后         |
| -------------------------- | -------- | ------------ |
| 首次全量建索引             | 9.4s     | 9.4s（不变） |
| 无关写后取语料（内容未变） | 0.9s     | 0.9s         |
| **改 1 个源文件后取语料**  | **9.4s** | **0.96s**    |
| 再改 1 个源文件后取语料    | 9.4s     | 1.10s        |

剩余 ~0.9s 是内容签名复核（读+哈希 3227 个文件），它同时是变更判据与增量输入，不再是纯开销。

**判据**：`tests/unit/corpusIncremental.test.ts`（6 例）**与全量重建逐位对拍**——`files` /
`symbols` / `fileText` 逐字段相同，且两套 BM25 在 5 条查询上的命中 id 与**分数逐位相同**；
覆盖「符号数不变」「符号数变化（触发符号索引整体重建）」「内容未变须复用同一对象」
「文件集合变化须回落全量」「缺产物表 / full 模式须拒绝」。
`tests/unit/bm25Incremental.test.ts`（4 例）：替换后与全量重建的 id / 分数 / df / idf 逐位一致、
越界抛错、空文档替换无残留。`npm run eval:ci` 全绿（召回 39.1% → 39.6%，无回归）。

## 2. Ollama 多轮回传（原生多轮工具对话此前不成立）

**先查官方文档再动手**：Ollama `docs/api.md` 的「Generate a chat completion」message 字段表规定
`tool_calls`（`[{function:{name,arguments}}]`，**`arguments` 是对象**、条目**无 `id`**）与
`tool_name`（工具结果消息用）；**Ollama 没有 `tool_call_id`** ——原先登记的
「`tool_call_id`/`tool_name`」有一半是错的，已按文档更正。

**改动**（`LlamaCppModel`）：assistant 消息回传 `tool_calls`；工具结果消息带 **`tool_name`**，
由**同请求 assistant 的 id→名映射**精确取值（不解析 id 字符串——本适配器合成的 id 形如
`name#2`，工具名本身含 `#` 时会解错；查不到就不发该字段）；`images` 内联为**纯 base64**
（剥 data URL 前缀），`http(s)://` / `file://` 无法不下载即内联，**不发假字段**并记 debug。

**判据**：`tests/unit/llamaCppToolRoundTrip.test.ts`（5 例，stub fetch **断言真正发出的请求体**，
含「名字本身带 `#`」的用例）+ 既有 `llamaCppToolCalls.test.ts`（5 例）。

## 兼容性

- `Bm25Index` 新增 `addDocument` / `setDocument` / `slotCount`（纯增量能力，既有行为逐位不变）。
- `ContextEngine.IndexOptions` 新增可选 `artifactSink`；`indexCorpus` 的对外签名与语义不变
  （解析规则抽到 `CorpusFileParser`，逐字等价）。
- `CorpusIndexCache` 行为不变更严格：内容未变仍复用同一语料对象（此前也是），
  内容真变则由「全量重建」升级为「增量重建 + 结果逐位等价」。

## 验证（本机实跑）

`typecheck`（含 web）/ `lint`（0 告警）/ `format` / `check --strict`（912 文件零违规）/
`audit:standard:delta`（本次提交未新增标准违规）/ `arch:gate`（新增 0）/
`audit:config-wiring`（912 文件）/ `audit:maturity` / `check:doc-links` 全绿；
`eval:ci` 全绿；`npm test` **2,438 项：2,434 过 / 0 失败 / 0 cancelled / 4 skip（exit 0）**。
