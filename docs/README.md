# OmniHarness 文档索引

> 本文件是 `docs/` 的**唯一入口**。任何新文档入库前先在这里登记；被取代的文档直接删除
> （本仓不再维护历史存档）。
> 状态口径铁律：**进度与状态只认 [PROJECT_BOARD.md](PROJECT_BOARD.md)（唯一事实源）**；
> 其余文档里的进度数字一律视为**撰写时点快照**——带日期后缀的报告天然是快照，
> 不带日期的手册（`QUICKSTART.md` 等）必须保持长期有效。

---

## 按角色选路径

| 你是谁                          | 先读                                                                                | 再读                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 第一次接触本项目                | 本文件 → [QUICKSTART.md](QUICKSTART.md)                                             | [ARCHITECTURE_UPGRADE_2026-10.md](ARCHITECTURE_UPGRADE_2026-10.md) §2（现状逐条实测） |
| 评审/投资视角（"现在到底怎样"） | [ARCHITECTURE_UPGRADE_2026-10.md](ARCHITECTURE_UPGRADE_2026-10.md)                  | [PROJECT_BOARD.md](PROJECT_BOARD.md)（进度与门禁状态）                                |
| 想接入/嵌入的第三方             | [integration.md](integration.md) → [PORTS_CONTRACT.md](PORTS_CONTRACT.md)           | [API_STABILITY.md](API_STABILITY.md) → [protocol.md](protocol.md)                     |
| 想写插件的第三方                | [PLUGIN_GUIDE.md](PLUGIN_GUIDE.md) → [contributing.md](contributing.md)             | [CODE_STANDARD.md](CODE_STANDARD.md)                                                  |
| 维护者/开发者                   | [PROJECT_BOARD.md](PROJECT_BOARD.md) → [CODE_STANDARD.md](CODE_STANDARD.md)         | [DOMAIN_SLICE_TEMPLATE.md](DOMAIN_SLICE_TEMPLATE.md) + [adr/](adr/README.md)          |
| 想知道"为什么不做某些事"        | [ARCHITECTURE_UPGRADE_2026-10.md](ARCHITECTURE_UPGRADE_2026-10.md) §5（反泡沫清单） | [DEPENDENCY_POLICY.md](DEPENDENCY_POLICY.md)                                          |

---

## 1. 旗帜文档（当前权威）

| 文档                                                                                 | 职责                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PROJECT_BOARD.md](PROJECT_BOARD.md)                                                 | **唯一前进看板（唯一事实源）**：门禁状态 / 已知未修缺陷 / 挂起项 / 活跃纪律摘录，全部信息以「本机可复核」为准                                                                                                                                                                                                                                                                      |
| [ARCHITECTURE_UPGRADE_2026-10.md](ARCHITECTURE_UPGRADE_2026-10.md)                   | **架构现状核查与升级调研**：11 专题外部调研（逐条带一手 URL）+ 现状实测核查 + P0→P3 路线图 + 反泡沫清单。**当前"架构该往哪投"的主要依据**；其 §4 是活跃路线图                                                                                                                                                                                                                      |
| [ARCHITECTURE_SPEC.md](ARCHITECTURE_SPEC.md)                                         | **现行工程架构说明书**：铁律 / 目录归属与依赖方向（与 `architectureGate` 同口径输出标签）/ 主循环数据流与不变量 / 沙箱矩阵与隔离口径 / 上下文与记忆 / 门禁两层 / 规模快照（**结构声明由 `architectureSpec.test.ts` 与代码逐条交叉核对**）                                                                                                                                          |
| [PROTOCOL_ECOSYSTEM.md](PROTOCOL_ECOSYSTEM.md)                                       | **协议生态现行说明（2026-10-24）**：ACP v1 / A2A 1.0 / AG-UI 的入口、覆盖矩阵与仍未支持点；与 MCP 2026-07-28 分开登记                                                                                                                                                                                                                                                              |
| [ARCHITECTURE_TARGET_2026-10.md](ARCHITECTURE_TARGET_2026-10.md)                     | **目标架构蓝图（Evolvix-Ω 开放进化基座）**：现状→目标态的"配置→受治理状态"飞跃 / UCE 公理到资产协议的映射 / 五层架构 / 6 条稳定性不变式 / 上限三层设计（资产类型开放·元进化·任务共进化）/ Wave A–E 分波浪路线（先 ADR 后码）。**目标态非现状**，与 SPEC 冲突处以 SPEC 为准                                                                                                         |
| [TRANSPORT_STACK_EVALUATION_2026-10.md](TRANSPORT_STACK_EVALUATION_2026-10.md)       | **传输栈评估（fastify 拒绝 / ws 暂不引入）**：实测 49 包 / 7.66 MB 双超预算 + 自研 RFC6455 帧层 4 处协议缺陷的审计与修复 + 复评触发条件                                                                                                                                                                                                                                            |
| [CONCURRENCY_MATH_2026-10-25.md](CONCURRENCY_MATH_2026-10-25.md)                     | **多会话并发数学调研与落地映射**：互斥/读写锁/公平排队（SFQ）/CAS/行级 diff3/死锁有序加锁/原子 rename/资源预算，逐条对应本仓代码与判据；含未做边界（字符级合并/OT/CRDT、多机向量时钟、形式化验证）与重评触发条件                                                                                                                                                                   |
| [PROJECT_EVOLUTION_PLAN_2026-10-25.md](PROJECT_EVOLUTION_PLAN_2026-10-25.md)         | **能力升级总规划（2026-10-25）**：独立性 / 桌面 / 长任务 / 多 Skill / Web+桌面五条工作流、优先级与执行状态；进度仍以看板为准                                                                                                                                                                                                                                                       |
| [WEB_DESKTOP_CAPABILITY_MATRIX.md](WEB_DESKTOP_CAPABILITY_MATRIX.md)                 | **Web / 桌面能力矩阵**：共享层 / 文件 / 通知 / 更新 / 安全 / 缺口六张表，明确哪些能力 Web 无替代、哪些是桌面壳独有                                                                                                                                                                                                                                                                 |
| [BLOCKERS_2026-10-25.md](BLOCKERS_2026-10-25.md)                                     | **剩余阻塞项**：必须由外部环境/凭据才能继续的项（签名证书、浏览器真机、API key 等），每项附复现证据与解阻命令                                                                                                                                                                                                                                                                      |
| [LONG_TASK_SUPERVISOR_FIX_2026-10-26.md](LONG_TASK_SUPERVISOR_FIX_2026-10-26.md)     | **长任务自锁修复**：真实模型跑长任务时 supervisor 一次写类失败即降级为 safe、后续写类全拒导致 3 小时空转的复盘与修复                                                                                                                                                                                                                                                               |
| [OTEL_EXPORT_EVALUATION_2026-10.md](OTEL_EXPORT_EVALUATION_2026-10.md)               | **OTel 导出评估（裁决：维持自研）**：B 级「先测后买」的实测记录（10 包 / 17.8 MB vs 预算 2 MB）+ 两条新判据（线格式 golden / 线↔账目对账）+ 复评触发条件                                                                                                                                                                                                                           |
| [EVOLVIX_SPEC_2026-10.md](EVOLVIX_SPEC_2026-10.md)                                   | **Evolvix-Ω 架构规格书（实现级）**：核心数据契约（CapabilitySchema/Record/台账行格式）/ 端口清单（新增 8·扩展 1）/ 逐文件模块清单 / 四条关键流程时序 / 持久化布局 / 信任-隔离矩阵 / A 级依赖接入点 / J1–J9 门禁判据。**全部为设计产物未实现**                                                                                                                                      |
| [COMMERCIALIZATION_GAPS_2026-10.md](COMMERCIALIZATION_GAPS_2026-10.md)               | **商业化路线图剩余项裁决记录**：逐项判定「① 已落地（带提交号+判据）/ ② 阻塞（缺什么、如何诚实降级）/ ③ 非代码项（若要做的前置）」——E1+–H3 已落地；wasmtime（J8）与 Wave E 为纪律性阻塞；F4/G1/G3/G4/H2 属运营与计费面；F2 前端 tab 属产品面                                                                                                                                        |
| [USABILITY_AUDIT_2026-10-09.md](USABILITY_AUDIT_2026-10-09.md)                       | **易用性 / 低学习成本审计（产品可用性轴）**：F1–F9 逐条带真机证据（CDP 截图 / 像素测量 / CLI 实跑）与「已修（带判据）/ 未修（写明前置）」判定；与上面几份"工程严谨性"报告看的是**不同的轴**，未修项 F8（窄视口横向溢出）/ F9（补丁层告警不可行动）是下一轮依据                                                                                                                     |
| [LONG_SESSION_QUALITY_2026-10-20.md](LONG_SESSION_QUALITY_2026-10-20.md)             | **长会话质量分析**：152 个会话的横向统计（冗余取回 / 压缩抖动 / 缓存命中 / 成本），给出数据驱动的修复清单与已修/未修边界。带日期快照                                                                                                                                                                                                                                               |
| [PELICAN_SESSION_POSTMORTEM_2026-10-19.md](PELICAN_SESSION_POSTMORTEM_2026-10-19.md) | **鹈鹕会话复盘**：单会话纵深复盘（工具轨迹 / 失败模式 / 成本），是长会话质量分析的前一篇。带日期快照                                                                                                                                                                                                                                                                               |
| [CODE_STANDARD.md](CODE_STANDARD.md)                                                 | **编码与门禁标准**：类模板、命名、六边形职责划分、门禁分层（§7.1）、隐喻引擎成熟度声明（§8）                                                                                                                                                                                                                                                                                       |
| [EVOLUTION_COMMERCIALIZATION_2026-10.md](EVOLUTION_COMMERCIALIZATION_2026-10.md)     | **自进化商业落地方案研究报告**：资产盘点（自进化六环体检）/ 市场调研（二手来源须复核）/ 商业模式选项矩阵与推荐 / E1–E5 插电路线图（每项带可证伪判据）/ 定价与 GTM / 风险登记册。带日期快照，进度不以此为准                                                                                                                                                                         |
| [EVOLUTION_RD_RESEARCH_2026-10.md](EVOLUTION_RD_RESEARCH_2026-10.md)                 | **自进化先行研究调研与自研方案**：GitHub 开源 + 学术机制级择优学习表（采纳/改造/拒绝逐条给理由）/ what-when-how 分类法对位 / 自研「进化环 2.0（GEE）」设计（六环→模块映射 + 判据细化）。带日期快照，外部星标与跑分为检索快照未复现                                                                                                                                                 |
| [EVOLUTION_ARCH_UPGRADE_2026-10.md](EVOLUTION_ARCH_UPGRADE_2026-10.md)               | **进化域架构升级方案（GEE Kernel v1）**：现状架构实读（含对"信号采集器孤儿"表述的订正）/ 目标架构与决策表 / 逐文件模块映射 / S1–S7 实施切片（每片带可证伪判据与人日）/ 收益核算与边界。配套 [adr/0008](adr/0008-governed-evolution-kernel.md)，**实施蓝图未落地前不得当现状引用**                                                                                                  |
| [DESKTOP_ARCHITECTURE_2026-10.md](DESKTOP_ARCHITECTURE_2026-10.md)                   | **桌面应用技术方案（v2 原生 UI 研究，已被 0017 取代）**：Avalonia/WinUI/Flutter/Qt 等候选调研与加权决策 / Avalonia 12.1 + 固定 Node 侧车 + 回环 HTTP 契约 / 无 WebView / 原生打包签名更新。当前实施方案见 [adr/0017](adr/0017-electron-official-app.md) 与 [desktop/README.md](../desktop/README.md)（Electron + React/TS，Codex 官方 App 同构），**未评审前不得当已批准方案实施** |
| [llms.txt](llms.txt)                                                                 | **面向 LLM / 自动化工具的机器可读索引**（llmstxt.org 规范）：只列权威入口与一句话职责，随 `docs/` 站点发布（站点根路径即 `/llms.txt`）                                                                                                                                                                                                                                             |

> **新增行为去哪找**：本机配置与工作区解析（根解析链 / 配置分层 / `~/…` 压缩 / BOM 容忍）、会话存档范围
> （`workspace:'*'`）、UI 模式暂存等最新行为，逐条记录在 [PROJECT_BOARD.md](PROJECT_BOARD.md) 的**第六十三 / 六十四轮**；
> 那里是这些行为的**唯一事实源**，本节表格只给「该读哪份文档」的导航。

## 2. 参考手册（长期有效的契约与指南）

| 文档                                                 | 内容                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| [STARTUP.md](STARTUP.md)                             | **一键启动与运行规范**（最快最简单的整体启动方式、探活、停止/重启、故障排查） |
| [QUICKSTART.md](QUICKSTART.md)                       | 5 分钟跑通（mock → 真模型 → Web 工作台）                                      |
| [CLI_REFERENCE.md](CLI_REFERENCE.md)                 | 子命令与旗标速查（26 个子命令 / 常用旗标 / JSON-RPC 探活）                    |
| [contributing.md](contributing.md)                   | 贡献铁律（一功能一类 / 一函数一职责）                                         |
| [DEPENDENCY_POLICY.md](DEPENDENCY_POLICY.md)         | 依赖准入政策（必要且更优即可依赖（D10）；`ports`/`core` 恒第三方-free）       |
| [API_STABILITY.md](API_STABILITY.md)                 | API 稳定性分级契约（`@public` / `@beta` / `@deprecated`）                     |
| [PORTS_CONTRACT.md](PORTS_CONTRACT.md)               | 端口契约：第三方实现 OmniHarness 端口的口径                                   |
| [integration.md](integration.md)                     | 接入指南（实现端口接口 → 注入配置 → 完成）                                    |
| [PLUGIN_GUIDE.md](PLUGIN_GUIDE.md)                   | 插件开发指南                                                                  |
| [protocol.md](protocol.md)                           | 协议文档 2.0（单源 schema 自动生成，勿手改；stdio / HTTP+SSE / WebSocket）    |
| [DOMAIN_SLICE_TEMPLATE.md](DOMAIN_SLICE_TEMPLATE.md) | 新增业务域的 7 步垂直切片模板                                                 |

## 3. 架构决策记录（ADR）

| 位置                  | 内容                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [adr/](adr/README.md) | 0001 六边形端口-适配器 · 0002 依赖白名单 · 0003 统一门禁 fail-closed · 0004 审计哈希链 · 0005 事件流单源 · 0006 沙箱诚实降级 · 0007 API 稳定标注 · 0008 治理化进化内核 · 0009 统一资产协议 · 0010 信任-隔离阶梯 · 0011 签名资产包分发 · 0012 插件进程隔离 · 0013 工作区信任 · 0014 MCP 认证 · 0015 桌面壳（已废止）· 0016 原生桌面 UI（已废止）· 0017 Electron 官方 App 同构（已接受） |

---

## 文档治理规则（铁律）

1. **一主题一权威**：每个主题只有一份现行文档；新报告写完后，旧版直接删除（不再保留历史存档）。
2. **状态只认看板**：进度 / 状态数字只更新 [PROJECT_BOARD.md](PROJECT_BOARD.md)；其余文档写"截至 X 日"的快照口径。
3. **命名即时效**：带日期后缀的报告（`*_2026-09-13.md`）天然是快照；不带日期的手册必须保持长期有效。
4. **负结果必须留档**：实验失败也要在现行报告里登记结论，不得静默删除证据。
5. **新 ADR 先于新机制**：改变架构形态的代码合入前，`adr/` 先落一条。
