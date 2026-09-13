# Agent Loop 审计与升级计划（2026-09-09）

> 范围：`src/core`（agent/turnRunner/stepRunner/toolGate）+ `src/context`（assembler/compactor/spiller）主循环质量审计。
> 方法：双代理并行对标 `D:\deepseek\.recycle-bin\.ref-backup\` 下的 codex（Rust）与 deepseek-harness（TS）→ 逐条亲自 Read 源码复核（剔除误报、钉死证据）。
> 结论一句话：**能力面（S21–S36）已对齐开源第一梯队，但循环的「运行时质量」三处 P0 落后——压缩瞬态重算、零取消零超时、回合级持久化。修这三处的收益大于再抄任何新功能。**

---

## 1. 现状盘点（核心链路）

```
Agent.continueSession (src/core/agent.ts:76)
  └─ TurnRunner.run (src/core/turnRunner.ts:37)      while steps < maxSteps(默认16)
       └─ StepRunner.run (src/core/stepRunner.ts:127) 每步：
            ├─ buildMessages: 全量事件投影 + 常驻指令 + repo-map + 压缩   ← P0-1
            ├─ requestModel: generate/stream（无超时/无取消）              ← P0-2
            └─ runToolCalls: for 循环串行                                  ← P1-4
                 gate(审批→沙箱→计划态) → pre钩子 → native FFI|JS → post钩子
                 → 外溢(>16KB) → 注入护栏 → 沙箱拒绝标注 → supervisor 上报
       退出：text / 步数耗尽 / 连续3次空响应
  └─ 收尾：finalize 兜底总结(仅1次) → turn_diff → 记忆蒸馏(异步)
  └─ finally: storage.save 全量落盘一次                                ← P0-3
```

核心 6 文件共 1330 行（agent 307 / stepRunner 436 / turnRunner 117 / toolGate 133 / compactor 128 / assembler 209），结构清晰、职责分离良好。

## 2. 实测问题清单（全部亲自读码核实，非转述代理）

### P0（直接烧钱 / 丢数据 / 卡死）

| #        | 问题                                               | 证据                                                                                                                                                                                                                                      | 后果                                                                                                                                                              |
| -------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0-1** | **压缩结果是瞬态的，长会话每步重复调一次摘要 LLM** | `contextCompactor.ts:53` 无任何缓存/游标；`stepRunner.buildMessages` 每步从 `allEvents()` 全量重投影（压缩摘要不写回事件日志，`recorder.system` 只记了「已折叠」提示文本）；投影长度不变 → 下一步 estimate 仍 > 8000 → **再次 summarize** | 每步多烧一次 LLM 调用（摘要输入是全量 head 历史，等于每步额外付一遍近全量 token 钱）+ 每步延迟显著增加。这是当前 loop 里性价比最高的一处修复                      |
| **P0-2** | **零取消、零超时**                                 | 全 `src/` 仅 `providerProbe.ts` 与 `otlpTraceExporter.ts` 用 AbortController；`ports/model.ts` 无 signal/timeout 字段；`adapters/model` 无 fetch 超时                                                                                     | 模型挂起 → 会话永久卡死；无法中断长工具；服务端无请求级取消。codex 有 CancellationToken 树级联 + 流中断恢复；dsh 每 phase 一个 AbortController + `throwIfAborted` |
| **P0-3** | **持久化粒度 = 整回合**                            | `storage.save` 全仓仅 `agent.ts:152`（finally 回合末全量）+ checkpoint.ts（手动快照）；`sessionRecorder` 不落盘                                                                                                                           | 长回合中途崩溃/断电，**整回合事件全丢**（用户看到空白）。dsh：单事件粒度 + 200ms write-behind + torn tail 修复；codex：每步 append_rollout_items                  |

### P1（明显落后于两个上游）

| #        | 问题                                                                           | 证据                                                                                                           | 上游做法                                                                                                                                |
| -------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **P1-4** | 工具调用全串行                                                                 | `stepRunner.ts:296-300` for 循环                                                                               | codex：工具级 `supports_parallel` 门控（读类并行、apply_patch 互斥）；dsh：`executionMode` + 有界并行池（默认10）+ exclusive 屏障       |
| **P1-5** | 压缩阈值与真实 context window 脱钩；摘要非结构化；摘要请求独立会话不保前缀缓存 | `agent.ts:19` 固定 8000（仅 `--context-window` 手动推导一次）；`summaryRequest` 是全新 system+user 两消息      | codex：阈值=window×百分比+auto_compact 双轨，头删保前缀缓存；dsh：0.8×window，8 段结构化摘要，压缩调用设计为原请求真前缀以复用 KV cache |
| **P1-6** | 空响应盲目重试；maxSteps=16 偏紧                                               | `turnRunner.ts:43-64` 同上下文原样重发，无纠偏消息；`cliBuildConfig.ts:167` 默认 16（2026-09-08 真机复现跑满） | codex：无硬上限，Stop-hook 续写 + token 预算终止；dsh：inbox 驱动                                                                       |
| **P1-7** | 模型重试/预算熔断默认关                                                        | `RetryingModel`/`BudgetedModel` 需显式开 `modelRetry`/`costBudget`                                             | 生产默认裸奔：一次 429/500 就整回合失败上抛                                                                                             |

### P2（体验/可扩展性）

| #        | 问题                      | 证据                                                              | 上游做法                                                      |
| -------- | ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| **P2-8** | 最终文本不流式            | `stepRunner.ts:205-208` `onText: () => {}`，live 端口仅流工具参数 | codex/dsh 文本 delta 逐块出                                   |
| **P2-9** | 无 request-error 钩子瀑布 | 重试决策硬编码在装饰器内                                          | dsh：`agent/request-error` 瀑布可插件化拦截（重试/降级/中止） |

### 误报澄清（看似缺失、实际已具备，勿重复投资）

- 上下文压缩、外溢 Spill、finalize 兜底总结、空响应止损（上游反而没有）、升级审批+沙箱拒绝标注、提示注入护栏、工具发现延迟装载、repo-map 每步注入+写后失效、usage 计量、turn diff、长期记忆蒸馏——均已落地且质量不差。

## 3. 开源对比矩阵

| 维度          | OmniHarness 现状                 | codex                   | deepseek-harness             | 差距     |
| ------------- | -------------------------------- | ----------------------- | ---------------------------- | -------- |
| 工具并行      | ❌ 串行                          | ⭕ 工具级门控并行       | ⭕ 并行池+屏障               | **大**   |
| 取消/中断     | ❌ 无                            | ⭕ CancellationToken 树 | ⭕ AbortController per-phase | **大**   |
| 模型超时      | ❌ 无                            | ⭕ 采样层重试+退避      | ⭕ retryableCodes+退避       | **大**   |
| 持久化粒度    | ⚠️ 回合末全量                    | ⭕ 每步增量 rollout     | ⭕ 单事件+write-behind       | **大**   |
| 压缩触发      | ⚠️ 固定 8000                     | ⭕ 0.x×window 双轨      | ⭕ 0.8×window                | 中       |
| 压缩缓存友好  | ❌ 每步重算                      | ⭕ 头删保前缀           | ⭕ 真前缀复用 KV             | **大**   |
| 摘要结构      | ❌ 自由文本                      | ⭕ SUMMARY 结构         | ⭕ 8 段结构化                | 中       |
| 空响应自愈    | ⭕ 有限重试+finalize（独有优点） | ⚠️ 无计数止损           | ⚠️ inbox 驱动                | 持平偏好 |
| 重试/熔断默认 | ❌ 默认关                        | ⭕ 默认有               | ⭕ 默认有                    | 中       |
| 文本流式      | ❌ noop                          | ⭕                      | ⭕                           | 小       |
| 步数上限      | ⚠️ 16                            | 无硬上限                | 无硬上限                     | 小       |

## 4. ROI 排序升级计划

> 原则：先修「运行时质量」P0（不新增任何用户可见功能，纯收益），再补并行与策略默认值；全部走装饰器/钩子/装配层，不侵入核心循环语义；每项配单测，验收 = typecheck → build → 全量单测 → smoke → Node 20 冒烟。

| 序     | 项                                                                                                                                                                                         | 等级 | 成本              | 预期收益                                                                    | 关键落点                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| **R1** | **压缩结果持久化**：摘要作为 system 事件写回事件日志；compactor 记「已压缩至 seq N」游标，投影时游标前的事件直接跳过                                                                       | P0   | 小（1 文件+单测） | 长会话每步省一次摘要 LLM 调用 + 上下文 token 大幅下降；**性价比最高，先做** | `contextCompactor.ts` + `sessionRecorder`        |
| **R2** | **增量落盘**：SessionRecorder 每步（或每事件，200ms write-behind）调用 storage.save；恢复路径已有 hydrate 可复用                                                                           | P0   | 小-中             | 崩溃零丢失；对齐 codex/dsh                                                  | `sessionRecorder.ts`                             |
| **R3** | **取消+超时**：`ModelPort` 请求对象加可选 `signal`，fetch 侧 `AbortSignal.timeout`（默认如 120s）；工具执行带超时；server 层把请求断开接到 signal                                          | P0   | 中                | 消灭「永久卡死」；可中断                                                    | `ports/model.ts` + 两个模型适配器 + `stepRunner` |
| **R4** | **压缩现代化**：阈值 = 0.8×contextWindow（config 已有字段）；摘要模板 8 段结构化（任务/决策/文件/错误/待办/当前/下一步/关键约束）；摘要请求改为「重放原前缀 + 尾部追加压缩指令」保前缀缓存 | P1   | 小-中             | 压缩质量↑ + 命中 provider KV cache 省钱                                     | `contextCompactor.ts`                            |
| **R5** | **工具并行**：工具定义加静态 `supportsParallel`（读类 true、写类 false）；并行批内 Promise.all + 有界池，遇写类形成屏障；结果按 model-order 提交                                           | P1   | 中                | 多工具回合延迟显著下降                                                      | `ports/tool.ts` + `stepRunner.runToolCalls`      |
| **R6** | **默认值修正**：空响应重试时追加一条纠偏 user 消息；`modelRetry` 默认开；`maxSteps` 默认 16→32（或挂钩任务复杂度）；`costBudget` 至少默认 warn                                             | P1   | 小                | 鲁棒性；减少真机「steps=16 跑满无果」                                       | `turnRunner.ts` + `cliBuildConfig.ts`            |
| **R7** | **文本流式**：StepRunner `onText` 接 recorder 的 text-delta 事件；UI 端拼接渲染                                                                                                            | P2   | 小                | 首字延迟体验                                                                | `stepRunner.ts` + `consoleEventPort`             |
| **R8** | **request-error 钩子瀑布**：模型调用失败先过 hooks 瀑布（重试/降级/中止可插拔）                                                                                                            | P2   | 中                | 插件化容错策略                                                              | `toolHooks.ts` 范式复用                          |

**建议节奏**：R1+R2 一个阶段（小件、纯 TS、可真实实证）→ R3 单独阶段（触端口签名，需回归两条模型适配器）→ R4+R6 一个阶段 → R5 单独阶段（并发语义需重点测试写类屏障）→ R7/R8 收尾。

**明确不做**（维持既定豁免）：Starlark 全解释器、MITM 网络代理、持久 PTY、Seatbelt/bwrap（Windows 环境）。
