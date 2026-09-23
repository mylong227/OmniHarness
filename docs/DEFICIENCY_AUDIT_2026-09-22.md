# OmniHarness 不足审计：逻辑 / 性能 / 架构 / 召回（2026-09-22）

> **方法**：三路独立只读深审（架构与可维护性 / 性能 / 逻辑缺陷）＋ 检索维度由主会话亲自实测。
> 所有结论标注证据来源与**实测 / 实读 / 推断**，不采信自我宣称；本轮能安全落地的已**直接修掉并带回归测试**，
> 其余按 ROI 排序登记为待办（含最小修复方案）。
> 状态图例：**【已修】** 本轮落地（含提交号）· **【待办·P0/P1/P2/P3】** 未修，附证据与修法。

---

## 0. 一页判读

| 维度                    | 结论                                                                                                                                                                                                                                     | 已修 / 待办                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **逻辑与缺陷**          | fail-closed 主线是真的（孤儿 tool_call 配对、取消传播、沙箱未知 profile 不回落、注入护栏三态、压缩无损子集均经复核成立）；但**两处安全语义被绕过**（SSRF 元数据、工作区路径逃逸）与**一处并发语义失效**（取消令牌单字段）                | 已修 2 · 待办 4（P1×1、P2×3）+ P3×8               |
| **性能**                | 每步固定开销的**绝对大头是 BM25 无倒排索引**（实测 33–223 ms/步，满量语料外推 ≈2.6 s/步）；另有 4 处可测热点                                                                                                                             | 已修 5 · 待办 4                                   |
| **架构与维护扩展**      | 分层纪律与门禁基建为真（依赖方向 0 违规、类型逃逸 0、配置接线六不变量）；问题集中在**门禁口径松弛**、**组合根错位**、**扩展触点 7–11 处无编译期约束**、**死资产/生成物入库**                                                             | 已修 0 · 待办 4（P0×3、P1×1）+ P1×8 + P2×6 + P3×4 |
| **代码文件召回/命中率** | 生产默认（K=20 + 精排 + 梯度投送）**78.8%** 对抗口径 / **100%** 自然口径；**剩余可提升空间已被精确量化**：当前候选池下 **+6.0pp**（精排区分力）＋ 语义路 **+6.1pp**（opt-in）＋ 词法盲区 **18.2pp**（须语义）；**「扩池」第 5 次被证伪** | 已修 0 · 待办 3（扩评测集为第一优先）             |

---

## 1. 逻辑与缺陷

### 1.1【已修】SSRF 元数据拦截被 IPv6 写法绕过（P1，安全语义）

- **证据（实测复现，主会话亲自跑了改造前的 `dist`）**：`inspectUrl('http://[::ffff:169.254.169.254]/latest/meta-data/', {allowPrivate:false})` → `{"blocked":false}`；
  `[::ffff:7f00:1]`、`[0:0:0:0:0:ffff:a9fe:a9fe]` 同样放行，而点分写法正确拦截。
  根因：`ssrfGuard.ts:131` 的映射地址正则**只认点分写法**，其余走 `startsWith('fc'/'fd'/'fe80'/'ff')` 前缀启发式。
  该判定是 A2A 传输（`a2a/httpA2aTransport.ts:34,45`、`wsA2aTransport.ts:50,58`）与 provider 探测（`server/services/providerProbe.ts:39,92`）的准入门禁。
- **修法（已落地）**：改为按 IPv6 数值分组解析内嵌 IPv4（IPv4-mapped / compatible / NAT64 `64:ff9b::/96` / 6to4 `2002::/16`，
  含尾部点分写法 `::ffff:a.b.c.d`）；元数据判定同时覆盖内嵌形式；**不可解析一律 fail-closed**。
  回归测试：`tests/unit/ssrfGuard.test.ts` 新增 3 例（含「公网 mapped 不被过度收紧」）。

### 1.2【已修】`safeReadFile` 缺 realpath 校验 ⇒ junction 越权读（P2，实测）

- **证据（实测）**：工作区内建 junction 指向外部目录后 `safeReadFile(ws,'junc/secret.txt')` 返回 `ok:true` 与外部文件内容；
  同路径 `WorkspaceGuard.isInside()` 为 `false` ⇒ **漏用既有守卫**，不是策略差异。
  该函数同时服务 RPC `fs.read` 与 HTTP `/files`（`workspaceTree.ts:51-53`、`httpServer.ts:147-150,295`）。
- **修法（已落地）**：复用 `WorkspaceGuard.resolveSafe`（词法 + realpath 双层），对外错误文案不变；
  回归测试新增「⑦ 符号链接/junction 逃逸被拦截」（无权限建链环境自动跳过，不误报）。

### 1.3【本轮已修】并发回合的取消令牌互相覆盖（`turns.abort` 静默失效或取消错会话）

- **证据（实读）**：`server/core/agentRuntimeHost.ts:122-139` 单实例 Agent 缓存被所有回合共用；
  `core/agent.ts:41/193/202` 的 `currentCancel` 是**实例单字段**（每次会话覆盖写、`finally` 置 undefined）；
  `server/core/appServer.ts:130-135` 的 `turns.abort` **不带 threadId**，而 `:459` 的 `activeTurns` 允许并发回合。
- **后果**：① 先结束者清空令牌 ⇒ 停止按钮静默无效；② 取消的是后启动会话 ⇒ 停 A 却停 B；③ `currentPersister` 同构。
- **修法（已落地）**：单字段 → `runningSessions: Map<sessionId, {cancel, persister}>`；
  `cancelCurrentRun(reason, sessionId?)` 定向取消（缺省仍取消全部，保 CLI 与旧前端兼容）；新增 `runningSessionIds()`；
  `buildTurnRunner` 显式接收 persister；`appServer.turns.abort` 读 `threadId`（兼容 `sessionId`）；
  前端 `ApiClient.abortTurn(threadId)` + `ComposerController.stop()` 传当前 `currentThreadId`（此前从不带 id）。
- **可证伪验证**：`tests/unit/sessionCancelIsolation.test.ts` 3/3（定向取消只停目标会话 / 不带 id 取消全部 / 未知会话 no-op）；
  **变异验证**：把编译产物改回「一律取消全部」⇒ ①③ 立刻变红（`# fail 2`），还原后复绿；
  前端 `web/test/turnControl.test.mjs` 增断言「stop 必须传当前 threadId」12/12。

### 1.4【本轮已修】审批上行无超时、断连不兑现 ⇒ 回合永久挂起

- **证据（实读）**：`server/core/serverEventBridge.ts:76-88` 审批请求只 `pending.set` 后死等；
  `httpBridgeTransport.ts:109` 的 WS 关闭只移除客户端、**不触碰挂起表**；UI 档 `ask` 无条件走上行（`agentRuntimeHost.ts:105`、`SettingsTab.tsx:40`）。
- **后果**：`ToolGate` 的 `await decide` 永不 settle ⇒ 回合永不返回、`activeTurns` 永久 running、`POST /rpc` 悬挂、pending 泄漏。
- **修法（已落地）**：① `requestApproval` 增**超时兜底**（默认 120s，`OMNI_APPROVAL_UPLINK_TIMEOUT_MS` 可覆盖，`0` = 不限时），
  超时按 **deny** 兑现（fail-closed）并记 `approval.uplink.timeout`；三条兑现路径（响应 / 超时 / 断连）共用同一
  **幂等 settle**（谁先到谁生效，其余 no-op）。
  ② 传输层新增**可选**能力 `Transport.setOnAllClientsGone`（`HttpBridgeTransport` 实现：SSE/WS 客户端集合由「有」变「无」时触发一次），
  `AppServer` 注册它 ⇒ **页面一关就立即把挂起审批兑现为 deny**，不必白等一整个超时窗口。
  ③ 刻意**不 unref** 定时器：实测 unref 后事件循环空闲时进程先退出、超时永不触发（测试直接报
  `Promise resolution is still pending...`），兜底形同虚设——那正是本类要防的「永久挂起」的另一种形态。
- **可证伪验证**：`tests/unit/approvalUplinkTimeout.test.ts` 5/5（超时⇒deny、断连⇒立即 deny、正常响应⇒allow 且晚到超时
  不二次兑现、传输层仅在有→无跃迁触发一次、`LineTransport` 未实现该可选能力不影响既有行为）。

### 1.5【本轮已修】`ToolScheduler` 的「写类形成屏障」契约不成立（实测）

- **证据（实测）**：`core/loop/toolScheduler.ts:39-58` 用**名字子串黑名单**判定串行；实测 `rollback | read_file | remember` 三者
  **同批并发**（总 71 ms），而其 `:6-10` 注释承诺写类形成屏障；生产未注入自定义判定（`stepToolExecutor.ts:51`）。
- **后果**：回滚/检查点/记忆写入与只读调用并发；与 `toolGate.ts` 的 `MUTATING_TOOLS` 口径漂移（后者也缺 `rollback`/`checkpoint`）。
- **修法（已落地）**：`MUTATING_TOOLS` 升格为**写类单一口径**（补齐 `rollback` / `checkpoint` / `remember`，并写明三处消费者：
  计划模式拦截 / 监督内核 hazardous / 调度器屏障）；`ToolScheduler.defaultParallelCapable` 改为
  **先查 `MUTATING_TOOLS`、名字模式仅作未知工具兜底**。
- **可证伪验证**：`toolScheduler.test.ts` 新增 3 例——`rollback/checkpoint/remember` 各自形成屏障（跨写不并行）、
  写类之间也串行、**遍历 `MUTATING_TOOLS` 全集断言「在集合内即不可并行」**（防口径再漂移）。

### 1.6【本轮已修】`checkpoint` 的 `label` 未校验 ⇒ 路径穿越写/读

- **证据（实读）**：`adapters/tool/git/checkpointTool.ts:31-38` 只判 label 非空；`core/checkpointManager.ts:64-67` 直接
  `join(base, sessionId, `${label}.files.json`)`；`rollback` 取路径同源。
- **修法（已落地）**：新增白名单 `^[A-Za-z0-9_-]{1,64}$`（拒 `..`、分隔符、空格、超长）；
  **在 `snapshot`/`rollback` 入口即校验**——只在 `fileSnapshotPath` 里校验是不够的：那条路径仅在注入
  `workspaceSnapshot` 时才走到，纯事件检查点会跳过校验（本轮由回归测试暴露），且非法标识还会拼进 storage 合成 key；
  工具层（`checkpointTool`）同样先拒并给出可读错误（纵深第一道）；路径构造处保留**包含性断言**（词法双保险）。
- **可证伪验证**：新增 4 例——非法 label 7 种写法全被拒、非法 `sessionId` 被拒、合法 label 不被过度收紧（含空格 label）、
  工具层对 `../../../../tmp/evil` 返回 `ok:false` 且对合法 label 正常打快照。

### 1.7 P3 批次【本轮已修 4 项 / 其余待办】

**已修（2026-09-22）**：

- **`NetworkEgressGuard` 漏 IPv4-mapped IPv6**（`networkEgressGuard.ts`）：其正则族只认 `::1`/`fe80:`/`fc..`/`fd..`
  前缀 ⇒ `http://[::ffff:169.254.169.254]/` 在出站守卫眼里**既不是** `169.254.*`（点分正则不匹配）**也不带**前缀，
  「元数据一律拒绝」的声明在该写法下不成立。**修法**：把 IP 分类抽成共享实现 `src/util/ipAddress.ts`
  （IPv4 CIDR 表 + IPv6 分组解析 + 内嵌 IPv4 四形态），SSRF 护栏与出站守卫**共用一份**——两份实现的分叉
  已经造成过一次真实缺口，故不再保留第二份。复验：白名单里**显式写上** `[::ffff:169.254.169.254]` 也依然被拒。
- **外溢预览按 UTF-16 码元切而宣称字节预算**（`spillPolicy.ts`）：CJK/emoji 预览可达预算约 4 倍。**修法**：
  改按 UTF-8 字节截断并回退到合法字符边界（不产生半个代理对）。
- **worktree 清理不在锁内且静默吞错**（`worktreeOps.ts`）：并发派生/结束时清理失败会残留
  `.omni-worktrees/<id>` 与 `omni-sub-*` 分支且无日志。**修法**：清理与创建共用同一把按 repoRoot 的锁，
  失败一律 `log.warn('worktree.cleanup.failed')`。
- **`web/src`（104 文件）不在本地 `typecheck`**：`typecheck` 只跑根 tsconfig。**修法**：
  `npm run typecheck` 追加 `tsc -p web/tsconfig.json --noEmit`（实测零错误）。

**仍待办**：shell 不消费取消信号（`shellTool.ts:185-191` 不传 `signal`，最长跑满 600 s 且只杀直接子进程）·
`EventPersister` 落盘竞态（`eventPersister.ts:69-72` 不等在飞写入；JSONL 整文件覆盖非原子）·
JSONL 坏行 ⇒ 静默空历史（`jsonlStorage.ts:37-44`）· spill 产物与涡环包无回收（`fileSpill.ts:33-38`、`vortexRingSpillAdapter.ts:20`）。

### 1.8 已核对确认**正确**的核心链路（避免重复投入）

孤儿 `tool_call` 配对四不变量（`stepToolExecutor.ts:107-177` + `contextAssembler.ts:74-76,141-151`）·
子代理/工作流/目标三条取消传播链 · `ConcurrencyLimiter` 构造期 fail-closed · 沙箱未知 profile 不回落 passthrough ·
提权复核 fail-closed · 注入护栏三态与异常兜底 · 压缩无损子集 · 回合预算与兜底 finalize · `LoopGuard` 去重 ·
`WorkspaceGuard` realpath 层本身正确（1.2 是别处没用它）。

---

## 2. 性能

### 2.1【已修】BM25 检索无倒排索引（P0，每步固定开销大头）

- **证据（实测）**：改造前 `Bm25Index.search` 为 `O(Q × Σ|doc|)` 全量扫描——真实语料 563 文件 / 98.6 万 token 下
  英文 5 词 **18.6 ms**、中文 22 词 **252 ms**，且按 token 数严格线性（1M token/20 词 = 98.5 ms）⇒
  32 MiB 配置上限外推 **≈2.6 s/步**；`query()` 单次 33.4 ms（英文）/ 182–223 ms（中文），其中 file 路占 84–98%。
- **修法（已落地）**：`addDocuments` 期建「词项 → (docId, tf)」postings，`search` 只遍历命中词项。
- **实测收益**：`fileIndex.search` **18.6 → 0.9 ms**、**252 → 1.8 ms**；`query()` 生产链路高热后
  **33–223 ms → 2.7–5.6 ms**（首调 27 ms 含惰性视图构建）。建索引一次性 +277 ms（file），1–2 步内回本。
- **等价性**：`tests/unit/bm25Index.test.ts` 与暴力实现逐位对拍（命中 id/分数/次序、分批追加、df·idf 同源）；
  检索端到端复验：生产默认档命中率仍 **78.8%**、headroom 拆解逐项不变。
- **顺带修真缺陷**：`addDocuments` 分批调用时 `averageLength` 只用「本批 token / 全部文档数」（平均长度被算小）。
  生产调用点均为单批 ⇒ 零行为变更。

### 2.2【已修】`ConcurrencyLimiter.release` 的 `shift()` 二次复杂度（P1）

- **证据（实测）**：`util/concurrencyLimiter.ts:56` 原用 `waiters.shift()`，而 `parallelMap` 会先为全部条目建 promise ⇒
  O(N²/concurrency)：n=20k/40k 实测 **576 / 927 ms**，改游标后 **45 / 63 ms（≈14.8×）**。
- **修法（已落地）**：队首游标 + 消费过半一次性压缩（摊还 O(1)）；`tests/unit/concurrencyLimiter.test.ts` 锁 FIFO 与 5000 等待者。

### 2.3【已修】每步上下文记账的两处浪费（P1 的一部分）

- `TokenEstimator.countCjk` 由 `match(/CJK/g)`（为计数分配整个命中数组）改码点区间循环：
  **101.0 → 48.2 µs / 170 KB（2.10×）**，零分配、计数逐字相等。
- `ContextBreakdownEstimator.toolTokens` 增 WeakMap 缓存：原先每步对 33 个工具重新 `JSON.stringify`
  （该步实测 2.53–34.41 ms 的一部分）。

### 2.4【待办·P1】repo-map 结果零记忆化 + 每步全文记账无前缀缓存

- **证据（实测 + 实读）**：`core/stepContextBuilder.ts:86-92` 每步调 repo-map，而 `deriveQueryText`（同文件 `:217-229`）
  在同一回合内返回**逐字相同**的查询；`context/repoMapContextEngine.ts:127-178` 无 (root,q,opts)→结果缓存
  （`CorpusIndexCache` 只缓存**索引**）。
- **修法**：① 单槽位 memo（键 = root+q+旋钮指纹）；② 消息级 token 数按内容字符串做前缀增量缓存，
  把每步 O(全文) 降为 O(新增)（实测 170 KB/850 KB/2.55 MB 上下文的记账为 10 / 48 / 84 ms/步，全会话 O(n²)）。
- 注：2.1 落地后 repo-map 查询本身已降到 3–6 ms，memo 的收益从「每步几十~几百 ms」变为「每步几 ms」，
  优先级随之下降——但仍值做（第 2..N 步可归零）。

### 2.5【待办·P2】事件日志与持久化、前端滚动帧

`appendOnlyEventLog.all()` 每次浅拷贝全数组（每步 2–4 次调用）· 持久化每 200 ms 全量重写
（JSONL 整文件覆盖；SQLite `DELETE` + 逐条 INSERT 无事务，实测 500 事件 8.1 ms）·
`StreamView` 每滚动帧全量重算（无 `useMemo`/rAF，实测 ≈180 µs@1000、≈510 µs@3000 事件/帧）。

### 2.6 已核对无问题

`ToolExposurePlanner` 预编译缓存（WeakMap + 合并正则）· `FileReranker.rerank` 实测 0.36 ms ·
`tokenize()` 0.02 ms/6 KB · `CorpusIndexCache` TTL+LRU 有界 · `ContextEngine.walk` 三道闸（4 GB 堆爆已封死）·
spill 阈值有界 · `Logger` 级别短路在序列化之前。

---

## 3. 架构与可维护 / 可扩展

### 3.1【本轮已修】`check --strict` 的函数体长度门禁看不见类方法（门禁可信度）

- **证据（实读 + 复现）**：`scripts/check.mjs:340-359` 的函数起始正则**看不见带访问修饰符/有返回类型标注的类方法**；
  而 eslint 的 `explicit-member-accessibility: error` + 必写返回类型恰好让所有类方法落入盲区。
  用 TS AST 实测 `src/` 有 **14 个函数体 >80 行**（最大 `context/contextEngine.ts` 的 `query` **220 行**），
  门禁却报「560 文件零违规」。
- **修法（已落地）**：`check.mjs` 改用 **TypeScript AST**（`ts.createSourceFile` + 节点遍历）计量
  函数/方法/构造器/取值器/箭头函数体行数，**只报最外层超限节点**（避免嵌套箭头重复计数）；
  存量 14 处冻结进 `scripts/checkFuncBaseline.json`（**只报不拦**），**新增或体量增长即阻断**；
  `函数体行数上限` 与 `文件行数上限` 一并升为**恒阻断规则**（此前只在 `--strict` 下阻断，CI 的 `npm run check` 看不见）。
- **可证伪验证**：① 当前树 `npm run check` 与 `--strict` 均绿，并把 14 处存量白名单逐条列出；
  ② 临时放入一个 98 行的 `gateProbe` 函数 ⇒ **两种模式都 exit 1** 且报「新增超限函数」；删除后复绿。
- **遗留**：存量 14 处待分批拆（最大 `query` 220 行）——白名单即后续拆分台账。

### 3.2【待办·P0】死资产与生成物入库

- `resources/comfyui_node_reference`：**3414 tracked 文件 / ≈20.8 MB（占全仓 tracked 文件的 71%）零代码消费者**
  （`git grep` 仅命中 `THIRD_PARTY_ASSETS.md:15` 一句描述）。建议迁出仓库或转 release 附件 / LFS。
- `evals/**/*.report.json` 有 **41 份被跟踪**且每次跑评测都改写（本次审计期间工作树即被评测进程弄脏 4 处，
  且 `BM25+PRF+rerank` 从 57.6 → 39.4 的漂移会被文档当结论引用）。建议只入库人工确认的 `*.baseline.json`。
- 记忆引擎三份同算法实现（≈350 行重复 + 死分支）：`cosmicWebMemoryEngine.ts`/`resonantMemoryEngine.ts` 是
  `resonantFieldEngine.ts` 的真子集，默认装配只走后者（`config/memoryStackAssembler.ts:54,64,74`）。建议删前两者、回退分支改实例化 `ResonantFieldEngine`。

### 3.3【本轮已修】组合根错位：`createRuntime` 住在 `core/` ⇒ 真值循环 + 端口倒置

- **证据（实读 + 独立建图复核）**：`core/runtime.ts` 值导入 6 个子系统并导出 `ServiceKeys`；
  `core/runtime.ts:29 ↔ subagent/subagentRuntimeFactory.ts:10` 构成**真值双向环**；
  `ports/runtime/agent.ts:3` 反向 import `core/runtime.js` 并用于端口契约签名。
  架构门禁只判 `core→adapters` / `adapters→core`（这两类经独立复核确为 0），**看不见 ports→core**。
- **修法（已落地）**：
  ① **迁出核心层**：`src/core/runtime.ts` → `src/composition/runtime.ts`（新装配层目录，已在
  `ARCHITECTURE_SPEC.md` §2.1 目录归属表登记）；全仓 42 处 import 说明符同步（含 3 个 benchmark 脚本）。
  ② **打断真值环**：`ServiceKeys` 下沉到 `src/composition/serviceKeys.ts`（纯常量、零依赖），
  子代理工厂改依赖它 ⇒ 组合根→子代理仍为值依赖，**反向只剩 type-only** ⇒ 值级环消失。
  ③ **解端口倒置**：`AgentFactoryPort` 改泛型 `AgentFactoryPort<TRuntime = unknown>`——端口不再 import 任何
  具体实现类型，由 `config/agentFactory.ts` 绑定 `OmniHarnessRuntime`（方法参数双变，赋值安全、零类型逃逸）。
  ④ **补门禁规则 [3.5]**：`ports/** 不得 import core|adapters|config|composition`（白名单空 = 新增即红）。
- **可证伪验证**：`arch:gate` 输出新增 `[3.5] ports→实现层：0 条`；**反向验证**——临时在
  `ports/runtime/agent.ts` 注入 `→ core/toolGate` ⇒ `[NEW!]` 且 **exit 1**，移除后复绿；
  搬移后 `tsc` 零错误、`npm test` 与门禁全绿（见 §6 与本轮提交）。

### 3.4【待办·P1】扩展接缝是「改一处漏一处」

- 新增模型适配器实际触点 **≥8 个文件**（`configBuilder.ts:164`、`cliBuildConfig.ts:468`、`providerProbe.ts:146`、
  `modelCatalogService.ts:129`、`configError.ts:198`、`cliEnums.ts:13`、`argParser.ts:20,241`、`providerPresets.ts:12,106`、`routineScheduler.ts:18`）；
  工具名 `'read_file'` 硬编码在 **7 个模块**；存储后端有两套独立字符串工厂（`cliBuildConfig.ts:502-510` vs `cli/kvStoreFactory.ts:44-51`）。
- **修法**：适配器名→构造器收成一张表；工具名集中到 `ports/tool/toolNames.ts`；存储工厂单一实现来源。

### 3.5 其余（摘要）

审计哈希链两份同构且**已语义分叉**（`auditSink.ts` canonical 含 `ts`，`jsonlRuntimeTelemetry.ts` 不含）·
JSON-RPC pending/超时/id 关联重复 6 处且 `mcpClient.ts:15-17` **无 reject 通道**（传输关闭时挂起请求永不被拒）·
shell 工具族常量各自声明 · 公开面 413+152 符号且泄漏测试替身（`MockModel`/`MemoryStorage`/`PassthroughSandbox`）·
覆盖率门禁是聚合值（`context/rankVeto`、`adapters/tool/git` 可零单测仍全绿）· `web/src`（104 文件）不在本地 `typecheck` 也不在体量门禁 ·
53 个 eval 脚本中 35 个未接入 npm script · 非 archive 文档 172 处死路径（含 README 指向**不存在**的
`docs/TASK_BOARD_2026-09-13.md`，而 README 又写明「以它为准」）· `src/` 内 3 个 Python 文件（3919 行）在全部 TS 门禁之外。

### 3.6 架构上确认**没问题**（避免重复投入）

端口枢纽不是垃圾桶（`ports/tool/tool.ts` 仅 74 行 / 6 导出；高扇入是契约本征）· `*ContextEngine`/`*Ranker`/`*Compressor`
均只有一个实现 · `web/src` 与 `src` 无成段重复 · 模块级可变状态几乎为零（仅 1 处 `let`）·
17 个模块级单例抽查均为无状态 · `core→adapters`/`adapters→core` 独立建图确为 0 · CI 浏览器门禁是 fail-closed 真闸 ·
`eval:ci` 确实零 key 不联网 · 类型逃逸真清零（`as unknown as` 4、`any` 0、`@ts-ignore` 0）· `audit:config-wiring` 六不变量是真门禁。

---

## 4. 代码文件召回 / 命中率：还能提升吗？

**能，但空间已被量化到个位数～十几 pp，且第一瓶颈已不是算法而是「评测样本量」。**

### 4.1 当前实测（当前语料 563 文件 / 9824 符号 / 33 条**对抗**锚点查询）

| 配置                                         | hitRate@K       | CI95             |
| -------------------------------------------- | --------------- | ---------------- |
| **生产默认**（K=20 + 精排 + 梯度投送）       | **78.8%**       | [63.6, 90.9]     |
| 自然提问口径（同批锚点换自然语言）           | **100%**        | [100, 100]       |
| 语义路（历史实测，`OMNI_SEMANTIC_RECALL=1`） | +6.1pp（81.8%） | CI 跨 0 ⇒ opt-in |
| PRF/RM3（opt-in）                            | −9.1pp（K=20）  | 证伪于当前口径   |

### 4.2 剩余空间拆解（本轮新增 (K × 候选池) 二维矩阵，补上看板未覆盖的 K=20 口径）

| K   | 候选池 | 精排实测  | oracle（GT 在池内） | 缺口      |
| --- | ------ | --------- | ------------------- | --------- |
| 20  | 20     | 75.8%     | 81.8%               | 6.0pp     |
| 20  | **80** | **78.8%** | **84.8%**           | **6.0pp** |
| 20  | 150    | 72.7%     | 93.9%               | 21.2pp    |
| 20  | 482    | 72.7%     | 93.9%               | 21.2pp    |
| 10  | 80     | 57.6%     | 84.8%               | 27.2pp    |

**三条结论（都可复跑）**：

1. **精排区分力是当前头号缺口**：池内 oracle 84.8% vs 实测 78.8% ⇒ **+6.0pp 在池子里却拿不到**。
2. **「扩池」第 5 次被证伪**：池 20→482 让 oracle 从 81.8% 升到 93.9%，但实测命中率**反降 6.1pp**（78.8% → 72.7%）——
   现有零依赖精排吃不下深池（弱候选挤掉真答案）。
3. **廉价精排变体全部无效**（实测）：去掉名次项 **±0.0pp**、加入路径子词 **−3.0pp**、`max(符号,路径)` **−6.1pp** ⇒
   剩余 6pp 需要**更强的判别器**（新信号/新表示），不是调参能拿的。

### 4.3 还有哪些**真**杠杆（按性价比）

| #   | 杠杆                            | 预期                                                    | 现状与前置条件                                                         |
| --- | ------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | **扩评测集 n=33 → ≥80**         | CI ±13–15pp → ±8pp 级，**让 3–6pp 级效果可判定**        | 本仓调研 §5 建议 4，**一直未做**；这是所有后续决策的前置条件           |
| 2   | 语义路翻默认（已实现、opt-in）  | 历史 +6.1pp（含 token 更低）                            | 需 2.2 GB 可选依赖 + 模型权重（本机无网络/未下载）；且 n=33 下 CI 跨 0 |
| 3   | 精排判别器升级（新信号/表示层） | ≤ **+6.0pp**（当前池 oracle 上限）                      | 需先做 #1 才能判定收益；廉价变体已被本轮证伪                           |
| 4   | 深池 + 能利用深池的精排（组合） | 上限 **+15.1pp**（pool 150 的 oracle 93.9% − 现 78.8%） | 单靠扩池为负，必须与 #3 同批做                                         |
| 5   | 词法盲区（GT 与查询零词法交集） | **18.2pp**（占 6/33 条）                                | 结构性不可达：需语义嵌入或查询改写；LSA/图/PRF/蜘蛛网五形态均已证伪    |

**诚实边界**：以上是 `hitRate@K`（至少命中 1 个相关文件），**不等于端到端任务成功率**；
33 条查询的 CI 宽约 ±13–15pp，故只把「CI 下界超基线」的档位判为达标（本仓「两关」纪律）。

### 4.4 本轮**新增**的测量能力（可复跑，证据在盘）

- `.omniharness/recall-headroom-probe.mjs`：(K × 候选池) 矩阵 + 每查询命中向量 + 确定性 bootstrap CI。
  它替换了「81.8% 天花板」的口径缺陷——该数字是 **K=10** 口径的产物，不是当前生产（K=20）的天花板。
- `.omniharness/recall-rerank-variants.mjs`：精排打分式变体扫描（本轮给出「廉价变体无效」的负结果）。

---

## 4.5【本轮已执行】检索评测集扩容 33 → 84：**推翻了一条既有结论**

> ROI 第 1 项。产物：`tests/fixtures/recallQueries.ts`（单一真相来源：冻结子集 33 + 新增 51）、
> `evals/recall-query-audit.mjs`（协议门禁：锚点 GT 为空即中止 + 难度画像）、
> `tests/unit/recallQueries.test.ts`（结构 / 规模 / 对抗性三条不变量）；
> `headroom-analysis` / `recall-precision` / `budget-recall-tradeoff` 改从该 fixture 取查询
> —— 此前 **15 个脚本各自复制同一份 33 条列表**，正是 §3 所指「复制漂移」的源头。

**协议**：新增条目 ① 锚点必须在 `src/` 真实出现（机械校验，缺失即中止）；② 查询内容词与锚点子词**零交集**
（严格对抗性，单测强制）；③ 同一语料 / GT / hitRate@K 口径。冻结子集保持 2026-09-17 原措辞不动，历史数字仍可比。

**难度画像**（563 文件语料，K=20 + 精排）：新增子集 OK 21 / RANKING **24** / LEXICAL 6（命中 41.2%）；
冻结子集 OK 26 / RANKING 4 / LEXICAL 3（命中 78.8%）⇒ 新集把「排序可救」样本从 **4 条提到 28 条**——
这正是度量排序改进所需的功效来源。

**CI 宽度**（同一配置的边际区间）：core33 **27.3–36.4pp** → all84 **21.4–22.6pp**；配对视差区间同步收窄。

**被推翻的结论（重要）**：`rerank@K=20`（精排 开 vs 关，fileK=20）

| 子集   | 精排关 | 精排开    | Δ           | 逐查询            | 判定                     |
| ------ | ------ | --------- | ----------- | ----------------- | ------------------------ |
| core33 | 66.7%  | 78.8%     | **+12.1pp** | ↑4 / ↓0 / =29     | CI [3.0, 24.2] ✅ 可判定 |
| ext51  | 52.9%  | **41.2%** | **−11.7pp** | ↑1 / ↓**7** / =43 | 精排在新增集上**净有害** |
| all84  | 58.3%  | 56.0%     | −2.4pp      | ↑5 / ↓7           | CI [−10.7, 5.9] — 跨 0   |

即：**「精排默认开」是 2026-09-17 依据 33 条查询翻的默认，在更广的查询分布上不成立**——它在原 33 条上
「只赢不输」，在新增 51 条上却赢了 1 条、输了 7 条。被打成未命中的 7 条集中在**小型适配器/工具文件**
（`AuditSink`、`LineTransport`、`ServerAuthGuard`、`ToolOutputTrust`、`ApprovalRuleDecision`、
`RewardCoverageMeter`、`ParallelMap`），形态与 `fileReranker.ts` 模块头自述的「查询词为通用前缀时把同前缀
兄弟文件一起抬起」一致 ⇒ **符号名覆盖度让「兄弟文件」压过了真正的定义处**。

**处置（未擅自翻默认）**：

1. 新增 51 条由我按协议撰写、**未经第二方复核**，故本条结论标记「**待复核**」——复核/替换后再定默认；
2. 复核通过前，**不得**再以「§17 已两关全过」为由认定 `rerank: true` 稳固；`evals/rerank-ab.mjs`
   的两关结论应重跑（该脚本仍用内联 33 条，属本轮**未接线**者，见 §6）；
3. 若要修精排，方向是抑制「兄弟文件抬升」（如对 basename 与查询内容词形近者加定义处加成、或给 coverage
   项设上限），但**必须先有复核过的查询集**才能判定收益。

---

## 5. 建议的推进顺序（ROI 排序）

0. **（新增）复核检索评测新增子集**：第二方逐条复核/替换 51 条 → 再据 all84 重判 `rerank` 默认。

1. **扩检索评测集到 n≥80**（解锁一切「能不能翻默认」的判定，成本 0.5–1d，纯离线）。
2. **修 `check.mjs` 函数体门禁**（恢复「零违规」可信度；先白名单 + `--delta`，成本 <0.5d）。
3. **修 1.3 取消令牌按会话存放**（并发正确性；P1，独立小改）。
4. **修 1.4 审批上行超时/断连兑现**（消除「回合永久挂起」；P1，独立小改）。
5. **迁出死资产 + 报告不入库**（仓库体积与噪声；纯删除/忽略类，收益明确）。
6. **组合根迁出 `core/` + 门禁补 ports→core 规则**（结构性，防未来退化）。
7. **精排判别器研究**（先做 #1 拿到判定力，再做实验；否则无法区分 6pp 与噪声）。

---

## 6. 边界与未验证

- **Rust 侧（6 crate / 45 文件）未审计**：本机无工具链（`~/.rustup` 不存在）且无网络。
- **真实覆盖率**：未跑 `coverage:check`（需 build + 全量测试）；「110 个模块无测试引用」是**文本引用启发式**，非行覆盖。
- **浏览器真实滚动卡顿**：只测得函数级单帧成本，未做浏览器 Profiler。
- **满量语料（32 MiB）端到端耗时**：由 1M/3M token 线性实测外推（改造前 ≈2.6 s/步；改造后未复测满量）。
- **未验证面**：插件热卸载、MCP/SSE 背压、sqlite/oobleck KV、LSP、CDP、quota/sessionArchive、web 未知事件丢帧。
- 本轮**未改动**：1.3–1.7、2.4–2.5、3.1–3.6 各项（保持只登记状态，避免大范围重构与本次修复混在一起）。
