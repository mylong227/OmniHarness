# 上游源码级差距审计（vs `D:\deepseek\codex` / `D:\deepseek\deepseek-harness`）

> **本篇与 `GAP_ANALYSIS_AND_PLAN.md` 的关系**：既有那篇基于 **2026-08 公开资料**（README/特性页）做能力对标；本篇基于 **本机真实源码树**逐目录通读（`codex/` 3394 个 `.rs`、`deepseek-harness/` 2682 个 `.ts`），定位到**文件与类型级**证据。两者互补：那篇定方向，本篇定实现细节与优先级。
>
> 审计时点：#75 落地后（2026-08-30）。

---

## 1. 先剔误报：这些「缺口」其实已具备

探查阶段曾把它们报成缺口，交叉核实源码后确认 **OmniHarness 已实现**，不应重复投资：

| 曾被报为缺口                  | 实际状态                                    | 证据                                                                                                                   |
| ----------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 上下文压缩 Compaction         | ✅ 已落地并接入主循环                       | `src/context/contextCompactor.ts`，由 `agent.ts:buildCompactor` 注入 `StepRunner`，默认 8000 token / 保留 6 条         |
| PTC 程序化工具调用 `run_code` | ✅ 已落地                                   | `src/code/codeExecutorTool.ts`、`src/code/codeInterpreter.ts`，已在默认工具集注册                                      |
| Skill 技能系统                | ✅ 已落地                                   | `src/skill/skillRegistry.ts`，`agent.ts:injectSkills` 按 prompt 命中注入                                               |
| `apply_patch` 补丁            | ✅ 已落地                                   | `src/adapters/tool/applyPatchTool.ts` + `patchApplier.ts`                                                              |
| 子代理委派（部分）            | ⚠️ 有 Worker 级委派，无 in-process 子 agent | `src/worker/workerOrchestrator.ts` + `src/adapters/tool/delegateTool.ts`（委派**外部** harness，非进程内 agent-graph） |

**教训（流程改进）**：此前给探查代理的「已实现清单」不完整，导致重复报缺。已把 **camelCase 模块清单 + 已落地能力**写进项目长期记忆，后续对标前先跑一次源码交叉核实再定任务。

---

## 2. 真实缺口（源码级证据）

### 高价值（建议优先）

| #   | 能力                                  | 价值                                                                                                                                                                                  | 上游归属      | 证据路径                                                                                                                                                                  |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **工具结果外溢 Spill**                | 一次大文件读取/海量 shell 输出即可撑爆上下文；先裁剪再压缩                                                                                                                            | DeepSeek 独有 | `deepseek-harness/packages/spill/spill/src/index.ts`、`spill-local/`、`spill-policy/`（`maxInlineBytes`）— **本轮 #75 已补齐** ✅                                         |
| G2  | **Subagent 进程内子智能体**           | 长任务分解、并发限流、父子树与深度限制；现仅能委派外部 CLI                                                                                                                            | 双方都有      | `codex/codex-rs/core/src/tools/handlers/multi_agents.rs`、`core/src/agent/registry.rs`；`deepseek-harness/packages/subagent/subagent/src/descriptor.ts`（多后端统一契约） |
| G3  | **运行时权限升级 + 沙箱违规重试**     | 命令被沙箱拒绝时识别原因并申请提权重试，而非直接失败 — 已由阶段 25 落地 ✅                                                                                                            | Codex 独有    | `codex/codex-rs/core/src/tools/handlers/request_permissions.rs`、`sandboxing/src/denial.rs`（`is_likely_sandbox_denied`）                                                 |
| G4  | **沙箱多后端 + 升级审批**             | 现仅 Windows RestrictedToken 一种 profile — 已由阶段 25 落地 ✅（SandboxManager 多后端 + EscalationPort 升级审批模型）                                                                | DeepSeek 独有 | `deepseek-harness/packages/sandbox/sandbox-local/src/profiles.ts`（bwrap/Landlock/seatbelt）、`sandbox/src/escalation.ts`                                                 |
| G5  | **Plan 计划模式 + todo + 结构化提问** | 长任务可审阅的计划协作态，缺模型面                                                                                                                                                    | DeepSeek 独有 | `packages/plan/plan-mode/src/types.ts`、`packages/todo/tool-todo/`、`packages/interaction/tool-ask-user/` → **已由 #77 落地**（见 roadmap 阶段 22）                       |
| G6  | **配置分层 + profile + 严格校验**     | 多层合并、profile 覆盖、key 别名归一化 — 已由阶段 26 落地 ✅（ConfigFile.loadLayered 分层合并 + ProfileLoader profile 覆盖 + configLayer 别名归一化与严格校验，零依赖、Node 20 兼容） | Codex 独有    | `codex/codex-rs/config/src/merge.rs`、`profile_toml.rs`、`strict_config.rs`                                                                                               |

### 中价值

| #   | 能力                                                                                                                    | 价值       | 证据路径                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | 工具语义检索（BM25），工具多时动态装载而非全量注入 schema                                                               | 省上下文   | `codex/codex-rs/core/src/tools/handlers/tool_search.rs`                                                                                                                                                                         |
| M2  | 会话检索（BM25 全文检索 + 跨会话 recall，零依赖复用 #M1 内核；**不引入 FTS5**，否则 node:sqlite 破坏 Node 20 兼容铁律） | 长会话回溯 | `deepseek-harness/packages/session-query/session-query-sqlite/src/schema.ts`（上游证据，吸收思路不改实现）                                                                                                                      |
| M3  | LSP 代码导航（definition/references/hover）                                                                             | 代码理解   | `packages/lsp/lsp/src/index.ts` — **已由阶段 32 落地 ✅**（外启语言服务器子进程 + LSP stdio JSON-RPC 桥接，`LspProcessAdapter`；零依赖铁律下不内嵌服务器，由用户自备）                                                          |
| M4  | 命令规范化与审批缓存（消除 `bash -lc` 包装差异）                                                                        | 审批命中率 | `codex/codex-rs/core/src/command_canonicalization.rs` — **已由阶段 27 落地 ✅**（`commandCanonicalizer.ts` + `CachedApproval`，默认关，开 `approvalCache`）                                                                     |
| M5  | 回合级变更追踪（unified diff，非 git）                                                                                  | 变更可观测 | `codex/codex-rs/core/src/turn_diff_tracker.rs` — **已由阶段 27 落地 ✅**（`unifiedDiff.ts` + `turnDiffTracker.ts` + `turnDiffHooks.ts`，默认开，可 `turnDiff:false` 关）                                                        |
| M6  | LLM 重试策略（指数退避 + 抖动 + Retry-After）                                                                           | 长任务鲁棒 | `deepseek-harness/packages/llm/llm/src/retry-policy.ts` — **重试策略已由阶段 27 落地 ✅**（`RetryingModel` + `ModelCallError`，默认关，开 `modelRetry`）；**成本计量 / 路由定价 / 硬预算已由阶段 29 落地 ✅**（见下方第 10 项） |

### 低价值 / 不适用

- **Starlark 命令策略引擎**（`codex/codex-rs/execpolicy/`）：需引入 Starlark 解释器，**违反「零运行时依赖」铁律**；若要吸收，应改自研极简 DSL 或纯 TS 规则树。
- **主机级网络出站策略 / MITM 代理**（`codex/codex-rs/network-proxy/`）：需 TLS 拦截与凭证代理，工程量大且 Windows 侧收益低。
- **Seatbelt / Landlock / bwrap**：现环境为 Windows，仅 Landlock 有跨平台价值（Linux 待办已在 roadmap）。
- **OAuth 设备码登录 / keyring**：仅接 ChatGPT 账号时需要。
- **TUI 全屏交互**：已有 Web 控制台。
- **Cordis「万物皆插件」范式本身**：属顶层架构替换，不可增量吸收（既有 `GAP_ANALYSIS_AND_PLAN.md` 已定调：吸收精髓，不引入其内核与品牌）。

---

## 3. 本轮已闭环：#75 Spill

| 项     | 内容                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增   | `src/ports/spill.ts`（端口）、`src/context/spillPolicy.ts`（纯策略）、`src/context/toolResultSpiller.ts`（外溢器）、`src/adapters/spill/{memorySpill,fileSpill}.ts`、`src/adapters/tool/spillReadTool.ts` |
| 接线   | `StepRunner` 在**钩子拿到完整结果之后、写入模型上下文之前**外溢（钩子/持久化无损，仅上下文被裁剪）；native 与 JS 两条路径共用                                                                             |
| 工具   | 默认工具集新增 `spill_read`（9 工具），且该工具**豁免外溢**，否则模型永远取不回全文                                                                                                                       |
| CLI    | `--spill-adapter memory\|file`、`--spill-bytes N`、`--spill-preview N`                                                                                                                                    |
| 默认值 | 超过 16 KB 触发，保留 2 KB 预览，落盘 `.omniharness/spill/`                                                                                                                                               |
| 验收   | 单测 11 项全过；Node 20 端到端实测（预览 4 字节 + 省略 18 字节 + 句柄落盘 22 字节 + 读回全文一致 + 目录穿越被拒）                                                                                         |

---

## 4. 建议推进顺序

> **进度**：第 1 项 G2 已于 #76 落地（见 `roadmap.md` 阶段 21），下表为剩余待补项。

1. ~~**G2 Subagent 进程内子智能体** — 与既有 `WorkerOrchestrator` 同层，可复用 `ToolGate` fail-closed 门禁；是所有长任务能力的地基。~~ ✅ **已完成（#76）**：`src/subagent/`（编排器 / 执行器 / 运行时工厂 / 事件桥 / 工具子集）+ `SubagentTool`；深度限制 + 并发限流 + 父子树；CLI `--subagent-max-depth|-concurrency|-max-steps`。
2. ~~**G5 Plan/todo/ask-user** — 模型面小、见效快，直接提升长任务可控性。~~ ✅ **已完成（#77）**：`UserResponder`/`TodoPort`/`PlanPort` 三端口 + `todo_write`/`ask_user`/`plan_write`+`plan_present`+`plan_read` 六工具 + `ToolGate` 计划态门禁（CLI `--plan`）；详见 roadmap 阶段 22。
3. ~~**M1 工具语义检索（BM25）** — 已由阶段 23 落地 ✅（见 `roadmap.md` 阶段 23）~~；~~**M2 会话检索（BM25 全文检索）** — 已由阶段 24 落地 ✅（见 `roadmap.md` 阶段 24；**用零依赖 BM25 替代 FTS5**，规避 node:sqlite 的 Node 20 兼容性断裂）~~。
4. ~~**G3/G4 沙箱升级审批** — 需先设计授权模型（与既有 #74 遗留的「`plugins.install` 需授权模型」是同一问题，可一并设计）。~~ ✅ **已完成（阶段 25）**：`SandboxManager` 多后端注册表（passthrough/policy/restricted + landlock/seatbelt/bwrap 本环境 fail-closed 占位）+ `EscalationPort` 三实现（deny/ask/auto）；`ToolGate` 沙箱拒绝时咨询升级审批，escalate 用 `elevatedSandbox` 复核放行、abort 拒绝（审批策略拒绝不升级，避免绕过既定策略）；`isLikelySandboxDenied`/`classifyDenial` 移植 codex `denial.rs`。详见 `roadmap.md` 阶段 25。
5. ~~**G6 配置分层 + profile + 严格校验** — 配置面尚小，但作为「分层合并 + profile 覆盖 + key 别名归一化 + 严格校验」基础设施，零依赖落地后任何新配置项自动获得多层能力。~~ ✅ **已完成（阶段 26）**：`ConfigFile.loadLayered`（用户级 → 项目级 → profile → 环境变量 四层合并）+ `ProfileLoader`（项目/用户级 profiles/ 查找）+ `configLayer`（`KEY_ALIASES` 下划线/连字符别名归一化、`ENV_MAP` 读 `OMNIHARNESS_*`、严格校验未知 key/枚举越界/类型错误 fail-closed）；CLI `--profile NAME`/`--config PATH`；非法配置非零退出。详见 `roadmap.md` 阶段 26。
6. ~~**M4 命令规范化 + 审批缓存**~~ ✅ **已完成（阶段 27）**：`commandCanonicalizer.ts` 去 `bash -lc`/`powershell -Command` 包装产出稳定 canonical；`CachedApproval` 以 canonical+cwd+策略指纹为键缓存审批决策（LRU、策略变化即失效、不持久化）；开 `approvalCache` 生效。详见 `roadmap.md` 阶段 27。
7. ~~**M5 回合级变更追踪**~~ ✅ **已完成（阶段 27）**：`unifiedDiff.ts`（零依赖 LCS 行级 diff）+ `turnDiffTracker.ts`（内存累积 write_file/apply_patch，不可精确追踪即 invalidate 本回合不产 diff）+ `turnDiffHooks.ts`（pre 读 baseline/post 记快照，仅追踪显式带 path 的写类工具）；`turn_diff` 事件默认广播。详见 `roadmap.md` 阶段 27。
8. ~~**M6 模型重试退避**~~ ✅ **已完成（阶段 27，仅重试策略部分）**：`RetryingModel` 装饰任意 `ModelPort`，指数退避 2^(n-1)×(1±10% 抖动) 封顶 15s，优先采用 Retry-After，不可重试（4xx）/达上限即上抛；`ModelCallError` 结构化错误（status/retryable/retryAfterMs）；开 `modelRetry` 生效。路由定价/用量投影（token-meter）暂未补（属成本计量，非重试同一范畴，留待后续）。详见 `roadmap.md` 阶段 27。
9. ~~**长期记忆 memories（跨会话持久 fact）**~~ ✅ **已完成（阶段 28）**：对标 codex 两阶段 LLM + git 版控，但落地为更轻的零依赖方案——`LongTermMemoryPort` + `FileLongTermMemory`（JSONL 落盘 `<workspace>/.omniharness/longterm/memory.jsonl`，进程重启重载、BM25 召回、跨会话持久）；`remember`/`recall` 两工具；`MemoryExtractor` 两阶段蒸馏（LLM 抽取 salient + 确定性去重合并）回合末由 `TurnRunner` 注入式调用（内部游标避免重复蒸馏）。与 #M2 `memory_search`（内存会话检索）本质区分：本能力存跨会话 durable fact，后者查"刚才聊了啥"。默认开，可 `memoryConsolidate:false` 关自动沉淀、`longTermMemory` 注入自定义实现。详见 `roadmap.md` 阶段 28。

> 暂缓：Starlark、网络代理、Cordis 范式替换（违反零依赖铁律或属架构级替换）；**其中长期记忆已于阶段 28 补齐、token-meter 成本硬预算已于阶段 29 补齐、goal/ralph 自主长循环已于阶段 30 补齐、agent-team/workflow DAG 已于阶段 31 补齐、LSP 代码导航已于阶段 32 补齐**。

10. ~~**token-meter 路由定价 + 成本硬预算（用量计量 / 熔断）**~~ ✅ **已完成（阶段 29）**：对标 dsh `packages/llm/token-meter`，但剥离其重度多模态图像定价抽象（违反零依赖铁律），只吸收「路由定价表 + 硬预算熔断」两个核心——`ModelOutput.usage` 新增 token 用量字段，`OpenAiCompatibleModel`/`ResponsesModel` 解析响应体 `usage`（prompt/completion/total）回填；`CostBudget`（零依赖进程内计量，按 `DEFAULT_ROUTE_PRICING` 路由定价累计 USD 成本，越 `costBudgetUsd` 硬上限即置位熔断）+ `BudgetedModel` 装饰器（fail-closed 包裹任意 `ModelPort`，调用前 `ensureWithin` 阻断、成功后按 usage 记账，与 `RetryingModel` 串联时居外层确保不重复记账、熔断优先于重试）；`budget_status` 工具让模型随时自查花费/剩余/是否已熔断；`costBudgetOnExceed:'warn'` 软预算仅观测不阻断。子代经 `SubagentPorts` 共享同一 `CostBudget` 实例（全局硬上限）。详见 `roadmap.md` 阶段 29。
11. ~~**goal/ralph 自主长循环**~~ ✅ **已完成（阶段 30）**：对标 dsh `goal`/`ralph`，落地为零依赖内部编排——`GoalChecker`（`parseAchieved` 保守判定） + `GoalRunner`（复用 `Agent` 主循环：`runTask` 首轮 + `resume` 续跑同会话，每轮判达成度，达成即停、否则续跑至 `goalMaxIterations` 上限，绝不无限循环）；模型面 `run_goal` 工具（隔离 runtime 视图、剔除 run_goal/subagent 防递归）；CLI `goal "<目标>"` 子命令；`goalMaxIterations` 配置项（默认 10，CLI/工具参数可覆盖）贯穿 `SubagentPorts`/`SubagentRuntimeFactory`。自动继承压缩/Spill/FFI 等既有能力，零重复实现、零新增运行时依赖。详见 `roadmap.md` 阶段 30。
12. ~~**agent-team / workflow DAG（多 agent 依赖编排）**~~ ✅ **已完成（阶段 31）**：对标 dsh `agent-team` / `workflow` DAG，落地为零依赖内部编排——`workflowTypes.ts`（`WorkflowDef`/`WorkflowStep`/`WorkflowResult`） + `workflowRunner.ts`：`computeLevels`（Kahn 拓扑分层，重复 id / 缺失依赖 / 成环 一律抛 `WorkflowCycleError` fail-closed） + `WorkflowRunner.run`（按层级调度、`ConcurrencyLimiter` 同层并发，默认 `DEFAULT_WORKFLOW_CONCURRENCY=4`，spec 的 `maxConcurrency` 优先；前序产出经 blackboard 注入后续 prompt；某步失败其全部下游 fail-closed 跳过，绝不静默续跑）；模型面 `run_workflow` 工具（隔离 runtime 视图、剔除 run_workflow/run_goal/subagent 防递归）+ CLI `workflow --file workflow.json` 子命令。每步实际执行仍交给 `Agent` 主循环，自动继承压缩/Spill/FFI，零重复实现、零新增运行时依赖。详见 `roadmap.md` 阶段 31。
13. ~~**LSP 代码导航（definition/references/hover）**~~ ✅ **已完成（阶段 32）**：对标 codex LSP stdio 桥接，落地为**外启用户自备语言服务器子进程 + LSP 协议（stdio JSON-RPC，Content-Length 分帧）**的进程级适配器——`ports/lsp.ts`（`LspPort`：坐标统一 1-based 编辑器约定，fail-closed）+ `adapters/lsp/lspProcess.ts`（`LspProcessAdapter`：initialize→initialized 握手、didOpen 同步、definition/references/hover、shutdown→exit；处理服务器通知与 server→client 请求；15s 超时 fail-closed；懒启动；**零依赖**仅用 `node:child_process`/`node:fs`/`node:url`；坐标 1-based↔0-based 内部转换）+ `adapters/tool/lspTools.ts`（`lsp_go_to_definition`/`lsp_find_references`/`lsp_hover`/`lsp_status` 四工具）+ CLI `lsp <definition|references|hover|status>` 子命令（`--lsp "server cmd"` 指定服务器，如 `typescript-language-server --stdio`）。**关键约束：绝不内嵌任何语言服务器**，服务器由用户自备——这是零依赖铁律下接入 LSP 的唯一合规方式。`tests/fixtures/mockLspServer.mjs` 提供进程级 JSON-RPC mock 供集成测与手动验证。详见 `roadmap.md` 阶段 32。
    - **真实服务器实证（2026-08-31 收尾）**：装 `typescript-language-server@4.3.0`（npmmirror 镜像把该包依赖元数据喂空导致只装顶层 1 包且 v6 是残包，最终用官方/镜像元数据均空的 4.3.0——其实它把 vscode-languageserver 等打进自身 dist 成单包自包含，故「added 1 package」即完整），外启真实 tsserver 跑通完整 LSP 生命周期：initialize→initialized→didOpen→definition/references/hover→shutdown/exit 全返回合法且坐标正确的 LSP 结构；并在缺 `typescript` 时正确 fail-closed 报错、补上后正常解析——证明桥的握手/生命周期/错误处理/坐标转换均对。注：`typescript-language-server` 对导入别名的 `definition`/`references` 默认返回别名位置（符合 LSP 规范），跨文件「跟随到目标」取决于语言服务器自身 project-loading 配置，属 server 端语义、非桥的能力缺口。复现：装 `typescript-language-server --stdio` 后 `omniharness lsp definition --file <某文件> --line N --col M --lsp "node <tls>/lib/cli.mjs --stdio"`。

> **剩余可移植缺口：已全部清零（3 项均已完成）**。删参考项目前需覆盖的 LSP / goal-ralph / agent-team DAG 三项可移植缺口已全部落地（阶段 30/31/32），另加阶段 28 长期记忆、阶段 29 成本硬预算、阶段 27 重试策略——**参考项目 `codex/` 与 `deepseek-harness/` 已于 2026-08-31 按用户铁律删除**（删除前整体备份于 `D:\deepseek\.ref-backup\codex` 与 `D:\deepseek\.ref-backup\deepseek-harness`，文件数核对一致：codex 6753/6753、dsh 8982/8982）。`D:\deepseek` 现仅余 `omniharness` 一个真实 harness 项目。
>
> **原设计性豁免 6 项中，3 项已按用户「直接搬参考能力」指令补齐（S33/S34/S35）；余 3 项仍属 OS/内核铁律豁免（见下）**：
>
> - ✅ **agent 密码学身份**（阶段 33）：已搬 codex-rs/agent-identity 可移植核心（见第 14 项）。
> - ✅ **Starlark 策略 DSL**（阶段 34）：已搬其「规则→决策」意图为零依赖安全子集求值器（见第 15 项）。
> - ✅ **TUI 富终端**（阶段 35）：已搬其「会话事件流渲染 + 交互」概念为零依赖 ANSI TUI（见第 16 项）。
> - 仍豁免（3 项）：native 沙箱 OS 级后端（landlock/seatbelt/bwrap，OS 绑定，Windows 仅 RestrictedToken 已在 Rust 内核 `crates/omni-core/src/restricted_token.rs`）、持久 PTY/terminal（OS PTY，需原生模块）、MITM 凭证代理（TLS 拦截 + 凭证代理，工程量大且 Windows 侧收益低）。这 3 项属环境/内核铁律豁免，不算欠账。

14. ~~**agent 密码学身份（Ed25519，对标 codex-rs/agent-identity 可移植核心）**~~ ✅ **已完成（阶段 33）**：不搬 OpenAI 注册/JWKS 平台绑定部分，只搬**可移植内核**——Ed25519 密钥对（PKCS#8 der base64 持久化）、ssh-ed25519 公钥编码、`agent_runtime_id:task_id:timestamp` 断言签名/验签（与参考 `authorization_header_for_agent_task` 同构）。`ports/agentIdentity.ts`（`AgentIdentityPort`：runtimeId/publicKeySsh/privateKeyPkcs8Base64/sign/verify/signAssertion/verifyAssertion/authorizationHeader，fail-closed）+ `adapters/identity/ed25519Identity.ts`（`Ed25519AgentIdentity`，**零依赖仅用 Node 内置 `node:crypto`**）+ `adapters/tool/agentIdentityTool.ts`（`agent_identity` 工具：show/sign/verify/sign_assertion/verify_assertion）+ config `agentIdentity?` 可选接线（配了才注册工具）+ CLI `identity <generate|show|sign|verify>` 子命令。可对任意会话产物签名、下游凭公钥验证「确由本 runtime 出具」。详见 `roadmap.md` 阶段 33。
15. ~~**Starlark 命令策略引擎（对标 codex-rs/execpolicy）**~~ ✅ **已完成（阶段 34，安全子集）**：不搬完整 Starlark 解释器（那是一个完整 Python 方言、需全语言解释器，违反零依赖铁律且过重），只搬其**可移植内核**——「事实(facts) + 规则(rules: 安全布尔表达式 → allow/deny/ask) → 决策」。`ports/policy.ts`（`PolicyPort`/`PolicyRule`/`PolicyDecision`）+ `adapters/policy/safePolicy.ts`（`SafePolicyEvaluator`：纯递归下降解析 + 求值，**零代码执行（绝无 eval/Function）**，运算符 `== != ~(正则) in(成员/子串) and or not 括号**；规则按顺序首命中生效、无命中用默认决策（默认 ask，可配 deny 更严）；表达式解析失败 fail-closed 跳过该规则绝不意外放行；未知标识符视为 false）+ `adapters/tool/policyEvalTool.ts`（`policy_eval`工具，始终注册，让模型可策略化审批决策）+ index 导出。用于把沙箱命令审批、工具调用审批「策略化、可审计」。详见`roadmap.md` 阶段 34。
16. ~~**TUI 全屏交互（对标 codex-rs/tui）**~~ ✅ **已完成（阶段 35，零依赖 ANSI 概念版）**：不搬 codex 的 288k 行 React 式组件树 / app-server 协议，只搬其**可移植内核**——「SessionEvent 渲染为带 ANSI 颜色的终端行 + 交互式读取输入」。`tui/render.ts`（纯函数：`renderEventLine`/`renderStatusLine`/`truncateToWidth`/`clearLine`/`prompt`，CJK 计 2 宽截断）+ `tui/interactive.ts`（`renderStream` 流渲染：`startInteractive` 用 Node 内置 `node:readline`/`node:tty` 启动交互会话，非 TTY 优雅降级）+ index 导出 + CLI `tui [demo]` 子命令（demo 用回声驱动演示事件流渲染）。零依赖。详见 `roadmap.md` 阶段 35。

---

## 6. 本轮新增：独立可用就绪（standalone-readiness，对标 codex CLI 即用性）

> 背景：引擎层能力（S21–S35）已对齐 codex/dsh，但「开箱即用」层面仍有 11 项短板——首次运行默认 mock/memory/silent、无位置参数、不读 `OPENAI_*`、缺 install 构建钩子、最终输出是原始 JSON、无 git 安全网。本阶段把 OmniHarness 补齐到「像 codex 一样装完即用」。仅触及 CLI 装配层，未触碰核心主循环。

| 项        | 短板                                                   | 抄自                             | 落地                                                                                                                                                                     |
| --------- | ------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1        | 安装不自动构建，bin 指向 dist 却无构建产物             | codex 的 `prepare`/`postinstall` | `package.json` 加 `"prepare": "tsc"`（npm install / link 即构建）                                                                                                        |
| G2        | 必须 `--prompt "x"`，不能 `omniharness "x"`            | codex/CLI 惯例                   | `parseArgs` 收集非旗标位置参数回退为 prompt；新增 `VALUE_FLAGS` 排除旗标值                                                                                               |
| G4/G5     | 不读 `OPENAI_*` 环境变量，每次都要手敲 key/url         | OpenAI CLI / codex               | `buildModel` 读 `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`（anthropic 同款），openai 默认 baseURL `https://api.openai.com/v1`                                     |
| G8/G9/G10 | 默认 memory/silent/auto → 首次跑不留痕、无进度、全放行 | codex 默认持久+可见              | `CliDefaults`：storageAdapter=jsonl（默认 `~/.omniharness/sessions`）、events=console、approval=rules、approvalAsk=allow；console 事件改走 stderr，stdout 仅输出最终答案 |
| G10       | 最终输出是 `JSON.stringify(summary)` 原始 JSON         | codex 干净 final text            | `run()` 输出 `result.finalText`；无 `--output` 时不向 stdout 倾倒事件 JSONL                                                                                              |
| —         | 缺可观测配置快照                                       | dsh `--dump-config`              | 新增 `--dump-config`（打印合并后生效配置并退出）                                                                                                                         |
| —         | 缺变更安全网                                           | Aider git auto-commit            | 新增 `--auto-commit`（执行后处于 git 仓库则自动 `git add -A` + commit，失败静默不破坏退出码）                                                                            |
| —         | 长会话上下文溢出无自动压缩兜底                         | OpenCode auto-compact            | 新增 `--context-window N`（按 75% 推导 compaction 预算，复用既有 Compactor，不触碰主循环）                                                                               |

**验证**：`tsc --noEmit` 通过；`node --test dist/tests/unit/cliSystem.test.js` 7/7（含 `doctor --model-adapter openai` 必须失败）；`npm run smoke` 全过；手动验证位置参数 prompt、stdout/stderr 分流、dump-config、`OPENAI_*` 回退均符合预期。

**零依赖铁律保持**：全部改动仅触及 CLI 装配层（`src/cli/exec.ts` / `src/adapters/event/consoleEventPort.ts` / `package.json`），未引入任何第三方运行时依赖、未触碰核心主循环、Node 20 兼容不变。
