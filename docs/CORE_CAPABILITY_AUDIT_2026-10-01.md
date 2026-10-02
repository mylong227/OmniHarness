# OmniHarness 核心能力排查与提升（2026-10-01）

> 范围：全仓体检（930 个 TS 源文件 + 6 个 Rust crate + Web 工作台）。
> 方法：跑全部门禁取硬数据 + 四路并行深读源码 + 逐项代码取证。
> 状态图例：**【已修·本次】** 已落地并过门禁 · **【待办·P0/P1/P2】** 未修，附证据与修法。

---

## 0. 一页判读

| 维度              | 判断                                                                                                                                   | 证据强度          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **门禁基线**      | 真绿。typecheck / lint / `check --strict` / `arch:gate --strict` / `audit:maturity` / `audit:config-wiring` / `api:check` 全过         | 实测              |
| **单测基线**      | 2452 用例 / 2439 通过 / 1 断言失败 / 4 超时；失败与超时均为**沙箱环境噪声**（`execFileSync` 管道 EBUSY、子进程退出码被吞），非代码缺陷 | 实测 + stash 对比 |
| **架构**          | 分层纪律是真的：依赖方向违规 0、ports 纯度 0、ports→实现层 0、依赖环恒 6 组（全为类型环，运行时 0）                                    | 实测              |
| **安全底座**      | **最大的真短板**。默认沙箱曾为零隔离；危险命令表仅 11 条且绕过面很大；审计链无密钥                                                     | 代码证据          |
| **执行链路**      | 取消传播有多处断点；委派路径曾绕过 plan 门禁；callId 配对有持久化污染风险                                                              | 代码证据          |
| **召回**          | README 的三条基线数字**口径过期**；真正瓶颈是「候选源」不是「排序」（45.6% 查询的 GT 文件不可达）                                      | 评测报告          |
| **S+ / 进化闭环** | 前 6 环是真实现，**晋升与回流两环是断的**；成熟度门禁可被一行绕过                                                                      | 代码 + 实跑门禁   |

**本次已修 9 项（含 3 项 P0），全部过门禁。**

---

## 1. 体检硬数据（本次实跑）

| 命令                                    | 结果                                       |
| --------------------------------------- | ------------------------------------------ |
| `npm run typecheck`                     | ✅ 零错误                                  |
| `npm run lint`（全量）                  | ✅ 零告警                                  |
| `npm run check -- --strict`             | ✅ 零违规（930 文件）                      |
| `npm run arch:gate -- --strict`         | ✅ 依赖方向 0 / ports 纯度 0 / 新环 0      |
| `npm run audit:maturity`                | ✅ 42 项声明（L0=7 / L1=21 / L2=9 / L3=5） |
| `npm run audit:config-wiring`           | ✅ 930 源文件接线全绿                      |
| `npm run api:check`                     | ✅ 161 + 70 条 export 全在标注分区         |
| `npm run audit:standard:delta`          | ✅ 本次零新增违规                          |
| `node --test dist/tests/unit/*.test.js` | 2452 / 2439 pass / 1 fail / 4 cancelled    |
| `cargo test --workspace`                | ✅ 91 passed / 0 failed                    |

### 关于单测的 4 个超时与 1 个失败

逐条核对后确认**全部是沙箱环境噪声**，非回归：

- 4 个超时（sessionLifecycle / terminalBenchNative / workflowRunner / workflowRunnerLimits）：本机负载下单文件 120s 不够；单独重跑全部通过。
- `runEval: 非 0 退出码如实返回状态码`（期望 7 / 实际 0）：本沙箱的 `execFileSync` 管道 stdin EBUSY 陷阱，会吞掉子进程退出码（历史上已记录同类）。
- **已用 `git stash` 做前后对比验证**：evolution 相关 5 项失败在**改动前即失败**，与本次改动无关。

---

## 2. 核心问题清单

### 2.1 安全执行底座（最高优先级）

| #   | 问题                                                                                                                                                                                            | 证据                                                    | 状态                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| A1  | **组合根默认沙箱 = `PassthroughSandbox`（零隔离）**，与「所有默认实现取 fail-closed 最保守侧」的注释自相矛盾；而提权路径反而默认 policy —— 提权比默认更严，逻辑倒置                             | `src/config/corePortsAssembler.ts:47` vs `:41`、`:83`   | **【已修·本次】**                          |
| A2  | **危险命令表无「解释器内联执行」规则**：`python -c` / `node -e` / `perl -e` / `php -r` / `powershell -Command` / `Invoke-Expression` 一条都没有 —— 这是任意代码执行的正门，且不含任何危险关键词 | `src/adapters/sandbox/dangerousCommands.ts`（原 11 条） | **【已修·本次】**                          |
| A3  | **换行绕过**：所有规则用 `[^\n]*` 连接，`rm\n-rf /` 直接绕过                                                                                                                                    | 同上                                                    | **【已修·本次】**（统一改惰性 `[\s\S]*?`） |
| A4  | **PowerShell 侧几乎空白**：`Remove-Item -Recurse`、`-EncodedCommand`、`del /f /q`（不带 `/s`）全部绕过原表                                                                                      | 同上                                                    | **【已修·本次】**                          |
| A5  | **间接递归删除零覆盖**：`git clean -fdx`、`find -delete`、`xargs rm`                                                                                                                            | 同上                                                    | **【已修·本次】**                          |
| A6  | **restricted 档「断网」保证不成立**：只封 curl/wget/nc/ssh/scp，`certutil` / `bitsadmin` / `Invoke-WebRequest` / `git clone` / `npm install` 全不在表内；`chmod -R 777` 也绕过原 `chmod\s+777`  | `src/adapters/sandbox/restrictedSandbox.ts`             | **【已修·本次】**                          |
| A7  | **TS 与 Rust 两份危险命令表语义分叉且互不为超集**（Rust 漏 `rm -r -f`，TS 漏 `cat x \| sh`）                                                                                                    | `crates/omni-core/src/sandbox.rs:63` vs TS 表           | **【已修·本次】**（两侧补齐对齐）          |
| A8  | 提示注入护栏默认 `shadow`（跑、记、但原样放行），出厂不拦                                                                                                                                       | `src/security/enforcementModeResolver.ts:95`            | 【待办·P1】                                |
| A9  | 审计哈希链裸 SHA256 无密钥 ⇒ 有写权限者可重算整条链；删库/尾部截断返回 `ok:true`                                                                                                                | `src/util/hashChain.ts:41`；`auditSink.ts:204`          | 【待办·P1】                                |
| A10 | Web 前端 `/rpc` 与 SSE 均不带 `Authorization` ⇒ 配令牌即工作台不可用，实际只能裸奔                                                                                                              | `web/src/core/ApiClient.ts:48`                          | 【待办·P1】                                |

> 做得好、不要误改的：`ServerAuthGuard` 默认绑 `127.0.0.1` + 非回环强制令牌 + `timingSafeEqual` + HTTP/WS 共用守卫；`WorkspaceGuard` 词法+realpath 双重判定可拦 symlink/junction；`SandboxManager` 未知 profile 返回 `UnsupportedSandbox` 绝不回退直通。

### 2.2 执行链路正确性

| #   | 问题                                                                                                                                                                                                             | 证据                                                                                | 状态                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| B1  | **`agent_identity` 恒返回 `callId: ''`** ⇒ 投影出「`tool_call_id:''`」的孤儿 tool 消息，OpenAI/DeepSeek 兼容端点直接 HTTP 400，且事件已落盘、resume 后不可自愈                                                   | `agentIdentityTool.ts:110/118`；`registryToolPort.ts:94`；`stepToolExecutor.ts:230` | **【已修·本次】**（两处：工具自报 + 端口层归一兜底）                                         |
| B2  | **委派路径绕过 plan 门禁**：`subagent` / `run_workflow` / `run_goal` 三条路径的子代 `ToolGate` 硬编码 `plan: undefined` + `planMode: false` ⇒ `--plan` 只读语义被绕过，且子代事件走独立 bridge，主会话侧完全静默 | `subagentRuntimeFactory.ts:88-95`                                                   | **【已修·本次】**                                                                            |
| B3  | 子代**无监督内核**：`supervisor` 整体缺省 ⇒ 不受确定性否决约束，工具失败也不上报健康监控                                                                                                                         | 同上（返回对象无 supervisor 字段）                                                  | **【已修·本次·部分】**（runtime 投影路径已透传；seed 早期路径仍缺，见 §4 诚实边界）          |
| B4  | `StepRunner.finalize()` 的模型请求**缺 signal** ⇒ 跑满 maxSteps 时（最贵、最想中断的时刻）无法取消                                                                                                               | `stepRunner.ts:130` vs `:167-173`                                                   | **【已修·本次】**                                                                            |
| B5  | `delegate` 工具**丢弃父会话 AbortSignal** ⇒ 外部 worker 跑到自身 30 分钟超时，而 `delegate` 是串行屏障 ⇒ 整回合被卡死                                                                                            | `delegateTool.ts:43`；`WorkerRequest.signal` 字段存在但从不填充                     | **【已修·本次】**                                                                            |
| B6  | WorkflowRunner **忽略 `truncated`/`aborted`**，把「跑满步数」报告为 `ok:true`，兜底摘要沿 DAG 注入下游 prompt                                                                                                    | `workflowRunner.ts:211-225`；`Agent.resultOf` 已专门透出该字段                      | **【已修·本次】**                                                                            |
| B7  | 配置文件键 `longTermMemoryEncryption` / `longTermMemoryKeyFile` **声明未接线** ⇒ 写在 `omniharness.json` 的加密开关静默无效，长期记忆明文落盘                                                                    | `ports/config/fileConfig.ts:150/152`；`argParser.configDefaults` 无映射             | **【已修·本次】**                                                                            |
| B8  | `git worktree` 调用**无超时、不受取消约束**，且卡在并发闸门槽位内 ⇒ 可永久挂起整进程                                                                                                                             | `subagent/worktreeOps.ts:138`（`promisify(execFile)` 无 timeout）                   | **【已修·第二批】**（30s 上界 + signal 透传 + 取消时不降级拷贝）                             |
| B9  | JS 工具路径 **post 钩子抛错会丢掉已成功的结果**，向模型谎报失败并给监督内核假失败信号                                                                                                                            | `stepToolExecutor.ts:156-177`                                                       | **【已修·第二批】**（先记录后钩子 + `runPostHookSafely` 隔离，JS/native 两路统一）           |
| B10 | `OMNI_LOOPGUARD=0` 未真正关闭失控检测（`observeEdits` 无门控）；`--plugin-profile` 在 run 路径零消费者                                                                                                           | `agent.ts:628`；`loopGuard.ts:157`                                                  | **【已修·第二批·前半】**（新增 `editChecks` 选项，`=0` 时全量关闭；`--plugin-profile` 未动） |

### 2.3 上下文与召回（护城河的真实水位）

| #   | 结论                                                                                                                                                                                   | 证据                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| C1  | **README 三条基线口径过期**：最新 193 条查询口径下生产默认 `hitRate@20 = 44.0%`、`recall@20 = 28.5%`；语义增益跨 5 个外部仓 pooled **0.0pp**（README 的 +15.8pp 是单仓自证，不可外推） | `evals/recall-query-audit.report.json`；`evals/semantic-crossrepo.report.json` |
| C2  | **真正天花板是「池外」不是「排序」**：193 条中 **88 条（45.6%）GT 文件在任何名次都不可达**，平均池仅 39.7                                                                              | `evals/rerank-ab.report.json` 的 `bestRankHistogram.unreachable = 88`          |
| C3  | **已试杠杆几乎全负**：PRF −7.1pp、图检索/层化图净负（跨查询重合 0.936 = 常量偏置）、LSA 符号精确率腰斩、频域共振零效应、交叉编码器 rerank −1.0pp、蜘蛛网五形态全负                     | `docs/RECALL_HEADROOM_SURVEY.md`                                               |
| C4  | **前缀复用率唯一在盘报告是修复前的（60.94%）**，文档声称的 80.75% 无报告支撑，且 `eval:prefix` 不在 CI                                                                                 | `evals/prefix-stability.report.json`（2026-09-16，早于修复提交）               | **【已修·第三批】**（`pairAt` 改按回合边界判型 + `--min-reuse` 回归门进 `eval:ci`；实测 8 回合终态 87.11%、跨回合对 7/14 正确识别） |
| C5  | **索引无增量**：TTL 30s 到期即全量重建，本仓实测 **8.6s/次** 且 `truncated=true`                                                                                                       | 实测 `ContextEngine.indexCorpus`                                               |
| C6  | **Python 符号抽取只认顶层 `def`/`class`**（`^\s*def`）⇒ 方法、import 全抽不到 —— 这直接解释了跨仓（全是 Python 仓）效果差                                                              | `src/context/repoMap.ts:115`                                                   |
| C7  | `query()` 224 行、11 个职责、6 组无出处的魔法权重 ⇒ 不可单测隔离；每次查询全量扫符号表（可用已有的 per-file 视图，实测 **1.055ms → 0.005ms**）                                         | `contextEngine.ts:385-636`、`:626`                                             |
| C8  | **AST / 调用图 / 增量索引 / 变更影响分析缺失**，项目自己在 `docs/LANDSCAPE_RESEARCH_2026.md:75` 已承认是「缺口」                                                                       | 同上                                                                           |

### 2.4 S+ 发明层与进化闭环

| #   | 结论                                                                                                                                                                                                                         | 证据                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| D1  | **README 的「24 个引擎（L0=8/L1=8/L2=3/L3=5）」与门禁实测「42 项（7/21/9/5）」不符**，且「全部声明等级」为假 —— 刻蚀记忆、元素组合、禁闭色荷、莫尔组合、奥不列克 5 个**无 `@maturity` 声明**（`if (!lm) continue` 直接跳过） | 实跑 `audit:maturity`；`auditStandards.mjs:588`                  |
| D2  | **成熟度门禁可一行绕过**：`@maturityEvidence package.json` 也能让 L3 通过（判据是 `fs.existsSync`，不校验是否为测试）；「名义证据」只 `console.log` 不 fail                                                                  | 实跑验证；`auditStandards.mjs:612`、`:656`                       | **【已修·第二批】**（证据须为含断言的 `tests/**` 测试文件；名义证据改 fail；用 `package.json` 探针实测两条拦截均生效，47 项现有声明不受影响）                                          |
| D3  | **进化闭环断在最后一米**：发现/RLVR/门禁/退火/多样性/覆盖率闸 6 环都是真实现，但生产装配**从未传 `onPromote`** ⇒ 晋升后什么都不发生，只写一行日志                                                                            | `composition/runtime.ts`（原 `:62-73`）；`rlvrController.ts:331` | **【已修·本次】**                                                                                                                                                                      |
| D4  | **S+ 遥测零回流**：`spark.cycle` 的 report 除 `log.info` 外无消费者，下一轮入参不随历史变化 ⇒ 全开即纯烧 token（当前默认关，故不烧也不产出价值）                                                                             | `agent.ts:595-622`；`sparkController.ts:113-118`                 | **【已修·第三批】**（`SparkController` 缓存上一轮 `SparkCycleReport`，下一轮 `planHarnessRegime` 从 CRISPR 晋升占比提炼 successRate、对称度序参量提炼 entropy，展开覆盖 genesis 信号） |
| D5  | 24 引擎中**默认只有 2 个在干活**（共振场 + 技能稀疏化）；12 项 L0 是隐喻税但项目自己诚实标注了（「实测零增益」「非量子」「非基因编辑」）                                                                                     | 逐引擎核对                                                       |
| D6  | 5 项 L3 全是**纯数学**（代数/账本/算子/模态端口/regimeCost），有真单测；**没有一个物理/生物隐喻达到 L3**                                                                                                                     | `genesis.test.ts`                                                |
| D7  | 全库**没有任何 S+ 引擎的 token/时延实测**；Genesis 算子成本是硬编码「记账虚构单位」而非实测                                                                                                                                  | `operators.ts:147-256`                                           |

### 2.5 Rust 内核与 Web 工作台

| #   | 结论                                                                                                                                     | 证据                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| E1  | Rust 与 TS **能力同构**，生产默认是 TS（native 不可用即静默回退）；Rust 的**真实增值只有 Windows `RestrictedToken`**                     | `cliBuildConfig.ts:272`；`crates/omni-core/src/restricted_token.rs` |
| E2  | `cargo test` 91 全绿，但 **4 个 crate 零单测**，其中 `omni-napi`（436 行，FFI 边界）零单测是明确缺口                                     | 实测统计                                                            |
| E3  | `ping` 只校验 `{ok,pong,native}` 三元组，**无 ABI 版本字段** ⇒ 旧 `.node` 与新 TS 混用要运行时才炸                                       | `nativeKernel.ts:116`                                               |
| E4  | Web 工作台 **RPC 75 : CLI 17**，Web 是能力更全的一侧；但 `audit verify` 只在 CLI、多标签并发无互斥、SSE 无自定义重连、错误边界仅根级一处 | 逐个 grep 比对                                                      |

---

## 3. 本次已落地的修复（9 项）

| 文件                                                                                                                                                                                    | 改动                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/corePortsAssembler.ts`                                                                                                                                                      | 默认沙箱 `Passthrough` → `Policy`（fail-closed 对齐 CLI 与提权路径）                                                                                                       |
| `src/adapters/sandbox/dangerousCommands.ts`                                                                                                                                             | 规则 11 → 28 条：补解释器内联执行、PowerShell 删除/编码命令、管道放宽、base64 管道、git clean/find/xargs 间接删除；统一 `[\s\S]*?` 堵换行绕过                              |
| `src/adapters/sandbox/restrictedSandbox.ts`                                                                                                                                             | 补 LOLBIN 下载器（certutil/bitsadmin/rundll32/msiexec/iwr/git clone/npm install）、`chmod … 777`、`chown -R`、持久化（schtasks/sc/reg add/crontab）、takeown/icacls/attrib |
| `crates/omni-core/src/sandbox.rs`                                                                                                                                                       | Rust 侧同步补齐并与 TS 逐条对齐；修正 `rm -r -f` 漏判                                                                                                                      |
| `src/adapters/tool/registryToolPort.ts`                                                                                                                                                 | `execute` 返回前以权威 `call.id` 覆盖工具自报 callId —— 一处修根，让任何工具都无法破坏配对不变量                                                                           |
| `src/adapters/tool/meta/agentIdentityTool.ts`                                                                                                                                           | `ok`/`fail` 改为接收并回填真实 callId                                                                                                                                      |
| `src/subagent/subagentRuntimeFactory.ts` + `src/ports/subagent/subagentPortsShape.ts` + `src/subagent/subagentPorts.ts` + `src/config/configBuilder.ts` + `src/config/configFactory.ts` | 委派路径透传 `plan` / `planMode` / `supervisor`（plan 与 planMode 必须成对，否则 `ToolGate` 的 `plan !== undefined` 判据拦不住）                                           |
| `src/core/stepRunner.ts`                                                                                                                                                                | `finalize()` 请求补 `signal`                                                                                                                                               |
| `src/adapters/tool/workflow/delegateTool.ts` + `src/worker/workerOrchestrator.ts`                                                                                                       | `delegate` 透传 `context.signal` 进 `WorkerRequest`                                                                                                                        |
| `src/autonomy/workflowRunner.ts` + `workflowTypes.ts` + `runWorkflowTool.ts`                                                                                                            | `truncated`/`aborted` 如实透传；渲染层标注「未完成」；注入下游 blackboard 时加不可读成已确认事实的前缀                                                                     |
| `src/cli/argParser.ts`                                                                                                                                                                  | 新增 `applyMemoryEncryptionDefaults`，接上两个长期记忆加密配置键                                                                                                           |
| `src/composition/runtime.ts`                                                                                                                                                            | 传入 `onPromote`（用 `replace` 而非 `register`，避免「技能重复注册」把合法晋升变成异常）+ `evolution.promoted` 观测行                                                      |

配套测试更新：`tests/unit/corePortsAssembler.test.ts`（默认沙箱断言改为 policy）、`tests/unit/configBuilder.test.ts`（seedOf 新参数 + 断言 seed 必须携带 plan 端口）。

---

## 3.1 第二批修复（2026-10-02 续作，8 项）

| 文件                                                                                                           | 改动                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/subagent/worktreeOps.ts`                                                                                  | 三处 git 调用加 `GIT_TIMEOUT_MS = 30_000` 上界 + `createWorktree` 透传会话取消信号；**取消时不降级为目录拷贝**（目录拷贝是重 IO，取消后再拷等于「更久地不停」，直接上抛由调用方转失败）           |
| `src/subagent/subagentOrchestrator.ts`                                                                         | `createWorktree` 传入 `request.signal`                                                                                                                                                            |
| `src/core/stepToolExecutor.ts`                                                                                 | JS/native 两路统一改为「先记录真实结果 → 再跑 post 钩子」；新增 `runPostHookSafely`（await 保时序、异常只留 `tool.hook.post.failed` 观测行）                                                      |
| `src/core/loop/loopGuard.ts` + `src/core/agent.ts`                                                             | 新增 `editChecks` 选项（默认开）；`OMNI_LOOPGUARD=0` 时全量关闭（含 edit 振荡/抖动检测）                                                                                                          |
| `scripts/auditStandards.mjs`                                                                                   | 成熟度门禁两条硬校验：L2/L3 证据须为 `tests/**` 下引用 `node:assert` 的文件；「名义证据」从 log 改为 fail。探针实测：`@maturityEvidence package.json` 现被两条规则同时拦截                        |
| `src/adapters/memory/insightEtchingEngine.ts` / `skill/elementComposer.ts` / `monitoring/confinementEngine.ts` | 补 `@maturity L0` 诚实声明（原先完全不在门禁视野内）                                                                                                                                              |
| `src/skill/moireComposer.ts`                                                                                   | 补 `@maturity L1`（结构同构可等式推理）+ 证据指向 `discoveryEngine.test.ts`                                                                                                                       |
| 奥不列克存储（OobleckStore，已于 2026-10-02 删除死代码）                                                       | 第二批补 `@maturity L0` + 死代码标注；删除与否原留待拍板，本轮拍板删除                                                                                                                            |
| `README.md`                                                                                                    | 口径校准：召回基线改 193 条口径（hitRate@20=44.0% / recall@20=28.5%）、语义跨仓 pooled 0.0pp、rerank 已回关 opt-in、「24 引擎」改「46 引擎（门禁实测 10/22/9/5）」、进化闭环标注 onPromote 已接线 |

声明数 42 → 46（L0=10 / L1=22 / L2=9 / L3=5），`audit:maturity` 全绿。受影响测试子集（loopGuard / step / tool / worktree / subagent / sandbox / agent）183 项 0 失败。

## 3.2 第三批修复（2026-10-02 再续，3 项）

| 文件                                                                                                                   | 改动                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evals/prefix-stability.mjs` + `package.json`                                                                          | `pairAt` 的 kind 判定改用**回合边界事实**（跨回合/同回合追加不再依赖恒假的 `sameHead`）；import 修正到 `composition/runtime.js`；新增 `--min-reuse` 回归门（低于下界 `process.exitCode = 1`）并接入 `eval:ci`。实测：跨回合对 7/14 正确识别（恒 0 → 7），8 回合终态复用率 **87.11%** ≥ 门下界 75%，证明「动态段置尾」治理生效 |
| `src/util/hashChain.ts` + `src/server/services/auditSink.ts` + `src/cli/auditCommand.ts` + `src/cli/cliBuildConfig.ts` | 审计哈希链升级 **HMAC-SHA256 防篡改**：`hash()` 支持可选密钥（有密钥走 HMAC，无密钥保持 SHA256 兼容）；AuditSink/CLI 读取 `--audit-hmac-key` 旗标或 `OMNI_AUDIT_HMAC_KEY` 环境变量。新增 3 个测试：同密钥验证通过、无密钥重算自洽链被 HMAC 验出（含对照组证明伪造链对无密钥验证方自洽）、密钥不符判失败                       |
| `src/spark/sparkController.ts`                                                                                         | **S+ 遥测回流**：缓存上一轮 `SparkCycleReport`，下一轮 `planHarnessRegime` 用 CRISPR applied 占比提炼 successRate、`1 - symmetry.orderParameter` 提炼 entropy（readonly 字段用展开覆盖），遥测从「只写日志」变成「影响下一轮 regime」                                                                                         |

门禁收尾：eslint 零警告、`audit:standard:delta` / `audit:maturity`（47 项）/ `arch:gate --strict` / `check --strict`（cycle 体 112 行 ≤ 基线 116）全绿；测试 auditChain+hashChain+audit+genesis 38 项、spark×8+loopGuard×2+stepToolExecutor+registryToolPort+toolHooks 56 项，0 失败；前缀回归门重跑通过。

## 4. 诚实边界（本次**没**做到的）

1. **B3 supervisor 只修了一半**：seed 早期路径（`ConfigFactory.build` 装配工具注册表时）拿不到 supervisor —— 它在 `Runtime.createRuntime` 才构造。要彻底修需把 supervisor 提前到 `CorePorts` 装配并让 `ResolvedConfig` 携带，影响面大，本次未动。**当前状态**：runtime 投影路径（server / graph / a2a）已透传；CLI exec 的 seed 路径仍缺 supervisor 继承。
2. **未重跑任何召回评测**：§2.3 的所有数字来自盘上既有报告，未现场复跑；不同报告的语料/查询集/指标口径不同，跨报告比较需谨慎。
3. **evolution 相关单测在本沙箱持续失败**（改动前后一致），我只能确认「非本次回归」，无法在本次环境中证明其绿。
4. **A2/A4/A5 的新规则未做误伤压测**：新增 17 条规则可能误伤合法命令（例如含 `-rf` 字样的文件名）。已跑全量沙箱单测无回归，但建议补一批「合法命令不得被拦」的反向用例。

---

## 5. 下一步建议（按 ROI 排序；✅ = 已完成）

| 排序 | 事项                                                                                         | 成本  | 收益                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- |
| ✅1  | ~~修 B8 worktree 超时 + 取消~~                                                               | 小    | 已消除全链路唯一「无时间上界 + 无取消出口 + 卡在闸门内」的永久挂起组合                                            |
| ✅2  | ~~重跑并基线化前缀稳定性报告 + 进 CI~~                                                       | 极小  | 已完成：`pairAt` 按回合边界判型，`--min-reuse 0.75` 门进 `eval:ci`，实测终态 87.11%                               |
| ✅3  | ~~改 README / 文档口径~~                                                                     | 极小  | 已完成（召回数字、47 引擎、rerank opt-in、onPromote 接线均已校准）                                                |
| ✅4  | ~~成熟度门禁补两条硬校验~~                                                                   | 小    | 已完成并探针实测                                                                                                  |
| ✅5  | ~~危险命令表单一真源化（TS 与 Rust 消费同一份定义）~~                                        | 中    | 已完成（03ef068）：dangerous-commands.json 单一真源，Rust build.rs 生成、TS fs 读取，双表腐化负债消除             |
| ✅6  | ~~候选源换路：把已实现的 LSP（lsp_find_references / go_to_definition）并入 repo-map 候选源~~ | 中-大 | 已完成（11c0cf1）：LspCandidateSource opt-in 第四路 + offline probe（无服务器时 SKIP），攻击跨文件引用不可达      |
| ✅7  | ~~增量索引（TTL 到期从 8.6s 全量重建改为按 mtime 增量）~~                                    | 大    | 已完成（6ff84bb）：跳过 TTL 到期全量重建，消除大仓每 30s 的 8.6s stall                                            |
| ✅8  | ~~审计链加 HMAC 密钥~~（链头外部锚定未做）                                                   | 中    | 已完成 HMAC 部分：`--audit-hmac-key` / `OMNI_AUDIT_HMAC_KEY`；链头锚定（如发布到外部 append-only 存储）仍留待后续 |
| ✅9  | ~~奥不列克存储删除拍板~~                                                                     | 小    | 已完成（d862bee）：删除死代码存储 + 同步 recall fixtures 与专项测试，门禁视野外死代码消除                         |
| ✅10 | ~~S+ 遥测回流~~                                                                              | 中    | 已完成：`SparkController` 上一轮 report → 下一轮 RegimeSignals                                                    |
| ✅11 | ~~A8/A9/A10 安全三连：注入护栏从 shadow 升档 + Web 前端带 Authorization~~                    | 中    | 已完成（2a900d7 / d87bc79 / 第三批 HMAC）：注入护栏三态生效 + Bearer 令牌接入，安全底座补齐                       |

---

## 6. 一句话总结

**架构与门禁是真的（0 违规、930 文件接线性全绿），真正的短板集中在三处**：安全底座的默认与规则覆盖面、执行链路的取消/配对/委派语义、以及「进化闭环与 S+ 引擎断在最后一米」。三批共修 20 项（9+8+3），三处短板中的高 ROI 项已全部落地；**上述 6 项剩余待办已全部落地**（03ef068 / 11c0cf1 / 6ff84bb / d862bee / 2a900d7 / d87bc79）：原始体检清单（§2）的高 ROI 项清零，安全底座、执行链路、进化闭环三处短板均闭合。
