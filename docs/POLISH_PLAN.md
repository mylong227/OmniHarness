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

| #      | 条目                                              | 维度           | 预期 | 依据                                                                                 |
| ------ | ------------------------------------------------- | -------------- | ---- | ------------------------------------------------------------------------------------ |
| **P1** | 零依赖 **reranker**（两阶段检索第 2 段）          | 命中准率↑      | 中   | 行业「retriever 定上限、refine 补精确」；本仓库**无 rerank 阶段**（仅 RRF+符号融合） |
| **P2** | **确定性压缩接线**（已建未接）                    | token↓         | 中   | 审计：`compressContext`/`foldHistorySegments` 仅 `src/index.ts` 导出、**生产零调用** |
| **P3** | **主循环自验证回环**（跑测试 / 自查）             | 准确率↑        | 高   | 审计：主循环**不自跑测试**；`SelfChecklist`/`goalChecker` 有件未装                   |
| **P4** | 护栏**工具输出来源信任级**                        | 准确率·安全↑   | 中高 | 实测 `tool-output` 召回 **0/6**、`natural-language` 0/4（主威胁面无召回）            |
| **P5** | 软预算 + **per-tool token 归因**                  | token↓(可观测) | 中   | 审计：成本仅**硬熔断**，cache 命中不折抵，无归因                                     |
| **P6** | 官方 **SWE-bench Verified / Terminal-Bench** 出数 | 齐平·超越      | 高   | B1 接线 code-ready，待 docker/Modal 凭证                                             |
| **P7** | **有界均衡并行调度**（突破串行瓶颈）              | 吞吐·墙钟↓     | 中高 | 三处串行：官方 500 题逐个实例 / 整套 TaskBench / worker 批量委派（本轮已接线）       |

**已完成的受控实验（本轮）**：`evals/bm25-tune.mjs`——把研究公认的「检索第一杠杆」（BM25 `k1`/`b` 调参）
在本语料上跑**全网格 + bootstrap CI + repeated 2-fold 留出折**。结论：**无稳健增益，默认 1.5/0.75 已近最优，不翻默认**
（详见 §3）。这是一次**受控排除**，把「调 BM25 参数」从候选清单划掉，避免后续重复投入。

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
  **缺口**：`deterministicCompressor`（去空行/JSON 紧凑/去重/长输出截断/历史折叠）**生产零调用**；
  `prefixStability` 只测不治；**无滚动 action-outcome 账本**；成本**仅硬熔断**、无 per-tool 归因、cache 命中不折抵。
- **检索侧**：`Bm25Index{k1,b}` 可注入但**生产全不传参**（默认 1.5/0.75）；`tokenizeExpanded`（camel 拆分 + 词形归并）；
  语义/混合 `hybridRanker`+`semanticIndex`（**默认关**，需 `OMNI_SEMANTIC_RECALL=1`）；旋钮 `recallKnobs`（fileK=10/14, symK=24/30, rrfK=60…）；
  **无 reranker**；层化/图/LSA/频谱**均默认关**（实测负）；评测 `evals/recall-codebase-real.mjs` 等。
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

### P1 零依赖 reranker（两阶段检索第 2 段）— 命中准率↑

- **缺口**：仅 RRF + 符号融合，**无 rerank 阶段**；fileK=14 时 precision 天然被稀释。
- **方案**：对 BM25/混合的 Top-N 候选，用**第二个独立信号**重排——候选（择一或组合，全部零依赖、可测）：
  ①**符号名精确覆盖**（查询标识符命中文件内符号名的加权）；②**查询词共现邻近度**（distance-based）；
  ③**文件路径/导出性**先验。**先跑否决器**（跨查询 Top-K Jaccard），再过 AB（同 corpus 开关隔离召回）。
- **验收**：召回/精度对照 + bootstrap CI（范式 `evals/layered-recall-ab.mjs`）；CI 下界 >0 且留出折为正才翻默认。
- **风险**：中（本仓库历史负结果多）。**工作量**：0.5–1d。

### P2 确定性压缩接线（已建未接）— token↓

- **缺口**：`compressContext`/`foldHistorySegments`/`truncateLongOutput` **仅 `src/index.ts` 导出、生产零调用**
  （本仓库最高频缺陷形态「声明未接线」）。
- **方案**：在 `ContextCompactor` 的 **LLM 摘要之前**加一层**确定性前处理**（去空行 → JSON 紧凑 → 重复分片去重 →
  长输出中段省略 → 远古历史折叠）；并在 `stepToolExecutor.recordToolResult` 的 spiller **之后**对**中等输出**
  （低于外溢阈值者）施加同款确定性收缩。**零 LLM 成本、幂等可证、单调不增字节**。
- **验收**：单测（三大定律 + 压缩率）+ `evals/context-efficiency/bench.mjs` 前后 token 对照。
- **风险**：低–中（不删事实，仅裁确定冗余；注意别改工具输出的可断言语义）。**工作量**：0.5d。

### P3 主循环自验证回环 — 准确率↑（最高杠杆）

- **缺口**：主循环**不自跑测试 / 不自查**，无 FAIL_TO_PASS 回环；`SelfChecklist`/`goalChecker` 有件未装。
- **方案**：回合收尾时以**确定性触发器**（改了源码 + 仓库有 `npm test` 症状）自动跑**受限测试命令**，
  把「失败摘要」（非全量日志）回灌一步；接入既有 `selfChecklist`（假完成探测器）。
  纪律：**不进主门禁**、可关、有超时与预算上限。
- **验收**：`tests/integration` 端到端（改坏代码 → 回环捕获 → 修好 → 通过）；对 SWE-bench 自研 10 题 live 分数做前后对照。
- **风险**：中高（碰主循环 → 用**装饰器/钩子**，不塞进 `StepRunner` 内部 new）。**工作量**：1–2d。

### P4 工具输出来源信任级（护栏关键面）— 准确率·安全↑

- **缺口**：护栏 `tool-output` 召回 **0/6**（正是注入主威胁面）、`natural-language` 0/4、FP 16.7%。
- **方案**：给工具结果打**来源/信任级**标签（外部抓取 / 文件内容 / 本机命令），对**外部来源**提高规则敏感度
  （或加启发式：指令式短语 + 不可信来源 ⇒ 隔离），降低对**本机可信输出**的误报。
- **验收**：`evals/injection-metric.mjs` 的 recall / FP 前后对照（目标：tool-output 召回 ≥ 半数，FP 不升）。
- **风险**：低（纯规则 + 测试）。**工作量**：0.5d。

### P5 软预算 + per-tool token 归因 — token↓（可观测）

- **缺口**：成本**仅硬熔断**；`promptCacheUsageReader` 已读 cache 命中却**不折抵预算**；无 per-tool 归因。
- **方案**：把 cache 命中折抵成本；按 工具/阶段 归因 token；超软阈值时**降级**（缩 fileK / 关语义路）而非直接熔断。
- **验收**：单测 + 一次真实 live 会话的归因报告（各工具 token 占比）。
- **风险**：低–中。**工作量**：0.5–1d。

### P6 官方基准出数 — 齐平·超越

- **缺口**：SWE-bench 仅自研 10 题（live 9/10）；官方 500 Verified 与 Terminal-Bench **无落盘成绩**。
- **方案**：B1 接线已 code-ready（`src/eval/swebenchVerified.ts`，`--backend modal|docker`，fail-closed）；
  待你侧 **cloud 凭证** 或本机 docker → 一键出官方分。
- **工作量**：外部条件解锁后 ~0.5d。

### P7 有界均衡并行调度（突破串行瓶颈）— 吞吐·墙钟↓【本轮已落地】

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
- **不再盲加检索路**（图/LSA/频谱/层化已四次实测负）；**先调 retriever + rerank**。
- **不引第三方**（reranker / 压缩 / 分块全部自写，保零依赖）。
- **不碰热区**（`stepRunner`/`turnRunner`/`adapters/live/**`/`toolInputSink`）；新能力走装饰器/钩子，由组合根装配。

## 6. 验收与门禁

每条落地 = **代码一笔 + 看板一笔**，六门禁全绿（`typecheck`/`lint`/`check --strict`/`audit:maturity`/`arch:gate`/`audit:standard:delta`）+ 该条单测/评测。
负结果同样写报告与看板（本仓库传统）。
