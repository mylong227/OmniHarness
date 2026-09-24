---
'omniharness': patch
---

**JSON-RPC 在途请求簿记收成单一实现**（用户指定「把其他问题全解决掉」）：新增 `src/util/pendingRequests.ts`，七个站点全部改接，删掉各自的 pending/超时/id 关联拷贝。**未改动任何对外行为**（超时文案、计数契约、幂等语义逐条保真）。

- **动机**：审计 §3.5 记「JSON-RPC pending/超时/id 关联重复 6 处」。那份重复里**已经**长出一个真缺陷
  （`mcpClient` 无 reject 通道，传输关闭时在途请求只能等各自超时，调用方表现为「卡住」——已在上一轮单独修掉），
  而它之所以会长出来，正是因为七份实现各自演进：有的记得清超时定时器、有的忘了；有的有拒绝通道、有的只有 resolve。
  本轮把**簿记**收成一份，把**语义差异**交给调用方显式表达。
- **新增 `PendingRequests<K, V>`**：`register` / `take` / `settle` / `fail` / `failAll` / `settleAll` / `size`。
  不变量：① 每个被登记的处理器**恰好**在一条路径上收尾；② **移出条目的同时清掉超时定时器**
  （因此不存在「已兑现但定时器仍在、稍后又 reject 一次」的双收尾，超时回调通过 `take` 的返回值判幂等）；
  ③ 一次性收尾返回条数（供日志与断言）。
- **差异如何保留**（不是把七种形态硬抹成一种）：
  `reject` 可缺省（`httpBridgeTransport` 只登记成功通道，语义不变）；超时可缺省（审批等待上限可 0 = 不限时，
  保留 `OMNI_APPROVAL_UPLINK_TIMEOUT_MS=0` 旧行为）；超时动作由 `onTimeout` 决定
  （`a2aClient`/`cdpClient`/`lspJsonRpcConnection`/`mcpClient`/`sdkClient` 为 **reject**，
  `serverEventBridge` 为 **兑现 deny**）；一次性收尾分 `failAll`（断开全拒）与 `settleAll`
  （断连一律 deny，`denyAllPending(reason)` 仍**返回条数**）。
- **改接站点（7）**：`a2aClient`、`httpBridgeTransport`、`cdpClient`、`lspJsonRpcConnection`、`mcpClient`、
  `sdkClient`、`serverEventBridge`。连带删掉：本地 `Pending`/`PendingRequest`/`PendingCall` 接口、
  `cdpClient`/`lspJsonRpcConnection`/`mcpClient` 的私有 `failAll`、`sdkClient` 的私有 `rejectPending`
  与「包一层只为 clearTimeout」的 resolve/reject 包装、`serverEventBridge` 内联的 `settle` 与定时器分支。
  `cdpClient`「任何 promise 都不得永久悬着」与 `mcpClient`「传输无关闭通知 ⇒ 必须显式 close」两条不变量
  **提升到类注释**，不再挂在被删的私有方法上。
- **行为保真（逐条核对）**：超时文案逐字未变（`A2A 调用超时` / `CDP 命令超时（<ms>ms）` / `LSP 请求超时` /
  `MCP 请求超时` / `SDK 请求超时`）；登记仍发生在**发送之前**；`mcp.request.timeout` 告警字段与触发时机不变；
  重复响应与重复审批保持幂等。
- **回归**：新增 `tests/unit/pendingRequests.test.ts`（9 例）；站点侧 **15 个测试文件 97 例** +
  审批/LSP 侧 **9 个文件 67 例**全过。
- **覆盖率效应（含门禁处理，均标明判定依据）**：去重后 `mcpClient` 87.26→85.29、
  `httpBridgeTransport` 97.66→97.63（两次全量复现一致 ⇒ 删掉**被覆盖的样板**使分母变小，逻辑搬进
  98.83% 覆盖的 `pendingRequests.js`，非行为覆盖丢失 ⇒ 更新冻结值）；`wsConnection` 85.14→84.42
  则**源码未被触及**，去掉新增测试文件后全量恰好回到 85.14% ⇒ 判定为**测试文件集合改变并发交错**的
  度量抖动，**不改基线**而是登记为**下限 84%**（`scripts/coverageEnvDependent.json`，附证据）。
  同时 6 个站点覆盖率上升（`a2aClient` 94.44→100、`sdkClient` 91.14→95.38、`serverEventBridge` 95.68→96.5 等），
  基线与聚合相应收紧：**90.54% → 90.56%（509 文件）**。
