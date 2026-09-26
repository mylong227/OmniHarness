# SWE-bench 判分链路：Docker / WSL 交接说明

> 2026-09-26 · 交接对象：接手「在 Docker/WSL 里把剩余实例的 gold 对照跑通」的那位
> 原则：**下面每一条都标了它是实测结论还是未实测建议**。实测结论可以直接依赖，未实测建议请自行验证后再写进文档。

## 0. 一句话背景

判分链路（本地 git worktree + uv venv + 真跑测试）在本机（Windows、无 C/C++ 工具链）已能可信判定
**30 题验证子集里的 21 题**；剩下 9 题卡在「环境保真度」，不是判分器缺陷。Docker/WSL 正是解这一层的正确工具。

| 类别             | 题数 | 现状（实测）                                                                                                                   | Docker/WSL 能不能解                                  |
| ---------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 编译型仓库装不上 | 6    | astropy 2 / matplotlib 2 / scikit-learn 2：`-e .` 失败 ⇒ 已正确标 `envError`（不计入分母）                                     | **能**：需 C/C++ 工具链（+ 各仓库的老依赖）          |
| xarray 2022.06   | 1    | `pandas<2` 后 `1 failed + 109 skipped`（需 dask/scipy/bottleneck/numexpr/cftime/pint/flox/sparse；iris/cdms2/cupy 本机不可得） | **部分能**：装齐可选依赖；`cupy`/`iris`/`cdms2` 仍难 |
| sphinx 3.3       | 1    | 残余 3 条是 Windows 平台 xfail（`Not working on windows`）                                                                     | **能**：Linux 镜像上这 3 条是普通 PASSED             |
| pytest 4.5       | 1    | 残余 1 条是数据集里的字面量 `[100%]`（官方解析器的终端换行产物，非测试）                                                       | **不能**：与平台无关，属数据集产物                   |

## 1. 判分链路的两关纪律（**必须先跑这个，再谈分数**）

```bash
# 第一关：官方 gold 补丁必须判 resolved=true，否则该题的判分链路不可信
node benchmark/capability_swebench.mjs --verified eval-data/swe_bench_verified.json \
  --instance-list <ids.txt> --gold-control \
  --gold-report eval-data/gold_control_<name>.json --jsonl eval-data/gold_<name>.jsonl
```

- **`--gold-report` 只被 `judgeValidIds()` / `printJudgeValidity()` 使用，不参与 `resolved` 计算**
  （`benchmark/capability_swebench.mjs` 第 430/449/474 行附近，实测核对过）⇒ 它只能把实例**标注**为
  可信/不可信，**无法把任何判定翻成通过**。这是「不自证循环」的关键，改动这里要非常小心。
- `--gold-control` 会把报告**写进** `--gold-report`（缺省 `<报告名>.gold.json`）——早先它只读不写，
  导致「gold 跑完再复核后续分数」的两步流程根本不可能成立（已修）。

## 2. 当前可信账（可直接复用，别重跑）

- 可信子集 **21 题**：`eval-data/gold_trusted_ids.txt`；合并后的 gold 报告：`eval-data/gold_control_trusted21.json`
  （django 14 + sphinx 2 + sympy 4 + xarray 1）。
- 单品报告：`gold_control_django14.json`、`gold_control_nondjango16.json`、`gold_control_xarray2.json`。
- **产品口径真实出分（付费批次，已完成）**：20 题全部生成并判分，**19/20 resolved (95.0%)**，
  模型失败 1（`sympy__sympy-18698`：F2P 1/1 过但打破 P2P 的 `test_sqf`）、环境失败 0。
  详见 `docs/SWEBENCH_PRODUCT_RUN.md`（协议、成本、逐题、复现命令）。

## 3. 环境层的三个机制（用它们，不要另起一套）

1. **Python 版本表**：`src/eval/pythonVersionResolver.ts`（repo+version → 3.x）。
   ⚠️ 前缀匹配是 `version.startsWith(key)` ⇒ **`5.1` 不以 `5.0` 开头**，次版本必须显式登记，
   否则会静默落到 FALLBACK 3.11（老仓库在 3.11 上直接装不起来）。
2. **env-pins**：`benchmark/swebench-env-pins.json`，**默认启用**（`capability_swebench` 与
   `swebench_predict` 都默认读它；后者曾漏读 ⇒ 「选候选的奖励环境 ≠ 最终判定环境」）。
   收录纪律：**必须写明实测效果与残余缺口**，不许凭猜添加。
   已验证条目：`flask: Werkzeug<3`、`pytest: setuptools<60`、`sphinx: jinja2<3.1`、`xarray: pandas<2`。
   ⚠️ **已知限制**：pin 是**按仓库**的，同一个仓库不同版本若需要相反的 pin 就会冲突
   （xarray 0.12 与 2022.06 现在就共用 `pandas<2`）。若要按版本分化，需要把 key 扩展成 repo+version
   （`NativeEnvBuilder.build()` 目前只收 repo，要一并改签名与单测）。
3. **环境失败语义**：**仓库本体 `-e .` 失败 = `envError`**（不计入 resolved 分母、可单独重试），
   因为它跑在补丁应用**之前** ⇒ 失败必是环境/工具链问题。其余安装步骤保持 best-effort
   （未声明的 extras 本就会报错，不该算环境阻塞）。见 `src/eval/pythonEnvPlan.ts`（首步 `required: true`）。

## 4. 不要重做的坑（本会话已修，都有实测证据）

| 坑                                                            | 结论                                                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 失败无原因 ⇒ 无法诊断                                         | 现每例回 `FAIL_TO_PASS a/b、PASS_TO_PASS c/d` + 短诊断 + 未通过样例；**先看这个再怀疑环境**                                                                       |
| `runPytest` 丢 stderr                                         | pytest 的启动期崩溃几乎全写 stderr ⇒ 曾被读成「零测试」。已合并两路                                                                                               |
| django 结果走 stderr、头部走 stdout                           | 合并后**顺序交错**，只看单路会读成「零结果」；这不是模块 label 的问题                                                                                             |
| django 解析器把「以括号短语结尾的 docstring」当 `展示名 (类)` | 会让**待配对的测试 id 丢失** ⇒ 该 id 恒判假。判据已加「括号内必须是点分标识符路径」                                                                               |
| 通用 `pytest <test_patch 文件>` 对 django 无效                | 已按官方口径走 `./tests/runtests.py --settings=test_sqlite <模块 directive>`（**默认启用**，`OMNI_REPO_TEST_SPECS=0` 可关）                                       |
| 未知旗标被静默忽略                                            | 已加 `FlagGuard`（`src/util/flagGuard.ts` + 单测，进 CI）；**拼错旗标会 exit 2**                                                                                  |
| 连接被中途掐断（undici `terminated`）判不可重试               | 已补进 `RetryingModel.isRetryable` 的消息兜底（含 `socket hang up`/`other side closed`/`premature close`）。**付费批次实测因此白丢过 4 题**                       |
| predict 产物不存 token ⇒ kill 后成本账丢                      | 现每题 token/rounds/duration 随补丁逐题落盘且 `--resume` 读回                                                                                                     |
| SBFL 把 test_patch 留在持久工作区（超时被杀那次）             | **完整性问题**：下次即使不开 `--sbfl`，测试补丁也会被读进 prompt。已把「工作区必须是干净检出」提为实例开始处的不变量（`ensureCheckout` 后立刻 `restoreWorktree`） |

## 5. 实操陷阱（会让你误判）

- **本 harness 里 `2>&1 \|` 会让 job 报 exit 1，即使内层命令退出码是 0**（stderr 以「错误记录」
  形式上浮）⇒ **判断成功看产物与报告，不看 job 退出码**。
- **判分续跑陷阱**：`--instance-list` **只能给「已有预测」的实例**。给全量会把尚未生成补丁的题记成
  「未提供模型预测」并写进 `--jsonl`，之后续判**以为它们已判过**而永久跳过（静默丢分）。
- **`eval-data/` 是 gitignore 目录**：产物与报告不会进 git；要留档的结论必须写进 `docs/`。
- 长跑任务**逐题落盘**（`writeOut()` / `--jsonl`），中断可 `--resume`；但 worker 的**汇总报告只在整批结束时写**。

## 6. Docker/WSL 的具体接法（**未实测，属建议**）

1. **首选官方镜像**：SWE-bench 官方每个实例有预建镜像 `swebench/sweb.eval.x86_64.<instance_id>:latest`
   （其中已装好该版本的全套 conda 依赖）⇒ 环境保真度直接对齐官方，`--gold-control` 应当全绿。
   接法：把 `NativeExecutor` 的「建 venv + 装依赖」这一层换成「在容器内执行测试命令」，
   或先只把**测试执行**搬进容器（`prepareRuntime` / `NativeTestRunner.runCommand` 是最小改动点）。
2. **WSL 里自建**（不依赖官方镜像）：`apt install build-essential python3-dev` + 各仓库老依赖
   （astropy 需 `setuptools<60` 与 `numpy<2`；matplotlib 需 freetype/pkg-config；sklearn 0.20/0.22 需
   `Cython<3` 与老 numpy）。**这些版本约束我未实测**，请自行验证后再写进 `swebench-env-pins.json`
   （并按纪律写清实测效果与残余）。
3. 无论哪条路，**判据不变**：`--gold-control` 上该实例必须 `resolved=true`，才允许把它的分数写进任何结论。

## 7. 我这边的在飞状态（截至交接）

- **付费对照臂（best-of-N vs 单候选）仍在跑**：`eval-data/preds_ablation_n1*.jsonl`（N=1 + self-test）。
  它回答「best-of-N 值不值这个钱」与「自纠环有没有用」——**自纠环已实证有效**（日志出现
  `⚠️ self-test：1 个 FAIL_TO_PASS 未通过：test_Mod` → `✅ self-test 修复后全绿`）。
  配套分析脚本已就绪：`eval-data/_ablation_compare.mjs`（配对 McNemar + 成本对比）。
- 若 Docker/WSL 构建会造成资源争抢（或你不需要这条对照），**可以先把它停掉**——停之前请记住：
  它的 token 账已随补丁逐题落盘，`--resume` 可续。
