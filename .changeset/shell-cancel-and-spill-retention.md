---
'omniharness': patch
---

**审计 §1.7 剩余两条缺陷修复（shell 会话取消 / spill 无回收）+ §3.2 逐条核实**：shell 此前**完全没消费取消信号**（回合已取消的命令仍跑满自己的超时，最长 10 分钟），spill 产物与涡环包**只增不减**。

- **shell 不消费取消信号（修 bug）**：`ToolContext.signal` 早已由 `stepToolExecutor` 注入，但 `ShellTool`
  没把它传进执行参数。修法三件：① `ShellRunOptions.signal` 参数透传；② 新增 `ProcessTreeKiller`
  **终止整棵进程树**——Windows 走 `taskkill /PID <pid> /T /F`（失败回退单进程 kill），POSIX 让 shell 成为
  进程组长（`detached: true`）后用 `kill(-pid)`；**超时与输出超限两条路径一并换用**，因此
  「只杀直接子进程」这个更广的隐患在三条终止路径上一起消失；③ 执行结果新增 `aborted` 字段，工具层
  状态优先级改为 **取消 > 超时 > 截断 > 退出码**，文案「命令被会话取消（已终止整棵进程树）」。
  回归：`shellTool.test.ts` 新增 2 例；「整棵树都死了」用**孙进程心跳停止**断言。
  **反向验证**：临时改回「只杀直接子进程」后该用例**会红且是挂死**——存活孙进程仍持有 stdout 管道，
  Node 的 `close` 永不触发 ⇒ 工具调用 Promise 永不 settle（即该缺陷在生产里的真实后果）。
- **spill 产物与涡环包无回收（修 bug，限额进配置）**：`FileSpill` 新增 `maxFiles`（默认 **512**，`0`=不回收），
  每次写入后按 **mtime 删除最旧**（失败只告警）；`VortexRingSpillAdapter` 新增 `maxRings`（默认 **256**，
  `0`=不淘汰），超限按 **LRU** 淘汰（`read` 命中即续命）并 `spill.ring.evicted` 告警，被淘汰 id 读回仍
  `undefined`（既有 fail-closed 语义）。两个限额均以 `OmniHarnessConfig` 字段
  （`spillMaxFiles` / `spillMaxRings`）暴露，由 `configBuilder.buildSpill` 与 `corePortsAssembler` 消费，
  **不硬编码策略**。回归：`spill.test.ts` 新增 6 例（上限回收最旧、`0`=不回收、**上限经配置生效**、
  LRU 续命、`maxRings=0`、**回收路径的三条失败分支**：根缺失 / `stat` 失败（悬空 junction）/ `rm` 失败
  （非空目录），三者都只告警不中断其余回收 ⇒ `fileSpill` 行/分支覆盖 96.43%→**100%**）。
- **§3.2 逐条核实（结论含一处判断更正）**：`resources/comfyui_node_reference` 与 `evals/*.report.json`
  **均已 0 tracked**（前两条确已结项）；第三条「记忆引擎三份重复＝死资产」**不成立、故不删**——
  两个引擎在 `resonantField.enabled === false` 时由 `memoryStackAssembler` 显式构造，有 3 个测试文件断言，
  覆盖率 87.4% / 97.95%，且 `src/index.ts` **对外导出**（删除属破坏性 API 变更）。
  正解是先 `@deprecated` 再按次版本移除并迁移到 U1 统一基板；审计标题与结论已据此更正。
- **新登记一条待办（本轮不修）**：Windows 下 `cmd /d /s /c` 会破坏性重解析**带引号参数**的命令
  （探针实测：`node "<绝对路径>" "<目录>"` 被粘成一个参数）。属解析契约级改动，需先建用例矩阵，见审计 §1.9。
