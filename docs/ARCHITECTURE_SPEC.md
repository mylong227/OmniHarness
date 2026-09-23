# OmniHarness 工程项目架构说明书

> 范围：当前已落地架构（六边形端口-适配器 + S+ 发明层）+ UCE 统一基板设计 + 本次新增上下文引擎。
> 数据来源：仓库实测（311 TS 文件 / 31500 行，38 Rust crate / 5936 行，137 测试文件，597 用例）+ 代码审阅。

---

## 1. 总体架构原则

| 铁律         | 内容                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| 语言         | TS（前端/编排）+ ESM + strict；Rust（内核 crate）                                                    |
| 零运行时依赖 | 不引入 tree-sitter / 向量库 / FFI 库；FFI 走宿主 node.exe `GetProcAddress` 解析 napi_*               |
| 一功能一类   | 禁大函数；TS camelCase，Rust snake_case                                                              |
| 形态         | 六边形（端口-适配器）：`src/core/` 只依赖接口，实现在 `src/adapters/`                                |
| 装配         | `Container` + `RuntimeFactory` + `ServiceKeys`；门禁统一 RuntimeFactory 注入（禁 StepRunner 内 new） |
| fail-closed  | 审批门禁→沙箱门禁→执行→记录；未知枚举抛错不静默回落                                                  |

---

## 2. 分层结构

```
src/
├── ports/        15+ 端口接口（Model/Tool/Storage/Event/Sandbox/Approval/
│                 Escalation/Kv/Vault/Retrieval/Spill/Todo/Plan/UserResponder/
│                 ResonantMemory/CosmicWeb 等）
├── adapters/     20 类适配器实现（memory/resonantMemory, memory/cosmicWeb,
│                 sandbox/*, model/openai, model/anthropic ...）
├── core/         仅依赖端口的业务编排（agent 主循环、stepRunner）
├── context/      【本次新增】repoMap.ts + contextEngine.ts（零依赖上下文引擎）
├── search/       bm25.ts（零依赖 Okapi BM25）、toolDiscovery、toolIndex
├── enterprise/   sso.ts（OIDC PKCE+JWKS）、合规导出、审计哈希链
├── util/         workspaceGuard（路径穿越防护）、logger（结构化日志+traeId）
└── cli/          参数白名单严格校验（非法枚举抛错）
```

### 2.1 目录归属表（P3.3 · 与 `scripts/architectureGate.mjs` 口径一致）

> 纪律：**新增目录必须先在此登记**；本表是目录规模门禁（单目录直接 `.ts` ≤ 30）与
> 「一域一目录族」判定的文档侧权威。同名业务域散落 3 个以上顶层目录即违规（P3.2）。

| 目录             | 层归属   | 职责（一域一族）                                                                                                                           | 允许依赖                                      |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `ports/`         | 端口层   | 全部端口接口与纯类型契约；**零实现、零第三方、零 class 行为**（含工具名常量表 `ports/tool/toolNames.ts`）                                  | 无（仅 ports 互引类型）                       |
| `core/`          | 核心层   | 业务编排：agent 主循环、step 执行、审批/沙箱门禁、检查点                                                                                   | 仅 `ports/**`、`util/**`、`errors/**`         |
| `adapters/`      | 适配器层 | 端口实现：model/memory/tool/sandbox/kv/vault/lsp/git/diff/live/embedding/approval/skill                                                    | `ports/**`、第三方 IO（唯一允许层）           |
| `context/`       | 核心域   | 上下文引擎：repo-map、检索、压缩、装配、spill 策略（零第三方）                                                                             | `ports/**`、`util/**`                         |
| `server/`        | 接入层   | AppServer/RPC 承载、HTTP/WS 传输、工作台服务                                                                                               | `ports/**`、`core/**` 装配产物                |
| `cli/`           | 接入层   | 命令行入口、参数解析、子命令                                                                                                               | `ports/**`、装配函数                          |
| `sdk/`           | 接入层   | 嵌入方 SDK（WebSocket 流式客户端）                                                                                                         | `ports/**`                                    |
| `mcp/`           | 协议域   | MCP 协议编解码、连接器、网关                                                                                                               | `ports/**`、`util/**`                         |
| `a2a/`           | 协议域   | A2A 互操作客户端/服务端/传输                                                                                                               | `ports/**`                                    |
| `config/`        | 装配层   | 组合根：ConfigFactory + 各域装配函数 + 配置读写                                                                                            | `ports/**`、各实现（唯一 new 密集区）         |
| `composition/`   | 装配层   | 运行时组合根：`createRuntime` / `OmniHarnessRuntime` / `ServiceKeys`（2026-09-22 由 `core/` 迁出——核心层不该持有装配知识与各实现的值导入） | `ports/**`、各实现（与 `config/` 同为装配层） |
| `errors/`        | 公共层   | 跨层错误类型（`ports/model` 迁出物）                                                                                                       | 无                                            |
| `util/`          | 公共层   | 无业务语义工具（logger/diff/日程/谱工具/**内建默认数据读取 `builtinDefaults` / `endpointDefaults`**）                                      | 无第三方                                      |
| `schema/`        | 公共层   | 结构化输出/代码生成契约                                                                                                                    | `util/**`                                     |
| `search/`        | 核心域   | 零依赖检索原语（BM25、toolIndex）                                                                                                          | `util/**`                                     |
| `eval/`          | 评测域   | Pass@k、bootstrap 置信区间、SWE replay 基建                                                                                                | 无第三方                                      |
| `evolution/`     | 进化域   | RLVR 可验证奖励、样本回放环                                                                                                                | `ports/**`                                    |
| `genesis/`       | 发明层   | 模态/算子/ledger 数学基板（L2/L3 声明区）                                                                                                  | `util/**`                                     |
| `skill/`         | 技能域   | 技能注册、莫尔组合                                                                                                                         | `ports/**`                                    |
| `spark/`         | 发明层   | 燧核引擎集与循环遥测                                                                                                                       | `ports/**`                                    |
| `security/`      | 安全域   | SSRF 防护等安全原语（fail-closed）                                                                                                         | 无                                            |
| `supervisor/`    | 安全域   | 航天级监督内核（FDIR 状态机）                                                                                                              | `ports/**`                                    |
| `enterprise/`    | 企业域   | SSO(OIDC)、审计哈希链、合规导出                                                                                                            | `ports/**`、第三方 OIDC                       |
| `plugin/`        | 扩展域   | 插件宿主、打包、注册源                                                                                                                     | `ports/**`                                    |
| `subagent/`      | 编排域   | 子代理编排器、运行时工厂、worktree                                                                                                         | `ports/**`、`worker/**`                       |
| `worker/`        | 执行域   | DSH 子进程 worker                                                                                                                          | 无第三方                                      |
| ~~`lsp/`~~       | 已收敛   | 原 LSP 顶层目录已并入 `adapters/lsp/`（P3.2，2026-09-13）                                                                                  | —                                             |
| `native/`        | 原生桥   | Rust 内核加载器（`.node`）                                                                                                                 | 无                                            |
| `observability/` | 观测域   | 指标/追踪导出                                                                                                                              | `util/**`                                     |
| `autonomy/`      | 编排域   | 工作流循环错误与自治循环                                                                                                                   | `ports/**`                                    |
| `output/`        | 呈现域   | 输出格式化                                                                                                                                 | `util/**`                                     |
| `tui/`           | 呈现域   | 终端渲染                                                                                                                                   | 无第三方                                      |
| `daemon/`        | 执行域   | 常驻进程例行任务                                                                                                                           | `ports/**`                                    |
| `hooksCompat/`   | 兼容层   | 旧钩子兼容垫片                                                                                                                             | `util/**`                                     |
| ~~`code/`~~      | 已收敛   | 原代码执行工具已并入 `adapters/tool/code/`（P3.2，2026-09-13）                                                                             | —                                             |

以上仅列 `src/` 内的层。**包根另有数据目录**（非 TS 层，故此表不列行，但同样受「新增目录先登记」纪律约束）：

| 包根目录    | 归属       | 职责                                                                                                                                                                                                                                                   | 发布要求                               |
| ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `defaults/` | 声明式数据 | 内建默认档：`ssrf.json`（元数据主机/内网后缀/IPv4 网段）、`providers.json`（厂商目录）、`endpoints.json`（适配器兜底端点/模型/凭据 env 名 + 服务端点地址）；由 `util/builtinDefaults` / `util/endpointDefaults` 读取，`omniharness.json` 或 env 可覆盖 | `package.json#files` 必须含 `defaults` |
| `examples/` | 示例数据   | 插件 catalog 等离线占位数据                                                                                                                                                                                                                            | `package.json#files` 含 `examples`     |

---

## 3. 核心数据流（一次 `turns.run`）

```
CLI/Web ──config.update──> ConfigFile.save ──> normalizeConfig(KNOWN_KEYS fail-closed)
   │
   └─turns.run({prompt,images,files,reasoning})──> agent.runTask(prompt,images,files)
        └─> StepRunner
              ├─ ApprovalGate（审批门禁）
              ├─ SandboxGate（沙箱门禁, fail-closed）
              ├─ ModelRequest{ messages, reasoningEffort } ──> OpenAiCompatibleModel.stream()
              ├─ ContextAssembler.build(events)  ← imagesOf/filesOf 注入用户消息
              └─ eventFactory.user(prompt,images,files) → sessionRecorder → AuditSink(哈希链)
```

**本次新增链路**：`contextEngine.query()` 在 `ContextAssembler` 构造系统消息时调用，注入紧凑 repo-map（Top-14 文件大纲 + Top-30 符号），替代整文件硬塞。

---

## 4. 关键子系统规格

### 4.1 沙箱矩阵（native）

- 多后端：`passthrough / policy / restricted` + `landlock|seatbelt|bwrap`（fail-closed 占位）。
- 真实生效：policy/restricted + Windows `RestrictedToken`（Rust `crates/omni-core/src/restricted_token.rs`）。
- 未知 profile → `UnsupportedSandbox`（一律拒绝，不回落 passthrough）。
- 路径穿越防护：`workspaceGuard.resolve()` 规范化 + `base+sep` 前缀比较，四工具 + 两后端全接入。

### 4.2 审计哈希链（enterprise）

- `AuditSink.record` 写 `seq/prev/hash`：`h_n = SHA256(prev ‖ canonical(e_n))`。
- `verify()` 三重篡改检出；旧日志判 `ok:null`（不可验证，非篡改）。
- `/healthz` + `/readyz` 探针；结构化日志 `logger.ts`（level 过滤 + AsyncLocalStorage traceId，JSON 写 stderr）。

### 4.3 双 BM25 检索（search）

- M1 工具检索：`tool_search`（延迟暴露）；M2 会话检索：`memory_search`。
- 决策：用零依赖 BM25 而非 FTS5（FTS5 依赖 node:sqlite，破 Node 20 兼容）。
- `tokenize()`：ASCII 词 + snake 拆子词 + CJK 单字/二元组（中英混合友好）。

### 4.4 S+ 发明层（自研原语）

- 燧-3 共振寻址（`ResonantMemoryPort.resonateByText`）、燧-4 涡环包、进化闭环（`evolution`）、QEC、免疫监控、宇宙网记忆、元认知。
- 接入范式：引擎 `implements` 被封包端口 → `ConfigFactory.build` 用 `*.enabled` 开关封包 → `XxxController` 经 `RuntimeFactory.create` 透传 → `agent.ts` 任务末 `runXxxIfEnabled`。
- 铁律：默认关、零破坏旁路；无能力启用时不构造控制器。

### 4.5 本次新增：上下文引擎（context）

- `repoMap.extractSymbols(relPath, content)`：零依赖正则抽取 函数/类/接口/类型/常量/方法（TS/JS/Py），产出 `SymbolNode{file,line,kind,name,signature}`。
- `contextEngine.indexCorpus(root)`：遍历源码 → 建符号级 + 文件级双 BM25 索引。
- `contextEngine.query(q)`：**混合打分**——文件分 = max(文件BM25分, 0.7×文件内最强符号分)，Top-14 文件大纲 + Top-30 符号签名。
- 基准（_实测_）：313 文件 / 5022 符号 / 309,433 token 语料，相对 grep 竞品**同等 14 文件预算** token **1/7.95**，相对整语料 **1/114.03**，文件召回 **67.0%**（竞品同预算 60.83%），符号精确率 25.5%。五轮技术尝试中四类（频域共振 / PRF / 44 万边引用图 / LSA）实测无效，采纳词形归并，详见 `docs/U3_CONTEXT_RECALL_EXPERIMENT.md`。

---

## 5. UCE 统一基板（设计态，非焊接）

| UCE 公理            | 现有模块映射                                      | 缺口        |
| ------------------- | ------------------------------------------------- | ----------- |
| 归一：一切皆 `Node` | resonantMemory+cosmicWeb → 合并为 `ResonantField` | U1 统一基板 |
| 守恒：C 账本        | 审计哈希链升格为 C 账本                           | U1          |
| 演变：势函数形变    | `evolution` 闭环 → RLVR 可验证奖励                | U4          |

三缺口（repo-map / eval / A2A）作为场的涌现，而非外挂模块。

---

## 6. 配置契约（关键字段）

| 字段              | 持久化                    | 生效路径                                         |
| ----------------- | ------------------------- | ------------------------------------------------ |
| `model`           | ✅ PERSISTABLE_KEYS       | 重建 agent 生效                                  |
| `approval`        | ✅                        | `resolveApprovals` 读 `fieldOverrides`（热切换） |
| `reasoning`       | ✅（本次新增 KNOWN_KEYS） | `stepRunner.reasoningEffort` → 模型请求          |
| `files`（多模态） | 透传                      | `turns.run`→`agent`→`contextAssembler.filesOf`   |
| `escalation`      | ✅                        | `EscalationPort`                                 |

---

## 7. 测试与质量门禁

- 597 用例 / 591 通过 / 6 skip（代码测试比 ~1.98:1）；Rust cargo test 89 + wasm E2E 10 + native E2E 9。
- `scripts/check.mjs`：零依赖铁律自检（阻断级零违规）。
- `tsc --noEmit`：本次新增 `context/*` 通过（已验证 EXIT=0）。
- API 稳定性：`@beta` 标注实验性导出 293 处；无 `@deprecated`。

---

## 8. 尚缺（诚实清单）

- OS 级沙箱后端（bwrap/seatbelt/landlock）仍 fail-closed 占位，待真机验证。
- **官方 SWE-bench Verified 大规模跑分仍缺**：已有 `benchmark/capability-swebench.json` —— deepseek-chat live **10/10 通过**（$0.20 / 64.7s），但为自研 10 题套件，非官方数据集；U5 扩到官方子集。
- A2A 互操作客户端未建（U6）。
- 共振语义层未与 repo-map 融合（U3，召回天花板症结）。

## 9. 已有真实评测基线（更正：非空白）

- `benchmark/capability-swebench.json`：live 段 deepseek-chat **10/10 通过**（64.7s / $0.20）；scripted 段 10/10。
- `benchmark/efficiency-benchmark.json`：冷启动 p50 86ms、上下文压缩省 80.7%、工具加载减 74.5%、检索 12929 qps、生成代数 1478 万 ops/s、RSS 49.3MB。
- `benchmark/selfcheck.report.json`：6/6 自检性质通过（fail-closed、不灾难遗忘、零依赖+退火单调等）。
- `evals/context-efficiency`：确定性上下文效率基准（114x vs 整语料，7.95x vs grep 竞品同等文件预算，召回 67.0%；含竞品召回对照与三配置 A/B，频域共振/PRF/引用图/LSA 实测见 `docs/U3_CONTEXT_RECALL_EXPERIMENT.md`）。
