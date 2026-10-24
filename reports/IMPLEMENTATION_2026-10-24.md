# 完整实现记录（2026-10-24）

> 依据：[REASSESSMENT_2026-10-24.md](REASSESSMENT_2026-10-24.md)
> 范围：按完整清单落地，不按「最小切片」。外部资料为 2026-10 检索快照，不把外部分数移植为本项目承诺。

## 1. 混合检索：双镜头 + 回归守卫

**改了什么**

- `tools/probes/recallHitrate.mjs` 新增 `--lens=bm25|hybrid|both`、`--preset`、`--strict`：
  - `hybrid` 走 `RepoMapContextEngine.getHybridRepoMapContext`（与 CLI agent 默认路径同源）；
  - 真嵌入自检（维度/模型），失败 exit 3，**不再静默当 BM25**；
  - `--strict` 在 `semanticFallbacks>0` 或 hybrid 低于 BM25 5pp 时失败；
  - JSON 输出带双镜头、Δ 与 fallback 计数。
- `package.json`：`probe:recall:hybrid`、`probe:recall:both`。
- `tests/unit/hybridRecallFallback.test.ts`：fake EmbeddingPort 覆盖「成功走 hybrid / 嵌入异常计数回落」两条路径。

**实测（2026-10-24，语料随新增源码增至 1209 文件 / 15,830 符号）**

| 镜头     |         all |      core |       ext |
| -------- | ----------: | --------: | --------: |
| 纯 BM25  |       42.4% |     65.6% |     37.7% |
| 语义混合 |   **57.6%** | **71.9%** | **54.7%** |
| Δ        | **+15.2pp** |    +6.3pp |   +17.0pp |

`semanticFallbacks=0`；`probe:recall:both` 严格模式通过。

## 2. 长时程评测 + 结构化进度

**改了什么**

- `src/context/longHorizonProtocol.ts`：`.omniharness/tasks/<slug>/{features.json,progress.md,init.sh,init.cmd}`；越界 fail-closed、BOM/坏 JSON 容错、原子写、progress 256KB 截断、`markFeature`/`verify`。
- `src/core/longHorizonCoordinator.ts` + `AgentTurnSetup.beginLongHorizon` + `Agent`：复杂任务或 `OMNI_LONG_HORIZON=1` 时注入 4 行 primer（任务/完成数/下一步/验证命令）；回合末写 progress；**不把 progress/历史塞回上下文**。
- `src/core/preCompletionChecklist.ts`：完成闸门外层；lastFailure → 内层闸门 → verifyCommand；未通过只注入一次「先验证再结束」，防死循环。
- `src/eval/longTaskCatalog.ts` + `tools/eval/longTasks.mjs` + `tools/eval/long-tasks/`：
  - 20 个机械可验收 fixture（每任务独立临时 git 仓库、verifier 覆盖、expectedFiles）；
  - `pass@1`/`pass@k`/`pass^k`/tokensPerSolved 复用 `AbMetrics`；
  - `--dry-run`/`--self-check`/`--k`/`--only`/`--long-horizon`/`--model`/transcripts；
  - 无 key 显式 `{skipped:true}`；不 mock 冒充。
- 判据：`longHorizonProtocol` 7、`longTask` 10、`longHorizonWiring` 4 全绿；`eval:long --self-check` **20/20**。

## 3. MCP 2026-07-28 完整互操作

**客户端**

- 每请求 `_meta`：协议版本 / 客户端能力 / 客户端信息 / OTel trace（traceparent/tracestate/baggage）。
- `server/discover` 双栈协商；MRTR `input_required` → `inputResponses` 重试（原样 `requestState`，≤3 轮）；
- `subscriptions/listen` 首帧 ack、过滤、关闭；
- OAuth：`iss`（RFC 9207）校验、CIMD `application_type`、跨 issuer 凭据隔离、refresh 日志脱敏；
- SDK 1.32 不支持 2026-07-28 时**如实声明**实际版本，auto 走内置 v2，不假装。

**服务端**

- 每请求 `_meta` 校验（不支持版本 `-32022`，缺能力 `-32021`）；
- 结果 `resultType` + `_meta.serverInfo`；`extensions` 协商；
- CacheableResult：tools/prompts/resources list、resources/read、templates、discover 均带 `ttlMs`/`cacheScope`；
- MRTR 服务端：HMAC `requestState` 绑定 method/session/args/TTL；ask_user/审批 handler 可往返；
- `subscriptions/listen`：ack 必为首条、4 类过滤、resourceSubscriptions、cancelled、连接上限；
- `McpSseResponseTransport` 长生命周期 POST/SSE 分流；stdio 旧栈不破；
- 工具清单完整性：**同名工具描述/schema 变化拒绝**（防 rug-pull），纯增删允许并重新基线；`OMNI_MCP_ALLOW_TOOL_CHANGES=1` 显式放行。

**判据**：MCP 21 files / 123 tests；`mcp:conformance` 86；新增 4 文件 49 例（server/client/security/serve）。

**仍未做（如实）**：完整 Streamable HTTP 服务端路由（HTTP 头校验/400 映射）需宿主 HTTP 层；MRTR 仅 tools/call；官方 tasks/UI 扩展实体；弃用 roots/sampling/logging；blob 资源；客户端 TTL 缓存；OAuth 8414/DCR；`requestState` 非单次使用。

## 4. ACP / A2A 1.0 / AG-UI

- **ACP v1**：`omniharness acp` JSON-RPC over stdio；initialize/session new|load|prompt|cancel、工具/计划/思考事件、权限请求/响应、stopReason；`--acp-permission client|auto`；真实 Agent 映射。9 例。
- **A2A 1.0**：`message/send`、`message/stream`、`tasks/get|cancel|subscribe`、`tasks/list`、push notification config set/get/list/delete + webhook、`agent/getCard`、authenticated extended card；HTTP/WS 流式与 Authorization assertion；保留旧最小面。7 例 + 17 回归 + 7 E2E。
- **AG-UI**：事件映射 RUN/TEXT/TOOL/STATE/REASONING/CUSTOM/FINISHED/ERROR；独立 `POST /agui` SSE、health、断连 abort、取消 RUN_ERROR。5 例。
- 文档：`docs/PROTOCOL_ECOSYSTEM.md`；`docs/README.md`、`docsLayout` 白名单登记。

**仍未做**：ACP authenticate/logout/session-close/list/resume、Client MCP server、fs/terminal 反向调用、image/audio prompt；A2A gRPC/HTTP+JSON 绑定、AgentCard JWS、AUTH_REQUIRED 完整交互、分页游标；AG-UI STATE_DELTA/ACTIVITY/子代理事件。

## 5. Per-action 授权 + 工具哈希

- `src/security/toolIntentPolicy.ts`：intent 分类（read/write/delete/exec/network/external/memory/state）+ 破坏性命令识别；`off|shadow|enforce`，默认 **shadow**（只记高风险，不改行为）；enforce 拒绝高风险。
- 接入 `ToolGate`（监督内核之后、审批之前）。
- `src/mcp/mcpToolIntegrity.ts` + `McpGateway`：会话内工具清单指纹；同名描述/schema 变化拒绝，纯增删允许。
- 判据：intent 4 例、integrity 3 例；MCP 生命周期回归通过。

## 6. 记忆时间图 / 事实卡（P2-1）

- `src/adapters/memory/temporalFactGraph.ts`：`TemporalFactGraph` 维护 subject/predicate/object + factId + validFrom/validTo + trust；规则抽取（箭头、use/require/prefer/own、系动词、冒号），实体归一化；同一 s+p 新事实关闭旧边；召回按 s/p/o 的 Dice 重合度，过滤 validTo/expiresAt；`consolidate()` 只合并派生索引、不删事实。
- `FileLongTermMemory` 默认启用图（第 6 个构造参数 `temporalGraph=true` 可关）；`load/remember/update/updateMany/delete` 同步维护；`recall` 按 factId `max(BM25, 图分)` 合并后仍走 `TimeDecay`；重启从 facts 重建。
- `ResonantFieldEngine` 默认包装器也探测 `temporalRecall` 并 max 合并，确保生产默认路径真正吃到图信号。
- 判据：temporalFactGraph 9 例；fileLongTermMemory +5 例（含关图正对照、图不改变排序、重启重建、consolidate 不删事实）；resonantField +1 接线例。
- 边界：规则抽取不是语义解析（中文关系句不建边）；同一 s+p 视为单值；validTo 只过滤图候选，不反删 BM25 命中。

## 7. 容器沙箱（P2-2）

- `src/adapters/sandbox/containerSandbox.ts`：`ContainerSandbox`（`name='container'`），Docker/Podman 运行时探测（3s、失败/超时/ENOENT fail-closed）；`check` 对 file_read/file_write 做 workspace 前缀校验，越界 `category:'path'`；`wrapCommand` 生成 `--network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp`、workspace rw bind、POSIX/Windows 引号转义。
- 接线：`SandboxProfile`/`SANDBOX_PROFILES`/`SandboxManager`/`SandboxCapabilityTable`/`doctor`/`ConfigError`/`adapters/index`/`cliHelp` 全部加 `container`；默认仍是 `policy`。
- 判据：`containerSandbox` 12 例；相关 sandbox/CLI/doctor 92 passed / 1 skipped。
- 边界：容器共享宿主内核，不是 microVM；`--read-only` 只保护容器根，workspace 是 rw；默认断网；Windows 依赖 Docker Desktop/WSL2；无运行时即 fail-closed。

## 8. 结构收口

- `McpServer` 从 45 成员拆为 **16**：`McpSubscriptionService`（8）、`McpInputRequiredService`（8）、`McpMethodService`（19）；协议行为/错误码/trace/cache/requestState/订阅语义逐字保持；MCP 49 例 + 回归全绿。
- `ConfigError` 的 `isPlainObject` 移到模块级，解除 501 codeLines 边缘；`temporalFactGraph` 24 成员；`resonantFieldEngine` 保持基线。编码标准增量门禁恢复全绿。

## 9. 协议/模型扩展（第二轮）

- **MCP Streamable HTTP**：新增 `McpHttpServer`（node:http，POST/GET/OPTIONS、1 MiB/读超时、批量、SSE `subscriptions/listen`、头校验 `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name`、400/406/408/413/415 映射、`listen()` 端口 0、`close()` 幂等）；`mcp serve --mcp-http-port` 接线，未给端口仍 stdio。19 例。
- **ACP 生命周期**：`session/close|list|resume`、`authenticate/logout`（注入式 `AcpAuthenticator`，默认拒绝）、close 幂等/取消/权限收尾、closed 墓碑、`requireAuth`；23 例。
- **A2A 1.0 余项**：AgentCard JWS（Ed25519 + RFC 8785 稳定序列化，无 key 不伪造）、`auth_required` 状态机（无凭据 fail-closed，凭据续跑）、`tasks/list` HMAC 分页与过滤绑定；24 例。
- **AG-UI 余项**：RFC 6902 `STATE_DELTA`（add/replace/remove）、`ACTIVITY_SNAPSHOT/DELTA`（工具/subagent）、`MESSAGES_SNAPSHOT`；14 例。
- **Gemini 原生适配器**：`GeminiModel`（generateContent/streamGenerateContent、函数调用、thinkingBudget、usage/cache、错误/超时/取消、API key fail-closed），注册到适配器清单/CLI/端点；22 例。
- 明确不实现：A2A gRPC/HTTP+JSON 绑定、MCP 官方 tasks/UI 扩展、ACP Client MCP server/fs/terminal 反向调用。

## 10. 门禁结果

| 项目                            | 结果                                            |
| ------------------------------- | ----------------------------------------------- |
| `tsc --noEmit`                  | ✅                                              |
| `npm run check`                 | ✅ 1229 文件零违规                              |
| `npm run lint`                  | ✅ 0 warning                                    |
| `npm run format:check`          | ✅                                              |
| `npm run arch:gate -- --strict` | ✅ 0 新增                                       |
| `npm run api:check`             | ✅                                              |
| `npm run audit:config-wiring`   | ✅                                              |
| `npm run check:doc-links`       | ✅                                              |
| `auditStandards --delta`        | ✅ 0 新增（含拆分后的 mcpServer）               |
| 全量单测                        | **639 files / 4,009 tests passed**（7 skipped） |
| 集成                            | **7/7 files、17/17 tests**                      |
| `eval:long --self-check`        | **20/20**                                       |
| `probe:recall:both --strict`    | ✅（57.6% vs 42.4%，fallback 0）                |

**明确不支持/外部依赖**：A2A gRPC 与 HTTP+JSON/REST 绑定（现有传输只承载 JSON-RPC，无真实客户端可验）；MCP 官方 tasks/UI 扩展与客户端 TTL 缓存；ACP Client 提供的 MCP server、fs/terminal 反向调用、image/audio prompt；AG-UI STEP/SUBAGENT/RAW 主动事件；Gemini 仅内联 base64 图片/PDF（Files API 未接）、Bedrock 原生适配未做。以上均在模块注释与 `docs/PROTOCOL_ECOSYSTEM.md` 登记。
