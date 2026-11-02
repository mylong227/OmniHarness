# 环境变量参考（ENV REFERENCE）

> 本文档由源码读点**自动编译**（2026-11-01，扫描 `src/` 全部 `process.env` 读取点并从读点注释提炼）。
> 约定：新增任何 `OMNI_*` 旋钮时**同步补一行**（变量 / 用途 / 取值 / 首个读点位置），否则文档与代码漂移。
> 核心安全项（`OMNI_SERVE_HOST` / `OMNI_GC_*` / `OMNI_EGRESS_*` 等）另有 `--help` 与 `docs/CLI_REFERENCE.md` 双口径，此处是全量清单。

## 归属与维护

| 变量                              | 用途                                            | 取值/默认                      | 位置                               |
| --------------------------------- | ----------------------------------------------- | ------------------------------ | ---------------------------------- |
| `OMNI_HOME`                       | 用户级状态归属根（整体搬盘唯一旋钮）            | 路径；缺省 `~/.omniharness`    | src/kernel/util/omniHome.ts               |
| `OMNI_TMP_DIR`                    | 项目临时根（Chrome user-data、worktree 副本等） | 路径；缺省 `<home>/tmp`        | src/kernel/util/omniHome.ts               |
| `OMNI_SESSIONS_DIR`               | 会话事件落盘目录覆盖（写入方与读取方共用）      | 路径；缺省 `<home>/sessions`   | src/kernel/util/sessionStorageLocation.ts |
| `OMNI_MAINTENANCE`                | 维护巡检总开关                                  | `off\|0\|false` 全停；其余启用 | src/kernel/util/maintenanceRunner.ts      |
| `OMNI_MAINTENANCE_INTERVAL_HOURS` | serve 常驻巡检间隔                              | 小时数，缺省 6                 | src/kernel/util/maintenanceRunner.ts      |
| `OMNI_GC_KEEP`                    | 会话存档保留最新 N 组                           | 整数 ≥0，缺省 50               | src/kernel/util/maintenanceRunner.ts      |
| `OMNI_GC_MAX_AGE_DAYS`            | 存档可删年龄                                    | 天数 >0，缺省 90               | src/kernel/util/maintenanceRunner.ts      |
| `OMNI_GC_MAX_BYTES`               | 存档总量上限                                    | 字节数 >0，缺省 4 GiB          | src/kernel/util/maintenanceRunner.ts      |

## 网络与超时

| 变量                                                                                                                                                                  | 用途                                                                                                                                       | 取值/默认                                                       | 位置                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------- |
| `OMNI_NETWORK_ALLOW`                                                                                                                                                  | CLI `--network-allow` 白名单落进进程环境；shell 策略据此拦 curl/wget 等带外通道                                                            | 逗号分隔主机；**变量存在即触发拦截**                            | src/kernel/adapters/tool/shell/shellCommandPolicy.ts |
| `OMNI_SSRF_STRICT`                                                                                                                                                    | SSRF 严格模式（连私有网段一并拦；云元数据永远拦）                                                                                          | `1` 开启；缺省放行私网                                          | src/kernel/security/ssrfGuard.ts                     |
| `OMNI_EGRESS_ALLOW_PRIVATE`                                                                                                                                           | 出站允许私网/回环目标                                                                                                                      | `1` 放行；缺省拦                                                | src/kernel/security/egressPolicy.ts                  |
| `OMNI_EGRESS_ALLOW_HOSTS`                                                                                                                                             | 出站主机白名单（支持 `.suffix`）                                                                                                           | 逗号分隔；空=不限                                               | src/kernel/security/egressPolicy.ts                  |
| `OMNI_EGRESS_ALLOW_PORTS`                                                                                                                                             | 出站端口白名单                                                                                                                             | 逗号分隔数字；空=不限                                           | src/kernel/security/egressPolicy.ts                  |
| `OMNI_MODEL_REQUEST_TIMEOUT_MS`                                                                                                                                       | 单次模型请求空闲超时                                                                                                                       | 毫秒，缺省 300000；`0`/负=关                                    | src/kernel/adapters/model/modelRequestGuard.ts       |
| `OMNI_APPROVAL_UPLINK_TIMEOUT_MS`                                                                                                                                     | 审批上行超时（到点按 deny 兑现）                                                                                                           | 缺省 120s，0=不限时                                             | src/apps/server/core/serverEventBridge.ts          |
| `OMNI_QUESTION_UPLINK_TIMEOUT_MS`                                                                                                                                     | 提问上行超时（到点按「未拿到回答」fail-soft）                                                                                              | 缺省 300s，0=不限时                                             | src/apps/server/core/serverEventBridge.ts          |
| `OMNI_CLIENTS_GONE_GRACE_MS`                                                                                                                                          | 「浏览器全部断开」宽限期：刷新/抖动不立即收尾挂起的审批与提问，宽限期内复联可恢复作答（配 `approval.pending`/`question.pending` 恢复 RPC） | 毫秒，缺省 10000；0=旧同步立即语义                              | src/apps/server/transport/httpBridgeTransport.ts   |
| `OMNI_A2A_SEND_TIMEOUT_MS` / `OMNI_A2A_READ_TIMEOUT_MS` / `OMNI_A2A_MAX_BODY_BYTES`                                                                                   | A2A 出站/入站超时与请求体上限                                                                                                              | 毫秒/字节，缺省 10000/30000/1 MiB                               | src/protocols/a2a/httpA2aTransport.ts                   |
| `OMNI_A2A_CLIENT_TIMEOUT_MS` / `OMNI_A2A_WEBHOOK_TIMEOUT_MS`                                                                                                          | A2A 委托挂起 / webhook 投递超时                                                                                                            | 毫秒，缺省 60000 / 10000（config > env > defaults/limits.json） | src/kernel/util/runtimeLimits.ts                     |
| `OMNI_WEB_FETCH_TIMEOUT_MS` / `OMNI_WEB_FETCH_MAX_BYTES`                                                                                                              | web_fetch 缺省超时与响应体上限                                                                                                             | 缺省 30000 / 200000（有硬上限）                                 | src/kernel/util/runtimeLimits.ts                     |
| `OMNI_HTTP_HEADERS_TIMEOUT_MS` / `_REQUEST_TIMEOUT_MS` / `_MAX_CONNECTIONS` / `_MAX_BODY_BYTES`                                                                       | HTTP Slowloris 防护与并发/体积限额（SSE 不受请求时限约束）                                                                                 | 缺省 30000 / 60000 / 2048 / 8 MiB                               | src/kernel/util/runtimeLimits.ts                     |
| `OMNI_HTTP_STATIC_CACHE_MAX_ENTRIES` / `_MAX_BYTES`                                                                                                                   | 静态资源缓存上限                                                                                                                           | 缺省 64 / 64 MiB                                                | src/kernel/util/runtimeLimits.ts                     |
| `OMNI_PREVIEW_HEADERS_TIMEOUT_MS` / `_REQUEST_TIMEOUT_MS` / `_MAX_CONNECTIONS`                                                                                        | 工作区网页预览源（独立回环端口）限额                                                                                                       | 缺省 15000 / 30000 / 64                                         | src/kernel/util/runtimeLimits.ts                     |
| `OMNI_LSP_REQUEST_TIMEOUT_MS` / `OMNI_LSP_DIAGNOSTICS_TIMEOUT_MS`                                                                                                     | LSP 请求与 diagnostics 等待时限                                                                                                            | 缺省 15000 / 5000                                               | src/kernel/util/runtimeLimits.ts                     |
| `OMNI_BROWSER_ACTION_TIMEOUT_MS` / `_LOAD_TIMEOUT_MS` / `_COMMAND_TIMEOUT_MS` / `_CONNECT_TIMEOUT_MS` / `_LAUNCH_TIMEOUT_MS` / `_PROBE_TIMEOUT_MS` / `_IDLE_CLOSE_MS` | 浏览器动作/加载/CDP 命令/建连/启动/探测超时与空闲自动关闭                                                                                  | 缺省 10000/30000/20000/15000/30000/5000/180000                  | src/kernel/util/runtimeLimits.ts                     |

## A2A

| 变量                                                                                                    | 用途                                                                        | 取值/默认                       | 位置                          |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------- | ----------------------------- |
| `OMNI_A2A_HOST`                                                                                         | A2A 服务绑定主机                                                            | 缺省 `127.0.0.1`                | src/protocols/a2a/httpA2aTransport.ts   |
| `OMNI_A2A_INSECURE`                                                                                     | 无 Agent 身份时允许启动 A2A（免验签）                                       | `1` 放行；缺省 fail-closed 拒启 | src/apps/composition/runtime.ts    |
| `OMNI_A2A_PAGE_TOKEN_SECRET` / `_PAGE_SIZE` / `_PAGE_TOKEN_TTL_MS`                                      | tasks/list 游标 HMAC 密钥 / 页大小 / 游标有效期                             | 缺省随机 32B / 50 / 24h         | src/protocols/a2a/a2aTaskPager.ts       |
| `OMNI_A2A_MAX_TASKS` / `_MAX_ARTIFACTS_PER_TASK` / `_MAX_PUSH_CONFIGS_PER_TASK` / `_MAX_PUSH_TASKS`     | 任务记录 / 单任务 artifact / 单任务 push 配置 / push 桶总数上限             | 缺省 500 / 200 / 20 / 500       | src/protocols/a2a/a2aTaskStore.ts       |
| `OMNI_A2A_SIGN_CARD` / `_CARD_KEY_JWK` / `_CARD_KEY_FILE` / `_CARD_KID` / `_CARD_JKU` / `_CARD_TTL_SEC` | AgentCard JWS 签名族（想签 / 内联 JWK / 密钥文件 / key id / JWKS / 有效期） | JWK 优先于 FILE                 | src/protocols/a2a/a2aAgentCardSigner.ts |

## 检索与上下文（含记忆）

| 变量                                                                                                                                                                                                    | 用途                                                        | 取值/默认                                 | 位置                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `OMNI_SEMANTIC_RECALL`                                                                                                                                                                                  | 语义混合检索开关（CLI 进程缺省开，库直用缺省关）            | `1` 开；`0` 显式关                        | src/kernel/config/configFactory.ts                                                               |
| `OMNI_HF_ENDPOINT` / `HF_ENDPOINT`                                                                                                                                                                      | HuggingFace 下载镜像源（本项目命名空间优先）                | host                                      | src/kernel/adapters/embedding/transformersEmbeddingAdapter.ts                                    |
| `OMNI_EMBED_PRELOAD`                                                                                                                                                                                    | 装配期后台预热嵌入管线                                      | `1` 开                                    | 同上                                                                                      |
| `OMNI_EMBEDDING_CACHE_DIR` / `OMNI_EMBEDDING_OFFLINE` / `OMNI_VEC_CACHE`                                                                                                                                | 嵌入权重缓存目录 / 只用本地权重 / 向量落盘缓存目录          | `OMNI_VEC_CACHE` 不可写退化为内存         | src/kernel/config/configFactory.ts                                                               |
| `OMNI_EMBED_BATCH`                                                                                                                                                                                      | 嵌入批大小（应急/调参）                                     | 整数 ≥1；缺省按维度推算                   | src/kernel/context/semanticIndex.ts                                                              |
| `OMNI_REPO_MAP` / `OMNI_REPO_MAP_TTL_MS`                                                                                                                                                                | repo map 开关 / 语料索引 TTL                                | `0` 关；TTL 缺省 30000                    | src/kernel/core/agent.ts、src/kernel/context/corpusIndexCache.ts                                        |
| `OMNI_RRF_K` / `OMNI_SEM_WEIGHT` / `OMNI_BM25_FLOOR` / `OMNI_MERGE_SYMBOLS` / `OMNI_CHUNK_RECALL` / `OMNI_FULL_FILE_DOC` / `OMNI_DOC_MODE` / `OMNI_GRAPH_SIGNAL` / `OMNI_GRAPH_WEIGHT` / `OMNI_PAYLOAD` | 检索融合与载荷形态旋钮族（见读点注释）                      | 各有缺省；详见 src/kernel/context/recallKnobs.ts | src/kernel/context/recallKnobs.ts                                                                |
| `OMNI_RERANK` / `OMNI_RM3`                                                                                                                                                                              | 检索重排 / RM3 伪相关反馈                                   | `1` 开；缺省关                            | src/kernel/context/repoMap/repoMapContextEngine.ts                                               |
| `OMNI_CONTEXT_WINDOW`                                                                                                                                                                                   | 上下文窗口 token 数（压缩阈值与 UI 容量分母，可纠正厂商表） | token 数；缺省按模型名查目录              | src/kernel/core/agentCompactor.ts                                                                |
| `OMNI_CONTEXT_SHAPERS`                                                                                                                                                                                  | 上下文整形器                                                | `0` 关；缺省开                            | src/kernel/core/stepContextBuilder.ts                                                            |
| `OMNI_MEMORY_TRUSTED_ONLY` / `OMNI_MEMORY_PRIMER` / `OMNI_MEMORY_FORGETTING`                                                                                                                            | 长期记忆只信 trusted / 开场 primer / 间隔重复遗忘           | `1` 开；缺省关                            | src/kernel/core/agent.ts、src/kernel/core/sessionInjector.ts、src/kernel/adapters/memory/fileLongTermMemory.ts |

## 模型与预算

| 变量                                                                        | 用途                                              | 取值/默认                                     | 位置                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `OMNI_MAX_OUTPUT_TOKENS`                                                    | 单次响应输出上限                                  | 正整数；未设=不限定                           | src/kernel/core/agentLimits.ts                                                              |
| `OMNI_TURN_TOKEN_BUDGET` / `OMNI_TURN_SOFT_TOKEN_BUDGET`                    | 回合硬/软 token 预算（软预算只提醒不截断）        | 硬 0=关；软缺省 5,000,000（有硬预算取其 80%） | src/kernel/core/agentLimits.ts                                                              |
| `OMNI_REASONING_POLICY`                                                     | 推理预算分层策略                                  | `balanced`（缺省）/ `off`                     | src/kernel/util/reasoningBudget.ts                                                          |
| `OMNI_REVIEW_MODEL`                                                         | reviewer 独立模型（须命中 `modelRouter.entries`） | entry 模型名                                  | src/kernel/config/configFactory.ts                                                          |
| `OMNI_REVIEW` / `OMNI_REVIEW_BLOCK`                                         | 独立 diff 审查开关 / blocker 是否阻断             | `off\|0` 关；`1` 阻断                         | src/apps/composition/runtime.ts、src/kernel/core/agent.ts                                        |
| `OMNI_NATIVE_TOKEN_ACCOUNTING`                                              | token 记账走 Rust 原生路径（逃生口）              | `1\|true` 开                                  | src/kernel/core/nativeTokenAccounting.ts                                                    |
| `OMNI_PLANNING_GUARD` / `_MIN_CHARS` / `_MIN_ACTIONS`                       | 回合级规划强制与复杂任务判定阈值                  | `0` 关；缺省 240 / 1                          | src/kernel/core/planning/taskComplexityClassifier.ts                                        |
| `OMNI_LOOPGUARD` / `OMNI_LOOP_MAX_MS` / `OMNI_LOOP_SOFT_MS`                 | 循环守卫开关 / 回合硬时限 / 软时限                | 缺省开 / 8h / 30min                           | src/kernel/core/loop/loopGuard.ts                                                           |
| `OMNI_LONG_HORIZON` / `_TASK` / `_VERIFY`                                   | 长时程协议开关 / 显式 slug / 验证命令             | `1` 强制开 `0` 强制关                         | src/kernel/core/longHorizonCoordinator.ts                                                   |
| `OMNI_SKILL_BUDGET_CHARS` / `OMNI_AGENTS_SKILLS` / `OMNI_SKILL_TRUSTED_KEY` | 技能注入预算 / 额外技能目录 / 签名技能验签锚      | 缺省 12000 / 关 / 未配即拒签名包              | src/kernel/core/sessionInjector.ts、src/kernel/skill/skillMdDiscovery.ts、src/apps/cli/cliSkillFlags.ts |
| `OMNI_TOOL_EXPOSURE` / `OMNI_TOOL_DOMAIN_LOCKS`                             | 工具暴露规划 / 资源域互斥锁                       | `off`；`0` 关                                 | src/kernel/core/toolExposurePlanner.ts、src/kernel/core/toolResourceGate.ts                        |
| `OMNI_CACHE_HIT_WARN`                                                       | prompt 缓存命中率坍塌告警阈值                     | 0–100，缺省 50                                | src/kernel/observability/cacheHitRateWatch.ts                                               |
| `LAYA_PYTHON_BIN` / `LAYA_MODEL_DIR`                                        | 决策引擎 Python 解释器 / 本地权重目录             | 缺省项目内 venv / third-party                 | src/kernel/adapters/laya/layaPaths.ts                                                       |

## 媒体

| 变量                                                                                | 用途                                 | 取值/默认                         | 位置                                |
| ----------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------- | ----------------------------------- |
| `OMNI_MEDIA_MAX_FRAMES` / `_MAX_DIMENSION` / `_TIMEOUT_MS` / `_PROCESS_CONCURRENCY` | 抽帧数 / 帧边长 / 超时 / ffmpeg 并发 | 1–32 / 128–4096 / 1000–600000 / 4 | src/kernel/config/mediaConfigResolver.ts   |
| `OMNI_FFMPEG_PATH` / `OMNI_FFPROBE_PATH`                                            | ffmpeg / ffprobe 可执行文件路径      | 缺省 PATH 探测                    | src/kernel/adapters/media/ffmpegLocator.ts |

## 安全与沙箱

| 变量                                                             | 用途                                           | 取值/默认                             | 位置                                          |
| ---------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------- | --------------------------------------------- |
| `OMNI_SHELL_POLICY`                                              | shell 命令策略模式                             | `enforce` 强制；缺省 `audit`          | src/kernel/adapters/tool/shell/shellCommandPolicy.ts |
| `OMNI_SHELL_CONCURRENCY` / `_QUEUE_PER_SESSION` / `_QUEUE_TOTAL` | shell 并发与排队限额                           | 缺省 8 / 64 / 256                     | src/kernel/config/configToolRegistry.ts              |
| `OMNI_CONTAINER_IMAGE` / `OMNI_CONTAINER_BIN`                    | 容器沙箱镜像 / 运行时二进制                    | 缺省 `node:22-alpine` / docker→podman | src/kernel/adapters/sandbox/containerSandbox.ts      |
| `OMNI_LANDLOCK_HELPER`                                           | Linux Landlock helper 路径                     | 空=未配置                             | src/kernel/adapters/sandbox/linuxLandlockSandbox.ts  |
| `OMNI_SELF_VERIFY_TIMEOUT_MS`                                    | 自验证（构建+单测）超时                        | 正整数毫秒，缺省 300000               | src/kernel/adapters/tool/verify/selfVerifyPolicy.ts  |
| `OMNI_PROVENANCE_GUARD`                                          | 来源追踪闸（写类工具参数含不可信外部输出即拒） | `1`=enforce；`0`=off                  | src/kernel/core/stepToolExecutor.ts                  |
| `OMNI_INTENT_POLICY`                                             | 工具意图策略（未知值 fail-closed）             | `off\|shadow\|enforce`；缺省 `shadow` | src/kernel/security/toolIntentPolicy.ts              |

## MCP

| 变量                                            | 用途                                               | 取值/默认                     | 位置                               |
| ----------------------------------------------- | -------------------------------------------------- | ----------------------------- | ---------------------------------- |
| `OMNI_MCP_ALLOWLIST` / `OMNI_MCP_ALLOW`         | MCP 服务器白名单（两个历史名互为回退）             | 逗号分隔；空=全部允许         | src/protocols/mcp/mcpGateway.ts              |
| `OMNI_MCP_ALLOW_TOOL_CHANGES`                   | 允许会话内 MCP 工具清单变化（tool poisoning 防线） | `1` 允许；缺省拒绝并落警报    | src/protocols/mcp/mcpToolIntegrity.ts        |
| `OMNI_MCP_PROTOCOL` / `OMNI_MCP_SERVE_PROTOCOL` | 客户端协议栈 / serve 端协议偏好                    | 缺省 `auto`                   | src/protocols/mcp/mcpProtocolNegotiator.ts   |
| `OMNI_MCP_TOKENS_FILE`                          | MCP OAuth 令牌存储文件                             | 缺省 `<home>/mcp-tokens.json` | src/protocols/mcp/mcpAuthFlow.ts             |
| `OMNI_MCP_REQUEST_STATE_SECRET`                 | input_required 回传 requestState 的 HMAC 密钥      | 缺省随机 32B                  | src/protocols/mcp/mcpInputRequiredService.ts |

## 许可、身份与插件

| 变量                                                                                                                                                           | 用途                                                                 | 取值/默认                                                 | 位置                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- |
| `OMNI_LICENSE` / `OMNI_LICENSE_FILE` / `OMNI_LICENSE_PUBLIC_KEY`                                                                                               | license 内联文本 / 文件路径 / 验签公钥                               | FILE 优先于内联；缺/半配=core 档                          | src/apps/license/licenseSource.ts                |
| `OMNI_REGISTRY_URL` / `OMNI_REGISTRY_MAX_RESPONSE_BYTES`                                                                                                       | 插件市场 registry 地址 / 响应上限                                    | 缺省 16 MiB                                               | src/kernel/plugin/pluginRegistry.ts                |
| `OMNI_ALLOW_REMOTE_PLUGINS` / `OMNI_PLUGIN_REQUIRE_SIGNATURE` / `OMNI_PLUGIN_PERMISSIONS` / `OMNI_PLUGIN_REQUIRE_OS_SANDBOX` / `OMNI_PLUGIN_WORKER_PERMISSION` | 远程插件加载 / 强制验签 / 权限白名单 / OS 沙箱强制 / worker 权限参数 | 缺省禁远程 / 不强制 / 非危险集 / 强制 / 加 `--permission` | src/kernel/plugin/pluginLoader.ts 等               |
| `OMNI_PLUGIN_ENTRY` / `_WORKER_SESSION` / `_NAME` / `_WORKER_MAX_FRAME_BYTES`                                                                                  | worker 子进程父→子传递项                                             | 帧缺省 1 MiB                                              | src/kernel/plugin/worker/workerSpawnSpecBuilder.ts |

## 遥测与日志

| 变量                                                                           | 用途                                                 | 取值/默认   | 位置                                       |
| ------------------------------------------------------------------------------ | ---------------------------------------------------- | ----------- | ------------------------------------------ |
| `OMNI_LOG_LEVEL`                                                               | 结构化日志级别                                       | 缺省 `info` | src/kernel/util/logger.ts                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `_METRICS_ENDPOINT` / `OMNI_OTLP_SERVICE_NAME` | OTLP trace/metrics 端点与服务名（设了才包 exporter） | URL         | src/kernel/observability/traceExporterAssembly.ts |

## serve 与审计

| 变量                                                                                   | 用途                                                                 | 取值/默认                     | 位置                        |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------- | --------------------------- |
| `OMNI_BACKEND_PORT`                                                                    | serve 后端端口（`--port` 旗标更高）                                  | 缺省 8787                     | src/apps/cli/serveDefaults.ts    |
| `OMNI_SERVE_HOST` / `OMNI_SERVE_TOKEN`                                                 | 绑定地址（非回环必须配令牌）/ Bearer 令牌                            | 缺省 127.0.0.1 / 回环自动临时 | src/apps/cli/cliServerCmds.ts    |
| `OMNI_READY_FILE` / `OMNI_NO_UI_URL` / `OMNI_CONTROL_STDIO` / `OMNI_NO_SERVE_INSTANCE` | 桌面就绪文件 / 抑制带 token URL / stdin 控制通道 / 跳过 pid 实例管理 | `1` 启用对应行为              | src/apps/cli/serveAnnounce.ts 等 |
| `OMNI_AUDIT_DIR` / `OMNI_AUDIT_HMAC_KEY`                                               | 审计落盘目录 / 审计链 HMAC 密钥（绝不落盘）                          | 均无=no-op / 缺省无 HMAC      | src/apps/cli/auditCommand.ts     |

## 厂商 key 与浏览器

| 变量                                                                                          | 用途                                                        | 取值/默认                    | 位置                                        |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------- | ------------------------------------------- |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`                                                        | OpenAI 兼容 / Anthropic 适配器凭据（也由凭据保险库水合）    | key；缺省 fail-closed        | src/apps/server/services/modelCatalogService.ts  |
| `GEMINI_API_KEY`（`GOOGLE_API_KEY` 备用）/ `GEMINI_BASE_URL` / `GEMINI_MODEL`                 | Gemini 原生适配器                                           | 缺省 `gemini-2.5-flash`      | src/kernel/adapters/model/geminiModel.ts           |
| `BRAVE_API_KEY` / `TAVILY_API_KEY`                                                            | web_search provider 凭据（Brave 优先）                      | 无 key 则不注册 `web_search` | src/kernel/adapters/tool/web/webSearchProviders.ts |
| `OMNI_CHROME_PATH`（`CHROME_PATH` 通用约定兜底）/ `OMNI_CDP_ENDPOINT` / `OMNI_BROWSER_ENGINE` | Chrome 路径 / 外部 CDP 端点（设置即复用不再自启）/ 引擎强制 | —                            | src/kernel/adapters/browser/chromeLocator.ts 等    |

## 配置覆盖（`OMNIHARNESS_*` → omniharness.json）

`OMNIHARNESS_MODEL_ADAPTER` / `_BASE_URL` / `_API_KEY` / `_MODEL` / `_STORAGE_ADAPTER` / `_STORAGE_DIR` / `_APPROVAL` / `_REASONING` / `_SANDBOX` / `_ESCALATION` / `_ELEVATED_SANDBOX` / `_WORKSPACE` / `_MAX_STEPS` —— 逐字段覆盖用户/项目配置（数字字段做 coerce）。见 src/kernel/config/configError.ts 映射表。

## 凭据保险库与加密

| 变量                                          | 用途                                      | 取值/默认                        | 位置                                   |
| --------------------------------------------- | ----------------------------------------- | -------------------------------- | -------------------------------------- |
| `OMNIHARNESS_VAULT_KEY` / `OMNIHARNESS_VAULT` | 保险库 AES 主密钥（推荐，不落盘）/ 总开关 | `0\|off\|false` 连密钥文件都不建 | src/apps/cli/vaultKeyDefaults.ts            |
| `OMNIHARNESS_MEMORY_KEY`                      | 长期记忆 AES-256-GCM 主密钥               | 级联密钥文件 → 兜底随机          | src/kernel/adapters/memory/aesGcmTextCodec.ts |
| `OMNIHARNESS_CRED_<NAME>`                     | EnvVault 免落盘回退的凭据读取前缀         | NAME 大写                        | src/kernel/adapters/vault/envVault.ts         |

## 推送闸与测试（非 src 运行时）

| 变量                                                                | 用途                                              | 位置                                |
| ------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------- |
| `OMNI_ALLOW_FOREIGN_PUSH` / `OMNI_STRICT_PUSH`                      | 推送闸放行 / 硬拦截（scripts/git-hooks/pre-push） | scripts/git-hooks/pre-push          |
| `OMNI_UI_BASELINE_UPDATE`                                           | UI 结构基线重写开关（类似 `jest -u`）             | tests/integration/liveUiE2e.test.ts |
| `OMNI_REQUIRE_BROWSER` / `OMNI_BROWSER_NONE` / `OMNI_PROBE_WAIT_MS` | web 判据浏览器开关与探针等待                      | web/test/browserSwitch.ts 等        |
