# SWE-bench「产品口径」真实出分：best-of-N 4 + self-test（DeepSeek v4-flash）

> 2026-09-26 · 模型 `deepseek-v4-flash`（temp=0，`https://api.deepseek.com`）· 原生执行器（git worktree + uv venv + 真跑测试）
> 本文是**付费那一批**的留档：生成补丁要花钱（模型调用），判分不花钱（本地 git+uv+pytest）。

## 一句话结论

在 **gold 对照可信的 20 题子集**（django 14 + sphinx 2 + sympy 4）上，产品口径
（`--best-of-n 4 --self-test` + 梯度投送，`deepseek-v4-flash`，temp=0）**20 题全部生成、全部判分**：
**`resolved = 19/20 = 95.0%`**，模型失败 1、环境失败 0，判分侧打印
`✅ 判分可信度：本次 20 个实例全部通过 gold 对照` ⇒ **这批通过不是判分链路幻觉**。
唯一失败是**真实的模型回归**（`sympy-18698`：F2P 1/1 过，却打破 P2P 的 `test_sqf`），不是环境或口径问题。
成本：**≈7.6M token 实测**（18 题有记录）+ 2 题因中途 kill 丢了 token 记录 ⇒ 估 **≈8.4M**；判分 0 成本（本地）。
口径提示：**这是子集口径（20/500），不是官方满分口径**，且集中在三个判分链路已被 gold 背书的仓库，**不可与官方榜直接比较**。

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

**已实测到 token 的部分（18 题有记录，2 题因中途 kill 丢失，见下）**：

| 来源                                                               | 题数 | token in  | token out | 小计          |
| ------------------------------------------------------------------ | ---- | --------- | --------- | ------------- |
| 首批 pilot 3 题（django-11133 / sphinx-9320 / sympy-13480）        | 3    | 617,854   | 619,995   | 1,237,849     |
| Worker A（django 11 题：12419…17087）                              | 11   | 2,226,195 | 2,189,514 | 4,415,709     |
| Worker B（sphinx-10449 / sympy-15599 / sympy-18698 / sympy-21847） | 4    | 872,340   | 1,045,769 | 1,918,109     |
| **合计（18 题）**                                                  | 18   | 3,716,389 | 3,855,278 | **7,571,667** |

⇒ **≈420,648 token/题**（18 题实测均值）。判分成本 = **0**（本地执行器；付费只在生成侧）。

⚠️ **两项缺口（诚实标注）**

1. **2 题的 token 记录已丢**：早期串行 worker 被 kill 时，11477 / 11951 两题的补丁已落盘，但 token 只在
   整批结束时才写进 *.report.json ⇒ 记录丢失。按均值补估 ⇒ **20 题总量 ≈ 8.4M token**。
   （这正是「预测产物只存 instance_id + model_patch、不存 token」的代价；要拿完整成本须让 worker 自然退出。）
2. 首题含**环境构建**（uv venv + 装依赖），故单题 token 略高于稳态。

**关于 --self-test 自纠环：本批 20 题的最佳奖励全部为 1**（即 4 个候选里至少有一个把 F2P 全跑绿）
⇒ 按设计自纠环**一次都没触发**（它只在 estReward < 1 时启动）。这不是失效，而是**该协议的 best-of-4 已足够**：
绿样本数逐题落在 1–4 之间（sympy-18698 只有 1 个绿样本，其余 3 个候选没修好）。
⇒ **本批的成绩来自 best-of-4 的候选选择；自纠环的增益本批无数据**（要测它需更难的任务集或 N 更小的对照臂）。

## 3. 结果

### 3.1 全部 20 题判分结果

| 实例                     | resolved | 仓库              | 备注                                                                                                                     |
| ------------------------ | -------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| django__django-11133     | ✅       | django/django     |                                                                                                                          |
| django__django-11477     | ✅       | django/django     |                                                                                                                          |
| django__django-11951     | ✅       | django/django     |                                                                                                                          |
| django__django-12419     | ✅       | django/django     |                                                                                                                          |
| django__django-13128     | ✅       | django/django     |                                                                                                                          |
| django__django-13512     | ✅       | django/django     |                                                                                                                          |
| django__django-13837     | ✅       | django/django     |                                                                                                                          |
| django__django-14349     | ✅       | django/django     |                                                                                                                          |
| django__django-14752     | ✅       | django/django     |                                                                                                                          |
| django__django-15268     | ✅       | django/django     |                                                                                                                          |
| django__django-15572     | ✅       | django/django     |                                                                                                                          |
| django__django-16100     | ✅       | django/django     |                                                                                                                          |
| django__django-16569     | ✅       | django/django     |                                                                                                                          |
| django__django-17087     | ✅       | django/django     |                                                                                                                          |
| sphinx-doc__sphinx-10449 | ✅       | sphinx-doc/sphinx |                                                                                                                          |
| sphinx-doc__sphinx-9320  | ✅       | sphinx-doc/sphinx |                                                                                                                          |
| sympy__sympy-13480       | ✅       | sympy/sympy       |                                                                                                                          |
| sympy__sympy-15599       | ✅       | sympy/sympy       |                                                                                                                          |
| sympy__sympy-21847       | ✅       | sympy/sympy       |                                                                                                                          |
| sympy__sympy-18698       | ❌       | sympy/sympy       | **真实模型失败（非环境/口径）**：`FAIL_TO_PASS 1/1` 通过，但 `PASS_TO_PASS 146/147`——补丁**打破了此前通过**的 `test_sqf` |

**汇总（全部 20 题）**：`resolved = 19/20 (95.0%)`，`模型失败 = 1`，`环境失败 = 0`，
判分侧打印 `✅ 判分可信度：本次 20 个实例全部通过 gold 对照`（⇒ 连那条 ❌ 所属仓库也在可信之列，故这个 95% 可解读）。

**这条 ❌ 值得单独说明**：它正是本会话新增「失败必带原因」的价值体现——报告直接给出
`FAIL_TO_PASS 1/1、PASS_TO_PASS 146/147；未通过样例: test_sqf`，一眼可判：
**模型确实修好了目标测试，但回归打坏了另一个**（`test_sqf` 与 `test_factor_terms` 都在 `sympy/polys` 一带）。
既不是环境缺依赖（那会 F2P 也全挂），也不是解析口径问题（那会「零收集」或 id 对不上）。
若没有原因字段，这条会被读成「sympy 不行」，而真相是「补丁过宽，需收窄」。

⚠️ **口径提示**：这是**子集口径（20/500）**，且集中在**判分链路已被 gold 背书**的三个仓库
（django 14 / sphinx 2 / sympy 4）⇒ **不可与官方满分榜直接比较**，也不代表模型在 500 题上的水平。
可解读的部分是：**在这个子集、这套协议下，模型 20 题过了 19 题，且这个数字的判分链路已被 gold 对照背书。**

**与历史数字的关系**：§21.6 早先记的「resolved 1/30（3.3%）」**已被判定为不可解读**（gold 只有 4/30 能过，
那些「模型失败」不含能力信息）。本批把可信度问题修好、把不可信实例排除后重跑，得到 19/20——
两者**不可直接对比**，因为口径、可信度与协议都变了（旧数字是单候选 + 坏判分链路）。

### 3.2 批次状态：**已完成**（20/20 生成 + 20/20 判分）

判分产物按 `--jsonl` **逐题落盘**（`eval-data/score_product.jsonl`），可随时断点续判。

**复现本批的完整两条命令**（先合并两个 worker 的产物，再判分）：

```bash
node eval-data/_merge_preds.mjs eval-data/preds_product_bestof4_all.jsonl \
  eval-data/preds_product_bestof4.jsonl eval-data/preds_product_bestof4_b.jsonl
node benchmark/capability_swebench.mjs --verified eval-data/swe_bench_verified.json \
  --predictions eval-data/preds_product_bestof4_all.jsonl --instance-list eval-data/gold_trusted_ids.txt \
  --gold-report eval-data/gold_control_trusted20.json --jsonl eval-data/score_product.jsonl \
  --out eval-data/score_product_bestof4.json
```

⚠️ **续判陷阱（本次踩过并留档）**：`--instance-list` 只能给「**已有预测**」的实例。若把 20 题全给，
尚未生成补丁的题会被记为「未提供模型预测」并写进 jsonl，之后续判会**以为它们已判过**而永久跳过
（静默丢分）。本次因此每次都用「有预测的 id 列表」而非全量列表。

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
   ✅ **本批实测答案：20 题的最佳奖励全部为 1 ⇒ 自纠环一次都没触发**（两份 worker 日志的
   `[best-of-N]` 行逐条可查；绿样本数 1–4，故它是「有候选修好了」而非「没跑」）。
   因此**本批成绩来自 best-of-4 的候选选择，自纠环的增益本批无数据**——要测它需更难的任务集、
   或对比 `--best-of-n 1 --self-test` 臂。
   另：本批运行的是**修正前的一版**（全红时 `RlvrLoop.best` 为 undefined ⇒ 不会进自纠环）；该空档已在
   本批跑动期间修掉（改用首候选 `c0` 作种子并显式打日志），但**本批产物出自修正前那一版**（本批全红也没出现，
   故实际未受影响）。
   `RlvrLoop` 的契约已核对（`src/evolution/rlvrLoop.ts`：`reward(candidate)` 收到的是 sampler 返回的
   同一个对象、`best = { candidate, reward }`），故按 `candidate.id` 反查「原始输出 + 未通过清单」是成立的。
4. 本文档的数字全部来自本机实测产物（`eval-data/` 为 gitignore 目录，故正文留档在 `docs/`）。
