# 0012 远程插件进程隔离（Plugin Worker + Capability RPC）

- 日期：2026-10-21
- 状态：**核心已实施（2026-10-21）；能力 broker / OS 沙箱强制 / 重启退避为后续阶段**
- 关联：[ADR-0009 统一资产协议](./0009-capability-protocol.md)、[ADR-0010 信任-隔离阶梯](./0010-isolation-ladder.md)、[ADR-0011 签名资产包](./0011-signed-asset-pack.md)
- 现行实现：[`src/plugin/worker/`](../../src/plugin/worker/)、[`src/plugin/pluginLoader.ts`](../../src/plugin/pluginLoader.ts)

## 背景

当前远程插件默认不加载（`OMNI_ALLOW_REMOTE_PLUGINS=1` 才放行），放行后仍跑在 `node:vm`
里。这个隔离**不是安全边界**：

- `apply(ctx)` 拿到的是宿主 `Container` 的降级视图，但端口对象的方法仍带宿主 `Function`；
- `node:vm` 的上下文逃逸面无法穷尽，同步死循环之外也无法可靠中止；
- 插件与宿主同进程：一个 `process.exit()`、未捕获异常、无限内存增长都能带走整个 harness；
- 权限门禁只校验声明，不改变执行面；`port.tools.execute` 虽已禁止，但其他宿主对象仍可被
  反射/原型链触达。

因此远程插件只能「默认关」；但商业产品需要「可安全地开」。本 ADR 给出可落地、可验证、
可渐进迁移的进程隔离架构。

## 目标与非目标

### 目标

1. 远程插件代码**永不与宿主同进程**；进程边界是安全边界，不是纵深防御的装饰。
2. 插件只能通过**显式能力句柄**访问宿主；没有 `container`、没有 `process`、没有裸 `fs`。
3. 插件崩溃/挂起/内存爆炸**不拖垮宿主**；有超时、熔断、隔离与可观测状态。
4. 工具注册/调用跨进程可用，且保持现有 `ToolPort` 契约与审批/沙箱闸门。
5. 信任分层：`bundled`/`local` 保留进程内 `apply(ctx)`；`remote` 一律 Worker。
6. 可在 Windows/Linux/macOS 上 fail-closed；没有可用 OS 隔离时拒绝远程插件，而不是降级到 VM。
7. 分阶段上线，每阶段有独立判据，不要求一次性重写插件生态。

### 非目标

- 不做插件间共享内存/共享 worker 池（隔离单元就是一个插件；池化是后续性能优化）。
- 不做通用 RPC 框架；协议只覆盖插件生命周期、能力调用、工具桥。
- 不承诺 Windows ACL 后端提供网络隔离（它只限制写）；远程插件的网络策略必须由更强后端
  或显式授权决定，见 §7。
- 不把 `worker_threads` 当安全边界；线程共享进程地址空间。

## 实施状态（2026-10-21）

已落地并有判据：

- 一插件一 Worker 进程（`pluginWorkerMain.mjs` + `PluginWorkerSupervisor`）；
- NDJSON 协议 v1、握手 nonce、帧上限、activate/tool.invoke/deactivate/health；
- 工具桥（注册/调用/回收、超时、同名拒绝）；
- legacy `apply(ctx)` 适配器（仅 `port.tools` 注册视图，其它宿主服务拒绝）；
- Worker 最小环境 + Node 权限模型（`--experimental-permission --allow-fs-read=<pluginDir>`）；
- Loader 路由：`remote`/缺失 source → Worker，`bundled`/`local` → 进程内；
- 宿主停机 `PluginManager.disposeAll` → `PluginHost.shutdown` 停止 Worker。

尚未落地（后续阶段，不得宣称已具备）：

- 真实宿主能力 broker（`cap.call` 的授权执行；当前 Worker 不暴露宿主能力）；
- OS 沙箱强制（Windows ACL/WSL bwrap；当前只有进程边界 + Node 权限模型）；
- 崩溃后指数退避重启/quarantine；
- `plugin.worker.*` 事件指标与 `doctor` 的 worker 段。

## 决策

### 1. 信任分层与执行位置

| 来源               | 执行位置             | 插件 API                             | 说明                         |
| ------------------ | -------------------- | ------------------------------------ | ---------------------------- |
| `bundled`          | 宿主进程内           | 现行 `apply(ctx)`                    | 随包发布、同签名供应链，可信 |
| `local`            | 宿主进程内           | 现行 `apply(ctx)`                    | 用户本机手写，等同用户代码   |
| `remote`           | **独立 Worker 进程** | Worker SDK v2（异步能力）            | 市场/远程来源，不可信        |
| `source` 缺失/损坏 | 独立 Worker 进程     | Worker SDK v2；旧 `apply` 走兼容适配 | 按不可信处理                 |

`OMNI_ALLOW_REMOTE_PLUGINS=1` 不再表示「允许在 VM 里跑」，而是「允许启动远程插件 Worker」。
没有可用 Worker 隔离时，该开关也不能把插件降级回进程内。

### 2. 进程模型

每个远程插件一个子进程（隔离单元 = 插件）：

```
┌──────────────────────────── Host (harness) ────────────────────────────┐
│ PluginSupervisor                                                       │
│  ├─ CapabilityBroker  (权限/句柄/审计)                                  │
│  ├─ ToolBridge        (ToolPort ↔ worker)                              │
│  └─ WorkerHandle      (spawn/状态/超时/重启/日志)                        │
│            │ NDJSON over stdin/stdout（stderr 只做日志）                 │
│            ▼                                                           │
│  ┌──────────────── Plugin Worker (Node.js child process) ────────────┐  │
│  │ pluginWorkerMain                                                  │  │
│  │  ├─ ProtocolCodec (帧上限/版本/请求表)                              │  │
│  │  ├─ WorkerSdk      (ctx.tools / ctx.kv / ctx.events / ctx.log)     │  │
│  │  └─ plugin module  (import 自只读插件目录)                          │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

为什么不是每信任域一个池：池化会让一个插件的崩溃/内存/句柄泄漏影响同池其他插件；首版按
「一插件一进程」换取可证明的隔离，进程数由 `maxWorkers` 限流，超限时拒绝新插件并上报。

为什么不是 `worker_threads`：线程共享进程、`process` 与原生句柄，无法阻止恶意代码影响宿主；
只能做性能隔离，不能做安全隔离。

### 3. Worker 启动与 OS 隔离

`WorkerHandle.spawn()` 的固定顺序：

1. 解析插件目录与入口，校验清单/签名摘要（安装期已验签，启动期再对摘要做一致性检查）。
2. 选择 OS 沙箱 profile：
   - Linux：`bwrap`（优先）或 `unshare`；
   - macOS：`seatbelt`；
   - Windows：`wsl-bwrap`（可禁网）优先；`windows-acl-readonly` 仅在显式允许网络时使用。
3. 组装最小环境：仅 `PATH` / `SystemRoot` / 语言变量 / 私有 `TEMP`；**不传宿主 API Key、
   token、代理凭据**。宿主 `process.env` 整体不继承。
4. `spawn(process.execPath, [workerMain, '--plugin-worker'], { cwd: pluginDir, env, stdio: ['pipe','pipe','pipe'] })`，
   外层套 OS 沙箱包装（与 shell 工具同一 `SandboxPort` 机制）。
5. 握手（§4）。握手失败/超时 → 杀进程，状态 `failed`，不上报 ready。

**拒绝降级**：`plugins.workers.requireOsSandbox` 默认 `true`。没有可用 OS 沙箱时，远程插件
加载失败并给出可执行原因；`allowUnsandboxed` 仅作为开发开关，且必须在诊断事件中显著标记。

### 4. 协议（Plugin Worker Protocol v1）

传输：stdin/stdout 的 **NDJSON**；每帧一个 JSON 对象，单帧上限 1 MiB；stderr 单独收集，
不参与协议。协议版本不匹配 → 立即杀进程，不尝试兼容。

握手：

```ts
// Parent -> Worker
{ v: 1, kind: 'hello', session: 's_...', plugin: { name, version, digest }, nonce: '...' }
// Worker -> Parent
{ v: 1, kind: 'ready', session: 's_...', nonce: '...', pid: 1234, sdk: '1' }
```

请求/响应：

```ts
type Envelope =
  | { v: 1; session: string; kind: 'req'; id: number; method: string; params: unknown }
  | { v: 1; session: string; kind: 'res'; id: number; ok: true; result: unknown }
  | { v: 1; session: string; kind: 'res'; id: number; ok: false; error: WorkerError }
  | { v: 1; session: string; kind: 'evt'; method: string; params: unknown };
```

方法表（首版冻结，新增走 v2）：

| 方向 | method              | 说明                                              |
| ---- | ------------------- | ------------------------------------------------- |
| P→W  | `plugin.activate`   | 调用插件 `activate(ctx)`；超时/异常 → 激活失败    |
| P→W  | `plugin.deactivate` | 幂等清理；超时后强杀                              |
| P→W  | `tool.invoke`       | `{ callId, tool, args, context }`，返回规范化结果 |
| P→W  | `tool.cancel`       | 尽力取消；不能打断同步代码时由父进程杀 worker     |
| P→W  | `event.deliver`     | 宿主事件推送（仅声明了事件能力的插件）            |
| P→W  | `health.ping`       | 健康检查                                          |
| W→P  | `cap.call`          | `{ cap, method, params }`；父进程按句柄校验权限   |
| W→P  | `tool.register`     | 注册工具定义 + handler 句柄                       |
| W→P  | `tool.unregister`   | 回收单个工具                                      |
| W→P  | `log`               | 结构化日志（限流）                                |
| W→P  | `fault`             | 插件自报不可恢复错误，父进程进入 quarantine       |

错误码（父进程与 Worker 共用）：

```
UNAUTHORIZED_CAPABILITY | UNKNOWN_CAPABILITY | INVALID_FRAME | VERSION_MISMATCH |
ACTIVATION_TIMEOUT | CALL_TIMEOUT | WORKER_CRASHED | WORKER_QUARANTINED |
INVALID_TOOL | TOOL_LIMIT | RESULT_TOO_LARGE | SANDBOX_UNAVAILABLE
```

### 5. 能力模型

Worker 里没有 `services.get(name)`；只有父进程签发的不透明句柄：

```ts
interface CapabilityGrant {
  readonly token: string; // cap_<随机>
  readonly plugin: string;
  readonly capability: PluginCapability;
  readonly scope?: Readonly<Record<string, unknown>>; // 例：kv namespace / fs 根
}
```

首版能力（与 `PluginPermission` 对齐并少量扩展）：

| 能力                   | 权限                    | 宿主实现                   | 约束                                      |
| ---------------------- | ----------------------- | -------------------------- | ----------------------------------------- |
| `tools.register`       | `tool.register`（新增） | `ToolPort.register`        | 名称命名空间化、schema 大小上限           |
| `kv.get/set/delete`    | `store.read/write`      | 现有 KV 端口               | 仅插件自己的 namespace                    |
| `events.emit`          | `events.emit`（新增）   | 事件端口                   | 事件类型白名单、限流                      |
| `fs.read/write/delete` | `fs.*`                  | `SafeFs` 路径守卫          | 根目录 scope，禁止符号链接越界            |
| `net.connect`          | `net.connect`           | 宿主 HTTP 客户端           | 只允许声明的 host 列表；不暴露原始 socket |
| `proc.exec`            | `proc.exec`             | `ShellTool`（带审批/沙箱） | 默认不授予；需显式审批策略                |

未在清单里的能力一律 `UNAUTHORIZED_CAPABILITY`；父进程对每次 `cap.call` 做审计事件
（插件名、能力、耗时、结果码），不记录参数中的敏感值。

### 6. 工具桥

Worker 注册工具时只发送**定义 + handler 句柄**；父进程是工具表的唯一真相源：

```ts
// Worker -> Parent
{ method: 'tool.register', params: { definition: ToolDefinition, handler: 'h_1' } }
```

父进程校验：

> 2026-10-21 实施口径：为兼容既有插件工具名（`ping-tool` 等），首版**保留原名**，
> 同名注册直接拒绝；命名空间前缀留到多插件冲突治理时再加，避免破坏现有工具表/UI。

1. 名称必须匹配 `^[a-z][a-z0-9_-]*$`，同名已存在即拒绝（不静默覆盖）；
2. `description` ≤ 2 KiB，`parameters` 必须是 JSON Schema 对象且 ≤ 16 KiB；
3. 每插件工具数 ≤ 64；同名重复注册拒绝；
4. 注册完成才进入 `ToolPort`，部分失败则回滚本插件已注册项。

调用：

```
ToolPort.execute(call, ctx)
  → ToolBridge 校验 call 属于该插件
  → 序列化 { callId, tool, args, context: { sessionId, workspaceRoot, cwd } }
  → worker tool.invoke（超时 callTimeoutMs）
  → 校验结果：output ≤ 1 MiB；files ≤ 8 MiB 且数量 ≤ 8
  → 返回 ToolResult
```

失败语义：超时/崩溃 → `ok:false, error:'插件不可用'`；**不自动重试**（工具可能有副作用）。
父进程取消（会话 abort）→ 先发 `tool.cancel`，宽限 2s 后杀 worker 并标记 quarantine。

### 7. 生命周期与故障

状态机：

```
spawned → handshaking → activating → ready → draining → stopped
    ↘          ↘            ↘          ↘
     failed ←── crashed ←────┘          quarantined
```

- **激活超时** `activationTimeoutMs`（默认 10s）；工具调用超时 `callTimeoutMs`（默认 30s）。
- **崩溃重启**：指数退避 1s/2s/4s，最多 `restartLimit`（默认 3）；超过后 quarantine，
  不再自动启动，UI/CLI 显示原因与 stderr 尾部。
- **健康检查**：`health.ping` 每 15s；连续 2 次超时视为 hung，杀进程并按崩溃处理。
- **内存**：`--max-old-space-size=<memoryMb>`（默认 256）；超限由 V8 退出，按崩溃处理。
- **进程树**：复用 `ProcessTreeKiller`；Windows 下额外用 Job Object（如 `wsl-bwrap`/ACL
  runner 不可用时的回退）确保子进程不残留。
- **停机**：宿主 `shutdown()` → 所有 worker `draining`，停止接单，等待在途调用完成或
  `shutdownGraceMs`（默认 5s）后强杀；任何残留进程都记 `plugin.worker.orphan` 告警。
- **不重复激活**：每插件一个 `activation` 单飞 Promise；并发加载只触发一次。

### 8. 沙箱与网络边界（必须如实标注）

- `windows-acl`/`windows-acl-readonly` **只限制写**；读、网络、进程可见性不受限。
- 因此远程插件的默认策略：
  - Linux：`bwrap --unshare-net`（强）；
  - macOS：seatbelt 禁止 network；
  - Windows：`wsl-bwrap --unshare-net`；不可用时**拒绝远程插件**，除非显式
    `plugins.workers.allowNetwork=true` 且插件声明 `net.connect`，并在 UI 显示「网络未隔离」。
- Node 权限模型（`--experimental-permission --allow-fs-read=<pluginDir>`）作为纵深防御，
  不作为唯一边界；版本不满足时跳过，不影响 OS 沙箱结论。
- Worker 环境不继承宿主 secrets；插件拿到的一切宿主数据都必须经过能力句柄。

### 9. 兼容与迁移

保留进程内 `apply(ctx)` 仅给 `bundled`/`local`。远程插件分两类：

1. **Worker SDK v2**（推荐）：

```ts
export default definePlugin({
  meta: { name: 'demo', permissions: ['tool.register', 'store.read'] },
  async activate(ctx) {
    await ctx.tools.register(def, async (args, call) => ({ output: '...' }));
  },
  async deactivate() {},
});
```

2. **Legacy `apply(ctx)` 适配器**：Worker 内提供只读 `ctx`：
   - `ctx.services.get('port.tools')` 返回注册/列举视图（无 `execute`）；
   - `register` 同步入队，`activate` 结束后统一 flush；
   - `ctx.services.get(<其它服务>)` 抛 `CAPABILITY_UNAVAILABLE`；
   - `ctx.onService` / `registerService` 在远程插件中**不支持**（能力模型不暴露容器）。

加载器按 `manifest.source === 'remote'` 路由到 Supervisor；`apply` 旧插件直接可运行，
但使用未支持能力的插件会在激活阶段得到明确错误，而不是静默半残。

### 10. 配置

```json
{
  "plugins": {
    "workers": {
      "enabled": true,
      "maxWorkers": 4,
      "memoryMb": 256,
      "activationTimeoutMs": 10000,
      "callTimeoutMs": 30000,
      "restartLimit": 3,
      "requireOsSandbox": true,
      "allowNetwork": false,
      "allowUnsandboxed": false
    }
  }
}
```

默认值必须 fail-closed；`allowUnsandboxed`/`allowNetwork` 只在显式配置时生效，并在
`doctor` 与启动横幅中打印警告。

### 11. 可观测性

事件（经现有事件端口）：

- `plugin.worker.state`：`{ plugin, state, pid, reason }`
- `plugin.worker.call`：`{ plugin, method, durationMs, outcome }`（不记参数）
- `plugin.worker.crash`：`{ plugin, code, signal, stderrTail }`
- `plugin.worker.restart`：`{ plugin, attempt, delayMs }`
- `plugin.worker.orphan`：`{ plugin, pid }`

`doctor` 新增 `plugin workers` 段：插件名、状态、pid、内存、重启次数、最近错误。
日志/stderr 走有界 ring buffer（64 KiB），避免日志爆炸。

### 12. 测试与验收

实现必须带以下判据，缺一不合并：

**协议与状态机**

- 版本不匹配、未知方法、超大帧、非法 JSON → fail-closed 并杀 worker；
- 握手 nonce 不匹配 → 拒绝；
- 重复 `activate` 只执行一次；
- 崩溃 → 退避重启 → 超过上限 quarantine；
- 宿主停机 → 无残留 worker。

**安全**

- Worker 内 `process`/`require`/`globalThis.process` 不可达（ESM 入口 + 权限模型）；
- 未声明能力 `cap.call` → `UNAUTHORIZED_CAPABILITY`；
- `fs` 越界/符号链接 → 拒绝；
- `windows-acl-readonly` 下工作区写入失败；
- `bwrap` 下网络连接失败（Linux CI 可跳过，需真机证据）。

**工具桥**

- 注册 → `ToolPort.list()` 可见；卸载 → 回收；
- 调用结果/大输出截断/文件上限；
- 超时 → 失败且不重试；取消 → 先 cancel 后强杀；
- 恶意 schema/重复名/超量工具 → 拒绝。

**兼容**

- 旧 `apply(ctx)` fixture 在 Worker 中注册工具可用；
- 使用未支持能力时给出可读错误；
- 进程内 `bundled`/`local` 行为零变化。

**门禁**

- fast 10/10、typed 2/2、全量单测；
- 新增模块遵守铁律（无顶层函数、函数/文件行数、无第三方依赖进 ports/core）。

### 13. 实施顺序（每步可独立合并）

1. **协议与 Supervisor 骨架**：`ports/plugin/pluginWorkerProtocol.ts`、`workerMain` echo、
   `PluginSupervisor` 握手/状态/超时/杀进程；开关默认关。判据：握手、超时、崩溃隔离。
2. **工具桥**：`tool.register`/`tool.invoke`/`tool.unregister`、结果上限、父进程
   `ToolPort` 适配；判据：跨进程工具可用。
3. **能力 broker**：句柄签发、权限校验、KV/events 最小集；判据：未授权能力拒绝。
4. **OS 沙箱接线**：Worker spawn 套现有 `SandboxPort`；Windows 走 WSL/ACL，无强隔离则拒绝远程。
5. **Legacy 适配器 + 加载器路由**：远程插件默认走 Worker；保留 `OMNI_ALLOW_REMOTE_PLUGINS`
   作为总开关；UI/CLI/doctor 显示状态。
6. **移除进程内远程路径**：删除 `Sandbox.loadPluginCodeInSandbox` 用于远程插件的分支，
   保留 VM 仅给可信插件的可选校验/资产执行（或彻底删除）。

### 14. 风险与取舍

| 风险                | 影响                                | 缓解                                                             |
| ------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| IPC 延迟            | 工具调用多一跳，P99 增加            | 首版接受；后续按插件批量/池化优化，但不牺牲隔离                  |
| 生态兼容            | 旧远程插件用 `ctx.onService` 会失效 | Legacy 适配器 + 明确错误；提供迁移文档                           |
| Windows 网络隔离    | ACL 只限写                          | 强制 WSL bwrap；否则拒绝远程或显式 allowNetwork + 警告           |
| Node 权限模型实验性 | 版本差异                            | 仅作纵深防御，不依赖它做唯一边界                                 |
| 进程泄漏            | 孤儿 worker                         | Job Object/ProcessTreeKiller + 停机扫描 + `plugin.worker.orphan` |
| 结果序列化          | 大文件/函数无法传                   | 限额 + 仅 JSON 可序列化结果；文件走附件路径                      |
| 单插件一进程开销    | 内存/启动时间                       | `maxWorkers` 限流；空闲回收；首版不池化                          |

### 15. 替代方案与否决理由

- **继续用 `node:vm` + 降级容器**：已被证明不是安全边界；远程插件不能商业化开放。
- **`worker_threads`**：同进程，无法防 `process.exit`/原生句柄/地址空间攻击。
- **QuickJS/WASM 隔离**：能提供强隔离，但现有插件 API 是 Node ESM + 宿主对象，迁移成本
  高于进程方案；且 WASM 无法直接跑依赖 Node 内建模块的插件。
- **远程容器/微服务**：隔离最强，但部署复杂度、冷启动、文件/工具桥成本不符合当前产品形态；
  进程 Worker 是可演进到容器的中间层。
- **池化 Worker**：性能更好，但隔离单元变成池，崩溃/内存/句柄互相影响；首版否决。

## 决策记录

1. 远程插件一律独立进程；信任分层不因开关降级。
2. 能力句柄替代宿主容器；没有隐式 `services.get`。
3. 父进程是工具表唯一真相源；工具调用不自动重试。
4. 没有 OS 级强隔离时拒绝远程插件，不用 VM 冒充。
5. 旧 `apply(ctx)` 只保留给可信来源；远程走 SDK v2 或受限 legacy 适配器。
6. 分六步落地，每步独立判据；在全部判据通过前不默认开启远程插件。

## 后果

- 正面：远程插件从「默认关」变成「可安全开」；崩溃/挂起/内存问题被进程边界吸收；
  权限从声明变成可执行的能力句柄；有完整的生命周期与诊断面。
- 负面：多进程内存与 IPC 成本；旧插件需要迁移；Windows 上强网络隔离依赖 WSL；
  首版不能共享 worker，插件数量受 `maxWorkers` 限制。
- 边界：进程隔离仍以宿主 OS 安全为前提；宿主被提权/内核被攻破不在本架构承诺内。
