# 独立复审与技术雷达（2026-10-24）

> 对象：`main` @ `abbd5226`（2026-10-23 收口提交）
> 口径：本机可复核命令 + 外部公开资料（检索快照 2026-10-24）。
> 结论只回答一个问题：**在已完成的内存/成本/准确率/结构收口之后，下一批真正值得做的是什么。**

---

## 0. 结论摘要

项目当前不是「还差很多基础能力」，而是**三处高杠杆缺口**：

1. **生产默认的混合检索没有被回归判据覆盖**。CLI 默认开语义召回，但 `probe:recall` 只测纯 BM25。同一 191 条查询、同一语料：BM25 **44.0%**，语义混合 **59.2%**（+15.2pp；core 71.9% → 81.3%）。这不是检索实现问题，是**测量覆盖缺口**；一旦语义索引静默回落，现有门禁不会红。
2. **缺少长时程任务的「可复核评测 + 结构化进度」闭环**。现有 `harnessAb` 只覆盖短文件任务；长任务仍靠 compaction 摘要，没有 initializer / feature-list / progress-file / pre-completion 验证这些前沿 harness 的稳定件。
3. **协议面只完成了一半**。MCP 2026-07-28 客户端已支持 discover/MRTR，但服务端只有 discover + `resultType`；A2A 只有最小 card/message/get；ACP、AG-UI 没有适配。对编辑器、跨 agent、标准 MCP 客户端的互操作会被卡住。

建议顺序：**先补测量（1–2 天）→ 再补评测（3–5 天）→ 再补协议（按需）**；不要先做沙箱/记忆的大重构。

---

## 1. 复审基线（本次实测）

| 指标               | 数值                                               | 口径                                             |
| ------------------ | -------------------------------------------------- | ------------------------------------------------ |
| 源码规模           | 1,170 个 `.ts` / 135,343 行                        | `git ls-files src`                               |
| 单测文件           | 620 个                                             | `tests/unit`                                     |
| 行/函数/分支覆盖率 | **84.58% / 90.02% / 85.03%**                       | `.coverage/coverage-summary.json`                |
| 全量单测           | **619 files / 3,794 tests passed**                 | `npm run test:fast`（2026-10-24 11:41）          |
| 集成               | **7/7 files、17/17 tests**                         | `npm run test:integration`                       |
| 全仓索引堆         | **108.9 MB heap / 281 MB RSS**                     | `node --expose-gc`，2,043 files / 32,475 symbols |
| BM25 检索          | **0.077 ms/次**（1000 次 5 词查询）                | 压缩后基准                                       |
| 纯 BM25 召回       | **44.0%**（core 71.9 / ext 38.4）                  | `probe:recall`，fileK=30                         |
| 语义混合召回       | **59.2%**（core 81.3 / ext 54.7）                  | `semanticHybridRecall --fileK=30`，fallback=0    |
| 工具面成本         | 53 工具 / off 6,167 token；plan 省 **69.6%–78.5%** | `probe:exposure`                                 |
| 前缀缓存           | 最近真实会话 **95.9%–97.5%** 命中                  | `telemetry:sessions`                             |

这些数字说明：**内存、单元质量、基础安全边界已经很强**；下一阶段的收益主要不在「再抠 5 MB」或「再补几个单测」，而在**默认路径的可测性、长任务可靠性、协议互操作**。

---

## 2. 已经做得好的部分（不要重复造）

- **事件溯源 + 回放 + 检查点/回卷**：真实会话可复盘，且回卷后压缩游标有判据；这是很多开源 harness 没有的。
- **fail-closed 的权限/沙箱/路径/出网边界**：审批六档、OS 沙箱可选、WorkspaceGuard、NetworkEgressGuard，且失败有可行动诊断。
- **上下文工程已有骨架**：repo-map、BM25+语义混合、RRF、工具暴露预算、压缩游标、子代理、前缀缓存测量。
- **可观测性不是空白**：OTLP spans + metrics + GenAI semconv 对齐；有 `observabilityReconcile` 对账。
- **质量纪律**：编码标准增量门禁、架构门禁、覆盖率门禁、确定性测试、独立评审记录；这比「再引入一个框架」更值钱。

因此下面的建议**不替换内核、不引入重运行时依赖**，只补缺口。

---

## 3. 发现与优先级

### P0-1（最高性价比）混合检索的「生产默认」没有被守住

**证据**

- `src/cli/execCli.ts` 的 `applyCliRetrievalDefaults()` 对 agent 路径设置 `OMNI_SEMANTIC_RECALL ??= '1'`，即 **CLI 默认走混合检索**。
- `tools/probes/recallHitrate.mjs` 直接调用 `ContextEngine.query(...)`（纯 BM25），没有注入 `EmbeddingPort`；`probe:recall` 的 44.0% 是**回退路径**的数字。
- 本轮实跑 `semanticHybridRecall.mjs --fileK=30`：BM25 44.0% → 混合 **59.2%**，`semanticFallbacks=0`。
- `RepoMapContextEngine` 有 `semanticFallbackTotal()`，但现有 CI 召回门禁不检查它；模型缺失/向量缓存不可写时会**静默退化为 BM25**，指标仍可能绿。

**影响**：默认体验的检索质量比门禁数字高 15pp，但一旦环境变化（离线、模型缓存损坏、权限问题），质量会静默掉回 44%，不会有红灯。这是「准确率」当前最大的可避免风险。

**建议**

1. `probe:recall` 增加 `--lens=bm25|hybrid|both`；`both` 输出两行，并显式打印 `semanticFallbacks`。
2. 新增 **hybrid 回归判据**：固定查询集 + 固定模型（本地缓存/CI 可选），断言：
   - `semanticFallbacks === 0`（不允许水分）；
   - hybrid recall ≥ BM25 − 容差，且 core 不低于冻结基线；
   - 若模型不可用，**显式 skip 并写明原因**，不静默当 BM25。
3. 单测层用 **fake EmbeddingPort** 钉住 RRF 融合/排序/去重（无需真模型）；真模型层放 nightly 或 `OMNI_REQUIRE_SEMANTIC=1`。
4. 首次语义索引约 3.5 分钟、权重 23 MB；在 CLI 里给「首次构建中，当前用 BM25」的可见状态，避免用户以为卡死。

**验收**：同一 191 条查询，hybrid 门禁稳定 ≥ 当前 59.2% − 容差；`semanticFallbacks=0`；离线场景显式 skip 而不是假绿。

---

### P0-2 长时程任务缺少「可复核评测 + 结构化进度」

**证据**

- `tools/eval/README.md` 明确：`harnessAb` 的内置任务只覆盖「写文件 + 读取确认」这类短任务；长任务需要自定义验收器。
- 没有 SWE-bench/Terminal-Bench 运行器；`docs/PROJECT_BOARD.md` 记录官方跑分设施已于 2026-10-03 主动删除（这是合理决策，不要恢复榜单）。
- 现有长会话靠 `ContextCompactor` 摘要 + `plan_write`/`todo_write`；没有「initializer 建立 feature list / progress file / init.sh」这类跨 context window 的稳定状态件。

**外部对照**

- Anthropic 的长时程 harness 明确用 **initializer agent + `claude-progress.txt` + feature-list JSON + git commit + init.sh**，解决「一次做太多」和「过早宣布完成」两类失败；仅靠 compaction 不够。
- Anthropic 的 eval 指南建议从 **20–50 个真实失败任务**开始，使用 deterministic graders + transcript 检查，并同时看 `pass@k` 与 `pass^k`。
- LangChain 只改 harness（self-verification、pre-completion checklist、目录上下文、时间预算、loop detection、reasoning sandwich）把 Terminal-Bench 2.0 从 52.8 提到 66.5；说明**评测驱动的 harness 迭代**比换模型更可控。

**建议**

1. 建一个**内部 20–30 任务**的 `eval:long`：
   - 每个任务：`repo fixture` + `prompt` + `verifyCommand`/文件断言 + `timeout` + `maxTokens`；
   - 每任务跑 k=3，报告 `pass@1`、`pass^k`、tokens/solved、墙钟、工具失败数；
   - 不追求官方榜单分数，只作为**回归/能力**双层判据。
2. 加 **长任务初始化协议**（复用现有工具，不新建框架）：
   - 首次进入工作区时生成 `.omniharness/tasks/<id>/features.json`（可勾选）、`progress.md`、`init.sh`；
   - 每回合开始读 progress + git log；结束写 progress + commit；
   - `PreCompletionChecklist` 钩子在模型准备结束前强制跑一次 `verifyCommand`（已有 `selfVerifyingToolPort` 可复用）。
3. 压缩时把 progress/features 作为**不可丢的结构化段**，摘要只压缩对话与工具输出（与现有压缩游标不冲突）。

**验收**：同一模型同一任务集，加入 checklist/进度件后 `pass^k` 提升或 tokens/solved 下降；单任务可复现，不依赖真实 API 也能跑 mock 机制测试。

---

### P0-3 MCP 2026-07-28：客户端走了一半，服务端只到 discover

**证据**

- `src/mcp/mcpProtocol.ts` 已有 `PROTOCOL_VERSION_V2 = '2026-07-28'`、`server/discover`；`mcpStatelessClient` 已处理 `input_required` MRTR。
- `src/mcp/mcpServer.ts` 只注册 `initialize`、`discover`、`tools/list|call`、`resources/list|read`、`prompts/list|get`，并给结果补 `resultType`；**没有** `subscriptions/listen`、`ttlMs`/`cacheScope`、服务端 MRTR `inputRequests`、`extensions` 能力。
- 规范 2026-07-28 的核心变化包括：移除协议级 session/initialize；每请求 `_meta` 版本/能力；`server/discover`；`subscriptions/listen`；结果 `resultType`；MRTR；可缓存结果的 `ttlMs`/`cacheScope`；`iss` 校验；`traceparent`/`tracestate`/`baggage` 传播。

**影响**

- 标准 2026-07-28 客户端连接本仓 MCP server 时，能 discover，但拿不到缓存提示、订阅、服务端输入请求；长任务/审批型工具无法按新规范往返。
- 反向：本仓客户端连别的 2026-07-28 server 已有基础，但 trace 传播缺失会让跨进程链路断在 MCP 边界。

**建议（按切片，不要一次全做）**

1. **缓存切片（小）**：`tools/list`、`resources/list|read`、`prompts/list` 加 `ttlMs` + `cacheScope`；`tools/list` 保持确定性排序（已有）。
2. **MRTR 切片（中）**：服务端对审批/`ask_user` 类工具返回 `resultType:"input_required"` + `inputRequests`；客户端已有重试，补 live handler。
3. **订阅切片（中）**：`subscriptions/listen` 支持 `toolsListChanged`；与现有 SSE 事件总线复用。
4. **安全切片（小）**：OAuth `iss`（RFC 9207）校验、CIMD 的 `application_type`、跨 issuer 凭据不复用。
5. **可观测切片（小）**：MCP `_meta` 注入 `traceparent`/`tracestate`/`baggage`，与 OTel 当前 trace 关联。

**验收**：`mcp:conformance` 增加 2026-07-28 向量；与 Claude/官方 SDK 客户端做一次 discover + list + call + input_required 的真实互操作；不破坏 legacy 客户端（`auto` 协商）。

---

### P1-1 协议生态：A2A 最小、ACP/AG-UI 缺失

**证据**

- `src/a2a/a2aProtocol.ts` 注释明确：`capabilities.declare` / `task.delegate` 是**私有**方法；A2A v1 只实现 `message/send`、`tasks/get`、`agent/getCard` 的最小互操作面。
- A2A 1.0 规范要求完整任务生命周期：`message/stream`、`tasks/cancel`、`tasks/subscribe`、push notification config、认证扩展等。
- 没有 ACP（Agent Client Protocol）端点；没有 AG-UI 事件协议适配。ACP 是编辑器（Zed 等）与 coding agent 的标准连接；AG-UI 是 agent 与用户界面的开放事件协议。

**建议**

- **ACP 优先于 AG-UI**：OmniHarness 是 coding agent，ACP 直接换编辑器入口；实现 `initialize`/session/prompt/工具事件/取消，TypeScript SDK 可参考。
- **A2A 补 stream/cancel/subscribe**：至少让长任务可被标准客户端监控/取消；push 可后置。
- **AG-UI 作为 Web 适配层**：现有 SSE/RPC 不动，新增 adapter；不要重写前端。

**验收**：Zed（或 ACP 测试 client）能列出会话、发 prompt、看到工具事件、取消；A2A 标准 client 能 `message/stream` 并 `tasks/cancel`。

---

### P1-2 长会话的「结构化状态」与上下文腐烂

**证据**

- `ContextCompactor` 在窗口 80% 触发摘要；摘要保留架构决策/未解 bug，但**没有强制的 progress/feature 状态**。
- 现有 `plan_write`/`todo_write` 是工具，不是自动注入的跨会话协议；模型可以不写。
- Chroma 的 context rot 报告：18 个模型在输入变长时性能非均匀下降；相似度越低、distractor 越多下降越快。Anthropic 也明确「compaction 不是充分条件」。

**建议**

- 采用 P0-2 的 features/progress/init 三件套；在系统提示里只注入**极简**的「当前任务、已完成、下一步、验证命令」，不把完整历史塞回去。
- 每回合结束写 progress；resume 时先读 progress + git log，再决定是否检索。
- 对长工具输出继续用 spill + preview；对「已消费」的工具结果在压缩时优先清理（已有工具结果裁剪，扩大策略需 A/B）。

**验收**：长任务 resume 后能复述「上次做到哪、下一步、怎么验证」；压缩前后 `pass^k` 不降。

---

### P1-3 安全：从「字符串防护」到「每动作授权」

**证据**

- 已有六档审批、沙箱、路径/出网守卫、`PromptInjectionGuard`、`OMNI_PROVENANCE_GUARD` 的 shadow/enforce。
- 但 provenance 仍是**字符串片段匹配**（代码注释自述会漏改写/编码、会误报正常引用）；没有按工具意图的 per-action 授权、没有签名审计记录、没有 MCP 工具描述哈希固定（防 rug-pull）。

**外部对照**

- OWASP LLM06:2025 Excessive Agency 明确要求最小权限、审批、作用域限制；Agentic AI 风险清单把工具滥用/身份/授权列为核心。
- 2026 的前沿实践在往 **pre-action authorization + 签名审计**（ALLOW/DENY/REQUIRE_APPROVAL/MASK）和 **tool list hash pinning** 走，而不是只靠提示词。

**建议**

1. 给每次工具调用生成 `intent`（filesystem_delete / network_outbound / exec / write 等）+ 作用域（路径/命令/域名），由统一 PDP 决策；现有 `ToolGate`/`ApprovalPort` 可扩展，不重写。
2. MCP 外部工具：首次 `tools/list` 记录名称/描述/schema 哈希；变更时要求重新审批（防 tool poisoning/rug-pull）。
3. 审计事件带签名字段（可选 Ed25519），至少让导出可独立 verify；与现有 provenance 证书链对齐。
4. 增加注入对抗用例：编码/分段/间接引用/工具输出回灌；shadow 模式先跑，不直接 enforce。

**验收**：恶意工具描述变更触发重新审批；编码后的注入样本在 shadow 中命中；不误伤正常引用（用现有误报集）。

---

### P2-1 记忆：已有 trust/decay/conflict，缺时间图与巩固

**证据**

- 已有 `FileLongTermMemory`、时间衰减、`untrustedPenalty`、冲突 supersede/expiresAt、LongMemEval-S 本地代理。
- 没有实体/关系/时间图（谁在何时做了什么、哪条事实覆盖哪条），也没有跨会话的周期性巩固（consolidation）。

**外部对照**

- Mem0/Letta/Zep 都在做「事实抽取 + 时间有效性 + 图/实体」；Chroma 的 LongMemEval 结果显示「只给相关片段」远好于「全量历史」。
- 对本项目，**不需要引入向量数据库**；可以在现有文件记忆上加 `subject-predicate-object` 三元组 + `validFrom/validTo`，用 BM25/时间过滤召回。

**建议**：先做「事实卡」结构（实体、关系、时间、来源、trust），再做巩固任务；与现有 conflict 逻辑合并。P2，不建议先于 P0。

---

### P2-2 沙箱：policy 不是隔离，容器/microVM 是可选阶梯

**证据**

- 默认 `policy` 做危险命令/路径拦截；OS 级 landlock/seatbelt/bwrap/unshare 可选，失败即 fail-closed。
- 没有容器/microVM 后端；Windows 上只有 policy/受限路径守卫。

**外部对照**

- OpenAI Agents SDK 提供 `SandboxAgent`/Unix/Docker sandbox；E2B/Daytona/microsandbox 把「长任务隔离 + 快照」做成基础设施。
- 对本项目，完整 microVM 是重投入；**Docker/Podman 作为可选适配器**更现实，保持默认 policy。

**建议**：加 `container` 沙箱端口（可选依赖检测、fail-closed），网络默认 deny + allowlist；用于高风险/长任务；不做默认。

---

### P2-3 多模型/实时：不是当前瓶颈

- 现有 `openAiCompatible`、`responses`、`anthropic`、`llama.cpp`、`mock`，加上 least-cost/by-role 路由，已覆盖主流 OpenAI-compatible 端点。
- 缺原生 Gemini/Bedrock/Azure（可经 OpenAI-compatible 网关绕过）与 realtime/voice；这些是生态扩展，不是 coding harness 的核心准确率杠杆。
- 建议：需要多厂商时加**薄适配器**，不要引入 LiteLLM/大 SDK；realtime/voice 放 Hold。

---

## 4. 技术雷达（2026-10 检索快照）

| 层                 | 本项目现状                            | 前沿参考                                                                                                                                                                          | 判断                                         |
| ------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Agent loop/harness | 自有事件溯源 + turn/step/compaction   | OpenAI Agents SDK、Claude Agent SDK、LangGraph/Deep Agents                                                                                                                        | **Adopt 思想，不换内核**                     |
| 工具/数据协议      | MCP client v2（部分 server）          | [MCP 2026-07-28](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/changelog.mdx)                                    | **Adopt**（缓存/MRTR/订阅/iss/trace）        |
| Agent↔Agent        | A2A 最小 card/message/get             | [A2A 1.0](https://raw.githubusercontent.com/a2aproject/A2A/main/docs/specification.md)                                                                                            | **Trial**（stream/cancel/subscribe）         |
| Agent↔Editor       | 无                                    | [ACP v1](https://github.com/agentclientprotocol/agent-client-protocol)                                                                                                            | **Adopt**（Zed/编辑器入口）                  |
| Agent↔User         | 自有 SSE/RPC                          | [AG-UI](https://github.com/ag-ui-protocol/ag-ui)                                                                                                                                  | **Assess**（适配层，不重写前端）             |
| 上下文             | repo-map + BM25/混合 + 压缩           | [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)、[Context Rot](https://www.trychroma.com/research/context-rot) | **Adopt** 结构化进度 + 更少高信号 token      |
| 长任务             | compaction + plan/todo 工具           | [Anthropic long-running harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)                                                               | **Adopt** initializer/features/progress/init |
| 评测               | 短任务 A/B + LongMemEval 代理         | [Anthropic evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)、[Terminal-Bench](https://www.tbench.ai/)、[SWE-bench](https://www.swebench.com/)       | **Adopt 方法论，不追榜单**                   |
| 安全               | 审批/沙箱/provenance 字符串           | [OWASP LLM06](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)                                                                                                        | **Adopt** per-action auth + 工具哈希         |
| 记忆               | 文件记忆 + trust/decay/conflict       | [Mem0](https://github.com/mem0ai/mem0)、[Letta](https://github.com/letta-ai/letta)、[Zep](https://github.com/getzep/zep)                                                          | **Assess** 时间图/巩固                       |
| 沙箱               | policy + OS 可选                      | [E2B](https://github.com/e2b-dev/E2B)、[Daytona](https://github.com/daytonaio/daytona)、[microsandbox](https://github.com/microsandbox/microsandbox)                              | **Assess** Docker 可选，不默认               |
| 可观测             | OTLP spans/metrics + GenAI semconv    | [OTel GenAI semconv 1.44](https://opentelemetry.io/docs/specs/semconv/gen-ai/)                                                                                                    | **Adopt** MCP trace 传播                     |
| 模型               | OpenAI-compatible/Anthropic/llama.cpp | [OpenAI Agents SDK](https://github.com/openai/openai-agents-python)（sandbox/realtime/100+ providers）                                                                            | **Trial** 薄适配器；realtime Hold            |

> 外部资料是 2026-10 的公开检索快照；其中部分文章/榜单日期晚于本机时间线，只作为方向信号，不作为「本项目必须达到的数字」。不恢复已删除的官方跑分设施，也不追不可复现的头条分数。

---

## 5. 30 / 60 / 90 天建议

### 0–2 周（低成本、直接提升可测性）

- [ ] `probe:recall` 双镜头 + hybrid 回归判据（P0-1）
- [ ] `eval:long` 20 任务种子 + pass@1/pass^k + transcript（P0-2 第一片）
- [ ] MCP `ttlMs`/`cacheScope` + traceparent/baggage（P0-3 小切片）
- [ ] 工具列表变更哈希 + 重新审批（P1-3 小切片）

### 2–6 周（体验/互操作）

- [ ] ACP `acp` 子命令 + Zed 端到端
- [ ] A2A `message/stream` + `tasks/cancel` + `tasks/subscribe`
- [ ] initializer/features/progress/init.sh + PreCompletionChecklist
- [ ] MCP 服务端 MRTR + `subscriptions/listen`

### 6–12 周（战略项，按需）

- [ ] 完整 MCP 2026-07-28 server 兼容面
- [ ] per-action intent authorization + 签名审计
- [ ] Docker 沙箱适配器（可选）
- [ ] 记忆事实卡/时间图（只有在 LongMemEval 代理显示收益后）

---

## 6. 不应该做的事

- **不要为了「对齐前沿」引入 LangChain/OpenAI Agents SDK 作为运行时**：会破坏当前零运行时依赖、fail-closed、事件溯源与门禁体系；借模式即可。
- **不要恢复官方 SWE-bench/Terminal-Bench 榜单跑分**：项目已明确删除该设施，且外部头条数字不可复现；用内部 20–50 任务做可复核回归。
- **不要先做 microVM/自改代码/voice**：对当前 coding harness 的边际收益低，风险/成本高。
- **不要把「语义召回默认开」当成已完成**：没有 fallback 判据的默认开，等于把质量交给环境。
- **不要用生成式 `AGENTS.md`/长 prose 替代可执行门禁**：外部实践反复显示 prose 规则不等于约束；本项目已有增量门禁，继续用可执行脚本。

---

## 7. 本报告证据命令

```powershell
npm run test:fast                       # 619 files / 3794 tests
npm run test:integration                # 7/7 files / 17 tests
node tools/probes/recallHitrate.mjs     # 纯 BM25：44.0%
node tools/probes/semanticHybridRecall.mjs --fileK=30  # 混合：59.2%
npm run probe:exposure                  # 工具面 6167 token / plan 省 69.6–78.5%
npm run telemetry:sessions              # 真实会话缓存 95.9–97.5%
node --expose-gc .tmp/idxmem7.mjs       # 108.9 MB heap / 281 MB RSS
```

---

## 8. 诚实边界

- 语义混合 59.2% 依赖本机缓存的 `all-MiniLM-L6-v2` 权重与矢量缓存；CI 无权重时只能 skip，不能把 skip 当绿。
- 外部资料中的 benchmark 分数、框架能力与协议版本处于快速演进期；本报告只把它们当**设计信号**，不把任何外部数字移植为本项目承诺。
- 本报告没有改代码；所有建议都需要独立判据与 A/B，不以「看起来更先进」为由翻默认。
