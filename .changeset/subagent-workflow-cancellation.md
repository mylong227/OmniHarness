---
'omniharness': patch
---

子代理 / 工作流 / 取消传播：3 处已复现缺陷修复 + 1 处接线缺口补齐（每处都有「修前红 → 修后绿」探针）。

**修掉的缺陷**

- **`run_workflow` 的 `maxConcurrency: 0` 永久挂起（已独立复现，最危险）**：`ConcurrencyLimiter` 的 `acquire()` 对 `limit < 1` 恒不满足 `active < limit`，且永无释放者 ⇒ 工作流**永不 settle**（无异常、无日志、无法收尾）。实测 `maxConcurrency` 为 `0 / -1 / NaN / "2"` 时 1000ms 内不 settle。现 `ConcurrencyLimiter` 构造期 fail-closed（`RangeError`，带可执行信息），`WorkflowRunner` 对构造期选项与每轮 `def.maxConcurrency` 双重校验并抛 `WorkflowSpecError`（新增错误码 `WORKFLOW_SPEC`），`run_workflow` 工具把它转成 `ok:false` 的可执行错误。同一根因的 `--subagent-concurrency 0` 也一并堵住。
- **成功但无 `finalText` 的步骤被当成依赖失败**：`WorkflowRunner.run` 原先把「`ok && output === undefined`」并入失败集合 ⇒ 下游被 fail-closed 跳过、整体 `ok` 变 false（把「这一步没吐文本」误判为「这一步失败了」，并传染全部下游）。现语义为「成功即成功，空产出只是没有内容可注入下游」，下游照常执行。
- **`--subagent-max-steps` 只覆盖三条子代路径之一**：`run_goal` / `run_workflow` 的子代 runtime 读的是**主会话** `maxSteps`，只有 `subagent` 走 `SubagentOrchestrator` 的子代预算。现三条路径共用同一份子代步数预算，缺省口径与编排器一致（`DEFAULT_SUBAGENT_MAX_STEPS`）。实测：`subagentMaxSteps: 1` 时子步模型调用从 9 次（= 主会话 8 + 1）降为 2 次（= 1 步 + 1 次兜底总结）。

**功能缺口补齐：取消传播（父 `cancelCurrentRun` → 子代）**

- 传播路径：`Agent` 会话取消令牌 → `StepRunnerDeps.signal` → `StepToolExecutor` 注入 `ToolContext.signal`（新增可选字段）→ `subagent` / `run_workflow` / `run_goal` 工具 → 子代 runtime 的模型端口装饰器 `cancellableModel`（父信号并入每次模型请求的 `signal`，请求结束后解绑监听，长会话不堆监听器）。
- 收尾语义：父取消后子代在飞模型请求立即中止并抛 `CancelledError`（不再继续烧 token）；工作流不再启动下一层步骤（记为「已取消」并继续阻塞其下游）；目标循环不再开启下一轮迭代（含跳过达成度判定那次模型调用）；子代理编排器在「已取消」时 fail-closed 拒绝派生（连并发槽位都不等、不建隔离工作树），隔离工作树仍由既有 `finally` 回收，不留孤儿。
- 修前实测（真实 Agent 主循环 + 真实工具注册表）：父取消后工作流步骤 / 目标循环 / 子代理的在飞请求**均未收到 abort**（子代继续跑）；子代理 `SubagentRunner` 取消后模型调用计数不收敛。修后 6 例全绿。

**验证**：新增 3 个测试文件共 16 例全绿；既有 `workflowRunner` 9/9、`runWorkflowToolContract` 3/3、`runGoalTool` 3/3、`stepToolExecutorPairing` 5/5、`goalRunner` 4/4、`loopV21` 7/7、`errors` 2/2 未退；`typecheck`/`build`/`check --strict`（558 文件零违规）/`arch:gate`/`audit:config-wiring`/`audit:maturity`/`eslint --max-warnings=0` 全绿。（`subagent.test.js`、`configBuilder.test.js`、`apiStability.test.js` 等在本机沙箱下因禁写临时目录而红：全部 13 例为 `EPERM: mkdtemp`，与本笔无关。）

**行为变更提示**：① 非法并发上限从「永久挂起」变为「立即拒绝」（`ConcurrencyLimiter` 抛 `RangeError`；启动期若配置了非法 `subagentConcurrency` 会直接报错而非挂死）；② `run_goal` / `run_workflow` 的子代步数上限改为子代预算（缺省 12，不再跟随主会话 `maxSteps`）；③ 成功但无产出的工作流步骤不再导致下游跳过（`ok` 变 true，属**修复**而非破坏，但会改变依赖该假故障的观测）；④ 新增公开导出 `WorkflowSpecError`、`requireConcurrencyLimit`，`ToolContext` / `SubagentRequest` / `WorkflowRunnerOptions` / `GoalRunnerOptions` 新增可选 `signal` 字段（向后兼容）。

**已知未修（如实登记）**：① 子代工具级事件绕过事件桥进父流并改写父状态——已复现：子代调用 `todo_write` 后父事件流收到 1 条 `todo` 事件（子代自身的 `session_meta/user/tool_call/tool_result/assistant` 仍留在桥内），且父待办被整表替换（`last-write-wins`）；根因是子代工具视图复用父注册表的**同一批工具实例**（实例在注册期已捕获父 `EventPort` / 共享 `TodoPort`），修法需按子代为工具重新绑定端口（组合根重构），未在本轮动手。② `rerootStorage` 对未知存储后端直接复用父存储，与其 JSDoc「不静默共享父存储」自相矛盾（未复现实害，未改）。③ `withWorktreeLock` 只锁创建未含清理（本机沙箱禁 spawn，无法用真实 worktree 复现）。
