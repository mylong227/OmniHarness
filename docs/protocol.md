# OmniHarness 协议文档（2.0）

> 由单源 schema 自动生成（勿手改）。传输：stdio（行式 JSON）/ HTTP+SSE / WebSocket。

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
