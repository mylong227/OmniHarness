# OmniHarness 核心能力短板与提升路径（对比分析）

> **分析对象**：`D:\deepseek\omniharness`，`main` @ `e096a16d`（2026-10-20）
> **报告日期**：2026-10-20（Asia/Shanghai）
> **口径声明**：**本报告不做跑分结论，不引用任何榜单排名来评价本项目。** 对比的是“能力结构”——在同样的任务形态下，系统缺哪一层机制、这层机制如何补、补完用什么工程判据验收。外部基准只用于界定任务形态（多小时、多文件、交互式），不用于给本项目打分。
> **一句话结论**：OmniHarness 的工程底座已经很强，但核心能力仍有五个结构性缺口：**长时执行会断、上下文会失忆、交互环境摸不着、验证不独立、生态接不上**。下一步不是加引擎，而是把这五件事从“机制存在”提升到“能力闭环”。

---

## 0. 结论摘要

### 0.1 五个核心短板

| #   | 能力短板           | 现状（一句话）                                                                                 | 用户可见症状                                                   | 优先级 |
| --- | ------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------ |
| 1   | **长时执行与恢复** | 默认 60 分钟硬熔断；不识别输出截断；无 prompt-too-long 反应式压缩；不自动切模型；resume 需手动 | 跑几小时的任务被切断；截断被当成完成；崩溃后不知如何继续       | **P0** |
| 2   | **上下文保鲜**     | 只在 0.8×窗口做一次摘要压缩；token 估算 `CJK+其余/4`；窗口目录把 Claude 4.6 的 1M 记成 200k    | 长会话压缩后“失忆”、重复读文件；大窗口模型被过早压缩           | **P0** |
| 3   | **交互式行动空间** | 浏览器只有截图；`web_search` 默认不注册且无内置 provider；`web_fetch` 只做静态 HTML→文本       | 前端只能“看一眼”不能“点一下”；研究任务缺搜索入口               | **P1** |
| 4   | **独立验证与纠错** | 完成闸门强，但“审查者”只是提示词角色；目标循环用 LLM 判官；子代理轨迹不持久                    | 假完成、回归漏检、审计链在子代理处断掉                         | **P1** |
| 5   | **生态互操作**     | MCP 协议停在 `2025-11-25`；`a2a` 是私有方法名；技能是 JSON 内联而非 `SKILL.md` 目录            | 新 MCP server/client 接不上；第三方 A2A 零互操作；技能不可移植 | **P1** |

次级短板：**执行隔离仍是 L2**（shell 出网可绕过）、**记忆/进化默认关且增益未证**、**模型/成本路由初级**、**可观测性只到 trace**、**产品化仍是单机单用户**。它们重要，但不是当前“能不能把任务做成”的第一瓶颈。

### 0.2 三个真正的领先点

1. **fail-closed 的工程纪律**：架构、接线、文档、密钥、成熟度、标准增量、类型、Lint 全都有机械判据，且强调“判据必须能对已知坏输入变红”。这是同类开源项目里稀缺的。
2. **事件流单源 + 审计链 + 可回滚**：会话状态以事件流为唯一真相；追加落盘；检查点/回滚有三级对齐；审计有哈希链。这为“可复盘”提供了真实底座。
3. **签名资产包 + 能力协议**：Ed25519 非对称验签、安装流水线、信任-隔离阶梯、资产分级。这是比“插件市场”更底层的治理能力。

### 0.3 一句话建议

**90 天内只做两条主线：先把“长时执行 + 上下文”做成能跑通小时级任务的闭环；再把“浏览器动作 + 独立 reviewer”做成能验证前端/代码改动的闭环。** 生态互操作与 OS 级隔离排在其后；跑分、榜单、500 题评测都不做。

---

## 1. 评估口径

### 1.1 能力成熟度（C0–C4），不是跑分

| 层级   | 含义                   | 判据                                |
| ------ | ---------------------- | ----------------------------------- |
| **C0** | 缺失                   | 没有代码路径                        |
| **C1** | 有机制，未闭环         | 能跑通 demo，但缺关键分支/恢复/边界 |
| **C2** | 机制闭环，有单测       | 对已知坏输入能变红                  |
| **C3** | 能力闭环，有端到端验收 | 用户场景能稳定跑通（不要求跑分）    |
| **C4** | 生产级                 | 有遥测、SLO、回归趋势               |

**本报告的判断**：OmniHarness 多数核心能力在 **C2**；少数在 C1；没有一项达到稳定的 C3。这与“工程好不好”是两件事：C2 证明“机制在”，C3 证明“能力成”。

### 1.2 对比方法

- **仓内证据**：读码 + 跑探针 + 读项目自记（`PROJECT_BOARD.md`、`ARCHITECTURE_SPEC.md`、`LONG_SESSION_QUALITY_2026-10-20.md`）。
- **参照设计**：Claude Code（公开源码分析论文 + 官方文档）、Codex/OpenCode（公开仓库与文档）、OpenHands/Cognition（公开工程复盘）、MCP/A2A/AGENTS.md/Skills 规范。
- **对比单位是“能力层”**，不是“功能条数”。例如不比“谁的工具多”，而比“行动空间是否覆盖文件、终端、浏览器、搜索、GUI”。
- **不做的事**：不引用 SWE-bench/Terminal-Bench 的排名作为本项目结论；不把“单次跑分”当能力定论；不追求“比别人高几分”。

### 1.3 本次没有做什么

1. 没有重跑全量 `npm test`（看板记录 3,099 例，本次未复跑）。
2. 没有真实 API key 复跑 `smoke:model`（m2/m4 的数字来自看板与本地报告，属项目自记）。
3. 没有在 Linux/macOS 上实测沙箱；没有做渗透测试/红队。
4. 外部资料按原文引用，预印本/厂商自报均标注为“需复核”。

---

## 2. 能力对比矩阵

### 2.1 总表

> 判定口径：**领先** = 机制/治理明显强于参照；**持平** = 能力面相当，差异在实现；**落后** = 缺一层关键机制；**缺失** = 没有可用路径。参照对象取“公开可验证的设计”，不取厂商营销页。

| 能力          | OmniHarness 现状                                            | 参照设计                                                            | 判定                              | 优先级 |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------- | ------ |
| 主循环与编排  | 单 while + plan/todo/workflow + 目标循环；事件流单源        | Claude Code 单 while + 5 层上下文；Devin 显式规划；LangGraph 图编排 | **持平**                          | —      |
| 长时执行/恢复 | 60min 硬熔断；无截断续写/反应式压缩/自动 fallback           | Claude Code 5 层恢复；TB4 8h 任务形态                               | **落后**                          | **P0** |
| 上下文管理    | 单层 0.8×摘要 + 确定性台账；启发式 token；窗口目录漂移      | Claude Code 5 层压缩；Context Rot/LongMemEval 的实证                | **落后**                          | **P0** |
| 工具广度      | 50 个工具；写类/只读类单一来源；plan 暴露                   | Claude Code 最多 54 个；OpenCode 工具面                             | **持平**                          | —      |
| 行动空间      | 文件/终端/LSP/截图；无浏览器动作、无搜索 provider、无 GUI   | OpenHands/OSWorld 的浏览器与 computer-use；Claude Code 的搜索/抓取  | **落后**                          | **P1** |
| 代码智能      | `edit`/`apply_patch`/LSP/写后诊断；无 tree-sitter/索引      | Claude Code LSP/搜索；Aider repo-map；OpenCode LSP                  | **持平**                          | —      |
| 验证/纠错     | 完成闸门 + 零测试解析 + `unverified`；reviewer 只是角色     | Cognition 干净上下文 reviewer；MAST task verification               | **落后（独立评审）**              | **P1** |
| 多代理        | worktree 隔离 + 单写者 + 写集冲突串行；无 reviewer 回路     | Cognition 单写者 + 干净 reviewer；Claude Code sidechain             | **持平（隔离）/落后（评审）**     | **P1** |
| 记忆/学习     | 长期记忆 + 投毒闸 + primer（默认关）；进化 Kernel（默认关） | Mem0/Zep/LongMemEval 的机制；本仓 E2 探针不显著                     | **持平（机制）/落后（效果）**     | P2     |
| 安全/隔离     | 审批六档 + RBAC + 策略沙箱 + 注入 shadow；OS 级 L2          | Claude Code 7 权限模式 + 27 hooks + shell sandbox；OWASP ASI        | **领先（策略）/落后（OS 隔离）**  | P1     |
| 互操作        | MCP 2025-11-25；A2A 私有；Skills JSON；AGENTS.md 已读       | MCP 2026-07-28；A2A v1.0；SKILL.md；AGENTS.md 60k+                  | **落后**                          | **P1** |
| 模型/成本     | 5 适配器（含 mock）；轮询/最低成本/关键词路由；价格兜底     | Cognition smart-friend；多厂商路由                                  | **落后（路由）**                  | P2     |
| 可观测        | OTLP trace + GenAI semconv + 对账；无 metrics/logs          | GenAI semconv；OTLP metrics/logs                                    | **领先（trace）/落后（metrics）** | P2     |
| 产品化        | Web 工作台 + CLI；单机单用户；无 IDE/云端/PR 闭环           | Claude Code IDE/桌面/Web；Codex cloud；Devin 托管                   | **落后（战略）**                  | P2     |

### 2.2 三个“领先”的细节

1. **门禁与接线审计**：`runGates` 的 fast/typed 分层、架构方向、声明-接线、死链、密钥、成熟度、标准增量，且要求“仪器自证 / 变异测试”。参照项目里很少有把“声明必须接线”机器化的。
2. **事件流与审计**：追加通道、回卷、压缩游标复位、审计哈希链、只读 Trace 自省。这让“出了事能复盘”不是口号。
3. **签名资产包**：`.ohb` + Ed25519 非对称验签 + 安装预检 + 信任-隔离阶梯。这比“插件市场”更接近“可治理的扩展生态”。

### 2.3 三个“结构性落后”

1. **时间尺度**：系统按“分钟级回合”设计，参照系统按“小时级任务”设计。60 分钟硬熔断、无截断续写、无反应式压缩，都是时间尺度错配。
2. **行动尺度**：系统按“文件 + shell”设计，参照系统按“文件 + 终端 + 浏览器 + 搜索 + GUI”设计。截图不是交互。
3. **互操作尺度**：系统按“自己一套协议”设计，参照生态按“MCP/A2A/Skills 标准”设计。协议再优雅，接不上别人就是用不上。

---

## 3. 核心短板一：长时执行与恢复（P0）

### 3.1 目标能力

用户给一个“几小时级”的任务（跨多文件重构、长跑测试、批量迁移），系统应当：

- 不被默认时限硬切断；
- 输出被截断时**续写**，而不是把半截当完成；
- 上下文超窗时**反应式压缩**并重试，而不是 400 直接失败；
- 过载时**切模型**继续，而不是整回合失败；
- 崩溃/重启后**自动或一键续跑**，不重复已完成的写操作；
- 全过程有成本上限，不能“长时能力”变成“长时烧钱”。

### 3.2 现状与证据

| 项         | 现状                                                       | 证据                                                                                             |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 默认硬时限 | **60 分钟**                                                | [`agent.ts:40-41`](../src/core/agent.ts#L40-L41)                                                 |
| 输出截断   | 不识别 `finish_reason=length`；全仓无处理                  | 全仓 grep 无命中                                                                                 |
| 输出上限   | `maxOutputTokens` 未设时不发 `max_tokens`                  | [`stepRunner.ts:228`](../src/core/stepRunner.ts#L228)                                            |
| 上下文超窗 | 无 `prompt_too_long` / `context_length` 分支；400 不可重试 | 全仓 grep 无命中；[`retryingModel.ts:200-206`](../src/adapters/model/retryingModel.ts#L200-L206) |
| 过载切换   | 仅 `health-fallback` 显式配置时；默认单适配器              | [`modelRouter.ts:139-185`](../src/adapters/model/modelRouter.ts#L139-L185)                       |
| 续跑       | `Agent.resume` 有；需手动触发；服务端 `threads.continue`   | [`agent.ts:379-384`](../src/core/agent.ts#L379-L384)                                             |
| 自动检查点 | `checkpoint` 是手动工具；无每 N 步自动快照                 | [`toolNames.ts`](../src/ports/tool/toolNames.ts)                                                 |

**为什么会这样**：这些机制大多是在“分钟级回合”假设下长出来的。`RetryingModel` 解决“同一请求再发一次”，但没有“请求形态要变”的恢复层（更长输出、更短上下文、换模型）。`resume` 解决“进程重启”，但没有“回合内断点”。

### 3.3 参照设计

- **Claude Code 的 5 层恢复**（社区对 v2.1.88 源码的分析，C 级证据）：context collapse 排空 → reactive compact → max output 续写（64K，最多 3 次）→ 529 切 fallback model → 用户中断。核心不是“重试”，而是**按故障域分层、从便宜到贵**。
- **Terminal-Bench 4.0** 把所有任务的 agent timeout 统一到 **8 小时**；这代表“长任务”的时间尺度，而不是一个分数。
- **OpenCode 的教训**：输出截断后不续写，直接丢任务；Claude Code 会 re-prompt 续写。这说明“截断续写”是能力，不是优化项。

### 3.4 提升方案

**（1）把恢复做成状态机，而不是散落的 if**

新增 `TurnRecoveryPolicy`（core 层，纯逻辑）：

```
正常 → [finish_reason=length] → 续写（≤3 次）→ 正常
正常 → [400 prompt_too_long] → forceCompact → 重试 → 正常/失败
正常 → [529/5xx 连续 3 次] → fallback model → 重试 → 正常/失败
正常 → [取消/超时] → checkpoint → 退出（可 resume）
```

状态机要可注入时钟、可脚本化测试；每次恢复都记一条事件（`recovery.*`），让复盘能看到“这次为什么续写/压缩/切模型”。

**（2）适配器保留 `finish_reason`**

`ModelOutput` 增加 `finishReason`（`stop|length|tool_calls|content_filter|...`），OpenAI/Anthropic/Responses 适配器都填。`StepRunner` 在 `length` 时不把半截当最终答案，而是注入 “Output token limit hit. Resume directly…” 并重试同一请求；半截 `tool_calls` 不执行，先续写再解析。

**（3）反应式压缩**

`ContextCompactor` 增加 `forceCompact(reason)`：剥媒体 → 摘要 → 保留最近工具轮 → 重试。仅由 400 `prompt_too_long` 触发，不改变主动压缩路径。压缩后重试仍失败，才把错误上抛。

**（4）时限分层 + 成本闸**

- `serve`/headless 默认 8 小时硬限；`-p` 单次默认 1 小时；CLI `--deadline` 可调。
- 8 小时必须配 `CostBudget` 硬上限；到预算先 nudge 收尾，再熔断。
- 软时限仍 30 分钟，只注入“开始收尾”提示，不打断。

**（5）自动检查点与续跑**

- 每 20 步或每 10 分钟落一次轻量 `TurnCheckpoint`（事件序号 + 工作区 diff 指纹 + 未完成工具调用）。
- 进程重启后，`serve` 在 `threads.continue` 前检查 checkpoint：有未完成回合则注入“从断点继续”，并**跳过已成功的写类调用**（按 callId 去重）。
- 不自动重放有外部副作用的 shell 命令；只自动续跑“读/分析/写文件”类。

### 3.5 工程验收（不是跑分）

| 判据     | 做法                                             | 必须变红的反例               |
| -------- | ------------------------------------------------ | ---------------------------- |
| 截断续写 | 脚本模型返回 `finish_reason='length'` + 半截文本 | 不续写 / 把半截当最终答案    |
| 超窗恢复 | 脚本模型第一次返回 400 `prompt_too_long`         | 不触发 `forceCompact`        |
| 过载切换 | 脚本模型 529 三次后 fallback 成功                | 不切模型 / 静默降级 mock     |
| 时限分层 | 注入时钟推进 8 小时                              | `serve` 默认硬停 / `-p` 不停 |
| 崩溃续跑 | kill 进程后 `threads.continue`                   | 重复写类调用 / 丢 checkpoint |
| 成本闸   | 预算耗尽                                         | 继续无限调用                 |

> 这些是**能力验收**，不是“跑分”：它们验证“这条能力路径是否存在且可靠”，不比较“谁高几分”。

### 3.6 风险与边界

- 8 小时默认会放大成本；必须有预算闸，且默认只对 `serve`/headless 放开。
- 自动续跑不能重放不可逆的外部副作用；写类调用按 callId 去重，shell 类默认不自动重放。
- 截断续写最多 3 次；超过说明模型无法在给定空间内完成，应报错而不是无限续写。

---

## 4. 核心短板二：上下文保鲜（P0）

### 4.1 目标能力

长会话（几十万 token、几十轮工具调用）在压缩后仍能：

- 记住任务目标、已改文件、已跑命令、失败原因；
- 不重复读同一个文件、不重复跑同一个命令；
- 不因压缩而丢失“刚读到的关键行”；
- 在 1M 窗口模型上不提前压缩，在 128k 模型上不越窗；
- 压缩成本可计量（摘要调用 + 丢失信息）。

### 4.2 现状与证据

| 项          | 现状                                               | 证据                                                                                      |
| ----------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 压缩层数    | **单层**：0.8×窗口一次摘要 + 最近消息 + 台账       | [`contextCompactor.ts:191-196`](../src/context/contextCompactor.ts#L191-L196)、`:354-363` |
| token 估算  | `ceil(cjk + other/4)`                              | [`tokenEstimator.ts:215`](../src/context/tokenEstimator.ts#L215)                          |
| 窗口目录    | `claude-4` 一律 200k；未识别模型 128k              | [`contextWindowCatalog.ts:18-48`](../src/context/contextWindowCatalog.ts#L18-L48)         |
| 压缩后质量  | 单测验“压缩发生/游标对/台账在”，不验“任务还能继续” | `contextCompactor.test.ts`                                                                |
| 记忆 primer | 默认关，`OMNI_MEMORY_PRIMER=1` 才注入              | [`sessionInjector.ts:88-94`](../src/core/sessionInjector.ts#L88-L94)                      |

**已有的亮点**：压缩摘要带**确定性工具台账**（已读文件/已跑命令/失败次数），这是防止“压缩后重新探索”的正确方向；`LONG_SESSION_QUALITY` 也复盘过 pre-fix 的 137 次冗余结果。问题不是“没做”，而是“只有一层 + 没有质量判据”。

### 4.3 参照设计

- **Claude Code 五层压缩**（每次模型调用前）：budget reduction → snip → microcompact → context collapse → auto-compact；越便宜的先跑。这不是“更复杂的摘要”，而是**按信息类型分层削减**。
- **Context Rot / LongMemEval**：输入越长，模型越不稳；全量历史相对聚焦历史会显著掉分。结论是“压缩不是越少越好，而是要在正确的层、用正确的粒度、保住任务状态”。

### 4.4 提升方案

**（1）分层削减（从便宜到贵）**

| 层              | 做什么                                          | 触发           | 代价       |
| --------------- | ----------------------------------------------- | -------------- | ---------- |
| L1 工具结果预算 | 超长工具输出外溢/截断预览                       | 单条 > N token | 极低       |
| L2 旧轮次 snip  | 折叠较早的、已完成且无后续引用的轮次            | 上下文 > 60%   | 低         |
| L3 微压缩       | 只压 reasoning / 长工具输出，保留工具调用与结论 | 上下文 > 70%   | 低         |
| L4 摘要压缩     | 结构化摘要 + 工具台账                           | 上下文 > 80%   | 中         |
| L5 最后丢弃     | 摘要 + 最近消息仍超预算时丢最旧                 | 仍超           | 高（有损） |

每层都记 `{layer, before, after, dropped}` 事件；关闭任一层，验收必须能看出差异。

**（2）token 估算校准**

保留启发式快路径；用真实 tokenizer 对固定语料做离线校准，记录 median/p90 误差；误差超阈值时用保守系数。不要为了“精确”引入重依赖；校准数据入库，校准脚本离线跑。

**（3）窗口目录数据化**

把 `ContextWindowCatalog` 从硬编码表改为数据文件（可测试、可更新）；至少覆盖 Claude 4.6 1M、GPT-5 系列、DeepSeek 128k、Qwen 等；未识别模型明确告警，不静默按 128k。

**（4）压缩后任务保持率**

在固定任务集上做“压缩前/压缩后”对照：同一任务，强制在中间触发压缩，看最终是否仍完成、是否重复读同一文件、是否重复跑同一命令。这不是跑分，是**能力回归**。

**（5）记忆 primer 的 A/B**

在真实任务上开/关 primer，测任务完成率、重复探索次数、回灌 token；没有增益就保持默认关，并在文档写清“这是有意的默认关”，而不是“待办”。

### 4.5 工程验收

- token 估算 p90 误差 ≤ 10%，median ≤ 5%；超阈即红。
- 压缩后任务保持率不低于不压缩基线的 5 个百分点（固定任务集，3 次重复）。
- Claude 4.6 窗口目录 = 1M；未识别模型告警可见。
- 分层削减每层有触发/未触发计数；删掉任一层，回归能看出差异。

### 4.6 风险与边界

- 分层越多，维护面越大；先做 L1/L2/L4 三层，L3/L5 后置。
- 压缩质量不能只靠“摘要看起来不错”；必须有任务保持率判据。
- 1M 窗口不等于“不用压缩”；Context Rot 说明长上下文本身会降智，压缩仍是必要的。

---

## 5. 核心短板三：交互式行动空间（P1）

### 5.1 目标能力

系统能像人一样操作一个界面：

- 打开页面、点击、输入、滚动、等待、读 ARIA/DOM、看 console/network；
- 搜索网络并抓取正文（含 JS 渲染页、PDF）；
- 在前端任务里“改代码 → 打开页面 → 点按钮 → 断言变化”闭环；
- 在研究任务里“搜索 → 打开多个结果 → 提炼”。

### 5.2 现状与证据

| 项     | 现状                                                                                    | 证据                                                                                                |
| ------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 浏览器 | 只有 `browser_screenshot`（URL/尺寸/等待/整页），无点击/输入/滚动/ARIA                  | [`browserScreenshotTool.ts:90-123`](../src/adapters/tool/browser/browserScreenshotTool.ts#L90-L123) |
| 搜索   | `web_search` 默认不注册；无内置 provider；需注入 `search` 函数                          | [`configToolRegistry.ts:38`](../src/config/configToolRegistry.ts#L38)                               |
| 抓取   | `web_fetch` 默认注册，但只是 `fetch + HTML→text`；不执行 JS、无 readability、不解析 PDF | [`webFetchTool.ts`](../src/adapters/tool/web/webFetchTool.ts)                                       |
| GUI    | 无 mouse/keyboard/screen/window 动作                                                    | 工具表无对应工具                                                                                    |

### 5.3 参照设计

- **OpenHands / OSWorld**：浏览器/computer-use 是独立行动空间，不是“截图工具”；长时 GUI 任务的失败面主要在状态跟踪与验证。
- **Claude Code**：搜索/抓取 + 文件/终端 + 技能；它的“工具面”不是最多的，但覆盖了编码任务的主要行动。
- **Cognition**：干净上下文 reviewer 与“smart friend”说明，行动空间之外还需要“验证/求助”通道。

### 5.4 提升方案

**（1）`browser_act`（CDP，不引 Playwright）**

复用现有 `cdpClient` / `browserSession`，新增动作：

- `click(selector | x,y)`、`type(selector, text)`、`press(key)`、`scroll(dx,dy)`、`wait_for(selector|text|timeout)`；
- `aria_snapshot()`：返回可访问性树（比整页 HTML 更适合模型）；
- `console()` / `network()`：返回错误与失败请求（前端调试的关键信号）。

安全：所有动作走审批；`aria_snapshot` 只读可放行；`click/type` 属外部副作用，默认 ask。工具进入 `MUTATING_TOOL_NAMES` 或明确的“外部副作用”分类，plan 模式拦截。

**（2）搜索 provider**

新增 `WebSearchProvider` 端口 + Brave/Tavily/Exa 适配器；有 key 时自动注册 `web_search`，无 key 时不注册（fail-closed，避免模型反复撞墙）。搜索结果带 URL/摘要/时间；不要伪造“搜索成功”。

**（3）`web_fetch` 增强**

readability 提取正文、PDF 文本、JSON 原样；不执行 JS（JS 渲染交给 browser）；保留字节/超时上限。

**（4）验收**

本地静态页 + 按钮：脚本模型执行“打开 → 点按钮 → 断言文本变化”；离线可跑，不需要外网。搜索用 mock provider 测“有 key/无 key”两条路径。

### 5.5 工程验收

- `browser_act` 的 click/type 在本地页面上改变 DOM，`aria_snapshot` 能读到变化；无浏览器时 fail-closed（不是 skip）。
- `web_search` 无 key 时不在工具清单；有 key 时能返回 ≥1 条结果（mock provider 离线测）。
- 动作工具的审批/plan 行为有判据；`package.json` 运行时不增加 Playwright/Puppeteer。
- `web_fetch` 对一份 JS 渲染页返回“需要浏览器”的可行动提示，而不是空正文。

### 5.6 风险与边界

- 浏览器动作是外部副作用，必须审批；不要让模型无审批地点击生产系统。
- CDP 动作在不同 Chrome 版本上可能有差异；用本地固定版本做判据，不承诺跨版本全兼容。
- 搜索 provider 会引入 key 与外部依赖；保持“无 key 不注册”，不破坏离线可用。

---

## 6. 核心短板四：独立验证与纠错（P1）

### 6.1 目标能力

系统在“模型说完成”之外，还有一条独立验证链：

- 一个**干净上下文**的 reviewer 只看 diff + 任务目标 + 测试结果，能报出边界/回归/安全问题；
- reviewer 的建议有证据（file:line、触发条件、影响），不是“我觉得”；
- 完成判定有证据（测试输出/文件/命令），不是 LLM 判官一句 YES；
- 子代理做过什么，事后能查（轨迹持久化）；
- 验证是**advisory + 可选阻断**，不误杀正常任务。

### 6.2 现状与证据

| 项         | 现状                                                  | 证据                                                                                                                                                           |
| ---------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完成闸门   | 强：回合结束跑验证；零测试拦截；`unverified` 一等状态 | [`turnEndCompletionGate.ts:100-119`](../src/adapters/tool/verify/turnEndCompletionGate.ts#L100-L119)                                                           |
| Reviewer   | 只是提示词角色；不是独立进程/工具集                   | [`agentPersonas.ts:1-12`](../src/subagent/agentPersonas.ts#L1-L12)                                                                                             |
| 目标判定   | `GoalChecker` 用模型 YES/NO                           | [`goalChecker.ts`](../src/autonomy/goalChecker.ts)                                                                                                             |
| 子代理轨迹 | 内存 bridge；storage 在 worktree 内，cleanup 删除     | [`subagentEventBridge.ts`](../src/subagent/subagentEventBridge.ts)、[`subagentRuntimeFactory.ts:122-135`](../src/subagent/subagentRuntimeFactory.ts#L122-L135) |

**已有的亮点**：完成闸门是全仓最接近 C3 的机制；它不是“让模型自评”，而是跑命令、解析 TAP、区分零测试。问题在于：它只覆盖“用户配的那条测试”，不覆盖“diff 里还有什么问题”；reviewer 只是角色，不是机制。

### 6.3 参照设计

- **Cognition 的干净上下文 reviewer**：平均每 PR 抓 2 个 bug，58% 严重；关键是 reviewer **不共享 coding agent 的上下文**，只看 diff，从实现反推规格。
- **MAST 的失败分类**：task verification 是三大失败类之一；说明“验证”不是附属品，是能力。

### 6.4 提升方案

**（1）Reviewer 子代理**

新增 `subagent` 的 `mode: 'review'`（或独立 `review_diff` 工具）：

- 输入：`diff`（必需）+ 任务目标 + 相关测试结果 + 可选相关文件片段；
- **不输入**：父会话完整历史、模型自己的“完成宣言”；
- 输出：结构化 `{severity, file, line, issue, evidence, suggestion}`；
- 默认只读，不写；reviewer 不直接改代码，保持单写者。

**（2）证据账本（Evidence Ledger）**

每个回合维护一份 `EvidenceLedger`：

```
- 改了哪些文件（diff 指纹）
- 跑了哪些命令（命令 + exit code + 测试计数）
- 哪些测试通过/失败（TAP 摘要）
- 哪些验收判据被满足（文件存在/输出匹配）
```

完成判定只看账本：没有证据的“完成”降为 `unverified`；LLM judge 只做 advisory，不做最终裁决。

**（3）测试合成（可选）**

reviewer 可以提出“缺哪个测试”，由主代理或独立 runner 执行；不要直接让 reviewer 改代码。测试合成是“建议”，不是“自动写测试并信任”。

**（4）子代理轨迹持久化**

子代结束前把 `bridge.events()` 追加进父存储（不广播），或写到 `reports/subagents/<id>.jsonl`；`--session <childId>` 可读。worktree 清理后仍可读。

**（5）验收**

注入一个已知边界 bug（如 `sort` 原地修改入参），reviewer 必须在 `severity>=major` 报出并给 file:line；reviewer 输入里不得出现父会话完整历史；子代理结束后轨迹可读。

### 6.5 工程验收

- 注入 bug 被 reviewer 抓到；未报即红。
- reviewer 输入结构判据：不含父历史标记；只含 diff/目标/测试。
- 子代理轨迹在 cleanup 后可读；至少 1 条事件。
- `GoalChecker` 无证据 YES 时，`verificationState` 不能是 `passed`。
- reviewer 误报率可观测（记录 suggestion 被采纳/驳回），但不作为硬门槛。

### 6.6 风险与边界

- reviewer 会误报；默认 advisory，不直接阻断；高风险（安全/数据）可配置为阻断。
- reviewer 也消耗 token；只对“有 diff 的回合”触发，纯问答不触发。
- 不要让 reviewer 拿到父历史，否则会变成“再问模型一遍”，失去独立性。

---

## 7. 核心短板五：生态互操作（P1）

### 7.1 目标能力

- 能连上按最新 MCP 规范实现的 server/client；
- 能被第三方 A2A agent 委托，也能委托出去；
- 能直接吃 `SKILL.md` 目录，也能导出；
- 能读 `AGENTS.md`（已支持）。

### 7.2 现状与证据

| 项        | 现状                                          | 证据                                                              |
| --------- | --------------------------------------------- | ----------------------------------------------------------------- |
| MCP       | SDK 协议 `2025-11-25`；规范已到 `2026-07-28`  | `node_modules/@modelcontextprotocol/sdk/.../types.js`             |
| A2A       | 私有 `capabilities.declare` / `task.delegate` | [`a2aProtocol.ts:13-16`](../src/a2a/a2aProtocol.ts#L13-L16)       |
| Skills    | JSON 内联 `instructions`；无目录/资源/脚本    | [`skill.ts:10-29`](../src/ports/skill/skill.ts#L10-L29)           |
| AGENTS.md | 已读，支持 `@import`                          | [`projectInstructions.ts`](../src/context/projectInstructions.ts) |

### 7.3 参照设计

- **MCP 2026-07-28**：无状态、`server/discover`、MRTR、tasks 扩展、`resultType`、`ttlMs`/`cacheScope`、确定性 `tools/list`。这是破坏性修订，不能“顺手升级”。
- **A2A v1.0**：`message/send`、`tasks/*`、`AgentCard` 发现、push config、三种绑定。
- **Agent Skills**：`SKILL.md` 目录 + 渐进披露 + 资源/脚本。
- **AGENTS.md**：60k+ 项目，就近文件优先；本项目已对齐。

### 7.4 提升方案

**（1）MCP 双栈**

保留 2025-11-25 作为默认（稳定、已有判据），新增 2026-07-28 适配器（无状态 + `server/discover` + MRTR + `resultType` + `ttlMs`），按 server 能力协商。不是一次性重写，而是**两个 transport/protocol 适配器 + 一个协商器**。

**（2）A2A v1.0 适配器**

实现 `message/send`、`tasks/get`、`tasks/cancel`、`AgentCard`；保留私有协议作为内部委托通道，但文档改名为“私有 JSON-RPC 委托”，不再自称 A2A。

**（3）Skills 导入/导出**

支持 `SKILL.md` 目录 → `Skill` 的导入（name/description/instructions + 资源清单），支持反向导出；渐进披露先做“按需读资源”，不做全自动。

**（4）验收**

用官方 MCP SDK 的 2026-07-28 client 连本仓 `mcp serve`，`server/discover` + `tools/list` 成功；用 2025-11-25 client 也成功（双栈）。用官方 A2A SDK 的 `message/send` 委托一个任务；`SKILL.md` 导入后能被 `selectForPrompt` 命中。

### 7.5 工程验收

- MCP 双栈：两版官方 client 各一条端到端判据。
- A2A：官方 SDK 的 `message/send` 返回 Task；私有 `task.delegate` 仍可用。
- Skills：导入/导出结构判据；资源按需读取。
- 文档：不再把私有协议称为 A2A；registry 明确标“占位”。

### 7.6 风险与边界

- 双栈维护成本高；先做 client 侧，再做 server 侧。
- 新 MCP 规范还在演进；不要一次性重写，保留旧栈回退。
- A2A 采用度仍在增长；先做“能被委托/能委托”的最小面，不做全量。

---

## 8. 次级短板（P1/P2）

### 8.1 执行隔离仍是 L2

- 默认 `policy` 是 TS 策略；`restricted` 在 Windows 上 restricting-SID 计数为 0；出网守卫只覆盖 `globalThis.fetch`，shell 子进程可绕过（[`networkEgressGuard.ts:39-48`](../src/adapters/sandbox/networkEgressGuard.ts#L39-L48)）。
- 注入防护 CLI 默认 `shadow`，`ConfigFactory` 仍 `off`；没有数据/控制流分离或能力标签。
- **提升**：Windows AppContainer + DACL 或 WSL2 + bwrap；OS 级出网；provenance-lite（工具输出 trust 标签 + 写类/出网类参数来源检查）；MCP server 白名单/版本 pin。
- **验收**：`policy` 档下 `curl` 被拒；AppContainer/WSL2 下读 `~/.ssh` 被拒、工作区可写；ACL 快照前后一致。

### 8.2 记忆/学习：机制有，效果未证

- 记忆 primer 默认关；进化 Kernel 默认关；E2 探针“不显著”。这不是“没做”，而是“没有任务级增益证据”。
- **提升**：primer 开/关 A/B（任务完成率/重复探索/回灌 token）；记忆检索从“重要度 top-5”改为“相关性 + 时效 + 冲突替代”；进化环先修“候选搜索宽度”再谈晋升。
- **验收**：primer 有增益才默认开；没有增益就保持关，并在文档写清边界。

### 8.3 模型/成本路由与可观测

- 5 个适配器（含 mock）；路由是轮询/最低成本/关键词；无能力/上下文长度/预算路由；价格未命中走兜底。
- 有 OTLP trace，但无 metrics/logs；无任务质量指标。
- **提升**：路由输入加 `contextTokens/taskType/budgetRemaining/latencyTarget`；补 1 个非 OpenAI 兼容 provider；价格未命中告警；OTLP metrics（token/tool error/compaction/turn duration/task outcome）。
- **验收**：路由决策可解释（log reason）；`budget_status` 显示 `priceSource`；一次回合至少 5 个指标并与账目对账。

### 8.4 产品化（战略，不是当前瓶颈）

单机单用户、无 IDE/云端/PR 闭环；License 已落地但档位未接真实功能开关；registry 占位。如果目标是本地可信 harness，这是合理取舍；如果目标是团队/商业版，这是下一阶段的事，不应与 P0/P1 混在一起。

---

## 9. 根因：为什么这些短板会同时存在

| 根因                   | 表现                                    | 影响                |
| ---------------------- | --------------------------------------- | ------------------- |
| **分钟级回合假设**     | 60min 硬限、无截断续写、无反应式压缩    | 长任务不可达        |
| **单层上下文设计**     | 0.8×摘要 + 启发式 token                 | 长会话失忆/越窗     |
| **文件+终端行动假设**  | 截图不是交互；搜索未接 provider         | 前端/研究任务不可达 |
| **机制优先的验证传统** | 单测/门禁强；独立评审/证据账本弱        | 假完成/回归漏检     |
| **自建协议优先**       | MCP 旧一修订；A2A 私有；Skills JSON     | 生态接不上          |
| **单机单模型**         | 所有真机结论来自一台 Windows + DeepSeek | 跨平台/跨厂商未验证 |

> 这些不是“能力不够聪明”，而是“能力的时间尺度、行动尺度、互操作尺度”与目标不匹配。提升的方向不是加一个更复杂的引擎，而是**把这三个尺度补上**。

---

## 10. 提升路线图（能力轨道，不是跑分）

### 10.1 三条主线

| 轨道                              | 目标能力                     | 关键交付                                                                             | 验收                                    |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------- |
| **A. 执行耐力**（第 1–4 周）      | 小时级任务不断               | 8h 时限分层、`finish_reason` 续写、`forceCompact`、fallback、自动 checkpoint、成本闸 | 脚本模型 5 条恢复判据；崩溃续跑不重复写 |
| **B. 上下文保鲜**（第 3–6 周）    | 长会话不失忆                 | 分层削减 L1/L2/L4、token 校准、窗口目录、压缩后任务保持率                            | 估算误差；压缩后完成率；目录测试        |
| **C. 交互行动**（第 5–8 周）      | 前端/研究闭环                | `browser_act`（CDP）、搜索 provider、`web_fetch` 增强                                | 本地点按钮 E2E；无 key 不注册           |
| **D. 独立验证**（第 6–9 周）      | 假完成/回归漏检下降          | reviewer 子代理、证据账本、子代理轨迹持久化                                          | 注入 bug 被抓；轨迹可读                 |
| **E. 互操作与隔离**（第 8–12 周） | 接得上生态、扛得住不可信扩展 | MCP 双栈、A2A v1.0、SKILL.md、AppContainer/WSL2、OS 级出网                           | 官方 SDK 互通；`curl` 带外被拒          |

### 10.2 90 天节奏

- **第 1–2 周**：恢复状态机骨架 + `finish_reason` + 8h 分层 + 成本闸；先把“断”修掉。
- **第 3–4 周**：`forceCompact` + fallback + 自动 checkpoint；跑通一个 2 小时级真实任务。
- **第 5–6 周**：分层削减 L1/L2/L4 + token 校准 + 窗口目录；压缩后任务保持率。
- **第 7–8 周**：`browser_act` + 搜索 provider + `web_fetch`；前端 E2E。
- **第 9–10 周**：reviewer + 证据账本 + 轨迹持久化；注入 bug 验收。
- **第 11–12 周**：MCP 双栈 + A2A v1.0 + SKILL.md；安全隔离（AppContainer/WSL2）作为并行线。

### 10.3 成功标准（能力口径）

1. **长时**：默认 8 小时内不被硬停；截断/超窗/过载三类恢复都有判据。
2. **上下文**：压缩后任务保持率非劣；token 估算误差可控；1M 模型不提前压缩。
3. **交互**：前端任务能“点按钮 → 断言变化”；研究任务能“搜 → 读”。
4. **验证**：reviewer 能独立抓到一个注入 bug；子代理轨迹可读。
5. **互操作**：MCP 2026-07-28 与 A2A v1.0 各有一条官方 SDK 互通判据。
6. **隔离**：`curl` 带外被拒；L2 边界在 `doctor` 里如实可见。

> 这些标准都是“能力是否闭环”，不是“分数是否更高”。

---

## 11. 不做什么

| 不做                                  | 为什么                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| 跑分/榜单/500 题评测结论              | 本报告的目标是能力提升；harness 对通过率的影响常小于噪声，跑分不适合作为能力结论 |
| 为“功能条数”加工具                    | 50 个工具已经够多；缺的是行动空间的关键一类（浏览器/搜索），不是数量             |
| 一次性重写 MCP 2026-07-28             | 破坏性修订；双栈 + 协商更稳                                                      |
| 为浏览器动作引入 Playwright/Puppeteer | 现有 CDP 够用；新依赖破坏运行时极简                                              |
| 引入向量数据库/图数据库               | 仓内已自证收益上限低；不是当前瓶颈                                               |
| 继续把记账/算子下沉 Rust              | 已实测反向 4.5–6.7×；先解决封送                                                  |
| 并行写入型子代理                      | Cognition + MAST + 仓内事故都反对；单写者 + 只读 intelligence                    |
| 用 LLM judge 当完成判据               | 机械判据优先；judge 只做 advisory                                                |
| 把“能力协议/资产包”当成生态           | 协议是能力，不是生态；registry 仍是占位                                          |

---

## 12. 结论

**OmniHarness 不是“能力不够多”，而是“能力的时间/行动/互操作尺度不够大”。**

它有一个很成熟的工程底座：六边形端口、事件流单源、fail-closed 门禁、50 个工具、7 个 CI job、审计哈希链、签名资产包。这些是真实资产，不需要推翻。

但核心能力仍有五个结构性缺口：

1. **长时执行会断**（60min、无截断续写、无反应式压缩、无 fallback）；
2. **上下文会失忆**（单层 0.8×摘要、启发式 token、窗口目录漂移）；
3. **交互环境摸不着**（只有截图、无搜索 provider、无 GUI 动作）；
4. **验证不独立**（reviewer 只是角色、目标判定靠 LLM、子代理轨迹不持久）；
5. **生态接不上**（MCP 旧一修订、A2A 私有、Skills 非标准）。

这五件事里，**前两件是 P0**：不解决，小时级任务不可达；后三件是 P1：不解决，能力边界被卡住。记忆/进化/成本/可观测/产品化是 P2：重要，但不是当前“能不能把任务做成”的第一瓶颈。

**90 天内只做两条主线**：先把“长时执行 + 上下文”做成小时级任务闭环；再把“浏览器 + reviewer”做成前端/代码改动的闭环。生态互操作与 OS 级隔离排在其后；跑分、榜单、500 题评测都不做。

如果只能做成一件，做 **长时执行与恢复**；如果能做成两件，加 **上下文保鲜**。这两件做完，OmniHarness 才真正从“分钟级机制完整”跨到“小时级能力完整”。

---

## 附录 A：关键论断—证据对照

| 论断                             | 证据                                                                                                                                                       | 类型               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 默认 60 分钟硬熔断               | [`agent.ts:40-41`](../src/core/agent.ts#L40-L41)                                                                                                           | 读码               |
| 无 `finish_reason` 处理          | 全仓 grep 无命中                                                                                                                                           | 读码               |
| 无 prompt-too-long 处理          | 全仓 grep 无命中；400 不可重试                                                                                                                             | 读码               |
| 压缩阈值 0.8×窗口、单次摘要      | [`contextCompactor.ts:191-196`](../src/context/contextCompactor.ts#L191-L196)                                                                              | 读码               |
| token 估算 `ceil(cjk + other/4)` | [`tokenEstimator.ts:215`](../src/context/tokenEstimator.ts#L215)                                                                                           | 读码               |
| Claude 4.6 1M 被记成 200k        | [`contextWindowCatalog.ts:25-28`](../src/context/contextWindowCatalog.ts#L25-L28) + Claude Code 论文                                                       | 读码 + 外部        |
| 浏览器只有截图                   | [`browserScreenshotTool.ts:90-123`](../src/adapters/tool/browser/browserScreenshotTool.ts#L90-L123)                                                        | 读码               |
| `web_search` 默认不注册          | [`configToolRegistry.ts:38`](../src/config/configToolRegistry.ts#L38)                                                                                      | 读码               |
| A2A 私有方法                     | [`a2aProtocol.ts:13-16`](../src/a2a/a2aProtocol.ts#L13-L16)                                                                                                | 读码               |
| 技能是 JSON 内联                 | [`skill.ts:10-29`](../src/ports/skill/skill.ts#L10-L29)                                                                                                    | 读码               |
| 注入 CLI 默认 shadow             | [`enforcementModeResolver.ts:116-127`](../src/security/enforcementModeResolver.ts#L116-L127)                                                               | 读码               |
| 出网守卫只覆盖 fetch             | [`networkEgressGuard.ts:39-48`](../src/adapters/sandbox/networkEgressGuard.ts#L39-L48)                                                                     | 读码               |
| 子代理轨迹不持久                 | [`subagentEventBridge.ts`](../src/subagent/subagentEventBridge.ts) + worktree cleanup                                                                      | 读码               |
| MCP 协议 2025-11-25              | `node_modules/.../types.js`                                                                                                                                | 本机实测           |
| Claude Code 5 层压缩             | [arXiv:2604.14228](https://arxiv.org/abs/2604.14228)                                                                                                       | 预印本（源码分析） |
| Claude Code 5 层恢复             | [error-recovery.md](https://github.com/6551Team/claude-code-design-guide/blob/main/architecture/17-%E9%94%99%E8%AF%AF%E6%81%A2%E5%A4%8D/error-recovery.md) | 社区源码分析       |
| Context Rot                      | [Chroma](https://www.trychroma.com/research/context-rot)                                                                                                   | 技术报告           |
| LongMemEval 30% 下降             | [ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/hash/d813d324dbf0598bbdc9c8e79740ed01-Abstract-Conference.html)                             | 同行评审           |
| Cognition 干净上下文 reviewer    | [Cognition](https://cognition.com/blog/multi-agents-working)                                                                                               | 厂商复盘           |
| MAST 14 模式/3 类                | [NeurIPS 2025](https://proceedings.neurips.cc/paper_files/paper/2025/hash/b1041e52d3be19f0a9bc491657488e4a-Abstract-Datasets_and_Benchmarks_Track.html)    | 同行评审           |
| MCP 2026-07-28 变更              | [官方 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)                                                                       | 官方规范           |
| A2A v1.0                         | [官方 spec](https://a2a-protocol.org/latest/specification/)                                                                                                | 官方规范           |
| AGENTS.md 60k+                   | [agents.md](https://agents.md/)                                                                                                                            | 官方项目           |
| OWASP ASI01–ASI10                | [OWASP](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/)          | 官方框架           |

---

## 附录 B：参考文献

**同行评审 / 官方规范（A 级）**

1. Deng, X., et al. “SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks?” ICML 2026, PMLR 306:23917–23934. <https://proceedings.mlr.press/v306/deng26f.html>
2. Cemri, M., et al. “Why Do Multi-Agent LLM Systems Fail?” NeurIPS 2025 Datasets & Benchmarks. <https://proceedings.neurips.cc/paper_files/paper/2025/hash/b1041e52d3be19f0a9bc491657488e4a-Abstract-Datasets_and_Benchmarks_Track.html>
3. Wu, D., et al. “LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory.” ICLR 2025. <https://proceedings.iclr.cc/paper_files/paper/2025/hash/d813d324dbf0598bbdc9c8e79740ed01-Abstract-Conference.html>
4. Model Context Protocol. “Key Changes — 2026-07-28.” <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
5. A2A Project. “Agent2Agent (A2A) Protocol Specification v1.0.” <https://a2a-protocol.org/latest/specification/>
6. OWASP GenAI Security Project. “OWASP Top 10 for Agentic Applications 2026.” 2025-12-09. <https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/>

**预印本 / 技术报告 / 官方基准（B 级）**

7. Liu, J., Zhao, X., Shang, X., Shen, Z. “Dive into Claude Code: The Design Space of Today’s and Future AI Agent Systems.” arXiv:2604.14228. <https://arxiv.org/abs/2604.14228>
8. Liu, Y., Han, Z. “What Does a Harness Buy? Tokens, Mostly.” arXiv:2610.04433. <https://arxiv.org/abs/2610.04433>
9. Terminal-Bench. “Terminal-Bench 4.0.” 2026-08-28. <https://www.tbench.ai/news/terminal-bench-4-0>
10. Hong, K., Troynikov, A., Huber, J. “Context Rot: How Increasing Input Tokens Impacts LLM Performance.” Chroma, 2025-07-14. <https://www.trychroma.com/research/context-rot>
11. Debenedetti, E., et al. “Defeating Prompt Injections by Design.” arXiv:2503.18813. <https://arxiv.org/abs/2503.18813>
12. AGENTS.md. “A simple, open format for guiding coding agents.” <https://agents.md/>
13. xlang-ai. “OSWorld 2.0: Benchmarking Computer Use Agents on Long-Horizon Real-World Tasks.” <https://github.com/xlang-ai/OSWorld-V2>

**厂商 / 社区分析（C 级，需自行复核）**

14. Yan, W. “Multi-Agents: What's Actually Working.” Cognition, 2026-04-22. <https://cognition.com/blog/multi-agents-working>
15. “错误恢复架构文档（Claude Code v2.1.88）.” 社区源码分析. <https://github.com/6551Team/claude-code-design-guide/blob/main/architecture/17-%E9%94%99%E8%AF%AF%E6%81%A2%E5%A4%8D/error-recovery.md>
16. NeuralTrust. “OWASP Agentic AI Top 10 Explained.” 2026-07-09. <https://neuraltrust.ai/blog/owasp-agentic-ai-top-10>

> 说明：B/C 级来源的数字与结论按原文引用，本报告未独立复现；A 级为同行评审或官方规范。仓内文档（`PROJECT_BOARD.md` 等）作为“项目自述”引用，不当作独立证据。

---

## 附录 C：本报告的自我证伪条件

1. **长时**：8 小时级任务在默认配置下跑通，截断/超窗/过载三类恢复有判据 → “长时执行会断”降级。
2. **上下文**：压缩后任务保持率非劣，且 1M 模型不提前压缩 → “上下文会失忆”降级。
3. **交互**：浏览器动作 + 搜索在真实任务上闭环 → “交互环境摸不着”降级。
4. **验证**：独立 reviewer 稳定抓到注入 bug，轨迹可读 → “验证不独立”降级。
5. **互操作**：MCP 2026-07-28 / A2A v1.0 有官方 SDK 互通判据 → “生态接不上”降级。
6. **隔离**：AppContainer/WSL2 + OS 级出网有可复现判据 → “隔离 L2”降级。

反过来，如果 90 天后仍然只有“60 分钟 + 单层压缩 + 截图 + 角色 reviewer + 私有协议”，那么本报告的五项判断不仅成立，而且说明项目需要把“能力闭环”而不是“机制数量”作为下一阶段的主线。
