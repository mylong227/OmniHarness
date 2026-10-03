---
'@mylong227/omniharness': patch
---

**检索栈收敛**：删除 LSA 潜语义路，其余实验档登记清单 + 删除边界可机械核验（G19，P3 减法第一项）。

## 背景

报告 §3.2/§3.3 与本仓 `docs/RECALL_HEADROOM_SURVEY.md` 的实测记录：检索栈里有多条路径被**本项目自己
反复证伪**（净负面 / 零增益），却仍占维护面——每次改索引都要连带改它们、每次读代码都要重新判断
"这条还在用吗"。G19 的要求是**明确标注为实验档、默认关、可删，并评估删除边界**。

## 改动

1. **删除 LSA 潜语义路**（实测"召回持平 / 符号精确率腰斩"的净负面路径，且**无任何外部消费者**）：
   删 `src/context/lsaEngine.ts`（326 行）与 `tests/unit/lsaRecall.test.ts`；清掉 `ContextEngine.query`
   的 `lsa` 选项、`IndexedCorpus.lsaModel` 字段、`EMPTY_LSA` 占位、`SeedFusion` 的 LSA 第三路
   （三路 → 两路：BM25 ∪ 共振）；同步 `scripts/coverageBaseline.json` 与 `scripts/codemod/maturityAnnotate.mjs`
   的清单条目。
2. **新增 `src/context/experimentalPaths.ts`**：登记每条实验档路径的 `status` / 旋钮 / `defaultOn` /
   **本仓实测证据** / `boundaryFiles`（删除边界）。并让生产路径在有人**开启**实验档时**运行期告警**
   （点名哪条 + 实测结论）——清单因此是**活的**，不是文档化石。
3. **判据 `tests/unit/retrievalStackStatus.test.ts`（6 例，离线零 key）**：
   ① 声明已删除的文件真的不在；② 实验档一律 `defaultOn: false`；③ 默认档真的不建代码图/频域谱、
   语料无 `lsaModel`；④ **删除边界闭合**（边界文件的引用者必须全落在"边界 ∪ 入口点"内）；
   ⑤ 清单是活的（开启即告警、未登记 id 也如实报）；⑥ LSA 无残留引用。

## 判据护航的删除对照（G1 基线，删除前 → 删除后）

| 镜头   | 语料                                | recall@14                     | MRR                 |
| ------ | ----------------------------------- | ----------------------------- | ------------------- |
| plain  | 926 文件 / **10,694 → 10,586** 符号 | 56.3% → **56.3%**（18/32）    | 0.1978 → **0.1979** |
| rerank | 同上                                | 50.0% → **53.1%**（16→17/32） | 0.2020 → **0.2043** |

**如实解读**：plain 镜头**逐位不变**；rerank 镜头**上升**（+1 条命中）。上升来自**语料变小**（被删文件
自身的符号/词项不再参与竞争），**不是**检索算法变好——故只声称"删除**没有**带来退步"，不声称"删除提升
了检索"。基线守卫（`retrievalBaseline.test.ts`，含锚点审计）删前删后均绿。

## 边界评估的两个真实发现（首版判断被判据当场纠正）

1. **三条图路不是三条独立可删路径，而是一个家族**：代码图 / 层化图 / P5 稀疏引用图**共用**
   `symbolFileFusion` / `codeGraphIndex` / `codeReferenceGraph` 等 stage 文件。首版拆成三条独立边界时，
   边界判据立刻报出跨边界引用（`codeGraphIndex ← codeReferenceGraph`、`layeredGraphFusion ← symbolFileFusion`）
   ⇒ 已合并为 `graph-family` 单一边界（删除时必须一起动或一起留）。
2. **`src/util/eigenspectrum.ts` 不可随频域路删除**：首版把它列进 boundary，判据报出它还挂着 **9 个非检索
   消费者**（退火 / 共振场 / 顿悟蚀刻 / CRISPR / 涡环 / cosmicWeb / resonantField / resonantMemory / `index.ts`）
   ⇒ 它是**共享数学基础设施**，已明确排除并在清单里登记理由。

## 判据自身的两次修正（都写进用例注释）

1. **首版边界判据真空通过**：`importersOf()` 的键用相对 `src/` 的路径，而清单写的是 `src/...`
   ⇒ `edges.get(...)` 永远取不到值 ⇒ 一条越界也看不见（恒绿）。改为相对**仓库根**统一键格式。
2. 补**仪器自证**：先断言"每个边界文件在边表里查得到"（否则判据必然真空），再做**正对照**——注入一条
   越界引用必须恰好报 1 条。**变异**：把边界外的文件引到边界内的 `seedFusion` ⇒ ④ 变红；
   复活 `lsaEngine.ts`（空文件）⇒ ① 变红；回滚后 6/6 绿。

## 验证

`tsc --noEmit` 零错误；`npm test` 全绿（新 6 例 + 检索基线/上下文/MCP 等既有用例全过）；
`arch:gate` / `check --strict` / `lint`（0 告警）/ `audit:config-wiring` / `audit:maturity` /
`check:doc-links` / `api:check` / `audit:standard:delta` / `rust:test` / `web:test` 全绿。

## 未做（如实登记为 G19-b）

`graph-family`（6 文件）与 `spectral`（1 文件）**本轮只登记未删**：前者涉及 P5 稀疏图这个**功能面**
（默认关但可显式开启），后者与语料侧的频谱构建耦合。删除边界已可机械核验，删不删是**产品取舍**，
应单独一轮决策——不在"清理"里顺手砍功能。
