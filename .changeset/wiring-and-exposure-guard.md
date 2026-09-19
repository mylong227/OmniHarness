---
'omniharness': minor
---

消灭「有实现、无接线」：把入口可达性审计查出的 15 个不可达模块全部接进生产路径，并补齐审计中发现的两处真缺口。

**接线（新增生产调用点，不只是 import）**

- 可观测性：`otlpTraceExporter` 此前只有自己的单测引用它（写了没接线）。新增 `traceSpanBuilder`（事件→span 纯构造，tool/model/session 三类 span）、`traceCollectingEventPort`（事件端口装饰器：事件原样透传 + 产出并导出 span）、`traceExporterAssembly`（设了 `OTEL_EXPORTER_OTLP_ENDPOINT` 才包装，未设**原样返回**零行为变更）。接线点：`corePortsAssembler`（CLI/服务端/子代理共用一处）与 `Agent.runTask` 的 finally（`EventPort` 增可选 `flush`）。端到端实测：起本地 collector 跑真实回合 → POST 出 `tool.shell` + `session` span。
- trace 自省（端口 + 只读适配器）：接入服务端与 CLI（只读、冻结快照语义，agent 可自省但不能借道改历史）。
- TS SDK 客户端（`sdkClient` + `webSocketSdkSocket`）：接入 CLI，可对 `serve` 的 WS 端点发真实 JSON-RPC。
- MCP 官方 SDK 服务端适配器：`mcp serve` 优先走 SDK 适配器，不可用时回落手写实现并如实报因。
- eval 门禁件（`bootstrap`/`passK`/`isolatedEvaluator`/`reasoningRouter`/`editDriftDetector`）与进化算子（`annealedAcceptance`/`diversityGuard`/`failurePatternMiner`/`rewardCoverageMeter`）：接入 eval 脚本与 RLVR 闭环的真实调用路径。

**审计中新发现并修掉的两处真缺口**

- **服务端默认绑定**：`httpServer.listen(port)` 未传地址 ⇒ Node 默认绑 `0.0.0.0`，而该服务能驱动 agent 执行任意工具（含 `--auto-approve`）⇒ 等于把无鉴权的远程执行入口开到局域网。新增 `ServerAuthGuard`：默认只绑回环；非回环**必须**配令牌否则拒绝启动（fail-closed）；配了令牌后除 `/healthz` 外一律要求 `Authorization: Bearer`，HTTP 与 WebSocket 共用同一守卫。`serve` 支持 `OMNI_SERVE_HOST` / `OMNI_SERVE_TOKEN`。
- **`config.update` 无法清空覆盖**：`undefined` 是 no-op、空串/null 会被原样写坏（`baseUrl=''`/`null` 破坏厂商端点拼装）⇒ `null` 现定义为**显式清除**（从覆盖集合与落盘结果双双删除，避免 `mergeConfigs` 只覆盖不删除导致旧值复活）；前端留空即发 `null`。

**前端 F4/F5/F6/F8 缺口收口**：四项此前已在 `fefadc3`/`33f9f51`/`9763db6` 落地（roadmap 表滞后）；本轮补真实缺口——中止**立即**收口且不残留 streaming、重生成补**回退**、编辑重发改为**回填输入框**、配置保存后**重拉并刷厂商目录**、路由未变也立即收口且打开文件写 hash。web 单测 137 → 157。

**另修** `stress` 假红（测法：预热后取基线 + 强制 GC）与 `eval:veto` 断链（引用不存在的 `context/codeGraph.js`）。
