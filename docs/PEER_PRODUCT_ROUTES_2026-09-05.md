# 同类优秀产品的代码检索技术路线与参考价值

> 背景：OmniHarness 本地离线混合检索卡在 **minilm + 浓缩身份文档(id) = 62.3%**（BM25 43.3%），KPI「67%→≥80%」未达成。
> 用户问：同类优秀产品怎么解决的？技术路线是什么？有没有参考价值？
> 调研日期：2026-09-05。信息来自各产品官方文档 / 技术博客 / HN / 架构拆解文（见末「来源」）。

---

## 0. 一句话结论

**所有头部产品都走「混合检索 + AST 感知分块 + 代码专用嵌入 + cross-encoder 重排 + 图/结构信号」的多模态融合，没有一家靠单一向量撞线。** 我们下午撞出的两条真结论（浓缩身份 62.3%、通用 reranker −1pp）和它们**完全同向**——这说明瓶颈判断没错，且我们最大的空白是**图信号第四路（符号引用图的 PageRank 排名）**，而这条路**离线零重嵌税、可直接落地**。

---

## 1. 调研对象与路线拆解

### 1.1 Cursor（Anysphere，~3000 万用户）

- **索引**：Merkle 树做增量同步（每 10 分钟比对根哈希，只上传变更文件，带宽降 95%）。
- **分块**：**AST 语义分块**（tree-sitter 按函数/类/接口切，不按字符截断）。
- **嵌入**：代码专用嵌入模型（voyage-code 系列 / 自研），chunk 哈希缓存。向量库 Turbopuffer。
- **检索**：`@Codebase` 触发 **稠密向量 + BM25 稀疏** 混合；**结果重排优先考虑「仓库中心性」与「最近编辑」**；取 top-k 拼进 200k 上下文窗口。
- **隐私**：路径客户端混淆，实际代码留本地，只在查询时回读。

### 1.2 Sourcegraph Cody

- **多源融合**：Keyword Search（查询重写+标识符/符号识别）+ Embeddings（稠密）+ Sourcegraph Search（原生代码搜索引擎）+ **Code Graph（SCIP 协议：符号定义/引用/跨仓关系/文档）**。
- **关键转折**：Cody Enterprise **已弃用 embeddings**，改回 SCIP 代码图 + 原生 search（理由：不发代码给第三方、零配置、可扩展到 >10 万仓）。但 Free/Pro 仍保留 embeddings。说明**结构/图信号在规模化时优于稠密**。
- **信号**：把代码当「互联图」而非「文档袋」。

### 1.3 Greptile（YC W24，代码评审/理解）

- **四阶段索引流水线**：① AST 解析（tree-sitter → 函数/类/变量/调用关系）；② **递归为每个 AST 节点生成自然语言 docstring**；③ 把 docstring 在**函数级**切块嵌入向量库；④ **建图**（调用关系 + import 依赖 + 嵌入余弦相似 >阈值的模式相似边）。
- **实测**：自然语言 docstring 比原始代码嵌入相似度 **+12pp**。
- **检索**：标准 RAG（向量+关键词）之上叠加 **Graph RAG（沿图多跳遍历）+ agentic search**（agent 评审相关性、追引用）。
- **核心论点**：「代码库是图，不是 PDF」——简单 RAG 不够。

### 1.4 Aider（开源 coding agent，repo-map 标杆）

- **repo-map**：tree-sitter 抽符号定义/引用，建**引用图**，**用 PageRank 排名符号重要性**。
- **排名权重**：被提及标识符 ×10、snake/camel 长名 ×10、已在对话的文件 ×50、私有名(_) ×0.1、重载符号 ×0.1。
- **token 预算**：二分搜索选最大的排名子集塞进上下文窗口（15% 容差）。
- **输出**：层级符号树（文件→类→方法签名），几百 token 让 LLM「先看仓库形状再看文件」。
- **精髓**：**用图排名浓缩身份**，零嵌入成本，纯结构信号。

### 1.5 Claude Code / Codex（agentic 探索派）

- 不预索引，靠 **agentic 探索 + 大上下文窗口（1M token）+ CLAUDE.md** 按需翻代码。
- 这是另一条哲学：用推理能力换索引维护。对「检索召回率」直接可比性低，但印证「上下文质量 > 数量」。

### 1.6 Continue.dev（开源，最接近我们约束）

- 全本地 SQLite，可配分块（定长/truncate/AST-tree-sitter），默认 **all-MiniLM-L6-v2 本地跑**，生产推荐 Voyage Code。
- **重要**：检索管线**完全可定制**——嵌入模型、reranker、context provider 都可换。这正是 OmniHarness 想做的本地可插拔形态。

---

## 2. 抽象出的「生产级范式」（五条共性）

| #   | 路线                                                           | 采用的头部产品                    | 我们现状                                                    |
| --- | -------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------- |
| P1  | **混合检索**（BM25 + 稠密 + RRF）                              | 全部                              | ✅ 已有（RRF k=60）                                         |
| P2  | **AST 感知分块 / 浓缩身份**                                    | Cursor / Greptile / Cody          | ✅ 已做 id-doc（62.3%）                                     |
| P3  | **代码专用嵌入**（voyage-code-3 / UniXcoder / C2LLM）          | Cursor / Greptile / Continue      | ⚠️ 卡本地 ONNX：jina 失败、C2LLM 无 ONNX、e5-large 本地脆弱 |
| P4  | **cross-encoder 重排（必须代码感知）**                         | Cursor / Greptile / 通用 RAG 范式 | ❌ 用了通用 MiniLM → −1pp                                   |
| P5  | **图/结构信号**（引用图 PageRank / 调用图 / 文件中心性 boost） | Aider / Greptile / Cody           | ❌ **完全空白，最大未测杠杆**                               |

> 行业原话（neura.market 架构拆解）：「All production systems use hybrid retrieval. Pure vector search is insufficient. **Reranking is standard. AST-aware chunking outperforms naive splits. The most successful tools combine multiple retrieval modalities.**」

---

## 3. 参考价值逐条判定（对 OmniHarness 本地离线约束）

### ✅ P2 浓缩身份 —— 已被我们独立验证，且被 Greptile 背书

- 我们下午：minilm + 浓缩身份(id) = **62.3%**，比 600字符原始代码 +3.1pp。
- Greptile 独立实测：AST 节点生成 NL docstring 比原始代码嵌入 **+12pp**。
- **判读**：两者本质相同——「向量装什么信号」比「多大/多长」重要。我们做的是**签名级穷人版 docstring**（离线零 LLM 税）；Greptile 用 LLM 生成真 NL docstring（需 API/大本地模型）。方向 100% 对，已被同行证实。

### 🔥 P5 图/结构信号 —— 最大空白，离线零税，最高 ROI

- Aider 用 **PageRank 跑符号引用图** 排名重要性；Greptile 建 **调用+依赖+相似边图** 做 Graph RAG 多跳。
- **我们完全有数据**：`corpus.symbols` 已含定义/引用/文件/签名，可建引用图 + PageRank。
- **落地形态（离线可行）**：
  1. 第四路检索信号 = 符号 PageRank 中心性（文件得分 = 其符号 PageRank 之和）；
  2. 查询条件 boost：查询命中的标识符在图里邻居文件加权（Aider 的 ×10/×50 思路）；
  3. 化学信息学类比（见 BREAKTHROUGH_SCOUTING §7）：AST 子树哈希作 Tanimoto 结构相似第四路。
- **判读**：这是 peer 产品确证有效、且我们零重嵌税就能做的下一步。**强烈推荐**。

### ⚠️ P3 代码专用嵌入 —— 方向对，但本地 ONNX 是硬墙

- 头部用 voyage-code-3（代码检索榜首）/ UniXcoder（开源最佳）/ C2LLM（MTEB-Code 80.75）。
- 我们实测：jina-base-code 本地跑通但**不如** minilm（52.9%）；C2LLM 无 ONNX、沙箱无 optimum 导出；e5-large 容量 +5.6pp 但本地 **17.5× 构建税 + 内存易崩**（本会话两次静默死）。
- **判读**：local 离线要换代码专用嵌入，现实路径只有两条：① 等/找更小的代码 ONNX（如 `jina-embeddings-v2-base-code` 已证明可加载但效果不佳，需换更对齐的）；② 用 optimum 离线导出 C2LLM-0.5B（需装工具链，非快赢）。**短期不追，先吃 P5 图信号。**

### ❌ P4 重排 —— 必须换代码感知模型，否则有害

- 我们：通用 `ms-marco-MiniLM` reranker = **61.3%（−1.0pp）**。机制对（捞回 10 条），但通用英文模型不懂代码，把 2 条大 GT 推出 top-K。
- 头部用 voyage-rerank-2（16K）/ Cohere Rerank 3（4K）/ bge-reranker（代码对齐）。
- **判读**：本地能跑的代码感知 reranker 只有 bge-reranker 系列，但 large(1.6GB) 在本沙箱过脆、base 未验。可后置，且与 P5 图 boost 二选一或叠加。

### ✅ P1 混合 + 增量 —— 已具备，可补 Merkle 式增量

- 我们 RRF 混合已有。增量更新（Cursor Merkle）是工程优化，不影响召回率，非瓶颈。

---

## 4. 我们下午的实验 ↔ 头部产品的「对表」

| 我们的单元格              | 结果             | 头部产品对应验证                               |
| ------------------------- | ---------------- | ---------------------------------------------- |
| minilm + 600字符+符号名   | 59.2%            | 基线                                           |
| jina + 600字符            | 56.1%（−3.1pp）  | 代码模型绑烂表示仍翻不了 → 印证「表示 > 模型」 |
| jina + 8000字符全文       | 54.5%（最差）    | 喂长字符稀释身份 → 印证「浓缩身份 > 全长」     |
| **minilm + 浓缩身份(id)** | **62.3%**        | ✅ 与 Greptile「NL docstring +12pp」同向       |
| + 通用 reranker           | 61.3%（−1.0pp）  | ❌ 印证「reranker 必须代码感知」               |
| e5-large + id             | 静默崩（本地墙） | ⚠️ 印证「本地 ONNX 容量墙」，头部用 API 绕开   |

**结论**：我们没走弯路。浓缩身份是对的（被 Greptile 背书），reranker 必须代码感知（被头部实践印证），图信号是未动的最大杠杆（被 Aider/Greptile/Cody 三方印证）。

---

## 5. 推荐下一步（尊重诚实测量纪律）

1. **【最高 ROI，立刻做】P5 图信号第四路**：用 `corpus.symbols` 建引用图，PageRank 排名 → 文件中心性得分作为第四路并入 RRF；叠加查询条件标识符邻居 boost。离线零重嵌税，受控 2×2 测增益。预期参考 Aider 经验可显著抬召回。
2. **【次高】P4 代码感知 reranker**：换 `bge-reranker-base`（Xenova 有 ONNX，体积适中）替代通用 MiniLM，重验 top-N→top-K 精排。
3. **【后置】P3 代码专用嵌入**：装 optimum 离线导出 C2LLM-0.5B，或找更小的代码对齐 ONNX；e5-large 暂不作为默认（构建税+内存墙）。
4. **【不追】** 纯向量加大、全长截断、通用 reranker、长距离 agentic 探索（上下文质量>数量，且本地无 1M 窗口）。

---

## 6. 来源

- Cursor RAG 索引拆解（DEV.to / CSDN / boredreading / mmntm.net）
- Sourcegraph Cody Context 官方文档（多版） + 「anatomy of an AI coding assistant」+「how Cody understands your codebase」
- Greptile HN Launch + devcheolu 架构文 + hatchet.run 案例（AST→NL docstring→embed +12pp、Graph RAG）
- Aider repo-map（DeepWiki / aider docs ctags.md / pondero.ai Legacy 对比）—— PageRank 符号排名、权重倍数
- Continue.dev 开源检索管线（本地 MiniLM + 可定制）
- neura.market「Code indexing for AI agents」—— 通用范式总结与 Voyage/UniXcoder 基准

> 关联文档：`docs/BREAKTHROUGH_SCOUTING_2026-09-05.md` §7（极限瓶颈与跨学科突破框架）—— 本文 P5 图信号即该节「图论/范畴论 + 化学分子指纹」假设的**同行实证**。
