# OmniHarness 文档索引

> 本文件是 `docs/` 的唯一入口。任何新文档入库前先在这里登记；被取代的文档移入 `archive/` 并在本表保留一行"去向"。
> 状态口径铁律：**进度与状态只认 `TASK_BOARD_2026-09-13.md`（剩余任务全量看板）**；`REFACTOR_BOARD_2026-09-12.md` 与 `UPGRADE_BOARD_2026-09-12.md` 为历史账（批次记录 + 决策日志 D1–D9 沿用），其余文档中的进度数字一律视为撰写时点快照。

---

## 按角色选路径

| 你是谁                          | 先读                                                        | 再读                                              |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| 第一次接触本项目                | 本文件 → `ARCHITECTURE_AND_GAP_2026-09-13.md` §0–2          | `QUICKSTART.md` 跑起来                            |
| 评审/投资视角（"比同类差在哪"） | `ARCHITECTURE_AND_GAP_2026-09-13.md` §4–§8                  | `archive/` 下的历史审计（看差距收敛过程）         |
| 想接入/嵌入的第三方             | `integration.md` → `PORTS_CONTRACT.md` → `API_STABILITY.md` | `protocol.md`（传输 schema）                      |
| 想写插件的第三方                | `PLUGIN_GUIDE.md` → `contributing.md`                       | `CODE_STANDARD.md`                                |
| 维护者/开发者                   | `TASK_BOARD_2026-09-13.md` → `ARCHITECTURE_SPEC.md`         | `CODE_STANDARD.md` + `DEPENDENCY_POLICY.md` + ADR |
| 理解技术方向（为什么这么做）    | `TECH_DIRECTION_SYNTHESIS_2026-09-12.md`                    | `UNITY_FRAMEWORK_UCE.md` + `library/README.md`    |

---

## 1. 旗帜文档（当前权威）

| 文档                                                                             | 职责                                                                                                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [TASK_BOARD_2026-09-13.md](TASK_BOARD_2026-09-13.md)                             | **唯一前进看板**：剩余任务全量盘点（A 兼容性 / B 可信度 / C 工程收口 / D UI 工程化 / E 能力扩展 / F 测试运维六线）+ 进行中/挂起/下一批排序   |
| [ARCHITECTURE_AND_GAP_2026-09-13.md](ARCHITECTURE_AND_GAP_2026-09-13.md)         | **全景对标报告**：整体架构 + 与全部成熟同类的核心/边缘差距 + 待办 ROI 排序。回答"现在长什么样、差什么、先做什么"（§1 五条更正见 TASK_BOARD） |
| [ARCHITECTURE_SPEC.md](ARCHITECTURE_SPEC.md)                                     | **工程架构说明书**：六边形分层、目录归属表（与 architectureGate 门禁同口径）、核心数据流、沙箱矩阵、上下文引擎规格                           |
| [TECH_DIRECTION_SYNTHESIS_2026-09-12.md](TECH_DIRECTION_SYNTHESIS_2026-09-12.md) | **总体技术方向**：UCE 四公理（归一/守恒/演变/度量）+ T0–T6 七条主线 + 反泡沫清单。只论证"为什么"                                             |
| [REFACTOR_BOARD_2026-09-12.md](REFACTOR_BOARD_2026-09-12.md)                     | 历史账：P/T 批次执行记录 + 决策日志（D1–D9 沿用）+ 度量口径权威（§1）                                                                        |
| [UPGRADE_BOARD_2026-09-12.md](UPGRADE_BOARD_2026-09-12.md)                       | 历史账：U1–U7 框架升级批次记录                                                                                                               |

## 2. 参考手册（长期有效的契约与指南）

| 文档                                                 | 内容                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| [QUICKSTART.md](QUICKSTART.md)                       | 5 分钟跑通                                                             |
| [contributing.md](contributing.md)                   | 贡献铁律（一功能一类/一函数一职责）                                    |
| [CODE_STANDARD.md](CODE_STANDARD.md)                 | 编码标准（含隐喻引擎成熟度声明 L0–L3 规则）                            |
| [DEPENDENCY_POLICY.md](DEPENDENCY_POLICY.md)         | 依赖准入政策（零运行时依赖的边界与例外流程）                           |
| [API_STABILITY.md](API_STABILITY.md)                 | API 稳定性分级契约（@public/@beta/@deprecated）                        |
| [PORTS_CONTRACT.md](PORTS_CONTRACT.md)               | 端口契约：第三方实现 OmniHarness 端口的口径                            |
| [integration.md](integration.md)                     | 接入指南（实现端口接口 → 注入配置 → 完成）                             |
| [PLUGIN_GUIDE.md](PLUGIN_GUIDE.md)                   | 插件开发指南                                                           |
| [protocol.md](protocol.md)                           | 协议文档 2.0（单源 schema 自动生成，勿手改；stdio/HTTP+SSE/WebSocket） |
| [compliance.md](compliance.md)                       | 蓝图合规性审计报告（安全/合规口径）                                    |
| [DOMAIN_SLICE_TEMPLATE.md](DOMAIN_SLICE_TEMPLATE.md) | 新增业务域的 7 步垂直切片模板                                          |
| [SINGLETON_REGISTRY.md](SINGLETON_REGISTRY.md)       | 单例登记册（P2.1，43 处真状态判定）                                    |
| [MIGRATION_MAP_2026-09.md](MIGRATION_MAP_2026-09.md) | 迁移映射表与残差清单（T1.3，重构产物显式化）                           |

## 3. 架构与理论设计

| 文档                                                   | 内容                                                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [UNITY_FRAMEWORK_UCE.md](UNITY_FRAMEWORK_UCE.md)       | 万法归一架构（UCE 三公理：归一/守恒/演变）——第四公理"度量"见方向书                                                                                    |
| [UPGRADE_PLAN_SYNTHESIS.md](UPGRADE_PLAN_SYNTHESIS.md) | U1–U7 综合升级路线（调研 + UCE + 真实基准三合一，执行升级路线的权威来源）                                                                             |
| [adr/](adr/README.md)                                  | 架构决策记录（0001 六边形 · 0002 依赖白名单 · 0003 统一门禁 fail-closed · 0004 审计哈希链 · 0005 事件流单源 · 0006 沙箱诚实降级 · 0007 API 稳定标注） |

## 4. 实验与审计证据（当前有效）

| 文档                                                               | 内容                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [maturity-audit-2026-09-09.md](maturity-audit-2026-09-09.md)       | 最近一次全量成熟度审计（六维矩阵 + UI 专项对标 + 零测试模块清单）                                                               |
| [U3_CONTEXT_RECALL_EXPERIMENT.md](U3_CONTEXT_RECALL_EXPERIMENT.md) | 上下文召回实验：负结果全留档（LSA 有害/PageRank 零增益/频域共振无效），采纳词形归并                                             |
| [EMBEDDING_EVALUATION.md](EMBEDDING_EVALUATION.md)                 | 本地 embedding 依赖评估（破 U3 语义鸿沟的准入分析）                                                                             |
| [LANDSCAPE_RESEARCH_2026.md](LANDSCAPE_RESEARCH_2026.md)           | 竞品差距·最新技术·开放学术资源完备调研（2026-09-05）                                                                            |
| `benchmark/` + `evals/`（仓库根）                                  | 能力基准集：capability-swebench（自研 10 题 live 10/10）、efficiency、context-efficiency（可换度量对照框架）、layered-recall-ab |

## 5. 研究资料库

| 位置                                                                 | 内容                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [library/](library/README.md)                                        | 九卷理论库：前沿 3 卷（harness 工程/agent 学习/2026 栈）+ 学科 5 卷（信息优化/结构拓扑/物理/生物/化学）+ 索引。T0–T6 的理论来源 |
| [agent_evolution_research/](agent_evolution_research/12_进度看板.md) | 20 篇编号研究：agent 演化、太初数学内核、竞品量化对标等                                                                         |
| [archive/](archive/)                                                 | **历史报告存档**：被取代的审计/计划/路线图 + 根目录旧调研。只读参考，不再维护                                                   |

## 6. archive/ 存档清单（2026-09-13 整理）

| 存档                                                                                                                                              | 取代者                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `omniharness-maturity-audit-2026-09-06.md`（原工作区根）                                                                                          | 本目录 `ARCHITECTURE_AND_GAP_2026-09-13.md` §5 逐条复核其 P0 结论 |
| `agent-harness-audit-2026-09-06.md`（原工作区根，业界能力基线 20+ 来源）                                                                          | `ARCHITECTURE_AND_GAP_2026-09-13.md` §9 速查                      |
| `agentic-dev-landscape-2026-09-13.md`（原工作区根，18 项目能力矩阵）                                                                              | `ARCHITECTURE_AND_GAP_2026-09-13.md` §4                           |
| `GAP_MATURITY_AUDIT_2026-09-02.md` / `GAP_CLOSURE_2026-09-02.md` / `GAP_ANALYSIS_AND_PLAN.md` / `UPSTREAM_GAP_SOURCE_AUDIT.md`                    | maturity-audit-2026-09-09 + 全景报告                              |
| `COMPLETION_PLAN.md`（09-01 补全计划）/ `ROADMAP.md`（09-01 初版路线图）                                                                          | REFACTOR_BOARD_2026-09-12 + TECH_DIRECTION                        |
| `UPGRADE_BOARD_2026-09-05.md`（自标"已被取代"）                                                                                                   | UPGRADE_BOARD_2026-09-12                                          |
| `AGENT_LOOP_AUDIT_AND_UPGRADE_PLAN_2026-09-09.md` / `AGENT_LOOP_V2_REDESIGN.md`（已落地）                                                         | REFACTOR_BOARD P1（stepRunner 拆分已完成）                        |
| `BREAKTHROUGH_SCOUTING_2026-09-05.md` / `PEER_PRODUCT_ROUTES_2026-09-05.md` / `RESONANCE_UPGRADE_PLAN.md`（设计稿，被方向书"不新增隐喻引擎"取代） | U3 实验 + TECH_DIRECTION T2                                       |
| `architecture.md` + `architecture.html`（早期 8 端口愿景稿）                                                                                      | ARCHITECTURE_SPEC.md（15+ 端口现行版）                            |
| `OOP_REFACTOR_BACKEND_PLAN.md` / `CODE_STANDARD_REFACTOR_PLAN.md`（历史执行账）                                                                   | REFACTOR_BOARD P4/P6 承接                                         |
| `codex-vs-omniharness-ui-gap.md` / `audit-round3-2026-09-09.md`（09-09 时点 UI 盘点）                                                             | maturity-audit-2026-09-09 §3 + REFACTOR_BOARD                     |
| `HARNESS_GAP_REPORT.html` / `precision-kanban.html` / `progress-kanban.html`                                                                      | **已删除**（HTML 渲染物，内容与 md 重复）                         |

---

## 文档治理规则（铁律）

1. **一主题一权威**：每个主题只有一份现行文档；新报告写完后，旧版移 `archive/` 并在上表登记去向。
2. **状态只认看板**：进度/状态数字只更新 `TASK_BOARD_2026-09-13.md`；其余文档写"截至 X 日"的快照口径。
3. **命名即时效**：带日期后缀的报告（`*_2026-09-13.md`）天然是快照；不带日期的手册（`QUICKSTART.md` 等）必须保持长期有效。
4. **负结果必须留档**：实验失败不删文档——进实验报告（如 U3）并在方向书登记结论。
5. **新 ADR 先于新机制**：改变架构形态的代码合入前，`adr/` 先落一条。
