# SWE-bench「产品口径」真实出分：best-of-N 4 + self-test（DeepSeek v4-flash）

> 2026-09-26 · 模型 `deepseek-v4-flash`（temp=0，`https://api.deepseek.com`）· 原生执行器（git worktree + uv venv + 真跑测试）
> 本文是**付费那一批**的留档：生成补丁要花钱（模型调用），判分不花钱（本地 git+uv+pytest）。

## 一句话结论

<!-- 待填：跑完后写 20 题汇总（resolved / 有效分母 / 成本）+ 一句口径提示 -->

## 1. 协议（逐字可复现）

```bash
# 生成（付费：模型调用）——产品口径 = 4 候选 best-of-N + 测试驱动自纠环，tiered 投送
node benchmark/swebench_predict.mjs \
  --model deepseek-v4-flash \
  --best-of-n 4 --self-test \
  --payload-shape tiered \
  --instance-list eval-data/gold_trusted_ids.txt \
  --worktree-root eval-data/prepare_zerocost \
  --out eval-data/preds_product_bestof4.jsonl --resume

# 判分（免费：本地执行器）——带 gold 对照报告，报告会自证可信度
node benchmark/capability_swebench.mjs \
  --verified eval-data/swe_bench_verified.json \
  --predictions eval-data/preds_product_bestof4.jsonl \
  --instance-list eval-data/gold_trusted_ids.txt \
  --gold-report eval-data/gold_control_trusted20.json \
  --out eval-data/score_product_bestof4.json
```

**为什么只跑 20 题（口径纪律，不是为了省钱）**：`--gold-report` 的可信度闸只认可**官方 gold 补丁被判
resolved** 的实例；Verified-30 里只有 20 题满足（django 14 + sphinx 2 + sympy 4）。其余 10 题：

| 类别                        | 题数 | 现状                                                                 | 为什么不引用其分数                      |
| --------------------------- | ---- | -------------------------------------------------------------------- | --------------------------------------- |
| 环境阻塞（无 C/C++ 工具链） | 6    | astropy 2 / matplotlib 2 / scikit-learn 2，判分侧已正确标 `envError` | 仓库本体装不进 venv，根本没进能力判定   |
| 平台差异（Windows）         | 1    | sphinx-8120：残余 3 条为 `xfail("Not working on windows")`           | 官方镜像为 Linux，那边是普通 PASSED     |
| 数据集产物 id               | 1    | pytest-5262：P2P 含官方解析器的换行产物 `[100%]`                     | 该 id 不是测试，本机无 TTY 换行不会产生 |
| 待补可选测试依赖            | 2    | xarray 两题（F2P 已全过，P2P 缺口来自可选依赖）                      | 尚未按 env-pins 纪律实测                |

⇒ **判分可信度以 gold 对照为准**（看板 §21.20/§21.21），不可信实例一律不进入分数。

**大 batch 的并行做法（本次实际使用；⚠️ 实测**未**证实能提速）**：该脚本**没有并发锁**，但每题跑完会
**整文件重写** `--out`（`patchById.set(...) + writeOut()`）⇒ 两个 worker **必须用不同的 `--out`**，否则互相清空。
本次按仓库把剩余题拆成两个不相交列表（A：django 11 题；B：sphinx 1 + sympy 3），跑完再合并去重：

```bash
node eval-data/_merge_preds.mjs eval-data/preds_product_bestof4_all.jsonl \
  eval-data/preds_product_bestof4.jsonl eval-data/preds_product_bestof4_b.jsonl
```

⚠️ **诚实更正（两次）**：我起初写「墙钟约减半」，**实测不支持**；随后又想归因为「并发把带宽切成两半」，
**同样被数据否掉**。两个数据点：两 worker 并行时，A 的 django-12419 与 B 的 sphinx-10449 都是
10:03:52 起、10:28 前完成（**≈25 min**），但 A 的下一题 django-13128 只用了 **≈10 min**（10:28→10:38）；
而**串行**时同批 django 是 6.6~16 min、sphinx 12 min。
⇒ 正确结论是：**单题耗时被「该题的生成量/修复轮数」主导，方差极大，样本不足以下任何并行加速或减速的结论**。
可确定的只有两件事：① 端点当时健康（1-token 探测 707ms）；② 进程常年 ~1% CPU ⇒ **瓶颈在模型侧生成**，
不在本机。给后续批次的操作建议：**串行更简单也可控**（不需要拆列表/分文件/合并），除非有证据表明
账号允许真并发（本次没测出来）。

**信任闸不自证循环（代码级证据）**：`--gold-report` 只被 `judgeValidIds()` 读入、只被
`printJudgeValidity()` 使用（`benchmark/capability_swebench.mjs` 第 430/449/474 行附近），
**不参与 `resolved` 的计算**——判定只来自 `NativeExecutor` 的真 pytest 结果。
即：gold 报告只能把实例**标注**为可信/不可信，**无法把任何一次判定翻成通过**。

## 2. 成本（实测，不是估算）

| 指标  | 实测（首批 3 题）                                        | 20 题外推   |
| ----- | -------------------------------------------------------- | ----------- |
| token | **412,616 / 题**（206K in + 207K out）                   | **≈ 8.25M** |
| 时延  | **865s / 题**（django 395s / sphinx 741s / sympy 1458s） | ≈ 4.8 小时  |
| 判分  | 0（本地）                                                | 0（本地）   |

<!-- 待填：跑完后的实测总量与逐题 token（取 eval-data/preds_product_bestof4.jsonl.report.json） -->

## 3. 结果

<!-- 待填：逐题表（resolved / reason / 用时 / token）+ 汇总行 -->

## 4. 跑之前修掉的付费路径缺陷（否则这一次的钱会白花）

见看板 §21.23，三条都在**最花钱**的那条路上：

1. `--best-of-n 4 --self-test` 组合下 **`--self-test` 静默失效**（best-of-N 分支直接 return）
   ⇒ 跑的根本不是文档定义的「产品口径」。已抽出 `selfTestRepair()` 两条路径共用。
2. best-of-N 路径的 **token 完全未统计**（报告恒为 `0/0`）⇒ 成本无从核算。
3. predict 侧环境与判分侧**不同源**（`pins=0` vs `pins=3`）⇒ 奖励环境与判定环境不一致；
   奖励环境若测试集体崩溃，所有候选 reward=0，best-of-N 会**静默退化成只看第一个候选**。

另有一个操作事故与守卫：未知旗标（如驼峰写法）曾被 `arg()` 静默忽略 ⇒ 已加
`FlagGuard`（`src/util/flagGuard.ts` + `tests/unit/flagGuard.test.ts`），两个 benchmark 脚本启动即 fail-closed。

## 5. 诚实边界

1. **子集口径**：20 题（非官方 500 满分口径），且集中在判分链路已被 gold 背书的三个仓库。
   报告里 `total` 就是子集大小，**不可与官方满分榜直接比较**。
2. **判分能力边界**：本机无 Docker 预建镜像、无 C/C++ 工具链 ⇒ 编译型仓库（astropy/matplotlib/
   scikit-learn）无法判定，已标 `envError` 并排除在分母外。
3. **self-test 自纠环的触发条件**：只有「选中的候选没有全绿」（`bestReward < 1`）时才会跑。
   本批运行的是**修正前的一版**：全红（4 个候选 reward 都为 0 ⇒ `RlvrLoop` 的 `best` 为 undefined）
   时**不会**进入自纠环。该空档已在本批跑动期间修掉（改用首候选 `c0` 作种子，并在日志里显式标注
   「全红 ⇒ 自纠环以首候选为种子」），但**本批产物出自修正前的那版**，故本批是否触发过自纠环以日志为准。
   <!-- 待填：本批是否出现 bestReward<1（grep 两份日志的 [best-of-N] 行） -->
   另：`RlvrLoop` 的契约已核对（`src/evolution/rlvrLoop.ts`：`reward(candidate)` 收到的是 sampler 返回的
   同一个对象、`best = { candidate, reward }`），故按 `candidate.id` 反查「原始输出 + 未通过清单」是成立的。
4. 本文档的数字全部来自本机实测产物（`eval-data/` 为 gitignore 目录，故正文留档在 `docs/`）。
