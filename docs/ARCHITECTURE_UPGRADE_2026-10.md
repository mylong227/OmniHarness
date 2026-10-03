# 架构现状核查与升级调研（2026-10-03）

> 本文件是「清理干净真实现状 + 调研整体架构是否值得更优升级」的交付物。
> 分工：**§1–§2 是本机实测/读码得出的事实**（可复核命令随文给出）；**§3 是外部调研**
> （学术论文 / 官方规范 / GitHub 优质开源，逐条带一手 URL，未读到的显式标注）；
> **§4 是升级路线图**（含判据、工作量、风险）；**§5 是反泡沫清单（明确不做）**。
>
> 调研方法：11 个专题并行调研（每个专题独立检索一手来源）+ 本项目自有代码复核；
> 所有"提案"必须给出**本机可跑、离线、无付费 key** 的判据，否则不予采纳。

---

## 0. 摘要（直接回答"架构能否更优升级"）

**能，而且骨架不用换。** 结论分三句：

1. **资产是真的**：97,631 行 TypeScript 只有 **2 个运行时依赖**，`ports/` 与 `core/` 第三方-free 且由 `arch:gate`
   机械强制；覆盖率 **行 90.13% / 分支 83.61%**；9 道门禁把"约定"变成判据（含"声明必须接线"这类罕见审计）。
   这套骨架**不值得推翻**，外部调研也没有给出推翻它的理由。
2. **短板不在抽象层，而在三个"未闭合边界"**：① **验证真空**——删掉评测子系统后，检索/排序（17 文件 / 4,476 行核心）
   彻底没有行为判据，项目自己的 D6 纪律（翻默认两关）**不可满足**；② **隔离/授权语义不成体系**——本轮实测出
   **5 处缺陷/边界错配**（子代理写入静默丢弃、workflow 无隔离却自称隔离、零测试被判"验证通过"、
   回滚漏压缩游标、取消原因降级），以及安全面三处"声明强于实现"；③ **复杂度集中与历史包袱**——
   检索栈里有多条**已被本项目自己证伪**的实验路径仍需维护，`docs/` 89 个文件里旧数字随时可能被当现状引用。
3. **升级的最优形态是"补三种闭环 + 做一次减法"，而不是"加机器"**：外部调研本轮**否掉了四个加机器的直觉**——
   把 token 记账下沉 Rust 实测**更慢 4.5–6.7×**、向量/图数据库在本仓约束下**不必要**、`worker_threads` 实测 **0.69×（更慢）**、
   并行写入型子代理**有害**。省下的比加上的多，这是本次调研最值钱的结论。

**本轮顺带产出的可复核缺陷（已登记看板 §8，全部本机可复现）**：

| 编号 | 缺陷                                                                              | 严重度 | 判据（判据=可复现命令/读码位置）                                     |
| ---- | --------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| 8.1  | 子代理文件写入**静默丢弃**（worktree 清理 + 无 patch 字段）                       | 🔴 P0  | `subagentOrchestrator.ts:62-77` / `worktreeOps.ts:74-97`             |
| 8.6  | 完成闸门把**零测试**判成"验证通过"（只看 exitCode）                               | 🔴 P0  | `node --test <空glob>` ⇒ exit 0 + `# tests 0`；闸门 `:78`            |
| 8.5  | 安全面三处"声明强于实现"（默认档无内核强制 / 受限令牌 0 个 SID / fetch 守卫盲区） | 🔴 P0  | `appServerBase.ts:245` / `restricted_token.rs:281-292` / egress 守卫 |
| 8.2  | 回滚后**压缩游标未复位**（同进程错、重启对）                                      | 🟠 P1  | `stepContextBuilder.ts:44,46,101-104`（无复位点）                    |
| 8.3  | 事件落盘**全量重写**（实测 12,800 条 ≈139 ms / 6.5 MB，每步 flush）               | 🟠 P1  | `eventPersister.ts:139-163` / `sqliteStorage.ts:49-67`               |
| 8.4  | 取消原因级联被降级为 `'parent'`，且**零测试覆盖**                                 | 🟠 P1  | `cancellationToken.ts` 级联处；`cancelPropagation.test.ts` 0 断言    |

**同时订正了四处此前的错误记录**（都是本轮读码/实测发现）：
① 行数口径 `Measure-Object -Line` **少计空行**（`src` 实为 **97,631** 行，非 92,124）；
② `web/src` 不是"自绘 React 垫片"，运行时是**官方 React 18.3.1 UMD**，手写的只是类型声明；
③ 嵌入吞吐"180–320 texts/s"**复现不出**（复测 **26–30 texts/s**，且吞吐随文本长度剧变）；
④ 默认嵌入是 **e5-large-v2（1024 维）**，不是我此前以为的 e5-small-v2。
另有三处口径由调研复核后订正：单文件行数上限是 **810**（非 800）、上帝类判据是 `codeLines>500 或 methods>25`、
"禁 `any`/显式修饰符"是 **ESLint 原生规则**（非自研脚本），以及 `*Assembler.ts` 只有 **6 个**（非 22 个）。

**专题完成度：11/11**（主循环、检索、记忆、工具/MCP、安全、多代理、可观测性、原生内核、TS 架构、Web 工作台、自验证）。
各专题的一手原始笔记（含全部 URL 与实测数字，**未入库**，被 `.gitignore` 的 `.omni-*/` 忽略）位于
`.omni-storage/research/<topic>.md`；本文件只保留经我复核、或有明确一手出处的结论。

---

## 1. 清理后的真实现状

### 1.1 本轮清理（3 个提交，均已推送）

| 提交      | 内容                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `289218b` | 删除跑分/评测子系统：87 个入库文件（`benchmark/`、`evals/`、`python/`、`scripts/*.py` 16 个、`tests/bench/`、`BENCHMARKS.md` + 5 篇口径文档、`requirements.txt`）+ 同步 `package.json`/CI/文档/死链基线 |
| `6395a92` | 清残留：41 个未入库 `*.report.json`、失效 `.gitignore` 规则、`THIRD_PARTY_ASSETS.md` 口径                                                                                                               |
| `9830a0f` | 清 `.xeval/`（20 个旧版编译残骸，全仓零引用）+ 同步 `auditTopLevelFunctions` 范围注释                                                                                                                   |

**清理后根目录已无**：`benchmark/`、`evals/`、`python/`、`eval-data/`、`tests/bench/`、`BENCHMARKS.md`、`requirements.txt`。
`package.json` 已无 `eval:*` / `metrics:*` / `bench*` 脚本；CI 的 `eval` job 同步删除（上次同类删除漏改 CI 有事故留档）。

### 1.2 规模（**计数口径已订正**）

> ⚠️ **口径订正**：历轮用 `Get-Content | Measure-Object -Line` 数行数，该 cmdlet **少计空行**——
> `src/context/contextEngine.ts` 实测 `(Get-Content).Count` = **646**，而旧口径给 609（单文件少 37 行）。
> 故历史数字系统性偏低。**正确口径 = 逐文件 `(Get-Content $f).Count` 求和**。

| 区域                             | 文件数 | 行数   |
| -------------------------------- | ------ | ------ |
| `src/` 全部（914 个 .ts）        | 914    | 97,631 |
| 单元测试 `tests/*.test.ts`       | 385    | 53,136 |
| Web 工作台 `web/src`             | 111    | 17,245 |
| Rust `crates/**/*.rs`（6 crate） | 39     | 6,143  |

`src/` 分区：adapters 211/32,033｜ports **342/6,238**｜server 47/9,104｜context 46/9,948｜cli 29/6,212｜
core 26/5,541｜util 32/4,248｜config 22/4,104｜media 19/2,559｜evolution 14/2,161｜subagent 10/950｜
autonomy 9/842｜security 8/1,210｜observability 7/1,114｜a2a 7/1,111｜mcp 8/908｜plugin 20/1,989｜skill 5/684｜search 3/651｜worker 6/374。

**运行时依赖仍只有 2 个**：`@modelcontextprotocol/sdk@1.30.0`、`zod@4.6.4`（可选：`@huggingface/transformers`、`sharp`）。
Node v22.20.0 / TypeScript 5.9.3。

**测试覆盖率（本机实跑 `npm run coverage`，2026-10-03）**：**行 90.13% / 分支 83.61% / 函数 87.63%**
（2,445 项断言 / 0 失败）。⇒ "代码被测试覆盖"这件事是**扎实的**；缺的不是覆盖率，而是**行为质量判据**（见 §1.3）。

### 1.3 现在的验证能力矩阵（**诚实清单**）

| 能力面                         | 有无机械判据 | 说明                                                            |
| ------------------------------ | ------------ | --------------------------------------------------------------- |
| 类型 / 规范 / 架构方向 / 接线  | ✅ 有        | typecheck、lint、check --strict、arch:gate、audit:config-wiring |
| 成熟度声明（40 项）            | ✅ 有        | audit:maturity（L2/L3 必须有存在性证据）                        |
| 文档链接 / API 稳定性          | ✅ 有        | check:doc-links（基线 89）、api:check                           |
| 单元行为（2,445 项断言）       | ✅ 有        | `npm test`（385 文件）、`rust:test`、`web:test`                 |
| **检索/排序质量**              | ❌ **无**    | 唯一判据（`evals/**`）已删；现存单测只验机制不验质量            |
| **工具按需暴露「零能力损伤」** | ❌ **无**    | 原 `eval:tool-exposure-e2e --gate` 已删                         |
| **前缀缓存复用率**             | ❌ **无**    | 原 `eval:prefix-stability` 已删（唯一 prompt-cache 代理指标）   |
| **技能路由三关**               | ❌ **无**    | 原 `eval:skill-routing --gate` 已删                             |
| **压缩降幅 / token 记账趋势**  | ❌ **无**    | 原 `tests/bench/compactionBench` 已删                           |
| **长期记忆增益**               | ❌ **无**    | 从未有过判据（见 §3.3）                                         |

> 这张表是删除评测子系统的**真实代价**：删除本身是明确指令，代价不是"少几个数字"，
> 而是**核心价值面（检索质量）从此没有可复现的机械判据**——这与"保证核心功能"目标直接冲突，
> 也是 §4 里优先级最高的一条（P0-1）。

### 1.4 本轮发现的已确证缺陷（6 条，详见看板 §8）

1. **🔴 P0：子代理文件写入被静默丢弃**（隔离有、回并路径无）。证据：`subagentOrchestrator.ts:62-77`

建 worktree → `finally` 清理；`worktreeOps.ts:74-97` 的 cleanup = `git worktree remove --force`
**+ `git branch -D`**；`ports/subagent/subagentResult.ts:9-19` 无 diff/sha 字段；
`WorktreeOps` 全仓仅 2 处引用（无合并路径）；`toolViewOf` 只剔除递归入口，写类工具可用。2. **🔴 P0：`run_workflow` 无隔离却自称隔离**。`src/autonomy/workflowRunner.ts:206` docstring 写
"构造隔离子智能体"，`:220/:223` 实际传**父级 ports**（无 worktree），同层并发（默认 4）直接写父工作区、
无冲突检测。两条并发路径的隔离语义**相反**。

3. **🟠 P1：回滚后"压缩游标"未复位**（✅ 我已复核）：`stateRestored` 全仓只在 L46 初始化、L102 置 `true`，
   **无任何复位点** ⇒ 同回合回滚后游标指向已被移除的折叠点（"同进程不对、重启对了"）。
4. **🟠 P1：事件落盘是全量快照重写**（✅ 机制复核 + **实测**单次成本：12,800 条 ≈ 139 ms / 6.5 MB）⇒
   每步 flush 使累计写入按 `size_N × 步数 / 2` 增长（外推，非端到端实测）。
5. **✅ 已修（第六轮）：取消原因在 AbortSignal 桥上丢失**（原诊断"级联降级"经读码**订正**——`'parent'`
   是一等值且被测试断言，属有意设计；真丢失点是 `toAbortSignal()` 不带 reason + `reasonOf()` 白名单缺
   `'loop-guard'`/`{custom}`、兜底值与自身 JSDoc 矛盾）⇒ 用户中断/超时/关机/失控熔断全被报成"父级联"。
6. **🔴 P0：安全面三处"声明强于实现"**（见看板 §8.5）：默认沙箱档 = 纯 TS 策略（无内核强制）；
   Windows"OS 级"后端 `CreateRestrictedToken(..., 0, null, 0, null, 0, null, …)` 三个 restricting-SID 计数为 0
   ⇒ **无文件/网络拒绝语义**；`networkEgressGuard` **只包 `globalThis.fetch`**（shell 子进程完全绕过）。
   ⇒ **可引用口径：当前隔离级别是 L2（同用户进程内约束）**。

### 1.5 "行为判据"的真实去处：**未入库的本地探针**（本次清理的重要发现）

删除 `evals/` 并不等于"项目没有行为测量"——真实情况是：**大部分行为测量能力以未入库脚本的形式活在
`.omniharness/`（gitignored）里**。本次清点（26 个 `.mjs`，全部未入库、GitHub 上不存在、CI 不跑）：

| 类别        | 脚本（示例）                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 检索质量    | `recall-headroom-probe.mjs`、`recall-hitrate-probe.mjs`、`recall-rerank-variants.mjs`、`rerank-discriminator-ab.mjs`、`rerankFixtureProbe.mjs`、`mergeRecallQueries.mjs` |
| Web UI      | `webLiveUiCheck.mjs`、`domAudit.mjs`、`uiPaletteProbe.mjs`、`liveScrollCoverage.mjs`、`scrollPullbackProbe.mjs`、`scrollPullbackTall.mjs`、`liveScrollPullback.mjs`      |
| 诊断/稳定性 | `hangStack.mjs`、`pauseStack.mjs`、`slowOrHung.mjs`、`crashGuardSmoke.mjs`、`cdpHealth.mjs`、`appLoadTrace.mjs`、`cleanAppProbe.mjs`、`repro185.mjs`                     |
| 接线/可观测 | `wiringScan.mjs`、`wiringScan2.mjs`、`otlpE2e.mjs`                                                                                                                       |

**这意味着两件事**：① 现有"实测数字"**不可被他人复现**（不在版本库里），与看板§9 的"记录纪律"（命令 + 日期 + 结果）
存在结构性冲突；② §1.3 的"验证真空"有一个**低成本补法**——不是重造评测体系，而是把其中少数几个
（检索召回/前缀复用/工具暴露）**提升为入库的、离线秒级的最小回归守卫**（见 §4 的 V1）。

**顺带清理**：`.omniharness/` 下 36 个孤儿目录（26 个 `tbench-e2e-*` + `tbench-work` + 5 个 `appmap-*` +
2 个 `shim-probe*` + `head-scan` + `skillcheck`，共约 **99.7 MB**）——它们全部来自已删除的
Terminal-Bench/评测子系统且**生产代码零引用**（逐名 grep 确认）；`spill`（126 处引用）与 `graphs`（34 处）是生产在用，保留。

---

## 2. 架构评估：骨架是资产，短板在"验证真空 / 语义闭环 / 复杂度集中"

### 2.1 结构性资产（应保留、不要推倒）

| #   | 资产                           | 证据                                                                                                                 |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| A1  | **依赖极度克制**               | 97,631 行 TS 只有 2 个运行时依赖；`ports`/`core` 第三方-free 且由 `arch:gate` 机械强制（不是口号）                   |
| A2  | **纪律机械化**（把约定变判据） | 9 道门禁 + "声明必须接线"审计（专抓声明未接线）+ 成熟度 L0–L3 证据要求 + 死链/覆盖率/API 稳定性                      |
| A3  | **可离线自足**                 | 本地 e5-small-v2 ONNX 嵌入 + llama.cpp + SQLite ⇒ 无付费 key 也能跑通核心链路（单人维护的关键生存条件）              |
| A4  | **能力面广且已接线**           | 4 类模型适配器、MCP、20+ 工具、审批、企业 SSO/审计、A2A 私有协议、Web 工作台、Rust 原生内核（且有 TS/Rust 奇偶测试） |
| A5  | **失败模式纪律**               | fail-closed 与"禁止静默失败"在多处注释里留有治理史（如 worktree 清理、语料遍历上限、工具配对不变量）                 |

### 2.2 结构性风险（按严重度排序，带量化）

| #      | 风险                                           | 量化证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | **验证真空**（检索质量无判据）                 | 检索/排序核心 **17 文件 / 4,476 行**（bm25Index 550、layeredCodeGraph 526、semanticIndexCache 384、corpusIndexCache 371、codeReferenceGraph 322、lsaEngine 326、rankVeto 三件 648、codeGraphIndex 262、fileReranker 221、recallKnobs 213、hybridRanker 210…）全部**只剩机制单测**；D6"翻默认两关"纪律不可满足                                                                                                                                                                                 |
| **R2** | **隔离/授权语义不成体系**                      | §1.4 两处 P0 + 记忆信任级缺失（§3.3）+ OS 沙箱 fail-closed 占位 ⇒ 同一类问题（"谁能在哪写什么"）散落四处                                                                                                                                                                                                                                                                                                                                                                                      |
| **R3** | **记忆投毒链（写入默认开、闸门缺）**           | `tool_result`（不可信）与 user 文本不加区分进入抽取；fact `source` 仅 `'tool'\|'consolidated'`，无信任级；primer 开启时以 `recorder.system(...)` 回灌；当前 primer 默认关 ⇒ 断开是**运气不是设计**                                                                                                                                                                                                                                                                                            |
| **R4** | **复杂度集中 + 实验代码长期占位**              | `context` 46 文件/9,948 行；其中图检索/LSA/频谱三项**已被本项目自己多次证伪**（净负面/零增益）却仍需维护、且默认关 ⇒ 维护面与"能开但没用"的语义负债                                                                                                                                                                                                                                                                                                                                           |
| **R5** | **端口层碎片化（不是死契约）**                 | 342 文件/6,238 行，平均 **18.2 行**、中位 **13 行**，264/342 文件 <20 行；符号级检查**仅 6 个孤儿文件（1.8%）**、310 个导出符号中仅 7 个未被 ports 外引用 ⇒ 契约是"活的但过细"，主要成本是导航/导入与组合根装配                                                                                                                                                                                                                                                                               |
| **R6** | **Web 工作台：类型垫片与死负载**（口径已订正） | `web/src` 111 文件 / 17,245 行（.ts 66/8,769 + .tsx 45/8,476，逐文件 `(Get-Content).Count` 求和）。**运行时是官方 React 18.3.1 UMD**（`web/vendor/react*.min.js`，`index.html` 直载），**零打包器**（`tsc` 直出 ESM）；手写的是**类型声明** `types/react-shim.d.ts`（≈5.5 KB）⇒ 真实成本是"类型维护税"，不是"自绘框架"。另：`index.html` 仍加载 `vendor/highlight.min.js`（**118.9 KB**）+ 其 CSS，而 `ui/highlight.ts` 已自研分词器（357 行，注释写明不引 highlight.js）⇒ **≈120 KB 死负载** |
| **R7** | **Windows 主开发机 + 最强隔离不可验证**        | OS 级沙箱后端 fail-closed 占位；本机无法验证 bwrap/seatbelt 路径 ⇒ 沙箱正确性属"写得出、证不了"                                                                                                                                                                                                                                                                                                                                                                                               |
| **R8** | **近红线文件聚集**                             | appServer **684**、cliBuildConfig 652、contextEngine 646、configError 638、openAiCompatibleModel 635（阈值是 `check.mjs` 的 **`MAX_FILE_LINES = 810`**，非 800）；**上帝类**另按 `auditStandards` 判据 **`codeLines>500 或 methods>25`**（`enterprise/oidcClient` 邻近 25）—— 新能力常被迫先重构                                                                                                                                                                                              |
| **R9** | **文档/历史包袱**                              | `docs/` 89 个入库文件，含大量分期审计与已删子系统引用（本轮冻结 89 处死链基线）⇒ 旧数字被误当现状的风险                                                                                                                                                                                                                                                                                                                                                                                       |

### 2.3 直接回答「是否值得更优升级」

**值得，但方向不是推倒重来，而是"补三种闭环 + 做一次减法"**：

1. **补验证闭环**（R1）：不恢复重型跑分，而是建**最小行为回归守卫**（离线、无 key、秒级）——这是核心价值的唯一护栏；
2. **补语义闭环**（R2/R3）：把"谁能在哪写什么"收成一条线（子代理写入、workflow 隔离、记忆信任级、沙箱能力声明）；
3. **补产品闭环**（R6/R7）：Web 工作台与沙箱是本项目对外的两个"最后一公里"，也是单人维护下最贵的两块；
4. **做一次减法**（R4/R5）：把已被自己证伪的实验路径（图/LSA/频谱）收敛为可删除或默认关的明确边界，让 context 层回到"少而可信"。

骨架（六边形 + 门禁 + 零依赖）**不需要改**；改的是它的三个未闭合边界。

---

## 3. 外部调研发现（11 专题）

> 每条 `——` 后为证据（一手 URL / 本机读码位置 / 数字）。标 **(未独立验证)** 者本轮未读到一手确认。

### 3.1 Agent 主循环与回合/步架构（✅ 已完成）

**发现**

1. **落盘是"全量快照重写"而非增量追加**（机制复核 + **本机实测**）：`EventPersister.saveSnapshot` → `storage.save(sid, events)`
   （`eventPersister.ts:139-163`），`TurnRunner` **每步** `schedule()`（`turnRunner.ts:107-108`）；三适配器无 append 通道
   （`jsonlStorage.ts:33-48` 整文件 tmp+rename；`sqliteStorage.ts:49-67` 事务内 **`DELETE` 全桶 + 逐条 `INSERT`**，已复核）。
   **实测（本机，`JsonlStorage.save` 单次调用）**：

   | 事件数 N | 单次 save 耗时 | 落盘体积   |
   | -------- | -------------- | ---------- |
   | 200      | ~28 ms         | 89 KB      |
   | 3,200    | ~41 ms         | 1.6 MB     |
   | 12,800   | **~139 ms**    | **6.5 MB** |

   ⇒ 单次 flush 成本**随 N 线性**；而 flush 每步触发 ⇒ 会话累计写入量 ≈ `Σ size(k) ≈ size_N × 步数 / 2`
   （12,800 事件、1,000 步的尾部量级 ≈ **3 GB 级重写**）。**这是"实测单次成本 × 线性增长"的外推，不是端到端实测**，
   引用时必须保留这个口径。对照：gptme 是真追加且要**四条件**证前缀完整（路径一致/长度不缩/size 与记录一致/以 `\n` 结尾）。

2. **✅ 已核实的新缺陷：回滚后"压缩游标"未复位**。`StepContextBuilder.compactionState/stateRestored`
   （`stepContextBuilder.ts:44,46`）**全仓唯一写入点是构造后首次 `buildMessages`**（L101-104；我复核 `stateRestored =` 仅 L46/L102 两处）。
   ⇒ 同回合内 `checkpoint` 回滚后，内存游标仍指向**已被 `eventsFrom` 从日志移除**的折叠点；
   症状是"同进程内不对、重启后对了"（重启新实例复位为 false）。三层回滚对齐（内存/检索/磁盘+在飞写）
   本身做对了：`sessionRecorder.rewindTo` 会重算 seq + `dropFromRetrieval`，端口不支持 `remove` 时**显式告警**而非静默。
3. **✅ 已修（第六轮）：取消原因在 AbortSignal 桥上丢失**（原诊断"级联降级"经读码复核后**订正**）：
   - 原怀疑的 `child.cancel(reason === 'parent' ? reason : 'parent')` **是有意设计**——`'parent'` 是
     `CancelReason` 的一等值且被 `loopCancellation.test.ts:45` 明确断言，且 `child()` 在 `src/**` 无生产调用点；
   - **真正的丢失点**：`cancellationToken.toAbortSignal()` 两处 `controller.abort()` 都**不带 reason**，
     而 `agent.ts:413` 正是把该 signal 交给模型层；同时 `CancellableModel.reasonOf()` 的白名单缺少
     `'loop-guard'` 与 `{custom}`，兜底值还与自己 JSDoc 写的"缺省为 `'user'`"矛盾（实现返回 `'parent'`）。
     ⇒ 净后果：用户中断 / 超时 / 关机 / **失控熔断**全被报成"父令牌级联"。
   - **已修**：桥带上结构化原因；`reasonOf` 认全五类 + `{custom}`、兜底取 `'user'`。判据：新增
     `tests/unit/cancellableModelReason.test.ts`（4 例）+ `loopCancellation` 增 1 例 + `cancelPropagation`
     在**真实 agent/workflow/goal/subagent 三条路径**上断言 `childAbortReasons() === ['user']`（原先零断言）。
4. **工具结果只保 model 顺序，丢了完成顺序**：`toolScheduler.ts:11` 注释直言"结果严格按 model-order 提交"；
   对照 codex 显式分开发 `call_trace::result_ready`（完成顺序）与最终按序收集。
5. **完成判定是本仓相对强项且有论文支撑**：`TurnOutcome.truncated`（步数耗尽）/`aborted`（失控熔断）是一等字段并如实透传
   （`turnRunner.ts:23-26,209-210`、`agent.ts:339-352`），另有 `CompletionGate`（每回合至多一次、`changedCount===0` 时不问）。
   arXiv **2503.13657**（MAST：1600+ traces / 7 框架 / κ=0.88 / 14 种失败模式聚 3 类）把 **task verification** 列为三大失败类之一；
   LangGraph/Temporal 均无等价值。
6. **LoopGuard 多一个维度、缺三样**：有而 OpenHands 无——**文件内容指纹**（FNV-1a，注释解释为何不能复用会掩码高熵串的
   `canonicalArgs`）与 `edit-oscillation`/`edit-thrash`；缺——① 只统计"最后一条 user 消息之后"的事件
   ② **nudge-once**（避免重复重发同一 nudge）③ 把 `thought` 纳入 action 等价性。OpenHands 文档列 5 种模式但
   `_is_stuck_context_window_error` 直接 `return False`（TODO 死分支）⇒ **文档与实现不一致**。
7. **仓库迁移事实**（影响任何按老路径取证的调研）：`sst/opencode` → **`anomalyco/opencode`**（默认分支 `dev`）；
   `block/goose` → `aaif-goose/goose`；`All-Hands-AI/OpenHands` → `OpenHands/OpenHands` 且主循环已迁至
   `OpenHands/software-agent-sdk`；`Aider-AI/aider` `pushed_at` = 2026-05-22（约 4.5 个月无推送）。

**提案**

| #   | 提案                                   | 判据（离线无 key）                                                                                                                    | 人日 |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| L1  | **会话持久化加"追加通道"**（消写放大） | 新增 `tests/unit/eventPersisterAppend.test.ts` + 本地基准：追加路径与全量路径 `load()` **逐条深相等**、size 近似线性、P95 不随 N 增长 | 4–6  |
| L2  | **工具结果加"就绪（ready）"旁路事件**  | `tests/unit/toolSchedulerReadyOrder.test.ts`：假 executor 让第 3 个先 resolve ⇒ 就绪顺序=完成顺序、`results[]` 仍 model 顺序          | 2–3  |
| L3  | **取消原因保真 + 子令牌可释放**        | 补 `cancelPropagation.test.ts`（现零覆盖）：父 `cancel('shutdown')` ⇒ 所有后代 reason 正确；`child()` 1000 次后 `children.size===0`   | 1–2  |
| L4  | **回滚时复位压缩游标**（对应发现 2）   | 挂在既有 `sessionRewindService.test.ts`：回滚后游标取自截断后日志、送出的消息不含指向已移除事件的折叠标记                             | 1–2  |

**不建议采纳**：照搬 LangGraph 式"每 superstep 全量快照 checkpointer"（官方自认 checkpoint 无界增长并建议 prune；
本仓"追加日志 + 压缩游标"更省，叠加会放大写放大）；引入 `update_state` 式**可逆就地回滚**（LangGraph 的 `update_state`
刻意不回滚而是分支；本仓 `rewindTo` 的 fail-closed 越界断言与"夹取会把算错伪装成成功"的理由会被毁掉 ⇒ 要分支语义应**新增**
`fork-from-checkpoint`）；按调用间数据依赖做 DAG 调度 / 沙箱内确定性重放（工具契约无输入输出声明，codex 与本仓**都**选择静态声明；
模型调用与副作用不可确定，两家的"重放"都只在展示/证据层）。

### 3.2 上下文工程与代码检索（✅ 已完成）

**发现**

1. **RRF 早已实现、不是缺口**：`SemanticIndex.rrfMerge`（k=60 + 每路权重）+ `HybridRanker` 4–5 路融合
   （`semanticIndex.ts:130-152`、`hybridRanker.ts:82-107`）；本仓自证多探针 RRF 增益 n=33 **不显著**（+0pp [−12.12, 12.12]，
   `repoMapContextEngine.ts:41-43`）。
2. **默认嵌入是 `e5-large-v2`（1024 维），不是 e5-small-v2**（`transformersEmbeddingAdapter.ts:10-13`）
   —— 这条纠正了此前假设；混合 + 词法精排使召回 75.8% → **81.8%** 且注入 token **−16.8%**。
3. **词法二段精排证据分裂**（维持 opt-in 是对的）：@14 **+9.6pp CI[1.80,18.60]** ✅；@10 **+6.3pp CI[−0.45,14.74]** ❌
   （`fileReranker.ts:41-47`）；**通用** cross-encoder 曾试 **−1.0pp** 已归档，**代码专用 CE 未测**。
4. **无 tree-sitter / SCIP / tantivy / zoekt**（914 个 .ts 全搜确认）：符号抽取是**逐行正则**（`repoMap.ts:22-59`，文件头明写不引 tree-sitter）；
   `grep` 是进程内 JS 正则、无索引（`grepTool.ts:66-75` + `workspaceFileWalker.ts:63`）。
5. **token 记账无 BPE**：`ceil(CJK + 其余/4)`（`tokenEstimator.ts:182-186`）——压缩阈值与固定开销预留都建在这个近似上，
   偏差会直接导致越窗；对照 repomix 用 `o200k_base` 精确计数。
6. **前缀缓存排序已做对**（这是省钱的真实来源）：repo-map 作为**尾部 system 消息**，命中率 ~54% → **81%**
   （`stepContextBuilder.ts:59-63,138-141`）；DeepSeek 机制是 **cache prefix unit、须整段完全匹配**。
   但 `PrefixStability`（前缀复用率测量器，`prefixStability.ts`）**只从 `src/index.ts` 公开导出、生产路径零引用**
   （✅ 我已复核全仓引用）⇒ 仪器在，但**没有接入请求路径**，这正是 §1.3"前缀复用率无判据"的代码层证据。
7. **Anthropic 一手（contextual retrieval）**：chunk 前置 50–100 token 上下文 ⇒ 检索失败率 **−35%**，叠加 BM25 **−49%**，
   再叠 rerank **−67%**（5.7% → 3.7% → 2.9% → 1.9%）—— <https://www.anthropic.com/engineering/contextual-retrieval>。
8. **Lost in the Middle**（arXiv 2307.03172）：相关点在**首/尾**最好、**中间**显著退化，长上下文模型同样；
   **CodeRAG-Bench**（arXiv 2406.14497）：低词法重叠时检索器仍差，且**上下文受限时生成器不获益**。
   —— 注意：任务书里给的 RepoBench 编号 2306.10119 实为天体物理论文，正确为 **2306.03091**。

**提案**

| #   | 提案                                 | 动机/要点                                                          | 判据（离线无 key）                                                                                  | 人日  |
| --- | ------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----- |
| C1  | **确定性 contextual chunk**          | Anthropic 一手 −35/−49/−67%；零新依赖                              | 新写 bench：193 条 recallQueries 配对 bootstrap 95%CI + 2-fold 留出折（**CI 下界>0 且留出折为正**） | 2     |
| C2  | **代码专用 cross-encoder 离线对照**  | 外部证据强（−67%），本地仅否掉了**通用** CE                        | 同池 193 查询配对 CI + p50/p95 延迟与 RSS；**默认关**、加载失败 fail-closed 回词法                  | 3     |
| C3  | **grep 延迟/内存基线（可自我否决）** | Zoekt 的账是 3× 磁盘 / 1.2× RAM / 2 GB 下 sub-50ms，本仓**无基线** | 914 文件与合成 20000 文件两档 p50/p95/RSS；p95 远低于 50ms 即**自我否决**                           | 1(+2) |
| C4  | **token 记账精度**                   | 压缩阈值建在 chars-per-token 上，偏差 ⇒ 越窗 fail-open 400         | 对全 `src/*.ts` 用本机已缓存 tokenizer 出误差分布（median/p90/max），Rust 侧须逐位一致              | 1.5   |

**不建议采纳**：上向量数据库（语料上限 32 MiB、千级向量，**暴力余弦已亚毫秒**；BEIR 结论是 dense/sparse 常不如 BM25+rerank）；
tree-sitter 全覆盖（aider 要 17 个 grammar 仓、repomix 要 WASM + 语言文件；本仓剩余差距是**零词法交集的语义鸿沟**，
AST 不产生新词法交集；Anthropic 亦指编码 agent 靠 glob/grep JIT"bypassing … stale indexing and complex syntax trees"）；
Zoekt/tantivy 式外置引擎（index ≈3× 语料、Zoekt 还要外挂 ctags 才有符号排序 ⇒ 大依赖换回本仓已有能力）。

### 3.3 记忆与长期记忆（✅ 已完成）

**发现**

1. **本仓长期记忆"写默认开、读默认关"**：`turnRunner.ts:202` 回合末蒸馏 + `RememberTool/RecallTool` 已接线；
   但 primer 仅 `OMNI_MEMORY_PRIMER=1` 注入（`sessionInjector.ts:90`，最多 5 条，JSDoc 自陈会复述造成噪声）。
2. **真实产出物只有 15 条 fact 且质量低**：`.omniharness/longterm/memory.jsonl` = 15 条、**全部 `importance:3`**
   （`memoryExtractor.ts:79` 写死）⇒ primer 的"按重要度取 top-5"**退化为随机取**；样本含疑为幻觉的环境事实。
3. **★ 该领域头条数字大面积不可复现**（外部最强反例）：LoCoMo 第三方复现审计汇总——EverMemOS 声称 92.32% →
   独立复现 **38.38%（−53.94pp，issue 仍 open）**；Mem0 平台分复现约 **0.20**（根因：用当前日期而非数据集时间戳）；
   Mem0 论文的 A-Mem 基线与 A-Mem 原文对不上；**Zep 原报分因分子含 Category 5、分母排除而虚高，作者已承认并更正为 75.14%**。
   —— <https://raw.githubusercontent.com/dial481/locomo-audit/main/methodology/reproducibility.md>
4. **"记忆提升长任务成功率"没有 clean 独立实证**：LongMemEval/LoCoMo/MemBench/Mem0/Zep 测的都是对话记忆 QA 准确率与
   token/延迟（**代理指标**）；LongMemEval（ICLR 2025，500 题）唯一硬结论是反向的——长上下文 LLM 跨会话记忆**掉 30% 准确率**
   —— <https://arxiv.org/abs/2410.10813>；Mem0 自报图增益 **~2%**、token 省 **90%** ⇒ 收益主体是省 token 而非更准
   —— <https://arxiv.org/abs/2504.19413>。
5. **图记忆独立增益薄，且本仓同机理已被自己证伪**：最干净的独立数字是 Zep DMR **94.8% vs MemGPT 93.4%（+1.4pp，自报）**
   —— <https://arxiv.org/abs/2501.13956>；而本仓 `docs/archive/RECALL_HEADROOM_SURVEY.md:45` 实测**图检索净负面**：
   Top-14 跨查询重合度 **0.936（vs BM25 0.058）= 常量偏置、对查询不敏感**；同批还证伪了扩大候选池（5.4× 池无变化）与 LSA（精确率 25.5%→10.5%）。
6. **★ 实测的、默认断开的记忆投毒链**：`memoryExtractor.ts:117-144` 把 `tool_result`（不可信）与 user 文本不加区分拼入 transcript，
   抽取 prompt 又明确要求记住"环境事实/踩过的坑"（正是指令文本最佳伪装位）；fact 入库后由 `sessionInjector.ts:205-208`
   以 **`recorder.system(...)`** 回灌，措辞"请优先参考这些既有约定"。外部同构工作：AgentPoison（NeurIPS 2024，arXiv:2407.12784，
   **攻击成功率未读到**）。
7. **向量库在本仓约束下的取舍（registry 实测）**：`sqlite-vec@0.1.9` 有 **windows-x64 预编译**、零运行时依赖、主包 **4 KB**
   ⇒ 唯一不破坏"运行时依赖=2"的向量方案；但**最后 push 2026-05-18（落后约 4.5 个月）、210 open issues**。
   对照：LanceDB 1.4 MB JS + 2 个强制依赖；Qdrant 只是 client（需独立 server）；DuckDB 显式依赖 node-gyp/61 MB（违反零原生构建）；
   `basic-memory` 是 **AGPL-3.0**（对 Apache-2.0 有法务风险）。

**提案**

| #   | 提案                                                 | 动机/要点                                                                 | 判据（离线无 key）                                                                         | 人日 |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---- |
| M1  | **记忆增益离线判据（A/B）**                          | 全仓无任何记忆增益数字；先能判死再谈投入                                  | 新增 `scripts/memoryLiftProbe.mjs`：primer on/off 对照 + 配对 bootstrap CI 不跨 0 + 留出折 | 1.5  |
| M2  | **写入质量：近似去重 + 冲突替代**                    | 现归一化去重只抹标点大小写；被推翻的旧事实无法替代                        | 扩展 `tests/unit/memoryExtractor.test.ts`：同义改写注入 2 次 `count` 只 +1                 | 2    |
| M3  | **记忆来源信任分级（投毒闸，开 primer 的前置条件）** | `source` 扩为信任级；`tool_result` 默认不入库或入待审区；回灌加不可信标注 | 新增 `tests/unit/memoryTrustBoundary.test.ts`：含指令文本的 tool_result 不产生可回灌 fact  | 2    |

**不建议采纳**：上向量库（收益上限仅 **18.2pp** 且近似方法已被自己证伪，成本是把依赖从 2 个变成一条链，须先过 M1）；
上图/时序知识图谱（唯一干净增益 +1.4pp 且自报，最响亮数字已被作者更正虚高，本仓同机理实测净负面）；
移植外部记忆系统（AGPL/基线不可复现/Python 栈与本仓约束全冲突）。

### 3.4 工具接口 / MCP / 工具选择与 schema 预算（✅ 已完成）

**发现**

1. **MCP SDK 落后**：最新稳定规范 **2026-07-28**、SDK **1.32.0**（2026-10-02）；本仓 `@modelcontextprotocol/sdk` 实解 **1.30.0**
   （`node_modules/.../types.js` 实测 `LATEST_PROTOCOL_VERSION='2025-11-25'`）⇒ 落后一个完整修订 + 2 个补丁。
2. **2026-07-28 是破坏性修订**：删协议级会话与 `Mcp-Session-Id`、删 `initialize` 握手转无状态、新增 `server/discover`、
   `subscriptions/listen` 取代 HTTP GET、MRTR 取代 roots/sampling/elicitation、结果新增必填 `resultType`、list 必带 `ttlMs`/`cacheScope`。
3. **Roots/Sampling/Logging 整体弃用**（SEP-2577）；OAuth DCR（RFC 7591）弃用改 **CIMD**；新增"最短 12 个月弃用窗口"政策。
4. **schema 预算实证**：RAG-MCP（arXiv **2505.03275**）工具检索使 prompt token 降 **>50%**、选择准确率 **43.13% vs 13.62%**；
   Anthropic 一手：Claude Code 默认把工具响应限在 **25,000 token**、detailed 206 vs concise 72 token；
   playwright-mcp README 自述编码 agent 正转向 CLI+SKILL 以避免大 schema 入库。
5. **本仓处方同构但检索器偏弱**：`toolExposurePlanner`（503 行）是**词法类别命中 + 子串正则**；`tool_search` 是 **BM25 词法**。
6. **错误语义与配对不变量本仓已正确**：`stepToolExecutor.ts:169-178` 让模型看到可行动错误（规范 SHOULD）；`:98-105` 显式保证
   `tool_call` 必有配对 `tool_result`（否则上游 HTTP 400）；并行是工具级静态声明 + 有界池 8 + allSettled 保序（无数据依赖分析）。
7. **安全**：CVE-2025-49596（MCP Inspector <0.14.1，**CVSS 4.0 = 9.4**）；postmark-mcp 首个在野恶意 MCP server；
   Invariant 证明 **shadowing is enough**（恶意 server 无需被调用即可改写可信 server 的工具行为）；规范硬约束
   annotations **MUST 视为不可信**。
8. **(未独立验证)** OpenAI function calling 指南（403）、Anthropic parallel-tool-use 页（跨源重定向）、github-mcp-server 元数据（API 限流）。

**提案**

| #   | 提案                                                                | 动机/要点                                                                                                             | 判据（离线无 key）                                                                                 | 人日 |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---- |
| T1  | **SDK 1.30.0 → 1.32.0（保守，不碰 v2）**                            | 白拿 body/batch 尺寸上限（1.30.1）、OAuth issuer 绑定（1.31.0）、`maxToolInputElements` + audience 校验（1.32.0）     | `npm run build && npm test` + 断言 `SUPPORTED_PROTOCOL_VERSIONS` 仍含 2025-06-18                   | 0.5  |
| T2  | **planner 上加 BM25 检索优先 + `tools/list` 确定性排序**            | 规范处方是"先检索再给模型"；确定性顺序提升 prompt cache 命中                                                          | `OMNI_TOOL_EXPOSURE=plan` 下确定性对比（同输入恒同输出 + 必需工具召回 100%）                       | 2–3  |
| T3  | **适配器补齐 `structuredContent`/`outputSchema` 与 `isError` 分流** | `sdkMcpClientAdapter.ts:141-147` 现在**丢弃结构化输出**；`:411-414` 把 image/audio/resource_link 等块收敛为**空文本** | 本地 stdio 假 server 夹具：返回 structuredContent + image 块 + isError，断言不丢块、isError 不被吞 | 1.5  |

**不建议采纳**：升到 SDK v2.x 分线（破坏性 + 单人维护，收益面窄）；跟进 2026-07-28 无状态/MRTR 重写（整修订级，且
Roots/Sampling/Logging 同期弃用）；自研 OAuth/CIMD（STDIO 规范本就 SHOULD NOT 走 OAuth）。

### 3.5 安全：沙箱 / 审批 / 注入防护（✅ 已完成）

**发现**（本仓读码部分我已复核，标 ✅ 者为我自己验证过）

1. **默认档零 OS 边界** ✅：`appServerBase.ts:245` 硬编码 `file.sandbox ?? 'policy'`；`policy`/`restricted` 是纯 TS
   字符串黑名单 + 工作区路径白名单（`restrictedSandbox.ts:20-54,93-106`），**无任何内核强制**。
2. **Windows"OS 级"后端只有半个令牌** ✅：`crates/omni-core/src/restricted_token.rs:281-292` 调
   `CreateRestrictedToken(token, DISABLE_MAX_PRIVILEGE, 0, null, 0, null, 0, null, …)`——**三个计数参数全 0**。
   按微软官方文档（CreateRestrictedToken / Restricted Tokens），**只有 restricting SID 才产生"两次访问检查、
   均放行才放行"的拒绝默认** ⇒ 该后端**没有文件/网络约束**，只删特权 + Job Object 限额（256 MB/进程、1 GB/job、4 进程）
   - 关句柄即杀。未设 `JOB_OBJECT_UILIMIT_*`、未换桌面（官方要求换桌面以阻 SendMessage/PostMessage）。
     —— <https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken>
3. **【关键结论】不付费 + 支持 Windows 下可达的最强隔离 = L3，只有两条路**：
   **(a) AppContainer + 宿主路径 DACL**（微软自家 MXC 定义其为"T3 通用回退：23H2/24H2/25H2 上所有文件系统策略
   均由宿主路径 DACL 强制"；网络靠 AppContainer 能力 + `netsh advfirewall`，**后者需要管理员**）；
   **(b) WSL2 utility VM 内跑 bubblewrap/landlock**（`automount=false` + `interop=false` + `networkingMode=none`
   可同时关掉 `/mnt/c`、Windows 进程互操作与网络）。原生无 DACL 副作用的 PSEC/T1 **仅 Windows 11 25H2+**。
   当前实现的定位是 **L2（同用户进程内约束）**。
   —— MXC README：<https://raw.githubusercontent.com/microsoft/mxc/refs/heads/main/README.md>
4. **Windows Sandbox 不能做逐命令沙箱**：官方/MXC 文档明确"每次调用付整个 VM 冷启动成本""每登录会话只能有 1 个 VM"
   "网络只能全封（block-only）"，且 Home 版不支持、启用需重启。
5. **出网守卫有结构性盲区**：`networkEgressGuard.ts` 文件头自述**只包 `globalThis.fetch`**且默认开放 ⇒
   shell 子进程的 `curl`/`certutil`/原生 socket **全不走这条路**；`restrictedSandbox` 的下载器黑名单只是字符串补丁
   （代码注释自认是 2026-10-01 审计漏项）。
6. **可撤销性只覆盖文件面**：`applyPatchTool.ts`（两阶段提交 + 回滚 + `.bak`）与 `GitWorkspaceSnapshot` +
   `checkpointManager` 已接线（`configToolRegistry.ts:334`），但 **shell/网络副作用不可回滚**，
   且快照基于 `git status --porcelain` ⇒ `.env`、构建产物等**被忽略文件不在快照内**。
7. **记忆档位与风险错配** ✅（我复核）：`toolOutputTrust.ts:37-43` 把 `memorySearch`/`recall` 归 **`file` 档（阈值 2）**，
   比一次性 `external`（阈值 1）**更宽松**，而记忆是**跨会话持久**的投毒载体 —— 与 §3.3 发现 6 相互印证。
8. **注入护栏默认不改变行为，且默认值是 `off` 而非 `shadow`（本机复核纠正）**：解析器把 `false / undefined`
   归一化为 **`off`**（`enforcementModeResolver.ts:33` 的 `MODES` 与归一化注释），而 `configFactory.ts:191-194`
   只在显式传入字符串时才解析 ⇒ **未配置时生产默认是"完全不跑"**（比 `shadow` 更保守）。
   调研员原稿称"生产默认 `shadow`"，**此处以我的复核为准**；另：原注入度量脚本已随评测子系统删除，
   故"护栏有效率"**当前零证据**。
9. **防御手段的实证强度**（一手论文）：CaMeL 在 AgentDojo 上 **77% 可证安全 vs 无防御 84%**（arXiv 2503.18813）；
   Spotlighting 把 ASR 从 **>50% 压到 <2%**（arXiv 2403.14720）；InjecAgent **1054 例 / 17 user + 62 attacker 工具**，
   GPT-4 ReAct 攻击成功率 24%（arXiv 2403.02691）；AgentDojo **97 任务 / 629 用例**（arXiv 2406.13352）。

**提案**

| #   | 提案                                                        | 动机/要点                                                             | 判据                                                                                                                                                                                                                           | 人日 |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| X1  | **Windows `appcontainer` 后端（AppContainer + 宿主 DACL）** | 唯一"不付费 + 非 VM + 非管理员"的 Windows 文件强制面，对齐微软 MXC T3 | `omniharness doctor` 报 `appcontainer` 可达；单测断言沙箱内读 `%USERPROFILE%\.ssh` 得 ACCESS_DENIED、工作区读写成功、未授权出网被拒、**`Drop`/失败路径后 `icacls` 快照与执行前逐条相等**                                       | 6–9  |
| X2  | **shell 出网带外收口 + 会话授权预算**                       | "以为断网其实没断"是最危险的错觉                                      | 断言 `policy`/`restricted` 档下 `curl` 与 `Invoke-WebRequest` 均被拒且 reason 说明"带外通道不受 fetch 守卫覆盖"；同一危险命令第 N+1 次重新审批                                                                                 | 2–3  |
| X3  | **重建安全判据 + 收紧记忆档**                               | "护栏有效"当前零证据；记忆类不该比一次性 external 更宽松              | 新增 `tests/unit/{sandboxCapabilityMatrix,sandboxFailClosedMatrix,injectionGuardRates}.test.ts`：`off\|shadow\|enforce` × `external\|file\|local` 的 (FP,FN) 表可复现，且**新对抗样本必须打穿 enforce 档**（证明判据有区分力） | 3–4  |

**不建议采纳**：上 Firecracker（官方 README 明说依赖 **KVM**、tested platforms 全为 Linux 宿主，**无任何 Windows 宿主表述**；
要 VM 级应走 microsandbox（README 声明 WHP）或先做 WSL2 路线）；用 Windows Sandbox 做逐命令沙箱（见发现 4）；
把 MXC / OpenHands 当既有安全边界（MXC 自述"known cases … are **overly permissive**""**no MXC profiles should be treated as
security boundaries currently**"；OpenHands 无沙箱档自述"full access to your filesystem"）——**可借鉴设计，不可写进威胁模型当已隔离**。

### 3.6 多代理编排与子代理（✅ 已完成）

**发现**

1. **子代理写入静默丢弃**（本仓最高危，已由我独立复核）：`subagentOrchestrator.ts:62-77` 建 worktree → `finally` cleanup；
   `worktreeOps.ts:74-97` cleanup = `git worktree remove --force` + **`git branch -D`**；`subagentResult.ts:9-19` 无 diff/sha 字段；
   `WorktreeOps` 全仓仅 2 处引用 ⇒ 无合并路径；父代理仍收到 `ok:true`。
2. **两条并发路径隔离语义相反**（已独立复核）：`workflowRunner.ts:206` docstring 自称"隔离子智能体"，`:220/:223` 实际传父级 ports，
   同层并发（默认 4）直接写父工作区、无冲突检测。
3. **Anthropic 成本数字**：多代理 **15×** chat tokens、单 agent **4×**；token 用量单独解释 BrowseComp **80%** 方差；质量 **+90.2%**
   —— <https://www.anthropic.com/engineering/multi-agent-research-system>。
4. **Cognition 已自我修订**（2025-06《Don't Build Multi-Agents》→ 2026-04《Multi-Agents: What's Actually Working》）：
   仍坚持"parallel-writer swarms 不成立"，改为 **"writes stay single-threaded + 其他 agent 只贡献 intelligence"**；
   并实测**干净上下文的 reviewer 更优**（每 PR 均抓 2 个 bug、58% 为严重）—— <https://cognition.com/blog/multi-agents-working>。
5. **C 编译器项目的反证**：16 agents / ~2000 sessions / **2B input + 140M output tokens** / <$20,000 / 100k 行；
   但 Linux 内核作为"one giant task"时 **16 个 agent 全撞同一 bug 并互相覆盖改动**，靠 GCC oracle 重构出独立性才恢复并行；
   官方做法不是 worktree 而是 **Docker + 共享 upstream + pull/merge/push + 文件锁**，且自述 merge 冲突频繁。
6. **对照研究**：arXiv **2606.13003**《The Illusion of Multi-Agent Advantage》——自动生成 MAS **一致劣于** CoT-SC 单代理却**贵至 10×**，
   只有专家手工设计的 MAS 占优；arXiv **2503.13657**（NeurIPS 2025 D&B）MAST：**1600+ trace / 7 框架 / 14 种失败模式 / 3 大类**（κ=0.88）。
7. **本仓 `a2a` 不是 A2A**：`a2aProtocol.ts:14,16` 用自定义方法 `capabilities.declare`/`task.delegate`；规范 v1.0.0 是
   `message/send` 等六操作 + `/.well-known/agent-card.json` 的 AgentCard ⇒ **零第三方互操作性**（`google/A2A` 已重定向至 `a2aproject/A2A`）。

**方向判断：收敛写入型子代理，加强只读型**（三条一手材料（Anthropic artifact 引用、Cognition 单写者、MAST misalignment）指向同一结论）。

**提案**

| #   | 提案                                       | 动机/要点                                                                 | 判据（离线无 key）                                                                      | 人日 |
| --- | ------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---- |
| S1  | **`isolatedWrite` fail-closed 门禁**       | 子代理工具视图剔除写类工具；父级授权写工具时明确拒绝而非静默丢弃          | 新增 `tests/unit/subagentWriteGate.test.ts`：视图不含 write/edit；带写工具时 `ok:false` | 1.5  |
| S2  | **worktree 产出改"持久化 + 引用"而非删除** | 对齐 Anthropic"artifact systems 回传轻量引用"；比合并便宜且规避并行写冲突 | 现有 `worktree.test.ts:80-90`（worktree 内写文件）改为断言**清理后可取回 patch**        | 2.5  |
| S3  | **`run_workflow` 隔离语义显式化**          | docstring 与实际相反；同层同文件写入应 fail-closed 或复用 worktree        | `tests/unit/workflowRunnerLimits.test.ts` 增：同层两步写同一文件 ⇒ 拒绝                 | 2    |
| S4  | **`maxDepth` 接上 CLI**                    | 目前只有 `--subagent-concurrency`/`--subagent-max-steps`，深度用户改不动  | CLI 参数解析单测                                                                        | 0.5  |

**不建议采纳**：并行写入型子代理（多写者 swarm）（Cognition 两篇一致反对 + C 编译器覆盖事故 + MAST inter-agent misalignment）；
按 A2A v1.0 全量重写 `src/a2a/**`（单人维护、无第三方消费者；**低成本替代**：把文档/命名从"A2A 互操作"改为"私有 JSON-RPC 委托协议"，
消除虚假互操作承诺）；给子代理加"完整上下文 fork"（作者自评在弱主模型上没跑通，且与本仓隔离+重定位存储冲突）。

### 3.7 可观测性与评测方法学（✅ 已完成）

**发现**

1. **OpenTelemetry 的 GenAI 语义约定已迁出主仓**：现址 `open-telemetry/semantic-conventions-genai`
   （2026-05-05 建、pushed_at 2026-10-02、403 stars、203 open issues）；主仓与 opentelemetry.io 的 gen-ai 页
   只剩 "Moved" 页；**新仓的 `## Schema URL` 仍是 TODO**。
2. **GenAI 约定全线 `Development`、没有一个 `Stable`**：9 个文档（spans / agent-spans / metrics / token-metrics /
   events / exceptions / mcp / openai / anthropic）的 `**Status**` 全为 Development，`gen_ai.operation.name` 的
   **19 个 well-known 值也全部 Development**；最新版本 **v1.44.0**（发布日期未读到，API 限流）。
   ⇒ **现在按它硬改名是单向门**，应"加字段不改名"。
3. **命名口径关键点**：span name SHOULD = `{gen_ai.operation.name} {gen_ai.request.model}`，工具侧
   `execute_tool {gen_ai.tool.name}`；token 侧**已不是** `gen_ai.client.token.usage`，而是 7 个
   `gen_ai.client.inference.usage.*`；且原文脚注明确 **`cache_read` 是 `input_tokens` 的子集**
   ⇒ 缓存读 token **绝不能与输入相加**（本仓 `tokenAttribution.ts:130` 的口径是对的，这点值得记功）。
4. **本仓 trace 与 semconv 全面不符（读码，带行号）**：`traceSpanBuilder.ts:107/180/212` 发 `session` /
   `tool.${name}` / `model.${model}`，属性 `tool.*` `tokens.*` `session.*` **无 `gen_ai.` 前缀**；`:286-291`
   把数值属性塞进 **`stringValue`**（OTLP 有 `intValue`/`doubleValue`）⇒ 任何标准 GenAI 后端都**无法自动解读**；
   `:253-255` 时间戳解析失败回落 `Date.now()`（**破坏确定性**）；`otlpTraceExporter.ts:102-104` 导出失败
   `catch {}` **零可见性**；**全仓无指标导出**；`traceCollectingEventPort.ts:61-68` 只在 `session_meta` 冲刷
   ⇒ 服务端多会话会**串会话**。
5. **★ "跑分不重要"有了量化依据（本轮最有用的一条外部证据）**：Anthropic 的 Miller（arXiv **2411.00640**）
   工作示例——δ=0.03、80% power、α=0.05 ⇒ **n≈969 道独立题**，原文结论是"新评测至少应有 1,000 道题"；
   同文还反直觉地指出"除非采样方案/估计量复杂，**bootstrap 并非必需**"，推荐**题目级配对差值**。
   可抄的工程口径（Inspect）：二值分数优先 **Wilson 区间**、聚类用 `stderr(cluster=…)`、`bootstrap_stderr()`
   默认 **1000** 次。
6. **pass@k 与 pass^k 不是一回事**：pass@k 的无偏估计量含 `C(n−c,k)/C(n,k)`，而 `1−(1−p̂)^k` **有偏**（奖励方差）；
   **pass^k 的确切出处是 τ-bench（arXiv 2406.12045）**，其 README 实测 Pass^1→Pass^4：retail 0.692→**0.462**、
   airline 0.460→**0.225**（该 README 同时已告警任务停更、改用 τ³-bench）。
7. **judge 的可信度是两极的**：GPT-4 judge 与人类一致性 **>80%**（arXiv 2306.05685）；但**仅调换顺序**就能让
   Vicuna-13B 在 80 题里**赢 66 题**（arXiv 2305.17926）；JudgeBench 里 GPT-4o **仅略优于随机**（arXiv 2410.12784）；
   self-preference 的机制被定位为**困惑度**而非"自产文本"（arXiv 2410.21819）⇒ **换 judge 模型不解决问题**。
8. **★ harness 本身是未被控制的巨大变量（与本项目最相关）**：在 Terminal-Bench Pro 的 50 题子集上实测，
   **harness 选择造成"每解一题 token 数"最多 40× 差异**，而同一模型内配对通过率差异只有 **0–8 个百分点**
   （95% 配对 bootstrap CI 多含 0）；失败指纹跨模型可复现 ⇒ harness 级偏差基本与模型无关。
   ⇒ **报通过率必须同时报 token/latency/harness 规格**；这也解释了为什么"跑分"对改进 harness 的信噪比很低。
   （该结论来自 arXiv 2607.22585；调研员**只读到摘要，未读正文**。）

**提案**

| #   | 提案                                           | 要点                                                                                                                                                                                                                                                         | 判据（离线无 key）                                                                                         | 人日 |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---- |
| O1  | **最小行为回归守卫**（与 §4 的 G1 同源）       | 复用现有 `src/core/scriptedModel.ts`（确定性、零 key）+ 真实 Agent 主循环，断言**行为不变量而非分数**：工具调用次数与顺序、审批/沙箱是否拒绝、落盘事件条数、`TokenAttribution` 桶和 == 总量；trace 侧注入 `traceIdFactory/spanIdFactory` 做 golden span 快照 | 故意改坏一个工具名，新用例**必红**；`npm test` 必绿                                                        | 1.5  |
| O2  | **OTLP 属性与 semconv 对齐（加字段、不改名）** | 数值属性改 `intValue`/`doubleValue`；**并行**发 `gen_ai.*` 标准键，保留现有键作过渡                                                                                                                                                                          | 新增 `tests/unit/genAiSemconvConformance.test.ts` 钉住属性名与**依据版本号**（上游一变就红，主动发现漂移） | 2    |
| O3  | **自观测计数器（把"静默丢弃"变成数字）**       | 丢弃批/span、孤儿 `tool_result`、未闭合调用、串会话计数；**只读字段、不发警告、不改业务分支**（照抄本仓 `cacheHitRateCollector` 的"无样本时给 `samples:0`"范式）                                                                                             | 注入必失败的 `fetchImpl` ⇒ 断言 `droppedSpans` 严格递增且 `flush()` **仍不抛错**                           | 1    |
| O4  | **一次性离线对账脚本**（不进 CI）              | 读落盘事件 → 跑 `TokenAttribution` → 断言 Σ桶 == Σ(prompt+completion)，并单列 `modelCallsWithoutUsage`（固定"缓存读不计入 total"口径）                                                                                                                       | `node scripts/observabilityReconcile.mjs` 退出码（纯离线）                                                 | 1    |

**不建议采纳**：重新引入重型基准 CI（发现 5/8：要检出 3pp 需 **n≈969**，且 harness 造成 token 差异达 **40×**，
对"改进 harness"信噪比极低；Terminal-Bench 官方 README 自己标 **beta、约 100 任务**并建议改用新工具）；
把 LLM-as-judge 当主判据（顺序可操纵、难例近随机、self-preference 源于困惑度；若必须用，须先做人类标签校准并报
**Cohen's Kappa** 而非 raw agreement，且强制双向顺序对调）；为对齐 semconv 引入 `@opentelemetry/*` SDK（Development 面
会把上游 breaking 变更变成硬伤，且新增依赖要走 `dependency-allowlist.json` 五件套）；按 semconv **一次性重命名**现有键
（上游未稳定时改名是单向门，加字段才是双向门）。

### 3.8 原生内核与性能（Rust / NAPI / WASM / Node）（✅ 已完成，**结论与本仓既有假设相反**）

**发现（全部为本机实测，脚本在 `.omniharness`/scratch，口径随文给出）**

1. **★ token 记账下沉 Rust 是净亏（推翻"下沉即加速"）**：同语料 1,108 条 / 775,600 字符，
   TS 纯计数 **6.12 ms**，走 native `context.estimate` **27.8–40.7 ms（慢 4.5–6.7×）**。
   根因是**封送成本占主导**：`JSON.stringify` 单项就 **12.08 ms / 925 KB，占 native 全往返 29.7%**，
   且 Rust 侧**无缓存**（`handler.rs:143-155` 每条从零扫 `chars()`），而 TS 侧已有 LRU + 零分配。
2. **绑定层从来不是瓶颈**：NAPI 小往返 **7.3 µs**、WASM 16.8 µs（2.3×），**大 payload 只差 1.17×**；
   体积 5.33 MiB vs **206 KiB**（WASM 小 26×）。⇒ 绑定选型是**分发议题**，不是性能议题。
3. **worker_threads 在本场景实测反效**：1 worker 编码 256 段 **0.69×（更慢）**，2 worker 仍慢于主线程
   （5,837 vs 3,061 ms），冷启动 **1,877 ms** —— 因为 onnxruntime-node 内部已吃满 8 核。
   Node 官方文档亦只说 worker 适合 CPU 密集的 **JS**，并建议用池，否则"开销很可能超过收益"。
4. **真正阻塞事件循环的是 ONNX 编码（✅ 机制我已复核）**：64 段编码 = 墙钟 661 ms，
   `eventLoopUtilization = 1.0000`、idle = 0、`monitorEventLoopDelay().max = **524.6 ms**`；
   根因是 `onnxruntime-node/dist/backend.js:113-125` 用 `setImmediate` 包住**同步**的 C++ `InferenceSession.run`
   （我已读到该 `setImmediate(() => …run(...))`）。
5. **tokenizer 不是瓶颈**：实测 **450,000 token/s**（占嵌入流水线 0.72%）；且 `@huggingface/tokenizers@0.1.3`
   的 `dist/` **全是 JS、无 `.wasm`/`.node`** ⇒ HF 的 Rust tokenizers 在这条路径上**根本没被使用**，
   "tokenization 下沉 Rust"是**空优化**。
6. **批构成噪声独立复现且更大**：本机 e5-small-v2/q8 下 `solo` vs `batch(32)` 分量最大差 **9.093e-3**
   （此前看板记 6.3e-3），同构重跑逐位为 0；**batch_size 对吞吐几乎零影响**（49.8/50.0/48.7 texts/s）。
   ⇒ 与看板 §4 的"可比性边界"结论一致，且量级更保守。
7. **口径洞（已知但无护栏）**：TS 按 **UTF-16 码元**、Rust 按 `char` 计数 ⇒ 星光面字符不一致，
   实测 `'😀😀😀😀'` **TS=6 / Rust=5**；`nativeTokenEstimator.test.ts:27-30` 注释已知此事但**无测试**
   （BMP 大样本两侧严格一致：271,760 ⇔ 271,760）。
8. **平台事实**：`omni-napi` 是 **Windows 专属**（`lib.rs:18` `#![cfg(windows)]`），手写 6 个 napi 符号、
   无 async work；`omni-wasm` **缺 `context.estimate`**（其注释自称"同一套方法面"已不准确）。
9. **建议入决策文档的量化门槛**（本次调研产出）：单次 CPU ≥5 ms 且频次 ≤10³/会话、
   **封送比 < 1/3**、单次同步段 ≤50 ms、跨平台/崩溃隔离是真实需求。
   **按此门槛，本仓库现存热点没有一个值得继续下沉 Rust。**

**提案**

| #   | 提案                                          | 要点                                                                        | 判据                                                                  | 人日  |
| --- | --------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----- |
| U1  | **`context.estimate` 默认走法翻回 TS**        | 实测慢 4.5–6.7× 且原生无缓存；Rust 侧**零改动**，保留为诊断                 | 基准 ≤6.12 ms 且 `nativeTokenEstimator.test.ts` 全绿                  | 0.5   |
| U2  | **嵌入编码切片让出事件循环**（不是加 worker） | `max` 事件循环延迟 524.6 ms 超阈 5.2×；worker 实测反效                      | `monitorEventLoopDelay().max ≤100 ms` 且总墙钟劣化 ≤10%、向量逐位相同 | 1.5–2 |
| U3  | **内核 RPC 换非 JSON 封送**                   | `stringify` 单项 12.08 ms 是与语言无关的最大自有开销                        | 封送 ≤4 ms、native 全往返 ≤15 ms；string 入口并存自动回退             | 2–3   |
| U4  | **WASM 重定位为跨平台主路径**                 | 大 payload 仅慢 1.17×、体积小 26×、有崩溃隔离；native 在非 Windows 编译为空 | `wasm:test` 绿 + TS/native/wasm 三路在 1,108 条语料上逐位相同         | 1.5   |

**不建议采纳**：继续把记账/算子下沉 Rust（实测反向 6.7:1，超门槛，除非先做 U3）；
引入 worker_threads 池"加速"CPU 任务（0.69×、冷启动 1.9 s、ONNX 自身已满核）；为跨平台整体重写 WASM 或
用子进程做性能隔离（仅 1.17× 差，却丢掉真实时钟/进程/OS 沙箱）；以性能为由换/不换 napi-rs（绑定层 7.3 µs 可忽略）。

### 3.9 自验证与完成判定（✅ 已完成）

**发现**

1. **"假完成"已被一手量化且高频**：ICML 2026 在 **9,876 条 τ²-bench 轨迹 / 8 个模型族**上测得假成功占
   **单控制域失败轨迹的 45–48%**，双控制域仅 3%（人工标注一致率 91.5%、κ=0.86）
   —— <https://icml.cc/virtual/2026/77904>；Zenodo 预注册实验（2,862 episodes / 7 模型 / <$1 算力）把该现象
   命名为 **false-DONE**，且测得最强模型各难度下 0 次假完成 ⇒ **假完成率是"模型的属性"**
   —— <https://zenodo.org/records/21698264>；MAST 把 **task verification** 列为三大失效类之一（κ=0.88）。
2. **模型裁判不如机械检测器**：judge 检测假成功的 **AUROC 上限 0.65**，而轻量机械检测器 **0.83**（次毫秒级）；
   judge 会被"自信的收尾措辞"抬高 **0.27–0.36** ⇒ **关键变量是"声明有没有权威"，不是"用不用模型"**。
3. **执行反馈有效、拓扑精炼无效**：HumanEval 76.6 → **94.0（+17.4，4.7σ）**、MBPP +30.4（4.9σ），
   且**全部在单机 1–3B 本地推理**完成（与本仓"无 key + 离线"同构）；跨模型精炼无差异（0.1σ）。
   反例：**无外部反馈的自我精炼会掉分**（
   <https://arxiv.org/abs/2310.01798>），不做早停时每次迭代净为负、**43–62% 初始正确的代码被改坏**。
4. **✅ 我已复核的本仓 fail-open 漏洞**：`node --test` **零匹配时 exit = 0** 并打印 `# tests 0`（Node v22.20.0 实测），
   而 `src/adapters/tool/verify/turnEndCompletionGate.ts:78` 的判据只有 `outcome.exitCode !== 0` ⇒
   **"一条测试都没跑"会被判成"验证通过"**。主流工具刻意区分二者：pytest 把"没收集到测试"单列 **exit 5**，
   Jest 需显式 `--passWithNoTests` 才允许空跑通过。（已登记看板 §8.6）
5. **覆盖率只能当下限**：Inozemtseva & Holmes（ICSE 2014）结论是"高覆盖并不表明测试套件有效"
   （原文相关系数未读到）。

**提案**

| #   | 提案                                       | 要点                                                                                  | 判据（桩模型 + 离线）                                                                                | 人日    |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------- |
| V1  | **计数感知的完成判据**（对应发现 4）       | 解析 `# tests N` / `N passed` / pytest `collected 0 items`；`tests == 0` 判**未验证** | `ScriptedModel` 桩回合：`# tests 0` 且 exit 0 **必须拦截**；`# tests 12 / # fail 0` 必须放行         | 1.0     |
| V2  | **`unverified` 提升为一等完成状态**        | 第二次声明完成当前**无条件** break（`turnRunner.ts:129`）                             | 脚本「写 → "改好了" → "真改好了"」+ 恒失败 runner ⇒ 结果只能是 `failed\|unverified`，绝不为 `passed` | 1.0     |
| V3  | **"无证据完成"检测**（LoopGuard 空步盲区） | 新增 `evidence-free-completion`（改过代码却从不跑命令就宣布完成）                     | 脚本触发（先 nudge 后 abort）；纯问答回合**不得**触发                                                | 0.5–1.0 |

**不建议采纳**：拿 verifier/LLM 当完成判据（AUROC 0.65 < 机械 0.83；措辞即可抬高 0.27–0.36；
且关键在"声明是否具权威性"，加一层 judge 仍只是 advisory）；无早停的自我精炼/自我批评循环
（无外部反馈会掉分，43–62% 初始正确代码被改坏）。

### 3.10 Web 工作台架构与 agent UX（✅ 已完成）

> **前提订正**：本项目此前多处（含看板）称 `web/src` 是"自绘 React 垫片"。**实测不成立**——运行时是
> **官方 React 18.3.1 UMD**（`web/vendor/react.production.min.js` 10.5 KB + `react-dom…` 128.7 KB，
> 由 `index.html` 以 `<script>` 直载），架构特点是**零打包器**（`tsc` 直出 ESM）；真正手写的是
> **类型声明**（原先那份 ≈5.5 KB 的手写 React 衬片，**已于第九轮 G11/W1 删除**，换成官方
> `@types/react` + 只做转引的 `reactGlobals.d.ts`）与自研分词器 `ui/highlight.ts`（357 行）。

**发现**

1. **"两套 DOM 所有权"是按年计的成本**（支持"不要重写渲染层"）：NYT 的 ProseMirror 集成复盘指出
   state tearing / layout effect 顺序问题需要长期投入 —— <https://smoores.dev/post/why_i_rebuilt_prosemirror_view/>；
   Preact 官方目标是"不做全兼容"且明说"要全兼容不如直接给 React 上游提交优化"
   —— <https://preactjs.com/about/project-goals>。
2. **长流式渲染的真实约束**：xterm.js 官方 flow control —— **<16 ms/帧、吞吐 5–35 MB/s、写缓冲 50 MB 上限
   超出即丢弃**，并要求自建 WS ACK 背压 —— <https://xtermjs.org/docs/guides/flowcontrol/>；
   `content-visibility: auto` 必须配 `contain-intrinsic-size`，且只适用于首屏外自包含大块
   —— <https://github.com/GoogleChrome/modern-web-guidance-src/blob/main/guides/performance/defer-rendering-heavy-content/guide.md>。
3. **diff 视图的重量级现实**：shiki 官方自陈 `bundle/full` = **6.4 MB min / 1.2 MB gzip**，Web 场景须
   fine-grained + Worker —— <https://shiki.style/guide/bundles> ⇒ 与本仓"零打包器 + 零网络依赖"不变量冲突。
4. **交互基线（一手文档）**：opencode 权限 = `allow/ask/deny` 三态 + **最后匹配胜出** + 弹窗
   `once/always/reject` + **`deny` 永不放行** + `doom_loop`/`external_directory` 默认 ask + `.env` 默认 deny
   —— <https://opencode.ai/docs/permissions/>；Roo Code = **Enabled 主开关与逐项解耦**、命令
   **前缀 allow + deny 双表最长前缀胜（等具体度 deny 优先）**、危险替换守卫、写入后 write-delay 等 IDE 诊断
   —— <https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions/>；
   Cline = **每次工具调用后**建 shadow-git checkpoint + Restore 三维正交（Task&Workspace / Task / Workspace），
   定位为"auto-approve 的安全网" —— <https://github.com/cline/cline/blob/main/docs/exploring-clines-tools/checkpoints.mdx>；
   VS Code 官方：设 `webview.html` **等于重载并重置脚本状态** ⇒ **视图状态必须与内容分离持久化**
   —— <https://code.visualstudio.com/api/extension-guides/webview>。
5. ~~**死负载 ≈120 KB**~~ **（2026-10-03 第九轮复核：误判，已订正——`markdown.ts` 的 `hasDeps()` 要求 `window.hljs`，markdown-it 的 `highlight:` 选项就调 `hljs.highlight`；该脚本是**活依赖**，删掉会让代码块静默失色。已加契约测试防误删）**：`index.html:47` 仍加载 `vendor/highlight.min.js`（118.9 KB）+ `highlight-github-dark.min.css`，
   而自研 `ui/highlight.ts` 已存在（注释写明不引 highlight.js）。**注**：该"死负载"结论来自调研员读码，
   我只复核了 vendor 体积与 `index.html` 的加载行，**未验证运行时是否仍走自研分词器**。

**提案**

| #   | 提案                                                     | 要点                                                                       | 判据（`npm run web:test`）                                        | 人日    |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------- |
| W1  | **类型层换官方 `@types/react`**                          | 消灭手写声明维护税；**运行时仍走 vendor UMD，不加打包器**                  | 类型检查（`tsc -p web/tsconfig.json`）零错误 + web 测试全绿       | 1.5–2.5 |
| W2  | **流式块内二次虚拟化 + 活跃尾块 + `content-visibility`** | 对应 xterm/content-visibility 的官方约束                                   | 扩 `longSessionPerf`：1 万 chunk 时 **DOM 节点数不随 chunk 增长** | 3–5     |
| W3  | **审批三态 + 会话内模式记忆 + 批量暂存批准 + 一键撤销**  | 对齐 opencode/Roo Code 的"once/always/reject + deny 永不放行 + 最长前缀胜" | web 单测 + 手工核对"一次 always 不会变成长期放行"                 | 4–6     |
| W4  | **删掉 ≈120 KB 死负载**（先验证再删）                    | 零风险收益                                                                 | `index.html` 不再加载 highlight；渲染回归由 web 测试覆盖          | 0.5     |

**结论**：**保留运行时与零打包器架构，不要重写渲染层**（重写净收益为负：本仓"自绘"其实只剩类型声明 + 分词器 + 视图模型）；
**不建议采纳**：自研 reconciler / 换 Preact 省体积（证据双向反对，且与 42 个 web 测试与 `deps.ts` 冲突）；
为 diff 引入 Monaco 或整包 shiki（需 worker/静态资源，破坏零打包器与零网络依赖不变量）。

### 3.11 TypeScript 架构与可扩展性（✅ 已完成，含对本文档若干口径的订正）

**口径订正（调研员读码纠正，我采纳）**：① "22 个 assembler 文件"**不成立**——仓内 `*Assembler.ts` 只有 **6 个**，
`src/config` 恰好 22 个 `.ts`（此前的说法把两者混为一谈）；② 单文件行数上限实为 `check.mjs` 的
**`MAX_FILE_LINES = 810`**（不是 800），而 `auditStandards` 的**上帝类**判据是 **代码行 >500 或 方法 >25**；
③ "禁 `any` / 显式访问修饰符"是 **ESLint 原生规则**，**不是自研 AST 脚本**（自研脚本管的是行数/文件名=类名/顶层函数/接线）；
④ `zod` 在 `src/` 里**只有 1 处 import**（MCP 适配器），且它是 **MCP SDK 的非 optional peer**。

**发现**

1. **组合根现状是"教科书正确"的**：Seemann 的原始定义即"DI Container 只许出现在 Composition Root"，
   Pure DI 是合法实现 —— <https://blog.ploeh.dk/2011/07/28/CompositionRoot/>；本仓 `src/core/container.ts` 仅 **56 行**、
   消费者 **11 个文件**、**无 locator 泄漏**（服务定位器反模式未出现）。
2. **容器路线的真实代价**：NestJS 强制 `reflect-metadata` peer，且官方明写**接口在编译期被擦除、不能作 DI 令牌**
   （须改 Symbol/抽象类）⇒ 与本仓"端口即 interface"的取向正面冲突。
3. **Effect-TS 的代价**：`effect@4.0.0` 运行时依赖确实为 0，但 **unpacked 48.4 MB**、**要求 TS ≥5.9**，
   且 v3→v4 是 `Context.Service`/`Cause`/组合子级重命名迁移，并要求"effect 与所有 `@effect/*` 同版本"。
4. **门禁耗时实测（本机）**：`eslint .`（无类型信息）**62.3 s**；type-aware（`projectService` + 一条 no-floating-promises，
   仅 src）**23.1 s**；`tsc --noEmit` **17.0 s**；自研 7 门禁合计 **28.5 s**。官方口径亦印证"typed lint ≈ tsc 耗时"
   —— <https://typescript-eslint.io/troubleshooting/typed-linting/performance/>。
5. **能不能用生态规则替代自研脚本**：typescript-eslint 自定义规则**能**拿到完整 `ts.Program`/checker（足以覆盖
   wiring/架构门禁），代价是门禁从秒级变成 tsc 级；oxc 的 **JS 插件仍是 alpha**，类型感知靠外部 Go `tsgolint` 且
   要求 **TS 7.0+**；Biome 插件只有 GritQL `register_diagnostic`，官方自述"**只分析同文件内出现的类型**"
   ⇒ **本仓"自研脚本 + 无类型 eslint"的分层在当前工具生态下是合理选择**，不该整体换引擎。
6. **运行时校验基准（第三方横评 vs 厂商口径互斥，必须并列引用）**：Moltar 原始数据（node 22.23.3）
   `parseSafe`：zod **10.51M** ops/s vs valibot **1.21M** vs typia 36.1M，arktype `parseStrict` 2.15M（**慢于 zod**）
   —— <https://raw.githubusercontent.com/moltar/typescript-runtime-type-benchmarks/master/docs/results/node-22.json>；
   而 Valibot 官方称"runtime 与 Zod v4 相近"、ArkType 官方宣称 **14 ns / 100× faster than Zod** ⇒ **厂商与横评互斥，
   本仓无 zod 热路径，故不需要为此改库**。zod 自身 AOT（`new Function`）在大对象上有 5.0×/10.2× 提升，
   但 CSP/`jitless` 环境不可用 —— <https://zod.dev/compile>。

**提案**

| #   | 提案                                       | 要点                                                                                             | 判据                                                                                                   | 人日 |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---- |
| TS1 | **拆掉架构环⑥**（优先于任何 DI 决策）      | 把环内散落的 `SubagentPortsShape` / `OmniHarnessRuntime` / `ResolvedConfig` 抽到 `src/ports/**`  | `node scripts/architectureGate.mjs --strict` 通过且 `CYCLE_WL_MEMBERS` 删掉对应成员                    | 2–4  |
| TS2 | **`Container.get<T>` 的类型安全原址增强**  | 现为 `value as T`（调用点断言）⇒ 引入泛型令牌 `ServiceKey<T>` 使 `ServiceKeys` 与 `get` 类型对齐 | `architectureGate` + `check` 全绿且 <3 s                                                               | 1–2  |
| TS3 | **门禁按"是否需要类型"分层，而不是换引擎** | 生态已有的规则继续交给 eslint；自研脚本只管"不需要类型"的部分                                    | 新增一条 typed 规则后：`tsc --noEmit`(17.0s) + typed eslint(23.1s) 之和 ≤45 s 且 `eslint .` 保持 <65 s | 1    |

**不建议采纳**：引入 DI 容器或 Effect-TS（收益已被 6 个 Assembler + 56 行 Container 覆盖，代价是 `reflect-metadata`/
装饰器语义或 48.4 MB + TS≥5.9 全量迁移；且 `ports/`+`core/` 恒第三方-free 由 `arch:gate` 强制，容器本就只能落在组合根——
正是现状）；迁移 zod → valibot/arktype/typia（zod 是 MCP SDK 的**非 optional peer**，换库只增不减依赖；
本仓无 zod 热路径；且厂商宣称与第三方横评互斥、typia 还要求换 `ttsc` + TS7）。

---

## 4. 升级路线图

> 排序原则：**先能验证 → 再补语义闭环 → 后加能力 → 最后做减法**。
> 每项都给"本机可跑、离线、无付费 key"的判据；没有判据的提案不进入本表。
> 工作量是**人日量级**（单人维护下的净投入，含测试）。

### P0：不先做这些，其余升级都无法被验证（也是本轮实测缺陷的收口）

| #   | 目标                                                                    | 含量化提案               | 判据（离线）                                                                                           | 人日 | 依赖 |
| --- | ----------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ | ---- | ---- |
| G1  | **建"最小行为回归守卫"**（补 §1.3 验证真空，而非恢复跑分）              | C3 基线 + C4 口径 + 新写 | 固定语料 + 固定查询集 → 记录召回/Top-K 命中与 **前缀复用率**；与入库基线比，超阈值即红；**单次 <60 s** | 3–4  | 无   |
| G2  | **子代理写入语义闭环**（修 §8.1 两处 P0）                               | S1 + S2 + S3             | `subagentWriteGate` / `worktree` 可取回 patch / `workflowRunnerLimits` 同层同文件 fail-closed          | 3–6  | 无   |
| G3  | ✅ **完成判定 fail-closed（V1 已落地，V2 待做）**（修 §8.6 零测试漏洞） | V1 + V2                  | `ScriptedModel` 桩回合：`# tests 0` **必须拦截**、`# tests 12/# fail 0` 放行；`unverified` 一等状态    | 2    | 无   |
| G4  | **回滚/取消语义补齐**（修 §8.2/§8.4）                                   | L3 + L4                  | `sessionRewindService` 增"游标随截断复位"；`cancelPropagation` 断言后代 reason 正确                    | 2–4  | 无   |
| G5  | **安全边界显式化**（把 §8.5 三处如实写进文档 + 收口）                   | X2 + X3                  | `policy/restricted` 档下 `curl`/`Invoke-WebRequest` 被拒且 reason 说明带外通道；记忆类移出 `file` 档   | 5–7  | 无   |
| G6  | **（可选大项）Windows 真 L3 隔离**                                      | X1                       | `doctor` 报 `appcontainer` 可达；沙箱内读 `~/.ssh` ACCESS_DENIED；**ACL 快照执行前后逐条相等**         | 6–9  | G5   |

### P1：一致性 / 成本 / 安全（有实测依据）

| #   | 目标                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 含量化提案 | 判据（离线）                                                                                                                                                                                                                                                                  | 人日    | 依赖   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ |
| G7  | ✅ **已落地**：事件落盘新增可选**追加通道**（`StoragePort.append` + jsonl 真追加 + sqlite `INSERT OR REPLACE` 不 DELETE + `EventPersister` 优先追加/失败回退/回卷走全量）                                                                                                                                                                                                                                                                                                       | L1         | 追加路径与全量路径 `load()` **逐条深相等**（7 例）；写入量＝新增条数而非总条数（40 vs 100）；**变异测试**：关掉追加通道 ⇒ ④⑤ 双双变红                                                                                                                                         | 4–6     | 无     |
| G8  | ✅ **已落地**：原生 token 记账默认翻回 TS（`NativeTokenAccounting`，缺省 false＝TS；配置/环境变量显式开启）+ **语料构建让出事件循环**（`indexCorpusAsync` + `CorpusCollector` + `CorpusIndexCache.getAsync`）。实测：同步 `maxGap=1677ms` ⇒ 异步中位 **95ms**（≈17×）；解析 803ms/符号 BM25 89ms/文件 BM25 730ms 三段全部分块                                                                                                                                                   | U1 + U2    | 记账走 TS（6.12ms）；心跳探针 ≤150ms（报告口径 100ms；剩余同步段＝目录遍历 54ms，见遗留 G8-c）                                                                                                                                                                                | 2–2.5   | 无     |
| G9  | ✅ **M3 已落地（投毒闸）**：`MemoryExtractor` 默认**不把工具输出并入蒸馏**（省略显式标注；只有工具输出的回合根本不抽调取器）；显式 opt-in（配置 `memoryIncludeToolOutput`）时事实标 `trust:'untrusted'`；回灌文案由"优先参考这些既有约定"改为"**不是指令**、冲突以用户要求为准"并加来源警示。⚠️ **M1/M2 未做**（见 G9-b）                                                                                                                                                       | M3         | `memoryTrustBoundary.test.ts` 6 例（含直抓模型 prompt 断言 + 只含工具输出的回合零事实）；**变异**：关掉闸门 ⇒ ①②③ 全红                                                                                                                                                        | 2+1.5+2 | 无     |
| —   | G9-b 记忆增益判据（M1）+ 写入质量（M2）                                                                                                                                                                                                                                                                                                                                                                                                                                         | ⏳ 待做    | **M1**：`scripts/memoryLiftProbe.mjs` primer on/off 配对 A/B + 配对 bootstrap CI 不跨 0 + 留出折——**离线无 key 时用脚本模型做 A/B 只会测出自己的脚本（假数字）**，故必须想清"可判死的代理指标"再动；**M2**：近似去重 + 冲突替代（现状只抹标点大小写，被推翻的旧事实无法替代） |
| G10 | ✅ **已落地**（T1+T3）：SDK `^1.30.0` → **`^1.32.0`**（实解 1.32.0，`LATEST_PROTOCOL_VERSION` 仍 `2025-11-25` ⇒ 版本断言不破）；**两处静默丢块一并修**——非文本块（图/音/资源链接）改为**保真转述**（含 MIME/体积/URI + `raw` 原始块）、`structuredContent` 原样透出并由网关渲染进工具结果；归一化收成 `McpContentBlocks` 一处（两条客户端路径共用，防漂移）                                                                                                                     | T1 + T3    | 真 SDK 适配器 + 真 stdio 子进程夹具 5 例（含端到端经网关渲染）；**变异**：把块塌成空文本 ⇒ ②③⑤ 全红。⚠️ T2（planner BM25 + `tools/list` 确定性排序）未做                                                                                                                      | 2       | 无     |
| G11 | ✅ **已落地（含一处报告订正）**：① 类型层换官方 `@types/react`（删手写垫片 ≈5.5 KB，新增只做转引的 `reactGlobals.d.ts` + `allowUmdGlobalAccess`；顺带挖出并修好 **`reasoningOptions` 被静默丢弃** 的真缺陷）；② **"120 KB 死负载"经复核为误判 ⇒ 不删**，改为把"highlight.js 在 markdown 路径上真被使用"钉成契约（`web/test/vendorAndTypeSource.test.mjs` 4 例，变异删脚本 ⇒ ① 变红）                                                                                            | W1 + W4    | `tsc -p web/tsconfig.json` 零错误 + `web:test` **300 全过**；垫片不得回归                                                                                                                                                                                                     | 1.5–2.5 | 无     |
| G23 | ✅ **已落地**：新增 `genAiSemconv.ts`（版本锚 `1.44.0` + 标准键 + 过渡键，唯一事实来源）；工具/模型 span **并行**发 `gen_ai.*`（`tool.name`/`operation.name`/`request.model`/`response.model`/`usage.input_tokens`/`usage.output_tokens`）且**过渡键一个不少**；数值属性改走 **`intValue`**（proto3 JSON int64 字符串形态）；缓存读口径：input 含缓存读、绝不相加                                                                                                               | O2         | `genAiSemconvConformance` 5 例钉住**版本 + 标准键 + 过渡键（字面名）**；**变异**：过渡键改名 ⇒ ② 变红（首版因断言常量而抓不到，已改字面断言）                                                                                                                                 | 2       | 无     |
| G24 | ✅ **已落地**：`OtlpTraceExporter.stats()` 自观测快照（`batchesSent/batchesDropped/spansSent/spansDropped/lastDropReason`；无样本给 0、不发警告、不改业务分支）+ 关闭"HTTP 非 2xx 被当成成功"的静默路径（`ok===false` ⇒ `http_<状态码>`）+ `scripts/observabilityReconcile.mjs` 离线对账（退出码；单列无 usage 调用；缓存读不计入 total）                                                                                                                                       | O3 + O4    | 注入必失败 `fetchImpl` ⇒ `droppedSpans` 递增且 `flush()` **不抛错**（6 例）；**变异**：`recordDrop` 不计数 ⇒ ①② 变红                                                                                                                                                          | 2       | 无     |
| G25 | ✅ **已落地**：环⑥（20 成员）**消失** —— 真实成因不是"接口没抽到 ports"（`SubagentPortsShape`/`OmniHarnessRuntime`/`ResolvedConfig` 早已在 ports），而是**类型已在 ports、调用点却绕道实现文件导入**；34 处导入改直连后环内边 51→32，`CYCLE_WL_MEMBERS` **41→25**，仅剩 4 成员配置子环                                                                                                                                                                                          | TS1        | `architectureGate --strict` 通过 + 白名单删掉 16 个已不成环的成员；`npm test` 2,520 项 0 失败                                                                                                                                                                                 | 2–4     | 无     |
| —   | G25-b 剩余 4 成员配置子环                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ⏳ 待做    | `SubagentPortSeed`/`CorePorts`/`MediaStack`/`ResolvedMediaOptions` 仍声明在实现文件里；移入 ports 会**级联**（如 `CorePorts.turnDiffTracker` 的类型是 `core/turnDiffTracker` 的类，需先改成端口类型 `TurnDiffTrackerPort`）⇒ 属**类型契约**级改动，不与拆环混做               |
| G26 | ✅ **已落地**：新增 `ServiceKeyLike<T>`（端口契约，含类型烙印）+ `ServiceKey<T>`（core 实现类，`declare` 烙印不落地）；`ContainerPort`/`Container` 每方法加**令牌重载**（保留字符串重载）；`ServiceKeys` 六键升级为泛型令牌（**令牌名与历史字符串键逐字一致** ⇒ 既有注册点零改动）。**踩坑并修**：只在类上写联合实现签名会让 `unknown` 吃掉检查（`TS2578×3` 暴露），接口与类必须同形声明重载                                                                                    | TS2        | `architectureGate` + `check` 全绿；类型层判据用三处 `@ts-expect-error`（未拦住即 `tsc` 红）；运行期 4 例（键名兼容/同桶互操作/语义不变/烙印不落地）                                                                                                                           | 1–2     | G25 ✅ |
| G27 | ✅ **已落地**：`runGates.mjs` 每条门禁声明 `tier`（`fast`/`typed`）并支持 `--tier=`；新增 `eslint.typed.config.mjs`（`parserOptions.project`，`src/**`）启用三条**必须类型**且存量零的规则（`no-floating-promises`/`await-thenable`/`no-misused-promises`）；新增 `scripts/gateBudget.mjs` + 策略模块**实测断言**预算。⚠️ **口径变更**：判据原写"两项之和 ≤45s"，实测该值对负载过敏（空载 43.9s / 负载 49.5–55.5s）⇒ 改按**并发墙钟**断言（≤45s，实测 32.2s），"和"仍打印供对照 | TS3        | 结构判据 7 例（每条门禁必须有 tier / 类型层只放需要类型的 / 类型层必须有 `project` 否则静默空转 / 规则集逐字等于策略清单 / 预算常量单一来源）；**变异**：去 `project` ⇒ ④⑤ 红，去 `tier` ⇒ ①③ 红；耗时：`eslint .` 26.2s、类型层墙钟 32.2s                                    | 1       | 无     |

### P2：能力提升（**前提是 G1 已落地**，否则无法判断是否真的更好）

| #   | 目标                                       | 含量化提案 | 判据（离线）                                                          | 人日 | 依赖 |
| --- | ------------------------------------------ | ---------- | --------------------------------------------------------------------- | ---- | ---- |
| G12 | **确定性 contextual chunk**                | C1         | 193 条查询配对 bootstrap 95% CI 下界 >0 且 2-fold 留出折同向          | 2    | G1   |
| G13 | **代码专用 cross-encoder 对照**            | C2         | 同池配对 CI + p50/p95 延迟与 RSS；默认关、加载失败 fail-closed 回词法 | 3    | G1   |
| G14 | **token 记账精度（接入真 tokenizer）**     | C4         | 全 `src/*.ts` 误差分布（median/p90/max）；Rust 侧逐位一致             | 1.5  | G1   |
| G15 | **工具检索优先 + `tools/list` 确定性排序** | T2         | `OMNI_TOOL_EXPOSURE=plan` 下同输入恒同输出 + 必需工具召回 100%        | 2–3  | G1   |
| G16 | **流式渲染与审批 UX**                      | W2 + W3    | 1 万 chunk 时 DOM 节点数不随 chunk 增长；"一次 always"不变成长期放行  | 7–11 | 无   |
| G17 | **WASM 作为跨平台主路径**                  | U4         | 三路（TS/native/wasm）在 1,108 条语料上逐位相同                       | 1.5  | G8   |
| G18 | **内核 RPC 换非 JSON 封送**                | U3         | 封送 ≤4 ms、全往返 ≤15 ms；string 入口并存自动回退                    | 2–3  | G8   |

### P3：减法与卫生（**减法也是升级**：降低单人维护的长期成本）

| #   | 目标                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 要点                                                                                                       | 判据                                                                                                                                                                                                                                                                                  | 人日 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| G19 | ✅ **已落地**：**删除 LSA 潜语义路**（实测召回持平/精确率腰斩、无外部消费者）——`lsaEngine.ts`(326 行)+其单测+`query` 的 `lsa` 选项/语料 `lsaModel` 字段/`EMPTY_LSA`/`SeedFusion` 第三路全清；其余实验档登记进 `src/context/experimentalPaths.ts`（状态/旋钮/默认/**实测证据**/删除边界），生产路径**开启即告警**。⚠️ **边界评估纠正两处首版误判**：三条图路共用 stage 文件 ⇒ 合并为 `graph-family` 单一边界；`util/eigenspectrum.ts` 有 **9 个非检索消费者** ⇒ 是共享基础设施、**不可**随路删除 | G1 判据护航做"删掉后指标不变"对照                                                                          | 删除前后基线对照：plain **56.3% → 56.3%（逐位不变）**、rerank 50.0% → 53.1%（**上升来自语料变小**，不声称算法提升）；判据 6 例（删除完整性/默认关/默认档不建图与谱/**边界闭合+仪器自证与正对照**/清单存活/无残留引用）；**变异**：复活 lsaEngine ⇒ ① 红、边界外引用 seedFusion ⇒ ④ 红 | 3–5  |
| G20 | ✅ **已落地**：`docs/` 根 **33 → 13 份**（只留 SSOT + 现行纪律 + 用户文档），20 份根级历史 + `library/`(9) + `agent_evolution_research/`(6) 移入 `archive/`（共 **55 份**）并**逐份加归档横幅**（"数字不再代表现状"+ 指向现行 SSOT）；重写 `docs/README.md` 与机器可读索引 `llms.txt`、新增 `archive/README.md`（策略+清单）；38 个文件的引用改写。**死链基线 96 → 24（净减 72）**                                                                                                              | `check:doc-links` 不新增死链 + SSOT 自洽                                                                   | 判据 `docsLayout.test.ts` 6 例（根白名单/横幅完整/索引完整/**现行索引自洽**/不得旧路径引用归档/横幅内容）；**变异**：丢野生文档 ⇒ ① 红、抹横幅 ⇒ ② 红、索引指向不存在文件 ⇒ ④ 红                                                                                                      | 2–3  |
| G21 | **把有价值探针从 `.omniharness/` 提升入库**（§1.5）                                                                                                                                                                                                                                                                                                                                                                                                                                             | 检索/前缀/工具暴露三类探针 → `tools/probes/`（或并入 G1），使其**可被他人复现**                            | 同一探针在干净克隆上可跑出同数量级结果                                                                                                                                                                                                                                                | 1–2  |
| G22 | **口径与门禁同步**                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 把本报告的"计数口径""评测口径""吞吐随文本长度变化"等写进 `docs/CODE_STANDARD.md` 与看板 §9，避免下一轮再错 | 门禁脚本不回归（`check --strict` 等）                                                                                                                                                                                                                                                 | 0.5  |

### 一句话结论

**架构骨架不需要推翻**（六边形 + 2 个运行时依赖 + 9 道机械门禁是真实资产）；
要做的三件事是 **① 把"能判死"的能力补回来（G1/G3）② 把"谁能在哪写什么"的语义闭环补齐（G2/G4/G5）③ 做减法**（G19/G20/G21）。
外部调研同时**否掉了四个"加机器"的直觉**：Rust 记账更慢（G8）、向量库不必要（§3.2/§3.3）、
worker 线程反效（§3.8）、并行写入型子代理有害（§3.6）——这正是本轮调研最大的价值：**省下的比加上的多**。

## 5. 反泡沫清单（明确不做）

| 不做                                                  | 为什么（带证据）                                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 恢复重型跑分/评测 CI 体系                             | 已按指令删除；且外部"头条数字"大面积不可复现（§3.3 发现 3）⇒ 自建**判据**优于照抄 benchmark                    |
| 引入向量数据库（含 sqlite-vec）                       | 语料上限 32 MiB、千级向量，**暴力余弦已亚毫秒**；语义路收益上限仅 18.2pp 且近似方法已被本仓自证伪（§3.2/§3.3） |
| 引入图数据库 / 时序知识图谱                           | 唯一干净增益 +1.4pp（自报）；最响亮数字因口径虚高已由作者更正；**本仓同机理实测净负面**（§3.3）                |
| 移植外部记忆系统（Mem0/Zep/basic-memory 等）          | AGPL 法务风险 + 基线不可复现 + Python/独立服务与本仓约束冲突（§3.3）                                           |
| tree-sitter 全覆盖 / Zoekt·tantivy 外置引擎           | 剩余差距是**零词法交集的语义鸿沟**，AST 不产生新词法交集；外置引擎 index≈3× 语料且要外挂 ctags（§3.2）         |
| 继续把记账/算子下沉 Rust                              | 实测**反向 6.7:1**；建议门槛"封送比 <1/3"（§3.8）                                                              |
| worker_threads 池"加速"CPU 任务                       | 实测 **0.69×（更慢）**、冷启动 1.9 s，ONNX 自身已吃满多核（§3.8）                                              |
| 并行写入型子代理（多写者 swarm）                      | Cognition 两篇一致反对 + C 编译器 16-agent 互相覆盖事故 + MAST inter-agent misalignment（§3.6）                |
| 把 `run_workflow`/A2A 宣传成"隔离子代理/互操作"       | 与实现不符（§8.1/§3.6 发现 7）；要么补实现，要么**改文档**（低成本路线）                                       |
| LangGraph 式每步全量快照 / `update_state` 可逆回滚    | 官方自认 checkpoint 无界增长；本仓 `rewindTo` 的 fail-closed 语义会被毁（§3.1）                                |
| 按调用间数据依赖做 DAG 调度 / 确定性重放              | 工具契约无输入输出声明（codex 与本仓都选静态声明）；模型/副作用不可确定（§3.1）                                |
| 上 Firecracker / 用 Windows Sandbox 做逐命令沙箱      | 前者 Linux/KVM only；后者冷启动按次计费、每登录会话 1 个 VM、网络只能全封（§3.5）                              |
| 拿 verifier/LLM 当完成判据                            | AUROC 0.65 < 机械检测器 0.83；"自信措辞"即可抬高 0.27–0.36（§3.9）                                             |
| 无外部反馈的自我精炼循环                              | 会掉分；43–62% 初始正确的代码被改坏（§3.9）                                                                    |
| 自研 reconciler / 换 Preact / 引 Monaco·shiki 做 diff | 运行时已是官方 React；shiki 全量 6.4 MB，破坏零打包器与零网络依赖（§3.10）                                     |
| 自研 OAuth / 跟进 MCP 2026-07-28 整修订重写           | STDIO 规范本就 SHOULD NOT 走 OAuth；整修订级重写对窄客户端面不划算（§3.4）                                     |

| 引入 DI 容器（NestJS 式）或 Effect-TS | 收益已被 6 个 Assembler + 56 行 Container 覆盖；代价是 `reflect-metadata` + 接口不能作 DI 令牌，或 48.4 MB + TS≥5.9 全量迁移（§3.11） |
| 迁移 zod → valibot / arktype / typia | zod 是 MCP SDK 的**非 optional peer** ⇒ 换库只增不减依赖；`src/` 仅 1 处 import、无热路径；厂商宣称与第三方横评互斥（§3.11） |
| 把自研门禁脚本整体换成生态规则引擎 | oxc JS 插件仍 **alpha**、类型感知需外部 Go 工具且要求 TS 7.0+；Biome 插件官方自述**只分析同文件内类型** ⇒ 覆盖不了 wiring/架构门禁（§3.11） |
| 按 semconv 一次性重命名 trace 键 / 引入 `@opentelemetry/*` | GenAI semconv **全 Development**、新仓 Schema URL 仍是 TODO ⇒ 改名是单向门，加字段才是双向门（§3.7） |
---

## 5.1 实施进度（按本报告 §4 逐项落地，每项都过全部门禁并推送）

| 日期       | 项                                     | 状态      | 判据/证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | -------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-03 | **G3-V1 完成判定 fail-closed**         | ✅ 已完成 | 新增 `TestCountParser`（5 类运行器识别）+ 闸门第二道判据；`tests/unit/testCountParser.test.ts` 12 例 + `turnEndCompletionGate.test.ts` 新增 4 例；真实命令复核：空 glob ⇒ `zeroEvidence=true`、真跑 12 例 ⇒ `total=12/false`；`npm test` **2,461 项（2,454 过 / 0 失败）**                                                                                                                                                                                                                                                                                                                                                        |
| 2026-10-03 | **G3-V2 `unverified` 一等完成状态**    | ✅ 已完成 | 新增端口类型 `VerificationState`（`not-run`/`failed`/`unverified`，**不含 `passed`** 并说明原因）；`TurnRunner.handleCompletionClaim()` 抽出（兼守函数体上限）+ 二次宣告完成记 `unverified` **并写 system 留痕**；透传 `TurnOutcome → AgentResult → SubagentResult`，`SubagentTool.render()` 告警父模型。判据：`verificationState.test.ts` 3 例（真 `turn-end` 闸门：恒失败 ⇒ `unverified`；无测试命令 ⇒ `not-run` 且无假警报；通过 ⇒ 不冤枉）；**变异测试**：删掉标记 ⇒ ① 变红                                                                                                                                                   |
| 2026-10-03 | **G4-L3 取消原因保真**                 | ✅ 已完成 | `toAbortSignal()` 带原因 + `reasonOf()` 认全五类与 `{custom}`、兜底 `user`；新增 `cancellableModelReason.test.ts` 4 例 + `loopCancellation` 1 例 + `cancelPropagation` 在真实三路径断言原因（原零断言）；端到端探针全保真。**原诊断"级联降级"经复核订正为有意设计**                                                                                                                                                                                                                                                                                                                                                               |
| 2026-10-03 | **G4-L4 回滚时复位压缩游标**           | ✅ 已完成 | 新增 `StepContextBuilder.rewindCompactionState()`（就地重推，撤 `stateRestored` 以避开旧缺陷 P0-1）+ 三级透传 + `Agent.registerRewinder` 在截断后调用；`contextIntegrityFixes.test.ts` ⑤ 复现缺陷形态并验修复。**接线缺端到端断言，已并入 G1**                                                                                                                                                                                                                                                                                                                                                                                    |
| —          | G4 回滚/取消补齐                       | ✅ 已完成 | 压缩游标复位（§8.2）+ 取消原因保真（§8.4）——两项均已落地并推送                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-10-03 | **G2 子代理写入语义闭环**              | ✅ 已完成 | worktree 档：`collectChanges()` + `persistChanges()` 采集为可 `git apply` 的 patch（含未跟踪新建文件），编排层在 cleanup **之前**采集并回传 `changedFiles`/`patchPath`；copy 档：`SubagentToolScope.writeForbidden()` **禁写**（fail-closed）+ `writesForbidden`；采集失败置 `writesUnrecoverable`；`SubagentTool.render()` 把事实渲染给父模型。S3：docstring 订正 + `WorkflowLayerPolicy` 同层多写者**退化为串行**。判据：新增 11 例                                                                                                                                                                                             |
| 2026-10-03 | **G1a 最小行为回归守卫（行为不变量）** | ✅ 已完成 | 新增 `tests/unit/behaviorRegression.test.ts`（4 例）：① 工具调用顺序与配对 ② 落盘不丢不重（id 唯一/配对不错位/`user` 先于 `tool_call`）③ plan 档门禁真拦写且带可读原因 ④ `TurnRunner.rewindCompactionState()` 透传接线。复用 `ScriptedModel` + 真 runtime，**离线零 key**。**变异测试验证有牙齿**：临时破坏 `SessionRecorder.toolResult` 落盘 ⇒ ①② 双双变红，回滚后恢复全绿                                                                                                                                                                                                                                                       |
| 2026-10-03 | **G1b-a 检索质量回归守卫**             | ✅ 已完成 | 新增 `tests/unit/retrievalBaseline.test.ts`（2 例，~3.5s）：① **锚点审计**（32 条冻结查询的 GT 锚点必须逐条存在于语料——恢复随评测子系统丢失的审计）② `plain` 与 `rerank` **两镜头**的 `recall@14`/`MRR` 均 ≥ 入库基线 − 容差（≤3 条查询 / 0.04 MRR）。基线：`plain` 18/32=56.25%・MRR 0.1978；`rerank` 16/32=50.0%・MRR 0.2020（语料 919 文件/10,598 符号）。**变异测试**：排序方向写反 ⇒ `plain` MRR 0.1978→0.1559 ⇒ ② 变红；**诚实登记盲区**：`SYM_K` 30→3 指标逐位不变（对符号池规模不敏感）                                                                                                                                   |
| 2026-10-03 | **G1b-b 前缀复用守卫 + 仪器接线**      | ✅ 已完成 | ① **生产接线**：`StepContextBuilder.measurePrefixReuse()` 用 `PrefixStability.prefixReuse` 记 `log.debug("context.prefix_reuse")`（该仪器原先**只有导出、零调用点**；只测只记，**零行为变更**）；② 守卫 `tests/unit/prefixReuseGuard.test.ts` 3 例（~0.4s）：稳定头逐字节不变 / 首条不得含动态段 / **只追加不重写（公共前缀 ≥ 上次长度−1）**；字符级复用率**只作证据不设地板**（被尾部体积稀释：实测 #1→#2 仅 0.9%，而"除尾段外逐条相同"完全成立）。**变异测试**：动态段 `push`→`unshift`（挪回头部）⇒ **三例全红**（`首条含 # Repo Map`、`公共前缀 0 条`），回滚恢复绿。共用件 `tests/helpers/recordingModel.ts`（G1a 同步去重） |
| —          | G1b-c 回滚端到端断言                   | ⏳ 待做   | 补 G4-L4 的端到端断言（调小 `compactionMaxTokens` → 打检查点 → 回滚 → 断言后续请求不再带旧摘要）；**当前如实登记未做**：用 `ScriptedModel` 时摘要正文由脚本产出，端到端会退化成"测夹具"而非"测游标"，需先想清可观测判据                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-10-03 | **G5 安全边界显式化**                  | ✅ 已完成 | ① 记忆信任档收紧：`TrustTier` 新增 `memory`（阈值 **1**，与 `external` 同级；理由＝跨会话持久 + 来源不可追溯），`isUntrusted` 改为与阈值**同源**；② `NetworkEgressGuard.COVERAGE` 自述"只覆盖 `globalThis.fetch`、shell 子进程不受约束"；③ 能力表 `restricted` 条目删去"Windows 提供 OS 级隔离"的暗示（restricting-SID 计数为 0）；④ `doctor` 增「安全边界」段（实测输出：`L2`／`shell 出网被拦=否`／阈值含 `memory=1`）；⑤ `docs/archive/compliance.md` 沙箱行从「OS 级隔离 ✅」降级为 ⚠️ 如实口径。判据：`securityBoundary.test.ts` 5 例 + `toolOutputTrust.test.ts` 同步；**变异测试**：移除 `memory` 档判定 ⇒ ④ 变红          |

**实施中新增的经验（写进纪律候选）**：仪器不得把被测对象的名字当成自己的读数——首版 `TestCountParser` 因
node TAP **回显用例名**而把"9 个用例全过"误判成"零测试"（测试名里恰好含 `no tests ran` 等字样）；
现先剔除逐用例行的用例名回显再判读，并补回归用例。

## 6. 复核方式（本机可重跑）

```bash
npm run typecheck && npm run lint && npm run check -- --strict   # 类型/规范/铁律
npm run arch:gate && npm run audit:config-wiring                 # 架构方向/声明接线
npm run audit:maturity && npm run check:doc-links && npm run api:check
npm test                                                        # 385 文件 / 2,445 项断言
npm run rust:test && npm run web:test
# 规模复核（正确口径）：
#   (Get-ChildItem src -Recurse -File -Filter *.ts).Count
#   逐文件 (Get-Content $f).Count 求和  ← 勿用 Measure-Object -Line（少计空行）
```
