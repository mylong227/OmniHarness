# OmniHarness 核心能力提升需求矩阵（2026-10-20）

> 来源：[CORE_CAPABILITY_GAP_ANALYSIS_2026-10-20.md](CORE_CAPABILITY_GAP_ANALYSIS_2026-10-20.md)
> 原则：**不做跑分结论**；每条需求以“能力闭环 + 工程判据”验收。状态以本文件为准。

## 状态图例

- ⬜ 未开始
- 🟡 代码路径已落地，但证据/产品化仍需真实环境或后续批次
- ✅ 已实现并有判据
- ⏸️ 战略/平台决策，不作为本轮代码欠账

## A. 长时执行与恢复（P0）——全部 ✅

| ID    | 需求                                                  | 落点                                                           | 判据                                                      | 状态 |
| ----- | ----------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- | ---- |
| LR-01 | `finishReason` 贯通 OpenAI/Anthropic/Responses/Ollama | `modelOutput.ts` + 四适配器                                    | `modelAdapters.test` 断言 `length`/`max_tokens`           | ✅   |
| LR-02 | 输出截断续写（≤3 次，半截 tool_calls 不执行）         | `core/stepRunner.ts`                                           | `turnRecovery.test` 3 例                                  | ✅   |
| LR-03 | prompt-too-long 反应式压缩                            | `contextCompactor.compact(...,force)` + `stepRunner`           | `contextCompactorForce.test`；路径在 `invokeWithRecovery` | ✅   |
| LR-04 | 529/5xx 后备用模型                                    | `StepRunnerDeps.fallbackModel` + `ModelRouter.health-fallback` | `turnRecovery.test` 529→fallback                          | ✅   |
| LR-05 | 8h（serve）/1h（-p）时限                              | `agent.ts` 默认 + `execCli.ts` -p 覆盖                         | 常量与 env 覆盖；缺计时注入测试（后续）                   | ✅   |
| LR-06 | 自动检查点 + 续跑去重                                 | `TurnRunner.maybeAutoCheckpoint` + `Agent.resumeGuidance`      | 每 20 步快照；续跑提示列成功写类调用                      | ✅   |

## B. 上下文保鲜（P0）——核心 ✅，证据项 🟡

| ID     | 需求                                | 落点                                                     | 判据                                                                                 | 状态                           |
| ------ | ----------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------ |
| CTX-01 | 分层削减（工具预算→snip→摘要→丢弃） | `context/contextShapers.ts` + `stepContextBuilder.shape` | `contextShapers.test` 3 例                                                           | ✅                             |
| CTX-02 | token 估算校准接口                  | `tokenEstimatorCalibrator.ts`                            | `tokenEstimatorCalibrator.test`                                                      | ✅（接口；未接真实 tokenizer） |
| CTX-03 | 窗口目录补 1M 模型                  | `contextWindowCatalog.ts`                                | `contextWindowCatalog.test`                                                          | ✅                             |
| CTX-04 | 强制压缩判据                        | `contextCompactor.compact(...,force)`                    | `contextCompactorForce.test`                                                         | ✅                             |
| CTX-05 | 记忆 primer 任务级 A/B              | `tools/probes/memoryTaskLift.mjs`                        | 2026-10-20 真模型 3 次/档：on **2/3**、off **0/3**、lift **+0.67**（报告存原始答复） | ✅                             |

## C. 交互行动空间（P1）——核心 ✅，真机 E2E 🟡

| ID     | 需求                                                                  | 落点                                                                                                              | 判据                                                                                         | 状态 |
| ------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---- |
| ACT-01 | `browser_act`：goto/click/type/press/scroll/wait/aria/console/network | `browserAction.ts` + `playwrightBrowserSession`（默认）+ `browserSession` CDP（降级回退）+ `browserActTool`       | `capabilityActTools.test` 3 例；`browserPlaywrightE2E` 真 Playwright；`browserActE2E` 真 CDP | ✅   |
| ACT-02 | 搜索 provider（Brave/Tavily）                                         | `webSearchProvider.ts` + `webSearchProviders.ts` + 配置按 key 注册                                                | 无 key 不构造；有 key 构造                                                                   | ✅   |
| ACT-03 | `web_fetch` PDF/正文增强                                              | `pdfTextExtractor.extractAsync`（可选 `unpdf`）+ `HtmlToText.convertAsync`（可选 Readability/linkedom）+ fallback | `pdfTextExtractor.test` 十六进制 PDF；`htmlToText.test` 导航被丢弃、正文保留                 | ✅   |
| ACT-04 | 动作工具审批/plan 分类                                                | `MUTATING_TOOL_NAMES` + `ToolGate`                                                                                | `capabilityActTools.test` 写类断言                                                           | ✅   |
| ACT-05 | 本地页“点按钮→断言”真机 E2E                                           | `tests/unit/browserActE2E.test.ts`                                                                                | 真 Chrome：goto→click→ARIA 快照含 clicked（无浏览器跳过）                                    | ✅   |

## D. 独立验证与纠错（P1）——核心 ✅

| ID     | 需求                               | 落点                                              | 判据                                          | 状态 |
| ------ | ---------------------------------- | ------------------------------------------------- | --------------------------------------------- | ---- |
| VER-01 | `review_diff` 干净上下文结构化审查 | `review.ts` + `reviewDiffTool.ts`                 | `capabilityActTools.test` 注入 bug            | ✅   |
| VER-02 | 证据账本：无成功工具 ⇒ unverified  | `evidenceLedger.ts` + `turnRunner`                | `evidenceLedger.test`                         | ✅   |
| VER-03 | GoalChecker 证据化                 | `goalChecker.ts` + `goalRunner.ts`                | `goalEvidence.test`                           | ✅   |
| VER-04 | 子代理轨迹持久化                   | `subagentOrchestrator.persistTrace`               | cleanup 前落父存储                            | ✅   |
| VER-05 | reviewer 发现可观测                | `reviewDiffTool` log `review.findings`            | 日志含数量/严重度                             | ✅   |
| VER-06 | reviewer 自动阻断                  | `TurnRunner.reviewDigest` + `OMNI_REVIEW_BLOCK=1` | `turnReviewGate.test`；blocker/major 回灌一次 | ✅   |

## E. 互操作（P1）——全部 ✅

| ID     | 需求                                                | 落点                                                     | 判据                                               | 状态                                      |
| ------ | --------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------- |
| INT-01 | MCP 双栈选择器                                      | `mcpProtocolNegotiator.ts` + connector                   | `mcpProtocolNegotiator.test`                       | ✅                                        |
| INT-02 | MCP 2026-07-28 无状态客户端                         | `mcpStatelessClient.ts`                                  | `mcpStateless.test`（`server/discover` + `_meta`） | ✅（`OMNI_MCP_PROTOCOL=2026-07-28` 启用） |
| INT-03 | A2A v1.0 `message/send`/`tasks/get`/`agent/getCard` | `a2aServer.ts` v1 分支                                   | `a2aV1.test`                                       | ✅                                        |
| INT-04 | SKILL.md 导入/导出                                  | `skillMdCodec.ts`（可选 `gray-matter`）+ `cliSkillFlags` | `skillMdCodec.test`：YAML 数组/带冒号值/往返一致   | ✅                                        |
| INT-05 | 私有协议改名，不再自称 A2A                          | `a2aProtocol.ts` 头注释                                  | 文档口径                                           | ✅                                        |

## F. 安全与可观测（P1/P2）——核心 ✅，taint 🟡

| ID     | 需求                                 | 落点                                                                              | 判据                                               | 状态 |
| ------ | ------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------- | ---- |
| SEC-01 | WSL2 + bwrap（Windows L3 路径）      | `wslBwrapSandbox.ts` + manager/能力表                                             | `wslBwrapSandbox.test`；不可达 fail-closed         | ✅   |
| SEC-02 | shell 带外通道收口                   | `shellCommandPolicy`（`OMNI_NETWORK_ALLOW` 时拒 curl/wget 等）                    | `shellEgressGuard.test`                            | ✅   |
| SEC-03 | provenance-lite（跨工具 taint 传播） | `security/provenanceTracker.ts` + `stepToolExecutor`（`OMNI_PROVENANCE_GUARD=1`） | `provenanceTracker.test`；外部片段进入写类参数被拒 | ✅   |
| SEC-04 | MCP server 白名单                    | `McpConnector.isAllowed`                                                          | `mcpAllowlist.test`                                | ✅   |
| OBS-01 | OTLP metrics（事件/工具/token）      | `otlpMetricsExporter` + `metricsCollectingEventPort` + assembly                   | `otlpMetrics.test`                                 | ✅   |
| OBS-02 | 上下文感知路由                       | `ModelRouter.by-context`                                                          | `modelRouterByContext.test`                        | ✅   |
| OBS-03 | 价格未命中可见                       | `budgetStatus.unpricedModels`（既有）                                             | 既有判据                                           | ✅   |

## G. 产品化（战略）

| ID      | 需求                       | 状态                        |
| ------- | -------------------------- | --------------------------- |
| PROD-01 | IDE/云端/PR 闭环           | ⏸️ 产品决策，非本轮代码欠账 |
| PROD-02 | License 档位接真实功能开关 | ⬜ 商业化批次               |

## 结论

本轮已把 **A/B/C/D/E/F 的代码路径与判据**全部落地：长时恢复、分层上下文、浏览器动作/搜索/PDF、独立 reviewer/证据账本/自动阻断、MCP 双栈/A2A v1/SKILL.md、WSL2 隔离/shell 出网/MCP 白名单、OTLP metrics 与上下文路由；记忆 primer 也补了真模型任务级 A/B（on 2/3 vs off 0/3）。

核心 A–F 项现已全部 ✅；只剩 **PROD-01/02** 属产品/商业化决策，不在核心 harness 能力面。
