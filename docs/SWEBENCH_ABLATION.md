# 付费对照实验：best-of-N 4 vs 单候选（同批 20 题，逐题配对）

> 2026-09-26 · 模型 `deepseek-v4-flash`（temp=0）· 判分=本地执行器（免费）· 唯一自变量 = **候选数**
> 目的：回答两个此前**完全没有数据**的问题——① best-of-N 值不值这个钱？② `--self-test` 自纠环有没有用？

## 0. 结论先行

| 臂     | 协议                        | resolved           | token 成本                         | 平均      |
| ------ | --------------------------- | ------------------ | ---------------------------------- | --------- |
| **N4** | `--best-of-n 4 --self-test` | **19/20（95.0%）** | ≈ 8.4M（20 题；2 题记录丢失见 §3） | ≈ 420K/题 |
| **N1** | `--best-of-n 1 --self-test` | **16/20（80.0%）** | ≈ 3.4M                             | ≈ 171K/题 |

- **配对结果**：不一致对 **N4 独过 3 / N1 独过 0**（方向一致，从未反向），差 **+3 题（+15pp）**；
  精确 McNemar **双侧 p=0.25、单侧 p=0.125 ⇒ 不显著**（只有 3 个不一致对，n=20 检验力不足）。
- **成本**：N4 ≈ **2.45×** 的 token 成本换 +15pp（同方向）。
- ⇒ **可辩护的表述**：best-of-4 的提升**方向稳定且从不反向**，但在 20 题上**未达统计显著**；
  要判定它是否值这个钱，需要把样本扩到不一致对足够多（按观测 3/20 的不一致率，80% 检验力约需
  **60-80 题**，即再花一轮同量级的钱）。
- **`--self-test` 自纠环**：在 N1 臂**频繁触发且确实修得回来**（见 §4）；在 N4 臂**一次都没触发**
  （best-of-4 里总有候选全绿）。⇒ 它不是摆设，但**它的价值只在「单候选修不动」时才兑现**——
  换句话说 **best-of-N 与 self-test 是替代关系而非叠加关系**，这解释了为什么 N4 的增益没有想象中大。

## 1. 三处失败差异（逐题看，N4 独过的 3 题）

| 实例                   | N1 的失败原因（判分侧原话）                                                            | N4  |
| ---------------------- | -------------------------------------------------------------------------------------- | --- |
| `django__django-11477` | 测试未通过（**FAIL_TO_PASS 1/3**、PASS_TO_PASS 150/151）—— 单候选只修好了 1 个目标测试 | ✅  |
| `django__django-12419` | 未抽出 diff（**空补丁**）—— 模型那次没给出可用补丁                                     | ✅  |
| `sympy__sympy-13480`   | **model_patch 应用失败**（补丁无法应用，视为未修复）                                   | ✅  |

三类恰好覆盖「单候选的三种典型损失」：**修不全 / 没给出 / 给出了但打不上**。
best-of-4 用 4 次独立采样把它们各自兜住了 —— 这正是它买到的东西。

## 2. 判分可信度（不可跳过的前置）

两臂都只在 **gold 对照可信的 20 题**上跑（`eval-data/gold_trusted_ids.txt` 当时为 20 题），
判分时带 `--gold-report eval-data/gold_control_trusted21.json`，两臂报告均打印
`✅ 判分可信度：本次 20 个实例全部通过 gold 对照`。⇒ 这里的 19/20 与 16/20 都**可解读**。

## 3. 成本口径（含两处诚实缺口）

| 臂  | 组成                                                                                                    | token                      |
| --- | ------------------------------------------------------------------------------------------------------- | -------------------------- |
| N4  | pilot 3 题 1,237,849 + worker A 11 题 4,415,709 + worker B 4 题 1,918,109                               | **7,571,667（18 题实测）** |
| N1  | worker B1 14 题 1,129,667 + worker B2 首轮 6 题 790,621 + `sympy-18698` 重跑 835,200 + 3 题重跑 671,552 | **≈ 3,427,040**            |

- **缺口 1（N4）**：另 2 题（`11477`/`11951`）的 token 记录因早期 worker 被 kill 丢失（补丁没丢）
  ⇒ 按均值补估 N4 20 题 ≈ **8.4M**。该缺口已修（现在 token 随补丁逐题落盘），
  见 `benchmark/swebench_predict.mjs` 的 `tokensById`。
- **缺口 2（N1）**：上表含**重跑**的 token（3 题因 undici `terminated` 网络中断重跑 + 1 题 `sympy-18698` 重跑），
  故 N1 的**有效**成本略低于 3.43M；重跑本身是对的做法——**网络中断不是「模型没修好」的数据点**。

## 4. `--self-test` 自纠环的实证（本会话首次拿到）

- **N4 臂（20 题）**：`[best-of-N]` 日志的最佳奖励**全为 1** ⇒ 自纠环**一次未触发**。
- **N1 臂**：频繁触发，且**确实修回**。原始日志（逐字）：
  - `⚠️ self-test：1 个 FAIL_TO_PASS 未通过：test_Mod` → `✅ self-test 修复后 FAIL_TO_PASS 全绿`
  - `⚠️ self-test：2 个 FAIL_TO_PASS 未通过：test_re_path_with_optional_parameter (urlpatterns.tests.SimplifiedURLTests), test_two_variable_at_start_of_path_pattern (…)`
  - `⚠️ 补丁不可应用：error: patch failed: sympy/functions/elementary/hyperbolic.py:586`（apply-修复环也在工作）
- ⇒ **自纠环有效，但它与 best-of-N 争夺同一批「失败样本」**：候选越多，需要自纠的越少。

## 5. 诚实边界

1. **n=20、只有 3 个不一致对** ⇒ 方向可信、显著性不足。任何「best-of-N 提升 X%」的说法都必须带这个限定。
2. **`sympy__sympy-18698` 的 N1 verdict 是「被中断的病态慢运行」**：它的 N1 补丁令
   `pytest sympy/polys/tests/test_polytools.py` 持续计算 >15 分钟（CPU 稳步增长、非死锁），
   人工中断后判为未通过。**这与 N4 的 false 同向**（N4 是真实回归：F2P 1/1 但打破 P2P `test_sqf`），
   故它属**一致对**、不影响上面的不一致对计数；但严格说它的 N1 verdict 不是「跑完的失败」。
3. **3 题重跑**（`11477`/`13128`/`13512`）是因 undici `terminated` 网络中断，属缺失点而非模型结果；
   `django__django-12419` 的**空补丁保留不重掷**（那是真实的模型输出失败，重掷会变成"跑到过为止"）。
4. **判分链路无超时保护（本轮新发现的真缺陷，已修）**：`execFile` 的两个调用点原先都没有 `timeout`
   ⇒ 一个病态慢的补丁能让判分**无限期挂住**（本轮实测被 `sympy-18698` 卡住十多分钟）。
   现默认 **30 分钟**上限（`OMNI_EVAL_TEST_TIMEOUT_MS` 可覆盖，`0` 关闭），被强杀时诊断优先报
   「测试执行超时」而不是误导性的「无输出/零收集」。

## 6. 复现

```bash
# N4 臂（已完成，产物已合并）
node eval-data/_merge_preds.mjs eval-data/preds_product_bestof4_all.jsonl \
  eval-data/preds_product_bestof4.jsonl eval-data/preds_product_bestof4_b.jsonl
# N1 臂
node eval-data/_merge_preds.mjs eval-data/preds_ablation_n1_all.jsonl \
  eval-data/preds_ablation_n1.jsonl eval-data/preds_ablation_n1_fix.jsonl eval-data/preds_ablation_n1_b.jsonl
# 判分（免费）+ 配对比较
node benchmark/capability_swebench.mjs --verified eval-data/swe_bench_verified.json \
  --predictions eval-data/preds_ablation_n1_all.jsonl --instance-list eval-data/ablation_n1_ids.txt \
  --gold-report eval-data/gold_control_trusted21.json --jsonl eval-data/score_ablation_n1.jsonl \
  --out eval-data/score_ablation_n1.json
node eval-data/_ablation_compare.mjs eval-data/score_product.jsonl eval-data/score_ablation_n1.jsonl
```
