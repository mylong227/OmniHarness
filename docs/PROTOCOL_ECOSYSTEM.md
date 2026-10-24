# 协议生态适配（ACP / A2A / AG-UI）

本仓在既有私有 JSON-RPC 面上补齐三条生态协议。三者互不替代：**ACP 是编辑器连接层**、
**A2A 是 agent 间互操作层**、**AG-UI 是 agent ↔ 用户界面的事件层**。

## 1. ACP v1（Agent Client Protocol）

```bash
# 由编辑器（Zed / JetBrains 等）以子进程方式启动，JSON-RPC 2.0 over stdio
omniharness acp [--acp-permission client|auto]
```

| 方法                         | 方向                   | 说明                                                                                             |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `initialize`                 | Client → Agent         | 协商协议版本（整数 `1`）与能力：`loadSession` / `promptCapabilities` / `mcpCapabilities`         |
| `session/new`                | Client → Agent         | 以绝对路径 `cwd` 创建会话，返回 `sessionId`（同时是 Agent 会话 id）                              |
| `session/load`               | Client → Agent         | 加载既有会话，并以 `session/update` 回放 `user_message_chunk` / `agent_message_chunk` / 工具事件 |
| `session/prompt`             | Client → Agent         | 跑一轮提示；返回 `stopReason`（`end_turn` / `cancelled` / `max_turn_requests`）                  |
| `session/cancel`             | Client → Agent（通知） | 中止回合；挂起的权限请求按 `cancelled` 收尾                                                      |
| `session/update`             | Agent → Client（通知） | `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan`        |
| `session/request_permission` | Agent → Client（请求） | 写类工具执行前请求授权；响应 `selected` 或 `cancelled`                                           |

映射：`--acp-permission client`（默认）下，写类工具（`MUTATING_TOOL_NAMES`）向 Client 请求权限，
只读工具直接放行；`auto` 全部自动放行。提示中的 `resource` 文本会并入 prompt；`image`/`audio`
因未声明能力而明确拒绝。ACP 的 stdout **只写协议消息**，诊断一律走 stderr。

## 2. A2A v1.0

`--a2a` 启用后（`--a2a-port` / `--a2a-transport http|ws`），HTTP 传输提供 `POST /a2a`（JSON-RPC）
与 `GET /.well-known/agent-card.json`；流式方法自动以 `text/event-stream` 回写。

| 方法                                                  | 说明                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `message/send`                                        | 创建并执行任务；`configuration.returnImmediately=true` 时后台执行、立即返回 submitted                    |
| `message/stream`                                      | Task 快照 → `statusUpdate(working)` → `artifactUpdate` → `statusUpdate(final:true)`                      |
| `tasks/get`                                           | 查询任务（`id` 或 `taskId`）                                                                             |
| `tasks/cancel`                                        | 取消在跑任务（`TaskNotCancelableError -32002` 表示已终态）                                               |
| `tasks/subscribe`（别名 `tasks/resubscribe`）         | 订阅在跑任务；首帧当前 Task，终态收尾                                                                    |
| `tasks/list`                                          | 任务列表（可按 `contextId` / `state` 过滤）                                                              |
| `tasks/pushNotificationConfig/set\|get\|list\|delete` | webhook 配置；任务状态变化时 POST `StreamResponse`，带 `x-a2a-notification-token` 与可选 `Authorization` |
| `agent/getCard`                                       | 公开 AgentCard（含 `protocolVersion` / `capabilities` / `securitySchemes`）                              |
| `agent/getAuthenticatedExtendedCard`                  | 认证后的扩展卡；未签名/验签失败返回 `-32000`                                                             |

认证沿用既有 `AgentIdentityPort`：配置身份后，受保护方法校验 `params.assertion` 或
`params.message.metadata.assertion`；HTTP/WS 传输会把 `Authorization` 头原文注入 `assertion`。
AgentCard 在配置身份时声明 `securitySchemes.agentAssertion` 与 `security`，便于标准客户端发现认证要求。

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
- 事件映射：`RUN_STARTED` / `TEXT_MESSAGE_*` / `TOOL_CALL_*` / `STATE_SNAPSHOT` /
  `REASONING_MESSAGE_*` / `CUSTOM`（`question` / `turn_diff` / `usage`）/ `RUN_FINISHED` / `RUN_ERROR`。
- 取消：AG-UI 无独立取消事件，适配层以 `RUN_ERROR { code: "CANCELLED" }` 收尾；
  请求断开即 abort 运行器。

## 4. 未支持 / 边界

- ACP：未实现 `authenticate` / `logout` / `session/close` / `session/list` / `session/resume`、
  Client 提供的 MCP server 连接、`fs/*` / `terminal/*` 反向调用、`image`/`audio` prompt；`plan` 暂不发送
  `priority` 之外的计划元数据。`session/load` 只回放文本 / 工具事件，不回放 `notice` 等实时事件。
- A2A：不支持 gRPC / HTTP+JSON 绑定、AgentCard JWS 签名、`TASK_STATE_AUTH_REQUIRED` 完整交互、
  多租户与任务分页游标（`nextPageToken` 恒为空）。push notification 为尽力投递（失败只记日志）。
- AG-UI：`STATE_DELTA` / `ACTIVITY_*` / 子代理事件未产生（类型面保留）；`MESSAGES_SNAPSHOT` 未使用。
