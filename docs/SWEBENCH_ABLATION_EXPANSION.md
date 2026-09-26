# best-of-N 对照扩样：20 题 → 60–80 题（第二轮融资批）

> 2026-09-26 启动 · 模型 `deepseek-v4-flash`（temp=0）· 判分=本地执行器（免费）· 唯一自变量 = 候选数
> 前置文档：`docs/SWEBENCH_ABLATION.md`（第一轮 20 题的协议与结论）、`docs/SWEBENCH_PRODUCT_RUN.md`（付费路径的坑与守卫）。

## 0. 为什么扩样（第一轮的统计缺口）

第一轮配对（N4 19/20 vs N1 16/20）方向稳定（3 个不一致对**从不反向**），但精确 McNemar
双侧 p=0.25 —— n=20、只有 3 个不一致对，检验力不足。按观测不一致率（3/20），
**80% 检验力约需 60–80 题**。本文档记录第二轮的采样、闸门与协议；结论跑完后追加在 §5。

## 1. 采样（确定性，脚本 `eval-data/_expansion_sample.mjs`）

- **池**：Verified-500 排除已用 30 题（gold_trusted 21 + docker 阻塞 9）后按仓库配额等距抽取，
  **无随机**：django 40 / sympy 8 / sphinx 6 / pytest 4 / xarray 3 / requests 2 / pylint 3 / seaborn 1
  = **67 题**（名单 `eval-data/expansion_sample_ids.txt`，含 repo+version 明细 `_expansion_sample.json`）。
- **显式排除（诚实边界）**：
  1. astropy/matplotlib/scikit-learn（57 题池）：本地无 C 工具链，gold 必挂，等 Docker 官方镜像通道（另批）。
  2. sympy 1.2–1.9（36 题池）：`pythonVersionResolver` 版本表缺登记，按纪律**不凭猜补登记**，留待实测后扩。
  3. sphinx ≥7.0：env-pins 的 `sphinx: jinja2<3.1` 是**按仓库**的 pin，与 sphinx≥7.0 的 jinja2≥3.1 要求
     冲突（交接文档 §3.2 已知限制的又一实例），采了必挂。
  4. flask（1 题）：版本表未登记，样本量贡献可忽略。
- django 全版本（1.11–5.0）在版本表均有显式登记，无 FALLBACK 风险。

## 2. 协议（两关纪律不变）

```bash
# 第一关（免费，前置闸）：新样本 gold 对照 —— gold 不过的实例不进付费批
node benchmark/capability_swebench.mjs --verified eval-data/swe_bench_verified.json \
  --gold-control --concurrency 3 \
  --instance-list eval-data/expansion_sample_ids.txt \
  --gold-report eval-data/gold_control_expansion67.json \
  --jsonl eval-data/gold_expansion67.jsonl --out eval-data/gold_expansion67.report.json

# 第二关（付费）：gold 通过的实例两臂一起补（配对设计要求两臂同实例，交接文档 §7 边界）
node benchmark/swebench_predict.mjs --model deepseek-v4-flash --best-of-n 4 --self-test \
  --payload-shape tiered --instance-list eval-data/expansion_goldpassed_ids.txt \
  --worktree-root eval-data/prepare_zerocost --out eval-data/preds_expansion_n4.jsonl --resume
node benchmark/swebench_predict.mjs --model deepseek-v4-flash --best-of-n 1 --self-test \
  --payload-shape tiered --instance-list eval-data/expansion_goldpassed_ids.txt \
  --worktree-root eval-data/prepare_zerocost --out eval-data/preds_expansion_n1.jsonl --resume

# 判分（免费）+ 配对比较（老 20 对沿用第一轮产物，不重跑）
node benchmark/capability_swebench.mjs --verified eval-data/swe_bench_verified.json \
  --predictions eval-data/preds_expansion_n4.jsonl --instance-list eval-data/expansion_goldpassed_ids.txt \
  --gold-report eval-data/gold_control_expansion67.json --jsonl eval-data/score_expansion_n4.jsonl \
  --out eval-data/score_expansion_n4.json
# （N1 臂同理）合并两轮后：node eval-data/_ablation_compare.mjs <合并N4> <合并N1>
```

- **成本口径**（第一轮实测）：N4 ≈ 420K token/题、N1 ≈ 171K token/题 ⇒ 50 题×两臂 ≈ **30M token**
  （第一轮全程 ≈ 11.8M）。闸门在付费之前：gold 挂掉的实例一分钱不花。
- **续跑**：predict 产物逐题落盘 + `--resume`；中断重跑不重复计费（同题跳过）。
- ⚠️ 判分 `--instance-list` 只给「已有预测」的实例（PRODUCT_RUN §3 续判陷阱）。

## 3. 状态（随跑更新）

| 阶段                | 状态                                                                            |
| ------------------- | ------------------------------------------------------------------------------- |
| 采样 67 题          | ✅ 完成（`expansion_sample_ids.txt`）                                           |
| gold 对照（免费闸） | 🔄 进行中（`gold_expansion67.log`，concurrency 3；前 18 题通过 17）             |
| django-10097 补跑   | ⏳ 由驱动 `_expansion_driver.sh` 自动执行（新判分代码，§4.5）                   |
| 两臂付费生成        | ⏳ 驱动自动衔接；名单由 `merge-gold` 机械产出（**帽 60** 新对，通过 < 40 熔断） |
| 判分 + McNemar 合并 | ⏳ 排在两臂之后（老 20 对沿用第一轮产物）                                       |

驱动日志：`eval-data/_expansion_driver.log`；两臂日志：`_expansion_n4.log` / `_expansion_n1.log`。

## 4. 与 docker9 批的关系

Docker 官方镜像通道（交接文档 §8）到位后，`docker_env_blocked_ids.txt` 的 9 题走镜像 gold 对照；
若可信，同样**两臂一起补**再进配对（镜像臂与本地臂的判分后端不同，但判据同一条：gold 必须先过）。
本批不等待镜像（拉取受限于镜像源可用性，时间不可控）。

**✅ 首个真机证据（2026-09-26 19:40）**：镜像 `pydata_1776_xarray-6992:v1`（5.69GB）落地后，
DockerExecutor 首次真机 gold 对照**通过**：`pydata__xarray-6992 resolved=true (backend=docker)`
（`eval-data/gold_docker_xarray6992.jsonl`）——可信子集 21 → **22**，§0 表里 xarray-2022.06 的
「部分能」在官方镜像上实际落地为「能」（可选依赖镜像内已备齐）。该题**不在本批 67 采样里**：
判分需 `--docker` 后端且两臂成对补跑，归入 docker9 批（本批的 native 判分会把它标 envError）。

## 4.5 本批途中修掉的判分链路缺陷（django-10097 现场，均有实测）

1. **`spawn ENAMETOOLONG`（Windows argv 上限）**：test_patch 推不出 `.py` 模块时（该题只改
   `tests/validators/*.txt` 数据文件），django 规格旧实现把 F2P+P2P 全部 id 转 directive 兜底
   ⇒ 十万字符级 argv ⇒ `spawn ENAMETOOLONG`。已改为**跑全量套件**（runtests.py 无 label 参数，
   argv 恒有界，官方 harness 的 directive 同样只来自 test_patch，行为对齐）；
   单测：`tests/unit/repoTestSpecs.test.ts`「绝不把 id 灌进 argv」。
2. **spawn 系统错误被记成模型失败**：`原生执行异常: spawn ENAMETOOLONG` 落在通用 catch 里记成
   模型侧失败（同文件 spawn EPERM 事故的同类错分）。已把 `spawn <系统错误>` 归类为
   `envError`（可单独重试、不进 resolved 分母）：`NativeExecutor.classifyExecFailure`。
   本批 67 题里仅 django-10097 中招（采样扫描确认），修复后单独补跑 gold。

## 5. 结果（跑完后追加）
