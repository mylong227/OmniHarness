# OmniHarness 协议文档（2.0）

> 由单源 schema 自动生成（勿手改）。传输：stdio（行式 JSON）/ HTTP+SSE / WebSocket。
>
> **重新生成命令**：`node dist/src/cli/exec.js schema --out-md docs/protocol.md`
> （`schema` 子命令走 `src/schema/codeGenerator.ts` 的 `CodeGenerator.generateDocs`；旗标用法以
> `node dist/src/cli/exec.js --help` 为准。手改本文件会在下次生成时被覆盖——要改口径请改 schema 或生成器。）
>
> **版本口径（别混）**：标题里的 **2.0 是协议版本**（JSON-RPC `jsonrpc: '2.0'`，即单源 schema 的
> `protocolSchema.jsonrpc`）——**不是** `src/version.ts` 的 `API_VERSION`（当前 `0.1.0`，那是公开 API 的
> 契约版本），也不是 `package.json` 的包版本；三者各自演进。
>
> **传输实现与命名（以代码为准）**：stdio = `LineTransport`（`src/server/transport/lineTransport.ts`，
> 行式 JSON 帧）；HTTP = `POST /rpc` + `GET /events`（SSE，`src/server/transport/httpServer.ts`）；
> WebSocket = **帧层**（`wsFrameCodec` / `wsConnection`，同在 `src/server/transport/` 下）。文档旧口径里
> 「HTTP+SSE」指的就是这一对端点，别再另起名字。
>
> **覆盖面提示**：本文件只覆盖**核心 turn / approval 面**（下方 7 个方法与 `thread.event` 通知）。
> UI/工作台侧的 RPC——如 `modes.set`、`sessions.list` 的 `workspace` 过滤、`plugins.reload`、
> `config.get`——由 `src/server/core/` 下的处理器文件（`appServer.ts`、`appServerHandlers.ts`、
> `appServerSurfaceHandlers.ts`）直接注册，**不在**本文件与单源 schema 内；查它们请直读注册处或 Web 侧调用点。

## 方法一览

| 方法               | 说明                                             |
| ------------------ | ------------------------------------------------ |
| `threads.create`   | 创建线程并执行任务                               |
| `threads.continue` | 续跑线程                                         |
| `threads.fork`     | 分叉线程                                         |
| `threads.get`      | 获取线程事件                                     |
| `threads.rewind`   | 回退线程（截断到指定事件，重生成的服务端真回退） |
| `turns.run`        | 运行回合（线程已存在则续跑）                     |
| `approval.respond` | 响应审批上行                                     |

## 方法详情

### threads.create

创建线程并执行任务

> **流式方法**：执行期间持续推送 `thread.event`（执行期间逐条推送会话事件（user/reasoning/tool_call/tool_result/assistant））。SDK 用 `threadsCreateStream` / `threads_create_stream` 订阅。

**参数**

| 字段     | 类型   | 必填 | 说明       |
| -------- | ------ | ---- | ---------- |
| `prompt` | string | 是   | 任务提示词 |

**结果**

| 字段        | 类型   | 必填 | 说明     |
| ----------- | ------ | ---- | -------- |
| `threadId`  | string | 否   | 线程 ID  |
| `finalText` | string | 否   | 最终文本 |
| `steps`     | number | 否   | 回合步数 |

### threads.continue

续跑线程

> **流式方法**：执行期间持续推送 `thread.event`（续跑期间逐条推送会话事件）。SDK 用 `threadsContinueStream` / `threads_continue_stream` 订阅。

**参数**

| 字段       | 类型   | 必填 | 说明     |
| ---------- | ------ | ---- | -------- |
| `threadId` | string | 是   | 线程 ID  |
| `prompt`   | string | 是   | 新提示词 |

**结果**

| 字段        | 类型   | 必填 | 说明 |
| ----------- | ------ | ---- | ---- |
| `threadId`  | string | 否   |      |
| `finalText` | string | 否   |      |
| `steps`     | number | 否   |      |

### threads.fork

分叉线程

> **流式方法**：执行期间持续推送 `thread.event`（分叉执行期间逐条推送会话事件）。SDK 用 `threadsForkStream` / `threads_fork_stream` 订阅。

**参数**

| 字段       | 类型   | 必填 | 说明      |
| ---------- | ------ | ---- | --------- |
| `threadId` | string | 是   | 源线程 ID |
| `prompt`   | string | 是   | 新提示词  |

**结果**

| 字段        | 类型   | 必填 | 说明 |
| ----------- | ------ | ---- | ---- |
| `threadId`  | string | 否   |      |
| `finalText` | string | 否   |      |
| `steps`     | number | 否   |      |

### threads.get

获取线程事件

**参数**

| 字段       | 类型   | 必填 | 说明    |
| ---------- | ------ | ---- | ------- |
| `threadId` | string | 是   | 线程 ID |

**结果**

| 字段       | 类型   | 必填 | 说明     |
| ---------- | ------ | ---- | -------- |
| `threadId` | string | 否   |          |
| `items`    | array  | 否   | 事件列表 |

### threads.rewind

回退线程（截断到指定事件，重生成的服务端真回退）

**参数**

| 字段          | 类型   | 必填 | 说明                 |
| ------------- | ------ | ---- | -------------------- |
| `threadId`    | string | 是   | 线程 ID              |
| `keepEventId` | string | 是   | 保留到哪条事件（含） |

**结果**

| 字段      | 类型    | 必填 | 说明                    |
| --------- | ------- | ---- | ----------------------- |
| `ok`      | boolean | 否   | 是否成功回退            |
| `kept`    | number  | 否   | 保留的事件条数          |
| `dropped` | number  | 否   | 丢弃的事件条数          |
| `error`   | string  | 否   | 失败原因（ok=false 时） |

### turns.run

运行回合（线程已存在则续跑）

> **流式方法**：执行期间持续推送 `thread.event`（回合执行期间逐条推送会话事件）。SDK 用 `turnsRunStream` / `turns_run_stream` 订阅。

**参数**

| 字段       | 类型   | 必填 | 说明            |
| ---------- | ------ | ---- | --------------- |
| `threadId` | string | 否   | 线程 ID（可选） |
| `prompt`   | string | 是   | 提示词          |

**结果**

| 字段        | 类型   | 必填 | 说明 |
| ----------- | ------ | ---- | ---- |
| `threadId`  | string | 否   |      |
| `finalText` | string | 否   |      |
| `steps`     | number | 否   |      |

### approval.respond

响应审批上行

**参数**

| 字段        | 类型   | 必填 | 说明          |
| ----------- | ------ | ---- | ------------- |
| `requestId` | string | 是   | 审批请求 ID   |
| `decision`  | string | 是   | allow 或 deny |

**结果**

| 字段 | 类型    | 必填 | 说明     |
| ---- | ------- | ---- | -------- |
| `ok` | boolean | 否   | 是否成功 |
