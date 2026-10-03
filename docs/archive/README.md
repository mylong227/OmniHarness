# 归档目录（docs/archive/）

> **本目录只读**：这里放的是**历史记录**——被取代的审计 / 计划 / 路线图 / 调研，以及迁移前位于
> `docs/` 根、`docs/library/`、`docs/agent_evolution_research/` 的旧材料（2026-10-03 G20 文档瘦身）。
> 每份归档文件顶部都有**归档横幅**：里面的文件数、测试数、召回率等数字**均不再代表现状**。
>
> **现行唯一事实源**：[../PROJECT_BOARD.md](../PROJECT_BOARD.md)（进度与状态）；
> **现行纪律**：[../CODE_STANDARD.md](../CODE_STANDARD.md)（编码与门禁标准）、
> [../DEPENDENCY_POLICY.md](../DEPENDENCY_POLICY.md)、[../API_STABILITY.md](../API_STABILITY.md)、
> [../PORTS_CONTRACT.md](../PORTS_CONTRACT.md)；**现行架构事实**：[../ARCHITECTURE_UPGRADE_2026-10.md](../ARCHITECTURE_UPGRADE_2026-10.md)
> （对现状的逐条实测核查，含反泡沫清单）。

## 为什么归档而不是删除

负结果与旧数字是**证据**：本仓的纪律是"失败的照实记、有效的才留"。删掉它们会让后来者重复踩同一坑
（例如潜语义 LSA 的"叠加后精确率腰斩"、图检索的"稠密图收敛至均匀"都在这里留档）。归档解决的是另一个
问题——**别让旧数字被当成现状**：横幅 + 索引 + 现行文档不再引用它们，即达到该目的。

## 清单（共 55 份）

### 一、根级历史报告（原 `docs/` 根，40 份）

| 文件                                              | 标题                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `AGENT_LOOP_AUDIT_AND_UPGRADE_PLAN_2026-09-09.md` | Agent Loop 审计与升级计划（2026-09-09）                                         |
| `AGENT_LOOP_V2_REDESIGN.md`                       | Agent Loop V2 重构蓝图（2026-09-09）✅ 已落地                                   |
| `ARCHITECTURE_AND_GAP_2026-09-13.md`              | OmniHarness 整体架构与同类差距全景报告（2026-09-13）                            |
| `ARCHITECTURE_SPEC_2026-09.md`                    | OmniHarness 工程项目架构说明书                                                  |
| `BREAKTHROUGH_SCOUTING_2026-09-05.md`             | 突破侦察报告：代码混合检索天花板（67%→≥80%）                                    |
| `CODE_STANDARD_REFACTOR_PLAN.md`                  | 全库代码规范重构计划                                                            |
| `COMPLETION_PLAN.md`                              | OmniHarness 调研差距清单与补全计划（2026-09-01）                                |
| `CORE_CAPABILITY_AUDIT_2026-10-01.md`             | OmniHarness 核心能力排查与提升（2026-10-01）                                    |
| `DEFICIENCY_AUDIT_2026-09-22.md`                  | OmniHarness 不足审计：逻辑 / 性能 / 架构 / 召回（2026-09-22）                   |
| `EMBEDDING_EVALUATION.md`                         | 本地 Embedding 依赖评估（破 U3 语义鸿沟）                                       |
| `FRONTEND_GAP_SOURCE_AUDIT.md`                    | 前端全功能页面对标审计（vs `deepseek-harness` Web / `codex`）                   |
| `GAP_ANALYSIS_AND_PLAN.md`                        | OmniHarness 对标与补全计划（vs DeepSeek Harness / OpenAI Codex Harness）        |
| `GAP_CLOSURE_2026-09-02.md`                       | 差距一次性抹平 · 结案报告（2026-09-02）                                         |
| `GAP_MATURITY_AUDIT_2026-09-02.md`                | OmniHarness 成熟度差距审计（2026-09-02）                                        |
| `INTERFACE_REFACTOR_QUEUE.md`                     | 接口层重构队列（INTERFACE_REFACTOR_QUEUE）                                      |
| `LANDSCAPE_RESEARCH_2026.md`                      | OmniHarness 竞品差距 · 最新技术 · 开放学术资源 完备调研文档                     |
| `MIGRATION_MAP_2026-09.md`                        | 迁移映射表与残差清单（T1.3 · 2026-09-13）                                       |
| `OOP_REFACTOR_BACKEND_PLAN.md`                    | src/ 顶层函数 → 类收敛清单                                                      |
| `PEER_PRODUCT_ROUTES_2026-09-05.md`               | 同类优秀产品的代码检索技术路线与参考价值                                        |
| `POLISH_PLAN.md`                                  | OmniHarness 打磨计划（2026-09-15）                                              |
| `RECALL_HEADROOM_SURVEY.md`                       | 检索命中率提升空间调研（2026-09-17）                                            |
| `RESONANCE_UPGRADE_PLAN.md`                       | OmniHarness 自研最佳升级路径 —— RDAA 共振驱动智能体架构                         |
| `ROADMAP.md`                                      | OmniHarness 成熟度差距与落地路线图（ROADMAP）                                   |
| `ROADMAP_2026-09-20.md`                           | OmniHarness 全项目任务清单（Roadmap）                                           |
| `SINGLETON_REGISTRY.md`                           | 单例登记册（P2.1 · SINGLETON_REGISTRY）                                         |
| `STATE_AUDIT_2026-09-22.md`                       | OmniHarness 状态盘点（2026-09-22 · 本会话实测版）                               |
| `SUSPENDED_BETTER_PATHS.md`                       | 挂起项更优解调研（B1 / B2 / B3 / F4）                                           |
| `TECH_DIRECTION_SYNTHESIS_2026-09-12.md`          | OmniHarness 总体技术方向（2026-09-12）                                          |
| `U3_CONTEXT_RECALL_EXPERIMENT.md`                 | U3 上下文召回实验报告（实测，2026-09-05）                                       |
| `UNITY_FRAMEWORK_UCE.md`                          | OmniHarness 万法归一架构（UCE）                                                 |
| `UPGRADE_PLAN_SYNTHESIS.md`                       | OmniHarness 综合升级方案（调研 · UCE 框架 · 真实基准 三合一）                   |
| `UPSTREAM_GAP_SOURCE_AUDIT.md`                    | 上游源码级差距审计（vs `D:\deepseek\codex` / `D:\deepseek\deepseek-harness`）   |
| `agent-harness-audit-2026-09-06.md`               | 自研 AI Agent Harness 差距审计 · 业界能力基线（2026-09）                        |
| `agentic-dev-landscape-2026-09-13.md`             | AI Coding-Agent / Agentic-Dev-Tool Landscape — Feature-Gap Analysis (Sept 2026) |
| `architecture.md`                                 | OmniHarness 架构文档                                                            |
| `audit-round3-2026-09-09.md`                      | OmniHarness 第三轮盘点——两轮 UI 对齐后的剩余升级空间                            |
| `codex-vs-omniharness-ui-gap.md`                  | Codex vs OmniHarness —— UI 功能差距盘点与综合建议                               |
| `compliance.md`                                   | OmniHarness 蓝图符合性审计报告（完整版）                                        |
| `maturity-audit-2026-09-09.md`                    | OmniHarness 成熟度审计 + UI 对标报告                                            |
| `omniharness-maturity-audit-2026-09-06.md`        | OmniHarness 完善度审计报告                                                      |

### 二、子目录（理论库 / agent 演化研究，15 份）

| 文件                                                              | 标题                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `agent_evolution_research/12_进度看板.md`                         | 12 · 进度看板（Verifiable & Controllable Board）             |
| `agent_evolution_research/16_长期运行数据回填与参数收紧闭环.md`   | 16 · 长期运行数据回填与参数收紧闭环（I-P4-3 完备收口）       |
| `agent_evolution_research/17_全量整合与收口.md`                   | 17 · 全量整合与收口（P0–P4 完整闭环）                        |
| `agent_evolution_research/18_自研化最低能耗最高效架构研究报告.md` | 18 · 自研化最低能耗 / 最高效 / 最低运行成本架构研究报告      |
| `agent_evolution_research/19_太初数学内核架构.md`                 | 19 · 太初数学内核（Genesis Core）—— 可推演 · 自适应 · 多模态 |
| `agent_evolution_research/20_竞品量化对标与超越性报告.md`         | 20 · 竞品量化对标与超越性报告                                |
| `library/01-frontier-harness-engineering.md`                      | 01 · 前沿：线束工程（Harness Engineering）                   |
| `library/02-frontier-agent-learning.md`                           | 02 · 前沿：智能体的学习、记忆与推理                          |
| `library/03-frontier-stack-2026.md`                               | 03 · 前沿：工程栈 2026（TS / Node / 供应链）                 |
| `library/10-math-information-and-optimization.md`                 | 10 · 数学（一）：信息、推断、优化、动力系统                  |
| `library/11-math-structure-and-topology.md`                       | 11 · 数学（二）：结构、范畴、层、拓扑与度量                  |
| `library/20-physics.md`                                           | 20 · 物理：熵、耗散、相变、扩散、同步、拓扑与编码            |
| `library/30-biology.md`                                           | 30 · 生物：进化、免疫、预测编码、稳态与自组织                |
| `library/40-chemistry.md`                                         | 40 · 化学：反应动力学、自催化、耗散结构与化学计算            |
| `library/README.md`                                               | OmniHarness 技术图书馆（Tech Library）                       |

## 治理规则

1. **新文档先登记**：任何新文档入库前先在 [../README.md](../README.md) 登记；被取代的旧文档移入本目录并在这里加一行。
2. **归档必须带横幅**：移入本目录的每份 `.md` 顶部必须有 `已归档（日期）` 横幅（`tests/unit/docsLayout.test.ts` 会核对，
   漏加即红）。横幅的意义是把"这是历史"写在**文件自身**里——帖在外面的索引挡不住单独把文件转给别人的场景。
3. **现行文档不得把归档物当现状引用**：引用归档材料时必须写明"历史记录"字样与 `archive/` 路径。
4. **不因归档而改历史**：归档文件的正文**不改**（除横幅）——数字与结论都是撰写时点的真实记录。
