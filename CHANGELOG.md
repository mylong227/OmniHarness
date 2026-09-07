# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/) 精神，版本号采用语义化版本（SemVer）。
未发布版本记录在 `Unreleased` 下；每个已发布版本独立成节。

> 注：当前仍处于 0.x 预发布阶段（API 稳定性标注见各导出符号的源码注释），0.x 的次版本号变更可能包含不兼容修改。

## [Unreleased]

### Added

- 审计日志哈希链：`AuditSink.record` 写入 `seq/prev/hash`（`h_n = SHA256(prev ‖ canonical(e_n))`），`verify()` 三重篡改检出（改内容 / 删条目 / 插条目），跨进程重启 `resumeChain()` 续链。旧格式日志判 `ok:null`（不可验证而非篡改）。
- 合规导出接入链校验：`buildComplianceReport` 暴露 `summary.chain`；CLI `audit export --compliance` 仅在链确凿断裂（`ok:false`）时告警退出。
- 健康探针：`GET /healthz`（存活恒 200）与 `GET /readyz`（核心组件齐备才 200，否则 503）。
- 结构化日志基座 `src/util/logger.ts`：level 过滤 + `AsyncLocalStorage` 传播 traceId，JSON 行写入 stderr；接入审计与 HTTP 请求层。受 `OMNI_LOG_LEVEL` 控制（默认 info）。
- 结构化日志全量铺开：agent 主循环 / 回合 / 单步 / 上下文压缩 / MCP 客户端的高频路径均记结构化事件（session.start/end、turn.start/end、model.request、tool.call/denied/native.fallback/spilled、compaction._、mcp._），经 `log.withTrace` 绑定单次会话 traceId。
- API 稳定性标注：实验性子系统导出符号补 `@beta`（共 293 符号 / 100 文件，覆盖 autonomy/subagent/spill/lsp/identity/policy/tui/plan-todo/worker/code/native/mcp/search/eval/schema/daemon/model 新增适配/retrieval/live/audit/enterprise/skill/plugin）；稳定核心（ports 基础接口、Agent、Container、RuntimeFactory、基础适配器）不标。无 `@deprecated` 候选。
- 零依赖规范自检 `scripts/check.mjs`：阻断级（零运行时依赖 / 禁止第三方裸导入 / TS 文件名 camelCase）恒 exit 1；报告级（文件>400 行、函数>80 行）默认提示，`--strict` 升级为阻断。
- CI 工作流 `.github/workflows/ci.yml`：gate（check + typecheck + build）与 test（npm test + 内置覆盖率文本）。
- 企业能力（D1/D2）：分发包硬化、`src/enterprise/sso.ts` OIDC 库（PKCE S256 + RS256 JWKS + `EnterpriseAuth.authenticate` fail-closed）、`auth login|callback` 子命令、合规导出。
- CLI 枚举参数严格校验（9 个白名单，非法值抛错而非静默回落 passthrough）。
- 工程化基建：ESLint v9 扁平配置（typescript-eslint，仅真 bug 规则 error，未用变量 warn）+ Prettier 3 风格基线；铁律自检 / ESLint / Prettier 三者各司其职，互不抢活。
- 覆盖率门禁 `scripts/coverageGate.mjs`：零依赖解析 Node 内置覆盖率表，行覆盖率低于阈值（默认 80%）exit 1。
- 零依赖 pre-commit 钩子（`scripts/git-hooks/pre-commit`，经 `core.hooksPath` 激活）：铁律自检 + ESLint + Prettier 增量格式化已暂存文件。
- 集中错误码 catalog `src/errors.ts`：`OmniError` 基类 + `ErrorCode` 常量；核心错误类统一继承（带 `code`）。
- 提示注入缓解基线 `src/security/promptInjection.ts`：`PromptInjectionGuard.scan` 启发式检测，仅观测不阻断。
- SSRF 加固：`NetworkEgressGuard` 默认拦截私有/链路本地地址（含云元数据 169.254.169.254、IPv6 ::1/fe80/fc00/fd00），白名单不可覆盖；`blockPrivateRanges` 逃生口。
- 提权复核沙箱默认 `policy`（fail-closed）：`CliDefaults.elevatedSandbox` 与 `ConfigFactory` 回落点由 `passthrough` 翻转，枚举扩 `'restricted'`。
- eval 烟雾任务扩容（2→6）；新增混沌/故障注入测试 `sandboxRobustness.test.ts`。
- CI：gate job 增 `npm run lint`；test job 改 `npm run coverage:check`（构建+测试+覆盖率+门禁合一）。
- **U2：repo-map 上下文引擎接入生产循环**：新增 `src/context/repoMapContext.ts`（进程级按 workspace 根路径 TTL 缓存索引，fail-closed，任意失败返回 null 不崩 agent）；`ContextAssembler.build` 支持动态系统碎片（向后兼容）；`StepRunner` 每步从最近 ≤3 条 user 消息推导查询、取 repo-map 注入 system 消息；`agent.ts` 经 `config.workspaceRoot` 注入。配套 `contextEngine.indexCorpus` 新增 `light` 开关（跳过频域共振/44 万边代码图/LSA SVD，仅留已验证有效的 morph+双 BM25，省时且召回不变）。默认开，env `OMNI_REPO_MAP=0` 关闭。此前该能力仅躺在基准脚本里、真实任务未用上。
- **U4：写类工具执行后主动失效 repo-map 缓存**：`StepRunner.runToolCall` 在 `write_file`/`apply_patch`/`shell`/`delegate`/`subagent` 等 `MUTATING_TOOLS` 成功执行后调用 `clearRepoMapCache(workspaceRoot)`，消除纯 30s TTL 的陈旧窗口（native 与 JS 双执行路径均覆盖）；`maybeInvalidateRepoMap` 全程 fail-closed。新增 U4 不变量单测。
- **本地 Embedding 依赖登记 + 语义召回骨架（破 U3 语义鸿沟）**：按新铁律登记 `@huggingface/transformers`（Apache-2.0，预算超限已显式审批，allowlist 覆盖 `maxInstallKb`/`maxTransitiveDeps`）。新增 `src/ports/embedding.ts`（`EmbeddingPort`，第三方-free 端口层）+ `src/context/semanticRecall.ts`（`SemanticIndex` 余弦最近邻 + `rrfMerge` 混合检索融合，DI 注入端口）+ `src/adapters/embedding/transformersEmbedding.ts`（真实适配器，动态 `import()` 懒加载、模型缺失 fail-closed 回退 BM25）。单测用确定性 FakeEmbedding 证明：查询词与代码字面不同但语义同义时 BM25 漏召回、向量召回命中（U3 残留鸿沟被补）。生产接线（repo-map 同时走语义召回）待模型权重就绪后接入。详见 `docs/EMBEDDING_EVALUATION.md`。
- **真实 LLM live 跑分脚手架（evals/live/bench.mjs）**：复用 `src/eval/evalHarness.ts` 的 `runTask`（已泛化为可注入真实 `ModelPort`，并将 `EvalTask.script` 改为可选 + 结果新增 `usage` token 统计）。脚本读 `OMNIHARNESS_API_KEY`/`DEEPSEEK_API_KEY`/`OPENAI_API_KEY` 与对应 `BASE_URL`，用 `OpenAiCompatibleModel`（DeepSeek/OpenAI 兼容）跑真实编码任务，产出 steps/tool_calls/tokens/成功率。无密钥时打印设置指引并 exit 1，**绝不伪造 mock**；已用不通端点做端到端冒烟测试，确认配置→模型→Agent→RuntimeFactory→模型调用全链路贯通（仅联网失败被如实捕获）。

### Fixed

- 安全：CLI 枚举参数（含 `--sandbox`）由 `as` 裸强转改为白名单校验；`SandboxManager.build` 未知 profile 返回 `UnsupportedSandbox`（fail-closed），消除拼错即静默全放行的 fail-open 链。
- 测试：清理 `native*` 三件套共 12 处 `console.warn + return` / 裸 `return` 静默假绿，改 `test({ skip })` 真跳过。
- 安全：NetworkEgressGuard 漏防 IPv6 环回 `[::1]`（URL hostname 带方括号未剥离）→ `hostOf` 规范去方括号，SSRF 判定统一覆盖 IPv6。
- 可观测性（#OBS-1）：`ToolGate.gate` 把真实拒绝原因（plan mode 未批准 / 审批策略名 / 沙箱拒绝 reason+category+target）透传到 `ToolResult.error`，不再一律压缩成 `"被拒绝: <name>"`。修复 plan mode 用户看到 shell/write_file "失败"却没有任何详情、误以为工具坏的问题——现在 UI/日志直接拿到根因与修复建议。新增 `tests/unit/toolGateDenialReason.test.ts` 覆盖三类透传路径，codeMode/MCP 两处依赖旧字符串的测试同步放宽为 `/拒绝/`。
- **live 跑分 token 用量遗漏（#S29 计量断点）**：`StepRunner.run` 此前只记 `recorder.assistant(text)`，丢弃模型返回的 `usage`，导致事件流无 `usage` 字段、`extractUsage` 恒扫不到、`evals/live/bench.mjs` 全程 `tokens=n/a`。新增 `model` 事件类型 + `EventFactory.model` + `SessionRecorder.usage`，在每步模型响应后立即落库 `usage`，`extractUsage` 现能聚合真实 token 成本。
- **live 评审过严误判**：`fix-off-by-one` 任务原先强校验 `apply_patch` 工具名，但 agent 用整文件重写（`write_file`）同样正确修复了 off-by-one；改为校验修正后文件内容含 `i <= n`（正确性导向），并通过。真实跑分现 3/3 全通过。
- 测试：cliEnumValidation 误将已合法枚举值 `restricted` 当非法值断言（与提权沙箱扩枚举冲突）→ 改用真不在枚举内的值 `passthru`。
- 工程化：`scripts/check.mjs` 的「函数体 >80 行」检测存在 brace-on-next-line 盲区（`function foo()\n{` 写法因开括号不在签名同行而被整段跳过）。改为签名行先匹配、开括号同行则直接用、否则向下（跳过空行/纯注释）最多 3 行定位开括号（箭头体收窄到 2 行防误挂后续无关块），盲区已堵。
- 启动#OBS-3：`buildModel` 用 `args.model === CliDefaults.model` 字符串相等判断「用户是否显式设了 model」——极常见场景下误判：用户配置文件里写 `model: "deepseek-v4-flash"`（恰等于 CliDefaults 占位符），被覆写成 `gpt-4o-mini`，发到 deepseek 端点 → HTTP 400 (`supported: deepseek-v4-pro/flash/vision-exp, you passed gpt-4o-mini`)。改为 `args.model ?? env.OPENAI_MODEL ?? 'gpt-4o-mini'`（`??` 真测 undefined，不再字符串比较），anthropic/responses/llamacpp 三处同样 bug 同步修复。端到端：turns.run 真实命中 `deepseek-v4-flash` 返回「你好！有什么可以帮你的吗？…」，日志无 `model.http.error`。#OBS-2 修复后立即暴露此 bug，两者连环生效——前者让 CLI 能起来真打 API，后者保证打 API 时模型名是用户要的。

- **#OBS-4 — 模型下拉只显示当前选中那一个**：「重新刷新网页时，当前 key 能用的全部模型应全部显示」。根因：`providerPresets.ts` deepseek 兜底仍写 `['deepseek-chat','deepseek-reasoner']`（2026 老版本已作废）+ `modelCatalog()` 仅当 `probeCache` 真测过才列全模型，但探测需 UI 点「检测」才触发——冷启动刷新时下拉永远只 1 项。双重修：① 兜底更新到 `deepseek-v4-flash / -v4-flash-vision-exp / -v4-pro`（实测存在）；② `AppServer` 构造里 `fire-and-forget` 调 `warmActiveProvider()`——按 `baseUrl→modelAdapter+providerKeys` 反查当前 active 厂商并探测，把 `/v1/models` 真实清单灌进 `probeCache`；mock/纯本地适配器跳过探测避免无意义流量。端到端冷启动 + 等 7s 后 `model.catalog` 立即返回 `active.models: [flash, pro, vision-exp]` 三项，不再只 1 个。
- **#OBS-5 — DeepSeek v4 多轮对话 HTTP 400**：错误 `reasoning_content in the thinking mode must be passed back to the API`。原实现依赖 `reasoning` 事件先于 `assistant` 事件到达，事件时序脆弱，跨回合混编就丢字段。修法：① `EventFactory.assistant`/`SessionRecorder.assistant` 增 `reasoning?: string` 可选形参；② `StepRunner.run` 把同一回合 `output.reasoning` 同步塞进 assistant 事件；③ `contextAssembler` 优先读事件自身 `payload.reasoning`，退到老路径 `pendingReasoning`。同一回合思考+正文原子绑定一条事件，下轮 API 必收到 `reasoning_content`。端到端 `create` + `continue` 两轮真模型对话正常返回，无 `model.http.error`。

### Changed

- **依赖铁律翻转：零依赖 → 必要即可依赖（准入制 + 分层隔离）**：`scripts/check.mjs` 由「禁止一切第三方依赖」改为「准入登记 + 分层隔离」四闸门——依赖须登记于 `dependency-allowlist.json`；登记字段 `reason`/`capability`/`license`/`approvedAt`/`layer` 缺一即阻断；许可证仅允 permissive（拒绝 GPL/AGPL/SSPL/BUSL 等）；`src/ports/**` 与 `src/core/**` 恒为第三方-free（架构不塌的底线）。新增机器可读 `dependency-allowlist.json` 与 `docs/DEPENDENCY_POLICY.md`。既有零依赖实现（BM25 / RFC6455 / Ed25519 / N-API FFI / LCS diff）全部保留，不因政策放宽而废弃；当前 `dependencies` 仍为 0。看板 LOCKED 项「零依赖铁律」同步更名为「依赖准入门禁」（门禁恒锁定 ON，严禁 OFF）。
- **默认 `--sandbox` 从 `passthrough` 翻转为 `policy`（P0 安全行为变更）**：开箱即默认拦截危险命令 + 工作区外路径（对标 Codex/Claude 默认拦截）；CLI 默认值（`CliDefaults.sandbox`）与配置文件回落点（`loadedFile.sandbox ?? args.sandbox ?? 'policy'`）同步翻转。需显式 `--sandbox passthrough` 才退回全放行。
- 测试门禁：`package.json` test 脚本加 `--test-timeout=120000` 兜底。
- 分发包：`files` 增补 `examples` / `omniharness.json.example`，加 `publishConfig` / `prepublishOnly` / `repository` / `homepage` / `bugs`。
- CLI 入口 `src/cli/exec.ts` god-class（原 2153 行）拆解为薄调度层 + 继承链 6 个基类（`cliBuildConfig` / `cliServerCmds` / `cliMcpCmds` / `cliDataCmds` / `cliCompareCmds` / `cliNativeCmds` / `cliAgentCmds`）；方法体逐字节等价，仅 `private`→`protected`。`package.json` bin 仍指向 `dist/src/cli/exec.js`，`main()`/`isEntry` 留在该文件；零运行时依赖 / Node 20 兼容 / 禁大函数铁律不变。
- 文件级「过大」债务清零：`src/server/appServer.ts`（原 864 行）拆为继承链三文件——`appServerBase.ts`（共享状态 + 核心助手）/ `appServerHandlers.ts`（profile·bundle·plugin 处理器）/ `appServer.ts`（叶：graph·memory·线程·runGraph 调度）；`AppServerOptions`、三常量（`AUTO_ALLOW`/`DENY_ALL`/`PERSISTABLE_KEYS`）、`GraphRunState` 外提 `appServerState.ts`。`AppServer` 经 `appServerState` 再导出 `AppServerOptions`，对外 API 不变；`loadPlugins`/`applyPluginProfile` 保持 `public`。
- `src/config/omniharnessConfig.ts`（原 666 行）拆为配置类 + `configBuilders.ts`（`build*` 自由函数族）；工具注册簇（`defaultTools` + `registerCore/Agent/AuxiliaryTools` + `demoWorkers`）再外提 `configToolRegistry.ts`。`ConfigFactory.build()` 内 `this.`/`ConfigFactory.` 调用改为自由函数调用；`SubagentPortSeed` 补 `export type`。
- `src/plugin/registry.ts`（原 472 行）拆为 `PluginRegistry` + `registrySources.ts`（4 类 `RegistrySource` 实现与远程抓取助手）；旧文件 `export *` 保 API。
- `scripts/check.mjs` 报告级「文件 >400 行」债务清零：当前 243 个 TS 源文件全部 <400 行、函数体全部 <80 行。
- 死代码清理：引入 `eslint-plugin-unused-imports`（devDep）安全批量摘除未用导入（只动 import 不碰局部变量，零副作用风险）；`@typescript-eslint/no-unused-vars` 剩余 9 处局部变量/参数逐一最小化修复（未用参数加 `_` 前缀、未用 `const` 删除、`ed25519Identity` 累加器 `o` 去末次赋值捕获）。ESLint 警告由 386 → 0。`.omni-worktrees/**` 加入 ESLint ignores（harness 运行时 worktree 产物，非本仓库维护源码）。
- 文件级「过大」债务清零：`src/cli/args.ts`（原 583 行）拆为 `args.ts`（CLI DTO/默认值/解析入口，287 行）+ `cliEnums.ts`（9 个枚举白名单常量，51 行）+ `cliFlagTable.ts`（VALUE_FLAGS + valueOf/checkEnum/enumOf + FLAG_TABLE 数据驱动表，263 行）。`args.ts` 经 `export *` 再导出枚举常量、`export { checkEnum }` 再导出校验函数，外部 import 路径不变；无运行时循环依赖（cliEnums 仅 `import type`，cliFlagTable 仅 `import type` 回指 args）。公开 API 与解析行为逐字节等价。

### 2026-09-06 完善度补齐（对标业界成熟 harness）

#### Added

- 仓库常驻指令加载：AGENTS.md / AGENTS.override.md / CLAUDE.md / CLAUDE.local.md（含 @import 嵌套）与 llms.txt，按用户级/项目级/子目录级分层注入系统上下文。
- headless 模式：`-p` / `--print` 单次非交互执行 + `--output-format json` 机器可读输出；`approval=ask` 在 CI 无 stdin 环境显式失败（防挂起）。
- 多档权限：在 auto/deny/rules/guardian/ask 基础上新增 `plan` 只读档。
- MCP：协议版本对齐 2025-06-18；新增 resources/prompts 能力声明与对应方法（未配置后端返回空列表）。
- 检查点文件级回滚：checkpoint 基于 git 工作树差异快照工作区，rollback 同时还原对话与代码。
- SSRF 防护：云元数据端点默认拦截，A2A HTTP 与 provider 探针 fail-closed 校验。
- CI `security` job：依赖审计 + 密钥扫描 + 依赖准入检查。
- ADR 文档体系：`docs/adr/` 首批 7 条架构决策记录。

#### Changed

- shell 工具：绑定 `workspaceRoot` 工作区约束、增加输出长度护栏与可配超时；修正与实现不符的「沙箱内执行」注释。
- MCP：保留 `initialize` 握手（协议核心，未移除），补全能力声明。

#### Fixed

- 审计遗留：检查点此前仅回滚对话事件、不回滚文件（自称「Escape 式安全网」实为半截 rewind），现已补齐文件级回滚。

## [0.1.0] - 预发布基线

- 六边形端口-适配器架构；22 工具 / 20 端口 / 20 类适配器。
- Rust 内核 N-API FFI（免 MSVC / 免 FFI 库）；工具名别名桥使标准工具下沉 Rust。
- 沙箱多后端（passthrough / policy / restricted + landlock|seatbelt|bwrap fail-closed）；升级审批 EscalationPort。
- 双 BM25 语义检索（工具检索 + 会话检索）；配置四层合并；Spill 外溢；MCP 双向；subagent；plan/todo/UserResponder；goal/ralph 自主长循环；agent-team/workflow DAG。
- 审计落盘 + 导出（json/table/csv）+ 在线 `audit.query` RPC。
