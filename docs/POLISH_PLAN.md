# OmniHarness 打磨计划（2026-09-15）

> **定位**：把「提高准确率 / 降低 token / 提高命中准率 / 提高项目质量 / 齐平并超越行业」拆成
> **可交付、可测量、可证伪**的条目。每条含：缺口证据 → 行业参照 → 方案 → 验收口径 → 风险 / 工作量。
> **纪律**：沿用本仓库既有铁律——**度量先行、两关评测（否决器放行 ≠ 有效）、不报点估计（bootstrap CI）、
> 负结果同样入库、零运行时依赖、不碰核心循环**。凡未实测的数字一律标「自报 / 待测」。

---

## 0. 一页判读

本仓库**检索侧已被反复打磨至接近该语料的词法上限**（BM25 诚实基线 38–43%，混合语义 59.1%），
且历史图 / LSA / 频谱 / 层化四路均实测**零增益或负增益**已被默认关闭。故本计划的真实增量**不在「再加一路检索」**，
而在三处**结构性欠账**（下述按 ROI 排序）：

| #      | 条目                                              | 维度           | 预期 | 依据                                                                                                     |
| ------ | ------------------------------------------------- | -------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| **P1** | 零依赖 **reranker**（两阶段检索第 2 段）          | 命中准率↑      | 中   | 行业「retriever 定上限、refine 补精确」；本仓库**无 rerank 阶段**（仅 RRF+符号融合）                     |
| **P2** | **确定性压缩接线**（已建未接）                    | token↓         | 中   | 审计：`compressContext`/`foldHistorySegments` 仅 `src/index.ts` 导出、**生产零调用**                     |
| **P3** | **主循环自验证回环**（跑测试 / 自查）             | 准确率↑        | 高   | 审计：主循环**不自跑测试**；`SelfChecklist`/`goalChecker` 有件未装                                       |
| **P4** | 护栏**工具输出来源信任级**                        | 准确率·安全↑   | 中高 | 实测 `tool-output` 召回 0/6（主威胁面无覆盖）⇒ **已落地 6/8=75%、FP 16.7%→8.3%**                         |
| **P5** | 软预算 + **per-tool token 归因**                  | token↓(可观测) | 中   | 审计：成本仅**硬熔断**、cache 命中不折抵、无归因 ⇒ **已落地缓存折抵 + 工具归因 + 软阈值信号 + 生产入口** |
| **P6** | 官方 **SWE-bench Verified / Terminal-Bench** 出数 | 齐平·超越      | 高   | B1 接线 code-ready，待 docker/Modal 凭证                                                                 |
| **P7** | **有界均衡并行调度**（突破串行瓶颈）              | 吞吐·墙钟↓     | 中高 | 三处串行：官方 500 题逐个实例 / 整套 TaskBench / worker 批量委派（本轮已接线）                           |

**已完成的受控实验（本轮）**：`evals/bm25-tune.mjs`——把研究公认的「检索第一杠杆」（BM25 `k1`/`b` 调参）
在本语料上跑**全网格 + bootstrap CI + repeated 2-fold 留出折**。结论：**无稳健增益，默认 1.5/0.75 已近最优，不翻默认**
（详见 §3）。这是一次**受控排除**，把「调 BM25 参数」从候选清单划掉，避免后续重复投入。

**已落地（打磨批次）**：**P7 有界均衡并行调度**（`src/util/parallelMap.ts` + 三处串行瓶颈接线，见 §4-P7）；
**P2 确定性无损收缩接线**（`DeterministicCompressor` 无损子集接进 `ContextCompactor`，实测 JSON 型工具输出 −29%，见 §4-P2）；
**P1 零依赖词法 reranker**（`FileRerankIndex` + `FileReranker` + `ContentStopWords`；判定档 fileK=14 召回 31.4%→41.0% /
CI[1.80,18.60]pp 两关全过；**2026-09-17 检索预算 10→14 翻默认后生产档亦两关全过 ⇒ 精排已随预算一并默认开**，见 §4-P1）；
**P4 工具输出来源信任级**（`ToolOutputTrust` 分级敏感 + 强/弱/启发式三层规则；tool-output 召回 0/6 → **6/8=75%**、
FP 16.7% → **8.3%**，见 §4-P4）；
**P3 主循环自验证回环**（`SelfVerifyingToolPort` 装饰器：写源码后按确定性触发器自动跑受限测试 + 假完成探测，
失败摘要回灌；真实 e2e 验收，见 §4-P3）；
**P5 成本预算可观测性**（`CostBudget` 缓存折抵 + `TokenAttribution` per-tool 归因 + 软阈值信号；
并补齐 `costBudget*` 的 CLI/配置文件生产入口，见 §4-P5）。

---

## 1. 行业参照（2026，外源结论逐条标注；厂商自报标「自报」）

- **Retriever 定上限**：组件级研究（Ke et al. 2026）称 SE 任务 RAG 里 **retriever 选择的影响大于 generator**，
  且经典 **BM25 在标识符密集语料上「exceptionally robust」**，应作**默认而非兜底**；invest 顺序 =
  retriever → 上下文长度/分块 → query 处理 → generator。⚠️ 但 BM25 在「自然语言查询 × 标识符文档」的词法鸿沟下
  **崩到 0.400**（技术术语查询 0.833–0.867）——即**语义路在 NL 查询上不可替代**，与本仓库 43%→59% 的混合增益一致。
- **检索表示的天花板**：`semble`（MinishLab 2026）在 63 仓库/1251 查询上 NDCG@10——BM25 **0.673**、
  CodeRankEmbed-Hybrid **0.862**；且**token 效率**：semble 566 tok/query vs `ripgrep+read` **45,692**（**−98%**）。
  ⇒ **「命中准率↑」与「token↓」同源**：检索更准 ⇒ 需要读的文件更少 ⇒ token 自然降。
- **上下文工程**（Morph / Fowler / Anthropic）：存在「**1M token 墙**」——超限后不看窗口大小、性能都退化；
  **Claude Code 比 Cursor 少用 5.5× token**（自报）；**子代理隔离 > 上下文压缩**（「context in, summary out, nothing retained」）；
  **系统提示瘦身**单会话省 ~7,300 token（砍问候/复述/文件清单/变更摘要等样板）。
- **压缩时机**：8 框架调研（crabtalk 2026）——**没人协调多代理压缩**；压缩应**保留 action-outcome 对**而非自然语言叙述；
  SupervisorAgent 变体「观测净化」平均省 **29.68%** token。
- **动态上下文**：Cursor 只喂「活跃文件 + git diff + 符号引用」的**增量**，**减 47% token 且质量不降**（自报）。
- **分块定天花板**：coderlegion 案例——「**retriever 无法返回被 chunking 毁掉的信息**」；AST/符号级分块抬升上限；
  但 **hybrid 非万能**（对部分模型 hybrid 反而降召回）。
- **技能**：SkillsBench——人工技能 +16.2pp，**AI 自生成技能无正增益**、堆叠引噪声（⇒ 本项目不应再新增隐喻引擎，先升格）

## 2. 本仓库四维机械盘点（2026-09-15，只读审计，含文件证据）

- **token 侧**：基础提示词在 `src/cli/cliBuildConfig.ts`（~1–1.5KB 静态）；项目指令 `src/context/projectInstructions.ts`
  （AGENTS.md/CLAUDE.md + `@import`，32KiB 预算，TTL 30s）；工具输出 `toolResultSpiller` + `spillPolicy`（**按字节阈值外溢**为预览+句柄）；
  历史 `contextCompactor`（**0.8×window 阈值 + LLM 8 段摘要**，`keepRecent=6`）；子代理 `subagentRunner`（全新上下文）；
  计量 `costBudget`/`budgetedModel`/`tokenEstimator`/`contextBreakdownEstimator`；缓存友好 `prefixStability`。
  **缺口**：`deterministicCompressor`（去空行/JSON 紧凑/去重/长输出截断/历史折叠）**生产零调用**（P2 已接线，见 §4）；
  `prefixStability` **已治（2026-09-16，第 25 条）**：`evals/prefix-stability.mjs`（`npm run eval:prefix`）
  走生产路径多回合真跑 Agent、录制真实 messages，实测**跨回合前缀复用率骤降**（动态段 repo-map 坐头部，一变即废其后全部历史缓存）：
  10 回合末 **现状 54.46% vs 「动态段移尾」对照 80.75%（+26.29pp）**、**交叉点 6 回合**。治理落地 = `stepContextBuilder.buildMessages` 把逐轮变化的 repo-map
  动态段从「事件历史之前」移到「事件历史之后」（尾部 system 消息），稳定前缀 = `world_state + 常驻指令 + 事件历史`，**实测复用率 54.46% → 80.75%**落地；
  常驻指令仍留头部保 prompt cache 锚点；repo-map 内容与压缩逻辑不变、仅位置后移，**默认部署纯 prompt cache 优化、行为与质量零变化**（受控对照数字已证）；
  PTC 压缩测试因 repo-map 移出 compactor 输入而解耦（显式 `OMNI_REPO_MAP=0` + 预算 30 + 断言放宽为 `OMNI_COMPACTION_V1|上下文压缩`），见 `TASK_BOARD.md` §5 第 25 条 ④；**质量侧仍待 P6 外部凭证并测**（但属缓存优化、不触模型语义）。**无滚动 action-outcome 账本**；成本**仅硬熔断**（P5 已补缓存折抵 / per-tool 归因 / 软阈值，见 §4）。
- **检索侧**：`Bm25Index{k1,b}` 可注入但**生产全不传参**（默认 1.5/0.75）；`tokenizeExpanded`（camel 拆分 + 词形归并）；
  语义/混合 `hybridRanker`+`semanticIndex`（**默认关**，需 `OMNI_SEMANTIC_RECALL=1`）；旋钮 `recallKnobs`（**fileK 默认 20**, symK=24/30, rrfK=60…）；载荷形态 `payloadShape`（**默认 `tiered` 梯度投送**，注入 token 降 69.9%；`degrade` 应急压缩再降至 81.1%；`full` 回退历史口径）；
  **精排 `FileReranker` 默认开**（`repoMapContextEngine` 混合路径已接第二段精排；关闭：`OMNI_RERANK=0`。注：原文「无 reranker」已因 `TASK_BOARD.md` §5 第 28 条翻默认为「开」而**失效**，此处更正）；层化/图/LSA/频谱**均默认关**（实测负）；评测 `evals/recall-codebase-real.mjs` 等。
- **准确率侧**：主循环**不自跑测试**（无 FAIL_TO_PASS 回环）；护栏 `promptInjectionGuard`（16 正则，opt-in）实测
  recall 1.0 / precision 0.857 / FP 0.167，但 **tool-output 0/6、natural-language 0/4、source-code 0/1**；
  重试/熔断齐备；SWE-bench 适配器在（自研 10 题 live 9/10）。
- **质量侧**：`tests/unit` **222** 个、`tests/integration` 3 个、`tests/bench` 4 个；`evals/` 多次消融；门禁六道齐备。

## 3. 本轮已做：BM25 `k1`/`b` 受控调参（负结果入库）

- **实现**：`Bm25Index.search(q, limit, options?)` 支持**打分期覆盖**（索引与 k1/b 无关 ⇒ 同语料零成本重打分）；
  `contextEngine` 的 `IndexOptions`/`query` 新增 `bm25K1`/`bm25B`（缺省仍 1.5/0.75，**生产行为不变**）。
- **实验**：`evals/bm25-tune.mjs`——466 文件 / 7557 符号；33 查询（1 条锚点失效按纪律跳过 → 有效 **32**）；
  网格 6×5=30 组；fileK=14。
- **结果**：默认 32.8% → 最优 `k1=3,b=0.25` **36.1%（+3.3pp）**，但 **bootstrap 95% CI = [−0.24, 8.20]pp 跨 0**、
  **留出折（repeated 2-fold×20）平均仅 +0.39pp**（min −5.17 / max +3.91）、分布 **↑3/↓1/=28**。
- **结论**：**默认 1.5/0.75 已近最优，调参无稳健增益，不翻默认**。此为「检索第一杠杆」的**受控排除**，
  报告 `evals/bm25-tune.report.json`。⇒ 检索侧的下一步应转向 **P1 reranker**，而非继续调 BM25。

---

## 4. 打磨清单（按 ROI，落地时逐条开一笔）

> **批次划分（2026-09-16 定稿，逐批交付、每批独立验收）**：
> **第一批 · token 效率** = **P2 确定性无损收缩接线（第一批已落地）** + **P5 软预算 + per-tool 归因（第一批已落地；其留白的「自动降档」亦已于 `062a486` 收口）**；
> **第二批 · 检索命中** = **P1 零依赖词法 reranker（第二批已落地，默认 opt-in 关）**；
> **第三批 · 准确率** = **P3 主循环自验证回环（第三批已落地）** + **P4 护栏工具输出来源信任级（第三批已落地）**；
> **第四批 · 外部解锁** = P6 官方 SWE-bench Verified / Terminal-Bench 出数（待凭证）。
> P7（并发）已于上一批单独交付。

### P1 零依赖 reranker（两阶段检索第 2 段）— 命中准率↑【第二批已落地】

- **缺口**：仅 RRF + 符号融合，**无 rerank 阶段**；fileK=14 时 precision 天然被稀释。
- **方案**：对 BM25/混合的 Top-N 候选，用**第二个独立信号**重排——候选（择一或组合，全部零依赖、可测）：
  ①**符号名精确覆盖**（查询标识符命中文件内符号名的加权）；②**查询词共现邻近度**（distance-based）；
  ③**文件路径/导出性**先验。**先跑否决器**（跨查询 Top-K Jaccard），再过 AB（同 corpus 开关隔离召回）。
- **验收**：召回/精度对照 + bootstrap CI（范式 `evals/layered-recall-ab.mjs`）；CI 下界 >0 且留出折为正才翻默认。
- **风险**：中（本仓库历史负结果多）。**工作量**：0.5–1d。
- **【第二批已落地（2026-09-16，`6e9024f`）】**
  - **落地形态（与初版方案的取舍）**：只取 ①**符号名覆盖**，且**以 IDF 加权**（`FileRerankIndex` 的 `weight` 转调 `Bm25Index.idf`，
    **与第一段同源**，杜绝两套口径）；最终式 `score = 1/(1+rank) + Σ(w(t)·overlap(t)) / Σw(t)`，**无自由拟合参数**（不引入 α 权重）。
    ②共现邻近度 / ③路径先验**未采用**：原型网格显示相对 ① 无额外增益，按「不加无收益机制」放弃。`resolveFloor` 默认 **0**
    （原型实测地板 0–5 在 fileK=10 档逐字相同、fileK=14 档 floor=0 略优于 5 ⇒ 近 no-op，故不引入常量）。
  - **两关（放行 ≠ 有效）**：否决器 `proceed`（fileK=14：候选 qi 0.090 vs 基线 0.138，meanOverlap 0.538 < 0.7 阈值）；
    AB 同语料开关隔离；候选池**不新增**（第一段 `candidateFiles` 不按 FILE_K 截断全量喂入，重排只置换不改集合，单测锁死）。
  - **实测（走生产路径 `RepoMapContextEngine.getRepoMapContext`；32 有效查询 / 470 文件 / 7605 符号）**：

    | 档位                   | 召回 off → on     | Δ          | bootstrap 95% CI        | 留出折                                 | 判定         |
    | ---------------------- | ----------------- | ---------- | ----------------------- | -------------------------------------- | ------------ |
    | **fileK=14（判定档）** | 31.4% → **41.0%** | **+9.6pp** | **[1.80, 18.60]pp ✅**  | 40 折均值 +9.59pp（2 折负，min −0.78） | **两关全过** |
    | fileK=10（生产默认档） | 26.9% → 33.2%     | +6.3pp     | **[−0.45, 14.74]pp ❌** | 40 折均值 +6.33pp（3 折负）            | 未过         |

    候选池天花板：avg 37.6 文件；@K 召回 10=26.9 / 14=31.4 / 20=38.1 / 30=48.1 / 50=**54.7（饱和）**；
    GT 最浅命中 ≤14 仅 19/32，**6/32 池内不可达**（语义鸿沟 ⇒ 词法重排结构上够不到，须语义路才可能补）。

  - **默认取值（先诚实判负 → 2026-09-17 两轮翻档）**：曾因「生产入口默认预算 fileK=10 的 CI 下界跨 0」而 opt-in 关
    （`OMNI_RERANK=1`）。
    - **【2026-09-17 第一轮】**：生产检索预算默认 **10 → 14**（`repoMapContextEngine.DEFAULT_FILE_K`；33 条对抗锚点查询
      命中率 **51.5% → 69.7%**，CI **[54.5, 84.8]**，下界 > 旧基线 51.5%），**精排随之默认开**——
      两者是同一决策（精排增益随候选池深度放大）。关闭：`opts.rerank = false` / env `OMNI_RERANK=0`。
    - **【2026-09-17 第二轮】**：预算 **14 → 20**，由**载荷梯度投送**（`RepoMapPayload`）买单——注入 token
      由 4829 压到 **1455（−69.9%）**，命中率再升到 **75.8% [60.6, 87.9]（+6.1pp）**，而 token 仍**低于**
      原 14 档全大纲口径（3703）。即**扩覆盖与降成本同时达成**；排序结果逐字不变（构造性）。
      验收：`evals/production-defaults-check.mjs`（三档等价性 **33/33**、旋钮可变性 **5/5 × 2**、排序不变量 **33/33**）。
  - **诚实边界**：回退集中在「查询词是通用前缀（`tool`/`sandbox`/`server`）」把同前缀兄弟文件抬起；天花板 54.7%、
    本次取到约 44% 可争取空间。报告 `evals/rerank-ab.report.json`，`npm run eval:rerank`。

### P1b BM25+RM3 伪相关反馈（查询扩展）— 命中/召回↑【本轮已落地（2026-09-16，`7375dac`）】

- **缺口**：P1 reranker 在候选**池内**重排，对「查询词法缺口」（NL 查询 × 标识符文档）无能为力——池外真相关文件捞不回。
- **方案**：经典 RM3 伪相关反馈——首轮 Top-R 文件作反馈集，TF·IDF 加权选 Top-E 扩展词，**重排（替换）而非并集**重跑 BM25。零依赖、可测。
- **实测（新增受控度量 `evals/recall-precision.mjs`，33 查询 / 锚点 GT / K∈{5,10,14} / bootstrap 95% CI B=2000）**：

  | 档位                     | 指标        | 基线 → PRF        | Δ          | bootstrap 95% CI          | 判定           |
  | ------------------------ | ----------- | ----------------- | ---------- | ------------------------- | -------------- |
  | **fileK=10（生产默认）** | hitRate@10  | 51.5% → 54.5%     | +3.0pp     | [33.3–69.7] → [36.4–72.7] | 重叠（不显著） |
  |                          | recall@10   | 26.7% → **32.2%** | **+5.5pp** | [14.8–39.6] → [19.2–45.4] | 重叠（不显著） |
  |                          | MRR         | 0.274 → 0.296     | +0.022     | —                         | 方向正         |
  | **fileK=5（P5 降档档）** | recall@5    | 17.5% → 24.8%     | **+7.3pp** | [8.2–28.5] → [12.6–37.9]  | 与降档互补     |
  |                          | precision@5 | 11.5% → 15.2%     | +3.7pp     | —                         | 方向正         |

- **默认取值（诚实判负）**：n=33 下 CI **重叠**（增益未达统计显著）⇒ **默认 opt-in 关**（`OMNI_RM3=1` 或显式 `prf: true`），
  生产行为零变更。若后续扩语料到 n≥80 且 CI 下界仍 > 基线再议翻默认。
- **实现要点（含修一个真 bug）**：原内置 `prf` 分支是**朴素并集**（20 个泛化词命中的文件顶进头部，hitRate 39%→9% 崩塌）；
  重写为 IDF 加权 Top-6 扩展词 + **重排替换** + 语料级 docFreq（WeakMap 按 corpus 缓存）。`RepoMapContextOptions` 加 `prf?`。
- **护栏/缓存并行测量（免网络）**：护栏 `injection-metric` recall 90.0% / FP-rate 8.3% / prec 94.7% / acc 90.6%（健康）；
  缓存 `prefix-stability` 加权复用率 ~60–73%（已治后区间）。报告 `evals/recall-precision.report.json`。

### P2 确定性无损收缩接线（第一批已落地）— token↓

- **缺口（已证）**：`compressContext`/`foldHistorySegments`/`truncateLongOutput` **仅 `src/index.ts` 导出、
  生产零调用**（本仓库最高频缺陷形态「声明未接线」）；`deterministicCompressor` 全仓消费方只有测试与
  独立基准脚本。
- **落地（与初版方案的三处口径修正，均有理由）**：
  1. **接在 `ContextCompactor`，不接 `stepToolExecutor`**。`recordToolResult` 属**记录层**（写事件日志 +
     审计链 fail-closed）；压缩属**投影层**职责（`events → 投影 → 压缩 → 发往模型`）。改记录层内容等于篡改
     审计事实，故**明确不做**。
  2. **只用无损子集**（行尾空白 / 3+ 连续空行 / 整段 JSON 缩进）——**不启用截断**。截断有信息损失，
     而工具输出的**外溢**（preview + 句柄）已由 `toolResultSpiller` 负责，投影层不再二次删事实。
     故本层承诺可无条件施加：**幂等 + 单调 + 不删任何字符级事实**（配机械测试）。
  3. **head 不收缩**（只缩保留的 tail / 未触发压缩时的全部消息）。理由：摘要请求 `[...head, 指令]`
     与主请求共享最长公共前缀 ⇒ 命中 provider implicit prompt cache；若压缩 head，前缀被破坏，
     按「缓存 90% 折扣 vs 压缩率」算，**不压 head 更省**。
- **配置链**：`config.compactionDeterministicShrink`（`configFactory`）→ `agent.buildCompactor()` 显式透传
  → `ContextCompactor`（类内默认 true）。**显式透传**以杜绝「声明字段 runtime 未透传」死旋钮。
- **验收（已过）**：
  - 单测：`shrinkLossless` 幂等/单调/不删事实；`ContextCompactor` 默认开、`false` 逐字节回退、
    system 不动、`toolCallId`/`reasoningContent` 原样（思考模式硬要求）、压缩路径与游标路径均收缩。**7 例全绿**。
  - 实测 `evals/compaction-wiring.mjs`（真实仓库产物 8 文件 / 20 条消息，接线前 vs 接线后）：
    - 口径① **未达阈值（长会话常态，每轮持续收益）**：162.79 KB → 155.37 KB，**−4.56%**；
    - 口径② **触达压缩阈值（保留 tail）**：6.31 KB → 3.67 KB，**−41.89%**；
    - 口径③ **整段 JSON 型工具输出（5 条）**：25.4 KB → 17.99 KB，**−29.16%**（单条 −12.14% ~ −42.44%）。
  - **诚实边界**：机制射程集中在 **JSON 型工具输出**（真实工具输出主导形态）；Markdown / 源码类内容
    实测 **0%**（本就无冗余可裁）。故「每轮 −4.6%」是被大体量 Markdown 稀释后的混合口径，
    **不是普适压缩率**——报告 `evals/compaction-wiring.report.json`。
- **风险**：低（无损 + 幂等 + 可关；默认开故生产行为变更，已用全量单测 1419 例验证无回归）。

### P3 主循环自验证回环 — 准确率↑（最高杠杆）【第三批已落地】

- **缺口**：主循环**不自跑测试 / 不自查**，无 FAIL_TO_PASS 回环；`SelfChecklist`/`goalChecker` 有件未装。
- **方案**：回合收尾时以**确定性触发器**（改了源码 + 仓库有 `npm test` 症状）自动跑**受限测试命令**，
  把「失败摘要」（非全量日志）回灌一步；接入既有 `selfChecklist`（假完成探测器）。
  纪律：**不进主门禁**、可关、有超时与预算上限。
- **验收**：`tests/integration` 端到端（改坏代码 → 回环捕获 → 修好 → 通过）；对 SWE-bench 自研 10 题 live 分数做前后对照。
- **风险**：中高（碰主循环 → 用**装饰器/钩子**，不塞进 `StepRunner` 内部 new）。**工作量**：1–2d。
- **【第三批已落地（2026-09-16，`322c75d`）】**
  - **落地形态 = `ToolPort` 装饰器**（`src/adapters/tool/verify/selfVerifyingToolPort.ts`），全程适配器层，
    `stepRunner`/`turnRunner`/热区**零改动**；`execute` 透明转发，写类工具成功**且**「命确定性触发器」后追加
    「假完成探测 → 跑受限测试 → 失败/超时回灌摘要」；**fail-open**（命令抛错只附提示、绝不改变内层 `ok`）。
  - **五件套职责缝**：`testCommandRunner`（端口）/ `shellTestCommandRunner`（复用既有 `ShellProcessRunner`，
    零进程管理重复）/ `testFailureDigest`（`node --test`/`jest`/`pytest`/`cargo` 四类失败行抽取，剥 ANSI、限行、限 300 字符）/
    `selfVerifyPolicy`（值对象：**仓库确有 `scripts.test` 才返回策略**，无测试脚本不包装；限定源码扩展名）/ `selfVerifyingToolPort`。
  - **确定性触发器**：`MUTATING_TOOLS ∩ isVerifiableTarget(path)` 双命中；谓词由 **config 层注入**
    （`configToolRegistry.withSelfVerify`）以规避 `core↔adapters` 双向禁线；假完成探测复用 `SelfChecklist.noPlaceholders`。
  - **预算**：超时 120s / 冷却 60s / 每会话 3 次 / 摘要 15 行；配置链 `config.selfVerify`（`ConfigFactory.resolveSelfVerify`）
    - CLI `--self-verify`（已登记）。
  - **验收（e2e）**：`tests/integration/selfVerifyLoop.test.ts`（真写盘 + 真 `npm test`）——①改坏源码 → 捕获并回灌失败摘要；
    ②修好 → 静默；③仓库无 `scripts.test` → 不包装。单测 23 例（策略 8 / 摘要 7 / 装饰器 10）全绿。
  - **诚实边界（SWE-bench live 前后对照不适用）**：自研 10 题夹具为 `bug.js`+`test.js`、**无 `package.json`**，
    确定性触发器**结构上不会命中**；env 亦缺 `DEEPSEEK_API_KEY` ⇒ 不以伪造数字充数，仅以上述 e2e 作验收（详见看板 §5）。
  - **风险**：低（装饰器 + 可关 + fail-open + 默认不启用）。**交付**：`322c75d`。

### P4 工具输出来源信任级（护栏关键面）— 准确率·安全↑【第三批已落地】

- **缺口**：护栏对一切文本用同一敏感度 ⇒ 双向偏差——**外部抓取内容**（间接提示注入 II 主威胁面）与本机命令输出同档
  （弱指令式短语一律漏检）；**本机命令输出**的 `system:` / `assistant:` 日志行与「角色标记注入」同档（稳定误报）。
  快照 `tool-output` 类别 6 条**全是良性**（该威胁面无覆盖，即「召回 0/6」的实质）、FP 16.7%。
- **方案（已实现）**：给工具结果打**来源信任级**（`external` 外部抓取 / `file` 文件内容 / `local` 本机命令 / `unknown` 未登记），
  规则拆**强 / 弱 / 指令式启发式**三层，判定阈值随来源变化（external & unknown = 1、file = 2、local = 3）；
  未登记工具回落 `unknown`（fail-closed：忘登记只会更严、不会更松）。不传来源时阈值 1 ⇒ 与旧行为**逐字等价**。
- **验收（已达成）**：`evals/injection-metric.mjs` 前后对照——tool-output 召回 **0/6 → 6/8 = 75%**（≥ 半数 ✅）、
  FP **16.7% → 8.3%**（不升 ✅）；报告 `evals/injection-metric.report.json`。
  **诚实边界**：快照为手写 curated 代理；新增 2 条用例故意置于启发式射程外，以保持召回数字诚实。
- **风险**：低（纯规则 + 测试）。**工作量**：0.5d。**交付**：`8b5ea35`。
- **后续更正（2026-09-16）**：本项做的是护栏**判定质量**，但其**开关本身**此前在生产路径上不可达——
  `promptInjectionGuard` 只在 `OmniHarnessConfig` 上声明，`ConfigFactory.build` 的返回字面量未透传，
  `agent` 恒读到 `undefined` ⇒ 护栏不可启用（第九处「声明未接线」，安全相关）。已修复（`0111d41`）
  并以新增的**接线完整性门禁**（`644143c`）防复发，详见 `docs/TASK_BOARD.md` §5 第 21 条。

### P5 软预算 + per-tool token 归因 — token↓（可观测）【第一批已落地】

- **缺口**：成本**仅硬熔断**；`promptCacheUsageReader` 已读 cache 命中却**不折抵预算**；无 per-tool 归因。
- **方案**：把 cache 命中折抵成本；按 工具/阶段 归因 token；超软阈值时**降级**（缩 fileK / 关语义路）而非直接熔断。
- **验收**：单测 + 一次真实 live 会话的归因报告（各工具 token 占比）。
- **风险**：低–中。**工作量**：0.5–1d。
- **【第一批已落地（2026-09-16，`d358b36`）】**（只读盘点另揪出**第五处「声明未接线」**一并修掉）
  - **① 缓存折抵（口径修正）**：`RoutePrice` 增 `cachedInputPer1M`；`CostBudget.record` 把 prompt 拆成
    cached / uncached 分档计价并累计 `savedUsd`。**保守取向**：命中量缺值 ⇒ **不打折**（缺值只能是
    「未知」，不得当 0 命中）；未配缓存价 ⇒ 命中仍按输入价（宁多记早熔断，不凭猜给折扣）；脏值按
    `promptTokens` 截断。此前命中与未命中同价 ⇒ 长会话（前缀稳定、命中率高）系统性高估花费。
  - **② per-tool 归因**：`src/observability/tokenAttribution.ts`（`TokenAttribution`）纯函数式投影——
    **每次模型调用的 usage 归给「自上一条 `model` 事件以来出现的 `tool_call` 工具名集合」**
    （该调用摄取了哪些工具的结果），无前驱工具归 `<initial>`，同批多工具**按桶均分**（各桶之和 == 总量）。
    零热区改动可行之因：用量与工具调用**都已落同一条 append-only 事件流**，归因即对生产事实源的投影。
  - **③ 软阈值信号**：`softRatio`（默认 0.8）+ `softExceeded` / `degradeSuggested` / `softLimitUsd`；
    越软/硬阈值回调 `onSoftExceed` / `onExceed` **首次真正接通**（此前装配处第 4 参恒 `undefined`
    ⇒ 越限只置标记、无任何上报，是死旋钮）。
  - **④ 生产入口（第五处「声明未接线」）**：`costBudgetUsd` / `costBudgetOnExceed` / `costBudgetSoftRatio`
    此前**只能编程注入**（CLI 与配置文件均无入口）⇒ 默认部署 `costBudget` 恒 `undefined`、
    `budget_status` 永不注册。本批补 CLI 三旗标（登记 `VALUE_FLAGS`，on-exceed 走枚举 fail-closed）
    - 配置文件同名字段 + `argParser` 映射 + `cliBuildConfig` 透传。
  - **⑤ 真实消费点**：`budget_status` 输出补 `cachedPromptTokens` / `savedUsd` / `softLimitUsd` /
    `softExceeded` / `degradeSuggested`——模型据此主动收敛，软阈值信号不再是「只算不报」。
  - **验收（真实运行时 + 真实事件流）**：集成测试走 `ConfigFactory.build` + `createRuntime` 真跑
    Agent 循环后对**运行时真发出的事件**归因（`<initial>` 120 / `shell` 340 / 总量守恒 460，与上报
    usage 逐项一致）；端到端演示（真会话 JSONL → `npm run metrics:attribution`，3 次调用 / 2+1 工具）
    `read_file` 8,200（56.9%）/ `list_dir` 2,560 / `shell` 2,560 / `<initial>` 1,080，合计 **14,400 = 各桶之和**。
    新增单测 25 例；全量单测 1484 / 1477 通过 / 0 失败 / 7 跳过，集成 10/10。
  - **诚实边界**：软阈值只交付**信号 + 回调 + 真实消费点**；归因是「结果摄取成本」的**近似**
    （prompt 是累积的，真实因果分解不可能），无 usage 的调用如实计数、不补零。
  - **【自动降档已落地（2026-09-16，`062a486`）】**：前批留白的**「自动降档」（缩检索 fileK / 关
    语义路）已收口**——把 `CostBudget.degradeSuggested` 建模为 `ports/` **只读端口**
    `BudgetDegradeSignal`（**避开 `core → adapters` 架构红线**），`CostBudgetDegradeAdapter`
    薄桥接后经 `ResolvedConfig` → `OmniHarnessRuntime` → `StepRunnerDeps.budgetDegrade` 注入
    `StepContextBuilder`：**信号置位 ⇒ 强制纯 BM25 + 收缩载荷大纲档位（`payloadShape:'degrade'`，只留 Top-1
    完整大纲）+ rerank:false**；信号关完全保持
    既有口径。**fail-safe 三态**：无预算 ⇒ false（默认部署零行为变更）／软超未硬熔断 ⇒ true
    （唯一降级窗口）／**已硬熔断 ⇒ false**（`degradeSuggested = softFlag && !exceededFlag`，硬熔断
    由 `BudgetedModel` 直接拒调）。零新增依赖、`arch:gate` ports 纯度 0 违规；新增单测 9 例，
    七门禁全绿。**诚实边界**：降档改变**检索预算**属**质量侧未验证**改动，**不动生产默认**——
    仅配 `costBudgetUsd` 且真实越软阈值的会话才降档，默认部署恒不降；召回影响待 P6 解锁后并测。
    - **【2026-09-17 改口径——降档该缩「大纲档位」而非「文件数」，附实测】**：原降档靠 `DEGRADE_FILE_K = 5`（缩 fileK），
      实测代价 **−12.1pp** 命中率却**几乎不省 token**——梯度投送下 fileK 5→10 的 token 只差 **34**（1030 → 1064），
      因 token 大头是**前几档的完整符号大纲**，尾部路径行每行仅约 7 token。改为收缩大纲档位后（K=14 档）：
      **946 token**（比旧降档 1337 还少 **29%**）且命中率 **69.7%**（旧降档 36.4%，**+33.3pp**）——因为**选中文件集合完全不变**。
      依据：`evals/military-payload-ab.report.json`、`evals/production-defaults-check.report.json`。

### P6 官方基准出数 — 齐平·超越

- **缺口**：SWE-bench 仅自研 10 题（live 9/10）；官方 500 Verified 与 Terminal-Bench **无落盘成绩**。
- **方案**：B1 接线已 code-ready（`src/eval/swebenchVerified.ts` + `src/eval/nativeExecutor.ts`，**原生本地执行器**：
  `git worktree` 检出 base + `uv venv` + 应用补丁 + `pytest` 判定，fail-closed）。
- **后续更正（2026-09-17）**：原文「`--backend modal|docker`」**已失效**——执行后端已整体替换为免 Docker、免云的 **`NativeExecutor`**。
  本轮进一步把通道推进到「**gold 可判 resolved**」：① 国内通道 **Gitee 镜像**（11/12 仓库、`base_commit` 22/22 命中）；
  ② **两关验收**（放行≠有效）暴露并修复**环境保真度缺口**——registry-latest pytest 顶掉仓库 pin（9.x 移除 `monkeypatch.notset`
  ⇒ 老套件 60/60 ERROR）+ 不设上界的开发期运行时依赖（`Werkzeug>=2.2.2` 拉到 3.x 删除 `__version__`）；
  修法为新增安装阶梯 `pythonEnvPlan.ts`（**仓库自述已 pinned 依赖 → 该仓库额外约束 → 仅缺失时装 pytest**）+ `envPins`
  - `benchmark/swebench-env-pins.json`；③ 修复 `FAIL_TO_PASS` 解析 **fail-open 假绿**缺陷（JSON 字符串被类型断言，
    空清单会使 `[].every()` 恒真）。**真实 500 题出分仍待 predictions（须模型 key）**。
    详见 `docs/TASK_BOARD.md` §5 第 30 条与 `docs/SUSPENDED_BETTER_PATHS.md` §四·续。
- **工作量**：外部条件解锁后 ~0.5d。

### P7 有界均衡并行调度（突破串行瓶颈）— 吞吐·墙钟↓【上一批已落地】

- **缺口（证据）**：三处**串行**编排——
  ① `SwebenchVerified.runVerifiedSuite` 逐个 `await executor.run()`（官方 500 题串行 = 主要墙钟瓶颈）；
  ② `TerminalBenchRunner.run` 逐个 `await runOne()`（整套串行）；
  ③ `WorkerOrchestrator.delegateAll` 明确注释「按清单顺序逐个执行，**不并行**」。
  既有并发原语只覆盖子代理（`SubagentOrchestrator`）与 Agent 工具（`ToolScheduler`，热区），**评测/编排层无并发**。
- **方案**：新增 `src/util/parallelMap.ts`（`ParallelMap`）——**复用 `ConcurrencyLimiter`**（信号量），
  提供有界并发 + **均衡调度**（槽位完成即移交等待者，先到先服务、无队头阻塞）+ **同序**结果；
  `concurrency=1` **退化为严格串行**（与旧 for-await 逐字节等价，零行为变更）。
  接线三处为**可选并发参数**（默认 1=串行，显式 N 才开启）；CLI `--concurrency N`。
- **语义保证（配机械测试）**：同序、在飞峰值 ≤ 上界、并发墙钟显著低于串行、`1` 与朴素 for-await 等价。
- **不做 CPU 并行**：Node 单线程，本类面向 **I/O 密集**独立任务（实例/子进程/网络）；
  CPU 密集须 `worker_threads`（另议，不在本轮）。
- **风险**：低（新增可选参数，默认不变）。**工作量**：0.5d。

---

## 5. 不做清单（防过度打磨）

- **不再新增隐喻引擎**（先升格现有 14 个；SkillsBench：AI 自生成技能无正增益）。
- **不再盲加检索路**（图 / LSA / 频谱 / 层化，以及 2026-09-17 的**蜘蛛网五形态**——文件级 PPR、扩张池、配额/能量项、词项共现网、形态丝——**均实测净负**；「扩大可达集」至此已 **4 次独立证伪**，机理见 `docs/RECALL_HEADROOM_SURVEY.md` §8）；**先调 retriever + rerank**。
- **不引第三方**（reranker / 压缩 / 分块全部自写，保零依赖）。
- **不碰热区**（`stepRunner`/`turnRunner`/`adapters/live/**`/`toolInputSink`）；新能力走装饰器/钩子，由组合根装配。

## 6. 验收与门禁

每条落地 = **代码一笔 + 看板一笔**，六门禁全绿（`typecheck`/`lint`/`check --strict`/`audit:maturity`/`arch:gate`/`audit:standard:delta`）+ 该条单测/评测。
负结果同样写报告与看板（本仓库传统）。
