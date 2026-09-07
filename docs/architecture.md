# OmniHarness 架构文档

融合 OpenAI Codex Harness 与 DeepSeek Harness 优点的全能 Agent Harness。
本架构遵循六条设计军规：**一个功能一个类、一个函数一个职责、无大函数、标准代码、核心零依赖、append-only 事件日志**。

## 1. 总览

```
┌─────────────────────────────────────────────────────────────┐
│  app-server（HTTP/SSE + stdio JSON-RPC）↔ 客户端/SDK/Web UI    │
├─────────────────────────────────────────────────────────────┤
│  core（稳定内核，只依赖端口接口）                               │
│    Agent → TurnRunner → StepRunner → ToolGate                 │
│    事件流: 日志 append-only + 事件端口广播 + 存储持久化          │
├─────────────────────────────────────────────────────────────┤
│  ports（8 标准插口）                                           │
│    ModelPort · ToolPort · StoragePort · EventPort             │
│    SandboxPort · ApprovalPort · KvPort · VaultPort            │
├─────────────────────────────────────────────────────────────┤
│  adapters（即插即用实现）                                      │
│    model: mock | openai兼容 | anthropic（含流式）              │
│    tool:  shell | read/write/list/apply_patch | run_code      │
│           web_search | delegate                               │
│    storage: memory | jsonl | sandbox: passthrough | policy    │
│    approval: auto | deny | rules | guardian | server(uplink)  │
├─────────────────────────────────────────────────────────────┤
│  扩展层：插件系统(cordis-lite) · Skills · Worker 编排 · 上下文压缩 │
└─────────────────────────────────────────────────────────────┘
```

## 2. 核心执行链

```
用户任务 → Agent 建会话 → 技能匹配注入(system 事件) → 记录 user 事件
  → TurnRunner 循环:
      StepRunner:
        1. ContextAssembler 投影事件日志 → 模型消息（超预算先压缩）
        2. 模型输出 → 记录 reasoning 事件
        3. 工具调用 → ToolGate 门禁: 审批(approval) → 沙箱(sandbox) → 执行 → 记录
  → 模型输出文本 → 回合结束
  → 存储 save 全部事件
```

**门禁 fail-closed**：审批 deny 或沙箱拒绝 → 工具不执行、记录失败结果。审批端口按工具类型映射沙箱动作（command / file_read / file_write）。

## 3. 事件模型（append-only 事实源）

事件类型：`user / assistant / reasoning / tool_call / tool_result / system`。

- **模型所见即所记**：模型上下文 = 事件日志投影（ContextAssembler），不是独立对话缓冲。
- **可观测性**：每个事件同时进入日志 + 事件端口广播（可对接控制台/SSE/审计）。
- **持久化**：StoragePort.save 全量落盘（jsonl 每会话一个文件），支持 resume/fork/replay。

## 4. 端口说明

| 端口         | 职责             | 默认适配器             | 定制方式              |
| ------------ | ---------------- | ---------------------- | --------------------- |
| ModelPort    | 任意 AI 统一插口 | mock                   | 实现 generate/stream  |
| ToolPort     | 工具能力统一插口 | registry（9 内置工具） | 注册定义+处理器       |
| StoragePort  | 会话持久化       | memory                 | 实现 save/load        |
| EventPort    | 事件广播         | silent                 | 实现 emit             |
| SandboxPort  | 命令/文件门禁    | passthrough            | 实现 check            |
| ApprovalPort | 工具审批         | auto                   | 实现 decide           |
| KvPort       | 键值存储         | memory                 | 实现 get/set/del/list |
| VaultPort    | 凭据保险库       | crypto（AES-256-GCM）  | 实现 get/set/del/list |

## 5. 关键子系统

- **上下文压缩**：TokenEstimator 估算 → 超预算 ContextCompactor 把较早历史折叠为 LLM 摘要（无模型退化为占位截断），压缩点记 system 事件。
- **PTC/Code mode**：run_code 工具执行模型生成的程序，程序内 `await call(name, args)` 多步调用（同样过门禁）。
- **插件系统 cordis-lite**：`inject` 依赖声明 → 服务就绪才启动；effect 逆序清理；onService 订阅。
- **Skills**：技能注册表按 prompt 匹配名称/tag → system 事件注入上下文。
- **Worker 编排**：CliWorker spawn 外部 harness（codex/claude-code/dsh/opencode），delegate 工具走主链门禁与事件流。
- **app-server**：JSON-RPC 2.0 原语（threads/turns/items）+ thread.event 推送 + approval.request 上行；stdio 与 HTTP/SSE 双传输。

## 6. Rust 硬内核（crates/）

蓝图 §3.3 的边界划分：**性能热路径与边界协议留在 Rust，生态与灵活性放 TS 插件层**，二者经 wasm + JSON-RPC/stdio 通信。

```
crates/
├── omni-core   硬内核（零运行时依赖，仅 serde/serde_json + Windows 下 windows-sys）
│   agent       工具注册表与执行（7 内置工具 + ToolMeta ToolSpec 自省）
│   queue       SQ/EQ 双队列：Submission（入站） / Op（出站），tag=kind + camelCase
│   session     状态机：审批 → 策略沙箱 → OS 沙箱 → 执行 → 记录 → 压缩；turn 开合、ask 挂起与裁决回复
│   context     上下文管理：碎片注入 + token 估算 + 双通道压缩 + ReasoningSummary 保留
│   approval    审批引擎：allow/deny/ask 三态 + 工具级/最长前缀规则 + Guardian trait
│   sandbox     策略沙箱（危险命令 + 路径白名单）+ PlatformSandbox 后端接口
│   restricted_token  Windows RestrictedToken OS 级沙箱：受限令牌 + Job Object + 受限进程启动
│   store       RolloutStore（JSONL append-only，可重开回放）+ MemoryStore
│   agents      多 Agent 树（父子校验 / 角色 / 祖先链 / 子树移除）
│   builtin     内置工具：echo / now / math.eval / fs.read_file / fs.write_file / fs.list_dir / shell.run(native)
├── omni-cli    `omni exec|tools|run|approval|context|sdk|sandbox`
├── omni-wasm   wasm32 cdylib：C ABI omni_init/omni_alloc/process/omni_dealloc + JSON-RPC
├── omni-napi   手写 N-API 插件（cdylib）：napi_glue（GetProcAddress 动态解析宿主 napi_* 符号）+ handler（JSON-RPC 复用内核 Session 全链）
├── omni-sdk    客户端运行时：Transport(stdio/TCP/子进程) + OmniClient(JSON-RPC 2.0)
└── omni-sdk-gen 单源 schema → Rust 服务端类型 + dispatch 骨架
```

**执行链与 TS 侧同构**：`Session::handle_tool_call` 依次过 `ApprovalEngine::evaluate` → `Sandbox::check`（策略沙箱）→ `PlatformSandbox::wrap`（OS 级沙箱，命令类工具且后端可用时把命令包装进受限进程）→ `AgentLoop::run_tool` → `MemoryStore/RolloutStore` 记录 → 超预算则 `ContextManager::compact`。任一门禁拒绝即 fail-closed，产出 `Op::ToolResult{ok:false}` 与 `Op::Error`；OS 沙箱可用但包装失败同样拒绝执行。

**OS 级沙箱（Windows）**：`restricted_token.rs` 用 windows-sys（mingw 链接 advapi32/kernel32，GNU 工具链可编译，无需 MSVC）实现 `RestrictedProcessLauncher`：`CreateRestrictedToken` 删特权 → `DuplicateTokenEx` 转 primary → Job Object（进程数/内存限额 + KILL_ON_JOB_CLOSE 关句柄即杀）→ `CreateProcessAsUserW` 受限启动。`RestrictedTokenSandbox::available()` 运行时探测并缓存（非写死常量），`omni-cli sandbox check/run` 暴露探测与受限执行。

**两语言边界**：

- **wasm**：TS 经原生 `WebAssembly` 读写内存，以 JSON-RPC 调 `process`（方法：`ping` / `tool_call` / `tools.list` / `session.submit` / `session.ops` / `context.render` / `approval.check`）。
- **native（FFI 热路径下沉，#65）**：`crates/omni-napi` 编译为 cdylib，导出 `napi_register_module_v1`；`napi_*` 符号用 windows-sys `GetProcAddress` 从宿主 node.exe **运行时动态解析**（不链接 node.lib、不依赖 napi-sys，mingw 可编）。TS 侧 `src/native/nativeKernel.ts` 用 Node 内置 `createRequire` 加载 `.node`（src/dist 双候选探测，失败不抛、`available()=false`）。addon 以 JSON-RPC 分发 `tool_call` / `tools.list` / `session.submit` / `session.ops` / `context.render` / `approval.check` / `ping`；`tool_call` 走 `Session::submit(Submission::ToolCall)` + `run_until_idle()` 全链（审批 → 策略沙箱 → **OS 沙箱包装** → 执行 → 记录），wrapped/rejected 标志回传。**panic 安全**：`[profile.ffi]`（inherits release + `panic="unwind"` + `strip="none"`）+ handler 外层 `catch_unwind`，内核 panic 被兜住不炸宿主 Node。`rawCall`（不抛错）/`call`（抛错）分层：内核业务拒绝（危险命令）是合法结果走 `rawCall`，协议/加载错误走 `call`。
- **stdio / TCP**：`omni-sdk` 的 `OmniClient` 以一行一帧的 JSON-RPC 2.0 接入运行中的 TS app-server（`omniharness server`），已实现跨语言真实联调（`threads.create` / `turns.run`）。

**工具链**：GNU（rustup + rustc/cargo 1.98 + rust-lld），无需 MSVC；`.cargo/config.toml` 指定 `linker="rust-lld"` 规避系统 gcc 反斜杠路径坑，`[source]` 走 rsproxy 镜像拉取 crates.io 依赖（含 windows-sys）；wasm 无系统时钟 → `now_iso()` 回退单调计数器。

## 7. 目录结构

```
src/
├── ports/       标准插口（核心唯一依赖）
├── adapters/    各端口实现（model/tool/storage/event/sandbox/approval）
├── core/        agent 循环（agent/turnRunner/stepRunner/toolGate/recorder/container/runtime）
├── context/     上下文投影 + 压缩（assembler/tokenEstimator/compactor）
├── code/        PTC 代码执行（interpreter/executorTool）
├── plugin/      cordis-lite 插件系统
├── skill/       Skills 系统
├── worker/      跨 harness worker 编排
├── server/      app-server（jsonRpc/lineTransport/appServer/httpServer）
├── schema/      单源协议 schema + TS/Python SDK 生成
├── native/      native 适配器（nativeKernel：src/dist 双候选探测 .node + rawCall/call 分层）
├── config/      配置装配 + 配置文件
├── cli/         exec 入口（子命令：exec/server/serve/schema/session/plugin/doctor/native）
└── util/        id/workspaceGuard/outputDecoder
web/             Web UI（单文件）
docs/            本文档
tests/           单测（node:test 零依赖）+ wasm E2E + native E2E
```
