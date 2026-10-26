# 面向实现的数学扩展（2026-10-26）：分位数、背包、UCB1、工作流调度

> **本文性质**：在 `CONCURRENCY_MATH_2026-10-25.md`（并发/文件合并）之后，继续为**非并发**能力找
> 「高杠杆、可判据、零新依赖」的数学模型。每个模型都回答：① 解决本项目哪个可测量瓶颈；
> ② 公式是什么；③ 落在哪一行代码/哪条判据；④ 什么情况下它**不该**用。
>
> 不写「万能数学」：只收录本轮真正实现并跑过判据的四项；未采用的候选连同拒绝理由列在 §5。

---

## 0. 选择标准（为什么是这四项）

| 标准     | 含义                                                       |
| -------- | ---------------------------------------------------------- |
| 可测量   | 有明确的误差/最优性/后悔界，能用判据红绿                   |
| 低耦合   | 纯函数或单类，不引入新服务/GPU/外部依赖                    |
| 失败可退 | 规模超限/输入异常时退回保守路径，不拖垮主流程              |
| 当前瓶颈 | 对应本仓已有的观测缺口或预算决策，而不是「为了用数学而用」 |

四项分别对应：**观测**（分位数）、**预算分配**（背包）、**在线决策**（UCB1）、**调度**（工作流列表调度）。

---

## 1. GK 分位数草图：从 min/max 到 p50/p95/p99

### 1.1 问题

`Metrics` 原先只保存回合耗时的 `count/sum/min/max`。min/max 对长尾没有意义：一次 30s 的
异常回合会把 max 拉到 30s，但 p95 可能仍是 200ms。保存全部样本再排序则是 O(n) 内存 +
O(n log n)，长运行服务不可接受。

### 1.2 数学对象

Greenwald–Khanna（GK）草图维护有序元组 `(v_i, g_i, Δ_i)`：

```text
g_i  = 该元组覆盖的秩下界（gap）
Δ_i  = 该元组允许的秩误差上界
不变式：g_i + Δ_i ≤ 2εn
压缩：g_i + g_{i+1} + Δ_{i+1} ≤ ⌊2εn⌋ ⇒ 合并相邻元组
```

查询分位数 `q` 时取秩 `r = ⌈q·n⌉`，返回第一个满足 `Σ_{j≤i} g_j + Δ_i ≥ r` 的 `v_i`。
空间 `O((1/ε)·log(εn))`，秩误差 `≤ 2εn`（本实现 ε=0.01，即 ≤2%）。

### 1.3 落地

- 代码：`src/util/quantileSketch.ts`
- 接入：`src/server/services/metrics.ts` 的 `turnQuantiles`；`TurnStats` 新增
  `p50Ms/p95Ms/p99Ms`；Prometheus 新增
  `omni_turn_duration_quantile_seconds{quantile="0.5|0.95|0.99"}`。
- 判据：`tests/unit/quantileSketch.test.ts`（4 例）、`tests/unit/metricsQuantiles.test.ts`（2 例）。

### 1.4 实测

10,000 个均匀样本（1..10000），ε=0.01：

| 分位 | 精确 | 草图 | 绝对误差     |
| ---- | ---- | ---- | ------------ |
| p50  | 5000 | 4856 | 144（1.44%） |
| p95  | 9500 | 9439 | 61           |
| p99  | 9900 | 9827 | 73           |

草图元组数 **68**（原始 10000），压缩约 147×；max 保持 10000（压缩时保留最后一个元组，
避免把最大值吞掉）。

### 1.5 不适用

- 需要**精确**分位数（审计结算）时不能用草图；应落原始样本/外部 TSDB。
- 多进程合并：本实现未做 GK merge；若未来多实例聚合，需要合并算法或改用 t-digest。

---

## 2. 0/1 背包：技能注入预算的精确最优子集

### 2.1 问题

`SkillActivationPlanner` 原先按相关性降序贪心：先遇到「高价值但很贵」的技能就吃掉预算，
后面两个便宜技能装不进来。真实场景：预算 18k 字符，技能 A 14k/相关性 10，B 10k/9，
C 8k/9 —— 贪心只拿 A（价值 10），最优是 B+C（价值 18）。

### 2.2 数学对象

0/1 背包：

```text
max  Σ v_i x_i
s.t. Σ w_i x_i ≤ B,  x_i ∈ {0,1}
DP:  dp[i][b] = max(dp[i-1][b], dp[i-1][b-w_i] + v_i)
```

复杂度 `O(nB)`。技能条数 ≤ 数十、B ≤ 1.2 万 ⇒ 最多约 1.2M 单元，毫秒级。

### 2.3 落地

- 代码：`src/util/budgetedKnapsack.ts`（二维 DP + 回溯；`n·B > 5e6` 时按价值密度贪心回退）
- 接入：`src/skill/skillActivationPlanner.ts` 的预算选择；去重/独占资源仍是前置硬约束
- 判据：`tests/unit/budgetedKnapsack.test.ts`（5 例）、
  `tests/unit/skillActivationPlanner.test.ts` 新增「贪心反例」1 例

### 2.4 实测

反例（B=18）：贪心 `A` 价值 10；精确 `B+C` 价值 18，重量 18。既有 6 例规划器判据全部保持
通过（去重、tag 冲突、exclusive 资源、单条超预算至少保留一条）。

### 2.5 不适用

- 预算到 10^6 以上或技能到数千条：`O(nB)` 不再便宜，应改用贪心/拉格朗日松弛。
- 需要**多维**预算（字符 + token + 工具数）时，当前单维背包不够；需多维 DP 或线性规划。

---

## 3. UCB1：模型路由的在线学习

### 3.1 问题

`ModelRouter` 的 `least-cost` 只看累计成本，`round-robin` 不看结果，`by-*` 是静态规则。
当多个 provider 的延迟/成功率随时间变化时，需要一个**边学边选**、且不会永久放弃
暂时失败 provider 的策略。

### 3.2 数学对象

UCB1（Auer et al., 2002）：

```text
score_i = mean_i + sqrt(2 · ln N / n_i)
选择 argmax score_i；冷启动每个臂先各试一次
```

奖励归一化到 `[0,1]`：本仓取

```text
reward = success ? 1 / (1 + latencySeconds) : 0
```

后悔界 `O(√(K·T·log T))`；失败臂 mean=0 会被降权，但上界项保证它仍会被探测。

### 3.3 落地

- 代码：`src/util/concurrency/ucb1Bandit.ts`
- 接入：`RouterStrategy` 新增 `'ucb1'`；`ModelRouter.generate/stream` 计时并记录奖励；
  `routeReason` 输出 `ucb1 chosen=… pulls=… mean=…`
- 配置：`configBuilder` 合法策略表 + `docs/CLI_REFERENCE.md`
- 判据：`tests/unit/ucb1Bandit.test.ts`（4 例）、`tests/unit/router.test.ts` 新增 1 例

### 3.4 实测

单测：3 臂冷启动按 0,1,2 各探索一次；50 轮后高奖励臂 pull 数显著多于失败臂；失败臂仍至少
被探索一次；奖励 5/-5/NaN 夹取为 1/0/0。路由器测试中失败 provider 不再被持续选中。

### 3.5 不适用

- 非平稳环境（provider 能力突变）需要滑动窗口/折扣 UCB；当前是全历史平均，旧数据会拖慢适应。
- 需要**成本约束**时，单纯 UCB1 会选「快但贵」的臂；应把成本并入奖励或使用约束 bandit。

---

## 4. 工作流 DAG：去掉层屏障的列表调度

### 4.1 问题

`WorkflowRunner` 原先逐层执行并**在层末设屏障**：同层所有步骤完成才启动下一层。若某层有一个慢步骤
A、一个快步骤 B，而 C 只依赖 B，C 仍要等 A 完成——并发槽位被一个与 C 无关的长任务占住。

### 4.2 数学对象

DAG `G=(V,E)`，底位级（bottom level，单位权重）：

```text
l(v) = 1 + max{ l(c) : c 是 v 的后继 }，叶子 l=1
```

就绪集合 `R = {v : 所有前驱已终态}`；每轮按 `l(v)` 降序填满并发槽，**等任意一个完成**就重新计算
`R`（列表调度 / HEFT 的简化版）。Graham 的列表调度界：

```text
makespan ≤ (2 − 1/m) · OPT
```

对任意静态优先级成立；关键路径优先通常更接近下界。

### 4.3 落地

- 代码：`src/autonomy/workflowPriority.ts`（底位级 + 稳定排序）、
  `src/autonomy/workflowRunner.ts` 的 `scheduleReady` / `classifyReady`。
- 开关：`WorkflowRunnerOptions.scheduling`（`ready` 缺省 / `levels` 旧行为）、
  `priority`（`critical-path` 缺省 / `spec`）。
- **安全边界**：只有**全只读**工作流走 `ready`；任一步骤可能写文件时自动回退 `levels`，
  保持共享工作区的写安全（`WorkflowLayerPolicy`）。
- 判据：`tests/unit/workflowPriority.test.ts`（4 例）、
  `tests/unit/workflowReadyScheduling.test.ts`（1 例，真计时）。

### 4.4 实测

DAG：A(120ms)、B(10ms)、C(10ms，依赖 B)，并发 2。

| 调度           | C 启动时刻         | 结果                            |
| -------------- | ------------------ | ------------------------------- |
| `levels`（旧） | A 结束后（≈120ms） | 层屏障把 C 拖到慢兄弟之后       |
| `ready`（新）  | B 结束后（≈10ms）  | C 在 A 完成前启动，槽位不被空耗 |

判据断言 `ready: C.start < A.end` 且 `levels: C.start ≥ A.end − 5ms`。

### 4.5 不适用

- 写类工作流：共享工作区会覆盖，必须保留层屏障/写安全策略。
- 单位权重不等于真实耗时；有步骤耗时估计后可把 `l(v)` 换成加权底位级（HEFT 原版）。
- 列表调度是启发式；受并发约束的 DAG 最优 makespan 是 NP-hard。

## 5. 评估过但本轮不采用的模型

| 候选                        | 数学对象                           | 为什么本轮不做                                                                              |
| --------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| HNSW / ANN                  | 近邻图 + 分层可导航小世界          | 现有语义召回是暴力余弦，44k 符号规模仍可接受；HNSW 需要索引持久化/删除/召回率判据，工作量大 |
| t-digest                    | 自适应质心 + 尺度函数              | 与 GK 二选一；GK 确定性误差界更易写判据，t-digest 的 merge 优势当前用不上                   |
| Count-Min / TinyLFU         | 哈希计数 + 频率淘汰                | 现有缓存命中率已由 LRU/代际清扫覆盖；没有证据表明频次淘汰能赢当前访问模式                   |
| HyperLogLog                 | 调和平均 + 寄存器                  | `Metrics.sessions` 是精确 Set，规模未到内存瓶颈；HLL 会牺牲精确性                           |
| 子模最大化（覆盖/设施选址） | `F(S)=Σ max_{i∈S} w_i`，贪心 1−1/e | repo-map 的实证结论是「排序 > 呈现」，改选择器风险高；先做技能预算背包（更小、可证最优）    |
| Lyapunov / 队列稳定性       | drift-plus-penalty                 | 现有 SFQ 已解决公平性；没有多队列稳定性的实测缺口                                           |
| PID / 自适应并发            | 误差反馈                           | 缺少生产 p95 分布；自动调参会把「未知」变成「不可复现」                                     |
| Kalman / 状态估计           | 线性高斯滤波                       | 没有连续状态需要估计；模型延迟是重尾，不是高斯                                              |
| 机制设计 / 拍卖             | 激励兼容                           | 单用户本地 harness，没有多租户竞价场景                                                      |

---

## 6. 边界与重评触发

- **GK**：未做 merge；多实例聚合前必须补。
- **背包**：单维字符预算；多维预算/数千技能前必须换算法。
- **UCB1**：全历史平均；provider 能力突变或需要成本约束时重评。
- **工作流列表调度**：只对全只读工作流生效；单位权重不是真实耗时；写类工作流仍走层屏障。
- 四项都只改**观测/选择/调度**，不改变文件写入、权限、审计的 fail-closed 语义。

## 7. 参考

- M. Greenwald, S. Khanna, _Space-Efficient Online Computation of Quantile Summaries_, SIGMOD 2001.
  <https://dl.acm.org/doi/10.1145/375663.375670>
- D. P. Williamson, D. B. Shmoys, _The Design of Approximation Algorithms_, 2011（背包 DP / 贪心）.
  <https://www.designofapproxalgs.com/>
- P. Auer, N. Cesa-Bianchi, P. Fischer, _Finite-time Analysis of the Multiarmed Bandit Problem_,
  Machine Learning 2002. <https://link.springer.com/article/10.1023/A:1013689704352>
- R. L. Graham, _Bounds on Multiprocessing Timing Anomalies_, SIAM J. Appl. Math. 1969.
  <https://epubs.siam.org/doi/10.1137/0117039>
- H. Topcuoglu, S. Hariri, M.-Y. Wu, _Performance-Effective and Low-Complexity Task Scheduling
  for Heterogeneous Computing_ (HEFT), IEEE TPDS 2002.
  <https://ieeexplore.ieee.org/document/993206>
