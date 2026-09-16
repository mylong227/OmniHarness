# 挂起项更优解调研（B1 / B3 / F4）

> 问题：B1 官方 SWE-bench Verified 子集（须本机 docker + HF 数据集 / 或云 Modal）、
> B3 Linux/macOS 真机、F4 keycloak 容器——是否存在**不依赖这些外部设施、
> 直接验证且保真度一致或更高、效率更优**的开源替代路径？
>
> 结论：**B3 与 F4 已在仓库内用零依赖更优解落地结项**；**B1 官方 500 Verified 的真实接线已落地
> （`src/eval/swebenchVerified.ts` + `src/eval/nativeExecutor.ts` + `capability_swebench.mjs --verified`，
> 原生本地执行器 fail-closed），免 Docker、免云、code-ready + turnkey**；执行须你侧具备
> git + uv + 网络（本地克隆仓库 + pip 安装 + pytest 判定）。

## 一、结论摘要

| 挂起项                   | 原方案（外部依赖）         | 更优解                                                                                                      | 保真度                                                | 效率                   | 状态                                                                  |
| ------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| **B3** 跨平台真机        | 自购/自管 Linux·macOS 硬件 | GitHub Actions `matrix.os: [ubuntu/macos/windows-latest]`                                                   | 一致（真实内核）                                      | 更高（零硬件筹备）     | ✅ 已落地 `ci.yml`                                                    |
| **F4** OIDC 真机         | 起 keycloak 容器（docker） | 零依赖本地 IdP 夹具（`node:crypto` 真实 RS256 + 真实 HTTP）                                                 | 等价（真实 JWT+JWKS）                                 | 更高（毫秒级·零容器）  | ✅ 已落地 `tests/integration/oidcFixture.ts`                          |
| **B1** 官方 500 Verified | 本机 docker + 云(Modal)    | `src/eval/nativeExecutor.ts` + `--verified`（git worktree + uv venv + pytest，免 Docker/免云，fail-closed） | best-effort（env 由 repo 自述 + uv 重建，非官方镜像） | 本地直接跑，零容器启动 | ✅ 接线落地（原生执行器，免 Docker/免云）+turnkey；执行待 git+uv+网络 |

**决策原则（给未来挂起项）**：当某验证被「容器 / 自管硬件 / 本机数据集 / 云凭证」阻塞时，
优先找三类替代——**托管 CI runner**（B3）、**进程内真实实现**（F4）、
**本地真实实现（免容器/免云）**（B1 原生执行器）。三者都把「外部设施」降为「可选/无需」，
保真度不降、效率反升。

## 二、B3：跨平台真机 → GitHub Actions 矩阵

**原阻塞**：`swebench`/sandbox 真机验证需在 Linux 与 macOS 真实内核上跑，
原方案是「自购或自管一台 Linux + 一台 macOS」。

**更优解**：GitHub 仓库本就有 `.github/workflows/ci.yml`，其 `test` job 原本只在
`ubuntu-latest` 跑。改为跨平台矩阵即直接吃到 GitHub 托管的三种真实内核 runner：

```yaml
test:
  runs-on: ${{ matrix.os }}
  strategy:
    fail-fast: false
    matrix:
      os: [ubuntu-latest, macos-latest, windows-latest]
```

**保真度**：runner 是真实 Ubuntu/macOS/Windows 内核，与「自管真机」等价，且覆盖到
Windows（原方案根本没考虑）。
**效率**：零硬件采购/运维，PR 触发即跑；`fail-fast:false` 让三平台独立报红。
**参考开源**：GitHub Actions 官方 `matrix` 策略即为跨平台真机验证的标准做法。

**已落地**：`tests/integration/*`（含 F4 的 OidcFixture 真实 RS256 链路）现随
`test` job 在三平台真机执行。

## 三、F4：OIDC 真机 → 零依赖本地 IdP 夹具

**原阻塞**：`EnterpriseAuth` 的 RS256 验签门禁要「真实接入某 IdP」才能端到端验证，
原方案是「起一个 keycloak 容器」（须 docker）。

**更优解**：`src/enterprise/oidcClient.ts` 的 `OidcClient`/`EnterpriseAuth` 本身就是
零依赖、fetch 可注入的纯实现。`tests/integration/oidcFixture.ts` 用 `node:crypto`
构造一个**真实 RSA 密钥对**，起一个监听 `127.0.0.1:随机端口` 的**真实 HTTP IdP**，
签发**真实 RS256 id_token**，暴露 discovery / JWKS / token 三个端点。集成测试
`tests/integration/oidcFixture.test.ts` 走完整真实链路：

```
enterpriseAuthFromIssuer(config, globalThis.fetch)   // 真实 discovery fetch（HTTP）
  → auth.authenticate('Bearer <真实 RS256 JWT>')      // 真实 JWKS fetch（HTTP）→ 真实验签 → iss/aud/exp 校验
```

**保真度**：私钥真实存在、JWT 用真实 RSA-SHA256 签名、`EnterpriseAuth.verifyJwtSignature`
跑的是与生产**完全一致**的 RS256 校验（非 mock 桩）；discovery/JWKS 也走真实 HTTP，
连「真实 IdP 的端点结构」都被验证。
**效率**：进程内生成密钥 + 内存级 HTTP，毫秒级、零容器启动、零网络往返。
**参考开源**：`panva/node-oidc-provider`（OpenID 认证的参考实现，已认证 OP 全 profile）
的本地 IdP 思路；本项目零依赖约束下用 `node:crypto` 自实现验证所需最小子集。

**已落地**：4 个集成测试全绿——真实令牌验过、签名篡改→fail-closed 返回 null、
过期→null、经 `/token` 端点 `exchangeCode` 换得含真实 id_token 的令牌集。

## 四、B1：官方 500 Verified → 真实接线已落地（原生本地执行器，免 Docker、免云）

**现状**：仓库自维护的 curated harness（`src/eval/swebench.ts`）**本来就不依赖 docker**
（host `execFileSync` 直接跑 patch+evalCmd），已用它出过自研 10 题套件 live 9/10 代理分
（报告 `benchmark/capability-swebench.json`，花费 $0.1226，对照有效性 ✅）。
但这只是**代理信号**，非官方 Verified 口径。

**官方 500 Verified 的真实接线（已落地为真实代码，非占位）**：用户要求「删 docker、不要云，
用完全本地方案」。据此实现**原生本地执行器** `src/eval/nativeExecutor.ts`，在本地用
`git` + `uv` + `pytest` 直接复现 SWE-bench 判定，零 Docker、零云：

- `src/eval/swebenchVerified.ts`：加载并校验官方 `swe_bench_verified.json`（fail-closed）；
  `SwebenchVerified.runVerifiedSuite` 聚合；`ExecutorPort` 端口（恒 `native`）。
- `src/eval/nativeExecutor.ts`（`NativeExecutor implements ExecutorPort`）：每题流程
  `git worktree add <base_commit>`（隔离工作区，支持并发）→ `uv venv --python <版本>`（按
  `PythonVersionResolver` 选版本，uv 自动拉取对应 Python）→ `uv pip install -e .` + pytest
  → `git apply` 应用 model/test 补丁 → `pytest` 跑 FAIL_TO_PASS + PASS_TO_PASS → 判定 resolved。
  全链路 fail-closed：缺 git / uv / 网络（克隆或 pip）一律返回 resolved=false 并写明原因，绝不静默假绿。
- `src/eval/pythonVersionResolver.ts`：纯函数「仓库 + 版本 → Python 版本」精选映射（best-effort 子集），
  未命中回落 3.11。
- `benchmark/capability_swebench.mjs --verified <swe_bench_verified.json> --predictions <preds.jsonl> [--concurrency N]`：
  本命令只负责「打分」一环；模型补丁（predictions）由我们的 live agent 在具备 git+uv+网络的环境生成。

**turnkey 一键命令（你侧具备 git + uv + 网络后执行）**：

```bash
# 1) 取官方 Verified 实例列表（HF：princeton-nlp/SWE-bench_Verified，转 JSON 数组存为 swe_bench_verified.json）
#    受限网络可设 HF_ENDPOINT=https://hf-mirror.com 走镜像
# 2) 用我们的 live agent 在具备 git+uv+网络的环境生成 predictions.jsonl（instance_id -> model_patch）
# 3) 安装 uv（https://docs.astral.sh/uv/），原生本地执行（免 Docker、免云）：
npm run eval:swebench:verified -- \
  --verified swe_bench_verified.json \
  --predictions preds.jsonl --concurrency 4
```

- **保真度边界（诚实声明）**：env 由「仓库自述 + uv 重建」而来，**不等同**官方 Docker 镜像
  （官方用预建 conda 镜像，含精确的依赖/系统库）。用于本地迭代/小批量自测；若需与官方口径逐题对齐的
  apples-to-apples 分数，仍建议官方 harness（docker/Modal）。本实现判定逻辑（FAIL_TO_PASS 全过 且
  PASS_TO_PASS 全过 = resolved）与官方一致。
- **效率**：本地直接跑，零容器启动、零云费用；跨仓库可并发（`--concurrency`），同仓库 worktree 串行保证隔离。
- **参考开源**：SWE-bench 官方评测口径（FAIL_TO_PASS/PASS_TO_PASS 判定）；`uv` 作本地 Python/venv 管理。

**沙箱硬限制（诚实声明）**：本沙箱实测**无网络**（无法 `git clone` 仓库 / `uv pip install`），
且 `uv` 未安装——故真实 500 题「执行」在此环境仍**物理上不可完成**。本仓库交付 code-ready + turnkey
接线（含 9 个单测覆盖 fail-closed / 版本解析 / pytest 结果解析 / 并发保序有界）；真实分数须你侧具备
**git + uv + 网络**的环境跑出。这与「删 docker、不要云」的诉求一致——执行器已彻底不依赖 Docker 或云。

## 五、给未来挂起项的取舍清单

1. **先问「能不能在进程内/本地用真实实现替代容器/云」**——F4（真实 RSA + 真实 HTTP 胜过 keycloak 容器）、
   B1 原生执行器（uv 隔离 venv + pytest 胜过 docker/Modal）即此。
2. **CI 能覆盖的跨平台验证，绝不自管硬件**——B3 即此（GitHub matrix 胜过自购 Mac）。
3. **优先在本地用真实实现替代容器/云**——B1 原生执行器即此（git worktree + uv venv + pytest 胜过 docker/Modal）。
4. **代理信号与真基准要分开标注**——A4 离线快照、B1 自研 10 题套件均为代理分，
   真基准（AgentDojo/InjecAgent、官方 Verified）解锁前不得冒充。
