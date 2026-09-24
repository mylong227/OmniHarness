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

### 1.9【第十轮新发现·待办·P2】Windows 下带引号参数的 shell 命令被 `cmd /d /s /c` 破坏

- **怎么发现的**：写「取消信号」回归用例时，命令用 `node "<绝对路径>" "<目录>"`，结果**没跑起来**；
  探针复现（`node` 直接调 `ShellTool`）：报错是 `Cannot find module 'C:\...\Temp\probe-xxx\"C:\...\heartbeat.js"'`
  ——两个参数被**粘成一个**、引号被吃进路径里。这不是我的改动引入的，是**既有**的执行形态问题。
- **根因**：`ShellInvocation.args()` 在 Windows 上给的是 `['/d', '/s', '/c', command]`（`shellInvocation.ts:41-44`）。
  `cmd.exe` 的 `/s` 开关会「剥掉命令串最外层引号并按特定规则重解析」，当命令里已经有引号（带空格路径、
  引号参数）时就会发生这种重组。Node 把 argv 拼成命令行时又会再加一层转义 ⇒ 双重解析错位。
- **影响面**：任何**参数带引号**的 Windows 命令（含空格路径、`--flag "value"`）都可能失败或被静默改写；
  非引号命令（绝大多数）不受影响，故长期未被发现。
- **最小修法（待验证）**：不用 `/s`（改 `['/d','/c',command]`），或改用「命令经 stdin 喂给 `cmd /d /q`」的形态，
  或对 `command` 做一次针对 cmd 的转义（`^` 转义元字符 + 引号成对）。**修前必须先建用例**：
  `node "<带空格路径>" <arg>`、`echo "a b"`、以及含 `&`/`^` 的引号参数，逐条钉住「引号参数原样到达子进程」。
- **为什么本轮不顺手改**：`/s` 的取舍会影响**所有**跨平台 shell 调用（含用户既有命令的行为），
  属「解析契约」级改动，需要独立一轮 + 上述用例矩阵，不能在收尾时夹带。

**第十轮 §3.15 已修（前 2 条）**：

- **`EventPersister` 落盘竞态（`eventPersister.ts:69-72`）**：原实现 `flush()` 遇到「已有 flush 在飞」**直接 return**
  ⇒ 该次请求**被丢弃**：定时器触发时若上一次写仍在飞，新事件要等**下一次 schedule** 才可能落盘；回合末
  `await persister.flush()` 也会在在飞写完成前返回，调用方误以为已落盘。**修法**：改为**串行队列**
  （每个 flush 排在上一次之后）：既不丢请求，又保证 `flush()` 返回时**它自己的快照确已写入**。
  回归：新增 `tests/unit/eventPersister.test.ts`（5 例，含「在飞期间的 flush 不被丢弃」与
  「flush 返回即在飞写已完成」两条窗口复现；用可控存储替身把写入挂在闸门上制造真实竞态）。
- **JSONL 坏行 ⇒ 静默空历史（`jsonlStorage.ts:37-44`）**：整文件解析放在同一个 `catch` 里，**一行**非法 JSON
  就让 `load` 返回 `[]`，调用方分不清「没有历史」与「历史读不出来」⇒ 会话续跑/回放**悄悄丢光上下文**。
  **修法**：逐行解析，坏行**跳过并告警**（带行号 `storage.jsonl.bad_line`），其余事件照常返回；
  有内容却全部行失败时另发 `storage.jsonl.all_lines_corrupt`（文件级损坏信号）；
  非 ENOENT 的读取失败改为 `storage.jsonl.unreadable` 告警后返回 `[]`（契约不变，但不再无声）。
  **同轮修掉同一文件的原子性**：`save` 原为整文件 `writeFile` 覆盖，崩在半途会留下半截文件；
  改为**先写 `<file>.tmp` 再 `rename`**（同目录 rename 原子），失败时清理半成品。
  回归：新增 `tests/unit/storageDurability.test.ts`（5 例：往返保序、覆盖写不留 `.tmp`、
  **个别坏行只丢那一行**、全坏行仍返回 `[]`、缺失/不可读均不抛错）。

**第十轮 §3.15 已修（后 2 条）**：

- **shell 不消费取消信号（`shellTool.ts:185-191`）**：会话取消信号此前**完全没被本工具消费**——
  `ToolContext.signal` 已经由 `stepToolExecutor` 注入（`stepToolExecutor.ts:84-88`），但执行参数里没有它，
  于是「回合已取消」的命令仍会跑满自己的超时（最长 10 分钟）。**修法**：
  ① 参数透传（`ShellRunOptions.signal`）；
  ② 新增 `ProcessTreeKiller`——**终止整棵进程树**（Windows `taskkill /PID <pid> /T /F`，失败回退单进程 kill；
  POSIX 以 `detached: true` 让 shell 当进程组长后用 `kill(-pid)`），超时与输出超限两条路径**一并**换用它；
  ③ 结果新增 `aborted` 字段，工具层状态优先级改为 **取消 > 超时 > 截断 > 退出码**，文案「命令被会话取消
  （已终止整棵进程树）」。
  回归：`shellTool.test.ts` 新增 2 例（取消立即生效且错误文案指明取消；进入执行前已 abort 也立即终止），
  其中「整棵树都死了」用**孙进程心跳停止**断言（比「某个 5s 后写的标记没出现」更严密）。
  **反向验证**：临时把树终止换成「只杀直接子进程」重跑，该用例**会红**——而且是**挂死**（存活孙进程仍持有
  stdout 管道 ⇒ Node 的 `close` 永不触发 ⇒ 工具调用 Promise 永不 settle）。这正是「只杀 shell」在生产里的
  真实后果，已写进用例注释。
- **spill 产物与涡环包无回收（`fileSpill.ts:33-38`、`vortexRingSpillAdapter.ts:20`）**：**修法按本项目纪律
  「限额进配置」**：
  - `FileSpill` 新增 `maxFiles`（默认 **512**，`0`=不回收）：每次 `spill` 后按 **mtime 删最旧**，
    失败只告警不抛错（`spill.collect.*`）；对外新增 `collect()` 便于观测。
  - `VortexRingSpillAdapter` 新增 `maxRings`（默认 **256**，`0`=不淘汰）：超限按 **LRU** 淘汰
    （`read` 命中即续命），淘汰时 `spill.ring.evicted` 告警，被淘汰 id 读回仍是 `undefined`（既有 fail-closed 语义）。
  - 配置面：`OmniHarnessConfig.spillMaxFiles` / `spillMaxRings` 两个字段（与既有 `spillMaxInlineBytes` /
    `spillPreviewBytes` 同一层），由 `configBuilder.buildSpill` 与 `corePortsAssembler` 消费。
  - 回归：`spill.test.ts` 新增 5 例（文件上限回收最旧、`maxFiles=0` 不回收、**上限经配置生效**、
    环包上限与 LRU 续命、`maxRings=0` 不淘汰）。

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

### 3.2【第十轮核实：前两条已结项，第三条**降级为「遗留可选路径」并更正原判断**】

逐条复测（2026-09-24，命令与结果均为实测）：

- ✅ **`resources/comfyui_node_reference` 已不在仓库**：`git ls-files resources/comfyui_node_reference` = **0 个 tracked
  文件**（原为 3414 tracked / ≈20.8 MB）⇒ 已按建议迁出（看板 §20.6 记录为「死资产迁出」）。
- ✅ **评测产物已不再入库**：`git ls-files 'evals/*.report.json'` = **0** ⇒ 不再有「跑评测即弄脏工作树」的问题
  （`evals/**` 下现存 44 个 `*.report.json` 均为**未跟踪**的本地产物）。
- 🟡 **记忆引擎「三份同算法实现」——原判断需更正，故不删**：
  - **不是死代码**：`src/config/memoryStackAssembler.ts:63-70,73-77` 会在
    `resonantField.enabled === false` 时按 `memoryWeb.enabled` / `resonance.enabled` **显式构造**它们；
    `tests/unit/cosmicWeb.test.ts`（3 例）、`tests/unit/resonantMemory.test.ts`、`tests/unit/sparkMainLoop*.test.ts`
    直接断言其类型与行为；覆盖率基线里两者分别为 **87.4% / 97.95%**（不是零覆盖）。
  - **属对外 API**：`src/index.ts:175` 导出 `ResonantMemoryEngine`、`:187-188` 导出
    `CosmicWebMemoryEngine` 与 `CosmicWebOptions` ⇒ 删除是**破坏性 API 变更**，须走弃用流程
    （`docs/API_STABILITY.md`），不能当「死资产」顺手删。
  - **重复确实存在但已被统一基板取代**：默认路径（U1，`resonantField.enabled !== false`）只走
    `ResonantFieldEngine`，共享频谱索引也已抽到 `ports/memory/resonantField.ts`；两个遗留引擎各自的
    频谱实现只在显式关闭 U1 时才启用。
  - **结论**：正确的收口是「**先弃用再移除**」（标 `@deprecated` + 次版本移除 + 迁移到 U1），
    而不是在审计里当作死资产删掉。已如实登记为**遗留可选路径的弃用议题**，与本轮 §1.7 的缺陷区分开。

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

### 3.4【已结项·P1】扩展接缝是「改一处漏一处」

- 新增模型适配器实际触点 **≥8 个文件**（`configBuilder.ts:164`、`cliBuildConfig.ts:468`、`providerProbe.ts:146`、
  `modelCatalogService.ts:129`、`configError.ts:198`、`cliEnums.ts:13`、`argParser.ts:20,241`、`providerPresets.ts:12,106`、`routineScheduler.ts:18`）；
  工具名 `'read_file'` 硬编码在 **7 个模块**；存储后端有两套独立字符串工厂（`cliBuildConfig.ts:502-510` vs `cli/kvStoreFactory.ts:44-51`）。
- **修法**：适配器名→构造器收成一张表；工具名集中到 `ports/tool/toolNames.ts`；存储工厂单一实现来源。
- **本轮进展（2026-09-22 第二轮，§3.7）**：其中「厂商目录两处维护」已消除——CLI 的 `ADAPTER_PRESETS`
  手工副本删除，厂商目录单一来源为 `config/providerPresets.ts`（数据在 `defaults/providers.json`），
  CLI 专属映射改由数据字段 `cliAdapters` 表达。适配器**构造侧**的其余触点仍待办。
- **本轮进展（2026-09-22 第三轮，§3.9）**：**「工具名硬编码」一项已结项**——本条的「7 个模块」是低估：
  实测 45 个工具名、注册侧 33 个工具类 + 消费侧 9 张策略表两头都写。现收口为
  `ports/tool/toolNames.ts` 单一声明处，并加两条反硬编码守卫（策略面 + 注册面）。
- **本轮进展（2026-09-22 第四轮，§3.10）**：**剩余两项一并结项**。
  ① **适配器名→构造器一张表**：`adapters/model/modelAdapterRegistry.ts` 成为全仓唯一 `new` 模型适配器处，
  三处分支（`cliBuildConfig.buildModel` 4 分支 / `configBuilder.buildRouterAdapter` 3 分支 /
  `providerProbe.buildModelForProvider` 2 分支）退化为查表；兜底值仍走 `defaults/endpoints.json`。
  ② **存储后端字符串工厂**：会话存储的后端名→实现+缺省路径收进 `cli/storageFactory.ts`
  （与既有的 `kvStoreFactory` 同形，family 各一个工厂；后端名字符串现在只出现在该文件里）。
- **残留（已于 §3.11 收口，此处保留演进记录）**：新增一个模型适配器**仍需改 4 处声明**——`CliArgs.modelAdapter`
  类型、`FileConfig.modelAdapter` 类型、`cliEnums.MODEL_ADAPTERS`、`configError.ENUM_VALUES.modelAdapter`
  （外加 daemon 的 `RoutineModelAdapter` 联合）。构造逻辑已单点，但「声明」仍是三处枚举/类型的重复；
  现由 `tests/unit/adapterFactories.test.ts` 的①机械核对（每个注册 id 必须能过 `normalizeConfig`、
  且与 `MODEL_ADAPTERS` 逐项一致）防止再次漂移。要把声明也收成一处，需要让类型从表推导
  （代价：`satisfies` 提供的编译期防漂移会失效），属**可选**后续，不在本轮范围。
  → **§3.11 已做**：`ports/model/modelAdapterId.ts` 成为唯一名字来源，5 处声明全部改为引用它，
  且注册表用 `Record<ModelAdapterId, …>` 让「漏一行」变成编译错误（`satisfies` 保护保持不变，
  因为清单本身仍是 `as const` 元组）。**新增适配器现在只需**：清单加一个名字 + 表体加一行
  （编译器强制配对）+ `defaults/endpoints.json` 加兜底（测试强制存在）。

### 3.5 其余（摘要）——**逐项状态**（2026-09-22 第八轮更新）

原始发现（保留原文，便于对照）：

审计哈希链两份同构且**已语义分叉**（`auditSink.ts` canonical 含 `ts`，`jsonlRuntimeTelemetry.ts` 不含）·
JSON-RPC pending/超时/id 关联重复 6 处且 `mcpClient.ts:15-17` **无 reject 通道**（传输关闭时挂起请求永不被拒）·
shell 工具族常量各自声明 · 公开面 413+152 符号且泄漏测试替身（`MockModel`/`MemoryStorage`/`PassthroughSandbox`）·
覆盖率门禁是聚合值（`context/rankVeto`、`adapters/tool/git` 可零单测仍全绿）· 53 个 eval 脚本中 35 个未接入 npm script ·
非 archive 文档 172 处死路径（含 README 指向**不存在**的 `docs/TASK_BOARD_2026-09-13.md`，而 README 又写明「以它为准」）·
`src/` 内 3 个 Python 文件（3919 行）在全部 TS 门禁之外。

**本轮（§3.12）已清掉**：

- ✅ **shell 工具族常量各自声明** → 新增 `adapters/tool/shell/shellTimeouts.ts`：**下限**收成一处
  （两族原本都是 `1000`），默认值与上限**刻意保持分开**并写明理由（前台是钳制上界、交互式另有默认值与
  1 小时上限），`shellTool.test.ts` 加了「下线共用 / 上限确实不同」两条断言。
- ✅ **`src/` 内 Python 文件在门禁之外** → 迁到 `python/omniharness/`（3 文件），
  `scripts/run_omniharness.py` 的 `SOURCE_ROOT` 与文档串同步更新（`repository_root()` 的 `parents[2]` 深度不变）。
- ✅ **README 指向不存在的看板** → `TASK_BOARD_2026-09-13.md` 实际从未存在（真实看板是 `TASK_BOARD.md`）；
  非归档文档 8 处引用全部改正（README×2、docs/README×3、两张历史板各 1、llms.txt×1）。
- 🟡 **`mcpClient` 无 reject 通道**（本条的具体缺陷已修）：`PendingRequest` 增加 `reject` 通道 + `close()`，
  `mcpConnector` 的句柄关闭改为**先拒在途请求、再关传输**，并加「close() 立即拒绝而非等 60s 超时」的回归。
  **但「pending/超时/id 关联重复 6 处」未动**——7 个传输类语义各异（有的带定时器、有的靠 socket close 回调），
  收成一张共享表是独立一轮的重构，不应与本次混做。

**第八轮（§3.13）再清四项**（用户指令：「全部进行清理过」）：

- ✅ **审计哈希链 canonical 分叉** → 新增 `util/hashChain.ts`（`HashChain.GENESIS` + `static hash(prev, canonical, sep)`）：
  **算法与创世哈希只此一份**，两条链各自保留自己的**规范化正文**与**分隔符**
  （分隔符参与哈希 ⇒ 改分隔符＝改历史，故不能「统一」）。
  顺带修掉一处真缺陷：`auditSink.ts` 的分隔符在源码里原是**裸 NUL 字节**（而非转义序列），
  使该文件被工具链判为二进制（读取/ diff / 编辑器全部失效）；改成 `'\u0000'` 转义后
  **行为逐字节不变**（golden 哈希实测一致）。新增 `tests/unit/hashChain.test.ts`：
  两条链各一条 golden 哈希（防静默改链）+ 算法等价性 + 分隔符敏感性 + **`src/**` 无裸 NUL 字节**守卫。
- ✅ **覆盖率门禁聚合值**（实测比审计描述更糟——**是假绿**）：`package.json` 的
  `--test-coverage-include='dist/**'` **匹配不到任何文件**，覆盖率表里只有 `# all files | 100.00` 一行，
  旧门禁**恒真**。改为 `dist/src/**/*.js` 后真实聚合 **90.54%（508 文件）**；
  并重写 `coverageGate.mjs` 为**按文件冻结基线**（`scripts/coverageBaseline.json`）：
  任一文件下降即红、新增文件低于 `MIN_NEW_FILE_COVERAGE`（默认 30%）即红、高于基线提示收紧。
  基线立刻暴露审计点名的那些模块（`consoleUserResponder` 8.60%、`agentIdentityTool` 10.89%、
  `jsonlWriter` 12.50%、`cliServerCmds` 24.12% …）——**以前它们是不可见的**。
  **收尾时又挖出同源的第二层缺陷**：`npm run coverage` 在 Windows 走 `cmd.exe`，脚本里的
  **单引号是字面量** ⇒ include 变成带引号字符串 ⇒ 报告又只剩聚合行，**依然假绿**（我最初用 `node` 直跑
  得到的 90.53% 掩盖了这一点）。两手都补：脚本引号改双引号 + 门禁加**空表守卫**（无逐文件行即阻断，
  报错里直接写明「检查引号口径」）。此外按文件冻结值会**随宿主漂移**：`bashAppRootMapper.js` 源码未改动、
  单测重跑两次结果一致（72.85%），差异来自本机 `bash` 是 **WSL 存根**、拿不到 MSYS 根（基线 78.81%
  来自当时能探到 bash 的运行）⇒ 新增 `scripts/coverageEnvDependent.json`，**经诊断**的宿主相关文件按
  **下限**校验并在输出里标注，**不对任何文件静默放宽**。

- ✅ **公开面「泄漏测试替身」** → **逐条核实：该判断不成立，故不改**。`MockModel` / `MemoryStorage` /
  `PassthroughSandbox` 都是**生产可达**的正式适配器（分别是默认模型适配器、`--storage-adapter memory`
  的实现、沙箱档位 `passthrough` 的注册实现）；若按审计建议弃用/删除，等于宣布默认适配器与可选档位将移除。
  核验证据与「不要删」的结论已写入 `docs/API_STABILITY.md`，防止后人误删。
- ✅ **35 个 eval 脚本未接入 npm script** → 新增 `scripts/runEval.mjs`（唯一入口：`--list`、
  构建先决检查、参数与退出码透传、脚本不存在时退出 2 并列出可用项）+ `eval:list` / `eval:run`，
  并把**顶层 `evals/*.mjs` 全部 38 个**接成 `eval:<名字>` 别名。实测 `eval:*` 共 50 个键
  （38 一名一文件 + 4 短别名 + 6 指向 `benchmark/`/`tests/`/`evals/live/` + list/run）；
  `evals/context-efficiency/bench.mjs` **有意未接线**（依赖同目录 `run.sh` 的 bash+tsc 管线，
  硬接在 Windows 上会「永远红」），`evals/lib/*.mjs`(3) 是共用模块而非可跑脚本。
- ✅ **非 archive 文档死路径** → 新增 `scripts/docLinkCheck.mjs`：**markdown 链接目标**必须存在（阻塞），
  反引号路径提及按**文档相对 OR 仓库根相对**双口径解析后冻结（避免假阳性）；
  基线 `scripts/docLinkBaseline.json`（90 处唯一存量，多为「迁移前路径」与示例 `src/foo.ts` 这类有意引用），
  接入 `pre-commit` 与 `npm run check:doc-links`。**实测 markdown 链接目标 0 处死链**。

**§3.5 逐项状态：六条全部结项（第九轮收口）**：

- ✅ **已结项（第九轮 §3.14）**：JSON-RPC pending 六处重复 —— 见文末 §3.14。
  其**缺陷层**（`mcpClient` 无 reject 通道）早在 §3.12 修掉；本轮把**去重层**也做完了：
  新增 `util/pendingRequests.ts`（`PendingRequests<K, V>`）作为「登记 / 命中 / 超时 / 一次性收尾」的
  唯一实现，**七个**站点全部改接（`a2aClient` / `httpBridgeTransport` / `cdpClient` /
  `lspJsonRpcConnection` / `mcpClient` / `sdkClient` / `serverEventBridge`）。
  原先登记的形态差异**不是靠统一形状**解决，而是让调用方表达差异：`reject` 可缺省（`httpBridgeTransport`
  只有成功通道）、超时可缺省（审批可设 0 不限时）、超时动作由 `onTimeout` 决定
  （五个站点是 reject，审批是**兑现 deny**）、一次性收尾分 `failAll` 与 `settleAll` 两种。

### 3.6【本轮已做，用户指定】SSRF 三张策略表配置化（`METADATA_HOSTS` / `INTERNAL_SUFFIXES` / `IPV4_BLOCKS`）

- **动机（用户指令）**：这类表本身就是**策略数据**（随云厂商清单与企业网络拓扑变化），写死在实现里
  ⇒ 加一个自建元数据端点、或放行某个内网域都要改代码重发，且散落在两处（护栏与出站守卫）会各自漂移。
- **改法**：新增 `src/security/ssrfPolicy.ts`（`SsrfPolicy` + `DEFAULT_SSRF_POLICY` + `resolveSsrfPolicy`）——
  实现只保留默认档，配置 `ssrfPolicy` 可覆盖；声明进 `FileConfig` / `OmniHarnessConfig`，
  校验器 `ssrfPolicyValidator` 接入 `configError`，**与运行时解析器同源**；
  消费链：`omniharness.json` → CLI 层（`args.ssrfPolicy`，出站守卫用）→ 组合根（A2A 传输用）。
- **语义（关键）**：字段缺省 ⇒ 默认表；**显式空数组 ⇒ 清空该项**（危险但显式，不静默）；
  非法条目（坏 CIDR / 越界前缀 / 不以 `.` 开头的后缀 / 含空白主机）⇒ **抛错**，绝不静默丢弃
  （静默丢弃会让人以为「配上了」，实际护栏比预期更松）。
- **顺带合一的口径**：`.corp` 原先只存在于出站守卫的正则里、SSRF 护栏没有 ⇒ 两守卫判定不一致；
  合一后并入默认后缀表（**收紧**，已登记）。
- **验证**：新增 7 例单测（默认档与历史逐字一致 / 替换语义生效 / 出站守卫同源 / 非法条目抛错 /
  显式清空 / 校验器与解析器同源）；`audit:config-wiring` 六条不变量全绿（新字段真的被读、透传、消费）；
  实测「默认档行为与历史一致」+「自定义 `metadataHosts:['evil.example']` 生效」+「非法 CIDR 被拒」。

### 3.7【本轮已做，用户指定】硬编码策略表**全部**移出代码（接 §3.6，第二轮）

- **动机（用户指令）**：§3.6 只做到「配置可覆盖」，**默认档仍写在 `.ts` 里**；`PRIVATE_IPV4_CIDRS` 还是
  `isPrivateIpv4` 的函数默认参数；厂商目录硬编码在 `server/services/providerPresets.ts`，而 CLI 另有一份
  手工副本 `ADAPTER_PRESETS`（注释自称「同源同步」）⇒ 加一家厂商要改两处。用户要求「全部走配置管理，
  不要在代码里硬编码，方便以后维护」。
- **改法**：默认档下沉为**随包发布的声明式数据** `defaults/ssrf.json` / `defaults/providers.json`
  （`package.json#files` 加 `defaults`），`util/builtinDefaults.ts` 按**模块相对路径**读包根（不做 cwd 推断）
  - 缓存，**缺文件 / 不可读 / 坏 JSON 一律抛错**——安全默认档静默退化成空表等于护栏「看着还在、实际更松」。
    用户侧 `omniharness.json` 新增 `providerPresets`（`ssrfPolicy` 沿用），语义为「按 `id` 整条替换、新 `id` 追加」，
    拒绝字段级隐式继承；校验器 `providerPresetValidator` 接入 `configError` 且**与运行时求解器同源**。
- **单一来源**：厂商目录收敛到 `config/providerPresets.ts`（服务端 + CLI 共用），**删除** `ADAPTER_PRESETS`；
  CLI 专属映射（`responses` → openai、`llamacpp` → ollama）改由数据字段 `cliAdapters` 表达，
  测试把「与已删除副本逐项等价」钉死（含 ollama **不在** openai 名下这一细节）。
- **本轮暴露的两个真实缺陷**（都不是本轮引入，但都属「配置管理没接通」，已修 + 回归）：
  1. **`ssrfPolicy` 声明未接线**：`configDefaults()` 从不映射 `file.ssrfPolicy` ⇒ `args.ssrfPolicy` 恒 `undefined`，
     写在 `omniharness.json` 的策略表**从未生效**（只有编程 API 路径生效）。`audit:config-wiring` 的 I5a 只看
     「`src/cli` 里有没有出现该标识」，`args.ssrfPolicy` 足以命中 ⇒ 这条断链长期为绿。**门禁口径本身值得留档：
     I5a 是「有没有提到」，不是「有没有从文件读到参数」**。
  2. **IPv6 内嵌 IPv4 绕过配置网段**：`isPrivateIpv6` 内嵌 IPv4 走的是函数默认参数（内置表），
     配置的 `ipv4Blocks` 只对纯 IPv4 生效 ⇒ `[::ffff:10.0.0.1]` 与 `10.0.0.1` 判定不一致（双口径）。
     现 `isPrivateIpv4` / `isPrivateIpv6` 的网段表**必传**，两个守卫统一传入策略表。
- **验证**：`npm test` 2079 例 / 2074 过 / 1 失败（本机 Chrome 环境用例，与基线同一条）/ 4 skip，新增 18 例；
  `check --strict`（567 文件零违规，含把 `configDefaults` / `buildConfig` 的函数体拉回基线内）、
  `arch:gate --strict`、`audit:config-wiring`（567 文件六条不变量全绿）、`lint`、`format:check`、
  `typecheck`（含 web）全通过。

### 3.8【本轮已做，用户指定】端点/地址硬编码移出代码（接 §3.7，第三轮）

- **用户指令**：「项目中类似的这些**地址**代码链接，也要专门的配置文件进行配置管理，不要在代码中硬编码」，
  起因是 `cliBuildConfig.buildModel` 里三家默认端点 + 兜底模型名 + 凭据 env 名全是字面量。
- **扫描后确认的范围**（先量化再动手）：真硬编码的地址 **6 处**，其中
  `cliBuildConfig.buildModel` 与 `configBuilder.buildRouterAdapter` **各写了一遍同样三个端点**（§3.4 同型缺陷）；
  其余为插件市场索引、SWE-bench 的 `github.com` / `api.github.com`、浏览器 CDP 自检地址/路径。
  **明确不在范围**：OTLP 端点（`OTEL_EXPORTER_OTLP_ENDPOINT`，无默认值即不启用）与 embedding 镜像主机
  （`remoteHost` 缺省 `undefined` 即库默认）——二者本就是 env/选项驱动，没有硬编码可移。
- **改法**：`defaults/endpoints.json`（`modelAdapters` + `services`）+ `src/util/endpointDefaults.ts`
  （严格校验；未知服务标识**抛错**而非给 undefined）。与 §3.7 的加载器同放 `util/`：消费方横跨
  `cli`/`config`/`plugin`/`eval`/`benchmark`/`adapters`，放 `config/` 会让这些层反向依赖装配层
  （`ARCHITECTURE_SPEC.md` §2.1 的 `adapters` 允许依赖里没有 `config`）。
- **口径提醒（留档）**：`endpoints.json` 的 `llamacpp` 兜底 `http://localhost:11434`（原生 `/api/chat`）与
  `providers.json` 的 `ollama` 预设 `http://localhost:11434/v1`（OpenAI 兼容层）**看着重复但不是重复**，
  已写进两份数据文件的 `notes` 与 `defaults/README.md`，避免后来者「顺手统一」而打断其中一条协议路径。
- **机械防线**：`tests/unit/endpointDefaults.test.ts` 的**反硬编码守卫**扫描 `src/**` 的代码行（注释除外），
  地址字面量一旦回到实现即测试失败——本条是本轮最有复用价值的产物（后续再收口地址可直接扩这组字面量）。
- **验证**：`npm test` 2085 例 / 2080 过 / 1 失败（本机 Chrome 环境用例，与基线同一条）/ 4 skip，新增 6 例；
  `check --strict`（568 文件零违规）、`arch:gate --strict`、`audit:config-wiring`（568 文件）、`lint`、
  `format:check`、`typecheck`（含 web）全通过。

### 3.9【本轮已做，用户指定】工具名收成单一来源（接 §3.8，第四轮；结项 §3.4 的「工具名硬编码」项）

- **用户指令**：「把工具名（§3.4 里记的 `'read_file'` 硬编码在 7 个模块）也照这个模式收口成
  `ports/tool/toolNames.ts` 的单一来源」。
- **实测范围大于 §3.4 的记载**（本条值得留档：审计里的「7 个模块」只是当时抽查到的 `'read_file'` 一处）：
  全仓 **45 个工具名**，且**两头都写**——注册侧 33 个工具类各写 `name: '<字面量>'`，消费侧 9 张策略表
  再写一遍（`MUTATING_TOOLS` / plan 只读白名单 / 调度器屏障 / 输出信任分级 / diff 钩子 / 变更目标解析 /
  默认审批规则 / 类别暴露表 / 评估夹具）。**漏改策略表不报错**，只让安全契约对该工具静默失效。
- **改法**：`ports/tool/toolNames.ts` 成唯一声明处。放端口层的理由：消费方横跨 core / adapters / security /
  cli / eval，而 `adapters/**` 与 `security/**` 都不得 import `core/` ⇒ 只有端口层是共同下游。
  `MUTATING_TOOLS` 保留导出名与 `ReadonlySet<string>` 形态（`indexBeta` 有导出），既有调用点零改动；
  域内既有常量（LSP / goal / workflow / policy_eval / agent_identity）改为别名指向同一张表。
- **机械防线**：`tests/unit/toolNames.test.ts` 的两条反硬编码守卫（策略面 + 注册面），并精确排除两类
  **同名但非工具名**的字符串：类别 `keywords:`（任务文本的词法模式）与类别 `id:`/`hint:`（标识与文案）。
  第一版守卫把这两类误判为工具名——**守卫本身也需要被「反向用例」校准**，否则会被当成噪声关掉。
- **验证**：见 §20.14（看板）与 `npm test` 总数；工具名逐字未变（测试逐条钉住）。

### 3.10【本轮已做，用户指定】适配器名与存储后端名各收成一张表（接 §3.9，第五轮；结项 §3.4 剩余两项）

- **用户指令**：把 §3.4 剩余两项收掉（「适配器名→构造器一张表」与「存储后端两套字符串工厂」）。
- **改动 1（适配器名→构造器）**：`adapters/model/modelAdapterRegistry.ts` 的表成为全仓**唯一**允许
  `new` 模型适配器的地方。三处同型分支退化为查表：`cliBuildConfig.buildModel`（4 分支）、
  `configBuilder.buildRouterAdapter`（3 分支）、`providerProbe.buildModelForProvider`（2 分支）。
  语义按调用方分层保留：**路由条目与厂商预设对未知 id 抛错**（配置错误要响亮），**CLI 未知 id 回落 mock**
  （枚举已把关，此处只作防御）。兜底端点/模型/env 名仍在 `defaults/endpoints.json`，表只持有构造器与引用。
- **改动 2（存储后端）**：`cli/storageFactory.ts` 收走「后端名 → 实现 + 缺省落盘路径」
  （`DEFAULT_SQLITE_FILE` 成命名常量、sqlite 懒加载保留），`cliBuildConfig.buildStorage` 退化为一次转发。
  与既有的 `kvStoreFactory` 同形——**两个 family 各一个工厂**；被修掉的是「同一族的字符串分支内联在装配类里」。
  刻意**没有**把子代理的 `events.db` 也并进来：`subagent/` 反向依赖 `cli/` 不合分层，且该文件名全仓只出现一次
  （无重复可收，收了只是多一层间接）。
- **本轮发现的真缺陷**：`configError.ENUM_VALUES.modelAdapter` **漏 `llamacpp`**——`FileConfig` 类型与
  `cliEnums.MODEL_ADAPTERS` 都早有它 ⇒ 配置文件里写 `"modelAdapter": "llamacpp"` 被判非法
  （与 `approval` 的 `'plan'` 同型：声明支持、校验拒绝）。已修，并把「三方一致」机械化。
- **机械防线**：`tests/unit/adapterFactories.test.ts` 6 例，其中两条守卫——模型适配器的 `new` 只允许在注册表内；
  `storageAdapter === '<后端名>'` 的字符串分支只允许在存储工厂内。
- **如实登记的残留**：新增适配器仍需改 **4 处声明**（`CliArgs.modelAdapter`、`FileConfig.modelAdapter`、
  `cliEnums.MODEL_ADAPTERS`、`configError.ENUM_VALUES.modelAdapter`）+ daemon 的 `RoutineModelAdapter`。
  构造已单点、声明仍重复，一致性靠测试①核对；要让声明也从表推导，代价是失去 `satisfies` 的编译期防漂移，
  属可选后续（详见 §3.4 末条）。→ **已由 §3.11 收口**。
- **验证**：`npm test` 2099 例 / 2094 过 / 1 失败（本机 Chrome，与基线同一条）/ 4 skip；
  `check --strict`（571 文件零违规）、`arch:gate --strict`、`audit:config-wiring`（571 文件）、`api:check`、
  `lint`（0 告警）、`format:check`、`typecheck`（含 web）全通过。

### 3.11【本轮已做，用户指定】CLI 帮助数据化 + 适配器声明收成单一来源（接 §3.10，第六轮）

- **用户指令**：`argParser.printUsage()` 那份 80 余行帮助数组「也应自觉按配置的方式实现，不该在代码中硬写」。
- **帮助数据化**：文案 → `defaults/cliHelp.json`；渲染 → `src/cli/cliHelp.ts`（`CliHelp`）。
  **枚举取值不抄**：数据写 `{{storageAdapters}}` 等占位符，渲染时从 `cliEnums` 派生；未登记的名字
  构造期抛错。**顺手修掉一处真漂移**：帮助写 `--storage-adapter memory|jsonl`，而解析期白名单早已是
  `memory|jsonl|sqlite`（用户照帮助选不到 sqlite）。逐行比对 HEAD 的旧数组：73 行对 73 行，
  除该行外文案逐字不变，另 15 行是描述列统一到 36 的纯空格位移（旧数组手工对齐参差）。
- **适配器声明单点化**：`ports/model/modelAdapterId.ts` 的 `MODEL_ADAPTER_IDS` + `ModelAdapterId` 成唯一
  名字来源；`CliArgs` / `FileConfig` / `cliEnums` / `configError.ENUM_VALUES` / daemon `RoutineModelAdapter`
  与 `ProviderAdapterId` 子集全部改为引用它；注册表表体用 `Record<ModelAdapterId, …>` ⇒ **漏一行即编译报错**。
- **机械防线**：`tests/unit/cliHelp.test.ts` 6 例（枚举派生 / 排版 36 列 / 占位符 fail-closed /
  **幽灵文档禁止** / **新增旗标必须文档化**（存量 15 个未文档化旗标冻结）/ 渲染确定性）。
  守卫自身被反向用例校准了两轮：首版把「类别关键词」「短旗标 `-p, --print`」误判为幽灵。
- **测试污染修复（留档）**：`adapterFactories.test.ts` 初版用相对路径建 sqlite 后端，在**仓库根**留下
  `omniharness.db` / `custom.db`（`git add -A` 会直接提交）。现一律落临时目录 + 句柄 `close()` 后再清理。
- **验证**：`npm test` 2105 例 / 2100 过 / 1 失败（本机 Chrome，与基线同一条）/ 4 skip；
  `check --strict`（573 文件零违规）、`arch:gate --strict`、`audit:config-wiring`（573 文件、七条不变量）、
  `api:check`、`lint`（0 告警）、`format:check`、`typecheck`（含 web）全通过。

### 3.12【本轮已做，用户指定】余项清理（接 §3.11，第七轮）

用户指令：「把余下的问题全部处理干净」。逐项处理结果见 §3.5 的**逐项状态**小节，此处只记本轮新增/变更：

- **未文档化旗标清零**：上轮把 15 个「在 `FLAG_TABLE` 里但帮助未记载」的旗标冻结为基线；本轮全部补进
  `defaults/cliHelp.json`（`--prompt` / `--model` / `--memory-*` / `--model-router*` / `--turn-token-budget` /
  `--stream-text` / `--no-model-retry` / `--no-model-circuit-breaker` / `--model-circuit-breaker-*` /
  `--cost-budget-*`），**基线清空** ⇒ 此后任何新增旗标未写进帮助即测试失败。
  其中 `--cost-budget-on-exceed` 的取值也纳入「枚举必须派生」检查（`{{budgetOnExceed}}`）。
- **`mcpClient` 拒绝通道**：`PendingRequest` 补 `reject` + `close()`，`mcpConnector` 句柄关闭改为
  先拒在途请求再关传输；新增回归「close() 立即拒绝（不等 60s 超时）」。
- **`--auth-required` 读取方式**：从裸 `serveArgs.includes(...)` 改为 `CliArgReader.has(...)`
  （新增该语义化方法）。**如实说明**：`Array.includes` 本就是精确匹配，这**不是 bug 修复**，
  只是把「子命令自解析参数」统一到同一套读取惯例（原注释里我一度写成「防子串误判」是错的，已改正）。
- **shell 工具族超时口径**、**Python 文件迁出 `src/`**、**README 死引用**：见 §3.5。
- **验证**：`npm test` 2108 例 / 2103 过 / 1 失败（本机 Chrome，与基线同一条）/ 4 skip；
  门禁同上（573 文件）。

### 3.13【本轮已做，用户指定】§3.5 六项清理（接 §3.12，第八轮）

用户指令：「全部进行清理过」。**逐条结论见 §3.5 的逐项状态**，此处只记本轮新增/变更与一处"审计判断不成立"的更正：

- **哈希链**：`src/util/hashChain.ts`（新）＝算法与创世哈希的唯一定义；两条链保留各自正文与分隔符
  （分隔符参与哈希 ⇒ 不可统一）。**同期修掉一个真缺陷**：`auditSink.ts` 的分隔符原为源码内**裸 NUL 字节**
  （非转义序列），致该文件被工具链当二进制；改 `'\u0000'` 后行为逐字节不变（golden 实测一致）。
  `tests/unit/hashChain.test.ts`（新，4 例）：两条链 golden + 算法等价性/分隔符敏感性 + **裸 NUL 守卫**。
- **覆盖率门禁**：审计说「是聚合值」，**实测更严重——是假绿**：`--test-coverage-include='dist/**'`
  匹配不到文件，旧门禁恒真。修正后真实聚合 **90.54%（508 文件）**，门禁重写为**按文件冻结基线** +
  新增文件下限（30%）；**收尾又挖出同源第二层**——npm 在 Windows 走 `cmd.exe`、单引号是字面量，
  改完 include 后 `npm run coverage` **仍**假绿，故同时改引号为双引号并加**空表守卫**；
  另有 `scripts/coverageEnvDependent.json` 对**经诊断的宿主相关文件**（`bashAppRootMapper`，因本机
  `bash` 是 WSL 存根）按**下限**校验。见 `scripts/coverageGate.mjs` / `scripts/coverageBaseline.json`。
- **公开面「泄漏测试替身」**：**审计判断不成立**（三个都是生产可达的正式实现），故**不改**；
  证据与「不要删」的结论记入 `docs/API_STABILITY.md`。
- **eval 接线**：`scripts/runEval.mjs`（新）为唯一入口，`evals/*.mjs` 38 个全部接成 `eval:<名字>`。
- **文档死路径**：`scripts/docLinkCheck.mjs` + 冻结基线（新，接入 `pre-commit`）。实测 **markdown 链接 0 死链**；
  审计的「172 处」绝大多数是**反引号提及**（含示例与迁移前路径），不是链接。
- **JSON-RPC pending 六处**：**缺陷层 + 去重层都已结**（详见 §3.14 与 §3.5 末条）。

### 3.14【本轮已做，用户指定】JSON-RPC pending 去重（接 §3.13，第九轮）

用户指令：「把其他问题全解决掉」——即 §3.13 里**唯一保留**的那一项（七个站点的在途请求簿记重复）。

- **新增** `src/util/pendingRequests.ts`：`PendingRequests<K, V>` 是「登记 → 命中 / 超时 / 一次性收尾」的
  **唯一实现**，含三条不变量：① 每个被登记的处理器**恰好**在一条路径上收尾；② 移出条目的同时清定时器
  （故不存在「已兑现但定时器still在、稍后又 reject 一次」的双收尾，`onTimeout` 用 `take` 的返回值判幂等）；
  ③ 一次性收尾返回条数（供日志/断言）。
- **形态差异不靠「统一形状」消除，而由调用方表达**（这是上一轮判断「不能安全合并」的正面解法）：
  - `reject` **可缺省** → `httpBridgeTransport` 只登记成功通道（原样保留「谁兑现这个响应」语义）；
  - 超时**可缺省** → 审批等待上限可为 0（不限时，保留 `OMNI_APPROVAL_UPLINK_TIMEOUT_MS=0` 的旧行为）；
  - 超时动作由 `onTimeout` 决定 → `a2aClient`/`cdpClient`/`lspJsonRpcConnection`/`mcpClient`/`sdkClient`
    是 **reject**，`serverEventBridge` 是 **兑现 deny**（fail-closed 而非报错）；
  - 一次性收尾两种都在：`failAll`（断开 → 全部 reject）与 `settleAll`（断连 → 全部按同一值兑现，
    审批即「一律 deny」，并保留 `denyAllPending(reason)` **返回条数**的对外契约）。
- **七个站点全部改接**：`a2aClient`（删本地 `Pending` 接口）、`httpBridgeTransport`、
  `cdpClient`（删本地 `PendingRequest` + 私有 `failAll`，其「任何 promise 都不得永久悬着」的不变量提到类注释）、
  `lspJsonRpcConnection`（删本地 `Pending` + 私有 `failAll`）、`mcpClient`（删本地 `PendingRequest` +
  私有 `failAll`）、`sdkClient`（删本地 `PendingCall` + 私有 `rejectPending`，原先「包一层只为 clearTimeout」
  的 resolve/reject 包装随之消失）、`serverEventBridge`（删内联 `settle`/定时器分支，`pendingApprovalCount()`
  与 `denyAllPending()` 改走 `size()`/`settleAll()`）。
- **行为保真点（逐条核对过）**：超时错误文案逐字未变（`A2A 调用超时: <method>` / `CDP 命令超时（<ms>ms）: <method>` /
  `LSP 请求超时: <method>` / `MCP 请求超时: <method>` / `SDK 请求超时: <method>`）；登记发生在**发送之前**
  （避免回包早于登记）；`mcp.request.timeout` 的告警字段与顺序不变；重复响应/重复审批幂等。
- **回归证据**：新增 `tests/unit/pendingRequests.test.ts`（9 例：结算幂等、未知 key、无 reject 通道、
  两种超时动作、结算后定时器必须已清、`take` 分支、`failAll`/`settleAll` 计数、同 key 覆盖）；
  站点侧 15 个测试文件 97 例 + 审批/LSP 侧 9 个文件 67 例全过（含 `mcp.test.ts` 的
  「close() 立即拒绝而非等 60s 超时」、`approvalUplinkTimeout.test.ts`、`cdpClient.test.ts`、`sdkStream.test.ts`）。
- **对覆盖率门禁的影响（三处下降，逐个查清，不静默放宽）**：`mcpClient` 87.26→85.29 与
  `httpBridgeTransport` 97.66→97.63 在**两次全量运行中数值相同** ⇒ 是「删掉被覆盖的样板」造成的
  **度量效应**（逻辑搬进 98.83% 覆盖的 `pendingRequests.js`），故更新冻结值；
  `wsConnection` 85.14→84.42 则**源码未被本次改动触及**，且**不含**新测试文件时全量恰好回到 85.14%
  ⇒ 属「测试文件集合改变并发交错」的度量抖动，故**不改基线**，登记为**下限 84%**
  （`scripts/coverageEnvDependent.json`，附证据）。同时 6 个站点覆盖率**上升**
  （`a2aClient` 94.44→100、`sdkClient` 91.14→95.38、`serverEventBridge` 95.68→96.5 等），已收紧基线；
  聚合 **90.56% / 509 文件**。

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

### 3.10【本轮已做，核验收尾】默认数据随包发布 + SSRF 策略在探测路径生效（接 §3.6/§3.7；§3.9 为工具名单一来源，两条互不重叠）

- **核验方式**：对 §3.6/§3.7 的迁移链做「不采信自我宣称」复核——不看注释与看板结论，直接读
  `package.json` 与每个消费点调用处。查出两处收尾缺陷，均属「声明写了、事实没到」。
- **缺陷 1（发布即不可用）**：`package.json#files` **没有** `defaults`，而 `defaults/README.md`、看板 §20.11/§20.12
  与对应 changeset 都已宣称「已加入 `defaults`」。npm 包实际会缺 `defaults/*.json`，安装后**启动即抛错**
  （`util/builtinDefaults.ts` 读不到数据，fail-closed）。已修：`files` 加 `defaults`；并给
  `scripts/auditConfigWiring.mjs` 新增不变量 **I6「内建数据即随包发布」**——每个 `builtinDefaults.json(name)`
  调用的数据文件必须存在、且 `defaults` 必须在 `files` 里（带故障注入 selftest）。门禁由六条不变量扩为七条，
  `tests/unit/configWiring.test.ts` 会跑 ⇒ 此类「迁移漏登记」不再可能复发。
- **缺陷 2（配了却不生效）**：`server/services/providerProbe.ts` 的 `fetchModelsEndpoint` / `probeViaChat`
  两处 `assertNotSsrf(url, defaultSsrfOptions())` 把策略写死为默认档 ⇒ 用户写在 `omniharness.json` 里的
  `ssrfPolicy` 在**厂商探测路径**上不生效（§3.6 的「配置化」在该路径上只做了一半）。已修：新增
  `security/ssrfGuard.ssrfOptionsFor(policy)` 作为「默认档 ＋ 注入策略」的唯一入口（防「只传 `{policy}`
  ⇒ 本地端点被误拦」的 E2 装配回归形态），全链增加可选策略入参，`ModelCatalogService` 两个探测点注入
  `resolveSsrfPolicy(file.ssrfPolicy)`；组合根 `makeA2aTransport` 一并收敛到同一入口。
- **机械防线与回归**：`providerAccess.test.ts` 新增「注入策略 ⇒ 在发请求前被拦；同一主机用默认档不拦」
  （无需网络）；`ssrfPolicy.test.ts` 新增 ⑧「`ssrfOptionsFor` 不丢默认档」。
- **实跑证据（本轮）**：`npm test` 2087 例 / 2082 过 / 1 失败（本机 Chrome e2e，环境问题，与基线同一例）/ 4 skip；
  `check --strict`（569 文件零违规）、`arch:gate`、`api:check`、`audit:config-wiring`（569 文件、七条不变量＋selftest）、
  `audit:maturity`、`checkNodeEngine`、`lint`（0 告警）、`format:check`、`typecheck`（含 web）全绿。
- **刻意不做（附理由）**：`util/builtinDefaults.ts` 的包根反推写死 `../../..`，对 `dist/` 布局正确、源码布局直跑
  会指向仓库父目录；**不加向上搜索**（会在某层意外存在 `defaults/` 时静默读到别的数据 ⇒ fail-open，与本模块
  fail-closed 口径冲突）。仓库所有入口都是先 build 再跑，无源码直跑路径。
- **新登记（未修）**：全仓 **216 处 / 104 文件**的 JSDoc 尾部带**错缩进**的 `* @returns 无返回值。`
  （`void` 方法上无意义；207 处在 HEAD 已存在，本轮改动新增 9 处）。Prettier 不管 JSDoc 缩进、现有门禁不查 ⇒
  建议加一条标准检查后机器统一修复（详见看板 §20.13）。
- **清理**：删除两个一次性 codemod 脚本 `scripts/tmpPolicyTableCodemod.mjs` / `scripts/tmpToolNameCodemod.mjs`
  （脚本自述「跑完即删，不入库」，留着即新死资产）。

### 3.11【本轮已做，结清 §3.10 的两项留档】包根锚点定位 + JSDoc 脱块清零（含新标准规则）

- **① 包根定位（原「刻意不做」，本轮改为有锚点的实现）**：`util/builtinDefaults.ts` 原先用
  `resolve(dirname(import.meta.url), '../../..', 'defaults')` —— 只对 `dist/src/**`（测试与发布布局）正确，
  源码布局（`src/util/`）会解析到仓库**父目录**。现 `BuiltinDefaults.locatePackageRoot()` 从模块目录向上
  查找**同时含 `package.json` 与 `defaults/`** 的那一级（最近者胜、上限 4 级）。
  **为何这不是 fail-open**：只找名为 `defaults/` 的目录，会在某一级父目录碰巧有同名目录时静默读到别人的
  数据；以 `package.json` 作包根身份锚点后，命中的必是本包根，找不到即**当场抛错**（而非用猜出的相对路径）。
  测试：随包/源码布局均命中、只有 `defaults/` 无 `package.json` 抛错、超上限深目录抛错、嵌套包根取最近者。
- **② JSDoc 脱块清零 + 新规则**：全仓 **31 文件 / 94 行**的 JSDoc 续行缩进 ≠ 「注释起始列 + 1」
  （`@returns 无返回值。` / `*/` 被写在注释块外）。成因：历史自动补写文档按「行首一空格」写，而 Prettier
  不管 JSDoc 续行缩进、原门禁也不查 ⇒ 长期存活。已一次性机器修复（只动行首空白）。
  规则接入 `auditStandards.mjs`：`--delta` 「只增即红」+ SUMMARY 打印度量 +
  `tests/unit/standardsJsdocIndent.test.ts` 钉住「已接线 + 真实仓库为 0」。
  **统计口径的坑（留档）**：带 BOM 的 41 个 `.ts` 会把 BOM 计入首行列号，首版统计虚报为 122–249 处；
  真实值为 94 处（实现已显式扣除 BOM）。
- **③ 刻意不做的相反方向（附理由）**：**不**禁止 `void` 方法写 `@returns 无返回值。`——
  `auditStandards.mjs` 增量门禁的「方法缺@returns」（`returnsGap`）把「有显式返回类型的方法」含
  `void` / `Promise<void>` 计入分母，`@returns 无返回值。` 正是合规写法；禁止它须先改那条门禁口径，
  属独立政策决策。结论：本轮只治「注释脱块」，不动 `@returns` 有无。
- **④ 工具与流程留档**：codemod 第一版按注释 token 起点累加行长算偏移，导致替换位置右移 `openCol` 个字符、
  把 31 文件正文改坏（`@returns 无返   回值。`）；已全部 `git checkout` 回滚后重写为「按整行偏移 + 写盘前
  自证 0 违约」。**教训：批量文本改写必须先 dry-run 抽样核对 diff，且修复器要自带「改完复检为 0」的后置断言。**
- **⑤ 推送状态**：`mine` 已推送全部提交；**`origin`（`omniharness/omniharness`）推送被拒**——
  `remote: Permission to omniharness/omniharness.git denied to mylong227` + HTTP 403（账号无写权限，
  非网络问题）。
- **实跑证据**：`npm test` **2093 例 / 2088 过 / 1 失败（本机 Chrome e2e，环境问题）/ 4 skip**；`check --strict`、`arch:gate`、`audit:config-wiring`（七条不变量）、
  `audit:maturity`、`audit:standard --delta`、`lint`、`format:check`、`typecheck`（含 web）全通过。
