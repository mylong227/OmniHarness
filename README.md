# OmniHarness

> 通用 Agent Harness：**TypeScript 负责 CLI / Web 前端 / 编排，Rust 负责原生内核**。
> 一次 agent 任务被拆成「审批 → 沙箱 → 执行 → 记录」的链路，全链路 **fail-closed**：可审计、可拒绝、可复现。

- **语言**：TypeScript（ESM + strict，CLI / 前端 / 编排）+ Rust（原生内核 crate）
- **形态**：六边形（端口-适配器）—— `src/core/` 只依赖 `src/ports/` 接口，实现在 `src/adapters/`
- **规模**（本机实测 2026-09-22）：`src/` 560 个 `.ts` / 约 6.6 万行；`web/src/` 104 文件 / 约 1.3 万行；`tests/` 335 文件 / 约 3.8 万行；`crates/` 6 个 crate / 约 4.9 千行 Rust
- **依赖**：`dependencies` 为 **0**（仅一个可选运行时 `optionalDependencies`：`@huggingface/transformers`）；第三方依赖走**准入登记 + 分层隔离**，`ports/**` 与 `core/**` 恒为第三方-free
- **许可**：Apache-2.0

---

## 目录

1. [这是什么](#1-这是什么)
2. [核心能力](#2-核心能力)
3. [架构总览](#3-架构总览)
4. [快速开始](#4-快速开始)
5. [CLI 命令速查](#5-cli-命令速查)
6. [Web 工作台](#6-web-工作台)
7. [扩展：插件 / MCP / A2A / 技能 / Hooks](#7-扩展插件--mcp--a2a--技能--hooks)
8. [Rust 内核](#8-rust-内核)
9. [配置](#9-配置)
10. [项目结构](#10-项目结构)
11. [质量门禁与 CI](#11-质量门禁与-ci)
12. [技术方向与成熟度治理](#12-技术方向与成熟度治理)
13. [诚实清单](#13-诚实清单)
14. [仓库内的第二套资产](#14-仓库内的第二套资产)
15. [许可证与贡献](#15-许可证与贡献)

---

## 1. 这是什么

An agent harness 是包裹模型的那一层系统：它决定模型能看到什么上下文、能调用哪些工具、动作是否被允许、过程是否留下证据。OmniHarness 的目标很直白：**不拼积木丰富度，拼可靠执行的默认架构**。

它的构想分两层：

| 层             | 内容                                                                                       | 状态                            |
| -------------- | ------------------------------------------------------------------------------------------ | ------------------------------- |
| **工程层**     | 六边形端口-适配器 + Rust 原生内核 + S+ 发明层（24 个隐喻引擎，全部声明成熟度等级且默认关） | 已落地                          |
| **技术方向层** | UCE 四公理（归一 / 守恒 / 演变 / **度量**）+ 七条升级主线 T0–T6，全部带可证伪验收标准      | 方向已立，T0 已落地，其余推进中 |

一次 agent 任务在 OmniHarness 里被拆成一条**可审计、可拒绝、可复现**的链路：

```
CLI / Web 工作台
      │
      ▼
组合根 ConfigFactory ──> Agent（会话编排）──> TurnRunner ──> StepRunner
      │                                                        │
      │                          ┌─────────────────────────────┤
      │                          │  ApprovalGate   审批门禁（rules / escalation 热切换）
      │                          │  SandboxGate    沙箱门禁（fail-closed：未知 profile 一律拒绝）
      │                          │  ContextAssembler.build(events)
      │                          │     └─ repo-map 上下文引擎（符号抽取 + 双 BM25 混合打分）
      │                          │  ModelRequest{messages, reasoningEffort} ──> OpenAiCompatibleModel / Anthropic（流式）
      │                          └─ eventFactory → SessionRecorder → AuditSink（哈希链）→ JSONL 会话存储（--resume / --fork）
      ▼
输出：最终文本 + 完整事件轨迹 + 可验证审计链
```

**不可妥协的六条铁律：**

| 铁律        | 内容                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| 分层        | 六边形端口-适配器：`core/` 只依赖 `ports/` 接口；`core → adapters` 违规边已清零（架构门禁 `--strict` 全阻断）  |
| 装配        | 组合根 `ConfigFactory` + `RuntimeFactory` + `ServiceKeys`；门禁统一注入，**禁止业务代码内 `new`**              |
| fail-closed | 审批 → 沙箱 → 执行 → 记录；**未知枚举一律抛错，绝不静默回落**                                                  |
| 依赖        | 准入制 + 分层隔离；`ports/**`、`core/**` 恒第三方-free（架构不塌的底线）                                       |
| 编码        | 一功能一类、禁大函数、严格 TS、公开成员显式标注与 JSDoc（见 [`docs/CODE_STANDARD.md`](docs/CODE_STANDARD.md)） |
| 诚实        | 负结果必须留档；「命名好听」不等于「有机制」—— 隐喻引擎须声明成熟度 L0–L3 并给出测试证据                       |

---

## 2. 核心能力

### 2.1 安全执行底座（fail-closed）

「受约束」落在一条**默认拒绝**的门禁链上：

- **审批门禁**：`auto / deny / rules / guardian / plan / ask` 六档；`rules` 读放行、危险动作按策略裁决；`plan` 为只读规划模式。
- **沙箱门禁**：多后端 `passthrough / policy / restricted` + OS 级 `landlock | seatbelt | bwrap`（后三者在缺失环境 **fail-closed 占位**，不静默放行）。开箱默认 `policy`（拦截危险命令 + 工作区外路径）。
- **路径穿越防护**：`WorkspaceGuard` 规范化 + `base+sep` 前缀比较，四类工具与两个后端全接入。
- **SSRF 加固**：`NetworkEgressGuard` 默认拦截私有 / 链路本地地址（含云元数据 `169.254.169.254`、IPv6 回环 / 本地），白名单不可覆盖。
- **提权复核**：`escalation`（默认 `deny`）+ `elevatedSandbox`（默认 `policy`），提权后仍以收紧沙箱复核。
- **Windows 系统级沙箱**：Rust `omni-core/restricted_token.rs` 绑定 `RestrictedToken` / Job Object。

### 2.2 上下文与检索

输入是高熵的：仓库任意大、历史任意长、工具输出任意脏。上下文工程的目标是——在有限预算里保留信息量最大、最可复用的那一部分。

- **repo-map 上下文引擎**（零第三方）：零依赖正则抽取符号（TS/JS/Py），文件级 + 符号级**双 BM25 混合打分**，注入紧凑 repo-map（Top-N 文件大纲 + 符号签名）替代整文件硬塞。
- **零依赖检索原语**：手写 Okapi BM25（`src/search/bm25Index.ts`）；`tokenize` 覆盖 ASCII 词、snake 子词、CJK 单字/二元组，中英混合友好。
- **确定性压缩 + 前缀稳定治理**：`context/` 自研压缩管线（折叠空行 / 压缩 JSON / 截断长输出 / 去重 / 折叠历史）+ **前缀复用度量**（KV 缓存命中率的根因变量）。
- **Spill 外溢**：超大工具输出落盘（`.omniharness/spill`）或转内存，保留预览字节，跨重启可读回（少擦写即少开销）。
- **可选语义召回**：`EmbeddingPort` + `SemanticIndex`（余弦最近邻 + RRF 混合检索）；真实适配器经动态 `import()` 懒加载，模型缺失 **fail-closed 回退 BM25**。
- **记忆生命周期**：充能 / 衰减 / 解离三态；触底事实解离出耦合图，外部充能可复活；排序封顶以保可复现。
- **双 BM25 通道**：M1 工具检索（`tool_search` 延迟暴露）+ M2 会话检索（`memory_search`）。

> **诚实基线**：生产默认走 BM25（文件召回 43.3%，零成本）；开语义 Hybrid 为 59.1%（+15.8pp，需 22MB 模型 / 81s 构建）；e5-large 为 64.8%（+5.6pp，但 321MB / 23.6min，17.5× 构建税）。早期「67.0%」口径已被判为虚高并修正。

### 2.3 审计与可观测

- **审计哈希链**：`AuditSink.record` 写入 `seq / prev / hash`（`h_n = SHA256(prev ‖ canonical(e_n))`），`verify()` 可检出**改内容 / 删条目 / 插条目**三类篡改；旧格式日志判 `ok:null`（不可验证 ≠ 篡改）。
- **合规导出**：`buildComplianceReport` 暴露链校验摘要，CLI `audit export --compliance` 在链确凿断裂时告警退出。
- **结构化日志**：`src/util/logger.ts` 支持 level 过滤 + `AsyncLocalStorage` 传播 traceId，JSON 行写 stderr；主循环 / 回合 / 单步 / 压缩 / MCP 高频路径全埋点。
- **健康探针**：`GET /healthz`（存活）与 `GET /readyz`（核心组件齐备才 200）。
- **检查点还原**：`checkpointManager.restoreFiles` 支持文件快照的**手术式还原**（会话 + 代码双回滚）。

### 2.4 验证与评测

- **八道门禁**：依赖准入 `check` · 类型 `typecheck` · 规范审计 `audit:standard` · 增量门禁 `audit:standard:delta` · 成熟度 `audit:maturity` · 架构 `arch:gate --strict` · 覆盖率 `coverage:check` · API 稳定性 `api:check`。全部进 CI 与 pre-commit 钩子。
- **编码标准硬门禁**：禁 `var` / 禁 `any` / 显式访问修饰符 / 公开成员 JSDoc / 文件名 = 类名 / 上帝类红线（> 500 行 或 > 25 成员）。
- **成熟度分级（L0–L3）**：每个以物理 / 生物 / 化学命名的引擎必须声明等级 —— **L0** 命名级（只是普通启发式）、**L1** 结构同构（可等式推理）、**L2** 动力学同构（同一差分 / 微分形式）、**L3** 可证性质（理论定理被单测机械证明）。**说 L3 必须有测试**，否则降级。
- **可证伪验收 + 反泡沫清单**：任一路线「跑不出数字不得声称完成」；同时明确列出**不做**的东西（向量数据库 / tree-sitter / microVM / GPU RL 训练 / 新增隐喻引擎 / 物理量背书）。
- **真实评测基线**（非空白）：
  - `benchmark/capability-swebench.json`：live 段 deepseek-chat **10/10 通过**（64.7s / $0.20）；scripted 段 10/10。
  - `benchmark/efficiency-benchmark.json`：冷启动 p50 86ms、上下文压缩省 80.7%、工具加载减 74.5%、检索 12929 qps、RSS 49.3MB。
  - `benchmark/selfcheck.report.json`：6/6 自检性质通过（fail-closed、不灾难遗忘、依赖准入 + 退火单调等）。
  - `evals/context-efficiency`：确定性上下文效率基准（相对整语料约 114 倍 token 缩减，相对 grep 竞品同等文件预算约 7.95 倍）。

### 2.5 编排与执行

- **三种执行形态**：单次 `exec`；自主长循环 `goal`（多轮推进直到达成或达上限）；DAG 工作流 `workflow --file`（多步依赖并发，前序产出注入后续）。
- **子代理与委派**：`--subagent-max-depth` / `--subagent-concurrency` / `--subagent-max-steps` 限制嵌套与并发；`WorkerOrchestrator` 可把任务委派给外部 harness 子进程。
- **常驻形态**：`server`（stdio JSON-RPC）、`serve`（HTTP 工作台）、`daemon`（后台 serve + PID 管理）、`routines`（interval / cron 定时任务）。
- **工具治理**：`--tool` 加载自定义工具模块；`--defer-tools` 延迟加载（经 `tool_search` 发现后再暴露），降低初始上下文占用。
- **会话生命周期**：`--resume` / `--fork` / `--replay`；JSONL 落盘，事件流可回放。

### 2.6 进化闭环与能力沉淀

- **进化闭环**：`FailClosedEvolutionGate`（发现 → 评估 → 晋升，fail-closed）+ **RLVR 可验证奖励**（编译 / 测试绿即奖励）+ 退火接受 + 多样性保留。
- **技能系统**：`SkillRegistry` + 莫尔组合；CRISPR 式精确技能编辑、能力结晶化（相变固化）等原语；技能稀疏化（预算 + 名字命中级豁免）控制注入量。
- **S+ 发明层**：24 个隐喻引擎（L0=8 / L1=8 / L2=3 / L3=5），全部声明等级 + 对应测试门禁，**默认关、零破坏旁路**；无能力启用时不构造控制器。
- **燧核（spark）**：`SparkController` 在任务末端按开关跑一轮循环，产出结构化遥测。
- **长期运行遥测**：`JsonlRuntimeTelemetry` 记录运行时观测并回填闭环参数（真实流量验证：21 条 production 观测、哈希链 ok=true、实花 $0.0003）。

---

## 3. 架构总览

### 3.1 TypeScript：CLI / 前端 / 编排

```
src/
├── ports/        15+ 端口接口（Model / Tool / Storage / Event / Sandbox / Approval /
│                 Escalation / Kv / Vault / Retrieval / Spill / Todo / Plan / UserResponder /
│                 ResonantMemory / CosmicWeb …）—— 零实现、零第三方
├── adapters/     20+ 类适配器实现（model/openai|anthropic|responses|llamacpp、memory/*、
│                 sandbox/*、kv/vault/spill/lsp/git/diff/live/embedding/approval/skill/tool/*）
├── core/         仅依赖端口的业务编排（agent 主循环、stepRunner、审批/沙箱门禁、checkpoint、
│                 loop/ 取消令牌 · 事件持久化 · 循环守卫 · 工具调度）
├── context/      零依赖上下文引擎（repo-map、检索、压缩、装配、spill 策略、前缀稳定）
├── search/       零依赖检索原语（BM25、toolIndex、toolDiscovery）
├── server/       AppServer/RPC 承载、HTTP/SSE/WebSocket 传输、工作台服务
├── cli/          命令行入口、参数白名单严格校验（非法枚举抛错）
├── mcp/ a2a/     协议域（MCP 编解码/连接器/网关；A2A 互操作）
├── enterprise/   OIDC SSO（PKCE+JWKS）、审计哈希链、合规导出
├── security/     SSRF 防护、提示注入观测（fail-closed）
├── supervisor/   监督内核（FDIR 状态机，航天级容错思路）
├── subagent/ worker/ daemon/ autonomy/   编排与执行域
├── genesis/ spark/     S+ 发明层数学基板与燧核引擎集
├── evolution/ eval/    进化闭环与评测基建（Pass@k + bootstrap 置信区间）
├── plugin/ skill/      扩展域
├── native/             Rust 内核加载器（.node）
└── config/ util/ errors/ schema/ output/ tui/ observability/ hooksCompat/ …
```

> 完整目录归属表（与 `scripts/architectureGate.mjs` 门禁口径一致）见 [`docs/ARCHITECTURE_SPEC.md`](docs/ARCHITECTURE_SPEC.md) §2.1。**新增目录必须先登记该表**。

### 3.2 Rust：原生内核

`crates/` 是 Rust 工作区，把「不该由 GC 语言承担的」系统层能力下沉：

| crate          | 职责                                                                                    |
| -------------- | --------------------------------------------------------------------------------------- |
| `omni-core`    | 内核最小闭环：agent loop + JSON-RPC 事件流；含 Windows `RestrictedToken`、Job Object 等 |
| `omni-cli`     | 内核 CLI：exec / tools / run / approval / context / sdk                                 |
| `omni-napi`    | Node 原生插件（`.node`）：手写胶水 + GNU 工具链可编，**无需 MSVC**                      |
| `omni-sdk`     | Rust SDK：JSON-RPC 2.0 客户端运行时（stdio / TCP）                                      |
| `omni-sdk-gen` | 单源 schema → Rust 服务端类型生成器（对齐 TS `src/schema/codeGenerator`）               |
| `omni-wasm`    | 把 `omni-core` 编译为 wasm32 cdylib，暴露 C ABI JSON-RPC 供 TS 侧调用                   |

> **FFI 下沉**：Node 进程内直调 Rust 内核（N-API / `.node`），**不引入 FFI 第三方库**，走宿主 `node.exe` 的 `GetProcAddress` 解析 `napi_*`。`native info` 显示 `available:false` 时先 `npm run native:build`。

### 3.3 关键子系统

| 子系统     | 说明                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 沙箱矩阵   | `passthrough/policy/restricted` + `landlock/seatbelt/bwrap`；真实生效为 policy/restricted + Windows `RestrictedToken`（Rust `omni-core/restricted_token.rs`） |
| 审计哈希链 | 见 §2.3；多数开源同类无可验证审计链，本项目超配项                                                                                                             |
| 双 BM25    | 工具检索 + 会话检索两条通道；`tokenize` 中英混合友好                                                                                                          |
| S+ 发明层  | 24 个隐喻引擎（L0=8 / L1=8 / L2=3 / L3=5），全部声明等级 + 对应测试门禁，**默认关、零破坏旁路**                                                               |
| Web 工作台 | React 单实现、零打包器（UMD vendor + 原生 ESM），聊天流 + 工具调用可视化 + 11 tab 右侧栏                                                                      |

---

## 4. 快速开始

### 4.1 环境要求

- **Node.js** ≥ 22.18（`package.json` 的 `engines` 声明）
- **Rust**（可选，仅原生内核 / `cargo test` 需要）；Windows 上 GNU 工具链即可，**无需 MSVC**
- 真实模型：任一 OpenAI 兼容端点（OpenAI / DeepSeek 等）

### 4.2 安装与构建

```bash
node -v
npm install
npm run build      # = prepare，产出 dist/
npm test           # 全量单测（构建 + node --test）
```

所有命令经 `node dist/src/cli/exec.js <子命令>` 运行；npm 安装后也可直接用 bin：`omniharness <子命令>`。

### 4.3 一分钟 mock 体验（零 API Key）

```bash
node dist/src/cli/exec.js serve --mock --port 8787
```

浏览器打开 <http://localhost:8787> —— 零依赖三栏工作台。在对话框下达任务（如「列出当前目录的 .md 文件并总结」），即可看到工具调用轨迹。

> 未找到 `omniharness.json` 时会在 stderr 提示，可忽略（默认 mock 模型）。

### 4.4 接入真实模型

**方式 A —— 命令行参数（临时）：**

```bash
node dist/src/cli/exec.js --prompt "读取 README.md 并总结" \
  --model-adapter openai \
  --base-url https://api.deepseek.com \
  --api-key sk-xxx \
  --model deepseek-chat \
  --workspace .
```

**方式 B —— 配置文件（推荐）：**

```bash
node scripts/init-config.mjs      # 在 cwd 生成 omniharness.json
# 编辑 apiKey / baseUrl / model 后
node dist/src/cli/exec.js serve --port 8787
```

也可直接复制 [`omniharness.json.example`](omniharness.json.example) 改名使用。配置字段全部落在严格白名单内（`src/config/configError.ts` 的 `KNOWN_KEYS`），白名单外字段即报错。

**headless / CI 用法：**

```bash
node dist/src/cli/exec.js -p --prompt "..." --output-format json --approval rules --escalation deny
# → {"ok":true,"sessionId":"...","steps":N,"finalText":"..."}
```

> `-p/--print` 会拦截交互审批：`--approval ask` 在无 stdin 的 CI 中会**永久挂起**，故显式报错而非静默卡死（fail-closed）。

---

## 5. CLI 命令速查

**顶层一次性执行**（无子命令）：`omniharness exec --prompt "任务" [选项]`

```bash
# 真机单次运行
node dist/src/cli/exec.js --prompt "..." --model-adapter openai --api-key sk-xxx

# 常驻 app-server（stdio JSON-RPC）
node dist/src/cli/exec.js server

# HTTP UI 服务
node dist/src/cli/exec.js serve --port 8787 [--auto-approve] [--mock]

# 自主长循环 / DAG 工作流
node dist/src/cli/exec.js goal "把 src 下 TODO 清理完" [--goal-max-iterations N]
node dist/src/cli/exec.js workflow --file workflow.json

# 富终端 TUI（需 TTY）
node dist/src/cli/exec.js tui [demo]

# 环境诊断 / 版本
node dist/src/cli/exec.js doctor
node dist/src/cli/exec.js --version     # 打印 API 契约版本（API_VERSION）
```

**子命令一览：**

| 子命令                                                                                        | 作用                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `exec`                                                                                        | 单次任务执行（默认路径）                                           |
| `server`                                                                                      | JSON-RPC stdio 常驻服务                                            |
| `serve`                                                                                       | HTTP UI 工作台（`--port` / `--auto-approve` / `--mock`）           |
| `goal "<目标>"`                                                                               | 自主目标循环，多轮推进直到达成或达上限                             |
| `workflow --file`                                                                             | DAG 工作流编排（多步依赖并发，前序产出注入后续）                   |
| `tui [demo]`                                                                                  | 零依赖交互式终端 UI                                                |
| `mcp serve \| list \| call`                                                                   | 暴露本地工具集 / 列出 / 调用外部 MCP 服务器工具                    |
| `kv get \| set \| del \| list`                                                                | 通用键值存储                                                       |
| `vault get \| set \| del \| list`                                                             | 凭据保险库（AES-256-GCM）                                          |
| `profile list \| create \| delete \| use`                                                     | 插件集 Profile（命名插件组合，一条命令切换编码 / 研究模式）        |
| `bundle pack \| unpack`                                                                       | Bundle 发布单元（可 patch 插件叠层 + 零依赖 zip + 可选 HMAC 签名） |
| `native info \| ping \| tools \| approval \| session-submit \| context \| tool-call \| bench` | 进程内直调 Rust 内核（需 `npm run native:build`）                  |
| `lsp <definition \| references \| hover \| status>`                                           | LSP 代码导航（需自备语言服务器）                                   |
| `identity <generate \| show \| sign \| verify>`                                               | 密码学身份（Ed25519，零依赖）                                      |
| `session list`                                                                                | 会话列表                                                           |
| `audit export [--compliance]`                                                                 | 审计日志导出 / 合规报告（含完整性哈希）                            |
| `daemon start \| stop \| status`                                                              | 常驻后台 serve（PID 文件管理）                                     |
| `routines add \| list \| remove \| run`                                                       | 定时任务（interval / cron 调度）                                   |
| `auth login \| callback`                                                                      | 企业 SSO（OIDC 授权码流 + PKCE）                                   |
| `schema`                                                                                      | 单源 schema 导出（TS / Py / MD）                                   |
| `plugin load \| list \| search \| install \| remove`                                          | 插件管理                                                           |
| `compare`                                                                                     | A/B 模型对比                                                       |
| `eval [--suite PATH.json]`                                                                    | 运行评估套件                                                       |

**常用全局旗标（节选，完整见 `omniharness exec --help`）：**

| 旗标                                                                       | 说明                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------- |
| `--model-adapter mock\|openai\|anthropic\|responses\|llamacpp`             | 模型端口（默认 mock）                                     |
| `--base-url` / `--api-key` / `--model`                                     | OpenAI 兼容端点与凭据                                     |
| `--approval auto\|deny\|rules\|guardian\|plan\|ask`                        | 审批策略（默认 rules）                                    |
| `--sandbox passthrough\|policy\|restricted\|landlock\|seatbelt\|bwrap`     | 沙箱后端（默认 policy）                                   |
| `--network-allow host1,host2`                                              | 网络外联白名单（设置即 fail-closed）                      |
| `--escalation deny\|ask\|auto` / `--elevated-sandbox`                      | 升级审批与提权复核沙箱                                    |
| `--workspace DIR`                                                          | 工作区根目录（工具读写边界）                              |
| `-p, --print` / `--output-format text\|json`                               | headless 执行与输出格式                                   |
| `--config PATH` / `--profile NAME` / `--plugin-profile NAME`               | 配置分层与插件集 profile                                  |
| `--resume ID` / `--fork ID` / `--replay ID`                                | 续跑 / 分叉 / 回放历史会话                                |
| `--spill-adapter memory\|file` / `--spill-bytes` / `--spill-preview`       | 大输出外溢策略                                            |
| `--subagent-max-depth` / `--subagent-concurrency` / `--subagent-max-steps` | 子代理编排上限                                            |
| `--tool FILE`                                                              | 加载自定义工具模块（可重复）                              |
| `--mcp-server NAME=COMMAND`                                                | 桥接外部 MCP 服务器（可重复）                             |
| `--defer-tools web_search,delegate`                                        | 延迟加载工具（经 `tool_search` 发现）                     |
| `--plan`                                                                   | 计划模式：未批准计划前拦截写类工具                        |
| `--memory-encrypt` / `--memory-key-file`                                   | 长期记忆加密落盘                                          |
| `--native`                                                                 | 启用 FFI 原生后端（Rust 内核 in-process，不可用自动回退） |
| `--auto-commit`                                                            | 执行后 git 自动提交（对标 Aider 的 git 安全网，opt-in）   |

---

## 6. Web 工作台

`serve` 启动后打开 `http://localhost:8787`：**零打包器、零网络依赖**（React / ReactDOM 走 `web/vendor/` UMD；`web/src/*.ts` 经 `tsc` 编译为原生 ESM）。协议：`POST /rpc`（JSON-RPC 2.0）+ `GET /events`（SSE 推送）。

| 区域   | 能力                                                    |
| ------ | ------------------------------------------------------- |
| **左** | 会话列表 + 工作区文件树                                 |
| **中** | 对话 + 实时轨迹流（reasoning / 工具调用树 / DiffBlock） |
| **右** | 设置 / 指标 / 插件市场 / 记忆 / 编排 / 配置集（11 tab） |

- **设置**：运行时改模型 / 审批 / 沙箱 / 工作区 → `config.update`（落盘 `omniharness.json`；凭据 / 工作区不回写）
- **指标**：token / 成本 / 步数 / 工具调用数（`/metrics`）
- **插件市场**：搜索 / 安装 / 卸载 / 重新加载，危险权限高亮
- **记忆**：检索 / 增 / 改 / 删长期记忆（`memory.*`），可选 AES-256-GCM 加密
- **编排**：声明式 Agent 图（DAG）编辑与实时运行（`graph.*`）
- **配置集**：命名插件组合切换 + bundle 打包 / 解包（`profile.*` / `bundle.*`）

**前端实现说明**：组件层为 **class 组件**（React 类组件范式），控制器层为纯 TypeScript 类（`AppController` 门面 + `Session` / `Composer` / `Graph` 子控制器 + `AppReducers` 纯归约类），与「一功能一类、禁自由 `function`」的编码标准一致。

**JSON-RPC 直调示例：**

```bash
curl -s -X POST localhost:8787/rpc -d '{"method":"memory.list","params":{}}'
curl -s -X POST localhost:8787/rpc -d '{"method":"graph.run","params":{"id":"demo"}}'
```

---

## 7. 扩展：插件 / MCP / A2A / 技能 / Hooks

### 7.1 插件（cordis-lite）

一个插件 = 一个目录，含 `omni.plugin.json`（清单）+ 入口文件（默认 `index.js`）：

```
my-plugin/
├── omni.plugin.json   # 清单（必须）
└── index.js           # 入口（默认；可由 manifest.entry 改）
```

```js
// examples/plugins/hello-tool/index.js（精简）
export default {
  meta: { name: 'hello-tool', inject: ['port.tools'] },
  apply(ctx) {
    const tools = ctx.services.get('port.tools');
    tools.register(
      {
        name: 'hello',
        description: '示例工具：回问候语',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '被问候者' } },
        },
      },
      async (call) => ({
        callId: call.id,
        ok: true,
        output: `hello, ${call.arguments.name ?? 'world'}!`,
      }),
    );
  },
};
```

**权限白名单**（10 项，未声明 = 无能力；超白名单 = 安装 / 加载即拒）：

`fs.read` · `fs.write`⚠️ · `fs.delete`⚠️ · `net.connect` · `net.listen`⚠️ · `proc.exec`⚠️ · `env.read` · `env.write`⚠️ · `store.read` · `store.write`⚠️

> 完整指南见 [`docs/PLUGIN_GUIDE.md`](docs/PLUGIN_GUIDE.md)；示例见 `examples/plugins/`。

### 7.2 MCP

既是 MCP **服务器**（`mcp serve` 暴露本地工具集），也是 MCP **客户端 / 网关**（`--mcp-server NAME=CMD` 桥接外部服务器，工具名前缀 `NAME__`）。当前实现对齐 MCP 2025-06-18（tools / resources / prompts）。

### 7.3 A2A

跨厂商 agent 互操作协议域：传输 / 服务端已建，**客户端待建**（见 §13）。

### 7.4 技能与 Hooks

- **技能系统**：`SkillRegistry` + 莫尔组合；技能稀疏化（预算 + 名字命中级豁免）控制注入量。
- **Hooks 兼容层**：`CodexHooksMapper` / `ClaudeCodeHooksMapper` / `HooksCompatAdapter` —— 把 codex-claude / claude-code 的事件格式映射进本项目的 hook 消费面。

### 7.5 跨 harness worker 编排

`WorkerOrchestrator` + `WorkerRegistry`：可注册 `CliWorker` / `SimpleWorker` / **`DshWorker`**（DeepSeek Harness 子进程），把任务委派给外部 harness 执行（`--worker-dsh PROFILE`）。

---

## 8. Rust 内核

```bash
npm run rust:test        # cargo test --workspace
npm run native:build     # 构建 .node 原生内核（node scripts/nativeBuild.mjs）
npm run native:test      # native E2E（tests/napiE2e.cjs）
npm run wasm:test        # omni-wasm 构建 + wasm E2E（tests/wasmE2e.mjs）
node dist/src/cli/exec.js native info    # 查看原生后端是否可用
```

内核 crate 与职责见 §3.2。要点：

- **N-API 手写胶水**：GNU 工具链即可编译，无需 MSVC；宿主 Node 内 `catch_unwind` 保护（`profile.ffi` 用 `panic=unwind` + 不 strip，与 wasm 的 `panic=abort` 分离）。
- **Windows 系统级沙箱**：`omni-core/restricted_token.rs` 用 `windows-sys` 绑定 `RestrictedToken` / Job Object——纯 API 绑定，mingw 链接 `advapi32` / `kernel32` 即可。
- **wasm 面向体积优化**：`release` profile 用 `opt-level="z"` + LTO + 单 codegen 单元 + `panic=abort` + strip。

---

## 9. 配置

### 9.1 `omniharness.json`（严格白名单）

```json
{
  "modelAdapter": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "YOUR_API_KEY_HERE",
  "model": "gpt-4o-mini",
  "storageAdapter": "jsonl",
  "storageDir": ".omniharness/sessions",
  "approval": "rules",
  "sandbox": "policy",
  "escalation": "ask",
  "elevatedSandbox": "policy",
  "maxSteps": 32,
  "longTermMemoryEncryption": false,
  "longTermMemoryKeyFile": ".omniharness/memory.key",
  "mcpServers": {}
}
```

- 生成方式：`node scripts/init-config.mjs`，或复制 `omniharness.json.example`。
- **非法字段即报错**（`normalizeConfig` 严格校验，`KNOWN_KEYS` 白名单）—— 拼错即失败，不静默。
- `omniharness.json` 已加入 `.gitignore`（含凭据，**切勿提交**）。

### 9.2 配置分层（`--profile`）

合并优先级：**内置默认 → 用户级 → 项目级 → profile 覆盖 → 环境变量 → 显式 CLI**。
`./profiles/<NAME>.json` 或 `~/.omniharness/profiles/<NAME>.json` 覆盖项目默认；支持 key 别名归一化与严格校验。

### 9.3 凭据分层纪律（个人数据零入库）

真实密钥**只**放用户级 `~/.omniharness/omniharness.json` 的 `providerKeys`（在仓库树之外，
任何克隆/发布物天然不含个人数据）；项目级 `omniharness.json` 只放非个人配置；
仓库内仅保留模板 `omniharness.json.example`（占位值）。曾放仓库树的 `.env` 形态已废除——
eval / bench 脚本（`eval:live`、`eval:swebench`、`eval:cache-probe`、`longrun:prod:real` 等）
在环境变量缺失时会自动回退读取用户级 `providerKeys`（`src/eval/liveCredentials.ts`），
无需任何仓库内密钥文件。机器兜底：`npm run check:secrets`（pre-commit 已接入）扫描
暂存内容中的形似真实密钥的模式，命中即提交中止——个人数据在机制上不可能抵达发布物。

---

## 10. 项目结构

```text
src/                     # TypeScript 主源码（六边形端口-适配器，见 §3.1）
  ports/ adapters/ core/ context/ search/ server/ cli/ mcp/ a2a/
  enterprise/ security/ supervisor/ subagent/ worker/ daemon/ autonomy/
  genesis/ spark/ evolution/ eval/ plugin/ skill/ native/ config/ util/ …
crates/                  # Rust 内核工作区（omni-core / -cli / -napi / -sdk / -sdk-gen / -wasm）
web/                     # React 工作台（UMD vendor + 原生 ESM，零打包器）
  src/{core,ui,types}/   # ApiClient / EventStream / 组件 / 控制器层
  styles/ vendor/ test/  # 样式 / React UMD / 挂载测试
tests/                   # 单元 + 集成 + smoke + stress（unit / integration / bench / fixtures）
scripts/                 # 门禁与工具（check / auditStandards / architectureGate / coverageGate …）
docs/                    # 文档中心（见 docs/README.md 索引；adr/ 决策记录；library/ 理论库）
examples/                # 插件与演示（plugins/ hello-tool / pdf-read / github-tools …）
evals/                   # 评测脚本与报告（context-efficiency / live / recall-* / a2a-loopback）
benchmark/               # 能力与效率基准（capability-swebench / efficiency / selfcheck / longrun）
resources/               # 遗留研究资产（见 §14）
.github/workflows/       # CI（ci.yml / release.yml）
omniharness.json.example # 配置模板
dependency-allowlist.json# 依赖准入清单（机器可读）
```

---

## 11. 质量门禁与 CI

```bash
npm run check                  # 依赖准入 + 分层隔离四闸门
npm run typecheck              # tsc --noEmit
npm run lint                   # ESLint（真 bug 规则 error）
npm run format:check           # Prettier 校验
npm test                       # 全量单测
npm run test:integration       # 集成 / 端到端分层
npm run coverage:check         # 行覆盖率门禁（默认 80%）
npm run audit:standard         # 规范审计（var / any / JSDoc / 上帝类 / 文件名=类名）
npm run audit:standard:delta   # 增量门禁（只阻断本次新增违规）
npm run audit:maturity         # 隐喻引擎成熟度 L0–L3 声明门禁
npm run arch:gate -- --strict  # 架构门禁（core↔adapters 依赖方向 + ports 纯度）
npm run api:check              # 公开 API 稳定性契约（@public/@beta/@deprecated）
npm run web:test               # Web 构建 + 挂载单测
```

**CI（`.github/workflows/ci.yml`）**：多个 job —— `gate`（铁律自检 + 类型 + 构建 + lint + api:check + audit:maturity + audit:standard + arch:gate --strict）、`web`（Web 构建 + 单测）、`test`（覆盖率 + 集成）、`eval`（零 key SWE replay + Pass@k + 排序否决器回溯）、`security`（npm audit + prettier + gitleaks）、`rust`（fmt + clippy `-D warnings` + test）、`e2e`（smoke + stress）、`wasm`（构建 + E2E）。

**pre-commit 钩子**（`scripts/git-hooks/pre-commit`，经 `npm run install-hooks` 激活）：铁律自检 + ESLint + Prettier + `audit:standard:delta` 增量阻断。

> 编码标准权威文档：[`docs/CODE_STANDARD.md`](docs/CODE_STANDARD.md)。**新文件必须完全干净**（零 `var` / `any` / 隐式访问 / 缺 JSDoc / 文件名 ≠ 类名 / 上帝类）。

---

## 12. 技术方向与成熟度治理

工程层之上有一条技术主线，以 **UCE 四公理**为骨架，全部带可证伪验收标准：

| 公理       | 含义                                         |
| ---------- | -------------------------------------------- |
| Ⅰ 归一     | 表示统一（copresheaf / 粘合）                |
| Ⅱ 守恒     | **记账不变量**（会计量，**非物理守恒**）     |
| Ⅲ 演变     | 适应度爬山 + 退火（Lyapunov 单调量）         |
| Ⅳ **度量** | 优化 / 检索 / 匹配必须在**正确的几何**上进行 |

**实测负结果的统一诊断**：项目的实测负结果（LSA 叠加后符号精度 25.5% → 10.5%、PageRank 零增益、频域共振零增益、PRF 有害、层化图路由 −9.1pp）根因统一诊断为**度量错配**——在错误的空间里比较相似。因此升级主轴不是加能力，而是**换到正确的数学空间做同一件事**。

**成熟度与「隐喻税」**：`docs/library/` 九卷理论库把理论对象逐条映射到代码并标注 L0–L3。「读表法」——找 `L0` 最多的列（那是隐喻税最重处），找 `L3` 列（那是可引以为据的护城河）；**升级的最高 ROI 不是补 L0，而是把 L1 升到 L3**（成本低、可信度跃升）。

七条主线（T0 成熟度治理 ✅ · T1 表示归一 · T2 度量升级 · T3 记忆生命周期 · T4 验证闭环 · T5 训练信号 · T6 栈升级），**可证伪验收是唯一完成判据**。

**反泡沫清单**（明确不做）：向量数据库 / tree-sitter / microVM 容器 / GPU RL 训练 / 新增隐喻引擎 / 物理量背书 —— 理由：违零依赖底线，且实测证明「换度量」比「换存储」更根本。

> 全文见 [`docs/TECH_DIRECTION_SYNTHESIS_2026-09-12.md`](docs/TECH_DIRECTION_SYNTHESIS_2026-09-12.md) 与 [`docs/UNITY_FRAMEWORK_UCE.md`](docs/UNITY_FRAMEWORK_UCE.md)；学科底座见 [`docs/library/`](docs/library/README.md)。

---

## 13. 诚实清单

**知道但没做 / 没验证**（诚实为荣，不假装完备）：

- OS 级沙箱后端（landlock / seatbelt / bwrap）**未在真机验证** —— 本机缺失时 fail-closed，无静默放行。
- **官方 SWE-bench Verified 大规模跑分缺失**：现有 `benchmark/capability-swebench.json` 为自研 10 题套件（deepseek-chat live 10/10，$0.20 / 64.7s），**非官方数据集**。
- A2A 互操作客户端未建。
- 本地 HF embedding 权重未实测（fail-closed 回退 BM25）；OIDC 仅 mock IdP 验证。
- repo-map 语义召回（Hybrid）已实现但生产默认仍为纯 BM25，语义路径待模型权重就绪后接入。
- 浏览器 / computer use 能力**空白**。

**已有真实评测基线**（非空白）—— 见 §2.4。

---

## 14. 仓库内的第二套资产

本仓库的 `resources/`、`scripts/run_*.py` / `evaluate_*.py`、`requirements.txt`、`config.example.yaml`、`BENCHMARKS.md`、`THIRD_PARTY_ASSETS.md`、`assets/` 属于一份**独立的 Python 研究代码 / 论文资产**（Symbolic Policy Learning + ComfyUI 视觉生成），随「公开发布基线」一并合入。

它们**不是**本 README 所描述的 TypeScript Agent Harness 的组成部分：

- 二者同仓并存，各自独立运行、互不依赖。
- TypeScript harness 的构建 / 测试 / 门禁**不涉及**任何 Python 依赖。
- 如需使用该研究资产，按 `BENCHMARKS.md` 与 `requirements.txt` 单独准备环境（CPython 3.10.x + ComfyUI）。

第三方资产（基准数据、模型、节点包等）各自保留其原始条款，见 [`THIRD_PARTY_ASSETS.md`](THIRD_PARTY_ASSETS.md) 与 [`NOTICE`](NOTICE)。

---

## 15. 许可证与贡献

- 源码采用 [Apache License 2.0](LICENSE)。
- 贡献前请读 [`docs/contributing.md`](docs/contributing.md)（一功能一类 / 一函数一职责）与 [`docs/CODE_STANDARD.md`](docs/CODE_STANDARD.md)。
- 文档治理：`docs/` 的唯一入口是 [`docs/README.md`](docs/README.md)；进度 / 状态只认 [`docs/TASK_BOARD.md`](docs/TASK_BOARD.md)。
- 架构变更先落 ADR（[`docs/adr/`](docs/adr/README.md)）再合代码。

---

> **本 README 的依据**：`package.json` / `Cargo.toml` / `src/index.ts` 公开 API 面 / `src/cli/argParser.ts` 用法表 / `docs/ARCHITECTURE_SPEC.md` / `docs/ARCHITECTURE_AND_GAP_2026-09-13.md` / `docs/TECH_DIRECTION_SYNTHESIS_2026-09-12.md` / `docs/library/README.md` / `.github/workflows/ci.yml` 与本机实测（2026-09-14）。数字如与看板不符，以 [`docs/TASK_BOARD.md`](docs/TASK_BOARD.md) 为准。
