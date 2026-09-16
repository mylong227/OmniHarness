# 挂起项更优解调研（B1 / B3 / F4）

> 问题：B1 官方 SWE-bench Verified 子集（须本机 docker + HF 数据集）、
> B3 Linux/macOS 真机、F4 keycloak 容器——是否存在**不依赖这些外部设施、
> 直接验证且保真度一致或更高、效率更优**的开源替代路径？
>
> 结论：**B3 与 F4 已在仓库内用零依赖更优解落地结项**；**B1 官方 500 Verified
> 的真实接线已落地（`src/eval/swebenchVerified.ts` + `capability_swebench.mjs --verified`，LocalDocker/Modal 双执行器 fail-closed），code-ready + turnkey；执行仍须你侧 docker/Modal + 官方 datasets + MODAL_TOKEN**。

## 一、结论摘要

| 挂起项                   | 原方案（外部依赖）         | 更优解                                                                                   | 保真度                   | 效率                       | 状态                                                    |
| ------------------------ | -------------------------- | ---------------------------------------------------------------------------------------- | ------------------------ | -------------------------- | ------------------------------------------------------- |
| **B3** 跨平台真机        | 自购/自管 Linux·macOS 硬件 | GitHub Actions `matrix.os: [ubuntu/macos/windows-latest]`                                | 一致（真实内核）         | 更高（零硬件筹备）         | ✅ 已落地 `ci.yml`                                      |
| **F4** OIDC 真机         | 起 keycloak 容器（docker） | 零依赖本地 IdP 夹具（`node:crypto` 真实 RS256 + 真实 HTTP）                              | 等价（真实 JWT+JWKS）    | 更高（毫秒级·零容器）      | ✅ 已落地 `tests/integration/oidcFixture.ts`            |
| **B1** 官方 500 Verified | 本机 docker + HF 数据集    | `src/eval/swebenchVerified.ts` + `--verified`（LocalDocker/Modal 双执行器，fail-closed） | 一致（官方同款 harness） | 更高（Modal ~7min/500 题） | ✅ 接线落地+turnkey；执行待 docker/Modal+datasets+token |

**决策原则（给未来挂起项）**：当某验证被「容器 / 自管硬件 / 本机数据集」阻塞时，
优先找三类替代——**托管 CI runner**（B3）、**进程内真实实现**（F4）、
**上游云执行**（B1 Modal）。三者都把「外部设施」降为「可选凭证」，保真度不降、效率反升。

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

## 四、B1：官方 500 Verified → 真实接线已落地（docker / Modal 双执行器）

**现状**：仓库自维护的 curated harness（`src/eval/swebench.ts`）**本来就不依赖 docker**
（host `execFileSync` 直接跑 patch+evalCmd），已用它出过自研 10 题套件 live 9/10 代理分
（报告 `benchmark/capability-swebench.json`，花费 $0.1226，对照有效性 ✅）。
但这只是**代理信号**，非官方 Verified 口径。

**官方 500 Verified 的更优解（已落地为真实代码，非占位）**：SWE-bench 官方 FAQ 明确
「不能脱离 Docker 跑评测」，但官方 harness 已 **upstream 支持 Modal 云执行**（`--modal`）：
在 Modal 的 gVisor 隔离容器里跑 500 题，官方文档称 **~7 分钟**完成，零本地 docker、零本机 HF 数据集下载。

本仓库据此实现了**真实接线**：

- `src/eval/swebenchVerified.ts`：加载并校验官方 `swe_bench_verified.json`（fail-closed）；
  `SwebenchVerified.runVerifiedSuite` 聚合；`LocalDockerExecutor` / `ModalExecutor` 两个执行器，
  均经上游 `python -m swebench.harness.run_evaluation` 真实打分，且**缺 docker / modal / MODAL_TOKEN
  / 官方 tasks JSON 时一律 fail-closed 返回未通过**（绝不静默假绿）。
- `benchmark/capability_swebench.mjs --verified <swe_bench_verified.json> --tasks-json <swe_bench_tasks.json> [--predictions <preds.jsonl>] [--backend modal|docker]`：
  本命令只负责「打分」一环；模型补丁（predictions）由我们的 live agent 在具备 repo 缓存的环境生成。

**turnkey 一键命令（你侧具备设施后执行）**：

```bash
# 1) 取官方 Verified 实例列表（HF：princeton-nlp/SWE-bench_Verified，转 JSON 数组存为 swe_bench_verified.json）
# 2) 用我们的 live agent 在具备 repo 缓存的环境生成 predictions.jsonl（instance_id -> model_patch）
# 3) 环境/安装元数据由 upstream harness 经 --dataset_name 自动从 HF 加载（本地 tasks 文件契约已废弃）；
#    受限网络可设 HF_ENDPOINT=https://hf-mirror.com 走镜像；零本地 docker 走 Modal 云执行：
MODAL_TOKEN=xxx npm run eval:swebench:verified -- \
  --verified swe_bench_verified.json \
  --predictions preds.jsonl --backend modal
# 或本机 docker（需本机 docker daemon 已起）：
npm run eval:swebench:verified -- \
  --verified swe_bench_verified.json \
  --predictions preds.jsonl --backend docker
```

- **保真度**：与官方同款 harness + 同款评测脚本，口径一致（甚至更标准）。
- **效率**：Modal ~7min/500 题，远高于「本机逐一起 docker 容器」。
- **参考开源**：SWE-bench 官方 `swebench` harness 的 Modal 集成（`--modal` flag）。

**沙箱硬限制（诚实声明）**：本沙箱实测**已有 docker daemon（WSL2 引擎已起），但无 modal CLI、
无 MODAL_TOKEN/HF_TOKEN，且官方 HuggingFace 站被代理拦截（fetch failed）——官方 500 Verified 的
「执行」一步在此环境仍**物理上不可完成**（缺模态凭证与 HF 数据集可达性；可设 `HF_ENDPOINT=https://hf-mirror.com`
走镜像缓解数据可达性）。本仓库交付 code-ready + turnkey 接线；真实分数须你侧具备 docker/Modal + HF 可达的环境跑出。

## 五、给未来挂起项的取舍清单

1. **先问「能不能在进程内用真实实现替代容器」**——F4 即此（真实 RSA + 真实 HTTP 胜过 keycloak 容器）。
2. **CI 能覆盖的跨平台验证，绝不自管硬件**——B3 即此（GitHub matrix 胜过自购 Mac）。
3. **上游若有云执行，优先走云**——B1 Modal 即此（gVisor 隔离胜过本机 docker）。
4. **代理信号与真基准要分开标注**——A4 离线快照、B1 自研 10 题套件均为代理分，
   真基准（AgentDojo/InjecAgent、官方 Verified）解锁前不得冒充。
