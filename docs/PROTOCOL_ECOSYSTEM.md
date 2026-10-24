# 协议生态适配（ACP / A2A / AG-UI）

本仓在既有私有 JSON-RPC 面上补齐三条生态协议。三者互不替代：**ACP 是编辑器连接层**、
**A2A 是 agent 间互操作层**、**AG-UI 是 agent ↔ 用户界面的事件层**。

## 1. ACP v1（Agent Client Protocol）

```bash
# 由编辑器（Zed / JetBrains 等）以子进程方式启动，JSON-RPC 2.0 over stdio
omniharness acp [--acp-permission client|auto]
```

| 方法                         | 方向                   | 说明                                                                                                                      |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                 | Client → Agent         | 协商协议版本（整数 `1`）与能力：`loadSession` / `promptCapabilities` / `mcpCapabilities` / `sessionCapabilities` / `auth` |
| `authenticate`               | Client → Agent         | 用 initialize 通告的 `methodId`（可选 `token`）完成认证；成功后身份记录到连接与活跃会话                                   |
| `logout`                     | Client → Agent         | 清除连接与全部活跃会话上的认证身份（幂等）                                                                                |
| `session/new`                | Client → Agent         | 以绝对路径 `cwd` 创建会话，返回 `sessionId`（同时是 Agent 会话 id）                                                       |
| `session/load`               | Client → Agent         | 加载既有会话，并以 `session/update` 回放 `user_message_chunk` / `agent_message_chunk` / 工具事件                          |
| `session/list`               | Client → Agent         | 列出本连接内的活跃会话（`sessionId` / `cwd` / `title` / `updatedAt`）；可按 `cwd` 过滤，只读                              |
| `session/resume`             | Client → Agent         | 复用既有 `sessionId` 继续 prompt（**不回放**历史）；已 close / 不存在的会话返回 `-32602`                                  |
| `session/close`              | Client → Agent         | 取消在跑回合、释放 mapper / 运行时、移出活跃会话；重复 close 幂等；未知会话返回 `-32602`                                  |
| `session/prompt`             | Client → Agent         | 跑一轮提示；返回 `stopReason`（`end_turn` / `cancelled` / `max_turn_requests`）                                           |
| `session/cancel`             | Client → Agent（通知） | 中止回合；挂起的权限请求按 `cancelled` 收尾；对已 close 会话幂等                                                          |
| `session/update`             | Agent → Client（通知） | `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan`                                 |
| `session/request_permission` | Agent → Client（请求） | 写类工具执行前请求授权；响应 `selected` 或 `cancelled`                                                                    |

会话生命周期能力在 `initialize.agentCapabilities.sessionCapabilities` 中声明
`{ list: {}, resume: {}, close: {} }`；`session/close` 关闭的 id 允许随后用 `session/load`
重新加载（close 只释放活跃资源，不删除会话），但 `session/resume` 对已 close 的 id **fail-closed**。
`session/list` 不做游标分页（`cursor` 接受但忽略），标题取首轮 prompt 首行（最多 80 字符）。

认证是**端口注入**而非内置凭据：`AcpServerOptions.authenticator`（`AcpAuthenticator`）决定
`authMethods` 与 method/token 校验；未注入时 `authMethods: []`、`authenticate` 一律拒绝。
注入非空方式后 initialize 同时声明 `agentCapabilities.auth.logout = {}`。
`AcpServerOptions.requireAuth`（默认 `false`）开启后，未认证的 `session/new|load|list|resume|prompt`
返回 `-32000`（保持既有 Client 兼容）。仓库内**没有**任何硬编码 secret，CLI 默认不注入认证端口。

映射：`--acp-permission client`（默认）下，写类工具（`MUTATING_TOOL_NAMES`）向 Client 请求权限，
只读工具直接放行；`auto` 全部自动放行。提示中的 `resource` 文本会并入 prompt；`image`/`audio`
因未声明能力而明确拒绝。ACP 的 stdout **只写协议消息**，诊断一律走 stderr。

## 2. A2A v1.0

`--a2a` 启用后（`--a2a-port` / `--a2a-transport http|ws`），HTTP 传输提供 `POST /a2a`（JSON-RPC）
与 `GET /.well-known/agent-card.json`；流式方法自动以 `text/event-stream` 回写。

| 方法                                                  | 说明                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message/send`                                        | 创建并执行任务；`configuration.returnImmediately=true` 时后台执行、立即返回 submitted；带 `message.taskId` 时按「任务内认证续跑」语义处理（见下） |
| `message/stream`                                      | Task 快照 → `statusUpdate(working)` → `artifactUpdate` → `statusUpdate(final:true)`                                                               |
| `tasks/get`                                           | 查询任务（`id` 或 `taskId`）；`auth_required` 任务同样可查，challenge 在 `status.message.metadata` 与任务 `metadata`                              |
| `tasks/cancel`                                        | 取消在跑任务（`TaskNotCancelableError -32002` 表示已终态）                                                                                        |
| `tasks/subscribe`（别名 `tasks/resubscribe`）         | 订阅在跑任务；首帧当前 Task，终态收尾                                                                                                             |
| `tasks/list`                                          | 任务列表（可按 `contextId` / `state`（或 `status`）过滤）；`pageSize` / `pageToken` 游标分页，返回 `nextPageToken` 与 `pageSize`                  |
| `tasks/pushNotificationConfig/set\|get\|list\|delete` | webhook 配置；任务状态变化时 POST `StreamResponse`，带 `x-a2a-notification-token` 与可选 `Authorization`                                          |
| `agent/getCard`                                       | 公开 AgentCard（含 `protocolVersion` / `capabilities` / `securitySchemes`；配置签名器时带 `signatures`）                                          |
| `agent/getAuthenticatedExtendedCard`                  | 认证后的扩展卡；未签名/验签失败返回 `-32000`；配置签名器时带 JWS `signatures`                                                                     |

认证沿用既有 `AgentIdentityPort`：配置身份后，受保护方法校验 `params.assertion` 或
`params.message.metadata.assertion`；HTTP/WS 传输会把 `Authorization` 头原文注入 `assertion`。
AgentCard 在配置身份时声明 `securitySchemes.agentAssertion` 与 `security`，便于标准客户端发现认证要求。

### 2.1 AgentCard JWS 签名（规范 §8.4）

`A2aAgentCardSigner` 用 Ed25519 对**规范化卡片正文**签名：剔除 `signatures` 后按 RFC 8785 等价形式
（对象 key 字典序、剔除 `undefined`、无多余空白）序列化，签名输入为
`ASCII(protected ‖ "." ‖ BASE64URL(UTF8(正文)))`。`signatures[]` 条目为
`{ protected, signature }`，Protected Header 含 `alg`（恒为 `EdDSA`）、`typ: "JOSE"`、`kid`，
可选 `jku` 与 `exp`（本仓扩展的有效期）。

- 启用：显式配置私钥即可——`OMNI_A2A_CARD_KEY_JWK`（JWK JSON）或 `OMNI_A2A_CARD_KEY_FILE`（JWK JSON / PKCS#8 PEM）；
  `OMNI_A2A_CARD_KID` / `OMNI_A2A_CARD_JKU` / `OMNI_A2A_CARD_TTL_SEC` 为可选。`OMNI_A2A_SIGN_CARD=1`
  只表达「想签」，**无 key 时仍不签名**（只记 `a2a.card.sign.skipped` 告警）。
- 无 key **不伪造签名**：取卡方法与 well-known 返回的卡没有 `signatures` 字段，客户端不得推断为已认证。
- `verify(card, keyResolver)` fail-closed：至少一个签名通过才算通过；篡改任意字段、未知 `kid`、
  算法不在白名单（只接受 `EdDSA`）、`exp` 已过期，一律拒绝且不抛错（返回 `{ ok, reason }`）。
- 取卡方法（`agent/getCard` / `agent/getAuthenticatedExtendedCard`）与 HTTP well-known 走**同一**取卡方法，
  两份卡内容一致；`jku` 指向的 JWKS 由部署方发布（本仓不自动托管公钥端点）。

### 2.2 任务内认证（`auth_required`，规范 §7.6）

executor 可通过 `DelegateResult.authRequired: A2aAuthChallenge` 声明「继续执行需要凭据」。服务端据此：

1. 把任务落到 `auth_required`（**非终态**，不判完成），`status.message` 是面向人的认证说明、
   `status.message.metadata.authChallenge` 与任务级 `metadata.authChallenge` 带结构化 challenge
   （`scheme` / `description?` / `url?` / `scopes?` / `metadata?`）。
2. `tasks/get` 可查询该任务；`tasks/cancel` 仍可取消；订阅/流在 `auth_required` 时不发 `final`。
3. 客户端把**凭据**放进 `message.metadata.assertion`（亦接受 `metadata.authorization` / `metadata.credential`，
   或传输注入的 `Authorization` 原文），并以 `message.taskId` 指回该任务发 `message/send` 续跑。
4. 无凭据 → **fail-closed**：原样返回仍为 `auth_required` 的任务，不执行、不改状态、绝不假装完成。
   有凭据 → 重新调用 executor（凭据经 `DelegateRequest.assertion` 传入）；executor 再次要求认证则仍落
   `auth_required`（可换新 challenge），成功才落 `completed`。
5. 对非 `auth_required` 任务使用 `message.taskId` 续跑返回 `-32004`（避免静默新建一个同名任务）。

线缆上的状态值沿本仓既有命名：`auth_required`（对应规范 `TASK_STATE_AUTH_REQUIRED`，0.x 写作
`auth-required`）；`tasks/list` 的 `state` / `status` 过滤同时接受这三种写法（归一后比较）。

### 2.3 分页（`tasks/list`，规范 §3.1.4）

- 稳定排序：`status.timestamp` 倒序，时间相同按任务 id 倒序兜底（同毫秒创建不会漂移）。
- `pageSize` 取 1..100（缺省 50），越界即 `-32602`；`nextPageToken` **恒存在**，末页为空串。
- `pageToken` 是 opaque 游标：`base64url(JSON).HMAC-SHA256`，载荷含上一页最后一条的
  `(timestamp, id)` 与签发时的过滤条件。签名不符 / 结构非法 / 超过 TTL（默认 24h）/ 过滤条件漂移
  一律 `-32602`（fail-closed），绝不「当作第一页继续」。
- 多实例部署需注入同一 HMAC 密钥（`OMNI_A2A_PAGE_TOKEN_SECRET` 或显式传入），否则跨实例游标会被拒。

私有委托面（`capabilities.declare` / `task.delegate`）**保留兼容**，与 v1 共用同一 `TaskHandler`
（`A2aTaskExecutor`：并发闸门 + 受限工具子集 + 可取消子代理）。

## 3. AG-UI

不重写现有 Web 前端 / RPC / SSE，而是提供**库适配层 + 独立 HTTP/SSE 端点**：

```ts
import { AgUiHttpServer } from './dist/src/agui/index.js';
const server = new AgUiHttpServer({ run: myRunner }); // myRunner 返回 OmniHarness SessionEvent 流
await server.listen(9001);
```

- `POST /agui`（或 `/agui/run`）：body 为 `RunAgentInput` 子集（`threadId` / `runId` / `messages`），响应 SSE。
- `GET /agui/health`：探活。
- 生命周期：`RUN_STARTED` →（可选快照/活动）→ 映射事件 → `RUN_FINISHED` / `RUN_ERROR`。
- 文本 / 工具：`TEXT_MESSAGE_*`、`TOOL_CALL_START` / `ARGS` / `END` / `RESULT`、`REASONING_MESSAGE_*`。
- 状态：首个 `todo` / `plan` 变化发 `STATE_SNAPSHOT`；后续变化按 RFC 6902 发 `STATE_DELTA`
  （`add` / `replace` / `remove`，数组整体替换）。状态未变化时**不发空 delta**；
  调用方要显式清除某个状态键可用 `AgUiEventMapper.mapState({...})`（产出 `remove`）。
- 活动：工具执行开始发 `ACTIVITY_SNAPSHOT`（`activityType: "TOOL_CALL"`，`status: "running"`），
  结果到达发 `ACTIVITY_DELTA`（`/status` → `completed` / `failed`，失败附 `/error`）。
  `subagent` 工具调用映射为 `activityType: "SUBAGENT"` 的活动开始/结束。
- 消息快照：`AgUiEventStream` / HTTP 端点收到**非空** `RunAgentInput.messages` 时，在
  `RUN_STARTED` 之后发一条 `MESSAGES_SNAPSHOT`（恢复/续跑同样适用）；无历史消息不发。
- 自定义：`CUSTOM`（`question` / `turn_diff` / `usage`）。
- 取消：AG-UI 无独立取消事件，适配层以 `RUN_ERROR { code: "CANCELLED" }` 收尾；
  请求断开即 abort 运行器，取消后的源事件不再映射。

子代理说明：本仓 `EventType` **没有**独立的 subagent 事件类型（子代理轨迹由
`SubagentEventBridge` 内部收集，不广播到父事件流），因此适配层从真实的
`tool_call` / `tool_result`（`name === "subagent"`）推导 `ACTIVITY_*`；没有对应事件时
不伪造子代理事件。`AgUiEventMapper.activities(event)` 与 `.map(event)` 分离，前者不改动
既有工具事件序列。

## 4. 未支持 / 边界

- ACP：未实现 `session/delete`、`session/list` 游标分页与 `session_info_update`、Client 提供的 MCP
  server 连接、`fs/*` / `terminal/*` 反向调用、`image`/`audio` prompt、`additionalDirectories` 生效、
  `configOptions` / 会话模式；`plan` 暂不发送 `priority` 之外的计划元数据。`session/load` 只回放文本 /
  工具事件，不回放 `notice` 等实时事件。认证只提供**端口**：CLI 未注入 `AcpAuthenticator` 时
  `authenticate` 一律拒绝（无内置凭据），宿主可注入自定义实现并选择 `requireAuth`。
- A2A：**只实现 JSON-RPC 绑定**（HTTP `POST /a2a` 与 WebSocket `/a2a-ws`）；gRPC（§10）与
  HTTP+JSON/REST（§11）**明确不实现**（不自造半套绑定）。未实现多租户 / `tenant` 路由
  （请求里的 `tenant` 被忽略）。AgentCard JWS 已实现，但签名有效期 `exp` 是本仓扩展、`jku` 指向的 JWKS
  需由部署方自行发布；不提供密钥轮换编排。任务内认证的**凭据语义由实现定义**（规范 §7.6.4：进入
  `auth_required` 本身不构成任何授权），本仓只负责状态机与 challenge 透传，凭据校验/作用域由注入的
  executor 决定；带外（out-of-band）交付凭据后自动续跑不支持——客户端需再发一次带凭据的续跑消息。
  分页游标默认绑定进程内随机 HMAC 密钥，多实例部署必须共享 `OMNI_A2A_PAGE_TOKEN_SECRET`。
  push notification 为尽力投递（失败只记日志）。
- AG-UI：`STATE_DELTA` 只生成 `add` / `replace` / `remove`；`move` / `copy` / `test` 仅保留类型面。
  数组状态整体替换，不生成逐元素补丁。`ACTIVITY_*` 只覆盖工具与 `subagent` 调用，不表达任意
  自定义活动/步骤；`ACTIVITY_SNAPSHOT.replace` 恒为默认 `true`。`SUBAGENT_STARTED` /
  `SUBAGENT_FINISHED` / `SUBAGENT_ERROR` 未单独发送（子代理以 `ACTIVITY_*` 表达）；
  `STEP_STARTED` / `STEP_FINISHED` 类型保留但不主动产生；`RAW` 未产生。
  `MESSAGES_SNAPSHOT` 只来自 `RunAgentInput.messages`（非空时），不回读会话存档；
  run 开始时也不从 `RunAgentInput.state` 发状态快照（状态快照由首个 `todo` / `plan` 触发）。
  状态映射是**单 run 内存态**，跨 run 不恢复；每个新 run 的首个状态事件仍是 `STATE_SNAPSHOT`。
