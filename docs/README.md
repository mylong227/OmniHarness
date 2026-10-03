# OmniHarness 文档索引

> 本文件是 `docs/` 的**唯一入口**。任何新文档入库前先在这里登记；被取代的文档移入
> [archive/](archive/README.md) 并在那里登记去向。
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

| 文档                                                               | 职责                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PROJECT_BOARD.md](PROJECT_BOARD.md)                               | **唯一前进看板（唯一事实源）**：门禁状态 / 已知未修缺陷 / 挂起项 / 活跃纪律摘录，全部信息以「本机可复核」为准                                                                                                                             |
| [ARCHITECTURE_UPGRADE_2026-10.md](ARCHITECTURE_UPGRADE_2026-10.md) | **架构现状核查与升级调研**：11 专题外部调研（逐条带一手 URL）+ 现状实测核查 + P0→P3 路线图 + 反泡沫清单。**当前"架构该往哪投"的主要依据**；其 §4 是活跃路线图                                                                             |
| [ARCHITECTURE_SPEC.md](ARCHITECTURE_SPEC.md)                       | **现行工程架构说明书**：铁律 / 目录归属与依赖方向（与 `architectureGate` 同口径输出标签）/ 主循环数据流与不变量 / 沙箱矩阵与隔离口径 / 上下文与记忆 / 门禁两层 / 规模快照（**结构声明由 `architectureSpec.test.ts` 与代码逐条交叉核对**） |
| [CODE_STANDARD.md](CODE_STANDARD.md)                               | **编码与门禁标准**：类模板、命名、六边形职责划分、门禁分层（§7.1）、隐喻引擎成熟度声明（§8）                                                                                                                                              |
| [llms.txt](llms.txt)                                               | **面向 LLM / 自动化工具的机器可读索引**（llmstxt.org 规范）：只列权威入口与一句话职责，随 `docs/` 站点发布（站点根路径即 `/llms.txt`）                                                                                                    |

## 2. 参考手册（长期有效的契约与指南）

| 文档                                                 | 内容                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| [QUICKSTART.md](QUICKSTART.md)                       | 5 分钟跑通                                                                 |
| [contributing.md](contributing.md)                   | 贡献铁律（一功能一类 / 一函数一职责）                                      |
| [DEPENDENCY_POLICY.md](DEPENDENCY_POLICY.md)         | 依赖准入政策（必要且更优即可依赖（D10）；`ports`/`core` 恒第三方-free）    |
| [API_STABILITY.md](API_STABILITY.md)                 | API 稳定性分级契约（`@public` / `@beta` / `@deprecated`）                  |
| [PORTS_CONTRACT.md](PORTS_CONTRACT.md)               | 端口契约：第三方实现 OmniHarness 端口的口径                                |
| [integration.md](integration.md)                     | 接入指南（实现端口接口 → 注入配置 → 完成）                                 |
| [PLUGIN_GUIDE.md](PLUGIN_GUIDE.md)                   | 插件开发指南                                                               |
| [protocol.md](protocol.md)                           | 协议文档 2.0（单源 schema 自动生成，勿手改；stdio / HTTP+SSE / WebSocket） |
| [DOMAIN_SLICE_TEMPLATE.md](DOMAIN_SLICE_TEMPLATE.md) | 新增业务域的 7 步垂直切片模板                                              |

## 3. 架构决策记录（ADR）

| 位置                  | 内容                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [adr/](adr/README.md) | 0001 六边形端口-适配器 · 0002 依赖白名单 · 0003 统一门禁 fail-closed · 0004 审计哈希链 · 0005 事件流单源 · 0006 沙箱诚实降级 · 0007 API 稳定标注 |

## 4. 归档目录（历史记录，只读）

| 位置                          | 内容                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [archive/](archive/README.md) | **历史报告存档（55 份）**：被取代的审计 / 计划 / 路线图 / 调研，含九卷理论库与 agent 演化研究。每份带**归档横幅**（数字不代表现状），索引见其 README |

> 2026-10-03（G20 文档瘦身）：`docs/` 根从 33 份收敛到 13 份——只留 **SSOT + 现行纪律 + 用户文档**；
> 其余（旧审计、旧计划、旧调研、理论库）移入 `archive/` 并逐份加横幅。文档死链基线同期从 **96 处收紧到 24 处**。
> 历史看板（`TASK_BOARD.md` / `REFACTOR_BOARD_2026-09-12.md` / `UPGRADE_BOARD_2026-09-12.md`）已于 2026-10-03 删除，
> 内容见 git 历史（`git show b49d96e^:docs/TASK_BOARD.md`）；其中仍具约束力的决策纪律（D6/D7/D10 等）已摘录进
> [PROJECT_BOARD.md](PROJECT_BOARD.md) §5。

---

## 文档治理规则（铁律）

1. **一主题一权威**：每个主题只有一份现行文档；新报告写完后，旧版移入 `archive/` 并在其中登记去向。
2. **状态只认看板**：进度 / 状态数字只更新 [PROJECT_BOARD.md](PROJECT_BOARD.md)；其余文档写"截至 X 日"的快照口径。
3. **命名即时效**：带日期后缀的报告（`*_2026-09-13.md`）天然是快照；不带日期的手册必须保持长期有效。
4. **负结果必须留档**：实验失败不删文档——进实验报告（如归档里的 `U3_CONTEXT_RECALL_EXPERIMENT.md`）并在报告里登记结论。
5. **归档必须带横幅**：移入 `archive/` 的每份 `.md` 顶部必须有 `已归档（日期）` 横幅
   （`tests/unit/docsLayout.test.ts` 会核对，漏加即红）——把"这是历史"写在**文件自身**里，单独转发也丢不掉。
6. **现行文档不得把归档物当现状引用**：引用归档材料时须写明"历史记录"并给出 `archive/` 路径。
7. **新 ADR 先于新机制**：改变架构形态的代码合入前，`adr/` 先落一条。
