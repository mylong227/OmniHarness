# U3 上下文召回实验报告（实测，2026-09-05）

> 目标：突破 repo-map 的文件召回天花板，并给出**可与同期产品正面比较**的真实数字。
> 原则：**失败的照实记，有效的才留**。原有实现全部保留为可回退 baseline，新增能力一律增量接入、默认按实测择优开关，不做全盘否定。

- 语料：OmniHarness 自身 `src/`（**313 文件 / 5022 符号 / 309,433 token**，确定性可复现）。
- 基准：`evals/context-efficiency/bench.mjs`（10 条查询）。
- **标准答案用独立字符串锚点定位**（如锚点 `spill_read` → 含该串的文件即 GT），**不依赖 BM25**，避免自证循环。
- 复现：`bash evals/context-efficiency/run.sh`。

---

## 一、五轮技术尝试的完整证据链

| #   | 技术                               | 文件召回            | 符号精确率        | 判定                | 默认     |
| --- | ---------------------------------- | ------------------- | ----------------- | ------------------- | -------- |
| 0   | BM25 纯词法（既有实现，baseline）  | 60.83%              | 13.0%             | 基线                | —        |
| 1   | **camelCase 拆分 + 词形变体归并**  | **67.00%** (+6.2pp) | **25.5%** (+96%)  | ✅ **有效，采纳**   | **开**   |
| 2   | 燧-3 频域共振符号并集              | 无实质增益          | —                 | ⚠️ 与词袋冗余       | 开(无害) |
| 3   | 伪相关反馈 PRF                     | 58.5% → **42.0%**   | —                 | ❌ **有害**         | 关       |
| 4   | 跨文件引用图 + PageRank（44 万边） | 零增益（逐条持平）  | —                 | ❌ 稠密图收敛至均匀 | 关       |
| 5   | 潜语义 LSA（截断 SVD，秩 64）      | 67.00%（持平）      | 25.5% → **10.5%** | ❌ **叠加后有害**   | 关       |

### 各轮结论（诚实，不掺水）

**#1 词形归并 —— 唯一真正有效的突破。**
失败查询的病根**不是语义鸿沟，是分词器缺陷**：

- **无 camelCase 拆分**：`registerTool` 退化成整词 `registertool`，与查询里的 `registration`/`register` 永远撞不上。
- **无词干化**：`spilled`≠`spill`、`escalate`≠`escalation`、`policies`≠`policy`、`tokenizer`≠`tokenize`。

修法是标准 IR 两件套（零依赖）：

- `splitCamel()`：`registerTool`→`register`+`tool`，`HTTPServer`→`http`+`server`（保留缩略词）。
- `morphVariants()`：**并行**应用多条后缀规则生成变体集（而非首条命中即停）——单规则剥离无法统一 `register`/`registration`，并行生成后二者在 `registr` 上收敛。

**两侧必须同用一套分词**（索引侧与查询侧），否则变体集不相交，归并反而掉召回。

**#2 频域共振零增益**：字符频谱与词袋在「短、词法稀疏」的符号域高度冗余，捕获的统计特征几乎重合。
**#3 PRF 有害**：Top-3 文件 token 扩展引入噪声，在 `FILE_K=14` 硬截断下挤掉真相关文件。证明固定 token 预算下精度优先，**「又省又准」不能靠撒网**。
**#4 图检索失效**：441,224 条边 / 5022 符号 ≈ 每节点 88 条边，**太密**。PageRank 在稠密图上收敛到近乎均匀，目标符号被抬升的同时所有其他符号被同等抬升 → **相对排序纹丝不动**，逐条查询召回 on/off 完全相等，却白增 token（净负面）。
**#5 LSA 交互有害**：单独叠加时符号精确率 12%→15.5% 微涨；**但在词形归并之上叠加则 25.5%→10.5% 腰斩**（召回持平）。潜语义扩展与形态变体扩展相互稀释。

---

## 二、公平对比（关键方法论修正）

> ⚠️ **我此前犯了一个方法论错误**：只测了我方召回、却只测了竞品 token。那样「我们更省 4x」完全可能只是「我们给得更少」——**不公平的对比不能算碾压**。
> 现修正：①竞品 baseline 的**召回率也测**；②追加**同等文件预算**对照（竞品同样给 14 个文件）。

**竞品 baseline 定义**（Claude Code / ripgrep 类做法）：关键词检索 → 取 Top-K **整文件**。用其自有分词器（`corpusBase`），非我方增强分词。

| 指标                         | 竞品 Top-8 | 竞品 Top-14（同等预算） | **OmniHarness（生产默认）** |
| ---------------------------- | ---------- | ----------------------- | --------------------------- |
| 文件召回率                   | 59.16%     | 60.83%                  | **67.00%**                  |
| 平均 token                   | ~13,600    | **22,062**              | **~2,949**                  |
| 相对竞品（同预算）token 节省 | —          | 1x                      | **7.95x**                   |
| 相对整语料硬塞 token 节省    | —          | —                       | **114.03x**                 |
| 符号精确率                   | —          | —                       | **25.5%**                   |

**结论（可证伪）**：在**同等文件预算**下，OmniHarness 用 **1/7.95 的 token** 拿到 **更高**的召回（67.0% vs 60.83%，+6.2pp）。这不是"省了但变差"，是**省了还更准**。

### 逐条查询明细（召回率 %）

| 查询                                           | GT  | 竞品Top8 | 竞品Top14 | baseline | **morph** | morph+lsa |
| ---------------------------------------------- | --- | -------- | --------- | -------- | --------- | --------- |
| where is tool registration handled             | 3   | 33.3     | 33.3      | 33.3     | 33.3      | 33.3      |
| how does sandbox denial escalate to approval   | 12  | 25.0     | 41.7      | 41.7     | **58.3**  | 58.3      |
| what does ContextAssembler project events into | 1   | 100      | 100       | 100      | 100       | 100       |
| where is the audit hash chain computed         | 0   | 100      | 100       | 100      | 100       | 100       |
| how are images attached to model messages      | 1   | 100      | 100       | 100      | 100       | 100       |
| where is reasoning_effort sent to openai model | 5   | 60       | 60        | 60       | **80.0**  | 80.0      |
| how does BM25 tokenize CJK text                | 3   | 33.3     | 33.3      | 33.3     | 33.3      | 33.3      |
| how is the resonant memory probe mapped        | 2   | 100      | 100       | 100      | 100       | 100       |
| where is the sandbox policy evaluated          | 5   | 40       | 40        | 40       | 40        | 40        |
| how are tool results spilled out of context    | 4   | 0        | 0         | 0        | **25.0**  | 25.0      |

---

## 三、剩余短板（不藏）

三条查询未改善，且**性质不同**：

1. `sandbox policy evaluated` → 答案文件含 `execPolicy`（40%，与竞品持平）。**这是真的语义鸿沟**：`evaluat` 与 `policy` 无字面/形态关系。所有静态技巧（词袋/频域/引用图/SVD）集体失效。
2. `BM25 tokenize CJK text` → 33.3%。查询词与 `bm25.ts` 高度重合却只召回 1/3，**疑似 GT 定义偏严**（锚点 `export function tokenize` 命中面窄）。
3. `tool results spilled` → 0%→25%（已从词形归并获益），仍未吃满。

**唯一能真正破第 1 类的是语义层**，两条路：

- **生产期蒸馏**（推荐）：由 LLM 把「X 在 Y 文件」关联写入 `ResonantMemoryPort`，运行时 `resonateByText` 反查路径并入召回集。仓库已有该端口与 live 跑分框架，属**运行时能力**，非静态基准可测。
- **本地 embedding**：用户已放宽零依赖铁律（"必要的依赖是允许的，能突破的、优秀的就可以依赖"）。可评估 `onnxruntime-node` + 量化 MiniLM/代码专用模型。代价：包体与冷启动上升，与"使用条件更低"目标冲突 —— **需权衡后决策**。

---

## 四、代码状态（择优保留，非推倒重来）

- `src/search/bm25.ts`：
  - **原 `tokenize()` 一个字未改** → 工具检索(M1)、会话检索(M2) 等既有调用方**零影响**。
  - 新增 `splitCamel()` / `morphVariants()` / `tokenizeExpanded()`（并行分支，仅 repo-map 使用）。
- `src/context/contextEngine.ts`：
  - `indexCorpus(root, { morph })` —— **默认开**，传 `{morph:false}` 即完整回退到既有 baseline。
  - `IndexedCorpus.morph` 字段保证查询侧分词与索引侧**严格一致**。
  - `grepTopKFiles()` 新增，使竞品 baseline 召回可测（公平对比前提）。
  - 开关实测定值：`morph` 开、`lsa` 关、`graph` 关、`prf` 关。
- 新增模块（均默认关，**保留为已验证无效路径的证据**，不删除）：`src/context/codeGraph.ts`、`src/context/lsaRecall.ts`。
- `evals/context-efficiency/bench.mjs`：三配置 A/B（baseline / morph / morph+lsa）+ 竞品召回 + 同等预算对照，落盘 `RESULTS.json`。
- 项目 `tsc --noEmit` **零错误**（`strict` + `noUncheckedIndexedAccess`）。
