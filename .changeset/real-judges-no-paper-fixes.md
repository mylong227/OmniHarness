---
'@mylong227/omniharness': patch
---

本批做的是**"撤销纸面处置、补真判据"**：把上一轮用"冻结进基线/登记白名单"挡过去的地方换成能证伪的判据。

## ① 撤销上一轮的纸面处置：`sqliteKv` 不是"不可达分支"，是**没缝**

上一轮我把 `SqliteKv` 的覆盖率冻结值从 100 直接改写成 95.41，理由是"懒加载重构带来一条本环境不可达的
防御分支"。**那是纸面处置**：错误文案（"改用 `--kv-adapter json-file` 或升级 Node"）是真实能力，
被删了也不会红。

改法：给 `SqliteKv.requireImpl` 一个**可注入的缝**（缺省仍是真实 `createRequire`），判据把加载器换成替身
**走的就是 `loadDatabaseSync` 的原逻辑**（不是包一层）。`tests/unit/sqliteKvFailurePaths.test.ts` 4 例：
不注入时的真实读写（反面对照）、加载器抛错、模块未导出 `DatabaseSync`、替身必须被恢复。
**正对照**：把错误文案改成 `boom` ⇒ 用例 ②③ 立刻变红。修好后行/分支/函数均 **100%**，
故**棘轮恢复为 100**（撤销改写），并在 `coverageEnvDependent.json` 里删掉那条"直接改写"说明。

**顺带抓到真缺陷**：`SqliteKv.list()` 原样外传 node:sqlite 的**null 原型行对象**，而端口契约是
`{key,value}` ⇒ 「同一端口两个后端返回**形状不同**的东西」（`deepStrictEqual` 直接不等、
`instanceof Object` 为 false）。已归一成普通对象并钉住。

## ② "跳过即假绿"全部装开关（10 个文件）

审计实测：14 个含 skip 的文件里 **10 个是无开关的静默跳过**——缺原生 `.node` / 缺 wasm 产物 /
没装 `sharp` / 没有 Laya 权重 / 没装 `dsh` 时，那些用例在 CI 上**看着绿、其实一行没跑**
（浏览器一族早有 `OMNI_REQUIRE_BROWSER=1`，其余没有）。

新增 `tests/helpers/requireEnv.ts`（**单一实现**）与 7 个开关：
`OMNI_REQUIRE_BROWSER / NATIVE / WASM / DSH / LAYAPY / SHARP / LICENSE`。
语义：能力可用⇒照跑；不可用且开关关⇒如实 skip；**不可用且开关开⇒失败**。
接了 10 个文件：`nativeKernel`(9 处，含 `approval.check` 审批语义)、`nativeAliasBridge`、
`nativeTokenEstimator`、`dshWorker`(3)、`viewImageResize`(2)、`wasmKernelE2E`、`wasmSkillPack`、
`wasmResourceLimits`、`featureEntitlements`、`layaBackend`(5 条真前向)。

外加两条机制判据（`tests/unit/requireSwitches.test.ts`）：
① **机制自证**（三种语义逐一验，含"开关打开时必须抛错"与"`=0` 不算开启"）；
② **全仓清点**（扫 `tests/**` 的每个 skip 点，要求接开关或在显式豁免表里；新增静默跳过即红）；
③ 开关表不得有死条目；④ 扫描面不得静默塌缩。

清点当场又抓出一个漏网文件：`tests/unit/sandboxElevatedReal.test.ts` 是**无条件 skip**
（任何环境都不跑，`describe/it` 注册着永远跳过）。解除后实测**三条断言全部通过** ⇒ 它本来就该跑，
现已成为真判据（文件头如实写明：它断言的是**决策面**，内核强制仍依赖真机特权）。

## ③ 测试盲区 Top10 全部补真判据（10 文件 / 121 条）

| 文件                      | 改前行覆盖 → 改后                                         | 变异正对照                                                                   |
| ------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `processTreeKiller`       | 63.64% → **100%**                                         | 3 处（去整树逻辑 / taskkill 丢 `/T` / 超时 5s→50ms）⇒ 5 条红                 |
| `quotaStore`              | 53.54% → **100%**                                         | 14 条变异 ⇒ 14/14 红                                                         |
| `jsonlWriter`             | 12.50% → **100%**                                         | 同上（同一批 14 条）                                                         |
| `frameSceneSelector`      | 27.27% → **100%**                                         | 21 条变异 ⇒ 21/21 红                                                         |
| `spawnMediaProcessRunner` | 29.13% → **100%**                                         | 同上（同一批 21 条）                                                         |
| `lspDiagnosticsCollector` | 82.18% → **98.14%**（残留为类型系统逼出的不可达防御分支） | 19 条变异 ⇒ 19/19 红（含定时器 `unref` 铁律的**源码级**红证）                |
| `turnDirectiveComposer`   | 80.39%/分支 **37.5%** → **100%**                          | 同上（含 8 种模式组合下"不得暗示已获授权"的措辞纪律）                        |
| `sdkMcpConnector`         | 15.86% → 见其判据                                         | 判据 25 条全绿                                                               |
| `worker` / `worker.ts`    | 零执行行 → 结构+行为判据                                  | 同上                                                                         |
| `approvalRule`            | 零执行行（编译产物只有 `export {};`）                     | 如实按**结构+编译器级**判据（`@ts-expect-error` 钉契约形状），**不**假报覆盖 |

注入缝一律**可选、缺省行为逐字不变**（`opts.X ?? 原实现`），且收在各自文件内：
`processTreeKiller`(platform/kill/exec/spawn)、`spawnMediaProcessRunner`(spawnChild)、
`lspDiagnosticsCollector`(timers，且**刻意不 unref**)、`sdkMcpConnector`。

## ④ 构建产物不再"先删后建"：`npm run build` 改为**先建到暂存再换入**

实测故障（本机 serve 占着 `dist` 时）：旧顺序 `cleanDist dist && tsc && …` 的 `rmSync` 在**删到一半**
抛 `ENOTEMPTY` ⇒ 留下"半删的 dist"（`--version` 能跑、`doctor` 报 `Cannot find module dist/src/core/agent.js`），
而 **tsc 从未开始**（`&&` 短路）。一次构建失败把工作树弄成比构建前更糟。

新脚本 `scripts/buildDist.mjs`：`tsc --outDir dist.next` + 资产 → **换入**
（优先 `rename` 真原子；被占用即**回滚**并退化为逐文件覆盖 + 陈旧清理）→ 清 `dist.old`。
实测：① tsc 失败路径 ⇒ **dist 完好**、只删暂存、退出码 2；② 成功路径 ⇒ `✓ 已原子换入 dist`（serve 在跑也一样）。
陈旧文件清不掉时**如实列出并退出 1**（否则 `dist/tests/unit/*.test.js` 会跑**幽灵用例**），
可用 `OMNI_ALLOW_STALE_DIST=1` 显式接受。`copyAssets.mjs` 增加可选产物根参数（默认行为不变）。

诚实边界：退化路径（覆盖同步）**不是**原子——那需要"没有进程占用 dist"，而被占用时不存在既原子又成功
的做法（Windows 语义）。

## ⑤ 架构门禁 `ports→实现层`：21 条存量边**真收口到 5 条**

上一轮我只是把动态全枚举首次现形的 21 条边冻进白名单（那是"看得见"，不是"修好"）。本批做真收口：

- **14 条属"类型早已在 `ports/**`，端口却绕道实现文件的再导出桶去取"**（G25 记录的同一类老毛病）
  ⇒ 改直连：`skill`×5、`plugin/pluginApplyContext`、`subagent/subagentTypes`、`a2a/a2aProtocol`、
  `native/nativeBackend`×2、`security/toolOutputTrust`、`server/transport/lineTransport`、
  `server/services/auditSink`、`mcp/mcpProtocol`——这些实现文件本来就只是 `export type … from '…ports…'`。
- **1 条是真搬移**：`TrustTier` 原声明在 `security/toolOutputTrust.ts`，而端口要用它表达"外部内容
  信任档"的配置面 ⇒ 新建 `ports/security/trustTier.ts`，原文件改为导入 + 再导出（调用点零改动）。
- **2 条属类型别名空转**：`SsrfPolicy` 只是 `ResolvedSsrfPolicy`（已在 ports）的空扩展
  ⇒ 两个端口直接引用端口层那个类型。

白名单随之 **21 → 5**（`architectureGateLayers.test.ts` 的"白名单不得有死条目"判据盯着），`--strict` 通过。
**剩余 5 条**（spark×2 / workerRegistry / skillRegistry / rlvrLoop）是真正"类型住在实现文件里"的边，
各有前置：需先造 `ports/**` 接口，并把 `Worker` / `RlvrSampleContext` / `SkillRetrieveHit` 等纯类型模块
搬进端口层——记为**下一批**，不再靠"白名单里有交代"糊过去。

## ⑥ 顺带：`check.mjs` 的 JSON 读取改为**容忍 BOM**

本批自己踩了一次：Windows PowerShell 的 `Set-Content -Encoding utf8` 会给文件加 BOM，`package.json`
一带 BOM，`check.mjs` 的 `JSON.parse` 直接抛 `SyntaxError: Unexpected token '\ufeff'`——报错既不点明
"这是 BOM"、也不点明"哪个文件"，连带 **4 条判据变红**。本仓配置层（`src/config/configFile.ts`）早已
容忍 BOM，门禁脚本这一侧没有 ⇒ 新增 `readJson()`（剥 BOM 后 parse）并替换全部 6 处 JSON 读取点。

## ⑦ 顺带修掉的真缺口：`delegateAll` 批量委派不可取消

`WorkerOrchestrator.delegateAll` 原先**没有** `signal` 形参、内部也不传 ⇒「批量委派不可取消」，
与单条 `delegate`（`DelegateTool → delegate → Worker.run`，已验证真能杀子进程）行为不一致。
现补可选 `signal` 并逐任务透传；判据 `workerContract.test.ts` ⑧ 用**同一链路两种调用形态**对照：
带信号 ⇒ 有界取消（<20s）、不传信号 ⇒ 正常跑完。**诚实登记**：该方法目前只有判据在调用（无生产
调用者），属**预防性补齐**。
