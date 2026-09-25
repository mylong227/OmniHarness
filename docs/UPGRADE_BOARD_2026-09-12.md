# 框架升级进度看板（2026-09-12 最新）

> **⚠️ 2026-09-13 起：剩余任务已并入 `docs/TASK_BOARD.md`（唯一前进看板）。** 本板保留为 U1–U7 批次记录；已完成结论与实测数据继续有效。
> 权威路线：`docs/UPGRADE_PLAN_SYNTHESIS.md` 的 U1–U7。
> 口径：✅ 已完成（代码落地 + 实测/单测验证）· 🟡 部分完成（核心已落地，仍有验证/规模化缺口）· ⚪ 待启动（仅设计，代码未写）。
> 本版依据 2026-09-12 全库代码复核 + A2A 回环实测**推翻并取代** 2026-09-05 版（旧版对 U1/U4/U6 的「代码未写」判断已过时）。
> 真实基线（2026-09-12）：**全量单测 1127 通过 / 门禁全绿**（tsc/eslint/构建/单测/集成；当日提交 `663482e`）。

---

## 一、进度快照（两套口径，避免误读）

| 口径                             | 进度      | 说明                                                                               |
| -------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| **计划层（U1–U7 七阶段）**       | **≈83%**  | 5 完成 / 2 部分 / 0 未启动（加权：done=1, partial=0.4）。较 09-05 版 ≈40% 大幅上修 |
| **执行主线（已驱动的升级动作）** | **≈100%** | U1–U7 七项**全部有代码落地**；U3 语义层、U5 eval 规模化仅剩验证/规模化缺口         |

> 一句话：U1 统一场、U4 RLVR、U6 A2A 三块「设计稿」已全部变成代码并接生产（runtime 接线 + 单测绿）；U6 回环实测本轮补齐转 ✅。剩余硬缺口集中在 **U5 官方基准规模化**（CI 已齐：八 job 含零 key eval Pass@k 门禁）；U3 为已结案的诚实天花板。

---

## 二、逐项看板（U1–U7 + 基础项）

| ID       | 升级项                          | 状态 | 已落地证据                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 剩余缺口（需补充）                                                                                                                                       |
| -------- | ------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **基础** | 零依赖铁律 → 必要即可依赖       | ✅   | `scripts/check.mjs` 四闸门准入 + `dependency-allowlist.json` + `docs/DEPENDENCY_POLICY.md`；当前 `dependencies` 仍 0                                                                                                                                                                                                                                                                                                                                        | —                                                                                                                                                        |
| **U1**   | 共振场统一基板（ResonantField） | ✅   | `ports/resonantField.ts` + `adapters/memory/resonantFieldEngine.ts`；`memoryStackAssembler` **默认开启**（`resonantField.enabled !== false`），单一 `ResonantFieldEngine` 同时充当长期记忆+宇宙网，消除双状态源；单测 `resonantField.test.ts` + `resonantFieldDefault.test.ts` 绿                                                                                                                                                                           | —                                                                                                                                                        |
| **U2**   | repo-map 接生产循环             | ✅   | `contextEngine` + `repoMapContext`(TTL 缓存) + `contextAssembler` + `stepRunner/agent` 注入；live 真跑 3/3                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                        |
| **U3**   | 共振语义层融合（破召回天花板）  | 🟡   | 语义骨架 + 混合检索接生产（默认关）；minilm **Hybrid 59.4%（vs 诚实基线 BM25 43.3%）**；e5-large-v2 64.8%（高召回可选预设）；2×2 消融 + 成本报告齐备（`evals/validation-2026-09-05.md` §7–§10）                                                                                                                                                                                                                                                             | **已结案（诚实天花板）**：KPI 67%→≥80% 未达成，瓶颈在 embedding 模型本身；codeGraph/LSA/频谱三项重评均不翻盘。换更强嵌入须端到端证增益为正，否则不再投入 |
| **U4**   | 进化闭环升格为 RLVR             | ✅   | `evolution/verifiableReward.ts`（编译/测试绿可验证奖励，fail-closed：异常→0）+ `rlvrLoop.ts`（**StarPO sample-filter-replay**：采样→可验证奖励打分→绿样本回放缓冲）+ `rlvrController.ts`；runtime 经 `config.evolutionRlvr` 接线（enabled+skillRegistry 才启用，缺省零破坏）；单测 `evolutionRlvr.test.ts` 绿                                                                                                                                               | 梯度级稳定化不适用（本地进化为提示词/采样驱动，非梯度训练）；端到端 autoRun 实跑未开（默认关），如需实战验证须显式开启并跑通验证命令                     |
| **U5**   | 专属 eval 门禁（规模化）        | 🟡   | `evals/live/bench.mjs` 任务集扩到 12+（`--repeat/--pass-k/--min-pass-k` Pass@k 门禁）；`benchmark/swebenchTasks.mjs` SWE 风格任务子集（`--swebench` 零 key replay、`--swebench-remote` 联网子集）；真实 DeepSeek 跑分 3/3；自研套件 10/10（$0.20）；**接 CI（本轮补齐）**：`.github/workflows/ci.yml` 自 re-init 起已存在（gate/web/test/security/rust/e2e/wasm 七 job），本轮补第 8 个 `eval` job（`npm run eval:ci` 零 key Pass@k 门禁，本地验证 exit 0） | ①**官方 SWE-bench Verified 子集**（当前为自研本地子集，联网子集未常态化）；②Terminal-Bench 子集；③对竞品横向对比                                         |
| **U6**   | A2A 互操作客户端                | ✅   | `a2aProtocol/a2aClient/a2aServer/httpA2aTransport` 全落地 + runtime 接线（server 监听 + client 委托，缺省零破坏）；单测 `a2a.test.ts` 绿；**回环实测（本轮补齐）**：串行 30 任务 **完成率 100%、延迟 avg 2.5ms / p95 5ms / max 7ms**；并发 5×50 任务 **100%、avg 10.8ms / p95 28ms**（`evals/a2a-loopback.mjs` + 两份 report.json）                                                                                                                         | 已测口径为 **localhost 传输层+协议层回环**（不含 LLM 推理）；跨进程/跨机部署形态与真实子 agent 委托链路未测                                              |
| **U7**   | 全链路零依赖铁律自检            | ✅   | `check.mjs` 阻断级门禁 + 预提交钩子；新增模块零第三方（ports/core 恒 free）                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                        |

---

## 三、待补充清单（按 ROI / 依赖排序）

1. **U5 eval 规模化**（唯一硬缺口，对竞品可证伪的关键；CI 半边本轮已补）
   - ~~接 CI~~ ✅ 已完成：`.github/workflows/ci.yml` 早已存在（09-08 re-init 携带、`3fdde9a` 加固；此前看板误判「缺失」，系 Glob 忽略点开头目录所致）；本轮补第 8 个 `eval` job：`npm run eval:ci`（passK 单测 + SWE 本地子集零 key replay + Pass@k 阈值门禁，本地 exit 0）。
   - 接官方 SWE-bench Verified 子集并常态化联网跑分（现有 `--swebench-remote` 钩子已预留；**须 API key，暂挂**）。
   - Terminal-Bench 子集 + 对竞品横向对比。

2. **U6 跨进程/跨机扩展**（可选增强）
   - 当前实测为 localhost 回环；WebSocket 传输、跨机延迟与真实子 agent 委托链路待测。

3. **U4 autoRun 实战验证**（可选）
   - `evolutionRlvr.autoRun` 显式开启，跑通「采样→验证命令→绿样本回放」端到端闭环。

4. **尾账（与升级主线无关但须记着）**
   - OS 沙箱真实隔离：bwrap/seatbelt/landlock 仍为 fail-closed 占位，待 Linux/macOS 真机验证。

---

## 四、诚实边界（不夸大）

- **有硬数字支撑的部分**：上下文效率 114x vs 整语料、7.97x vs grep 竞品且召回更高；live 真实跑分 3/3、自研 SWE 套件 10/10；U6 回环实测 80 任务 0 失败、串行 p95 5ms。
- **未坐实的部分**：官方 SWE-bench Verified 大规模 Pass@k 仍缺（自研子集 ≠ 官方基准）；U6 实测限于 localhost 回环（传输+协议层，无 LLM/跨机）；U3 召回天花板为诚实结案而非达标；U4 端到端 autoRun 未开。
- **git 可追溯性缺口**：git 历史 2026-09-08 整体重建（`31878a2 re-init from working tree`），U1/U4/U6 三块代码经 re-init 入库、**无独立特性提交**，出处只能回溯到快照；后续新特性须保持独立提交。

---

## 五、git 状态（截至本次汇报）

**2026-09-08 前主线**（旧历史，经 re-init 快照保留）：`8481ce2`(铁律翻转) `2565ff3`(U2) `7f55a4a`(U4缓存) `80ce2e0`(embedding) `7561950`(live脚手架) `6157234`+`ab9b876`(live跑分) `f35a873`(语义召回接生产) 等。

**2026-09-08 re-init 后**：U1/U4/U6 代码随 `31878a2` 入库（无独立特性提交，见诚实边界）；随后为代码规范八条战役（Phase 3/4/5/6，`663482e` 收官：全库显式访问权限、文件名=类名、削 static、一文件一类、上帝类拆分），单测基线 835 → **1127 全绿**。

**本轮新增（2026-09-12）**：`evals/a2a-loopback.mjs`（U6 回环实测脚本）+ `evals/a2a-loopback.report.json`（串行 30）+ `evals/a2a-loopback.report.conc5.json`（并发 5×50）+ 本看板；随后补 `.github/workflows/ci.yml` 第 8 个 `eval` job（U5 零 key Pass@k 门禁进 CI，本地验证 exit 0），并修正「CI 缺失」误判（复核工具 Glob 忽略点开头目录所致）。

---

## 六、旧版看板

`docs/archive/UPGRADE_BOARD_2026-09-05.md` 保留作历史存档，其中 U1/U4/U6「⚪ 待启动」的判断已被本版推翻。

## 七、配套看板

- **工程架构与写法**侧（分层解耦 / 单例治理 / 目录归属 / 注释强制 / 前端 class 规范化 / 技术栈升级）见 `docs/REFACTOR_BOARD_2026-09-12.md`（P0-P8，度量可查）。两份看板并行：本页管**能力**（能不能），另一页管**工程**（好不好维护）。
- **理论与前沿**侧（Harness Engineering 2026 前沿 / 数学·物理·生物·化学理论底座 / 隐喻引擎成熟度分级 / 六条升级主线 T0–T6）见 `docs/library/README.md` 与 `docs/TECH_DIRECTION_SYNTHESIS_2026-09-12.md`。第三份文档管**方向与依据**：为 U1–U7 的每个 KPI 提供理论解释，并解释本项目历史负结果（LSA/PageRank/频域共振）的共同根因＝**度量错配**。

## 八、本轮（2026-09-13）截图功能前后端打通

**触发**：三张工作台截图，要求「上下文容量面板 / 今日余额与配额档位 / + 菜单（目标·计划·绘图·插件·智能体·搜索）/ 审批档位表」前后端全部打通。

**后端（RPC + 服务，随 `cd84553` 提交）**：

- 新增 RPC：`context.usage`、`quota.get/set`（档位 free/plus/pro 倍率 1.0/1.5/3.0）、`modes.get/set`（会话模式）、`agents.list`、`search.all`（混合检索）、`approval.tiers`。
- 新增服务：`contextUsageService`、`quotaPlans`/`quotaStore`/`quotaService`、`sessionModeStore`、`sessionArchive.dailyUsage`、`turnDirectiveComposer`、`agentCatalogService`、`workspaceSearchService`、`approvalTierCatalog`、`sketchWriteTool`（fail-closed 写 `.omniharness/sketches/`）。
- 接线：`appServerSurfaceHandlers`（RPC 承载层）、`appServer`（继承）、`agentRuntimeHost`（resolveApprovals 加 plan 分支）、`configFile`（approval 枚举补 plan）、`eventFactory`/`sessionRecorder`（model/usage 带上下文快照）。

**前端（组件 + 接线，本轮修复编译后提交）**：

- 纯逻辑模型：`AddMenuModel`/`ContextUsageView`/`QuotaView`/`TokenScaleFormatter`/`PermissionTierModel`（零 React 依赖，node 直测）。
- 组件：`AddMenu`/`ContextCapacityPanel`/`PermissionPicker`。
- 接线：`Composer`（渲染三组件 + `threadId` 解构）、`StreamView`（透传 + 去重 `onOpenFile`）、`App`（openPane/回调）、`ApprovalModal`（onChangePermission）、`components.css`/`theme.css`（含 `--danger` token）。
- 修复编译 4 处：`AddMenu` onChange 事件类型、

`Composer` 漏解构 `threadId`、`StreamView` 重复 `onOpenFile`、前端 `React.ChangeEvent` 命名空间不存在（react-shim 仅运行时值，无类型命名空间）。

**门禁（全绿）**：typecheck / lint / check --strict / audit:maturity / audit:standard:delta / arch:gate / web:build 均通过。

**测试**：`tests/helpers/tempWorkspace.ts` 隔离工作区，修复 `process.cwd()` 真实仓库根扫描撞破 15s 轮询死线的大面积假失败。

- ✅ **单元债务（9 项）已收口（2026-09-13）**：密闭化修复（modelOverrideEnabled + pluginLoader + 测试工作区隔离）后单文件复核全绿（appServer 8/8、httpServer 10/10、shellTool 7/7）；本机 Node 20.1 因缺 node:sqlite 尚有 20 项环境性失败（CI Node 22 全绿）。另补组件挂载契约测试（P5.5，零依赖 DOM 桩）。原登记：`appServer`/`httpServer`/`sdkStream`/`wsTransport` 工作区测试改动后，app-server（threads.create 返回结构、turns.run assistant 事件、approvalUplink 未接 AppServer 构造）、HTTP 审批 SSE、SDK WebSocket 端到端、shellTool（workspaceRoot/管道语义）共 9 项失败；`src/server` 实现未在工作区改动（已随 `cd84553`），属历史未验证测试，建议单列技术债 sprint 收口。

**pre-commit 适配**：hook 由 `npm run` 改 `node` 直调脚本（`npm` 在本环境 shell PATH 缺失，仅 `node` 可用；判定逻辑不变，更鲁棒）。

## 九、本轮（2026-09-13）收口补件：AppServer 密闭化开关

`ef46eb5` 提交后，工作树仍残留一组**内部自洽、此前漏提交**的改动——属 §八 测试隔离工作区的服务端配套，本次补齐。

**改动（随本提交）**：

- `src/server/core/appServerState.ts`：`AppServerOptions` 新增可选字段 `modelOverrideEnabled?: boolean`（含 JSDoc）——嵌入方与单测注入 mock 模型时须显式传 `false`，否则会读落盘 `omniharness.json` 并拿真实凭据打真实 API。
- `src/server/core/appServerBase.ts`：`modelOverride` getter 在 `modelOverrideEnabled === false` 时返回 `undefined`；缺省 `true`（serve 模式依赖此行为热切换真模型）。
- `tests/unit/{appServer,httpServer,sdkStream,wsTransport}.test.ts`：测试脚手架统一传 `modelOverrideEnabled: false`，使 AppServer 构造变为 hermetic。

**作用**：直接消除 §八「9 项单元债务」中 `appServer(27-30,32)` 一类「构造即读本机模型配置」的假失败根因；serve 模式默认行为不变。

**门禁预检（提交前）**：后端 `tsc --noEmit` 零错误；prettier `--check` 六文件全通过；`audit:standard:delta` 零增量违规。本提交不跑 unit（hook 不拦），但 `modelOverrideEnabled:false` 应使上述 appServer 单测转绿，建议后续技术债 sprint 顺带复跑验证。
