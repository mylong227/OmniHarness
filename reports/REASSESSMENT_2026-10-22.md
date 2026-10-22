# OmniHarness 再评估（2026-10-22）：从「机制完整」到「边界可信、证据可证、分发可达」

> **复核对象**：`D:\deepseek\omniharness`，`main` @ `70126d42`（2026-10-22 22:30 快照；工作树另有 5 个未提交文件，见 §1.1）。
> **复核日期**：2026-10-22（Asia/Shanghai）。
> **口径**：仓内结论以本机可复核的代码/命令为准；外部资料标 `[V]`（已读原文）/`[I]`（推断），数字不复现；**不引用榜单给本项目打分**。
> **与旧报告的关系**：`reports/CORE_CAPABILITY_GAP_ANALYSIS_2026-10-20.md` 的五项短板在本报告中逐条复核；已经闭环的不再重复，只写「现在还剩什么」。

---

## 0. 摘要

### 0.1 三句话

1. **旧报告的五项短板，两项已补齐机制**（长时执行、交互行动空间），**两项补了一半**（上下文保鲜、生态互操作），**一项仍是默认弱**（独立验证/OS 隔离）。旧判断「分钟级机制完整、小时级能力不足」**不再成立**。
2. **新的主要矛盾从「能力缺层」变成「边界与证据」**：内部（插件进程隔离、审计哈希链、门禁）很严，入口（工作区配置、MCP 认证、技能来源）很松；有遥测但**没有评测契约**；有工具面但**没有编辑器/PR 分发面**。
3. 如果只做一件事：**工作区信任闸**。如果做两件：加 **评测契约**。如果做三件：加 **MCP 客户端认证**。

### 0.2 六条自证伪复核（旧报告的判死条件）

| #   | 旧判断         | 现在的证据（本机代码）                                                                                                                                                                                                                                                                                                                                | 判定                   |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | 长时执行会断   | 软时限 30min、硬时限 **8h**（[agent.ts:44](../src/core/agent.ts#L44)、[agent.ts:50](../src/core/agent.ts#L50)）；截断续写 ≤3 次（[stepRunner.ts:242](../src/core/stepRunner.ts#L242)）；`forceCompact` 反应式压缩；`health-fallback` 切模型；每 20 步自动 checkpoint（[turnRunner.ts:288](../src/core/turnRunner.ts#L288)）；续跑引导列已成功写类调用 | **降级（已补齐机制）** |
| 2   | 上下文会失忆   | 工具结果头尾裁剪 + 旧轮剪枝（`contextShapers`）；token 校准器；1M 窗口目录；压缩游标回卷对齐。**但**压缩仍是单次摘要为主，缺「压缩后任务保持率」的端到端数字                                                                                                                                                                                          | **部分降级**           |
| 3   | 交互环境摸不着 | `browser_act` 九动作（Playwright 默认、CDP 回退）；`web_search` Brave/Tavily 按 key 注册；`web_fetch` Readability + `unpdf`                                                                                                                                                                                                                           | **降级（已补齐机制）** |
| 4   | 验证不独立     | `review_diff` 干净上下文 reviewer（默认 advisory）；`EvidenceLedger` 无证据 ⇒ `unverified`；目标判定有机械证据否决门。**但** reviewer 默认不阻断、目标正向语义仍靠 LLM、provenance 默认关                                                                                                                                                             | **部分降级**           |
| 5   | 生态接不上     | MCP **2026-07-28 无状态客户端**（`server/discover`，默认 auto，失败回退 legacy）；A2A `message/send`/`tasks/get`/`agent/getCard`；`SKILL.md` 导入/发现。**但** MCP server 仍 `2025-11-25`；无 OAuth/MRTR/registry/conformance；无 ACP                                                                                                                 | **部分降级**           |
| 6   | 隔离仍是 L2    | 新增 `windows-acl`（受限令牌）与 `wsl-bwrap`；但**默认 `sandbox=policy`** 仍是同用户进程内约束；shell 出网只在 `OMNI_NETWORK_ALLOW` 已配置时被工具层拦截                                                                                                                                                                                              | **仍成立（默认档）**   |

> 结论：旧报告要求「90 天内把长时 + 上下文做成小时级闭环」，其中**长时已基本兑现**；上下文只兑现了机制，未兑现「压缩后能力不降」的证据。**验证与隔离没有翻默认**，这是有意为之的诚实边界，不应被写成已修复。

### 0.3 五个仍然值得做（按杠杆排序）

1. **工作区信任闸**（P0，S/M）——当前「clone + `npm start`」会让项目配置自动生效，包括 `mcpServers`（spawn 子进程）、`approval:auto`、`sandbox:passthrough`、`baseUrl`（可把用户凭据导向别处）。这是本轮**新发现**的最高优先项。
2. **评测契约**（P0，S/M）——`session_meta` 只记 workspace/model；没有 run manifest；OTLP 缺 `invoke_agent` 父 span；探针是机制级，不是任务级 A/B。没有它，后续任何「变好了」都无法证伪。
3. **MCP 客户端 OAuth + MRTR + 一致性**（P0，M）——`McpServerConfig` 只有 `url`，没有 header/token 字段；受 OAuth 保护的托管 MCP server 目前**接不上**；v2 的 `input_required` 也没有回路。
4. **角色化模型/推理预算 + trace→patch 闭环**（P1，S/M）——路由只有 least-cost/round-robin/by-task/by-context/health-fallback，没有 planner/executor/reviewer/compactor 的角色位；`sessionTelemetry` 已经聚合失败但没有任何「从轨迹生成补丁」的回路。
5. **分发面：ACP + 技能可移植/签名 + A2A 卡**（P1，M/S）——ACP 已是编辑器事实标准；`.agents/skills` 是跨客户端路径；A2A 只有私有 `agent/getCard`，没有 `.well-known` 签名卡。

### 0.4 这次明确不做

不做跑分结论、不追 Terminal-Bench 榜单、不上向量库/图数据库、不重写 MCP server、不上 MCP Apps/AG-UI、不上 microVM/多租户/托管控制面、不做并行写入型子代理、不把更多记账下沉 Rust、不做无门禁的「自动改自己」。理由见 §8。

---

## 1. 复核方法与证据

### 1.1 本机实测（2026-10-22 22:05–22:40）

| 命令                            | 结果                                           | 说明                                                                             |
| ------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `npm run build`                 | ✅                                             | `tsc → dist.next` + 资源镜像 + 原子换入；无编译错误                              |
| `npm run check`                 | ✅                                             | 扫描 **1137** 个 TS 文件，铁律零违规；函数体超限白名单 11 处（未增长）           |
| `npm run arch:gate -- --strict` | ✅                                             | 依赖方向 0 违规；端口纯度 0；5 组白名单环（21 成员）；3 个平铺目录告警           |
| `npm run lint`                  | ✅                                             | 工作树收口后 `--max-warnings=0` 通过                                             |
| 定点测试                        | ✅                                             | `pluginLoader` + `pluginWorker` + `sandbox` 合计 **30/30**；`sandbox` 单跑 9/9   |
| 全量单测（编辑中途的一次）      | 3673 passed / 4 failed / 7 skipped（599 文件） | **不作为门禁结论**：22:32 工作树仍在改；4 例单跑均可复绿（见下方「测试确定性」） |

**规模（逐文件 `(Get-Content).Count` 求和，口径同 `CODE_STANDARD.md` §11）：**

| 范围            | 文件     | 行          |
| --------------- | -------- | ----------- |
| `src/**/*.ts`   | **1137** | **136,996** |
| `tests/**/*.ts` | **625**  | **96,828**  |
| `web/src/**`    | **170**  | **27,786**  |

对比 `ARCHITECTURE_SPEC.md` 的 2026-10-06 快照（1014 文件 / 114,234 行）：16 天新增 **123 个源文件 / 22,762 行**，测试新增 **124 个文件 / 21,428 行**。

**模块分布（前 10）：**

| 目录         | 文件 | 行     | 目录       | 文件 | 行     |
| ------------ | ---- | ------ | ---------- | ---- | ------ |
| `adapters/`  | 252  | 41,520 | `context/` | 53   | 11,107 |
| `server/`    | 57   | 11,712 | `ports/`   | 399  | 9,547  |
| `cli/`       | 49   | 11,491 | `core/`    | 35   | 7,841  |
| `config/`    | 27   | 5,083  | `util/`    | 43   | 5,052  |
| `evolution/` | 27   | 4,963  | `plugin/`  | 33   | 4,454  |

**测试确定性观察（不计为产品缺陷，但需要处理）**：全量并行跑期间出现过 3 例「单跑全绿、并行红」——`pluginWorker` 的工具超时、`layaWarmWorker` 的 2 例热进程。它们都在 3 文件定点复跑中恢复；`sandbox.test` 的 1 例在 22:32 工作树更新后单跑也绿。建议在 CI 加一条「同 commit 连跑两次」的确定性门禁，或给资源重的判据单独分池；否则「全绿」会依赖机器负载，和本项目「判据必须可复核」的纪律冲突。

### 1.2 外部资料分级

- `[V]`：本轮读到原文/官方文档（arXiv HTML、官方 spec、官方 docs、仓库 README）。
- `[I]`：由多条 `[V]` 推出的工程判断，或二手转述。
- `[B]`：厂商博客/二手转述（原文未能直接读取，例如 OpenAI Codex 博客 403）。
- 外部数字（跑分、百分比、版本日期）**只用于界定方向，不作为本项目的结论**；本报告没有复跑任何外部 benchmark。

### 1.3 本次没有做什么

1. 没有用真实 API key 跑小时级任务；长时能力的结论来自代码路径与既有判据，不是本轮实跑。
2. 没有在 Linux/macOS 上实测 `landlock`/`seatbelt`/`bwrap`；没有做沙箱渗透。
3. 没有复跑 Terminal-Bench/SWE-bench 等外部基准；也不建议把它们的分数当本项目 KPI。
4. 没有提交任何代码；工作树中 5 个未提交文件是复核期间出现的改动（plugin worker 重启/能力扩展/沙箱强制），本报告只把它们当作「最新实现」的一部分来读，不据其未完成状态下结论。

---

## 2. 最新实现：代码结构与能力面

### 2.1 分层与结构

- **六边形纪律仍然成立**：`arch:gate --strict` 报「依赖方向 0 违规、端口纯度 0 违规、ports→实现层 0 违规」。这在同类项目里少见，是真实资产。
- **`ports/` 399 个文件 / 9,547 行**（≈24 行/文件）：契约优先的代价是碎片化。好处是 `adapters` 252 个文件 / 41,520 行仍能被端口约束；代价是「找实现」要多跳一层，新人成本高。
- **5 组白名单环**（`genesis/spark`、`context`、`config`、`cli`、`evolution`；门禁报 21 个白名单成员）：存量冻结、新增即红，纪律正确；但 `config` 7 成员环说明配置层仍在承担过多装配职责。
- **3 个平铺目录告警**：`cli/` 49、`context/` 39、`util/` 34 个直接 `.ts`。不是错误，是下一轮可读性债务。
- **单一门禁实现** `scripts/runGates.mjs` + 两层（fast/typed）仍然是同类项目里最强的工程约束之一；`check` 的「声明即接线」、`arch` 的「新增环即红」、`standard-delta` 的「文档与门禁常量交叉核对」都应保留。
- **依赖面克制**：运行时 11 个直接依赖，可选 8 个；无通用 agent 框架、无向量库、无图数据库、无 ORM。Rust 内核可选且默认 TS 路径。

### 2.2 近两周落地的能力（2026-10-07 → 10-22）

| 能力面    | 已落地（本机代码/判据）                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 长时执行  | 8h 硬限 / 30min 软提醒；`finishReason` 归一化与截断续写；`forceCompact`；`health-fallback`；每 20 步自动 checkpoint；续跑引导列已成功写类调用                      |
| 上下文    | `ContextShapers` 头尾裁剪 + 旧轮剪枝；`TokenEstimatorCalibrator`；`ContextWindowCatalog` 补 1M；压缩游标回卷对齐（G1b-c2）                                         |
| 交互      | `browser_act` 九动作（Playwright 默认 / CDP 回退）；Brave/Tavily `web_search`；`web_fetch` Readability + `unpdf`；右栏网页预览（独立回环源）                       |
| 验证      | 完成闸门 + `EvidenceLedger` + `unverified` 一等状态；`review_diff` 干净上下文 reviewer；`OMNI_REVIEW_BLOCK=1` 才阻断；目标检查的机械证据否决门                     |
| 互操作    | MCP v2 无状态客户端（`server/discover`，默认 auto 回退 legacy）；A2A v1 最小面；`SKILL.md` 导入/发现；AGENTS.md 读取                                               |
| 隔离      | Windows ACL 受限令牌（`windows-acl`）；WSL2 + bwrap（`wsl-bwrap`）；shell 出网策略；MCP 主机白名单；远程插件独立 Worker（L3）+ 能力 broker（`fs.read`/`fs.write`） |
| 可观测    | OTLP trace + metrics；GenAI semconv 1.44.0 锚（加字段不改名）；`observabilityReconcile` 对账；SSE 断线重放                                                         |
| 进化/资产 | GEE Kernel（默认关）+ HashChain 晋升台账 + 回滚；CapabilitySchema/Registry；签名资产包；Windows 凭据 DPAPI                                                         |
| 规划      | `TaskComplexityClassifier` 复杂任务强制先规划（2026-10-22）；todo `id/dependsOn` DAG；`run_plan` 并行执行（按 `writes` 声明精确并发）                              |
| 前端      | Vite + React 19；面板模态；diff 评论；checkpoint/rewind；Trace/治理/记忆/指标面板；真 Chrome a11y 判据                                                             |

### 2.3 结构评价：强项与债务

**强项（应保留，不要为了「像前沿」而推翻）：**

1. **事件流单源 + 追加落盘 + 审计哈希链 + 回滚**：这是「可复盘」的底座，比多数开源 harness 的「聊天记录 + 日志」强一个代际。
2. **门禁与变异测试传统**：判据要求「对已知坏输入能变红」「仪器自证」「声明即接线」。这类纪律在开源 agent 项目里稀缺。
3. **端口/适配器 + 依赖准入**：让「换模型/换沙箱/换存储」不需要重写主循环。
4. **插件进程隔离 + 能力 broker + 签名包**：方向正确，且比「VM 里跑插件」的常见做法更贴近本地优先。

**债务（不是错误，是下一轮成本）：**

1. **端口碎片化**（399 文件）：建议按域合并「只有 1–2 个方法的纯 type 文件」，保留 `ports/<domain>/index.ts` 作为唯一入口；不要为了行数好看而合并语义不同的契约。
2. **`config` 7 成员环 + 39 个配置键**：配置层在承担「装配 + 校验 + 兼容 + CLI 映射」四件事。工作区信任闸会再加一层，若不先抽「配置来源/信任级别」，环会更大。
3. **`adapters` 41.5k 行**：工具/模型/沙箱/存储都在一个目录下，靠子目录分。可考虑把 `adapters/tool` 再按「文件/终端/浏览器/协议」拆成独立包级目录（不改变端口）。
4. **环境变量/特性开关 sprawl**：`OMNI_*` 已有数十个，且部分只在运行时读。工作区信任、MCP auth、role routing 若继续用 env 会加重「配置面不可发现」。建议新能力一律进 `omniharness.json` schema + `doctor` 可见。
5. **测试确定性**：见 §1.1；并行下的资源竞争红会侵蚀「门禁可信」这个最大资产。

### 2.4 现行诚实边界（引用时必须保留）

- 默认隔离仍是 **L2（同用户进程内约束）**；`windows-acl`/`wsl-bwrap` 需显式选择且依赖宿主能力。
- `policy` 档出站守卫只覆盖 `globalThis.fetch`；shell 出网只在 `OMNI_NETWORK_ALLOW` 已配置时被工具层拦截。
- 注入防护默认 `off`（观测模式）；provenance guard 默认关（`OMNI_PROVENANCE_GUARD=1` 才开）。
- 工具暴露规划默认 `off`（`OMNI_TOOL_EXPOSURE=plan` 才开）。
- memory primer / evolution kernel 默认关（增益未证）。
- A2A server 默认关（`--a2a` 才监听）。
- `maxSteps=0` 且 token 预算默认 0；成本刹车需显式配。
- 目标达成仍由 LLM 做正向 YES/NO；机械层只做否定门。

---

## 3. 旧五项短板的逐条复核

### 3.1 长时执行与恢复：已降级（机制闭环，缺小时级实跑）

**已兑现：**

- 硬时限从 60min → **8h**，软时限 30min 到点劝收尾；`OMNI_LOOP_MAX_MS=0` 可关。
- 截断识别：`finishReason` 贯通 OpenAI/Anthropic/Responses/Ollama；`ModelFinishReasons.isTruncated` 兜底；续写 ≤3 次，半截 tool_calls 不执行。
- 过窗恢复：400 prompt-too-long → `forceCompact` 后重试；529/503 → `health-fallback`。
- 崩溃续跑：每 20 步自动 checkpoint；`resumeGuidance` 列出已成功写类调用，避免重复写。
- 失控检测：`LoopGuard` 覆盖同调用重复、A→B→A 循环、同一工具结果重复、编辑振荡/抖动（[loopGuard.ts:24](../src/core/loop/loopGuard.ts#L24)）。

**仍缺：**

- 没有本轮真实 2–8 小时任务的端到端证据；「默认 8h」不等于「8h 任务能收敛」。
- `maxSteps=0` + 默认 token 预算 0：长时能力没有默认成本上限，只有显式配置才刹车。
- 截断续写是「同一模型继续」，没有跨模型/跨 provider 的续写策略。

**判定**：旧报告的「会断」不再成立；新问题是「长时任务的质量/成本证据」，属于评测契约（§6.3），不是主循环机制。

### 3.2 上下文保鲜：部分降级（机制在，效果未证）

**已兑现：**

- 工具结果头尾裁剪 + 旧工具轮剪枝，默认只裁最新一条以保前缀缓存；强制压缩路径才 aggressive。
- `TokenEstimatorCalibrator` 用真实 usage 校准估算；`ContextWindowCatalog` 补 1M 窗口。
- 压缩游标回卷：`rewindCompactionState` + 重新折叠 + 新游标落日志（G1b-c2）。
- Anthropic **滚动缓存断点**（system + 最近轮次，≤4），不是只在 system 打一个点。

**仍缺：**

- 压缩仍是「单次摘要为主」，不是多级/分层压缩；压缩后的**任务保持率**没有数字。
- 「旧工具轮剪枝」与「保前缀缓存」之间有张力：剪枝会移动前缀，缓存收益需要实测。
- 没有「上下文编辑（context editing）」式的按需删除/替换工具结果；`spill` 是外溢，不是编辑。

**判定**：机制从「单层 0.8× 摘要」升级到「裁剪 + 校准 + 游标 + 缓存断点」，但旧报告要求的「压缩后能力非劣」仍未验收。建议用 §6.3 的 A/B 契约补一条「压缩前后同一任务 pass^k」。

### 3.3 交互行动空间：已降级（浏览器 + 搜索 + 抓取闭环）

**已兑现：**

- `browser_act`：goto/click/type/press/scroll/wait_for/aria_snapshot/console/network；Playwright 默认，启动失败回退 CDP；`OMNI_BROWSER_ENGINE=cdp` 可强制。
- `web_search`：Brave/Tavily 按 key 自动注册；无 key 不注册（不假装有搜索）。
- `web_fetch`：Readability 正文抽取 + `unpdf` PDF 文本层，缺失时回退自研。
- 右栏网页预览：独立回环端口、只读、与 UI 不同源，避免同源 iframe 带 cookie 调 RPC。

**仍缺：**

- 没有 OS 级 GUI/computer-use（点击桌面、系统对话框、非浏览器应用）；这仍是 OpenHands/OSWorld 一类系统的差异点。
- 浏览器动作的「可断言结果」主要靠 aria/console/network，不是视觉 diff；前端任务仍需要人看截图。
- 搜索依赖第三方 key；无内置 provider 时的降级路径是「不注册」，这是诚实的，但用户体验上等于没有搜索。

**判定**：旧报告的「只有截图、不能点」不再成立；新差距是「GUI 级行动空间」与「视觉验证」，优先级低于边界/证据。

### 3.4 独立验证与纠错：部分降级（reviewer 默认 advisory）

**已兑现：**

- 完成闸门：无证据 ⇒ `unverified`；有工具但全失败 ⇒ 阻断；`review_diff` 干净上下文、结构化 findings；`OMNI_REVIEW_BLOCK=1` 才阻断，默认 advisory 避免误杀。
- `EvidenceLedger` 把「完成声明」与「机械证据」分开；目标检查在无成功工具时不调模型判达成。
- 子代理轨迹在 worktree cleanup 前落父存储；reviewer findings 记 `review.findings`。

**仍缺：**

- reviewer 默认不阻断——这是产品取舍（避免误杀），但也意味着「假完成」仍可能穿过默认路径。
- 目标达成仍是 LLM 正向判断；机械层只能否决「有工具但全失败」。
- provenance guard 默认关，且只匹配 `web_fetch`/`web_search`/`mcp_*` 输出片段；不做数据流分析。
- 没有「独立验证器」：代码改动仍靠测试命令，缺少「第二模型/第二工具链」的交叉验证。

**判定**：从「reviewer 只是提示词角色」升级到「有端口、有独立模型、有证据账本」，但默认强度仍弱。建议：reviewer 在「有写类改动且无测试证据」时默认阻断；provenance 先默认 `shadow`（见 §6.6）。

### 3.5 生态互操作：部分降级（客户端双栈，服务端落后一版）

**已兑现：**

- MCP v2 无状态客户端：`server/discover` + `_meta` + 默认 `auto`（v2 失败回退 legacy）；SDK 1.32 处理 2025-11-25 五版本兼容。
- A2A v1 最小面：`message/send`、`tasks/get`、`agent/getCard`；私有 `capabilities.declare`/`task.delegate` 已改名，不再自称 A2A。
- `SKILL.md`：frontmatter + 正文导入/导出；`.omniharness/skills` 与 `.claude/skills` 自动发现。
- AGENTS.md 读取（含 `@import`）。

**仍缺：**

- **MCP server 仍 `2025-11-25`**（[sdkMcpServerAdapter.ts:4](../src/adapters/mcp/sdkMcpServerAdapter.ts#L4)），而客户端已在消费 `2026-07-28`；服务端没有 `server/discover`、没有 `resultType`、没有 MRTR。
- **MCP 客户端没有认证**：`McpServerConfig` 只有 `url`，没有 header/token/OAuth 字段；受 OAuth 保护的托管 server 接不上。
- **没有 MRTR/elicitation**：v2 server 返回 `input_required` 时，客户端没有回路。
- **没有 MCP registry/conformance**：plugin registry 是私有格式；CI 没有官方一致性套件。
- **没有 ACP**：不能作为 Zed/JetBrains 的 agent 后端。
- **A2A 没有 `.well-known/agent-card.json`/签名卡**：只有 `agent/getCard` 方法。
- `SKILL.md` 只扫 `.omniharness/skills` 与 `.claude/skills`，不扫 `.agents/skills`（跨客户端主路径）。

**判定**：客户端方向已经「接得上」，服务端与认证方向仍「接不上」。这是 §6.2 与 §6.5 的依据。

### 3.6 隔离：仍成立（默认 L2）

- 默认 `sandbox=policy`（TS 策略：危险命令 + 工作区外路径）；`restricted` 在 Windows 上限制 SID 数仍为 0（如实标注）。
- `windows-acl`/`wsl-bwrap` 是新增的真隔离路径，但需显式选择，且依赖宿主能力；`windows-acl` 走可选依赖 `@deepseek-ai/dsh-sandbox-windows-acl`。
- shell 出网：`ShellCommandPolicy` 在 `OMNI_NETWORK_ALLOW` 开启时拒绝 `curl/wget/nc/ssh` 等；但默认没有开，且这是「工具层拒绝」，不是「内核层断网」。
- 注入防护默认 `off`；provenance 默认关。

**判定**：旧报告的「隔离 L2」仍成立，但已从「只有策略」升级到「策略 + 可选 OS 级 + 插件进程隔离」。默认档不翻是合理取舍（`npm install`/`git clone` 需要出网），但必须保持 `doctor` 的如实输出，不能把「可选」写成「已有」。

---

## 4. 前沿对照（2026-10）

### 4.1 Harness 架构：11 个系统的源码研究 + LangChain 的「只改 harness」实验

**来源**：arXiv [2609.00006](https://arxiv.org/abs/2609.00006)（11 个生产级 harness 的源码研究）[V]；LangChain [Improving Deep Agents with harness engineering](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering)（2026-02-17）[V]。

**关键发现：**

1. **没有通用 agent 框架**：11 个系统里没有一个在运行时 import LangGraph/Agents SDK 一类通用框架；主循环都是手写 async loop（事件溯源、流式批处理、Tokio 状态机、async-generator、预算化 stop-guard、steering queue、log-as-queue）。
2. **代码检索不是向量检索**：样本内没有系统用 embedding 做代码检索；主流是 ripgrep/tree-sitter/glob/AGENTS.md 一类确定性检索。**这直接支持本仓「BM25 为主、语义可选、拒绝向量库」的取舍**，不必因为「前沿」而改。
3. **Skills 超过 MCP**：`SKILL.md` 在 9/11 系统中出现，MCP 8/11；ACP 6/11，并出现「harness 作为 ACP host」的第三角色。
4. **安全是分层选择，不是规模函数**：Codex 四层（Starlark exec policy → lifecycle hooks → LLM approval reviewer「Guardian」→ OS sandbox）；Claude Code 三层；Hermes 保留「YOLO 也绕不过的 policy floor」；OpenCode/Hermes 没有 OS 隔离。**安全强度取决于是否显式设计，不取决于项目大小**。
5. **延迟加载与 plan mode 在扩散**：deferred tool loading 1→3 个系统、read-only plan mode 2→4 个系统（一个季度内）。
6. **Codex 的 app-server 把 Thread/Turn/Item 做成 API**：`thread/fork`、`resume`、`rollback`、`compact/start`、`turn/steer`、`turn/interrupt`；sandbox 策略 read-only → workspace-write → danger-full-access；per-task git worktree；kernel 级 `spawn_agent`/`wait_agent`。[B]（OpenAI 博客经两份二手转述，原文 403）
7. **LangChain 的 13.7 分**：模型固定为 `gpt-5.2-codex`，只改 harness，Terminal-Bench 2.0 从 **52.8 → 66.5**；三个旋钮：prompt、tools、middleware。具体 middleware：`LocalContextMiddleware`（启动时映射 cwd + 可用工具）、`PreCompletionChecklistMiddleware`（拦截退出，强制对照 spec 验证）、`LoopDetectionMiddleware`（按文件编辑计数 → 提示 reconsider）。另有「reasoning sandwich」（xhigh-high-xhigh 63.6% vs 全 xhigh 53.9%）。**注意**：单一 benchmark、厂商自报、对该模型调过参；Opus 4.6 在同一 harness 上 59.6%。[V]

**对本仓的含义（逐条对照）：**

| 前沿机制                      | 本仓现状                                                                       | 结论                                            |
| ----------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| 完成前强制验证                | 完成闸门 + 证据账本 + reviewer（advisory）                                     | **已有**，不需要再抄；需要的是「默认阻断强度」  |
| Doom-loop 检测                | `LoopGuard`（重复/循环/结果冗余/编辑振荡）                                     | **已有且更细**，不要重复实现                    |
| 工具输出外溢/裁剪             | `ToolResultSpiller` + `ContextShapers`                                         | **已有**，缺「裁剪后任务保持率」证据            |
| 提示缓存断点                  | Anthropic 滚动断点（≤4）                                                       | **已有**，可补 OpenAI/Gemini 的缓存命中归因     |
| 子代理 worktree 隔离          | `worktreeOps`（git worktree + 失败 fail-closed）                               | **已有**；DAG 节点仍未按 worktree 隔离          |
| 延迟工具加载                  | `ToolExposurePlanner` + `tool_search`，**默认 off**                            | **已有但没默认开**；这是最便宜的一笔 token 优化 |
| Skills 渐进披露               | `SKILL.md` 导入 + `selectForPrompt` 注入正文；无「metadata → body → 资源」分层 | **部分**；见 §6.5                               |
| Policy-as-code + policy floor | 六档审批 + hooks 兼容 + reviewer；**没有机器可读 policy 文件/硬 floor**        | **缺**；见 §6.6                                 |
| Workspace trust               | **缺**；项目配置自动生效                                                       | **缺**；见 §6.1（本轮最高优先）                 |
| Thread/Turn API               | `threads.*` RPC + checkpoint/rewind；`compact` 不是一等操作                    | **部分**；可把 compact 做成可寻址操作           |
| ACP                           | **缺**                                                                         | **缺**；见 §6.5                                 |
| 角色化模型/推理预算           | 全局 model/reasoning；reviewer 可用 `OMNI_REVIEW_MODEL`                        | **缺**；见 §6.4                                 |
| trace→patch 闭环              | `sessionTelemetry` 聚合 + evolution kernel，但无「从轨迹生成补丁」             | **缺**；见 §6.4                                 |
| Aider 式 repo map             | `repoMap` + 代码图是实验档，生产主路径是 BM25                                  | **已探索**；不建议为此上 tree-sitter（见 §8）   |

### 4.2 协议：MCP 断代、Skills 无版本、A2A 浅、ACP 成事实标准

**MCP 2026-07-28**（[官方 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)）[V]：

- **无状态核心**：删 `initialize`/`Mcp-Session-Id`；每个请求在 `_meta` 带版本与能力；新增必选 `server/discover`；跨调用状态必须是 server 铸造的显式 handle。
- **MRTR**（SEP-2322）：server 返回 `resultType:"input_required"` + `inputRequests`，client 带 `inputResponses` 重试；`resultType` 必填。取代 server 发起的 elicitation/sampling/roots。
- `subscriptions/listen` 取代 GET stream + `resources/subscribe`；list 结果带 `ttlMs`/`cacheScope`；`Mcp-Method`/`Mcp-Name` 头必填。
- **扩展成框架**：Tasks、MCP Apps（`ui://` + sandboxed iframe + postMessage）、Skills-over-MCP、Enterprise-Managed Authorization、OAuth client-credentials。
- **Auth**：server = OAuth 2.1 resource server；必须暴露 RFC 9728 metadata；client 必须带 RFC 8707 `resource`、校验 RFC 9207 `iss`、PKCE S256、403 step-up；DCR 被 CIMD 取代。
- **Registry 仍是 preview**（metadata-only `server.json`）；**一致性套件已制度化**（SEP-2484：任何 Final standards-track SEP 必须有 conformance scenario）。

**Agent Skills**（[agentskills.io](https://agentskills.io/specification)）[V]：`SKILL.md` + frontmatter（name/description；可选 license/compatibility/metadata/allowed-tools）；渐进披露 = metadata → body → bundled files。**没有版本号、没有 releases、没有 conformance**；2026-08-20 审计：11 个客户端文档声明读 `SKILL.md`，8/11 扫 `.agents/skills`，Claude Code 只扫 `.claude/skills`；frontmatter/consent/context budget 各家不一致。

**A2A**（[v1.0.0](https://github.com/a2aproject/A2A/releases/tag/v1.0.0)，2026-03-12）[V]：150+ 组织，但 Agent Card JWS 签名可选、registry/discovery 规范没有落地——「A2A-compliant」只证明 wire format + 自述卡，不证明身份/行为。[I]

**ACP**（[agentclientprotocol.com](https://agentclientprotocol.com/)，registry 2026-01-28）[V]：~45 个 agent（Claude Code adapter、Codex、Cursor、Copilot、Gemini CLI、OpenCode、OpenHands、Qwen、Kimi 等），客户端 Zed + JetBrains；**事实上的 coding-agent↔editor 标准**。

**AG-UI 1.0**（2026-09-30）[V]：agent→UI 事件流，Google/MS/Amazon/Oracle 采用；只解决 agent↔UI，不解决 agent↔agent。

**Docker Sandbox Kit Spec v3**（2026-09）[V]：权限声明进 OCI 镜像、host 审批、两套一致性套件；方向值得观察，但**现在接是「权威」不是「消息」**，跳过。

**对本仓的含义**：客户端已消费 2026-07-28 的 `server/discover`，但**没有认证、没有 MRTR、没有 conformance**；server 仍 2025-11-25。**先把客户端认证和 MRTR 补齐，再谈 server 重写**（等 SDK v2 更稳）。

### 4.3 评测与可观测：harness effect 很大，但单次跑分噪声也很大

**Benchmark 形态**（[Terminal-Bench 4.0](https://www.tbench.ai/news/terminal-bench-4-0)、[SWE-bench Pro V2](https://arxiv.org/abs/2610.24206)、[τ²-bench](https://github.com/sierra-research/tau2-bench)、[METR TH1.1](https://metr.org/blog/2026-01-29-time-horizon-1-1/)、[GAIA 2](https://arxiv.org/abs/2602.11964)、[OSWorld 2.0](https://arxiv.org/abs/2606.29537)）[V]：

- Terminal-Bench 从 2.0 → 2.1 → 3.0 → 4.0（2026-08-28），**语义化版本**（x=重跑、y=重评、z=复用）；4.0 固定 8h 超时，移除 8 个饱和/泄题/拒答任务，修 19 个；榜单同时报 **resolution / cost / tokens**。
- SWE-bench Pro V2：修/退 480/731 个任务（23 工程师、404h），限制网络到模型端点，**干净容器重评每个 patch**；642 任务，top 99.4%，Hard split 52.9–98.0%。
- τ²：**pass^k** 暴露「pass@1 看不出的不一致」；2.0 用冻结集，1.x/2.0 分数不可比。
- METR：任务长度视野（50% 可靠性）196.5 天 doubling（130.8 天 since 2023）。

**Harness effect（为什么必须做 A/B，而不是看单次分数）**：

- 同一模型、同一任务，只改「截短陈旧工具结果」——SWE-bench Verified 169 题上 per-task fail-to-pass **28% → 49%**、complete solves **43 → 72**，并迁移到 3 个其他模型。[V]（[arXiv 2608.26218](https://arxiv.org/abs/2608.26218)）
- Goose/OpenCode/OpenHands 在 50 个 TB-Pro 任务上，pass rate 只差 2–10pp，但 **tokens per solved task 最高差 40×**。[V]（[Zenodo 19819492](https://zenodo.org/records/19819492)）
- 仅资源限制就能让 TB2.0 移动 6pp；基础设施错误 5.8% → 0.5%。[V]（Anthropic infra-noise）
- 换 eval 框架本身都能让模型分数变（Vivaria→Inspect：GPT-4o 9.2→6.0 min，o3 94→78）。[V]（METR）

**结论 [I]**：≤3pp 的单次差异不可测量；只有**同环境、配对、重复 k≥3、报 pass^k + cost/token per solved** 才算证据。这正是本仓缺的「评测契约」。

**OTel GenAI semconv**（[semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai)）[V]：已从 core 拆出，仍是 Development，锚 core **1.44.0**；新增 agent spans（`create_agent`/`invoke_agent`/`invoke_workflow`/`plan`/`execute_tool`/skills/MCP）和 `gen_ai.evaluation.result`；content capture 默认 off，生产应把内容放外部存储、span 上放引用。

**本仓现状**：`TraceSpanBuilder` 只产 `tool.*`/`model.*`/`session` 三类 span（[traceSpanBuilder.ts:8](../src/observability/traceSpanBuilder.ts#L8)）；**没有 `invoke_agent` 父 span**，也没有 `gen_ai.evaluation.result`。`session_meta` 只记 workspace/model（[eventFactory.ts:215](../src/core/eventFactory.ts#L215)），没有工具集/提示哈希/预算。这使「按 session 聚合成本/延迟」只能靠自研脚本，不能在任何 OTLP 后端里按 agent 维度查询。

### 4.4 安全：MXC 把「进程/会话/VM」统一成策略，CaMeL 把「外泄」变成结构问题

**隔离后端（2026）** [V]：

- **Windows MXC（Microsoft Execution Containers）2026-10-07 GA**：一个策略接口下四种后端——AppContainer（进程）、session container（独立账户 + 独立桌面/剪贴板/输入）、WSL、实验 microVM；Enforcement/Learning/Permissive 三档；策略在工作负载之外。Copilot、Codex、OpenClaw、Replit 已采用。**这对 Windows 本地优先的本仓特别相关**：`windows-acl` 是入口，MXC 是「策略层」的下一站。
- Linux：Landlock/seccomp/bubblewrap；Apple Seatbelt（已弃用但仍在用）；gVisor（Sentry 用户态内核，CVE-2026-96812 提醒「不是零」）；microVM（Firecracker/E2B/Daytona）；WASI 0.3（2026-06-11，capability worlds）。
- **真正有后果的逃逸是 agent 级**：Snowflake Cortex Code CLI 通过间接注入绕过 HITL 审批 + 沙箱模式（2026-03-16，1.0.25 修）。**命令门禁比 hypervisor 更值得加固**。[V]

**注入防御**：

- **Lethal trifecta**：不可信内容 + 私有数据 + 出网，三者同现即高风险；这是设计时 lint，不是运行时分类器。[V]
- **CaMeL**：P-LLM 从可信 query 生成代码；Q-LLM 只解析不可信数据、无工具；值带 capability（provenance + 允许的读者）；解释器在每次调用前查策略。AgentDojo **67%** 任务可解且有可证明安全；GPT-4o 攻击成功 **233 → 0**（仅隔离）。非目标：纯文本操纵、需要未读数据的计划。[V]（[arXiv 2503.18813](https://arxiv.org/abs/2503.18813)）
- **本仓可借的「CaMeL-lite」**：现有 `ProvenanceTracker` 只是「外部输出片段 → 写类参数」的字符串匹配，默认关；把它扩成「不可信标签 → 写/出网参数」的污点检查，就是低成本的 leg removal。

**供应链**：

- **Sigstore 签名技能已可用**：Chainguard 把发布的 skill 签成 Sigstore bundle（chain-to-root、issuer identity、透明日志、digest），`chainctl skills verify` + `skills-lock.json` pin；`cosign ≥3.1.1` 也可。[V]
- 策略引擎：OPA/Rego 成熟，Cedar 是 AWS 原生替代；本仓的六档审批 + hooks 已覆盖「动作级」，缺「机器可读 policy 文件 + 不可绕过的 floor」。
- 合规：EU AI Act 高风险期限被 2026-07 的 Digital Omnibus 推到 **2027-12-02**（独立）/ **2028-08-02**（嵌入）；GPAI 义务自 2025-08 起。审计链仍是刚需，但紧迫性下降。[V]

### 4.5 记忆与学习：机制在扩散，评测比机制更脆弱

- **Letta/MemGPT**：四层（buffer / in-context core / recall / archival），agent 用工具编辑；**sleep-time agents**（0.7.0，arXiv 2504.13171）用第二个更强模型离线重写主 agent 的记忆。[V]
- **Mem0**：抽取 + 去重，user/session/agent 三 scope；v3 hybrid semantic+BM25+entity。厂商数字（26% judge gain、91% p95、90% token）需复核。[V]/[I]
- **Zep/Graphiti**：时序知识图谱，bi-temporal 边（「何时为真」）；DMR 94.8% vs MemGPT 93.4%，LongMemEval 最高 +18.5%。[V]
- **GEPA**：反思式 prompt 进化，ICLR 2026 oral，平均 +6%（最高 20%）超 GRPO，rollout 少 35×。**与本仓 evolution kernel 天然契合**。[V]
- **LongMemEval**：500 题，考抽取/多会话/时序/知识更新/拒答；助手与长上下文 LLM 掉约 30%。[V]
- **评测脆弱性**：2026-09 审计发现 LongMemEval-S 的 reader lane 93→479/500、重判会翻标签、LoCoMo 的 token-F1 收益在答案行抽取后消失、没有 untouched holdout。[V]
- **MINJA**：仅通过 query 就能注入记忆（不需要写权限），靠 bridging steps。[V]

**本仓现状**：`FileLongTermMemory` 有 trust 字段、`expiresAt`、BM25 + `TimeDecay`；但 `rankWithDecay` **只按时间衰减，不按 trust 加权**（[timeDecay.ts:56](../src/adapters/memory/timeDecay.ts#L56)）；primer 默认关；没有 LongMemEval 适配。**MINJA 类攻击下，trust 只在写入/回灌文案层生效，检索排序不 consult 它**——这是可修的具体缺口。

### 4.6 GitHub 上的前沿方向与本仓落点

> 说明：下表只列本轮读到源码/官方文档的项目；「借用」不是「照搬」，落点列写的是本仓已有端口/文件。

| 方向              | 代表项目                                                                                                                                                                                                                       | 可借机制                                                              | 本仓落点                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| 开放 harness 平台 | [openai/codex](https://github.com/openai/codex)                                                                                                                                                                                | app-server 的 Thread/Turn/Item、fork/rollback/compact/steer、worktree | 已有 `threads.*`/checkpoint；补 `compact` 一等操作 + role 路由 |
| 终端 agent        | [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)                                                                                                                                                        | **trusted folders + discovery phase**、loop detection、A2A            | 新增 workspace trust（§6.1）；LoopGuard 已有                   |
| 事件溯源 harness  | [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands)                                                                                                                                                            | 事件溯源引擎、可插拔 condensation、ACP host                           | 事件流已有；补 ACP（§6.5）                                     |
| 配方/多 agent     | [block/goose](https://github.com/block/goose)                                                                                                                                                                                  | recipes/subrecipes、MCP elicitation/roots、ACP provider               | `workflow` 已有；补 elicitation 回路                           |
| Plan/Act          | [cline/cline](https://github.com/cline/cline)                                                                                                                                                                                  | 模式级不同模型、checkpoints、hooks、ACP                               | plan 模式已有；补模式级模型（§6.4）                            |
| 客户端/服务端     | [sst/opencode](https://github.com/sst/opencode)                                                                                                                                                                                | 强 client/server 分离、log-as-queue、anchored summaries               | 已有 HTTP/SSE + SDK；可借 anchored summary                     |
| LSP 上下文        | [charmbracelet/crush](https://github.com/charmbracelet/crush)                                                                                                                                                                  | LSP grounding、`serve` 共享 workspace                                 | LSP 工具已有；补 IDE 入口（ACP）                               |
| Repo map          | [Aider-AI/aider](https://github.com/Aider-AI/aider)                                                                                                                                                                            | 文件依赖图 + token 预算的 repo map                                    | `repoMap` 已有（实验档）；不建议上 tree-sitter                 |
| Deep agents       | [langchain-ai/deepagents](https://github.com/langchain-ai/deepagents)                                                                                                                                                          | 三个 middleware、reasoning sandwich、trace-analyzer skill             | 完成闸门/LoopGuard 已有；补 role + trace→patch（§6.4）         |
| 记忆              | [letta-ai/letta](https://github.com/letta-ai/letta)、[mem0ai/mem0](https://github.com/mem0ai/mem0)、[getzep/graphiti](https://github.com/getzep/graphiti)                                                                      | sleep-time、抽取/去重、时序 KG                                        | 记忆栈已有；补 trust 排序 + LongMemEval（§6.7）                |
| 协议              | [modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol)、[a2aproject/A2A](https://github.com/a2aproject/A2A)、[agentclientprotocol](https://github.com/agentclientprotocol/agent-client-protocol) | MCP 2026-07-28、A2A v1、ACP                                           | 客户端 v2 已有；补 OAuth/MRTR/ACP（§6.2/§6.5）                 |
| 评测              | [UKGovernmentBEIS/inspect_ai](https://github.com/UKGovernmentBEIS/inspect_ai)                                                                                                                                                  | dataset+solver+scorer、容器化、`.eval` 日志                           | 新增内部 A/B runner（§6.3）；不追榜                            |
| 可观测            | [open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai)                                                                                                                      | `invoke_agent`/`plan`/`evaluation.result`                             | 加 agent/eval span（§6.3）                                     |
| 隔离              | [e2b-dev/E2B](https://github.com/e2b-dev/E2B)                                                                                                                                                                                  | microVM per sandbox                                                   | 暂不接；Windows 先看 MXC                                       |
| 签名              | [sigstore/cosign](https://github.com/sigstore/cosign)                                                                                                                                                                          | Sigstore bundle + lockfile pin                                        | 插件已有 Ed25519；技能补签名/lock（§6.5）                      |

---

## 5. 差距矩阵（当前 vs 前沿）

> 判定：**领先** = 机制/治理明显强于参照；**持平** = 能力面相当；**部分** = 有机制但未闭环/未默认；**缺失** = 没有可用路径。优先级按「对本地可信 harness 的实际收益」排，不按功能条数。

| 能力                 | 现状（证据）                                                | 前沿参照                         | 判定 | 优先级 | 成本 |
| -------------------- | ----------------------------------------------------------- | -------------------------------- | ---- | ------ | ---- |
| 工作区信任/项目配置  | 项目配置 + bundle patch 自动生效；`mcpServers` 启动即 spawn | Gemini trusted folders / VS Code | 缺失 | **P0** | S/M  |
| MCP 客户端认证       | `McpServerConfig` 只有 `url`；无 header/OAuth               | MCP OAuth 2.1 + PRM/CIMD         | 缺失 | **P0** | M    |
| MCP MRTR/elicitation | 无 `input_required` 回路                                    | MCP 2026-07-28 MRTR              | 缺失 | P1     | M    |
| MCP server 版本      | 2025-11-25（SDK）                                           | 2026-07-28 无状态                | 落后 | P2     | L    |
| MCP conformance      | 无官方套件                                                  | SEP-2484 / conformance CLI       | 缺失 | P1     | S    |
| ACP                  | 无                                                          | ACP registry（~45 agent）        | 缺失 | P1     | M    |
| A2A 发现/签名        | 仅 `agent/getCard`                                          | `.well-known` + JWS（可选）      | 部分 | P2     | S    |
| Skills 可移植        | 只扫 `.omniharness`/`.claude`                               | `.agents/skills`（8/11）         | 部分 | P1     | S    |
| Skills 签名          | 插件有 Ed25519；技能无签名/lock                             | Sigstore bundle + lockfile       | 部分 | P2     | S/M  |
| 评测契约             | 无 run manifest；无 paired A/B；探针机制级                  | Harbor/Inspect + pass^k          | 缺失 | **P0** | S/M  |
| Agent span           | 无 `invoke_agent`/`plan`；只有 tool/model/session           | OTel GenAI semconv               | 缺失 | P1     | S    |
| 角色化路由           | 全局 model/reasoning；reviewer 单 env                       | Amp/Cline role routing           | 缺失 | P1     | S    |
| Trace→patch          | `sessionTelemetry` 只聚合，无补丁建议                       | LangChain trace-analyzer         | 缺失 | P1     | M    |
| 污点/出网            | provenance 默认关；egress 只 fetch                          | CaMeL / lethal trifecta          | 部分 | P1     | M    |
| Policy-as-code/floor | 六档审批 + hooks；无机器可读 policy/floor                   | Codex 4 层 / Hermes floor        | 部分 | P1     | M    |
| 记忆检索信任         | `TimeDecay` 只按时间；trust 不进排序                        | Zep/Mem0 + trust                 | 部分 | P2     | S/M  |
| 长时执行             | 8h/续写/forceCompact/fallback/checkpoint                    | TB 4.0 8h                        | 持平 | —      | —    |
| 上下文压缩           | 裁剪 + 校准 + 游标；单次摘要为主                            | 多级压缩                         | 部分 | P2     | M    |
| 交互行动             | browser_act + search + readability/unpdf                    | OpenHands/OSWorld                | 持平 | —      | —    |
| 独立验证             | reviewer advisory + evidence ledger + `unverified`          | Cognition reviewer               | 部分 | P1     | S/M  |
| 默认隔离             | `policy` L2；OS 级可选                                      | MXC / bwrap / Seatbelt           | 落后 | P1     | M/L  |
| 插件隔离             | Worker L3 + 能力 broker + 签名                              | Codex worktree / OS sandbox      | 领先 | —      | —    |
| GitHub PR/IDE        | 无 PR 闭环；无 IDE/ACP                                      | Codex cloud / Cursor / ACP       | 缺失 | P2     | M    |

---

## 6. 还值得做的五件事（设计 + 验收）

> 6.1–6.3 都是 P0；本节编号按主题而非实施顺序，实施顺序见 §7（信任 → 评测 → MCP 认证）。

### 6.1 P0：工作区信任闸（本轮最高优先）

**为什么现在做**（新发现，不是旧报告的内容）：

本仓的配置分层是「用户级 → 项目级 → profile → **bundle 补丁层** → 环境变量」（[configFile.ts:137](../src/config/configFile.ts#L137)）。其中：

- 项目级 `omniharness.json` 由 `find(workspace)` 自动发现并合并；
- `.omniharness/bundle-patches/*.json` 由 `loadBundlePatchLayer(workspace)` **自动读取并应用**（[configError.ts:460](../src/config/configError.ts#L460)）；
- `ArgParser.configDefaults` 把 `mcpServers`、`baseUrl`、`approval` 等映射进 CLI 默认值（[argParser.ts:481](../src/cli/argParser.ts#L481)，`baseUrl` 在 [argParser.ts:518](../src/cli/argParser.ts#L518)）；
- `CliBuildConfig.bridgeMcpServers` 在启动时**直接 spawn** 这些 MCP server（[cliBuildConfig.ts:410](../src/cli/cliBuildConfig.ts#L410)）。

因此，「clone 一个仓库 → `npm start`」的信任边界，等同于「执行仓库里的 `omniharness.json` + `.omniharness/bundle-patches/*.json`」。攻击面至少包括：

1. `mcpServers[].command`：启动即执行任意本地命令（stdio server）；
2. `approval: "auto"` / `sandbox: "passthrough"` / `escalation: "auto"`：把审批与沙箱降到最低；
3. `baseUrl`：把用户级 `providerKeys` 里的凭据导向攻击者端点（`configDefaults` 会合并用户 key 与项目 baseUrl）；
4. `costBudget*` / `modelRouter`：不是 RCE，但可造成成本/路由操纵。

这不是「本仓独有的漏洞」——VS Code 的 Workspace Trust、Gemini CLI 的 trusted folders 都是为同一类问题存在的。**但本仓目前没有任何门禁**：`serve` 的横幅只打印工作区来源，不打印「本项目将执行 3 个 MCP 命令 / 把 approval 设为 auto」。

**设计（最小可用）：**

1. **信任存储**：用户级 `~/.omniharness/trust.json`，键 = `sha256(realpath(workspace))`，值 = `{ trustedAt, configHash, mode: 'trusted'|'restricted', decisions }`。
2. **默认 restricted**：新工作区首次启动时，**不应用**「可执行/可降权」键：
   - 执行类：`mcpServers`、`bundle-patches`；
   - 权限类：`approval`、`sandbox`、`escalation`、`elevatedSandbox`；
   - 凭据重定向类：`baseUrl`（可保留 `model`/`reasoning` 等只读语义键）。
     其余键照常合并；被忽略的键逐条打印原因（沿用 F9 的「可行动告警」风格）。
3. **发现式确认**：首次启动打印一份「本仓库请求的能力清单」——MCP 命令 + args、approval/sandbox 目标值、baseUrl 是否变化、bundle patch 文件列表；交互式 `y/N`，非交互式 fail-closed 到 restricted。CLI 加 `--trust-workspace=once|always`；UI 在设置里给「信任此文件夹」。
4. **策略地板（policy floor）**：即使 trusted，项目级配置也**不能**把 `approval` 设为 `auto`、把 `sandbox` 设为 `passthrough`——这两项只接受 CLI 显式旗标（`--auto-approve` / `--sandbox passthrough`）。这是 Hermes「policy floor that survives YOLO」的本地化。
5. **TOFU 哈希**：信任后记录 `configHash`（项目配置 + bundle patches + MCP 命令串）；文件变化 ⇒ 重新确认（避免「信任一次，之后被替换」）。
6. **与现有机制的关系**：不替代插件签名/进程隔离；它管的是「工作区输入」，插件签名管的是「插件制品」，两者正交。

**验收（必须能对已知坏输入变红）：**

- 恶意夹具 1：项目 `omniharness.json` 写入 `mcpServers: [{name:'x', command:'node', args:['-e','...']}]` ⇒ restricted 下**不 spawn**，告警含命令；
- 夹具 2：`approval:"auto"` + `sandbox:"passthrough"` ⇒ restricted 下被忽略，`doctor` 显示实际值；
- 夹具 3：`baseUrl:"https://evil.example"` ⇒ restricted 下不覆盖用户 baseUrl，且提示「已忽略」；
- 夹具 4：`.omniharness/bundle-patches/x.json` 改 `approval` ⇒ 不生效；
- 正例：`--trust-workspace=always` 后同一夹具生效；改配置后再次启动要求重新确认；
- 变异：删掉 restricted 分支 ⇒ 上述 4 例全红。

**成本/风险**：S/M（2–4 天）。风险是首次使用摩擦；用「信任一次 + UI 明确清单」抵消；不要做「默认信任本地路径」的例外。

### 6.2 P0：MCP 客户端 OAuth + MRTR + 一致性

**现状证据：**

- `McpServerConfig` 只有 `name/command/args/env/cwd/url`（[mcpServerConfig.ts](../src/ports/mcp/mcpServerConfig.ts)），**没有 header/token/OAuth**；
- `McpStatelessClient` 只做 `server/discover` + `_meta`，没有 `input_required` 处理（[mcpStatelessClient.ts:24](../src/mcp/mcpStatelessClient.ts#L24)）；
- `mcp` 目录下没有 OAuth/PRM/CIMD 相关代码（grep 零命中）；
- server 仍是 2025-11-25（[sdkMcpServerAdapter.ts:4](../src/adapters/mcp/sdkMcpServerAdapter.ts#L4)）。

**为什么重要**：MCP 生态的托管 server（GitHub、Sentry、Linear、Figma、企业内网）几乎都要求 OAuth 2.1；没有认证，本仓只能接「本地 stdio / 匿名 HTTP」，这与「通用 harness」的定位不符。

**设计：**

1. **认证**：新增 `McpAuthProvider` 端口；用现有 `openid-client` + `jose` 实现：
   - 401 → 读 `WWW-Authenticate` → RFC 9728 PRM → AS metadata；
   - 授权码 + PKCE S256；RFC 8707 `resource`；校验 RFC 9207 `iss`；
   - CIMD（Client ID Metadata Document）优先，DCR 仅兼容；
   - 403 `insufficient_scope` → step-up；
   - token 存 vault（复用 DPAPI/AES-GCM），按 server + resource 作用域。
2. **MRTR**：`callTool` 收到 `resultType:"input_required"` ⇒ 把 `inputRequests` 转成 `ask_user`/审批 UI ⇒ 带 `inputResponses` 重试；无 UI 时 fail-closed（拒绝，不猜测）。
3. **一致性**：新增 `scripts/mcpConformance.mjs`，跑官方 conformance CLI 的关键场景（discover、tools/list、tools/call、input_required、auth 401→PRM），进 fast 层或 nightly。
4. **server 侧**：**不手写 2026-07-28**；等 `@modelcontextprotocol/sdk` v2 支持后升级，保留 2025-11-25 兼容。文档明确「服务端落后一版」。
5. **配置**：`mcpServers[]` 增加 `auth: { type:'oauth'|'bearer'|'none', ... }`，但**只允许用户级配置**（工作区信任闸的又一理由）。

**验收：**

- mock OAuth server：401 → PRM → 授权码 → token → `tools/list` 成功；token 过期 → refresh；
- `input_required`：server 要求确认 → UI 弹窗 → 带 `inputResponses` 重试成功；无 UI ⇒ 明确失败；
- conformance 脚本在 CI 通过；legacy server 仍可连（双栈）；
- 变异：删掉 `resource` 参数 ⇒ 授权失败（红）。

**成本/风险**：M（5–8 天）。风险是 spec 仍在演进；用「适配器 + 双栈 + 明确版本锚」控制。

### 6.3 P0：评测契约（run manifest + paired A/B + agent span）

**现状证据：**

- `session_meta` 只有 workspace + model（[eventFactory.ts:215](../src/core/eventFactory.ts#L215)）；
- 没有 run manifest / config hash / tool-set hash / prompt hash（grep 零命中）；
- `TraceSpanBuilder` 只有 tool/model/session（[traceSpanBuilder.ts:8](../src/observability/traceSpanBuilder.ts#L8)），没有 `invoke_agent`；
- `agentPlanningAb.mjs` 是单次 A/B，只报 steps/todoWrites/ok/duration，不报 token/cost/pass^k；
- 探针（recall/tool-exposure/memory/evolution）是机制级，不是任务级。

**设计：**

1. **Run manifest**：每次 `exec`/`serve` 回合写一份 JSON（挨着 session log 或 `~/.omniharness/runs/`）：
   - solver：model、adapter、reasoning、prompt hash、tool set hash、exposure mode、subagent 配置；
   - environment：workspace hash、sandbox 档、approval 档、网络白名单；
   - eval：dataset/task id、verifier hash、semconv anchor、资源上限；
   - code：git commit + dirty flag。
2. **Paired A/B runner**：把 `agentPlanningAb.mjs` 泛化为 `tools/eval/harnessAb.mjs`：
   - 输入：N 个任务（含 oracle 正解与故意坏解）、两套配置、k≥3；
   - 输出：pass^k、tokens/solved、cost/solved、wall time、失败签名；
   - 统计：配对 bootstrap 95% CI（复用 `tools/probes` 的两关纪律）；
   - 预算：每 run token/cost 上限；超限即停。
3. **任务集**：10–20 个本地任务，覆盖「读改测」「多文件重构」「前端点击断言」「长会话压缩后续跑」「MCP 工具调用」「被注入内容后的写操作」。每个任务有 **oracle 解**和 **bad 解**（证明 verifier 有牙齿）。
4. **OTel**：加 `invoke_agent`（session 级父 span）、`plan`（规划阶段）、`gen_ai.evaluation.result`（eval 结果子 span）；内容仍留 JSONL，span 只放引用/哈希。
5. **Replay**：mock adapter 录制/回放（key = prompt hash + seed）；golden event sequence 断言 replay 逐条一致；CI 零网络。
6. **门禁**：把「run manifest 存在且 hash 可复算」「golden trace 不变」「探针阈值」进 fast 层；nightly 跑 k=3 的 A/B。

**验收：**

- 同一任务、两套配置、k=3：输出 pass^k + tokens/solved + CI；报告可复算；
- 换一个无关配置（如只改日志级别）⇒ 结论「无显著差异」，证明不会把噪声当收益；
- 删掉 `invoke_agent` span ⇒ 判据红；
- replay 两次的事件序列逐条一致。

**成本/风险**：S/M（3–5 天）。风险是「内部任务集」容易过拟合；用 held-out 任务 + 版本化任务集（TB 的语义化版本思路）控制。

### 6.4 P1：角色化模型/推理预算 + trace→patch 闭环

**现状证据：**

- `RouterStrategy` 只有 `least-cost`/`round-robin`/`by-task`/`by-context`/`health-fallback`（[routerStrategy.ts](../src/ports/model/routerStrategy.ts)）；
- `reasoning` 是全局配置；reviewer 只能通过 `OMNI_REVIEW_MODEL` 指定一个 entry；
- `sessionTelemetry.mjs` 已经能聚合「有效时长/调用/token/缓存命中/压缩/工具失败/结果冗余」，但没有「从轨迹生成补丁」的回路；
- evolution kernel 有 signal/ledger/rollback，但默认关，且信号来自 production telemetry 的失败签名/成功密度。

**设计：**

1. **角色表**：配置 `modelRoles: { planner, executor, reviewer, compactor, subagent }`，每项 `{ model, reasoning }`；`ModelRouter` 增加 `by-role` 策略，按调用点传入 role。
2. **Reasoning sandwich**：planner/reviewer 默认 `xhigh`，executor `high`，compactor `low`；用 A/B 验证（§6.3）再翻默认。
3. **Trace analyzer**：新 skill `harness-trace-analyzer`（或 `tools/eval/traceAnalyzer.mjs`）：
   - 输入：最近 N 个 session 的 JSONL/OTLP；
   - 聚类失败签名：工具错误、循环、压缩后重复读、`unverified`、reviewer findings、成本异常；
   - 输出：排序的「harness 级修复提案」（prompt 片段、tool exposure 类别、compaction 阈值、reviewer 规则），每条带证据 session id；
   - **不自动改代码**：提案进 evolution ledger 的候选区，过 §6.3 的 A/B 才允许晋升。
4. **与 evolution kernel 的关系**：analyzer 产出的是 `EvolutionSignal` 的一种（失败签名 → 候选资产），复用现有 ledger/rollback；不要另起一套。

**验收：**

- 角色表生效：planner 用 A 模型、executor 用 B 模型，日志/span 可区分；
- analyzer 在 50 个 session 上产出 ≥3 条可行动提案，每条能追到证据；
- 提案未过 A/B 不得晋升（变异：跳过 A/B ⇒ 红）。

**成本/风险**：角色 S（1–2 天），闭环 M（5–8 天）。风险是「自动改自己」的漂移；坚持「提案 → 评测 → 人工批准」三段，不做自动合并。

### 6.5 P1：分发面——ACP + 技能可移植/签名 + A2A 卡

**现状证据：**

- 无 ACP（grep 零命中）；
- `.agents/skills` 未扫（[skillMdDiscovery.ts:21](../src/skill/skillMdDiscovery.ts#L21) 只有 `.omniharness/skills` + `.claude/skills`）；
- 技能无签名/lock；插件有 Ed25519 + `.ohb`；
- A2A 只有 `agent/getCard`（[a2aServer.ts:81](../src/a2a/a2aServer.ts#L81)），无 `.well-known`。

**设计：**

1. **ACP server**：`omniharness acp`（stdio JSON-RPC），实现 `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/update`、`request_permission`；把现有事件流映射到 ACP 的 session update；权限请求走现有审批端口。
2. **技能路径**：扫描顺序 `.agents/skills` → `.claude/skills` → `.omniharness/skills`；`.agents/skills` 为主，其余兼容；导入时保留 frontmatter 的 `allowed-tools` 到权限声明（不自动信任）。
3. **签名**：复用现有 Ed25519 基础设施，给 skill pack 加 `manifest.json` + `signature` + `skills-lock.json`（name/version/digest/signer）；导入时验签，严格档无签名即拒。
4. **A2A**：加 `GET /.well-known/agent-card.json`，返回现有 `A2aAgentCard`；可选 JWS（`jose`）签名；不实现 registry（规范未落地）。

**验收：**

- Zed 通过 ACP 连接，发一个 prompt，能看到流式 update 与权限弹窗；
- `.agents/skills` 下的 skill 被自动发现；篡改签名包被拒；lockfile 固定 digest；
- `curl /.well-known/agent-card.json` 返回可验签的卡（若启用签名）。

**成本/风险**：ACP M（5–8 天），技能/卡 S（1–2 天）。风险是 ACP 版本演进；适配器保持薄，协议细节集中在 `src/acp/`。

### 6.6 P1：安全纵深——taint + egress proxy + provenance shadow + policy floor

**现状证据：**

- `ProvenanceTracker` 默认关，只匹配 `web_fetch`/`web_search`/`mcp_*` 输出片段，塞进写类参数才拒绝（[provenanceTracker.ts:11](../src/security/provenanceTracker.ts#L11)）；
- `NetworkEgressGuard` 只包 `globalThis.fetch`；shell 出网只在 `OMNI_NETWORK_ALLOW` 已配置时被工具层拒绝；
- 没有 machine-readable policy 文件/floor；
- 默认 `sandbox=policy` L2；`windows-acl`/`wsl-bwrap` 可选。

**设计：**

1. **Provenance 默认 `shadow`**：用现有 `EnforcementModeResolver` 三档（off/shadow/enforce），先在生产流量记录「本该拒绝」的证据，再翻 enforce；避免直接误杀。
2. **Taint 扩展**：把「不可信来源」从 web/MCP 扩到 `read_file` 的工作区外内容、`shell` 输出、附件解析；给 `write_file`/`apply_patch`/`shell`/`web_fetch` 参数做「污点 → 目标」检查；不是完整 CaMeL，但去掉「读到注入 → 原样写出」这条最短路径。
3. **Egress proxy**：本机回环 HTTP 代理 + 域名 allowlist；`fetch` 与 shell 子进程都走它（shell 设 `HTTP_PROXY`/`HTTPS_PROXY` + 拒绝直连）；审计链记录每条出站。
4. **Policy floor**：机器可读 `policy.json`（allow/deny/requires-approval），在审批之前求值；项目级配置不能降低 floor（与 §6.1 共用）。
5. **MXC 评估**：Windows 上把 `windows-acl` 作为 MXC 的一个后端候选；先做「策略 schema 对齐」，不急着换实现。

**验收：**

- 注入内容（web_fetch 结果）进入 `write_file`/`shell` 参数 ⇒ shadow 记录、enforce 拒绝；
- 出网 allowlist 外的请求（fetch + curl）被拒；审计链有记录；
- policy floor 下，项目配置写 `approval:auto` 不生效；
- 误报率有数字（shadow 期），低于阈值才翻 enforce。

**成本/风险**：M（5–8 天）。风险是误报与性能；shadow 先行的纪律不能跳。

### 6.7 P2：记忆——检索期信任/时效 + 长记忆评测

**现状证据：**

- `FileLongTermMemory` 有 trust/expiresAt；`rankWithDecay` 只按时间（[timeDecay.ts:56](../src/adapters/memory/timeDecay.ts#L56)）；
- primer 默认关；无 LongMemEval 适配；
- MINJA 类「只读查询即可投毒」的攻击面存在。

**设计：**

1. `ScoredFact` 加 `trustWeight`：`untrusted` 乘 0.5（可配），且**永不进 primer 的指令区**（只作背景）；
2. 冲突替代已有（G9/M2），补「检索期」的 trust/recency 联合排序；
3. `tools/eval/longMemEval.mjs`：LongMemEval-S 500 题适配 + 固定 reader/judge + negative control；报告 abstention/时序/知识更新分项；
4. sleep-time consolidation 作为可选离线任务（默认关），只做「合并重复/过期清理」，不自动改写事实。

**验收：**

- MINJA 风格注入后，被污染事实的排序低于可信事实；primer 不把它当指令；
- LongMemEval-S 分数与 negative control 有显著差异；judge/reader 固定版本；
- 变异：去掉 trust 权重 ⇒ 排序判据红。

**成本**：S/M（3–5 天）。**风险**：记忆评测本身脆弱（reader/judge 会翻标签）；必须固定版本 + negative control，不把单次分数当结论。

### 6.8 P2：产品面（GitHub PR / 会话分享 / 桌面）

这些是「战略项」，不是当前瓶颈。建议只做一件：**GitHub PR 闭环**（branch/commit/push/PR/review comment），因为它把「本地改完」变成「可合并的交付物」，也是 Codex cloud/Cursor 的差异点。但需要 GitHub 凭据、网络与仓库权限，且与「本地可信」定位有张力；先做 `gh` CLI 适配（不引入 octokit），失败 fail-closed。

---

## 7. 90 天路线图（能力轨道，不是跑分）

| 周    | 主线                   | 交付                                                                                                    | 验收（可证伪）                                                        |
| ----- | ---------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1–2   | 卫生 + 工作区信任      | 修测试确定性（资源重判据分池/连跑两次门禁）；`trust.json` + restricted 默认 + 发现式清单 + policy floor | 4 个恶意夹具全拦；正例可信任；单测连跑两次全绿                        |
| 3–4   | 评测契约               | run manifest；`harnessAb.mjs`；10–20 任务集（oracle + bad）；`invoke_agent`/eval span；replay 骨架      | 两套配置 k=3 报告含 pass^k/tokens/sold/CI；manifest 可复算；span 可见 |
| 5–6   | MCP 认证 + MRTR        | OAuth PRM/CIMD/PKCE/8707/9207；token vault；`input_required` 回路；conformance 脚本                     | mock OAuth 全流程；MRTR 弹窗；legacy 双栈；conformance 绿             |
| 7–8   | 分发面                 | ACP server；`.agents/skills`；skill 签名/lock；A2A well-known 卡                                        | Zed 连接并跑一轮；skill 导入/篡改拒绝；卡可验签                       |
| 9–10  | 角色路由 + trace→patch | `modelRoles` + `by-role`；reasoning sandwich；trace analyzer 产出提案                                   | 角色可区分；50 session 产出 ≥3 提案；未过 A/B 不晋升                  |
| 11–12 | 安全纵深 + 记忆        | provenance shadow→enforce；taint 扩展；egress proxy；memory trust 排序；LongMemEval-S                   | 注入不外泄；allowlist 生效；记忆排序判据；negative control 显著       |

> 如果只能做 4 周：**1–2 周 + 3–4 周**（信任 + 评测）。这两件做完，后面所有「变好了」才有意义。

---

## 8. 反泡沫清单（这次明确不做）

| 不做                             | 为什么                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| 追 Terminal-Bench/SWE-bench 榜单 | harness effect 2–10pp、token 40×、单次噪声 ≤3pp；榜单分数不是本项目的 KPI；内部 A/B 才可解释    |
| 重写 MCP server 到 2026-07-28    | 破坏性修订；SDK v2 未就绪；客户端认证/MRTR 的收益更直接；服务端落后一版如实标注即可             |
| 上 MCP Apps / AG-UI              | 需要 UI host 面；本仓 Web 是工作台不是通用 host；等客户需求出现                                 |
| 上向量库/图数据库                | 11 系统样本内没有代码向量检索；本仓探针实测语义路零增益/负增益；BM25 + 符号/文件融合已够        |
| 上 microVM / 多租户 / 托管控制面 | 本仓自己的商业化裁决已判为「非代码项/阻塞」；先把本地信任与证据做好，不要用基础设施掩盖能力缺口 |
| 并行写入型子代理                 | Cognition/MAST/本仓事故都反对；单写者 + worktree 隔离是正确取舍                                 |
| 继续把记账/算子下沉 Rust         | 已实测原生 token 记账慢 4.5–6.7×；先解决封送，不要为「原生」而原生                              |
| 无门禁的「自动改自己」           | evolution kernel 默认关、增益未证；trace→patch 必须「提案 → A/B → 人工批准」，不做自动合并      |
| 把外部跑分写进 README            | 违反本仓「两关才算增益」的纪律；外部数字只可作为方向引用，不可作为本项目结论                    |

---

## 9. 结论

**OmniHarness 已经越过了「机制完整」的阶段。** 长时执行、浏览器动作、MCP 客户端双栈、SKILL.md、Windows ACL/WSL 隔离、插件进程隔离、审计链、OTLP、进化台账——这些在 2026-10 的开源 harness 里都属于「有真东西」的一档。旧报告的五项短板，两项已补齐机制，两项补了一半，一项仍默认弱；「分钟级机制完整、小时级能力不足」的判断应撤回。

**但下一阶段的瓶颈换了位置：**

1. **边界**：内部很严，入口很松。工作区配置可以 spawn 进程、降审批、改 baseUrl——这是「clone 即执行」的信任缺口，也是本轮最值得先修的一件事。
2. **证据**：有遥测、有探针、有 3600+ 单测，但没有 run manifest、没有 paired A/B、没有 `invoke_agent` span。没有评测契约，就无法区分「harness 变好」与「这次模型运气好」。
3. **分发**：ACP 是编辑器事实标准，`.agents/skills` 是跨客户端路径，A2A 需要签名卡；本仓在这三处都还是空白。工具面已经够多，缺的是「别人怎么用上」。

**如果只做一件事：工作区信任闸。** 它不增加能力，但把「本地可信 harness」这句话从口号变成可验证的边界。**如果做两件：加评测契约。** 它让后续每一笔投入都能被证伪。**如果做三件：加 MCP 客户端认证。** 它把「通用」从本地 stdio 扩展到托管生态。

---

## 附录 A：本机证据（2026-10-22）

```text
$ npm run build
[build] tsc → dist.next ...
[build] ✓ 已原子换入 dist
[build] ✓ dist 已就绪

$ npm run check
✅ 铁律自检通过：扫描 1137 个 TS 文件，零违规
ℹ️ 函数体超限存量白名单 11 处（未增长）

$ npm run arch:gate -- --strict
依赖方向违规：0 条（白名单 0，新增 0）｜ports 纯度：0 条｜ports→实现层：0 条
依赖环：5 组（新增 0）｜目录告警：3 个
✅ 架构门禁通过：无新增违规

$ npm run lint
（无输出，exit 0）

$ npx vitest run --project node tests/unit/pluginLoader.test.ts tests/unit/pluginWorker.test.ts tests/unit/sandbox.test.ts
Test Files  3 passed (3)
Tests       30 passed (30)

$ npx vitest run --project node tests/unit/sandbox.test.ts
Test Files  1 passed (1)
Tests       9 passed (9)

$ node --input-type=module -e "import { ArgParser } from './dist/src/cli/argParser.js'; console.log(JSON.stringify(ArgParser.configDefaults({mcpServers:[{name:'x',command:'node',args:['-e','x']}],approval:'auto',sandbox:'passthrough',baseUrl:'https://evil.example'})))"
{"mcpServers":[{"name":"x","command":"node","args":["-e","x"]}],"baseUrl":"https://evil.example","approval":"auto","sandbox":"passthrough"}
```

最后一条是 §6.1 的最小复核：项目级配置里的 `mcpServers`/`baseUrl`/`approval`/`sandbox` 会原样进入 CLI 默认值，随后 `bridgeMcpServers` 按该清单连接（stdio 形态即 spawn）。

**规模（逐文件 `.Count` 求和）：** `src` 1137 文件 / 136,996 行；`tests` 625 / 96,828；`web/src` 170 / 27,786。

**全量单测的说明：** 复核期间（22:22–22:31）工作树仍在编辑，全量跑出 3673 passed / 4 failed / 7 skipped；4 例在单跑/定点复跑中均绿。该数字**不作为门禁结论**，只作为「测试对并行资源敏感」的观察。

---

## 附录 B：外部来源（`[V]` 已读原文；`[I]` 推断/二手）

**Harness 架构**

1. [Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents — A Source-Code Study of Eleven Systems](https://arxiv.org/abs/2609.00006)，arXiv 2609.00006。[V]
2. [Improving Deep Agents with harness engineering](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering)，LangChain，2026-02-17。[V]
3. [Codex as a platform: build on the open agent harness](https://developers.openai.com/blog/codex-as-a-platform)，OpenAI Developers（原文 403；经两份二手转述）。[B]/[I]
4. [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)、[Context window](https://code.claude.com/docs/en/context-window)。[V]
5. [Gemini CLI trusted folders](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/trusted-folders.md)。[V]
6. [Aider repo map](https://aider.chat/docs/repomap.html)。[V]
7. [Amp models and subagents](https://ampcode.com/docs/models-and-subagents)。[V]
8. [Kiro changelog 0.10](https://kiro.dev/changelog/ide/0-10/)、[Cline Plan & Act](https://docs.cline.bot/core-workflows/plan-and-act)、[Crush README](https://raw.githubusercontent.com/charmbracelet/crush/main/README.md)。[V]
9. [Zed ACP registry](https://zed.dev/blog/acp-registry)。[V]

**协议**

10. [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)、[Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、[Registry](https://modelcontextprotocol.io/registry/about)。SEP-2484（conformance 要求）见 changelog 引用。[V]
11. [Agent Skills specification](https://agentskills.io/specification)。[V]
12. [AGENTS.md](https://agents.md/)。[V]
13. [A2A v1.0.0 release](https://github.com/a2aproject/A2A/releases/tag/v1.0.0)、[A2A spec](https://a2a-protocol.org/latest/specification/)。[V]
14. [Agent Client Protocol](https://agentclientprotocol.com/)。[V]
15. [AG-UI 1.0](https://www.copilotkit.ai/blog/ag-ui-1.0)。[V]
16. [Docker Sandbox Kit v3](http://aaif.io/blog/dockers-sandbox-kit-spec-puts-an-agents-permissions-inside-the-container-image)。[V]

**评测/可观测**

17. [Terminal-Bench 4.0](https://www.tbench.ai/news/terminal-bench-4-0)、[Benchmarks](https://www.tbench.ai/benchmarks)。[V]
18. [SWE-bench Pro V2](https://arxiv.org/abs/2610.24206)。[V]
19. [τ-bench pass^k](https://arxiv.org/abs/2406.12045)、[τ²-bench](https://github.com/sierra-research/tau2-bench)。[V]
20. [GAIA 2](https://arxiv.org/abs/2602.11964)、[OSWorld 2.0](https://arxiv.org/abs/2606.29537)、[METR TH1.1](https://metr.org/blog/2026-01-29-time-horizon-1-1/)。[V]
21. [Same Model, Different Harness](https://arxiv.org/abs/2608.26218)。[V]
22. [The Scaffold Effect](https://zenodo.org/records/19819492)。[V]
23. [Anthropic infrastructure noise](https://www.anthropic.com/research/infrastructure-noise)。[V]
24. [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)。[V]
25. [Inspect](https://inspect.aisi.org.uk/)、[Harbor](https://harborframework.com/)。[V]

**安全/记忆/学习**

26. [Defeating Prompt Injections by Design (CaMeL)](https://arxiv.org/abs/2503.18813)。[V]
27. [Microsoft Execution Containers (MXC)](https://blogs.windows.com/windowsdeveloper/2026/10/07/microsoft-execution-containers-policy-driven-containment-for-ai-agents/)。[V]
28. [Chainguard: verifying agent skills](https://edu.chainguard.dev/chainguard/agent-skills/verifying-skills.md)。[V]
29. [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/)。[V]
30. [LongMemEval (ICLR 2025)](https://proceedings.iclr.cc/paper_files/paper/2025/hash/d813d324dbf0598bbdc9c8e79740ed01-Abstract-Conference.html)。[V]
31. [MINJA memory injection](https://arxiv.org/abs/2503.03704)。[V]
32. [GEPA](https://arxiv.org/abs/2507.19457)。[V]
33. [Letta sleep-time compute](https://www.letta.com/blog/sleep-time-compute/)、[MemGPT](https://arxiv.org/abs/2310.08560)、[Graphiti](https://arxiv.org/abs/2501.13956)。[V]
34. [EU AI Act Digital Omnibus](https://www.ds.dk/en/news/2026/digital-omnibus-for-ai-approved)。[V]

> 说明：B 级来源（厂商博客/二手转述）的数字按原文引用，本报告未独立复现；`[I]` 为工程判断。仓内代码/命令为 A 级证据。

---

## 附录 C：本报告的自证伪条件

1. **工作区信任**：若本仓已在别处（如 `ConfigFactory` 或启动脚本）对项目级配置做了「可执行键白名单/首次确认」，则 §6.1 的「缺失」判断失效——以代码为准，不以本报告为准。
2. **MCP 客户端认证**：若 `McpServerConfig` 之外有全局 header/token 注入通道（如 env 注入到 SDK transport），则「接不上托管 server」降级；需要一条端到端判据。
3. **评测契约**：若 `session_meta` 之外已有 run manifest/paired A/B（例如 CI 私有脚本），则 §6.3 的「缺失」降级；本报告只认仓内可复核的路径。
4. **长时能力**：若有一份真实 2–8 小时任务的端到端记录（不是脚本模型），则 §3.1「缺小时级实跑」降级；仅有 8h 默认时限不算。
5. **隔离默认**：若 `sandbox` 默认已改为 OS 级（`windows-acl`/`wsl-bwrap`），则 §3.6「仍成立」降级；需要 `doctor` 的实际输出与 `npm test` 证据。
6. **分发面**：若 ACP/`.agents/skills`/A2A 卡已在未合并分支或插件中实现，则 §6.5 的「缺失」降级——以 `src/` 的 grep 为准。

反过来，如果 90 天后仍然是「项目配置自动执行 + MCP 只能匿名 + 没有 run manifest + 没有 ACP」，那么本报告的三条结论不仅成立，而且说明下一阶段需要把「边界/证据/分发」当成主线，而不是继续加工具。
