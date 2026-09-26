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

**付费对照臂（best-of-N 4 vs 单候选 1，同一批 20 题）——已基本跑完，正在补缺失点。**

- **目的**：回答两个至今无数据的问题——① best-of-N 的增益（N4 vs N1 配对）；② `--self-test` 自纠环的增益。
- **已拿到的实证（重要）**：
  - N=4 臂 20 题的最佳奖励**全为 1** ⇒ 自纠环**一次未触发**（best-of-4 里总有候选全绿）。
  - N=1 臂则**频繁触发并修得回来**：日志反复出现
    `⚠️ self-test：1 个 FAIL_TO_PASS 未通过：test_Mod` /
    `…：2 个 FAIL_TO_PASS 未通过：test_re_path_with_optional_parameter …`
    → `✅ self-test 修复后 FAIL_TO_PASS 全绿`。⇒ **自纠环不是摆设，但它的价值只在「单候选修不动」时才兑现**。
- **成本实测**：N=4 臂 ≈ **421K token/题**；N=1 臂 ≈ **81K token/题**
  （django 14 题实测 604,527 in / 525,140 out）⇒ 配对判分后才知道那 4 倍候选买到了什么。
- **需要修掉的缺失点（不是「没修好」，是网络中断）**：N=1 臂有 3 题被 undici `terminated` 掐断
  （`django__django-11477 / 13128 / 13512`）⇒ 已在**带重试修复**的代码上重跑；
  `django__django-12419` 是**真实的「未抽出 diff」**，按口径保留、**不重掷**。
  `sympy__sympy-18698`（本批最慢，单题 >70 分钟）仍在自纠环里跑。
- **收尾脚本已就绪**：`eval-data/_ablation_compare.mjs`（配对 McNemar + 两臂 token 成本对比）。

⚠️ **给接手方的边界**：这条对照臂**只在当时已可信的 20 题**上跑（`gold_trusted_ids.txt` 现为 21 题）。
**不要只给一臂加题**——配对设计要求两臂同实例；若要纳入新可信实例，两臂一起补。

## 8. 接手方进展（2026-09-26 下午）：DockerExecutor 已落地，卡在镜像获取

**① 官方镜像执行器已实现并过门禁（实测）**：`src/eval/dockerExecutor.ts`（`DockerExecutor`，
实现 `ExecutorPort`，backend=`docker`）+ `benchmark/capability_swebench.mjs --docker` 旗标接线
（`--docker-cli` / `--docker-mirrors` / `--docker-timeout` 可覆盖；FlagGuard 自扫描源码，新旗标自动入白名单）。
五道门禁（typecheck/lint/check --strict/audit:maturity/audit:standard:delta）全绿。
语义与 harness 2.1.8（预建镜像同代）逐条对齐：镜像名 `__`→`_1776_`、env 名 `testbed`、
test_cmd=`pytest --no-header -rA --tb=no -p no:cacheprovider`（六个 pytest 类仓库逐仓核实自 2.1.8 constants）、
模型补丁 `git apply` 失败回退 `patch --fuzz=5`、test 文件 reset 用 test_patch 全量文件、directives 过滤测试样貌文件。
脚本经 **stdin** 送 `docker run -i … bash -s`（零挂载零 docker cp）；解析复用 `PytestVerdict`（fail-closed 不变）。
⚠️ 交接附注：15:38 提交进仓的版本用 `execFile(..., {input})`——**该选项在 execFile 上不存在，tsc 不过**；
接手后已改 `spawn` 手写 stdin（现工作区版本，未提交），顺带绕开 Windows 命令行长度上限。

**② 镜像获取的实测记录（截至 17:40，均有证据）**：

| 源                                | 状态                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Hub 直连                   | **不可用**：`registry-1.docker.io` DNS 污染（解析到 Dropbox 段）；本机无任何代理（12 个常见端口 + 全部监听进程 + 网关端口均查过）                                                                                         |
| docker.m.daocloud.io              | alpine 等**白名单内**秒拉；`swebench/*` **不在白名单**直接拒（错误信息指向其 GitHub issue 申请流程）                                                                                                                      |
| hub.rat.dev → docker.1ms.run      | 14:00 前后**可用**（真实下载过 astropy-12907 多层）；17:00 起 blob 挂死（manifest 秒回、层数据零传输）。302 追踪实测：hub.rat.dev 把 blob 重定向到 1ms.run，`astropy-12907` 有一层（`2f183d…`）在 1ms.run 上 **404 缺失** |
| docker.xuanyuan.me                | 免费节点持续「繁忙」403（官方提示付费专业版）                                                                                                                                                                             |
| 学术镜像（iscas/nju/baidubce 等） | 404/403/不可达                                                                                                                                                                                                            |

- ⚠️ **`:latest` 陷阱**：不带标签拉取时 docker 默认 `:latest`，hub.rat.dev 对该引用 **manifest 解析直接挂死**；
  必须显式 `:v1`。
- 重试循环脚本：`/d/deepseek/.tmp/pull_loop.sh`（后台长跑，8 分钟一轮，三源轮换，最长 4 小时）；
  镜像落盘后 `docker tag` 回官方名，DockerExecutor 只认官方名。

**③ 镜像到位后的两条命令（零成本，判据不变）**：

```bash
export OMNI_DOCKER_CLI="D:\Docker\Desktop\resources\bin\docker.exe"
# 第一关：gold 对照（9 题：astropy 2 / matplotlib 2 / sklearn 2 / xarray-6992 / sphinx-8120 / pytest-5262）
node benchmark/capability_swebench.mjs --verified eval-data/swe_bench_verified.json \
  --docker --docker-mirrors "hub.rat.dev,docker.1ms.run" \
  --instance-list eval-data/docker_env_blocked_ids.txt --gold-control \
  --gold-report eval-data/gold_control_docker9.json --jsonl eval-data/gold_docker9.jsonl
# 第二关：模型补丁判分（preds_verified30.jsonl 里 9 题补丁已齐，判分免费）
node benchmark/capability_swebench.mjs --verified eval-data/swe_bench_verified.json \
  --docker --docker-mirrors "hub.rat.dev,docker.1ms.run" \
  --predictions eval-data/preds_verified30.jsonl \
  --instance-list eval-data/docker_env_blocked_ids.txt \
  --gold-report eval-data/gold_control_docker9.json \
  --jsonl eval-data/score_docker9.jsonl --out eval-data/score_docker9.json
```

预期（按 §0 表）：astropy/matplotlib/sklearn/sphinx 的 gold 应全绿（进入可信子集）；
xarray-6992 取决于镜像内可选依赖（cupy/iris/cdms2 难装，可能仍判不过）；pytest-5262 的 `[100%]`
数据集产物 id **永远**对不上（本机无 TTY 换行，官方镜像无 TTY 同样不产生）。
判分纪律不变：**gold 没过的实例，其模型分不进任何结论**。
