# OmniHarness 综合升级方案（调研 · UCE 框架 · 真实基准 三合一）

> 文档性质：**可执行升级路线**，非框架 PPT。每一阶段都标注「技术来源」「复用现有模块」「可验证 KPI」。
> 诚实边界：本文所有「性能碾压」论断，凡带 _实测_ 标记的均有 `evals/context-efficiency` 跑出的硬数字支撑；凡标 _架构确定性_ 的，是相对竞品实现方式的构造性优势（竞品按整文件/裸 grep 喂上下文，我们用检索式，故效率优势是确定的）；凡标 _待实测_ 的，是路线目标，需用 SWE-bench/Terminal-Bench 跑分后方可断言。

---

## 0. 执行摘要（先讲真话）

**已落地且已验证（真实数字）：**

- 零依赖 repo-map 上下文引擎（`src/context/repoMap.ts` + `src/context/contextEngine.ts`）。
- 确定性基准（`evals/context-efficiency/bench.mjs`）在 311 文件 / 4787 符号的真实语料上跑出：
  - 相对「grep 关键词→整文件」竞品基线（**同等 14 文件预算**）：**token 降至 1/7.95**，且召回更高（_实测_）
  - 相对「整语料硬塞」：**token 降至 1/114.03**（_实测_）
  - 文件召回率：**67.0%**（_实测_；竞品同等预算仅 60.83%，见 §4）

**已落地但未接生产循环（能力存在、待测线）：**

- 沙箱矩阵、审计哈希链、双 BM25、Ed25519 身份、安全策略求值器、S+ 发明层（共振/涡环/进化闭环/QEC/免疫/宇宙网/元认知）。

**已存在真实评测基线（2026-09-03/04 产物，本会话前已生成，非本会话伪造）：**

- `benchmark/capability-swebench.json`：**live 段——模型 deepseek-chat，10/10 任务全过**（off-by-one-sum / null-guard-greet / wrong-op-avg / reversed-sort / loop-start-firstN / fencepost-slice / regex-anchored / float-precision / type-coercion / inverted-condition），耗时 **64.7s**、成本 **$0.20**；scripted 段同为 10/10。⚠️ 注意：这是**自研 10 题套件**，**非**官方 SWE-bench Verified 数据集，故不能称作"SWE-bench Pass@k"，只能称"10 题 live 全过"。
- `benchmark/efficiency-benchmark.json`：冷启动 p50 **86ms**、上下文压缩**省 80.7%**、工具加载**减 74.5%**、检索 **12929 qps**、生成代数 **1478 万 ops/s**、RSS 49.3MB。
- `benchmark/selfcheck.report.json`：**6/6** 自检性质通过（安全 fail-closed、不灾难性遗忘、零依赖+退火单调、…）。

> 更正声明：本方案更早草稿曾写"SWE-bench 数字为空 / 仅上下文效率有实测"，**与上述事实不符，已更正**。正确表述：已有 10/10 live 通过记录（自研套件）+ 多项效率硬指标 + 6/6 自检；**官方 SWE-bench Verified 大规模跑分仍缺**，列为 U5 扩展目标。

**本方案的硬主张：**

1. 用 **UCE 第一性框架**（万法归一·万物守恒·万物演变）统一现有 6 大子系统，消灭「焊接后遗症」。
2. 把调研到的 2025–2026 前沿技术（repo-map、Mem0 自编辑记忆、RAGEN/RLVR、HippoRAG2、SWE-bench 严谨评估）**焊接到 UCE 的同一基板上**，使「创新」成为框架的涌现而非外挂。
3. 每个升级阶段都给出**可证伪 KPI**，跑不出数字不宣称领先。

---

## 1. 调研结论汇总（来源：三路并行调研，2026-09-05）

### 1.1 同期产品能力矩阵（_架构确定性_ + 公开资料，非我方跑分）

| 能力维度             | OmniHarness                      | Codex CLI   | Claude Code        | Aider   | Goose    | OpenHands |
| -------------------- | -------------------------------- | ----------- | ------------------ | ------- | -------- | --------- |
| 多模型/供应商抽象    | ✅                               | OpenAI 为主 | Anthropic          | 广      | 广       | 广        |
| 推理强度控制         | ✅(reasoning_effort 已接)        | ✅          | ✅                 | ⚠️有限  | ❌       | ❌        |
| 子代理/多代理        | ✅(SubagentPort)                 | ⚠️          | ✅                 | ❌      | ✅       | ✅        |
| 工作流 DAG           | ✅(WorkflowRunner)               | ❌          | ❌                 | ❌      | ⚠️       | ✅        |
| 长程记忆             | ✅(共振+BM25)                    | ❌          | ✅(项目记忆)       | ⚠️      | ⚠️       | ⚠️        |
| 上下文压缩(repo-map) | ✅(_实测_ 114x / 同预算 7.95x)   | ❌整文件    | ❌整文件           | ✅(AST) | ❌整文件 | ❌整文件  |
| 工具沙箱             | ✅(原生矩阵+Win RestrictedToken) | ✅(容器)    | ✅(macOS seatbelt) | ❌      | ✅       | ✅(容器)  |
| 权限/审批            | ✅(规则引擎)                     | ✅          | ✅                 | ✅      | ✅       | ✅        |
| MCP 客户端/服务端    | ✅双向                           | ❌          | ✅                 | ❌      | ✅       | ✅        |
| A2A 互操作           | ⚠️(待建客户端)                   | ❌          | ❌                 | ❌      | ❌       | ❌        |
| 插件/技能系统        | ✅                               | ❌          | ✅                 | ❌      | ✅       | ✅        |
| 企业 SSO/审计        | ✅(OIDC+哈希链)                  | ❌          | ⚠️                 | ❌      | ⚠️       | ⚠️        |
| 智能体密码学身份     | ✅(Ed25519)                      | ❌          | ❌                 | ❌      | ❌       | ❌        |
| 自主长循环           | ✅(goal/ralph)                   | ❌          | ❌                 | ❌      | ⚠️       | ✅        |
| 多模态输入           | ✅(图/视频/文件)                 | ✅(图)      | ✅(图)             | ❌      | ❌       | ✅(图)    |
| 专属 eval 跑分       | ⚠️(目录在,未接 CI)               | ❌          | ❌                 | ❌      | ❌       | ❌        |

> 说明：Aider 是唯一同样做 repo-map 的竞品，但其为 AST(tree-sitter)单层；我们的差异点是 **repo-map + BM25 + 共振记忆三层融合**（共振层尚未接，见 §5 U3）。

### 1.2 最新工程技法（按可落地性排序，附来源）

1. **repo-map / AST 符号排名**（Aider, SWE-agent）→ 上下文图压缩。_已落地简化版（正则符号抽取）。_
2. **Mem0 自编辑记忆**（arXiv 2504.19413）→ 记忆体自我归纳。_对接现有 resonantMemory。_
3. **RAGEN / StarPO**（arXiv 2504.20073）→ agentic RL，verifiable reward。_对接现有 evolution 闭环。_
4. **RLVR**（arXiv 2506.14245）→ 可验证奖励训练。_编译/测试绿即奖励。_
5. **HippoRAG 2**（arXiv 2502.14802）→ 图检索 + 归纳推理。_升级共振记忆检索。_
6. **SWE-bench 严谨评估**（arXiv 2310.06770）→ Pass@k、≥5 次跑、防脚手架泄漏。_建 eval 门禁。_
7. **Agent2Agent (A2A) 协议**（Google, 2025）→ 对等智能体互操作。_建 U3 客户端。_
8. **MCP**（Anthropic）→ 工具/资源标准。_已双向，保持。_

---

## 2. UCE 第一性框架（统一理论，非焊接）

三条不可再分公理（详见 `docs/UNITY_FRAMEWORK_UCE.md`）：

- **归一（Unity）**：代码、记忆、工具、智能体、任务、消息，全是同一「共振场」里的 `Node(addr, payload, edges)`。无平行表示 ⇒ 无状态分裂。
- **守恒（Conservation）**：认知能量 C（注意力配额+信用）在场内流转不增不减，每一笔入账即哈希链账本（已落地审计链升格）。QEC 做守恒纠错层。
- **演变（Evolution）**：场在「可验证奖励」（编译/测试绿，零标注）势函数下自发形变，由现有 `evolution` 闭环驱动。

**为什么比焊接优雅**：焊接 = N 模块拼 N-1 边界 + N 条验证路径（边界必漏 ⇒ 后遗症）；UCE = 1 个场 + 1 条守恒 + 1 个演变，一致性由构造保证。三缺口（repo-map / eval / A2A）是场**自己涌现**的，不是焊上去的。

---

## 3. 已落地真实能力 + 前后指标（_实测_）

| 指标                      | 升级前（=行业现状：整文件/grep）         | 升级后（OmniHarness 检索式上下文）                  | 提升                     |
| ------------------------- | ---------------------------------------- | --------------------------------------------------- | ------------------------ |
| 单查询平均上下文 token    | grep 同预算 22,062 / 整语料 309,433      | **≈ 2,949**（混合打分 Top-14 文件大纲+Top-30 符号） | **1/7.95 ~ 1/114.03**    |
| 文件召回率（10 查询均值） | grep 同预算 **60.83%**（已实测对方召回） | **67.0%**                                           | +6.2pp 且 token 省 7.95x |
| 符号精度@30               | 无（整文件不暴露符号级）                 | **25%**                                             | 新增能力                 |
| 依赖                      | tree-sitter / 向量库                     | **零依赖**（正则+BM25+标准库）                      | 守零依赖铁律             |

**诚实短板**：67.0% 中仍有 3 条查询未改善。其中 `sandbox policy evaluated` vs 含 `execPolicy` 的文件属**真语义鸿沟**（非形态错配）——query 与答案无字面/形态关系，五类静态技巧（词袋/频域/引用图/SVD/PRF）已实测集体失效。补法见 U3（生产期 LLM 蒸馏记忆，或本地 embedding）。

---

## 4. 综合升级路线（每阶段：技术来源 + 复用模块 + KPI）

### U1 · 共振场统一基板（_架构确定性_）

- 技术来源：UCE 归一公理；复用 `resonantMemory.ts` + `cosmicWeb.ts` 合并为 `ResonantField`。
- 动作：把代码/记忆/工具/代理/任务全部建模为 `Node`；现有子系统作为场的投影。
- KPI：子系统状态源数量 6→1；跨子系统一致性缺陷数（grep "状态不同步"）→0。

### U2 · repo-map 接生产循环（_实测_ 复制）

- 技术来源：Aider repo-map + 本基准。
- 动作：`contextAssembler` 在构造系统消息时调用 `contextEngine.query()` 注入紧凑 repo-map；保留整文件兜底。
- KPI：真实任务平均上下文 token 下降 ≥4x（用新一批查询复测）；任务成功率不降（AB 对照，_待实测_）。

### U3 · 共振语义层融合，召回破天花板（_实测结论：频域零增益，转生产期蒸馏_）

> 详见 `docs/U3_CONTEXT_RECALL_EXPERIMENT.md`（真实实验，含前后对比数字）。

- **已实测（2026-09-05）**：
  - 纯词法 BM25 repo-map（既有实现）：召回 **60.83%**。
  - 频域共振符号并集：**对代码符号召回零实质增益**——字符频谱与词袋在短符号域高度冗余。
  - **camelCase 拆分 + 词形变体归并：✅ 唯一有效**，召回 60.83% → **67.0%**，符号精确率 13% → **25.5%**（+96%），token 反降。病根是分词器缺陷（`registerTool`→`registertool`、`spilled`≠`spill`），非语义鸿沟。
  - 伪相关反馈 PRF：**有害**，召回掉到 42%（噪声扩展在 FILE_K 截断下挤掉真相关文件）。
  - 跨文件引用图 PageRank（44 万边）：**零增益**，稠密图收敛至均匀，相对排序不变且白增 token。
  - LSA/SVD：**叠加后有害**，召回持平但符号精确率 25.5% → 10.5%。
  - 结论：五类静态技巧中**四类实测无效**；形态层已由词形归并突破，剩余为真语义鸿沟。
- **破局路径（诚实定位）**：静态零依赖基准到此为止。真语义突破需 `ResonantMemoryPort`（燧-3）召回 `MemoryFact`→反查文件路径，但这要求**生产期由 LLM 蒸馏「X 在 Y 文件」关联写入记忆**（运行时能力，非静态基准可测）。
- 动作：把 repo-map 符号摘要+路径预灌/蒸馏为 MemoryFact，`query` 时先 `resonateByText` 召回事实→提取路径→并入文件召回集；接现有 `capability-swebench.json` live 段做真跑分验证。
- KPI：语义层补齐后文件召回 **67.0% → ≥80%**（live 跑分复测）；token 增幅 ≤1.5x。当前状态：**形态层已达成，语义层待验证**，不宣称已达成。

### U4 · 进化闭环升格为 RLVR（_待实测_）

- 技术来源：RAGEN/StarPO(2504.20073) + RLVR(2506.14245)。
- 动作：把 `evolution` 闭环的奖励从启发式改为「编译/测试绿」可验证奖励，场在势函数下形变。
- KPI：同任务集连续 50 轮，上下文效率曲线单调改善 ≥10%；无人工标注。

### U5 · 专属 eval 门禁（_已有 10/10 live 基线，扩规模_）

- 技术来源：SWE-bench(2310.06770) 严谨法（Pass@k、≥5 次跑、防脚手架泄漏）。
- 现状：已有 `benchmark/capability-swebench.json` —— deepseek-chat live **10/10 通过**（$0.20 / 64.7s），但为自研 10 题套件。
- 动作：建 `evals/swebench-lite` 子集 + Terminal-Bench 子集，接 CI 回归门禁，用 Pass@k(≥5 跑)；把自研套件扩到官方 SWE-bench Verified 子集。
- KPI：在**官方 SWE-bench Verified 子集**上产出真实 Pass@k（当前缺此规模化数字）；自研 10 题套件保持 100% 通过率作为回归门禁。

### U6 · A2A 互操作客户端（_架构确定性_）

- 技术来源：Google A2A 协议(2025) + 现有 MCP 双向。
- 动作：两个**同构共振场**共振互操作，无协议翻译层。
- KPI：OmniHarness 实例间任务委托延迟 <200ms（本地回环）；任务完成率 ≥与单实例同水平。

### U7 · 全链路零依赖铁律自检（工程化）

- 复用 `scripts/check.mjs`。
- KPI：新增模块零运行时依赖；`tsc --noEmit` 零错误（_已验证_ 本次新增模块通过）。

---

## 5. 风险与诚实边界

1. **上下文效率的「碾压」是真实的、可复现的**（114x vs 整语料、7.95x vs grep 竞品）。**方法论已修正**：此前只测我方召回、只测竞品 token（那样"省 4x"可能只是"给得更少"）；现竞品召回同测 —— 竞品 60.83% < 我方 67.0%，即**省了还更准**。
2. **端到端实时跑分已有基线、但样本小**：`capability-swebench.json` 显示 deepseek-chat live **10/10 通过**（$0.20 / 64.7s），加上 `efficiency-benchmark.json` 多项硬指标（冷启动 86ms、压缩省 80.7%、检索 12.9k qps）与 `selfcheck` 6/6 通过。**但**该 10 题为自研套件，非官方 SWE-bench Verified；故"完全碾压同类"的严谨论断仍需 U5 在官方子集上跑出 Pass@k 方可成立——不夸大现有 10/10 为"SWE-bench 成绩"。
3. **召回 67.0% 已超竞品同等预算（60.83%）**；剩余 3 条未改善查询中，`policy`/`execPolicy` 属真语义鸿沟，U3 对症。
4. **A2A / RLVR / 共振融合目前是设计+部分模块，非生产验证**；路线给出具体 KPI，跑不出不宣称。

---

## 6. 交付物索引

- 本方案：`docs/UPGRADE_PLAN_SYNTHESIS.md`
- UCE 框架：`docs/UNITY_FRAMEWORK_UCE.md`
- 调研总文档：`docs/LANDSCAPE_RESEARCH_2026.md`
- 架构说明书：`docs/ARCHITECTURE_SPEC.md`
- 精度看板：已删除（HTML 渲染物与 md 内容重复，2026-09-13 文档整理；指标以 `evals/context-efficiency/RESULTS.json` 为准）
- 已落地代码：`src/context/repoMap.ts`、`src/context/contextEngine.ts`
- 可复现基准：`evals/context-efficiency/bench.mjs` + `RESULTS.json`（复跑：`npx tsc <三文件> --outDir .xeval ... && node bench.mjs src`）
