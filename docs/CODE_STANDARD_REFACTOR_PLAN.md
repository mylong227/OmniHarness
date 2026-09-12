# 全库代码规范重构计划

> **本文件是分阶段执行账（历史进度），不是独立标准。** 权威规则以 `docs/CODE_STANDARD.md` 为准；
> 当前进度以 `docs/REFACTOR_BOARD_2026-09-12.md` 为准。自 2026-09-12 起，标准已通过常驻 skill
> `omniharness-coding-standard` + Git 提交钩子（`scripts/git-hooks/pre-commit`）+ CI 三重强制，
> **任何时候编码都生效**（详见 `docs/CODE_STANDARD.md` §9）。

> 目标：让全部 `.ts`（`src/`、`tests/`、`web/src/`）符合 `docs/CODE_STANDARD.md` 的规范。
> 盘点口径：AST 全量扫描（`node scripts/auditStandards.mjs`），非正则印象。
> 纪律：每批次完成即跑门禁（typecheck / build / web:build / lint / test），可回滚；
> 并行会话热区文件（`core/stepRunner.ts`、`core/turnRunner.ts`、`adapters/live/**`、
> `ports/toolInputSink.ts`）**不触碰**。

## 盘点基线（改造前）

| 指标                                 | 基线                     | 现状                                                     |
| ------------------------------------ | ------------------------ | -------------------------------------------------------- |
| `.ts` 文件数（excl dist/tests 内联） | 333                      | 362                                                      |
| `var` 用法                           | 0                        | 0 ✅                                                     |
| `any` 用法                           | 0（源码）/ 1（web shim） | 0 ✅                                                     |
| 隐式 public 的类成员                 | **1332**                 | **20**（热区豁免块残留）                                 |
| 顶层 function（src）                 | 261（已导出 163）        | 273（已导出 163）                                        |
| 缺 JSDoc 的公开成员                  | 288 / 813                | 281 / 918                                                |
| 文件名 ≠ 主类名                      | 69                       | **0**（Phase 3 收官：仅 `ports/model` 端口豁免，非违规） |
| 上帝类（>500 行 或 >25 方法）        | 8                        | **1**（仅 `stepRunner` 热区）                            |
| `static` 用量                        | 206 / 36 文件            | **20**（Phase 5 收官：−186，6 文件，全合法）             |
| 单文件 ≥3 个导出类                   | 3                        | **0**（Phase 6 收官）                                    |

## 批次状态

### Phase 0 — 门禁与工具（✅ 已完成）

- `eslint.config.mjs`：`no-explicit-any` 升为 `error`；新增
  `@typescript-eslint/explicit-member-accessibility: error`；热区文件加覆盖块豁免（TODO 待撤）。
- 新增 `scripts/auditStandards.mjs`（AST 盘点）与 `scripts/codemod/memberAccessibility.mjs`（机械修复）。

### Phase 1 — 显式访问权限（✅ 已完成）

- 机械 codemod 补全 **1332 处** 隐式 public 成员为显式 `public`（含构造器参数属性），覆盖 **269 个文件**。
- 语义零变更（隐式 public ≡ 显式 public）；`web/src/types/react-shim.d.ts` 手工补 12 处 + 去 `any`。
- 门禁：typecheck / build / web:build 0 error；lint **0 error**；全量单测 1012/1028 通过
  （8 失败均为既有的 WebSocket/端口 15s 超时环境问题，与本改动无关）。

### Phase 2 — JSDoc 覆盖（待办）

- 目标：813 个公开成员中缺文档的 288 个（src）补齐，含 `@param`/`@returns`。
- 风险：需逐方法理解语义，**不可机械批量**；按模块分批，每批单独提交。
- 建议顺序：`util/` → `context/` → `adapters/` 小文件 → `ports/` 接口。

### Phase 3 — 文件名 = 类名（✅ 已完成，仅 `ports/model` 端口豁免）

- 二选一策略（逐文件判定）：
  - **改文件名**：`errors.ts` → `omniError.ts`（类名 `OmniError`）——推荐，改动集中。
  - **改类名**：仅当类名语义弱于文件名时。
- 必须同步更新全部 import 路径（ESM `.js` 后缀）与 `api:check` 导出清单；`index.ts` 桶文件豁免；
  `ports/**` 接口文件豁免（如 `ports/model.ts` 的 `ModelCallError`）。
- 按 fan-in 分批：低 fan-in（含相对路径 import）先动，每批 tsc+eslint+单测+独立提交；热区 stepRunner 的
  依赖（`core/toolHooks`）暂缓，待热区收口。
- **批次1（提交 `1ed25be`，65→62，实际基线已因 Phase 6 桶拆分降到 65）**：重命名 3 个低 fan-in 单类文件
  `core/eventLog`→`appendOnlyEventLog` / `adapters/model/router`→`modelRouter` / `daemon/routines`→`routineScheduler`；
  17 处 import 路径更新（含 `./eventLog.js` 相对形式漏改一次后补），门禁全绿、单测 15 用例通过。
- **批次2（提交 `e16be43`，62→61）**：`core/checkpoint`→`checkpointManager`（类 `CheckpointManager`）；
  7 处 import 路径更新（src 4 + tests 3），门禁全绿、checkpoint 单测通过。
- **批次3（提交 `aef7789`，61→58）**：重命名 3 个低 fan-in 单类文件
  `cli/doctor`→`doctorRunner` / `cli/execImpl`→`execCli` / `context/lsaRecall`→`lsaEngine`；
  9 处 import 路径更新（含 `./` 相对形式），门禁全绿、单测通过。
  `repoMapContext`（被热区 `stepRunner` 引用）暂缓。
- **批次4（提交 `2d35e7a`，58→53）**：重命名 5 个 fanIn=1 单类文件
  `core/loop/cancellation`→`cancelledError` / `a2a/a2aTransportHttp`→`httpA2aTransport` /
  `adapters/embedding/transformersEmbedding`→`transformersEmbeddingAdapter` /
  `adapters/memory/resonantField`→`resonantFieldEngine` / `server/wsTransport`→`wsConnection`；
  15 处 import 路径更新（含 `./`、`../` 相对形式），门禁全绿、5 个单测文件通过。
  **纪律**：codemod 必须排除 `.omni-worktrees/`（并行会话工作树），否则会误改他人源码。
- **批次5（提交 `2c8da8e`，53→52）**：`sdk/sdkSocket`→`webSocketSdkSocket`（类 `WebSocketSdkSocket`，
  仅 1 类+接口，干净）；2 处 import 更新（含 `./` 相对形式），门禁全绿、sdkStream 单测 7/9 通过
  （#8 真实 WebSocket 端到端 `threads.create` 超时=既存 SDK-WS 环境性 flaky，非回归）。
  另发现 `server/httpServer` 含 `HttpBridgeTransport`+`HttpServer` **两个类** → 属 2 类模块，暂缓/待拆分，不纳入简单重命名。
- **收官（批次 6+，69 → 0）**：后续批次将全部剩余文件名≠主类名文件重命名（类名语义优先，同步更新 ESM `.js` import 路径与 `api:check` 导出清单），并随 9 个上帝类拆分自然消除（`vortexRingPacket`/`cancelledError`/`inMemoryReplayBuffer`/`permissionDeniedError` 等次级文件文件名=类名）。审计 `MAIN CLASS NAME != FILENAME` 仅剩 `ports/model`（端口接口豁免，非违规）。
- **验证（2026-09-11）**：`tsc --noEmit` 通过、`eslint --quiet` 0 错、`tsc` 构建通过；单元 **1145** 用例 **1127** 通过（8 失败 **全部**位于既存环境性 flaky 文件 `appServer`/`httpServer`/`wsTransport`：mock-agent 端到端 64s > 15s 轮询上限、WebSocket/SSE 15s 超时，**无任何模块解析/导出错误**）；集成 **3/3** 通过。结论：重命名 + 9 拆分 **零回归**。

### Phase 4 — 上帝类拆分（✅ 真项清零；仅余热区）

**已完成（各独立提交，行为零变更 + 门禁绿 + 单测通过）**

- ✅ `adapters/lsp/lspProcess.ts`（371 行 / 26 方法）→ 抽出 `LspJsonRpcConnection`（stdio JSON-RPC 传输/分帧/超时），
  适配器只留 LSP 协议语义。提交 `24d0a7c`；lspProcess+lspTools 17/17。
- ✅ `spark/sparkController.ts`（430 行 / 23 字段）→ 抽出 `SparkEngineSet`（20 引擎归拢）与
  `SparkCycleTelemetry`（~95 行遥测映射），控制器字段 23→4。提交 `f903cde`；spark 系列 24/24。
- ✅ `context/repoMapContext.ts`（620 行 / 13 方法）→ 抽出四协作者 `RecallKnobs`（旋钮三级解析，集中 env）、
  `CorpusIndexCache`（TTL/LRU 语料缓存 + 驱逐回调）、`SemanticIndexCache`（语义索引构建/缓存 + 文档装配）、
  `HybridRanker`（RRF 多路融合排序，纯算法可复用）；引擎降为薄编排门面。提交 `b44401e`；repoMapContext 16/16，
  顺带修正 LRU 驱逐对语义缓存失效的空操作 bug。
- ✅ `cli/cliDataCmds.ts`（570 行 / 9 方法，7 个子命令域）→ 抽出 6 个单一职责协作者：`CliArgReader`（共享参数解析，
  组合替代继承）、`KvStoreFactory`（KV 后端工厂）、`SessionCommand`、`PluginCommand`、`ProfileCommand`、
  `BundleCommand`、`AuditCommand`、`StoreCommand`；`CliBuildConfig` 的 flagValue/flagNumber/collectFlags 改为委托
  `CliArgReader`（消重复），并删除一处既有无用 import。提交 `8756869`；cliDataCmds 端到端 7/7（新增单测）。
- ✅ `server/appServer.ts`（659 行 / 31 方法）→ 抽出 4 个领域服务（组合替代「RPC 胶水 + 领域逻辑」混写）：
  `RepoPathGuard`（仓库内相对路径 fail-closed 守卫，安全判定单点）、`DiffReview`（git 审查：file/hunk 级
  stage/revert，真实 git 操作）、`DiffCommentStore`（行内评论工作区级持久化，读失败 fail-open 到空态）、
  `SessionCheckpoints`（会话检查点列表/创建/回滚，只依赖 `StoragePort` 窄接口而非整个 ResolvedConfig）。
  433 行 / 14 方法，全部新文件 ≤165 行且文件名=类名；RPC 名/签名/错误文案/返回结构逐字不变。
  提交 `f6a6416`；新增服务单测 20/20（repoPathGuard 5 / diffCommentStore 5 / diffReview 6 / sessionCheckpoints 4）。

- ✅ `server/appServerBase.ts`（1259 行 / 55 成员 = 17 字段 + 38 方法）→ **收敛为组合根**，抽出 9 个单一职责
  协作者（全部新文件 ≤350 行且文件名=类名）：
  - `ServerConfigStore`（UI 覆盖态 + 落盘 + 工作区列表；凭据打码，`probeProvider` 回调隔离「配置×模型」域）
  - `FsExplorer`（跨工作区文件对话框：browse/mkdir/attach，白名单+大小+数量上限）
  - `WorkspaceTree`（工作区内树形列举与读取，越界校验 + 复用 `safeReadFile`）
  - `SessionArchive`（`.jsonl` 存档聚合：usage 统计 / 会话列表，磁盘空时回退进程内指标）
  - `WorkspaceChanges`（git 优先、会话 `turn_diff` 回退的变更清单）
  - `ModelCatalogService`（厂商探测缓存 / 模型目录 / 运行时模型覆盖解析，独占 probeCache）
  - `PluginHost`（插件容器装配 + 加载幂等 + Profile 应用）
  - `ServerEventBridge`（事件下行 + 审批上行；挂起 resolver 表内聚）
  - `AgentRuntimeHost`（Agent/图端口装配、审批端口解析、Kernel 放宽判定与三类缓存失效）
  - 另抽出 `ServerNoopSupervisor`（原嵌套类，独立成文件以满足「文件名=类名」）。
    继承链 `AppServerBase → AppServerHandlers → AppServer` **保持不变**，对外契约（`loadPlugins` /
    `applyPluginProfile` / `effectiveWorkspace` / `updateConfig` / `bypassSupervisorKernel`）保留薄委托，
    `appServerHandlers.ts` 仅 5 处 `ensurePlugins()` → `plugins.ensure()`；所有服务**构造期装配一次**
    （零每调用开销），工作区根/配置一律 **getter 注入**以兼容 `workspace.switch` 与 `config.update`。
    审计口径：appServerBase 已移出上帝类清单（余 `omniharnessConfig` 伪上帝类与热区 `stepRunner`）。
    新增 9 个测试套件 / 67 用例全绿（纯临时目录 + 临时 git 仓，绕开环境性 flaky 的集成路径）。
    提交 `4d25816`。

- ✅ `config/omniharnessConfig.ts`（764 行）→ **组合根收敛**：真 god 是**单方法 363 行的 `ConfigFactory.build`**
  （interface 段 316 行只是被动数据声明，无逻辑）。抽出 4 个顶层领域装配函数（+ 11 个模块级私有助手）：
  `corePortsAssembler`(118) / `memoryStackAssembler`(230) / `skillStackAssembler`(101) / `sparkAssembler`(101)。
  结果：文件 **764 → 480 行**、`build` **363 → 78 行**、`static` **206 → 206（中性）**、上帝类清单再减 1。
  接口段**逐字保留**（43 个文件 import 本模块，路径与导出名不变，34 处 `ConfigFactory.build` 调用点零改动）。
  新增 4 个测试套件 / 21 用例全绿（临时工作区 + mock 适配器，无网络、无 flaky）。
  门禁：typecheck / build / lint(0 error) / api:check / web:build / 依赖四闸门 全绿；全量 1121 用例 8 失败**全为既有环境性**。

**剩余（待办）**

- `core/stepRunner.ts`（526）→ **热区，暂缓**（并行会话活跃文件）。
- ⚠️ `appServer*` 两兄弟的单测在本机因 **mock agent 单次实跑 64s > 测试内部 15s 轮询上限**而不可靠（本次实测：
  `threads.create` 端到端 64.1s，返回结构正确），拆分只能靠 typecheck + api:check + 新协作者单测兜底，须最谨慎。
  关键回归守卫（`bypassSupervisorKernel` 的 auto/rules 两条）不依赖长跑，仍可作真实门禁。
- 每个文件**独立提交**并跑全量单测，确保行为零变更。
- 拆分范式（已验证，可复用）：读全文件找**职责缝** → 抽出新类**文件名=类名**（顺带满足规范 #2）
  → 原文件留组合门面、导出名与路径不变（调用点零改动）→ 逐文件独立提交 + 跑该模块单测。
- 子范式（命令簇/继承链场景）：抽出协作者类，**不改继承链**（`flagValue` 等 89 处共享方法仍在根类）；协作者经
  `CliArgReader` 组合式取参、经工厂函数注入链上能力 → 命令类不依赖继承链、可独立单测；`protected runXxx` 门面
  签名不变 → `execImpl` 分发点零改动。**测试陷阱**：勿在测试进程内劫持 `process.stdout`（会与 `node --test` 的 TAP
  报告器抢 stdout，致用例丢失），CLI 端到端改用子进程（仿 `cliSystem.test.ts`）。
- 子范式（RPC 门面/服务器场景）：god 不在类自身而在「RPC 胶水与领域逻辑混写」——按**领域**（git 审查 / 评论持久化 /
  会话检查点 / 路径安全）抽独立服务类；服务收 RPC 原始参数并自持校验（错误文案与返回结构逐字保留），门面只留
  `handlers.set` 一行委托；服务在**构造期装配一次**（零每调用构造开销），工作区根以 **getter 注入**以兼容运行时
  `workspace.switch`；依赖只取**窄接口**（如 `StoragePort`）而非整个 `ResolvedConfig`（接口隔离，且可用
  `MemoryStorage` 直接单测）。服务纯逻辑用临时目录/临时 git 仓单测，绕开环境性 flaky 的集成测试。
- 子范式（**组合根/装配场景**，`config/omniharnessConfig` 用）：god 不在类而在「单方法 363 行的 build」——
  按**领域**抽顶层装配函数（`assembleCorePorts` / `assembleMemoryStack` / `assembleSkillStack` / `assembleSpark`），
  `ConfigFactory.build` 收敛为**编排器**（定顺序 + 拼切片），不再亲自装配任何端口。
  三条硬约束：① **保持导出路径不变**（43 个文件 import 本模块，34 处用 `ConfigFactory`）；
  ② 领域装配函数返回**只含 `ResolvedConfig` 字段的切片**，`...spread` 合并——TS 不对 spread 做多余属性检查，
  故**必须让切片不含内部件**，否则多余的 `resonance`/`vortexAdapter` 会静默混进配置对象（把 Spark 专用内部件
  另置于 `sparkInput` 返回）；③ **静态/函数形态选择**：本域已有 `configToolRegistry.ts` 的**顶层函数**范式且
  军规⑥要「减 static」，故一律用顶层函数（若用 `class XxxAssembler { static assemble }` 会新增 16 处 static，
  与 Phase 5 目标冲突）。实测：文件 764 → 480 行、`build` 363 → 78 行、`static` 保持 206 不变。

### Phase 5 — 削减 static（收官，206 → **20**，−186）

- 范式：`export class Xxx` 静态方法族 → 实例类 + 组合根单例（`export const xxx = new Xxx()`）+ 调用点
  `ClassName.xxx(...)` → `xxx.xxx(...)` 零构造复用（沿用批次 A 已验证模式）。高扇入模块用一次性 codemod
  批量重命名 `ClassName.` → `camelName.`，再手工同步 import（仅静态调用的 import 直接改 token；类名仍作
  类型/值的 import 保留并补 singleton）。tsc --noEmit + eslint 双门禁逐批验证。
- **已完成（9 模块 `6f95857`）**：`util/unifiedDiff`、`util/commandCanonicalizer`、`util/eigenspectrum`、
  `context/prefixStability`。
- **已完成（5 模块 `9394581`）**：`server/auditExport`、`tui/render`、`skill/skillComposer`、
  `genesis/modality`、`genesis/multimodalBridge`。
- **已完成（5 模块，第三批 `160f968`）**：`enterprise/sso`(13)、`cli/doctor`(10)、`cli/args`(9)、
  `plugin/bundle`(8)、`cli/toolLoader`(4)。其中 `sso` 的 `EnterpriseAuth.fromIssuer` 静态工厂
  改为顶层工厂函数 `enterpriseAuthFromIssuer`（原无外部调用）；`args` 的 `ADAPTER_PRESETS` 私有静态表
  降为模块级常量；`toolLoader` 唯一调用点（`cliBuildConfig`）改走门面 `loadToolModule`。
- **已完成（1 模块，第四批 `c6c8301`）**：`config/configBuilders`(10) —— `ConfigBuilder` 静态方法族 → 实例方法 +
  组合根单例 + 同名门面函数（内部互调改 `this.`）。
- **已完成（1 模块，第五批 `b9f3f8b`）**：`config/configFile`(6) —— `ConfigFile` 静态方法族改实例类 +
  组合根单例 + 门面；25 处类形式调用改为单例形式，导出路径零改动。
- **已完成（1 模块，第六批 `d676a82`）**：`server/jsonRpc`(7) —— `JsonRpc` 静态方法族改实例类 +
  组合根单例 `jsonRpc`；41 处 `JsonRpc.xxx` 调用改为 `jsonRpc.xxx`，`index.ts` 仍导出 `JsonRpc` 类（API 不变）。
- **已完成（6 模块，第七批 `8fef6c3`）**：`adapters/approval/guardianPrompt`(3)、
  `adapters/sandbox/dangerousCommands`(1)、`adapters/model/sseParser`(2)、`mcp/mcpToolMapper`(3)、
  `config/profile`(2，类 `ProfileLoader`)、`skill/skillRegistry`(1) —— 纯无状态工具类改实例类 + 组合根单例；
  调用点 `ClassName.xxx` → `xxx.xxx`，import 同步引用单例（`SkillRegistry` 保留类名用于类型/值并补 singleton）。
  static 计数 60 → 48。
- **已完成（1 模块，第八批）**：`core/eventFactory`(13) —— 13 个静态工厂方法 + `private static base`
  改实例方法 + 组合根单例 `eventFactory`；自调用原即 `this.base(...)`（非 `EventFactory.base`），去 static 后天然
  转实例调用；21 处调用点（`eventLog`(5) / `sessionRecorder`(9) / `planTool`(3) / `askUserTool`(1) /
  `todoTool`(1) / `eventLog.test`(1)）改为 `eventFactory.xxx`，6 处 import 同步引用单例。 static 计数 48 → 35。
- **已完成（1 模块，第九批）**：`mcp/mcpProtocol`(14→11) —— 仅 3 个纯工厂方法（`text` / `toolResult` /
  `initializeResult`）去 static 转实例方法 + 组合根单例 `mcpProtocol`；11 个 `static readonly` 协议常量
  （版本号 / 方法名 / 错误码）属合法常量命名空间，保留 static，调用点 `McpProtocol.XXX` 不动。3 处工厂调用点
  （`mcpServer` 的 `initializeResult` / `toolResult`×2）改 `mcpProtocol.xxx`，`mcpClient` / `mcp.test` 仅用常量零改动。
  static 计数 35 → 33。
- **已完成（3 模块，第十批）**：`mcp/mcpStdioTransport`(2) / `mcp/mcpConnector`(1) / `worker/dshWorker`(2)
  —— 三个无状态工厂类统一套「实例类 + 组合根单例」范式（`mcpStdioTransport` / `mcpConnector` / `dshWorker`），
  调用点 `ClassName.xxx` 改 `camelName.xxx`；`mcpStdioTransport.launch` 内部 `this.failureOf` 自调用天然转实例调用。
  调用点涉及 `mcpConnector`(`cliMcpCmds`×2 / `mcpGateway`×1)、`dshWorker`(`cliBuildConfig`×1 / `dshWorker.test`×3)、
  `mcpStdioTransport`(`mcpConnector`×1)，import 同步引用单例。static 计数 33 → 28。
- **已完成（3 模块 + 模块级函数，第十一批）**：`subagent/subagentRuntimeFactory`(3)、`core/runtime`(1)、
  `util/logger`(2) —— 这三项无状态但带构造约束 / 状态类，改用「模块级函数」手法：
  `SubagentRuntimeFactory`(3) 去 static 转实例类 + 组合根单例 `subagentRuntimeFactory`（内部
  `SubagentRuntimeFactory.rerootStorage`/`containerOf` 静态自调用转 `this.`）；
  `RuntimeFactory.create`(1) 单方法纯工厂转模块级函数 `createRuntime`（沿用 `enterpriseAuthFromIssuer` 先例）；
  `Logger`(2) 仅 `currentTrace`/`nextTraceId` 两个无状态静态抽成模块级函数 `currentTrace()`/`nextTraceId()`
  （`Logger` 类与 `log` 单例保留）。调用点经一次性 codemod 批量重命名 `RuntimeFactory`→`createRuntime`、
  `SubagentRuntimeFactory`→`subagentRuntimeFactory`、`Logger.nextTraceId(`→`nextTraceId(`，33 个 `src`/`tests` 文件
  同步（含 `index`/`indexBeta` 重导出、`benchmark/*.mjs` 与 `README`/`docs/integration` 示例同步）。
  static 计数 28 → 20（真实类成员 static）。
- **剩余 20 处 / 6 文件 —— 全部为合法 static，Phase 5 收官**：
  - 协议 / 安全常量命名空间（保留 static）：`mcp/mcpProtocol`(11，`static readonly` 版本/方法/错误码)、
    `security/ssrfGuard`(3，常量数据)。
  - 有状态工厂 / smart constructor（保留 static，构造状态实例的合法工厂模式）：`plugin/permissionGate`(3)、
    `native/nativeBackend`(1)、`sdk/sdkSocket`(1，`connect` 构造状态实例)。
  - 有意保留的公共 API（调用点 43+，改动收益低风险高）：`config/omniharnessConfig.build`(1)。
  - 结论：所有「可削减的 static」已削干净；剩余 20 处均为 CODE_STANDARD 认可的常量 / 工厂 / 公共 API 形态，
    继续削减将损害设计（常量必须 static，工厂构造实例为合法 smart constructor，`build` 公共 API 不可改签名）。
    Phase 5 完成。

### Phase 6 — 一文件一类（✅ 已完成）

- 三个「单文件 ≥3 导出类」的 God-module 全部按「每类一文件 + 原文件改桶再导出」拆分，调用点零改动
  （共享函数/类型抽 `*Shared.ts`，原文件仅 `export { X } from './X'` 桶，审计按 `export class` 声明计数故不再计入多类模块）。
- ✅ `adapters/tool/lspTools`（4 类：`LspGoToDefinitionTool` / `LspFindReferencesTool` / `LspHoverTool` / `LspStatusTool`）
  → 4 个单类文件 + `lspToolsShared.ts`（共享 `renderLocation` / `parseTarget`）+ 原文件改桶。
- ✅ `adapters/tool/planTool`（3 类：`PlanWriteTool` / `PlanPresentTool` / `PlanReadTool`）
  → 3 个单类文件 + 原文件改桶。
- ✅ `plugin/registrySources`（4 类：`LocalDirSource` / `BundledSource` / `RemoteHttpSource` / `FileRegistrySource`）
  → 4 个单类文件 + `registrySourcesShared.ts`（类型/常量/共享函数）+ 原文件改桶
  （`plugin/registry.ts` 经 `export *` 透出，零改动）。
- 门禁：tsc --noEmit EXIT=0 / eslint `--config eslint.config.mjs` EXIT=0 / build EXIT=0 /
  `auditStandards` 多类模块 = 0 / 受影响单测 26/26 通过（lspTools 9 + planTodoAsk 13 + registry 4）。
- 单文件 ≥3 导出类：**3 → 0**（Phase 6 收官）。

### Phase 7 — 封装收紧（待办，判断批）

- Phase 1 只是把「隐式 public」显式化；本批在其中识别**本应 private/protected** 的成员并收紧。
- 纯人工判断 + 单测护栏，按模块小步推进。

## 收口判定

全部批次完成后：

- `node scripts/auditStandards.mjs` 中：隐式 public = 0、`any` = 0、`var` = 0、
  文件名≠类名 = 0、上帝类 = 0、单文件多类 = 0。
- `npm run lint` / `typecheck` / `build` / `web:build` 全绿；`npm test` 无新增失败。
