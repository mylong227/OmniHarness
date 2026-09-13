# 单例登记册（P2.1 · SINGLETON_REGISTRY）

> 任务来源：`docs/REFACTOR_BOARD_2026-09-12.md` §P2.1/§P2.2。
> 口径：模块级 `= new` 全量清单来自 `npm run audit:metrics`（AST 实测，43 处）；**「有状态」判定不看类名，看字段可变性**（AST 扫描全部成员字段，2026-09-13 实测）。
> 分类：🟢 无状态可留（实例类 + 组合根单例范式，Phase 5 产物）· 🔴 有状态须收敛（P2.2 清偿对象）· ⚪ 值类型/集合常量（非单例语义）。

## 一、判定结论（诚实口径）

43 处模块级 `new` 中，**真状态化仅 2 处导出单例**（`repoMapContextEngine` 的 TTL 缓存、`skillRegistry` 的技能注册表）
＋ 4 处模块级可变集合/上下文容器。其余 37 处为**零可变字段**的无状态实例（AST 证据见 §三），
其存在理由是 Phase 5 的「实例类 + 组合根单例」范式（消 static 的合法产物），保留不损害架构。

> 原「状态化 34」口径（`audit:metrics` 按类名白名单粗分）是**保守代理指标**：凡不在值类型白名单的类一律计入。
> 本表以字段可变性为准做二次判定，两套数字并存：代理指标用于门禁趋势（只增即红），本表用于 P2.2 清偿范围。

## 二、P2.2 清偿清单（🔴 有状态须收敛 → 组合根装配）

| #   | 单例                                                                                | 状态                                                                   | 收敛动作                                                                                                                             | 状态              |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| 1   | `context/repoMapContextEngine`（`export const repoMapContextEngine`）               | TTL 语义缓存 + 语料缓存（`semanticCache`/`corpusCache`，进程内长寿命） | `memoryStackAssembler` 构造并注入 `StepRunnerDeps`；`stepContextBuilder`/`stepToolExecutor` 改走注入实例；废弃包装函数与模块单例删除 | 🔜 本批           |
| 2   | `skill/skillRegistry`（`export const skillRegistry`）                               | 技能注册表（`skills` 集合，`register` 可变）                           | 组合根 `skillStackAssembler` 已自建实例注入 runtime；`core/agent` 改用注入实例的 `render`；模块级默认实例删除                        | 🔜 本批           |
| 3   | `subagent/worktree.ts :: worktreeLocks = new Map()`                                 | 进程内 worktree 互斥锁表                                               | 保留：锁表语义即进程级资源，无跨实例需求；已登记（缓存键有界）                                                                       | 🟢 保留（有理由） |
| 4   | `util/logger.ts :: traceStorage = new AsyncLocalStorage()`                          | trace 上下文载体                                                       | 保留：Node 内置上下文传播机制，等价于语言运行时设施而非业务单例                                                                      | 🟢 保留（有理由） |
| 5   | `context/codeReferenceGraph.ts :: cache`、`context/projectInstructions.ts :: cache` | memo 化缓存（键有界：路径/内容哈希）                                   | 保留：纯进程内 memo，无业务状态；改注入反而把「缓存」伪造成契约                                                                      | 🟢 保留（有理由） |

## 三、🟢 无状态可留（37 处，AST 字段扫描零可变字段）

### 导出单例（16 处 Phase 5 范式产物）

| 单例                                                                             | 字段证据                                                                   | 备注                                                                                    |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `adapters/approval/guardianPrompt`                                               | 零字段                                                                     | 提示模板构建                                                                            |
| `adapters/model/sseParser`                                                       | 零字段                                                                     | SSE 分帧解析（逐调用状态在局部变量）                                                    |
| `adapters/sandbox/dangerousCommands`                                             | 零字段                                                                     | 危险命令模式表                                                                          |
| `config/configFile`                                                              | 仅 `readonly FILE_NAME` 常量                                               | 配置读写（IO 走参数）                                                                   |
| `config/profileLoader`                                                           | 零字段                                                                     | Profile 加载                                                                            |
| `core/eventFactory`                                                              | 零字段（Phase 5 的 `private static base` 已随去 static 移除）              | 事件工厂；P2.3 判定：**无状态，可留**（已另有 `ports/eventFactory` 注入路径供适配器用） |
| `mcp/mcpConnector` `mcp/mcpProtocol` `mcp/mcpStdioTransport` `mcp/mcpToolMapper` | `mcpProtocol` 11 个 `static readonly` 协议常量（合法命名空间）+ 实例零字段 | MCP 协议域                                                                              |
| `server/jsonRpc`                                                                 | 零字段                                                                     | JSON-RPC 编解码                                                                         |
| `subagent/subagentRuntimeFactory`                                                | 零字段                                                                     | 运行时工厂                                                                              |
| `util/logger`                                                                    | 构造注入 `minLevel`/`sink`（readonly），实例无可变字段                     | 日志门面；`traceStorage` 见 §二#4                                                       |
| `worker/dshWorker`                                                               | 零字段                                                                     | worker 启动工厂                                                                         |

### 非导出模块级单例（18 处，均零可变字段 → 无状态）

`cli/argParser`、`cli/doctorRunner`、`cli/toolLoader`、`config/configBuilder`、
`context/deterministicCompressor`（仅 `readonly encoder`）、`context/lsaEngine`、`context/prefixStability`、
`enterprise/oidcClient`、`genesis/modalityPort`、`genesis/multimodalBridge`、`plugin/pluginBundler`、
`security/ssrfGuard`（3 个 `static readonly` 常量表，合法）、`server/auditExporter`、`skill/moireComposer`、
`tui/tuiRenderer`、`util/commandCanonicalizer`、`util/eigenSpectrum`、`util/unifiedDiff`。

> 非导出实例仅在本模块内部复用，不构成跨模块共享状态；按 D3「不为拆而拆」保留。

## 四、⚪ 值类型/集合常量（9 处，非单例语义）

`context/codeGraph :: NOISE_NAMES`、`adapters/approval/planApproval :: PLAN_ALLOWED_TOOLS`、
`context/contextEngine :: CODE_STOP`、`core/loop/loopGuard :: VOLATILE_KEYS`、
`server/workspaceSearchService :: SKIP_DIRS`（均为只读语义的 `Set`/`Map`）＋ §二#3–#5 四处容器。

## 五、维护纪律

1. **新增模块级 `new` 必须先在本表登记**并注明分类理由；`audit:metrics` 数字只增即红（P0.2 代理门禁）。
2. 🔴 项清偿后从 §二 移入 §三 并附提交哈希；「有理由保留」项必须有上述明示理由，禁止空理由挂账。
3. 判定口径变更须按 D7 留档（原口径为什么错 + 反例）。
