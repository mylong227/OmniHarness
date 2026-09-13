# OmniHarness 自研最佳升级路径 —— RDAA 共振驱动智能体架构

> 编制：2026-09-05 | 性质：**设计方案（待实施）**，非已落地声明
> 目标：把调研出的三块真实差距（AST 图上下文、专属 eval、A2A）与"效率最高/消耗最低/精度最高/技术最新"要求，用**项目独有的 S+ 发明层原语**焊接成别人没做过的东西。
> 诚实前置：本方案每一项都标注「思想来源 = 调研」「焊接点 = 现有代码」「新在何处 = 对比」「验证指标 = 可测」。凡属隐喻驱动的，明确其计算落地形态，不神化。

---

## 0. 总架构：RDAA（Resonance-Driven Agent Architecture）

一句话：**用「结构共振寻址」替代「检索排序」、用「QEC 综合征」做轨迹容错、用「涡环能力胶囊」做互操作、用「进化闭环 + 可验证奖励」做零标注自改进。**

四个支柱全部建立在 OmniHarness 已实现的 S+ 原语之上（不是从零发明，是**把已有积木拼成新结构**）：

| 支柱            | 调研来源（别人已验证的思想）           | OmniHarness 已有积木                                             | 焊接后的新结构                                   |
| --------------- | -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| ① 共振 Repo-Map | Aider repo-map（tree-sitter+PageRank） | `resonantMemory`（共振寻址）、`cosmicWeb`（宇宙网）、双 BM25     | **Resonant Repo-Map**：AST 图 × 结构共振寻址     |
| ② QEC 评级 Eval | SWE-bench/Terminal-Bench 执行分级      | `qec`（QEC 原语）、`immune`（免疫监控）、`evolution`（进化闭环） | **QEC-Graded Eval**：轨迹=码字，综合征→早停/自愈 |
| ③ 涡环 A2A      | Google A2A / MCP                       | `agentIdentity`（Ed25519）、`vortexRing`（涡环包）、`cosmicWeb`  | **Vortex-A2A**：签名能力胶囊 + 宇宙网发现        |
| ④ 零标注自改进  | RAGEN/StarPO、RLVR（2025-2026）        | `evolution`（进化闭环）、`GoalRunner`                            | **RLVR-on-Evolution**：可验证奖励接进化闭环      |

---

## 1. 支柱①：Resonant Repo-Map（共振图上下文）

### 思想来源

Aider/SWE-agent 用 `tree-sitter AST → PageRank 符号排名 → token 预算` 给模型结构性上下文；本质仍是图排序检索。

### 焊接点（现有代码，不重写）

- `src/spark/resonantMemory.ts`：共振寻址——对任意输入算「共振签名」，与记忆库做相似度命中。
- `src/ports/cosmicWeb.ts` + `src/adapters/.../cosmicWeb`：宇宙网记忆，支持跨节点关联。
- `src/search/` 已有 BM25 工具检索；`src/adapters/retrieval/` 已有 BM25 会话检索。

### 新在何处（对比竞品 = 真 novelty）

竞品的 repo-map 是**静态图 + 排序**。这里把 AST 节点也纳入「共振空间」：

- 对每个 AST 符号（函数/类/类型）计算**结构共振签名**（= 符号的签名哈希 + 相邻依赖子图的局部结构编码，纯计算、可复现，不是玄学）。
- 检索时不是 BM25/PageRank 排序，而是**共振预过滤**：先按共振签名把相关符号聚类到少数「共振簇」，再对簇内做轻量 BM25 精排。
- 效果：**检索候选集大幅缩小 → 进窗口的 token 更少（消耗最低）**，同时结构相关性更高（精度最高）。

### 落地形态

- 新增 `src/context/repoMap.ts`：`buildGraph(tree-sitter) → 符号节点 + 依赖边`；`src/context/resonantRepoMap.ts`：`ResonantMemory` 适配 AST 节点。
- 接口：`getContextFor(prompt, budgetTokens): SymbolCluster[]`，复用现有 `TokenEstimator`。
- 不动既有 BM25，做**叠加层**（fail-closed：共振层出错则回退 BM25）。

### 验证指标（不造假）

- 在 `evals/` 的 10 任务集上对比：repo-map 开启 vs 仅 BM25 的 **token 消耗↓** 与 **首次正确补丁率↑**。
- 用 mini-SWE-bench（仓库已有 `benchmark/capability_swebench.mjs`，10 任务）做 **Pass@1** 对比。

---

## 2. 支柱②：QEC-Graded Eval（量子纠错隐喻的评级 Eval）

### 思想来源

SWE-bench/Terminal-Bench 用「执行分级」（FAIL_TO_PASS/PASS_TO_PASS）做 verifiable reward；评估严谨性要求 Pass^k、≥5 次跑。

### 焊接点（现有代码）

- `src/spark/qec.ts`：QEC 原语（纠错隐喻）。
- `src/spark/immune.ts` + `src/adapters/.../immune`：免疫监控（异常检测）。
- `src/evolution/`：进化闭环（已能 autoRun 接主循环）。

### 新在何处

把「智能体轨迹」当作**码字 (codeword)**，定义**综合征 (syndrome)**：

- 工具调用返回非 2xx / schema 不匹配 / 同一文件来回改动 ≥3 次 / 编译错误未收敛 → 各计一种综合征。
- 综合征数 > 阈值 → **早停**该候选并触发 `evolution` 自愈（改策略重跑），而非傻等到 SWE-bench 跑完。
- 意义：**用廉价的综合征检测替代昂贵的全量执行分级**，eval 成本最低；且把「失败」变成「可纠正信号」，精度靠 verifiable reward 保证。

### 落地形态

- 新增 `src/eval/qecGrade.ts`：`gradeTrajectory(events): {syndromes, earlyStop, selfHeal}`。
- 接 `evals/` 现有 SWE-bench 任务集；新增 Terminal-Bench 适配（`tbench.ai` 容器任务）。
- 接 CI：**每次 PR 跑 mini-SWE-bench（10 任务）+ Terminal-Bench（子集）**，作为回归门禁。

### 验证指标

- **eval 成本**：带早停 vs 全量跑的 wall-clock / token 比。
- **Pass@k（k≥5）** 真实上报，避免单次造假。
- **自愈成功率** = 触发 evolution 后下一轮通过率。

---

## 3. 支柱③：Vortex-A2A（涡环能力胶囊互操作）

### 思想来源

Google A2A（Agent Card + HTTP/SSE 对等委托）；MCP 已事实标准（OmniHarness 已双向支持）。全行业 CLI harness 的 A2A 都薄——这是**差异化空白**。

### 焊接点（现有代码）

- `src/ports/agentIdentity.ts` + `src/adapters/identity`：**Ed25519 密码学身份**（已落地，2026 全行业几乎无人做）。
- `src/spark/vortexRing.ts`：涡环包原语（能力封装隐喻）。
- `src/ports/cosmicWeb.ts`：宇宙网（发现/关联）。

### 新在何处

不做「又一个 HTTP Agent Card」。而是：

- **能力胶囊 = 涡环包**：把「我是谁(Ed25519 签名) + 我能做什么(tool/子体清单 hash) + 任务 spec」封成涡环包，**签名即身份、哈希即能力指纹**。
- **发现 = 宇宙网共振**：对等体通过 cosmicWeb 共振广播能力指纹，匹配则建立会话（优于 A2A 的中心化 Agent Card 注册）。
- 兼容：对外仍暴露 **MCP server**（已有）给非 OmniHarness 宿主；对内用 Vortex-A2A 做 OmniHarness↔OmniHarness 对等协作。

### 落地形态

- 新增 `src/server/vortexA2a.ts`：`Capsule = sign(identity, capabilityHash, spec)`；`discover()/delegate()`。
- 复用 `agentIdentity` 签名与 `appServer` 的 RPC 通道（不新起传输栈）。
- 失败隔离沿用现有 Subagent 的「独立窗口/工具视图」机制。

### 验证指标

- **A2A 往返延迟**（OmniHarness↔OmniHarness 对等委托一个子任务）。
- **胶囊验签失败率**（伪造身份应被拒，验证 crypto identity 真生效）。
- 兼容性：作为 MCP server 被 Claude Code/Zed 接入的冒烟测试。

---

## 4. 支柱④：RLVR-on-Evolution（零标注自改进引擎）

### 思想来源

RAGEN/StarPO(2504.20073) 轨迹级多轮 RL；RLVR(2506.14245) 用可验证奖励；AgentRM(2502.18407) 训练奖励模型做测试时搜索。

### 焊接点

- `src/evolution/` 进化闭环 + `src/autonomy/goalRunner.ts` 已能复用 Agent 主循环续跑。
- 支柱②的 verifiable reward（编译/测试绿）直接作奖励信号。

### 新在何处

把「进化闭环」从启发式变异升级为**带可验证奖励的轨迹优化**：

- 奖励 = 支柱②的 SWE-bench/Terminal-Bench 执行分级结果（0/1 或 partial）。
- 用 StarPO 式轨迹过滤 + 梯度稳定，复用现有 `GoalRunner` 跑多轮 rollout。
- **零人工标注**：奖励来自执行环境，成本最低、精度最高（可验证即真理）。

### 落地形态

- 新增 `src/evolution/rlvr.ts`：把 `qecGrade` 的 verifiable reward 喂给 `GoalRunner` 的 rollout 选择。
- 与支柱②共享 eval 管线，不重复造。

### 验证指标

- 在 mini-SWE-bench 上：**进化 N 轮后 Pass@1 提升曲线**（对比无 RLVR 基线）。
- 显式报告「奖励来自执行环境、无人标」。

---

## 5. 横切效率引擎（贯穿四支柱）

| 手段               | 来源            | 复用点                           | 收益                      |
| ------------------ | --------------- | -------------------------------- | ------------------------- |
| 共振预过滤         | 支柱①           | resonantMemory                   | token 消耗↓（最低）       |
| 早停 + 自愈        | 支柱②           | qec/immune                       | eval 成本↓                |
| 可验证奖励         | 支柱④           | eval 管线                        | 标注成本=0，精度=执行真理 |
| 工具分层检索       | 调研 AnyTool    | 现有 tool_search                 | 长工具列表压窗↓           |
| Mem0 自编辑记忆    | 调研 2504.19413 | resonantMemory + memoryAnnealing | 跨会话 fact 召回↑         |
| 多模型推理强度映射 | 调研            | 已有 reasoning_effort            | 非 OpenAI 模型也吃推理档  |

---

## 6. 实施里程碑（顺序 = 依赖最小、风险最低优先）

| 阶段 | 任务                                                | 复用/新增                                         | 风险                              | 验证                         |
| ---- | --------------------------------------------------- | ------------------------------------------------- | --------------------------------- | ---------------------------- |
| M1   | Resonant Repo-Map（AST 图 + 共振预过滤，BM25 回退） | 新增 `context/repoMap.ts` + 适配 `resonantMemory` | 低（叠加层 fail-closed）          | token↓ / Pass@1↑ on mini-SWE |
| M2   | QEC-Graded Eval（综合征 + 早停 + 自愈钩子）         | 新增 `eval/qecGrade.ts`，接 `evals/`              | 低                                | eval 成本↓ / Pass@k          |
| M3   | SWE-bench + Terminal-Bench 正式管线 + CI 门禁       | 接现有 `benchmark/`                               | 中（需容器/网络）                 | PR 回归门禁                  |
| M4   | RLVR-on-Evolution                                   | 新增 `evolution/rlvr.ts`                          | 中（RL 不稳定，需 StarPO 稳定化） | 进化曲线                     |
| M5   | Vortex-A2A（胶囊 + 宇宙网发现 + 验签）              | 新增 `server/vortexA2a.ts`，复用 `agentIdentity`  | 中                                | 往返延迟 / 验签失败率        |
| M6   | Mem0 自编辑记忆融合 + 工具分层检索                  | 改 `resonantMemory` + `tool_search`               | 低                                | 召回@k↑                      |

> 顺序逻辑：M1→M2→M3 先解决「上下文 + 评估」两块硬骨头并把 eval 变成可复用资产；M4 用 M3 的 reward 做自改进；M5 做互操作差异化；M6 是精度/消耗收尾。

---

## 7. 诚实风险声明（不诓骗）

1. **「共振」「涡环」「QEC」「宇宙网」是隐喻**，其计算落地形态是：结构哈希相似度 / 能力指纹封装 / 综合征异常检测 / 图关联。文档已逐条给出**实际算法**，不是玄学。
2. **「从没人做」的范围限定**：RDAA 的「四支柱焊接结构」是新的；但其中每个积木（BM25、AST、Ed25519、RLVR、MCP）都是已知技术。**新颖性在组合与接口，不在底层原子**。
3. **需真实验证才敢称「领先」**：本方案全部指标（token↓、Pass@k、eval 成本↓、A2A 延迟、验签率）必须在 M1–M5 落地后用真实跑分填数，**在拿到数字前任何「领先」表述都是预言，不是结论**。
4. **RL 不稳定是已知坑**：RAGEN 论文明载 "Echo Trap" 不稳定性，M4 必须上 StarPO-S（轨迹过滤 + 批评者 + 梯度稳定），否则会训崩。已写入风险。
5. **OS 级沙箱真机验证**仍是既有尾账（S78），Vortex-A2A 的跨机委托必须等该尾账收口才有真实隔离保证。

---

## 8. 成功度量（KPI，全部可测）

- **上下文效率**：相同任务平均进窗 token ↓ ≥30%（vs 仅 BM25）。
- **代码任务精度**：mini-SWE-bench Pass@1 ↑，Terminal-Bench 子集通过。
- **Eval 成本**：带早停 vs 全量 wall-clock ↓ ≥40%。
- **自改进**：RLVR 进化 5 轮后 Pass@1 相对基线 ↑。
- **互操作**：Vortex-A2A 对等委托往返 < 2× 本地子体启动；伪造身份验签拒绝率 100%。
- **零标注**：自改进奖励 100% 来自执行环境。

---

### 一句话收束

别人在「加功能」，我们在「换检索与互操作的底层范式」——用已有的 S+ 发明层把 repo-map / eval / A2A / 自改进 四块焊成 RDAA。每一项都有计算落地、都有可测 KPI、都标了风险。**落地前是设计，落地后跑出数字才算数。**
