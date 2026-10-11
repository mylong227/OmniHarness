# CLI 参考（命令与旗标）

> **本文件是"速查"，权威来源永远是代码与 `--help`**：
>
> ```bash
> node dist/src/cli/exec.js --help              # 子命令用法 + 全部旗标
> node dist/src/cli/exec.js --dump-config       # 打印生效配置（默认值 + 配置文件合并结果）后退出
> ```
>
> 命令分发处：[`../src/cli/execCli.ts`](../src/cli/execCli.ts)；旗标认识面（**新增旗标必须登记**）：
> [`../src/cli/knownFlags.ts`](../src/cli/knownFlags.ts) + [`../src/cli/cliFlagTable.ts`](../src/cli/cliFlagTable.ts)。
> 一键启动与运行规范见 [`STARTUP.md`](STARTUP.md)。

---

## 0. 运行方式

| 方式                      | 命令                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| 源码运行（本仓开发）      | `node dist/src/cli/exec.js <子命令> [旗标]`（先 `npm run build`） |
| 全局 bin（`npm i -g` 后） | `omniharness <子命令> [旗标]`                                     |
| 无子命令（默认路径）      | `omniharness exec --prompt "任务"` 或 `omniharness "任务"`        |

---

## 1. 子命令一览（28 个分发点，按用途分组）

### 服务与工作台

| 子命令                       | 作用                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `serve`                      | **HTTP UI 工作台**（`--port N` / `--auto-approve` / `--mock` / `--workspace DIR`） |
| `server`                     | JSON-RPC **stdio** 常驻服务（给 SDK / 编辑器用）                                   |
| `daemon start\|stop\|status` | 后台常驻 serve（PID 文件管理）                                                     |
| `auth login\|callback`       | 企业 SSO（OIDC 授权码流 + PKCE，需真实 IdP）                                       |

### 执行与编排

| 子命令                            | 作用                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `exec`（默认）                    | 单次任务执行；`-p/--print` = headless（CI）                                                         |
| `goal "<目标>"`                   | 自主目标循环（多轮推进直到达成或达上限）                                                            |
| `workflow --file workflow.json`   | DAG 工作流（多步依赖并发，前序产出注入后续；步骤可用 `when` 声明受控条件）                          |
| `workflow --resume-run <runId>`   | 续跑工作流运行（复用已完成步骤的产出，其余重跑；运行日志在 `<workspace>/.omniharness/graph-runs/`） |
| `routines add\|list\|remove\|run` | 定时任务（interval / cron）                                                                         |
| `tui [demo]`                      | 纯 ANSI 交互式终端 UI（需 TTY）                                                                     |

### 扩展与集成

| 子命令                                       | 作用                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `plugin load\|list\|search\|install\|remove` | 插件管理                                                                                |
| `profile list\|create\|delete\|use`          | 插件集 Profile（一条命令切换编码/研究模式）                                             |
| `bundle pack\|unpack`                        | Bundle 发布单元（补丁叠层 + zip + 可选 HMAC 签名）                                      |
| `mcp serve\|list\|call`                      | 暴露本地工具集 / 列出 / 调用外部 MCP 服务器工具                                         |
| `sdk call --url ws://… --method NAME`        | 用本仓 TS SDK 客户端连 app-server 发一次 JSON-RPC                                       |
| `lsp definition\|references\|hover\|status`  | LSP 代码导航（需自备语言服务器）                                                        |
| `capability …`                               | 能力注册表（协议能力声明与查询）                                                        |
| `boost probe [list]`                         | 探针统一归档 + 跨次比对（只读 `tools/probes/`；`exit 0/1/3` = 通过/仪器坏/判据类结论）  |
| `boost gate`                                 | 按改动挑门禁子集（清单现场读自 `scripts/runGates.mjs`；默认不执行，`--boost-run` 才跑） |
| `boost audit-surface`                        | 输入表面声明的静态取证（入口脚本一变即判声明过期；只覆盖 `scripts/` 下的门禁入口）      |

### 数据、凭据与治理

| 子命令                                                                          | 作用                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------- |
| `session list`                                                                  | 会话列表（`--storage-dir` 指定存档目录）          |
| `trace read --session ID`                                                       | 只读自省会话 trace（冻结条目，不可借道改历史）    |
| `audit export [--compliance]`                                                   | 审计导出 / 合规报告（含完整性哈希）               |
| `kv get\|set\|del\|list`                                                        | 通用键值存储                                      |
| `vault get\|set\|del\|list`                                                     | 凭据保险库（AES-256-GCM）                         |
| `identity generate\|show\|sign\|verify`                                         | 密码学身份（Ed25519，零依赖）                     |
| `license …`                                                                     | 许可证校验与签名资产包（见 ADR-0011）             |
| `schema [--out-ts/--out-py/--out-md]`                                           | 单源 schema 导出                                  |
| `compare`                                                                       | A/B 模型对比                                      |
| `doctor`                                                                        | 环境诊断（沙箱后端可达性、依赖、配置）            |
| `evolution …`                                                                   | 进化闭环（RLVR / GEE Kernel 编排）                |
| `native info\|ping\|tools\|approval\|session-submit\|context\|tool-call\|bench` | 进程内直调 Rust 内核（需 `npm run native:build`） |

> **没有** `eval` 子命令（跑分/对外评测子系统已移除；历史评测数字只在 git 历史与归档文档里）。

---

## 2. 常用旗标（节选）

### 模型与端点

| 旗标                                                                                        | 说明                                                                                                        |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--model-adapter mock\|openai\|anthropic\|responses\|llamacpp`                              | 模型端口（默认 `mock`；`responses` = OpenAI Responses API；`llamacpp` = 本地 Ollama/llama.cpp `/api/chat`） |
| `--mock`                                                                                    | 等价 `--model-adapter mock`（离线演示）；与 `--model-adapter` 同时给出时**以 argv 中后出现者为准**          |
| `--base-url URL` / `--api-key KEY` / `--model NAME`                                         | OpenAI 兼容端点与凭据（**凭据只应放用户级配置或本机环境**）                                                 |
| `--model-router JSON` / `--model-router-file PATH`                                          | 多适配器路由（least-cost / round-robin / by-task / health-fallback）                                        |
| `--turn-token-budget N` / `--context-window N`                                              | 单回合预算 / 上下文窗口（据此在 75% 处压缩）                                                                |
| `--no-model-retry` / `--no-model-circuit-breaker` / `--model-circuit-breaker-*`             | 重试与熔断                                                                                                  |
| `--cost-budget-usd N` / `--cost-budget-on-exceed fail\|warn` / `--cost-budget-soft-ratio R` | 成本硬预算与软阈值                                                                                          |

### 安全（审批 / 沙箱 / 网络 / 提权）

| 旗标                                                                              | 说明                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `--approval auto\|deny\|rules\|guardian\|plan\|ask`                               | 审批端口（默认 `rules`；**`ask` 仅 `serve` 支持**，单跑路径 fail-closed 报错） |
| `--approval-ask allow\|deny`                                                      | `rules` 模式下 ask 时的裁决（默认 allow）                                      |
| `--auto-approve`                                                                  | **仅 `serve`**：启动即跳过审批弹窗（危险）                                     |
| `--sandbox passthrough\|policy\|restricted\|landlock\|seatbelt\|bwrap\|unshare`   | 沙箱后端（默认 `policy`；OS 级不可用即 fail-closed）                           |
| `--network-allow host1,host2`                                                     | 网络外联白名单（**一旦设置即白名单外全拒**）                                   |
| `--escalation deny\|ask\|auto` / `--elevated-sandbox …`                           | 升级审批与提权复核沙箱                                                         |
| `--auth-required` / `--oidc-issuer URL --oidc-client-id ID --oidc-jwks-uri URI`   | 服务端鉴权门禁（`serve`/`server`）                                             |
| `--plan`                                                                          | 计划模式：未批准计划前拦截写类工具                                             |
| `--guard-prompt-injection` / `--guard-prompt-injection-mode off\|shadow\|enforce` | 提示注入护栏（**未显式传时默认 `shadow` 观测档常开**）                         |

### 工作区、配置与存储

| 旗标                                                                     | 说明                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `--workspace DIR`                                                        | 工作区根（工具读写边界）；解析链见 [`STARTUP.md`](STARTUP.md) §6  |
| `--config PATH` / `--profile NAME` / `--plugin-profile NAME`             | 显式配置 / 配置分层 / 插件集（**`--plugin-profile` 仅 `serve`**） |
| `--storage-adapter memory\|jsonl\|sqlite` / `--storage-dir DIR`          | 存储端口（默认 `jsonl` → `~/.omniharness/sessions`）              |
| `--spill-adapter memory\|file` / `--spill-bytes N` / `--spill-preview N` | 大输出外溢策略                                                    |
| `--memory-encrypt` / `--memory-key-file PATH`                            | 长期记忆落盘加密（AES-256-GCM，默认关）                           |
| `--skills FILE.json`                                                     | 受种技能包（可重复；与配置 `skills` 合并，**同名以旗标为准**）    |
| `--tool FILE`                                                            | 加载自定义工具模块（可重复）                                      |
| `--mcp-server NAME=COMMAND`                                              | 桥接外部 MCP 服务器（工具名前缀 `NAME__`）                        |
| `--defer-tools web_search,delegate`                                      | 延迟加载工具（经 `tool_search` 发现）                             |
| `--dump-config`                                                          | 仅打印生效配置并退出                                              |

### 会话与输出

| 旗标                                                                             | 说明                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `-p, --print` / `--output-format text\|json`                                     | headless 执行与输出格式（json = `{ok,sessionId,steps,finalText}`） |
| `--resume ID` / `--fork ID` / `--replay ID`                                      | 续跑 / 分叉 / 回放                                                 |
| `--output FILE`                                                                  | 事件 JSONL 输出文件                                                |
| `--events console\|silent`                                                       | 事件端口（默认 console，进度走 stderr）                            |
| `--stream-text`                                                                  | 流式打印模型文本增量（默认关）                                     |
| `--auto-commit`                                                                  | 执行后用 git 自动提交变更（需处于 git 仓库）                       |
| `--native`                                                                       | 启用 FFI 原生后端（默认开启；不可用自动回退 TS）                   |
| `--subagent-max-depth N` / `--subagent-concurrency N` / `--subagent-max-steps N` | 子智能体编排上限                                                   |
| `--self-verify` / `--no-self-verify`                                             | 写源码后自动跑受限测试并回灌失败摘要（默认开）                     |
| `--decision-engine off\|shadow\|enforce` / `--no-decision-engine`                | Laya 本地决策引擎（默认 `shadow` 观测档）；解释器与权重零配置解析  |
| `--decision-engine-python PATH`                                                  | 决策引擎的 Python 解释器（须装有 `laya`/`torch`；覆盖自动探测）    |
| `--a2a [--a2a-port N] [--a2a-peer URL] [--a2a-transport http\|ws]`               | A2A 互操作（默认关）                                               |
| `--evolution-rlvr …` / `--evolution-kernel`                                      | RLVR 进化闭环 / GEE Kernel 编排（默认关）                          |
| `--version, -V`                                                                  | 打印 `API_VERSION` 并退出                                          |

---

## 3. JSON-RPC（`serve` / `server` 的对外协议面）

传输：`POST /rpc`（JSON-RPC 2.0，批量也支持）+ `GET /events`（SSE 推送）+ WebSocket 帧层。
核心方法（`threads.*` / `approval.respond`）见 [`protocol.md`](protocol.md)；
UI 侧高频方法（`config.get` / `config.update` / `sessions.list{workspace}` / `modes.get` / `modes.set` /
`plugins.*` / `memory.*` / `graph.*` / `workspace.*` / `fs.*`）以 [`../web/src/core/ApiClient.ts`](../web/src/core/ApiClient.ts) 为准。

示例：

```bash
curl -s -X POST http://127.0.0.1:8787/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"config.get","params":{}}'

# 列全部项目的会话（缺省只回当前项目）
curl -s -X POST http://127.0.0.1:8787/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"sessions.list","params":{"workspace":"*"}}'
```

---

## 4. 新增旗标 = 必须登记（否则会被静默打死）

`ArgParser` 对**不认识的 `-` 开头 token fail-closed**。因此任何新旗标都要出现在
`src/cli/cliFlagTable.ts`（取值型/开关型）或 `src/cli/knownFlags.ts`（子命令自解析）之一，
否则 `--your-flag` 会以"未知旗标"报错退出——**哪怕代码里真的在读它**。

判据在 [`../tests/unit/knownFlags.test.ts`](../tests/unit/knownFlags.test.ts)：

1. 源码里每个旗标读取点（reader 式 `.value(`/`.has(` **以及** `Array.includes(`）都必须被接受；
2. 不得与 `FLAG_TABLE`/`VALUE_FLAGS` 重复登记；
3. 登记了但全仓没人读 ⇒ 判据红（防白名单腐化）；
4. 未知旗标必须非零退出并给可读原因；
5. `--help` 与合法子命令旗标不得被误伤（实跑正对照）。

历史教训：`--auto-approve`（`--help` 与文档都写着、代码也真的读）因未登记被"未知旗标"打死；
把判据扫描面补上 `Array.includes(` 后，一次又揪出 `--version` / `--compliance` / `--allow-all` 三个同类。
