# Agent Loop V2 重构蓝图（2026-09-09）✅ 已落地

> **落地状态（2026-09-09 当日完成）**：四个新组件 + 五处改造全部实现并通过验收——
> typecheck/build 全绿；新增 4 套件 24 测试全绿；全量 987 pass（8 fail 经 HEAD 基线
> worktree 实证为遗留/环境性网络类测试，与本重构无关）；smoke ✅；Node 20.1.0 冒烟 ✅
> （顺手修复 `sqliteStorage` 顶层静态 import `node:sqlite` 的遗留 Node 20 加载回归——
> 改为类型 import + 惰性 require，签名零变更）。
> 验收中测试还抓出并修复了两个实现缺陷：① LoopGuard 双检测器共享序列重复 push 导致
> 周期误判；② 周期 1（A→A）与 exact-repeat 重叠——已划定周期 1 归 exact-repeat 专属，
> wall-clock 到点直接熔断（收尾由 finalize 兜底）。

> 定位：不是打补丁（见同日 `AGENT_LOOP_AUDIT_AND_UPGRADE_PLAN_2026-09-09.md` 的 R1–R8），而是把主循环重构为「事件溯源 + 可取消 + 失控自愈 + 并行调度」的新一代 loop。设计思想全部提炼自开源第一梯队的公开实践。

## 1. 开源思想 → 本项目映射表

| 开源项目                                      | 核心思想                                                                                               | 落地方式                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| OpenHands V1                                  | **事件溯源单一事实源**：append-only EventLog，重放即重建；Agent 无状态，唯一可变物是 ConversationState | 已有 `AppendOnlyEventLog`；补齐**单事件粒度持久化**（write-behind），崩溃可从任意事件恢复       |
| OpenHands                                     | **StuckDetector / Control Flags**：重复模式检测 + iteration/budget 双预算是控制器一等公民              | 新组件 `LoopGuard`：同调用重复检测 + 循环窗口 + wall-clock 预算，产出结构化干预决策             |
| agent-loop-guard / LoopBuster（失控检测品类） | **参数规范化**（uuid/timestamp/hash 掩码）避免误判；**检测后注入纠偏上下文而非直接杀**                 | `LoopGuard` 内置 canonicalArgs（易变字段掩码）；违规时产 `nudge` 注入 user 消息，连续违规才熔断 |
| codex                                         | **CancellationToken 树**级联取消；采样层重试                                                           | 新组件 `CancellationToken`（零依赖）+ `ModelRequest.signal` 贯穿模型调用与工具执行              |
| codex / dsh                                   | **压缩阈值挂真实 context window**；摘要**结构化**；压缩调用**保前缀缓存**                              | `ContextCompactor` 改造：阈值=window×0.8、8 段结构化摘要模板、摘要请求重放原前缀只追加尾部指令  |
| codex / dsh                                   | **工具并行门控**（工具级静态声明 + 写类屏障 + 有界池，结果按 model-order 提交）                        | 新组件 `ToolScheduler`：`parallelCapable` 声明 + Promise 有界池 + 写类屏障                      |
| dsh                                           | **phase 状态机 + write-behind 持久化**（单事件 seq、批量 200ms、torn tail 可修复）                     | 新组件 `EventPersister`：write-behind 200ms + 显式 flush；回合末强 flush                        |
| Claude Agent SDK                              | gather→act→verify 循环观；**双执行控制**（max_turns + max_budget_usd）                                 | 既有 maxSteps + CostBudget；补 wall-clock `maxDurationMs` 进 LoopGuard                          |

## 2. 新组件清单（全部零依赖、Node 20 兼容、一功能一类）

```
src/core/loop/
  cancellation.ts    CancellationToken（abort/reason/throwIfAborted/child）
  loopGuard.ts       失控检测：ExactRepeat/循环窗口/wall-clock → nudge|abort 决策
  toolScheduler.ts   工具并行调度：并行池 + 写屏障 + model-order 提交
  eventPersister.ts  write-behind 增量持久化（200ms 批量 + flush）
```

改造：`contextCompactor.ts`（游标+结构化+前缀缓存）、`ports/model.ts`（signal）、
`turnRunner.ts`（LoopGuard+nudge 接线）、`stepRunner.ts`（scheduler+signal 接线）、
`agent.ts`（persister+cancellation 接线）。

## 3. 兼容性承诺

- 对外接口不变：`AgentResult`/`SessionEvent`/`ToolPort`/`ModelPort` 增量扩展（可选字段），旧适配器不改动也继续工作。
- 既有 837 单测必须全绿；新组件各配独立套件。
- 零运行时依赖铁律、Node 20 兼容铁律不破。

## 4. LoopGuard 决策表

| 检测器       | 触发条件                               | 干预                                 |
| ------------ | -------------------------------------- | ------------------------------------ |
| exactRepeat  | 同名工具+规范化参数连续 ≥3 次          | nudge（注入纠偏 user 消息）          |
| cyclePattern | 窗口内 A→B→A→B 循环（窗口 8，周期 ≤4） | nudge                                |
| wallClock    | 会话 wall-clock 超 `maxDurationMs`     | abort（fail-closed 收尾进 finalize） |
| nudge 上限   | 同一检测连续触发 ≥2 次仍未改观         | abort                                |

nudge 文案要求模型「换方法」，而非重复尝试——学 Varpulis 的 additionalContext 模式。

## 5. V2.1 增量落地（2026-09-09 深夜，第二轮盘点后）

诚实盘点修正：上一轮「待升级清单」有误报——A2 重试瀑布（RetryingModel）、
C8 fallback 路由（modelRouter health-fallback）、B5 成本预算（BudgetedModel）、
B6 压缩 8 段结构（含任务目标/当前进度）、C9 SubagentTool 均已存在。
真实缺口与本轮落地：

| 项                 | 落地                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 文本流式        | ToolInputSink 加可选 onTextDelta；StepRunner 转发 onText；ConsoleLiveView 文本通道（--stream-text opt-in）；execImpl 流式时不重复打印 finalText |
| A3 重试默认开      | modelRetry 默认 true（--no-model-retry 显式关）；暴露并修复 RetryingModel 对无 stream 模型的虚假广告缺陷（undefined 上抛炸 StepRunner）         |
| B4 token 预算      | TurnRunner 累计 usage.totalTokens 超限停止步进（config.turnTokenBudget / env OMNI_TURN_TOKEN_BUDGET / --turn-token-budget）                     |
| B5 熔断优雅化      | BudgetExceededError 在循环层被捕获→记系统事件→finalize 交付已有进展，不再整回合硬崩                                                             |
| B7 resume 语义     | resume 不带提示 = 崩溃恢复：注入「续跑」引导消费 write-behind 已落盘的中间事件                                                                  |
| C10 prompt caching | Anthropic system 变独立 text block + cache_control ephemeral（跨回合稳定前缀命中缓存）                                                          |

测试新增 loopV21.test.ts（7 测试）；modelAdapters Anthropic 断言同步更新。
另修 sqliteStorage 惰性加载缺陷（require('node:sqlite') 返回模块对象非类，
须解构 DatabaseSync）。验收：typecheck/build 绿；loopV21 7/7；全量 1009 测试
994 pass / 8 fail（与 HEAD 基线逐项一致，均为遗留环境性网络类）；smoke 绿；
Node 20 冒烟绿。
