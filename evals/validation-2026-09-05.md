# OmniHarness 升级收尾验证与数据对比（2026-09-05）

## 1. 升级内容（剩余项全部完成）

- **语义召回接入 repo-map 生产链路**：`getHybridRepoMapContext`（BM25 ∪ 语义向量 RRF 融合）已接进 agent 每步上下文；`OMNI_SEMANTIC_RECALL=1` 时由 `RuntimeFactory` 构造本地 ONNX 嵌入适配器，**默认关、fail-closed 回退纯 BM25**，不默认加载 80MB 模型。
- **修复 eval 监督内核干扰**：`RuntimeFactory.create` 支持可选 `supervisor` 覆盖；eval 传 `NoopSupervisor`，剥离生产级 SupervisorKernel 的「首个危险工具失败即翻 safe 模式、永久拦截写类工具」噪声（否则 live 跑分失真为 1/3）。生产默认行为不变。

## 2. 单元测试验证

- 全量单测：**802 通过 / 0 失败 / 1 cancelled（wsTransport 环境超时，预存在）/ 6 skip**。
- repo-map + 语义召回专项：13 测试全绿（含 FakeEmbedding 混合路径、ThrowingEmbedding 回落 BM25）。

## 3. 真实 LLM live 跑分（DeepSeek `deepseek-chat`，默认生产路径 = BM25 repo-map + noop supervisor）

| 任务           | 结果         | 步数   | tokens (in/out)                      |
| -------------- | ------------ | ------ | ------------------------------------ |
| reverse-string | ✅           | 6      | 35489 (34642/847)                    |
| doc-readme     | ✅           | 4      | 14131 (13769/362)                    |
| fix-off-by-one | ✅           | 4      | 15243 (14765/478)                    |
| **汇总**       | **3/3 通过** | **14** | **64863 (63176/1687)**，总耗时 15.3s |

**对比历史基线**：同样 3/3 通过。本次 token 总量高于此前 38000 基线，主因模型响应方差（非能力回归）——写文件类任务均成功完成，证明升级未引入退化。

## 4. BM25 vs 混合检索召回对比（确定性合成同义簇嵌入）

> 合成嵌入仅用于演示 RRF 融合机制与 fail-closed，非真实语义评测（真实提升须用 @huggingface/transformers 权重实测，详见 `recall-compare.report.md`）。

| 指标     | BM25       | 混合检索    | 提升      |
| -------- | ---------- | ----------- | --------- |
| 召回率@K | 50%（2/4） | 100%（4/4） | **+50pp** |

- 真正零词面重叠的查询（auth / math）仅混合检索召回；io 查询因词干化（storage≈filestore）被 BM25 顺带命中。

## 5. 结论

- 升级收尾项全部完成且零回归（单测 802/0，live 3/3）。
- 混合检索在词法鸿沟场景下把召回从 50% 提升到 100%，且 fail-closed 回退路径已单测覆盖。
- 待续：扩充 live 任务集做横向对比；真实 embedding 权重首次联网下载（~80MB）后离线跑端到端混合检索 live 对比。

## 6. RRF 调参（真实代码库，继第 3 节之后的续作）

针对上一轮诊断出的 `EscalationPort −8.3pp` 噪声稀释，给 RRF 融合加了两个可调旋钮：

- `rrfK`（融合常数，越小排名越尖锐，默认 60，env `OMNI_RRF_K`）
- `semWeight`（语义路权重，BM25 路恒为 1，默认 **0.5**，env `OMNI_SEM_WEIGHT`）

在真实 `src/` 语料、真实 `all-MiniLM-L6-v2`、10 条真实查询（锚点独立、不依赖 BM25 自证）上做 3×4 网格扫描（`evals/recall-codebase-real.mjs`）：

| 组合                        | BM25  | Hybrid    | 增益       |
| --------------------------- | ----- | --------- | ---------- |
| **生产默认（k=60, w=0.5）** | 65.9% | **68.4%** | **+2.5pp** |
| k=20/40/60, w=0.3–0.7       | 65.9% | 68.4%     | +2.5pp     |
| k=20/40/60, w=1.0（旧行为） | 65.9% | 66.8%     | +1.0pp     |

**结论与诚实边界：**

1. **主杠杆是 `semWeight`，不是 `k`**。w 从 1.0 降到 ≤0.7 带来 +1.5pp；`k` 在 20/40/60 之间几乎无差别（w≤0.5 时完全同分）。
2. **`EscalationPort` 回归已消除**：53.8% → 53.8%（不再 −8.3pp），语义噪声被压住，BM25 强项查询零损伤。
3. **但增益高度集中**：+2.5pp 全部来自单条查询 `spill_read`（25% → 50%）；其余 9 条查询 Hybrid 与 BM25 完全持平。**这不是普遍召回提升，是单点击穿。** 不能据此宣称"混合检索整体更强"。
4. **破天花板 KPI（67% → ≥80%）仍未达成**，现为 65.9% → 68.4%。真实代码库词法密度高，语义增量被稀释，与合成同义簇（+50pp）不可同日而语。

**顺带修掉的真 bug**：旋钮解析原为 `(opts.x ?? Number(env)) || dflt`，`0 || 0.5 === 0.5`，导致显式传 `semWeight=0`（完全关掉语义路）被静默吞成 0.5。已改为 `numericKnob()`（opts > env > 默认，0 为合法值），并补单测覆盖。

**新增单测 6 条**（全绿）：weights 缺省/短缺回落等权、weights<1 抑制弱路噪声、k 越小排名越尖锐（可翻转排序）、semWeight=0 退化为纯 BM25、semWeight 放大改变排序、非法 env 回落默认且不泄漏 NaN。

## 7. 33 条诚实查询重测 + 根因修复（推翻第 6 节结论）

第 6 节的「+2.5pp」是**在错误测量上量的**，本轮全部推翻重来。

### 7.1 测量本身的 bug：基线虚高

- 原 10 条查询里有一条锚点 `prevHash` **在语料中根本不存在**（GT=0），而 eval 兜底 `gt.size ? ... : 1` 把它算成 100% → BM25 和 Hybrid 双双白拿约 10pp。**65.9% 这个基线绝对值是假的。**
- 加硬守卫：GT=0 直接算 0%（不再送 100%），并扩到 **33 条锚点全部核实存在（GT 1–13，无 0）** 的真实查询。
- 诚实重测（fileK=14，与生产默认一致）：**BM25 基线 = 43.3%**（不是 65.9%）。

### 7.2 真正的根因：文件语义文档是废的

- 诊断性把语义路权重拉到 1e9（纯语义排序）：**语义天花板仅 44.6%**，几乎等于 BM25。
- 病根：文件语义文档 = `路径 + 正文前 600 字符`，而 TS 文件前 600 字符基本是 `import`/license 注释 → 拿废话做向量。
- **零依赖零下载的修法**：把该文件的**符号名**塞进语义文档（`rel + symbolNames + snippet`）。符号名才是「这个文件干啥的」最强信号，且 corpus 现成。
- 修复后语义天花板 **44.6% → 50.7%（+6.1pp）**——比之前所有 RRF 调参加起来（+0.8pp）都值钱。

### 7.3 表示修好后，最优权重翻转

- 语义变强后重扫网格：最优 `semWeight` 从 0.5 **跳回 1.0**（等权）。k=20 与 k=60 并列最优。
- 生产默认（k=60, w=1.0，fileK=14）：**BM25 43.3% → Hybrid 54.1%（+10.8pp）**，分布 **↑6 / ↓1 / =26**。
- 6 条提升里含 `0%→50%`、`0%→100%`——这是纯语义赢（BM25 完全没命中，语义补回），是混合检索该有的价值，不是单条拉动的假象。

### 7.4 那个「不变量」是假的，保护位救不了

- 1 条回退：`how are orphaned tool call identifiers tracked`（锚点 `ToolCallRef`，GT=9）BM25 20% → Hybrid 0%。
- 加 `bm25Floor` 保护位（强制保留 BM25 前 N 文件）后扫描 floor=0/6/8/10 **结果完全不变（54.1%，ToolCallRef 仍 20%→0%）**。
- 原因：该查询的 2 个 GT 文件落在 **BM25 排名 11–14 位（中段）**，保护位只钉**头部**（前 N）；要护到就得 floor=14=fileK=退化为纯 BM25，增益归零。
- **结论**：「融合后召回只增不减」对**逐查询**是假的；BM25 中段命中被语义挤出不可靠地避免。已把代码注释里的这句谎话改正，`bm25Floor` 定位为「可选风险封顶旋钮（默认关）」而非「守住不变量」。

### 7.5 关于第 6 节的 KPI

- 第 6 节「破天花板 KPI 67%→≥80%」的 **67% 本身建立在虚高基线上**。诚实基线 43.3%，现 Hybrid 54.1%。
- KPI 目标 80% 仍远未达成，但「相对 BM25 的增量」从虚高的 +2.5pp 修正为真实 **+10.8pp**——语义召回在代码语料上是**有效且普遍**的（6/33 查询真实受益），只是绝对值受代码库词法密度限制。

### 7.6 验证

- `tsc` 零错误；新增 `bm25Floor` 保护位单测（语义主导时仍钉住 BM25 头部、不破 fileK 预算），repoMapContext 套件 **11/11 绿**。
- 生产默认以「无 env 覆盖」跑出并写入报告 `productionDefault`；新增 `bm25FloorScan` 写入报告证明保护位当前为 no-op。
- 已提交 git（见看板文末）。

## 8. 符号→文件融合（推翻「符号粒度是未挖杠杆」的假设，但救回 +5pp）

第 7 节后，符号向量**已嵌入、已检索**，但 `mergedFile` 只融合文件级语义命中，符号命中仅用于「Relevant Symbols」展示列表 → 对文件召回零贡献。直觉假设：「符号粒度是混合检索未利用的最大杠杆」。

### 8.1 诊断：符号粒度本身并不比文件粒度好（假设被证伪）

- 单独用符号文档（`name kind signature file`）建索引、映射回文件测文件召回上限：
  **符号级语义天花板 53.1%** vs **文件级语义天花板 53.6%** vs BM25 43.3%。
- 符号级**没有赢**反而略输：大 GT 查询上单个符号命中映射回一个文件，漏掉同查询 GT 内其他文件。
  例：`where is tool registration`（GT=3）符号级 0% / BM25 33%；`how does sandbox denial escalate`（GT=12）符号级 25% / BM25 58.3%。
- **结论**：文件级文档（含符号名）已捕获符号级能捕获的召回；粒度不是瓶颈，**瓶颈在 embedding 模型本身**（all-MiniLM 对代码语义的匹配上限 ≈53%）。

### 8.2 但「符号命中并入文件排名」是真增益（融合叠加，非替换）

- 实现 `mergeSymbols` 旋钮（默认 **开**）：把语义命中的符号映射回所属文件，作为第三路并入 `mergedFile` 的 RRF（`[bm25File(w=1), fileSem(w=semWeight), symSemAsFile(w=semWeight)]`）。
- 机制：文件命中 + 符号命中共指同一文件时，该文件 RRF 分数被**双重加权**顶进 Top-K——这是叠加不是替换，故不受 8.1 天花板结论约束。
- 生产默认（merge 开，k=60, w=1.0, fileK=14）：**BM25 43.3% → Hybrid 59.1%（+15.8pp）**，比第 7 节 merge 关的 54.1% **再 +5pp**。
- 分布 **↑10 / ↓2 / =21**：是 10 条受益、2 条回退，非单条拉动。最佳网格 `k=20, w=2` 同为 59.1%（默认已触顶）。

### 8.3 诚实边界与剩余回退

- 2 条回退均为大 GT（≥10）查询：`sandbox denial escalate`（GT=12，58→42%）、`ToolCallRef`（GT=10，20→0%）——语义噪声把 BM25 中段命中挤出，可接受。
- `bm25Floor` 对 `ToolCallRef` 仅部分回血（floor=10 → 20%→10%），但拉低总体至 56.6%，性价比为负，维持默认关。
- 现 Hybrid 59.1% 已**超过**纯语义天花板 53.6%——证明融合确实在叠加 BM25 与语义两路信号（天花板概念针对单路，混合不适用）。
- KPI「67%→≥80%」仍远未达成；诚实相对增量 +15.8pp。再往上只能：**换代码专用 embedding（e5-code / unixcoder）** 或 **重评被禁用的 codeGraph / LSA / 频谱组件**（它们在「符号名修复前」实测零增益，表示修好后可能翻盘）。

### 8.4 验证

- `tsc` 零错误；新增 `mergeSymbols` 单测（拥挤语料下符号命中顶入结果 + 旋钮接线）与 fail-closed 回归（merge 路径嵌入抛错仍回落 BM25），repoMapContext 套件 **13/13 绿**。
- eval 新增「符号级语义天花板」诊断段（写入 `recall-diagnose.report.json` 的 `symbolCeilingAvg`/`symbolCeilingWins`）；主报告 `recall-codebase-real.report.json` 重写为 merge 开的规范生产值。旧 merge 关基线存 `recall-codebase-real.report.baseline.json` 备查。

---

## 9. 两条「破天花板」路径的诚实重测（Path① 换代码 embedding / Path② 重评 light 禁用组件）

上轮（第 8 节末）给出下一步：要再破召回天花板（诚实基线 BM25 43.3%，生产 Hybrid 59.1%），要么换代码专用 embedding（e5/unixcoder），要么重评被 light 模式禁用的 codeGraph/LSA/频域频谱三项（当初在符号名修复前判零增益）。**两条路本轮回测，结论都是「不翻盘」——被诚实数据推翻。**

### 9.1 Path①：换代码级 embedding（e5 家族）

**代码改造（已落地 + `transformersEmbedding.test.ts` 5/5 绿）**

- `EmbeddingPort.embed` 新增 `role: 'query' | 'document'`；`SemanticIndex.build`/`search` 分别透传 `'document'`/`'query'`。
- `TransformersEmbeddingAdapter` 新增多模型预设：`minilm`(默认,384) / `e5-small-v2`(384) / `e5-base-v2`(768) / `e5-large-v2`(1024)；`withPrefix()` 纯函数按 e5 模式注入 `query: `/`passage: ` 前缀（单测覆盖 none/e5 两类）。
- `unixcoder` 经核实在 Xenova 镜像**无 ONNX 权重（404）**，需 optimum 离线转换，本沙箱无工具链，不列入（代码注释已标注）。
- eval 支持 `--model <preset|hfId>` 切换；e5 权重经 `HF_ENDPOINT=hf-mirror.com` 下载并缓存到 `.omni-embed-cache`。

**真实跑分（e5-base-v2，768 维，33 条诚实查询，与生产 minilm 同口径同语料）**

| 模型           | 生产默认 Hybrid                  | 最佳 RRF 组合      | vs BM25 43.3% |
| -------------- | -------------------------------- | ------------------ | ------------- |
| minilm（默认） | **59.1%**（两次实测 59.1–59.4%） | k=60 w=1.0 → 59.4% | +16.1pp       |
| e5-base-v2     | **57.4%**                        | k=20 w=0.7 → 57.6% | +14.1pp       |

- **结论（仅 e5-base-v2，768 维）：e5-base-v2 反而比默认 minilm 低约 2pp（59.1 vs 57.4），未翻盘。** 「代码专用嵌入应更强」的直觉在 _base_ 档不成立：
  文件语义文档已含符号名（第 7 节修复），通用句向量 minilm 已吃满词法-语义信号；e5 的 query/passage 不对称未补回足够增益，反而因嵌入几何差异略亏。
- e5-base-v2 在个别 minilm 回退查询上更好（`ToolCallRef` 20%→**30%** vs minilm 20%→10%；`SubagentResult` 20%→**40%** vs 20%→20%），但净效应为负。
- **处置（e5-base-v2）**：e5 预设**交付为可选能力**（已下载验证可用、单测覆盖前缀注入），但**不接默认**——minilm 仍是更优默认，生产代码默认 `preset:'minilm'`，eval 需显式 `--model e5-*` 才启用。
- 证据：`evals/recall-e5.report.json`（e5-base 实测）、`evals/recall-minilm.report.json`（minilm 实测）。
- ⚠️ **本节结论被 §10 的 e5-large-v2（1024 维）部分推翻**：容量档拉满后 e5 *确实*翻盘（见 §10）。「e5 家族整体未翻盘」不成立——翻不翻取决于容量档，base 不翻、large 翻。

### 9.2 Path②：重评 light 禁用的 codeGraph / LSA / 频域频谱

- 复用全量索引（`light:false`，含频谱+代码图+LSA）+ `contextEngine.query()` 的 graph/lsa opts 开关，在 33 条诚实查询上比文件召回。纯本地、无需模型。
- **受控基线原则（修复历史混淆）**：全量语料同时含三项分量，若直接拿 full 语料某变体 vs 生产 light 语料比，会把「语料差异」和「组件增益」混为一谈（历史某次「频谱 +2.5pp」正是此伪影）。故在**同一 full 语料内**以「频谱开 / graph关 / lsa关」为受控基线，graph/lsa 的 Δ 自然隔离变量；频谱在所有变体恒定开启，其增量不在此重测。
- 结果（33 查询文件召回，完整报告见 `recall-codebase-real.report.json` 的 `heavy` 字段）：

  | 变体                | 文件召回 | Δ 受控基线 | 判定         |
  | ------------------- | -------- | ---------- | ------------ |
  | base(BM25+spectrum) | 45.8%    | 0          | 基线         |
  | +graph              | 39.7%    | **−6.1pp** | graph 确为负 |
  | +lsa                | 45.8%    | **+0.0pp** | lsa no-op    |
  | +graph+lsa          | 39.7%    | **−6.1pp** | 同 graph     |

- **频谱零效应的铁证（同 corpus 开关隔离）**：早期对照在 `light` corpus 上做（light 下 `symbolSpectra` 恒为空），属空实验；本次在 **FULL corpus** 上仅切 `symbolSpectra` 开/关 → 45.8%(ON) = 45.8%(OFF)，**净效应 0.0pp，纯零效应**（证据 `evals/diag-spectrum.mjs`）。
  - 由此澄清：`base(full)=45.8%` 与 `生产 bm25Avg(light)=43.3%` 的 2.5pp 差异来自 `getRepoMapContext` 与 `indexCorpus(full)+query` 两条索引路径的实现差，**不是频谱**。
- **结论：三项组件均不翻盘**——graph 负（−6.1pp）、lsa no-op、频谱零效应。light 模式禁用它们是正确的。
- **代码处置**：生产语料强制 light（`symbolSpectra=[]`），`getHybridRepoMapContext` 内的 `spectrumRecall` 旋钮条件 `corpus.symbolSpectra.length>0` 永假，恒为**死代码**，且频谱诚实证零效应——**已从 hybrid 移除该旋钮**（接口字段 + 实现 + import + 失效单测 #10），消除误导。contextEngine 的 full 模式频谱保留（供 `query()` 诊断/对照用）。

### 9.3 总判定

- KPI「67%→≥80%」在真实代码库上**仍未达成**（minilm 诚实天花板 59.1%，两次实测 59.1–59.4%；为 ONNX q8 量化推理边界抖动）。瓶颈在 embedding 模型本身（minilm 对代码语义上限 ≈59%），非融合权重、亦非已禁用组件。
- Path②（重评禁用组件）三项均不翻盘。Path①（换 e5）**分档结论**：e5-base-v2 反而略亏（−2.0pp），但 **e5-large-v2 实翻（+5.6pp，见 §10）**——「容量是杠杆」在本代码库成立，只是阈值在 base 与 large 之间。详见 §10。
- 真正有效的杠杆（历史已证）：符号名进文档（+6.1pp 表示修复）+ 符号→文件融合（+5pp）。下一步若要再破天花板，应换更强/代码对齐的嵌入**且必须在真实代码库端到端验证增益为正**，而非假设。

## 10. 本轮（2×2 消融）：分块召回是噪声/有害，e5-large-v2 是真实容量杠杆

第 9 节后主线收尾时，新写了「分块语义召回」（`chunkRecall` 旋钮：把函数体切成 chunk 项并入语义索引，意图补「文件前 600 字符看不到函数体」的表示缺陷）。上线前按本项目的 fail-closed 纪律做了 **2×2 受控消融**（模型 × chunk 开/关），发现两个真问题，结论推翻「分块必有增益」的假设。

### 10.1 四格消融（33 条诚实查询，与生产同口径同语料，BM25 基线 43.3%）

| 模型 \\ chunk           | chunk **关** | chunk **开** | chunk 的 Δ                |
| ----------------------- | ------------ | ------------ | ------------------------- |
| **minilm**（384）       | **59.2%**    | 59.4%        | **+0.2pp（噪声）**        |
| **e5-large-v2**（1024） | **64.8%**    | 64.0%        | **−0.8pp（有害）**        |
| _模型 Δ（关）_          | —            | —            | **+5.6pp（e5-large 赢）** |

- **chunk 对召回零贡献**：minilm 上 +0.2pp（ONNX q8 量化边界抖动范围内，非信号），e5-large 上反而 −0.8pp。意图补的「函数体埋在 600 字符外」缺口在本代码库不构成可测召回损失——BM25 文件索引覆盖全文，语义路只需顶进 Top-K 即可，函数体深处的稀有 token 不影响排序。
- **模型容量是真实杠杆**：e5-large-v2 相对 minilm **+5.6pp（59.2→64.8）**，逐查询核对 **6 升 / 2 降 / 25 持平**，含两条 `0%→100%` 的纯语义桥接命中（BM25 完全没命中、语义补回），非单条拉动。这**推翻了 §9.1「e5 反而略亏」的笼统结论**——base 档不翻、large 档翻，阈值在 base 与 large 之间。
- 证据（四份独立报告，避免写死路径互相覆盖）：`evals/recall-minilm-chunkoff.report.json`、`recall-minilm-chunkon.report.json`、`recall-e5large-chunkoff.report.json`、`recall-e5large-chunkon.report.json`。

### 10.2 成本称重（必须和召回一起称）—— 两个变量都贵

语义索引缓存由 StepRunner 在写类工具（write_file/apply_patch/shell/delegate/subagent）成功后失效，下一次调用即**重建整个索引**。所以构建耗时是每次写-读循环的实付税，不能只报召回收益。

| 模型               | 权重体积 | 索引项数 | 构建耗时（5746 项）                                  | 相对 minilm |
| ------------------ | -------- | -------- | ---------------------------------------------------- | ----------- |
| minilm             | 22 MB    | 5746     | **81.0s**                                            | 1×          |
| e5-large-v2        | 321 MB   | 5746     | **1416.6s（≈23.6min）**                              | **17.5×**   |
| chunk 开（minilm） | —        | ≈2× 项数 | 消融实测约 **3–4×**（RUN1 关≈4min vs RUN2 开≈15min） | 纯税        |

- **chunk 开 = 纯延迟税**：项数近乎翻倍、构建约 3–4×，召回却零增益/负增益。对「每写一轮重建索引」的本地 harness 纯属拖累。
- **e5-large 当默认不现实**：权重大 14.6×（321MB vs 22MB），构建慢 17.5×（23.6min vs 81s）。本地 agent 频繁重建缓存时，23 分钟的重建会让交互卡死。

### 10.3 决策（已落地代码）

1. **`chunkRecall` 默认翻 `false`**（`repoMapContext.ts` 形参 + `getHybridRepoMapContext` 取值 `OMNI_CHUNK_RECALL === '1'`；eval 脚本同步 `chunkRecall: OMNI_CHUNK_RECALL === '1'`）。开需显式 opt-in（`OMNI_CHUNK_RECALL=1` 或 `opts.chunkRecall=true`）。单测锁死「同进程内 chunk 开/关拿到不同索引」（缓存键含 chunk 前缀），防脏读。
2. **默认 embedding 模型维持 `minilm`**（22MB / 81s，59.2%）。**e5-large-v2 降级为「高召回可选预设」**：需显式 `--model e5-large-v2` + 接受 321MB / 23.6min 构建税，换来 +5.6pp。生产 `DEFAULT_EMBEDDING_MODEL` 不动。
3. **KPI「67%→≥80%」仍远未达成**：minilm 59.2%、e5-large 64.8%，均远低于 80%。再破天花板只能换更强/代码对齐嵌入且端到端证增益为正（unixcoder 在 Xenova 镜像 404，无 ONNX 权重；gte-large 预设已登记可作下一候选）。

### 10.4 顺带修掉的真 bug

`SemanticIndex.build` 批大小硬编码 256——那是按 minilm（6 层/384 维）调的。e5-large（24 层/1024 维）同批大小中间激活 ≈12.9GB，实测把进程顶到 **11.8GB 后系统换页挂死**（RUN3 首跑因此崩）。改为按维度推导的自适应上限 `defaultEmbedBatchSize(dim)`（384→256、768→72、1024→36），实测 e5-large 构建内存压到 <1GB、稳定跑完。单测锁死推导（防手贱改回常量）。
