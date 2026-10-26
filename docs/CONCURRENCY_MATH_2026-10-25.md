# 多会话并发：数学方向调研与落地映射（2026-10-25）

> **本文性质**：一次**面向实现**的数学调研，不是学术综述。每个概念都回答两件事：
> ① 它解决本项目哪个可复现的失败面；② 本仓哪一行代码/哪条判据把它落地了。
> **诚实边界**：本仓没有 TLA+/Coq 工具链；实现了**有界状态空间模型检查**（TS 穷举）。
> CRDT 实现为独立 RGA 原语，**未接入文件写入**（文件仍是整文件 diff3 语义）；OT 只做
> insert-only。文末「未做」一节逐条写明。文中外部结论均为公开常识/论文结论，复现口径以
> 链接原文为准。

---

## 0. 问题重述：并发不是"同时跑"，而是"交错可接受"

两个会话同时改 `a.ts`，失败形态不是"程序崩溃"，而是**某一次写入静默消失**。要谈"解决"，
先把它写成可判定的性质：

| 性质           | 数学表述                                                               | 本项目判据                                               |
| -------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| **互斥**       | 任意时刻至多一个写者位于临界区                                         | `keyedReadWriteLock` 写写互斥 + 跨进程锁                 |
| **无丢写**     | 每个"读—改—写"事务的写效果要么全可见、要么全不可见（原子提交）         | 原子 rename + 版本基线 + 2026-10-25 跨进程 10 次自增判据 |
| **线性化**     | 每个操作可被安排在它开始与结束之间的某一点，且结果与顺序执行一致       | 单文件写锁 + `rename` 的原子可见性                       |
| **无撕裂读**   | 读者看到的永远是某个完整版本，不会看到半个文件                         | `AtomicFileWriter` + 判据⑧（并发读者只看到完整版本）     |
| **有界等待**   | 任一请求在有限时间内要么成功、要么得到可读失败（不永久挂起）           | `timeoutMs` / AbortSignal / 进程锁等待上限               |
| **公平性**     | 在持续积压时，各会话获得的服务量与权重成比例；新会话不继承历史欠账     | `FairSessionScheduler`（SFQ）+ 判据②③                    |
| **无死锁**     | 等待图无环                                                             | 多文件锁按绝对路径排序后一次性持有 + 判据⑦               |
| **崩溃可恢复** | 进程在任意点崩溃后，磁盘上要么是旧完整版本、要么是新完整版本，锁可过期 | `rename` + 租约/心跳/fencing token                       |

> 关键取舍：**"正确"不等于"永不并发"**。读读必须并行、异文件必须并行、不同位置的编辑应当
> 合并——否则只是把并发问题换成了吞吐问题。

---

## 1. 互斥与读写锁：安全性 / 活性 / 公平性

### 1.1 为什么不是"一个全局互斥量"

全局锁把 `O(1)` 的冲突放大成 `O(N)` 的串行：所有会话、所有文件互相等待，尾延迟随会话数线性上升。
正确粒度是**资源键**（本项目：归一化绝对路径），不同键之间没有共享可变状态。

### 1.2 读写锁的四条不变量

设 `R` 为读者数、`W∈{0,1}` 为写者数：

1. `W=1 ⇒ R=0`（写者独占）
2. `W=0` 时读者可任意多（读读并行）
3. 队列非空时新请求**不得插队**（FIFO；否则先到者可能永远拿不到）
4. 队列里有写者时，后到的读者排在写者之后（**写者优先**；否则源源不断的读会饿死写）

本仓 `KeyedReadWriteLock` 直接实现这四条：`pump()` 先放行队首连续读者，无读者时再放行一个写者；
空闲即删 key（有界内存）。判据 `tests/unit/keyedReadWriteLock.test.ts` ①–⑧。

### 1.3 活性与"写者饥饿"

写者优先不是"写者永远优先"：它只保证**已在队列中的写者**不会被后来的读者无限绕过。
代价是：一个长读会阻塞后续写。文件读通常是毫秒级，故这个代价可接受；若未来出现长时间读
（比如对 1 GiB 文件做全量哈希），应改为**读租约 + 写者等待上限**，把"长读"显式降级为失败，
而不是让写者无限等。

---

## 2. 调度：FIFO、处理器共享与公平排队

### 2.1 为什么 FIFO 信号量会"饿死会话"

`ConcurrencyLimiter` 是 FIFO 信号量：一个会话一次性排入 100 个 shell 任务，另一个会话的第 1 个
任务排在第 101 位。总吞吐没变，但**尾延迟被一个会话拉爆**。这是分配问题，不是并发度问题。

### 2.2 Start-time Fair Queueing（SFQ）

把每个任务看成一个包。会话 `i` 的第 `k` 个包：

```
start(i,k) = max(V, finish(i,k-1))
finish(i,k) = start(i,k) + 1 / w_i
```

每次选 **finish 最小**的包执行，然后 `V ← max(V, start)`（`V` 为系统虚拟时间）。
`w_i` 是权重；`w_i=1` 即等分。性质（理想流体近似下）：

- 任意时间窗内，各会话服务量按 `w_i` 成比例；
- 新会话从当前 `V` 起算，**不继承**别人的历史欠账（不会因为来得晚而被永久压后）；
- 有界积压时，单会话延迟上界与"其它会话的最大包数"相关，而与它自己的队列长度无关。

本仓 `FairSessionScheduler` 用「每会话 FIFO + 每次扫描所有会话头」实现（会话数远小于任务数，
`O(S)` 扫描比堆更简单、更确定）。判据 `fairSessionScheduler.test.ts`：
② A 灌 10 个任务时 B/C 仍排在 A5 之前；③ 权重 3:1 在前 20 个槽位约为 15:5。

### 2.3 容量与排队论：为什么"把上限调大"往往更慢

把资源看成服务台，到达率 `λ`、单台服务率 `μ`、并行度 `c`。M/M/c 的平均等待随利用率 `ρ=λ/(cμ)`
非线性上升；M/M/1 的响应时间：

```
E[T] = 1 / (μ - λ)
```

`ρ → 1` 时 `E[T] → ∞`。工程含义：

- 并发上限不是越大越好；**超过服务能力后，排队只会增加尾延迟与超时**；
- 观测应看 **p50/p95/p99** 与排队长度，而不是只看平均吞吐；
- Little 定律 `L = λW` 可用于把"队列长度"和"等待时间"互相校验（本项目 `stats()` 暴露
  `active/waiting`，可直接代入）。

本仓默认 shell 上限 **8**（`OMNI_SHELL_CONCURRENCY`），是按"前台命令以 IO/构建为主、单机核数
有限"取的保守值；**没有**做自动调参（见 §9 未做项）。

### 2.4 抖动的代价：为什么不能简单轮询

若所有争抢者以固定间隔重试，会在同一时刻再次碰撞（**惊群 / thundering herd**）。本仓跨进程锁
采用**全抖动**：

```
sleep = slice * (0.5 + U[0,1])
```

它在期望上不改变总等待，但打散到达相位，降低"同一毫秒内 N 个进程同时 `mkdir` 失败"的概率。
（`AsyncFileLock.acquire`；这是工程启发式，不是最优退避证明。）

---

## 3. 乐观并发：版本、CAS 与"读—改—写"

### 3.1 为什么需要版本基线

悲观锁只能保证"不交错"，不能保证"模型手里的内容还是最新的"。会话 A：

```
read x (v1) → 用户/别的会话把 x 改成 v2 → A write(v1 的内容)
```

若只加锁，A 仍会**合法地**覆盖 v2。故写前必须比较**基线**：`current == expected` 才提交，
否则拒绝（CAS 语义）。本仓 `FileContentLedger` 按会话保存 `owner → path → hash`，写前
`changedSince(path, current, owner)`；判据 `staleReadGuard` + `workspaceFileCoordinator` ③。

### 3.2 全局一份指纹为什么不够（本仓 2026-10-25 修掉的真缺陷）

旧账本只有"该路径最新内容"一份。于是：

```
A read x (ledger=x) → B write y (ledger=y) → A write:
changedSince(ledger=y, disk=y) = false ⇒ A 的陈旧内容覆盖 B
```

按会话基线后，A 的基线仍是 x，磁盘是 y ⇒ 冲突。这一条不是理论推演，是判据③的现场形态。

### 3.3 逻辑时钟：何时需要 Lamport / 向量时钟

内容哈希比较的隐含假设是"同一路径的内容单调演进"。跨**多副本**（两台机器各自缓存同一文件）
时，需要因果顺序：

- **Lamport 时钟**：给事件一个全序标量，能判断 `a → b`，但不能判断并发；
- **向量时钟**：`V_i[j]` 记录 i 知道的 j 的事件数；`V_a < V_b` 才是因果先后，否则**并发**；
- **版本向量 + 冲突副本**：并发写不覆盖，保留两个版本供人工/策略合并。

本仓当前是**单机多进程共享同一文件系统**，`rename` + 文件锁已提供线性化点，故**不需要**向量时钟。
若未来做"多机共享工作区"或"离线副本"，才需要把账本升级成版本向量（见 §9）。

### 3.4 文本合并：LCS、diff3、OT、CRDT

| 方法                   | 数学对象                              | 适用                           | 本仓取舍                                               |
| ---------------------- | ------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| 公共前后缀             | 最长公共前缀/后缀                     | 冲突摘要（第几行起、增删多少） | ✅ `TextDiffSummary`                                   |
| LCS / diff3            | 最长公共子序列 + 三方合并             | 两份完整文本 + 共同祖先        | ✅ 行级 `TextThreeWayMerge` + 冲突片段字符级细化       |
| 字符级 LCS             | 以 UTF-16 code unit 为单元的三方合并  | 同一行不同字符区间             | ✅ `TextCharacterMerge`（只细化冲突片段）              |
| 操作变换（OT）         | 操作序列 + 变换函数 `T(a,b)`          | 实时协同编辑（中心服务器）     | ✅ insert-only `TextOperationalTransform`；delete 未做 |
| CRDT（RGA/Yjs 类）     | 全序/半格 + 交换律/结合律/幂等        | 无中心、离线优先               | ✅ RGA `TextCrdt`（独立原语，未接入文件写入）          |
| **锚点交换性（本仓）** | 替换操作的前置条件：`old_string` 唯一 | 按内容编辑、双方改不同位置     | ✅ `EditFileTool`：锚点仍在 ⇒ 合并；否则拒绝           |
| 多人整文件覆盖         | 无交换性                              | 必须显式冲突                   | ✅ `write_file`：三方合并失败即拒绝                    |

**两层合并语义（2026-10-26 补齐 diff3）**：

1. **有共同祖先全文**（该会话 `read_file`/上次写过的内容仍在 `SessionBaselineStore` 内）：
   用 `base + ours + theirs` 做**行级 diff3**。base→两边的 LCS 差分若落在不相交的 base 区间，
   两个改动可交换，直接叠加；区间相交且结果不同 ⇒ 冲突，**不写盘**。
   `write_file`/`edit`/`apply_patch` 三条写路径都走这一层。
2. **没有基线全文**（未读、文本超过 512 KiB/全局预算被淘汰）：退回**锚点交换性**——
   `old_string` 仍唯一命中则替换，否则拒绝。这一层是保守降级，不是另一套语义。

**字符级只做冲突片段细化**：行级已经能覆盖「两个函数各改一处」这类真实并发；当同一行
两侧都改时，`TextCharacterMerge` 再按 UTF-16 code unit 做一次 LCS。它**不做整文件字符级
合并**：那会把「同一行不同位置」也合并，容易生成语法上成立但语义错误的内容，而且需要更
复杂的冲突 UI。`diff3` 的最终冲突仍然交回模型/人决策——本仓不自动生成冲突标记写盘。
delete/富文本/undo 的 OT 与 CRDT 的垃圾回收仍未做（见 §9）。

**判据**：`textThreeWayMerge.test.ts`（干净合并/冲突/插入删除边界/超限）、
`fileThreeWayMerge.test.ts`（三个工具 × 真文件 × 两会话）、
`workspaceFileCoordinator` ⑤⑥、`editFileTool` 既有判据。

---

## 4. 死锁：Coffman 条件与有序加锁

死锁四条件（Coffman et al., 1971）：互斥、持有并等待、不可抢占、循环等待。
本仓多文件补丁最容易踩第 4 条：

```
会话 A: lock(a) → 等 lock(b)
会话 B: lock(b) → 等 lock(a)
```

**破法**：所有多文件操作按**全序键**（归一化绝对路径）排序后依次获取；任何调用方都必须
用同一顺序。`WorkspaceFileCoordinator.withWriteMany` 先 `uniqueSorted`，再逐把获取；
判据⑦用反向申请 `[b,a]` 验证不会互锁。

其它工程约束：

- 不可抢占 ⇒ 用**租约 + 超时**把"永久持有"变成"有界失败"；
- 持有并等待 ⇒ 尽量"要么全拿、要么不拿"（两阶段），并在失败时按逆序释放；
- 循环等待 ⇒ 排序 / 层级锁（本项目选排序，成本最低）。

---

## 5. 原子性与持久性：rename、fsync、哈希链

### 5.1 为什么 `writeFile(target)` 会产生撕裂读

`writeFile` 先截断再写。另一个进程在截断与写完之间读，会拿到空串或半截内容；进程崩溃则文件
永久停在一半。**同文件系统内的 `rename` 是原子的**：读者要么看到旧 inode 的完整内容，要么看到
新 inode 的完整内容。本仓 `AtomicFileWriter`：

```
write(temp) → chmod(保留权限) → rename(temp, target)
```

Windows 上杀毒/索引器短暂占用会让 `rename` 返回 `EPERM/EBUSY`；按指数退避 + 抖动有界重试
（最多 5 次），仍失败则**报错**，不静默退化为非原子写。判据⑧用 12 个 120 KB 版本 + 8 个并发读者
验证"只会看到完整版本"。

### 5.2 fsync：按数据价值分层（2026-10-26 补齐）

`fsync` 保证掉电后数据仍在；代价是每次写入一次磁盘同步，吞吐下降一个数量级。本仓按
**数据价值**分层，而不是全局开或全局关：

- **工作区文件**：默认只保证"进程崩溃安全"（rename 原子），不 `fsync`——它们可重建、可重跑；
- **`durable:true` 的原子写**：`AtomicFileWriter` 对临时文件 `fsync`，POSIX 上再 sync 父目录；
- **晋升台账**：每条 append 后 `fsync`（不可重建的治理证据）；
- **审计链**：`close()` 必 `fsync`（正常停机不掉尾）；`durable:true` 时每条记录也 `fsync`
  （合规要求更高、吞吐换耐久）。

**边界**：这不是"所有文件掉电安全"；崩溃发生在 `fsync` 之前仍可能丢尾部，且网络文件系统
的 fsync 语义取决于服务端实现。

### 5.3 哈希链与 Merkle

- **哈希链**：`h_i = H(h_{i-1} || entry_i)`，改中间一条会断链——本仓晋升台账/审计链已用；
- **Merkle 树**：把 N 条记录的校验压成 `O(log N)` 的路径，适合"证明某条记录属于某版本"；
  本仓**未**对工作区文件做 Merkle 化（文件数大、收益低）。

并发写入与哈希链的交点：链的 append 必须串行（否则分叉），本仓台账用单写者/文件锁；
若要并行 append，需要"批量提交 + 单点排序"，而不是让每个写者各自读尾哈希。

---

## 6. 资源预算：信号量、令牌桶、准入控制

| 机制       | 数学形态                       | 本项目用途                                       |
| ---------- | ------------------------------ | ------------------------------------------------ |
| 计数信号量 | `active ≤ c`                   | `ConcurrencyLimiter` / 工作流并发 / A2A          |
| 公平队列   | SFQ finish 标签                | `FairSessionScheduler`（shell）                  |
| 令牌桶     | `tokens += r·Δt`，`tokens ≤ B` | 未做（模型配额是外部服务，当前靠 provider 限流） |
| 准入控制   | 队列长度 ≥ L ⇒ 拒绝            | `maxQueuePerSession` / `maxQueueTotal`           |
| 有界缓存   | LRU / 插入序淘汰               | 账本 8192 路径、锁表空闲删除                     |

### 6.1 为什么同时要"总量"和"公平"

只有总量：一个会话可以占满所有槽位。
只有公平：没有上限时，N 个会话仍可起 N 倍进程。
**两者叠加**才是"总量有界 + 分配公平"。本仓 shell 闸门正是 `FairSessionScheduler(limit=8)`。

### 6.2 队列长度设计

`maxQueuePerSession=64`、`maxQueueTotal=256` 是**有界内存**与"允许突发"的折中；超过即拒绝
（`LockError('queue-full')`），而不是无限排队。拒绝文案要告诉调用方"降低并发/稍后重试"，
否则模型会原样重发。判据 `shellGovernor` ③。

---

## 7. 观测与实验设计（比公式更容易出错的部分）

并发判据最容易写成"看起来在测并发，其实在赌时序"。本仓纪律：

1. **用闸门/屏障，不用固定 sleep**：先让 A 持有锁并阻塞在 Promise 上，再启动 B，断言 B 未开始；
   放行 A 后再断言顺序。判据①–⑦均按此写。
2. **同时测正反两面**：既断言"并发峰值 = 上限"（闸门真的生效），也断言"未注入闸门时峰值 = 2"
   （没有把默认行为改坏）。`shellGovernor` ⑤。
3. **变异自证**：把关键修复删掉，判据必须红；若仍绿，先怀疑变异没落地。
4. **跨进程要真起进程**：同进程两个实例测不出 `mkdir` 原子性、租约、fencing。判据⑨真 spawn
   两个 Node 进程各做 5 次读—改—写。
5. **耗时断言用相对量/上界，不用绝对毫秒**：全量套件并发时机器负载会让绝对阈值假红
   （本仓已有多次教训）。
6. **统计口径**：公平性判据用"前 20 个槽位的比例"而不是单次顺序；容量判据用 p95/p99 而不是均值。

---

## 8. 落地映射（数学 → 代码 → 判据）

| 数学/理论                    | 代码                                                               | 判据                                                                        |
| ---------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 读写锁不变量 + 写者优先      | `src/util/concurrency/keyedReadWriteLock.ts`                       | `keyedReadWriteLock.test.ts` ①–⑧                                            |
| FIFO 信号量                  | `src/util/concurrency/concurrencyLimiter.ts`（既有）               | `concurrencyLimiter.test.ts`                                                |
| SFQ 公平调度                 | `src/util/concurrency/fairSessionScheduler.ts`                     | `fairSessionScheduler.test.ts` ①–⑧；`shellGovernor.test.ts`                 |
| CAS / 版本基线（按会话）     | `src/adapters/tool/fs/fileContentLedger.ts`                        | `staleReadGuard.test.ts`；coordinator ③                                     |
| 基线全文（diff3 的共同祖先） | `src/adapters/tool/fs/sessionBaselineStore.ts`                     | `sessionBaselineStore.test.ts`                                              |
| 行级 LCS / diff3 三方合并    | `src/util/textThreeWayMerge.ts`                                    | `textThreeWayMerge.test.ts`；`fileThreeWayMerge.test.ts`                    |
| 字符级 LCS（冲突片段细化）   | `src/util/textCharacterMerge.ts`                                   | `textCharacterMerge.test.ts`；`textThreeWayMerge.test.ts`                   |
| insert-only OT               | `src/util/textOperationalTransform.ts`                             | `textOperationalTransform.test.ts`（交换律穷举）                            |
| RGA CRDT（独立原语）         | `src/util/textCrdt.ts`                                             | `textCrdt.test.ts`（并发插入/墓碑/merge 收敛）                              |
| 向量时钟（因果偏序）         | `src/util/concurrency/vectorClock.ts`                              | `vectorClock.test.ts`（before/after/concurrent/merge 交换幂等）             |
| 共享文件系统分布式租约       | `scripts/workspaceLease.mjs`（build/test 共用）                    | `workspaceLease.test.ts`（真跨进程区间不重叠）                              |
| 有界模型检查                 | `tests/unit/modelChecking.test.ts`                                 | 读写锁可达状态穷举 + 有序加锁无环 + 正对照                                  |
| 耐久写（fsync）              | `atomicFileWriter.ts`（durable）：账本 append / AuditSink close    | `atomicFileWriterDurable.test.ts`、`auditDurability.test.ts`                |
| 冲突文案统一口径             | `src/util/textMergeConflictMessage.ts`                             | 三个写工具的冲突用例                                                        |
| 跨进程租约 + fencing + 心跳  | `src/util/concurrency/fileLock.ts`、`asyncFileLock.ts`             | `fileLock.test.ts`、`fileLockCrossProcess.test.ts`、`asyncFileLock.test.ts` |
| 原子 rename + 有界重试       | `src/util/concurrency/atomicFileWriter.ts`                         | coordinator ⑧（并发读者完整版本）                                           |
| 读单飞（共享在飞 IO）        | `src/adapters/tool/fs/workspaceFileCoordinator.ts`                 | coordinator ⑫                                                               |
| 有序加锁（破循环等待）       | `WorkspaceFileCoordinator.withWriteMany`                           | coordinator ⑦                                                               |
| 内容锚点交换性               | `src/adapters/tool/fs/editFileTool.ts`、`textDiffSummary.ts`       | coordinator ⑤⑥；`editFileTool.test.ts`                                      |
| 随机/性质测试（不变量）      | `tests/unit/concurrencyProperties.test.ts`                         | 200 任务交错 W≤1、SFQ 1:2:3、120 次自增不丢                                 |
| 两阶段提交 + 回滚            | `src/adapters/tool/fs/applyPatchTool.ts`、`patchCandidatesTool.ts` | `patchCandidates.test.ts`、staleReadGuard ⑤                                 |

**接入点**：`ConfigToolRegistry.buildWorkspaceTools` 统一装配账本/协调器/shell 闸门——这组工具
必须共享同一批实例，散落装配最容易漏掉其中一条（2026-10-25 已抽成单一 helper）。

---

## 9. 未做（诚实边界）与触发条件

| 方向                                 | 为什么现在不做                                          | 何时重评                                   |
| ------------------------------------ | ------------------------------------------------------- | ------------------------------------------ |
| delete/富文本 OT、整文件字符级合并   | insert-only OT 与冲突片段字符级已覆盖当前文件语义       | 实时协同编辑 / 富文本 / 多光标             |
| CRDT 接入文件写入 / GC               | RGA 已实现并证收敛；文件写入仍走 diff3（整文件语义）    | 做多人实时协同编辑 / 离线副本              |
| 多机文件同步（只做向量时钟原语）     | 向量时钟已实现；多机同步还需要传输、冲突副本与垃圾回收  | 多机共享工作区、跨设备离线                 |
| 跨机 quorum 分布式锁                 | 共享文件系统租约已用于 build/test；不做网络分区下的安全 | 需要 etcd/Raft 级强一致的跨机写            |
| TLA+ / Coq 全量形式化验证            | 已有界模型检查；全量工具链与文件系统外部行为成本过高    | 锁算法再复杂化（优先级、可重入、跨资源）时 |
| 队列容量自动调参（PID / 自适应并发） | 缺少生产延迟分布数据；自动调参会把"未知"变成"不可复现"  | 有真实 p95 指标与可控负载实验后            |
| 优先级继承 / 防优先级反转            | 当前所有会话等权；没有实时优先级                        | 引入交互式高优先级会话 / SLA               |
| 工作窃取 / 任务迁移                  | Node 单线程，迁移收益低                                 | 引入 worker 池做 CPU 密集任务              |
| 全局 fsync                           | 已对账本/审计/durable 原子写开启；全局开启代价过高      | 所有工作区文件都要求掉电安全时             |
| Merkle 化工作区                      | 文件多、收益低；`git` 已提供内容寻址                    | 需要"证明某文件属于某快照"且不能依赖 git   |

---

## 10. 参考（公开来源）

- L. Lamport, _Time, Clocks, and the Ordering of Events in a Distributed System_, CACM 1978.
  <https://lamport.azurewebsites.net/pubs/time-clocks.pdf>
- F. Mattern, _Virtual Time and Global States of Distributed Systems_, 1988.
  <https://www.vs.inf.ethz.ch/publ/papers/VirtTimeGlobStates.pdf>
- M. Shreedhar, G. Varghese, _Efficient Fair Queueing Using Deficit Round Robin_, SIGCOMM 1995.
  <https://dl.acm.org/doi/10.1145/217382.217453>
- P. Goyal, H. M. Vin, H. Cheng, _Start-Time Fair Queueing_, INFOCOM 1996.
  <https://dl.acm.org/doi/10.1109/INFCOM.1996.493348>
- J. D. C. Little, _A Proof for the Queuing Formula: L = λW_, Operations Research 1961.
  <https://en.wikipedia.org/wiki/Little%27s_law>
- E. G. Coffman, M. J. Elphick, A. Shoshani, _System Deadlocks_, ACM Computing Surveys 1971.
  <https://dl.acm.org/doi/10.1145/356586.356588>
- M. Shapiro, N. Preguiça, C. Baquero, M. Zawirski, _Conflict-free Replicated Data Types_, 2011.
  <https://hal.inria.fr/inria-00609399>
- proper-lockfile（租约 + 心跳 + `onCompromised` 的工程参考）:
  <https://github.com/moxystudio/node-proper-lockfile>
- Jepsen（分布式一致性测试方法）: <https://jepsen.io/>

> 引用外部结论时请注意：论文结论有其模型假设（同步/异步、失败模型、消息代价），
> 不能直接外推为"本机一定成立"。本仓的判据是对**本机形态**的可复现断言，不是对论文定理的复现。
