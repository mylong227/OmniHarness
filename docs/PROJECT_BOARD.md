# OmniHarness 项目看板（唯一事实源）

> **本文件是仓内唯一的看板**。旧看板（`TASK_BOARD.md` / `REFACTOR_BOARD_2026-09-12.md` /
> `UPGRADE_BOARD_2026-09-12.md` / `archive/UPGRADE_BOARD_2026-09-05.md`）已于 2026-10-03 删除，
> 内容永久可查于 git 历史（`git show b49d96e^:docs/TASK_BOARD.md` 等）。
>
> **记录纪律（不可妥协）**：写入本板的每一条信息必须「本机可复核」——或附上产生它的命令/测试，
> 或标注复核日期。禁止复制未经验证的宣称；历史看板里的数字在重新实测前一律视为**待复核**。

---

## 1. 项目是什么

> **第六轮进度（P0 逐步落地）**：G3-V1 完成判定 fail-closed ✅ ｜ **G3-V2 `unverified` 一等完成状态 ✅** ｜
> G4-L3 取消原因保真 ✅ ｜ G4-L4 回滚重推压缩游标 ✅ ｜ G2 子代理写入语义闭环 ✅ ｜
> G1a 最小行为回归守卫 ✅（4 例行为不变量 + 变异测试验证有牙齿）｜
> **G1b-a 检索质量回归守卫 ✅**（锚点审计 + `plain`/`rerank` 两镜头 recall@14/MRR 对基线；变异测试验证有牙齿，并诚实登记"对符号池规模不敏感"的盲区）｜
> **G1b-b 前缀复用守卫 ✅**（`PrefixStability` 首次接进请求路径；三条结构不变量；变异"动态段挪回头部"⇒ 三例全红）｜
> **G5 安全边界显式化 ✅（P0 收口）**：记忆信任档收紧（新增 `memory` 档、阈值 1）＋ 网络守卫自述"只覆盖 fetch"＋ 能力表去掉 OS 级隔离暗示 ＋ `doctor` 增「隔离强度 L2／shell 出网被拦=否」如实输出 ＋ `compliance.md` 降级为 ⚠️。｜
>
> **第七轮（P1 启动）｜G8 ✅**：原生 token 记账**默认翻回 TS**（实测原生慢 4.5–6.7×）＋ **语料构建让出事件循环**
> （同步 1677 ms ⇒ 分块中位 **95 ms**，≈17×）。判据：`nativeTokenAndYield.test.ts` 5 例（含**仪器自证**——
> 报告点名的 `monitorEventLoopDelay()` 在本机对 200 ms 忙等读 0 样本，改用可验证的心跳探针）。遗留 **G8-c**：目录遍历仍同步 54 ms。
>
> **第八轮（P1）｜G7 ✅**：事件落盘新增**追加通道**（`StoragePort.append`，fail-closed 前缀校验；jsonl 真追加、
> sqlite 不 DELETE、`EventPersister` 优先追加/失败回退/**回卷必全量**）。判据 7 例：两路 `load()` 逐条深相等、
> 写入量＝新增条数（40 vs 100）；变异关掉追加 ⇒ ④⑤ 变红。
>
> **第九轮（P1）｜G11 ✅**：Web 类型层换官方 `@types/react`（删掉 ≈5.5 KB 手写垫片，只留转引文件）
> ——顺带挖出并修好 **`reasoningOptions` 被静默丢弃**的真缺陷；并**订正报告 R6/W4 的"120 KB 死负载"误判**：
> highlight.js 在 markdown 路径上是**活依赖**，改为加契约测试防误删（变异删脚本 ⇒ 变红）。
>
> **第十轮（P1）｜G24 ✅**：OTLP span 的"静默丢弃"变成可断言数字（`stats()` 快照 + 关闭
> "HTTP 非 2xx 当成成功"这条静默路径），并加离线对账脚本 `scripts/observabilityReconcile.mjs`；
> 变异"不计数" ⇒ 判据变红。
>
> **第十一轮（P1）｜G23 ✅**：OTLP 属性与 **GenAI semconv 对齐（加字段、不改名）**——新增 `genAiSemconv.ts`
> （版本锚 + 标准键 + 过渡键唯一事实来源），工具/模型 span 并行发 `gen_ai.*` 且过渡键一个不少，数值属性改走
> `intValue`；一致性判据钉住**字面键名**（首版断言常量导致变异抓不到，已修正）。
>
> **第十二轮（P1）｜G25 ✅**：**拆掉架构环⑥**（20 成员 → 消失）。真实成因不是"接口没抽到 ports"——
> 那三个接口早已在 `src/ports/**`，而是**类型已在 ports、调用点却绕道实现文件导入**；34 处导入改直连后
> 环内边 51→32、`CYCLE_WL_MEMBERS` **41→25**，剩 4 成员配置子环如实登记为 G25-b。
>
> **第十三轮（P1）｜G26 ✅**：容器引入**泛型服务令牌** `ServiceKey<T>`（端口只给结构契约，类在 core）——
> 注册类型不符**编译失败**、取用**零断言**推导类型；`ServiceKeys` 六键升级为令牌且**键名与历史逐字一致**
>
> **第十四轮（P1）｜G9/M3 ✅**：**记忆投毒闸**——`MemoryExtractor` 默认不再把 `tool_result` 输出并入蒸馏
> （省略显式标注；只有工具输出的回合根本不抽调取器），显式 opt-in 时事实标 `trust:'untrusted'`；回灌文案从
>
> **第十五轮（P1）｜G10 ✅**：MCP **SDK 1.30→1.32**（协议版本断言不破），并修**两处静默丢块**——非文本块
> （图/音/资源链接）改为保真转述（含 MIME/体积/URI + `raw`）、`structuredContent` 原样透出并经网关渲染进工具结果；
>
> **第十六轮（P1）｜G27 ✅（P1 收口）**：**门禁分层**——`runGates.mjs` 每条门禁声明 `tier` 并支持
> `--tier=fast|typed|all`（pre-commit 仍只跑快层）；新增 `eslint.typed.config.mjs`（`parserOptions.project`）启用三条
>
> **第十七轮（P3）｜G19 ✅**：**检索栈收敛（减法第一项）**——LSA 潜语义路**整体删除**（326 行引擎 + 单测 +
> `lsa` 选项/`lsaModel` 字段/`EMPTY_LSA`/`SeedFusion` 第三路），G1 基线护航对照：**plain 56.3%→56.3% 逐位不变**，
>
> **第十八轮（P3）｜G20 ✅**：**文档瘦身**——`docs/` 根 **33 → 13 份**（只留 SSOT + 现行纪律 + 用户文档），
> 55 份历史材料移入 `docs/archive/` 并**逐份加归档横幅**（"其中的数字与结论不再代表现状"）；重写文档索引与
>
> **第十九轮（P3）｜G21 ✅**：**探针入库**——`tools/probes/` 三探针（检索命中率+CI / 精排判别器受控对照 / **新写**工具暴露预算），
> 并写明复现配方与实测参考值；判据 6 例含**实跑自证**（真跑一次并断言结构，"文件存在"不算数）与**可移植性**
>
> **第二十轮（P3）｜G22 ✅（路线图收官）**：**口径与门禁同步**——`CODE_STANDARD.md` §11 收录计数/评测/门禁
> 三类共 16 条（每条带证据与"在哪被强制"），看板 §9.1 指向它；判据 7 例**交叉核对文档与门禁常量**（改阈值不同步文档即红）。
>
> **第二十一轮（P1 余项）｜G9/M2 ✅**：**记忆写入质量**——把"归一化精确匹配"升级为**骨架+值位三态**：近似改写**不新增**、
> 值位冲突（`policy`→`restricted`、`pnpm`→`npm`）⇒ 新事实入库且**旧事实置 `expiresAt` 失效但不删除**、其余**两条都留**
>
> **第二十二轮（P1 收口）｜G9/M1 ✅**：**记忆 primer 机制判据**（`tools/probes/memoryLiftProbe.mjs`）——三档对照
> （primer 关/开/**随机注入**）+ 两关统计 + **判死能力自证**（随机对照须显著更差，否则退出码 3）；实测 primer 关 0%/0%、
>
> **第二十三轮（补登记项）｜G21-b ✅**：工具暴露探针接入**真实 schema**（`ConfigFactory.build()` 离线生产装配）——
> off 全下发 **5,250 token**（33 个默认注册工具）、plan 命中类别时 **953–1,677 token**（省 **68.1%–81.8%**）、
>
> **第二十四轮（补登记项）｜G20-b ✅**：`docs/ARCHITECTURE_SPEC.md` **按现状重写**（旧版自述"311 TS 文件/31500 行"已归档）——
> 规模数字带**日期 + 口径**；**结构声明逐条与代码交叉核对**（运行时依赖 / 端口 28 目录 / ADR 列表 / 门禁 6 条规则标签 / 两层归属），
>
> **第二十五轮（补登记项）｜G10-T2 ✅**：工具暴露规划器加 **BM25 检索优先**（新增可选 `toolTexts` 语料，检索**只增不减**地并入类别结果）
>
> **第二十六轮（补登记项）｜G1b-c ✅**：回滚端到端判据 `rewindCompactionCursor.test.ts`——**端到端对照**（真运行时 +
> 模型驱动 `checkpoint`/`rollback`：控制组证明折叠摘要确实进过请求体，实验组证明回滚后不再有它）+ 单元级回归守卫；
>
> **第二十七轮（补登记项）｜G8-c ✅**：目录遍历也切成**可让出档**——新增公开 `ContextEngine.walkAsync`（与 `walk` 同产物、
> 共用 `buildWalkState` 闸门），`indexCorpusAsync` 接入；让出粒度按**跨目录累计**目录项（首版按目录计数 ⇒ 小目录树几乎不让出，实测抓出）。
>
> **第二十八轮（补登记项）｜G25-b ✅**：**配置子环拆解**——`SubagentPortSeed`（内引 `MediaStack`）从 `configFactory.ts` 搬进 ports
> （`ports/config/subagentPortSeed.ts` + `ports/media/mediaStack.ts`），原位置只再导出（公开 API 面不变）⇒ `configBuilder`/`configToolRegistry`
> 不再反向 import。**环组 6 → 5**，架构门禁白名单**收紧 25 → 21**。判据 `configCycleDisbanded.test.ts`（4 例，含"回边不得复活"与
> 门禁实测）；**变异**把回边加回去 ⇒ 判据红 **且**门禁报"新增 1 环、中止"。
>
> **第二十九轮（补登记项）｜G1b-c2 + §8.0 ✅**：**回卷对齐接线判据**（`rewindRealignmentE2E.test.ts`）——走**真实回卷通路**
> （`LiveSessionRewindRegistry.rewind`，即 `CheckpointManager.rollback`/在跑会话回卷共用的入口）：对照 run 标定真折叠写回的
> 游标事件下标，回卷 run **只截掉游标事件本身**（投影逐字节不变——这正是 G1b-c 的请求体判据看不见差异的原因；差异只在
> 构建器的**内存游标**上），断言回卷后必须**重新折叠**（`_v2`、摘要调用 +1）且新游标**重新落日志**（崩溃恢复面）。
> **变异**删掉 `agent.ts` 的 `runnerOf()?.rewindCompactionState()` ⇒ 判据红（陈旧游标指纹仍匹配 ⇒ 走快路径复用 `_v1`：
> 无新摘要调用、末次请求仍是 `_v1`、日志再无游标事件），而同一变异下 G1b-c 既有 15 项**照绿**（实证其"不区分"）。
> **机制结论（如实）**：该修复**不是正确性护栏**——压缩器指纹自动失效保证陈旧游标永不泄漏错误内容；它的可观测价值是
> **状态-日志不变量**（回卷后请求成为截断日志的纯函数 + 崩溃恢复游标重建），判据钉的是这条接线契约。
> **§8.0 时间敏感判据同轮修复**：`MemoryExtractor` 注入可选 `now` 时钟（缺省墙钟，逐字节不变），`memoryWriteQuality` ②
> 改受控时钟判据——`supersede` 的 `expiresAt` 与"现在"**零余量**，判据在替代前采样墙钟时毫秒跨界即偶发假红；
> 现在失效边界钉在受控时刻，判据恢复确定性（`api:check` 绿，仅向 `@beta` 选项接口追加可选成员）。
>
> **第三十轮（收尾盘点）｜G25 收尾 + G2 收尾 + 账面销账 ✅**：把盘点出的全部尾巴收掉。
> ① **G25-b 剩余配置契约成员进 ports**（§4 最后一行 ⏳ 销账）——`CorePorts` 声明搬入 `ports/config/corePorts.ts`
> （原位置桶再导出），四个实现类成员改挂端口契约（`ToolResultSpillerPort` / `ToolDiscoveryPort` / `ToolHookRunnerPort` /
> `TurnDiffTrackerPort`）；顺带抽 `RepoMapContextEnginePort` + 把 `RepoMapContextOptions` 搬入 ports。**ports→实现层边归零**
> （原先 `ports/config/resolvedConfig.ts` 等长期 `import type` 绑定 context/search 实现类而门禁 [3.5] 看不见——
> `context/`、`search/` 是漏网层），[3.5] 规则随之**补上两层**「新增即红」。
> ② **G2 遗留"工作流精确并发"收口**——`WorkflowStep` 新增可选 `writes` **写集声明**；`WorkflowLayerPolicy` 升级为
> **声明式精确并发**：全层皆写者 + 全员知情声明（`tools` 显式约束 + `writes` 已声明）+ 写集两两不相交（目录前缀语义，
> 反斜杠/尾斜杠归一化）⇒ 保持并发；有只读步骤在场（读集未声明 ⇒ 读-写一致性竞争排除不了）或任一写者缺声明 ⇒ 保守串行
> （第六轮原判据作为缺省完整保留）。判据 ⑥–⑪ 六例新增（含"srcX vs src 不算重叠"反例与空写集语义），
> **变异**把声明集判定退化成"写者层一律串行" ⇒ ⑥⑦⑪ 红。
> ③ **账面销账**：看板 §8.3 翻 ✅（G7 早已落地、状态漏翻——与 §8.0 同形态）；升级报告 §8 表 8.2/8.3/8.4 三行、
> 正文缺陷清单 1–4 条、§4/§5 "G1b-c 回滚端到端断言 ⏳" 行全部对齐实际进度。
>
> **第三十一轮｜GEE Kernel v1（Wave A S1–S7）✅ 全片落地**：按 [EVOLUTION_ARCH_UPGRADE_2026-10.md](EVOLUTION_ARCH_UPGRADE_2026-10.md) §4 的依赖图
> `S1 → S2 → {S3,S4,S5,S6} → S7` **七片独立提交**（`a7d0354` S1 信号面 / `af07c98` S2 编排装配 / `e3aa514` S3 台账回滚 / `7c1d6f0` S4 级联评估 /
> `c8ddc17` S5 覆盖率分桶 / `e2c2d88` S6 执行体转正 / S7 CLI+文档+成熟度）。每片过全部门禁（铁律 / 成熟度 / 标准增量 / 架构 / 接线 / 死链 / 密钥 / 顶层函数 / ESLint）
> 并跑**全量单测**（末次 **clean build** 实测 **2665 例，0 失败，4 跳过**）。
>
> ① **S1 信号面**：3 端口（信号源 / 候选档案 / 晋升台账）+ `EvolutionSignalCollector`（production 观测行 → 失败签名 / 成功密度，游标有界确定性）。
> ② **S2 编排**：`EvolutionKernel` 实现**既有** `EvolutionController` 端口（`core/agent.ts` 零改动），`evolutionRlvr.kernel` **默认关**、关时逐行为等价（判据钉死）；
> 配置子键 `kernel` / `ledgerDir` / `archiveMaxPerBucket` 三处透传（端口契约 + `configError` 白名单 + CLI 旗标 + `cliSubsystemSections`），顺带修好「发现源构造时快照」缺陷。
> ③ **S3 台账回滚（差异带本体）**：`HashChainPromotionLedger`（JSONL + seq/prev/hash，复用 `util/hashChain`，分隔符 `|` 与审计/遥测链刻意区分）——
> **无快照不晋升**（台账缺失 ⇒ 晋升裁决 fail-closed 改写为未晋升）、`rollback(seq)` 逐条深相等、**篡改检出**（改中间条目 ⇒ `verify()` 红且断链拒绝写入）、重启续链。
> ④ **S4 级联评估**：`CascadeReward` 静态预检（非空 / 围栏配平 / 红线模式）先于 `verifyCommand`——**变异判据：静态不过 ⇒ 内层调用次数 = 0**；
> 静态通过则与 `VerifiableReward` **逐字同判**（只加更早的否决，不加新的通过路径）；静态否决记 `verifiable=false`（不虚增覆盖率）。
> ⑤ **S5 覆盖率分桶**：`BucketedCoverageMeter` 同一样本记全局与工况桶、闸取**最差桶**；阈值**沿用** `COVERAGE_THRESHOLD`；
> **变异判据**：单桶拥挤场景全局口径 0.75 放行、最差桶 0 阻断（「去掉分桶即漏放」）。
> ⑥ **S6 执行体转正**：`DormantExecutorActivation`——失败提案 → `CrisprEditSpec`（**差异测试 = 门禁基准非回退**，与门禁同一把尺 `RlvrController.defaultGateScore`）→ `queue()`/`flush()`；
> 越阈成功组合 `crystallize()` 冻结为原生能力（加法式，源技能逐字不动、密度归零、重复只计已冻结）。两条路径判据 7 例，含「回滚后原技能一字不动」。
> ⑦ **S7 CLI + 文档 + 成熟度**：`omniharness evolution status|cycle|rollback`——`status` **只读**（判据：跑完台账逐字节不变、目录零新增），
> `rollback` / `cycle` **需显式 `--yes`**（缺则退出码 2、零改动）；回滚产物写成 `--skills` 可直接吃回的技能包（CLI 进程没有活着的技能表，这是诚实边界）；
> 新增引擎全部带 `@maturity` + 真实测试证据（**进化域新增 6 项 L1，全仓 50 项**声明，`audit:maturity` 绿）。
>
> **过程中挖出并修掉的两个既有缺陷**（都不是本片引入）：① `CrisprEditSpec.addressThreshold` **被实现忽略**（端口契约声明了、编辑器只读构造参数）——
> 「声明未接线」的又一例，已改为规格优先；② `verifiableVerdictForCode` 的临时代码文件**不带 pid**，而 `node --test` 每文件一个进程共用临时目录 ⇒
> 「验证后无残留」判据会看到别的进程正在写的同前缀文件而**偶发假红**（本轮实测触发一次），已按 pid 收窄。
>
> **另一条仪器教训（关于本板这个数字本身）**：S5 把 `coverageBuckets.test.ts` 改名为 `bucketedCoverageMeter.test.ts`，此后各片用 `npx tsc`
> **增量**编译——`dist/` 里那份旧编译产物**没被清掉**，`dist/tests/unit/*.test.js` 于是把同一批 7 个用例**跑了两遍**，
> 全量计数一路显示 2672。`npm run build`（内含 `cleanDist`）后真相是 **2665**。
> **口径**：跨片累计的**测试计数**必须取自 `npm run build` 后的 clean 产物；改名/删除测试文件后尤其如此。
>
> **诚实边界**：Kernel **默认关**，增益未经两关统计，不得声称"已实现自我进化"；CLI `cycle` 的晋升落在**本进程内存**技能表（会话级），
> 只有台账（快照/晋升/回滚条目）是持久产物——命令输出的 `note` 字段如实写明这一点。
>
> **第三十二轮｜Evolvix-Ω Wave B（资产协议泛化）✅ 全片落地**：按 [ARCHITECTURE_TARGET_2026-10.md](ARCHITECTURE_TARGET_2026-10.md) §7
> 的 Wave B（前置 = Wave A 全绿 + ADR-0009）分 **6 片**独立提交：
> B1 `84bc0c7`（ADR-0009 + `ports/capability` 六契约 + 类型注册表 + SkillSchema）/ B2 `1b487dc`（`CapabilityRegistry` 绞杀者第一态）/
> B3 `bedb277`（注册口与治理 fail-closed 判据）/ B4 `dba408a`（第二类型 WorkflowTemplate + 评估器 + Operator/Evaluator 契约 + 端到端）/
> B5 `530eddf`（`capability` 配置段 + 装配接线）/ B6（CLI `capability list` + 文档）。每片过全部门禁并跑**全量单测**
> （末次 clean build 实测 **2700 例，0 失败，4 跳过**；成熟度声明 **56 项**）。
>
> ① **协议面**：`CapabilitySchema`（类型自描述：校验 + **评估契约** + 默认信任/隔离档 + 台账语义）+
> `CapabilityRecord`（本体 + 溯源 + 适应度 + 治理状态）+ 两个端口（类型注册表 / **`SkillPort` 超集**注册表）。
> ② **绞杀者第一态**：`CapabilityRegistry` **内部持同一份 `SkillRegistry`**，`SkillPort` 全量成员与
> `selectForPrompt`/`rankForPrompt`/`render` 一律委托——**J6 判据**跑「选择→稀疏化→渲染」完整轨迹逐位对照
> （名字 + 分数 + 顺序 + 渲染文本），并带**仪器自证**（故意反转排名的对照实现必须被判红）；**生产注入路径本波不动**（切换属第二态）。
> ③ **fail-closed 三条**：未注册类型即拒 + 结构非法即拒（**失败不留痕**）+ 治理变更必须留台账
> （无台账即拒且状态不变；入链记 `action:'governance'` 并回写 `ledgerSeq`）；档位（信任/隔离）**只可收紧不可放宽**。
> ④ **对类型开放（上限轴 1）**：第二个类型 `workflow-template` 自带度量（依赖满足度），端到端判据串起
> 「算子产出 → 新类型入册 → 评估出 fitness → 台账晋升 → 回滚逐条深相等」；`OperatorPort` 由**既有**燧-1 发现引擎实现（**零休眠代码**）。
> ⑤ **配置与 CLI**：`capability` 段严格校验（未知子键/类型/档位枚举越界一律拒启动——落在安全档位上的静默忽略代价最高）；
> 缺省关 ⇒ 切片 undefined（零行为变更）；`capability list` **结构性只读**（命令类只拿只读回调）。
>
> **过程真问题（门禁自己抓到的）**：B5 首次跑全量单测时，仓库自己的**接线完整性门禁 I5a** 报
> `FileConfig.capability 被配置文件接受但 CLI 层零引用（写入后静默丢弃）`——即「声明未接线」第 N 次同形态。
> 已补 `argParser.configDefaults` + `CliSubsystemSections` 两段透传并加判据（配置文件 → CliArgs → partial 闭环）；
> 另一处是 `ConfigFactory.build` 体量被新切片推过基线（106 > 99），按该文件既有手法抽成 `buildCapabilityStack` 帮手。
>
> **诚实边界**：Wave B 是**协议与治理面**的落地，**不改变任何既有行为**（`capability.enabled` 缺省关）；
> 已注册的类型仍只有 `skill` / `workflow-template` 两个（「类型开放」是能力，不是已有生态）；
> Wave C（隔离阶梯）/E（元进化）与 A.5（依赖准入）**仍未开始**（D 见下一轮）。
>
> **第三十三轮｜Evolvix-Ω Wave D（签名资产包分发）✅ 核心落地**：前置 = Wave B（ADR-0011 已落）。分 **3 片**提交：
> D1 `20853ed`（契约 + `.ohb` 编解码 + Ed25519 非对称签验）/ D2 `bf34d54`（安装流水线）/ D3 `b236b09`（CLI `install|metadata` + 收口）。
> 每片过全部门禁并跑**全量单测**（末次 clean build 实测 **2724 例，0 失败，4 跳过**；成熟度声明 **59 项**）。
>
> ① **为什么不用既有 HMAC**：插件包的 `.ohb` 用 HMAC-SHA256，**验签方必须持有同一把密钥** ⇒「谁能验签」等于「谁能伪造」，
> 且既有 `unpackBundle` 的校验是**条件式**的（只有「带签名**且**给了 keyFile」才校验 ⇒ 带签名的包在没给 keyFile 时被静默接受，fail-open）。
> Wave D 复用**同一容器**（zip）但换成 **Ed25519 非对称**：验签用**清单里发布者的公钥**，第三方可独立验签；
> 签名的规范化正文固定键序（`JSON.stringify` 原对象会因键序不稳定导致验签假失败）。**零新依赖**（`node:crypto` 原生 Ed25519）。
> ② **J9 三类全拒**（本波把 §8 最后一条可落地判据变绿）：无签名 ⇒ `unsigned` 拒；坏签名（换人签 / 替换签名字段）⇒ `bad-signature` 拒；
> **验签后篡改**（改资产正文 / 发布者 / 签发时间 / 包名任一）⇒ 拒。容器误读同样显式报错（缺清单、把插件包当资产包喂进来 ⇒ 点名包内条目，不 sniffing）。
> ③ **安装流水线五步**：解包验签 → **全量预检**（类型已注册 / `validate` 通过 / 无名冲突 / 档位只收紧）→ 入册 → **逐资产入账** `pack-install` → 报告。
> 任一预检不过 ⇒ **整包拒且零入册零账目**；入册期意外异常 ⇒ 补偿撤销本轮已入册者（**账上不留假记录**：顺序刻意是「先入册后入账」）。
> ④ **严格档默认开**：无签名包默认拒装；`--allow-unsigned` 是显式降档（本地开发），装入资产记 `external` 档并在报告里如实标 `unsigned`；
> 无台账 ⇒ **拒装**（无账不生效）。CLI `install` 需 `--yes`；`list` / `metadata` **结构性只读**（只拿只读回调，没有写入口）；`metadata` 只出公开字段。
>
> **过程真问题（判据当场抓到的两个）**：① **字符串当错误通道**——档位本身就是字符串，`typeof x === 'string'` 判不出错误，
> 于是合法档位 `'external'` 被当成拒绝原因（安装报告直接吐 `rejectedReason: "external"`）；已改为判别式结果并把这条陷阱写进注释。
> ② **测试夹具里各起一套注册表**——安装器写 A 套、只读面读 B 套，装完的资产「看不见」（判据变红）；
> 已改成与生产同构：安装器用**切片里那份**注册表（`ExecCli` 也是这么接的，台账则在同一组合点按 Kernel 路径同口径装配）。
>
> **诚实边界**：只做了**签名与安装**——远程注册表客户端与「元数据被 MCP 客户端 loopback 消费」（§7 Wave D 判据里那条）**未做**；
> `metadataFor` 只落导出、不落发布；签名覆盖清单正文，**独立载荷文件尚未纳入摘要**（v1 资产是清单内联 JSON 故等价，ADR-0011 已登记该边界）；
> Wave C（隔离阶梯，含 J8）/E（元进化）与 A.5（依赖准入）仍未开始。
>
> **第三十四轮｜Evolvix-Ω Wave C（信任-隔离阶梯）✅ 零新依赖部分落地**：ADR-0010 + 2 片提交
> （C1 `e5cefe7` 契约与阶梯 / C2 装包流水线接入）。每片过全部门禁并跑**全量单测**
> （末次 clean build 实测 **2733 例，0 失败，4 跳过**；成熟度声明 **60 项**）。
>
> ① **档位从「记录里的字段」变成「执行时的门」**：`IsolationPort` 按**载荷分派**（宿主闭包 / JS 源码 / wasm 字节）——
> 为什么不能只收闭包：宿主闭包**无法跨 realm**，塞进 `node:vm` 只会得到**假隔离**；故闭包型只允许 `in-process`，
> 在更严档位请求闭包 ⇒ `payload-unsupported`（拒，不假装隔离）。这是本波最容易被糊弄过去的地方，故用判据钉死。
> ② **四条 fail-closed**：档位不可达 ⇒ `level-unavailable` 拒（`wasm` 档如实申报「wasmtime 未按 D10 准入」，**绝不静默降档**）；
> 请求比资产声明更松 ⇒ `downgrade-not-allowed`（放宽需显式 `allowDowngrade`）；vm 内触达宿主能力 ⇒ `escape`；
> 载荷抛错/超时 ⇒ `trap` / `timeout`（**异常绝不从 `run` 逃逸**——否则装包冒烟会在多资产循环里半途中止）。
> ③ **`vm` 档的真本事**：受限上下文 + **V8 vm timeout 真打断同步死循环**（判据实测 `while(true){}` 被中止）；
> 并发现一个必须拒的形态——**载荷未自求值（返回函数）**：它说明代码压根没被执行，而且跨 realm 调用**不受 vm timeout 保护**
> （同步死循环会直接挂住宿主）。已判据化。
> ④ **接入 §4 F3 的第四步**（Wave D 里如实登记过的缺口）：装包时做「**档位可达性门禁 + 冒烟**」——
> 声明不可达档位的包整包拒（不降档）；`in-process` 档真跑一次该类型的度量（把「装完才发现评估就炸」提前到安装时）；
> 更严档位默认**不冒烟**（闭包跨 realm 无意义、数据型资产也没有自带代码），组合根可用 `smokePayloadFor`
> 提供档位原生载荷（判据：注入后 vm 档内 `require` 冒烟 ⇒ `escape` 拒装）。CLI `capability install` 已接该门禁。
>
> **诚实边界（这一波尤其要说清）**：`wasm` 档**只有「拒执行」这一种行为**——**J8（wasm 越界 / fuel）无法判**，
> 因为没有 wasm 运行时（`wasmtime` 是独立的 D10 准入事项：Rust crate + 原生构建 + 体积 / 工具链评估），本波**不做**也不假装；
> `os-sandbox` 档只有在组合根注入原生执行器时才可达；`node:vm` 是 **best-effort**、**不是**安全边界
> （沿 ADR-0006 与 `plugin/sandbox.ts` 的既有表述，跨过首个 `await` 后的同步死循环仍无法就地中止）。
>
> **第三十五轮｜A.5 依赖准入第一项：`croner` 正式准入 + 暴露并修掉一处真实缺陷 ✅**：
> 按 D10 六门走完流程（`reason`/`capability`/`license`/`approvedAt`/`layer`/`exitPlan` 齐备，登记于
> `dependency-allowlist.json`）：**croner 10.0.1 · MIT · 零传递依赖 · 实测 install 151 KB**（默认预算 2048 KB / 20 依赖）。
>
> ① **准入理由（「必要且更优」，不是"大家都用"）**：新增 `CronSchedulePort`（`ports/daemon/cronSchedule.ts`）
>
> - `CronerSchedule`（`adapters/schedule/`）。自研等价物要自带 IANA 时区库 + DST 跳变/重叠规则；
>   实测 croner 在 `America/New_York` 的 `30 2 * * *` 上把**不存在的那次**（春季跳变）正确顺延到 03:30 EDT。
>   ② **过程发现一处真实缺陷（比新功能更值钱）**：既有 `RoutineScheduler.matchesCron` 用的是**宿主本地时区**
>   的 `getHours/getDate/getDay`（**不是 UTC**——其文件头曾误写为「UTC 字段匹配」，本轮已改正），于是
>   **同一份 `routines.json` 在不同时区的机器上触发时刻不同**（本机宿主为 Asia/Shanghai）。
>   判据用「本地构造的 09:00 必命中 / UTC 09:00 是否命中完全取决于宿主偏移」把这条钉死。
>   ③ **接口形态是刻意选的**：`timezone` 缺省**恒为 `UTC`**，绝不跟随宿主本地——croner 自身默认宿主本地，
>   照抄会把环境依赖带进来（这正是 ② 的病根）。要本地时间必须显式传时区。
>   ④ **失败语义三类分明**（判据钉死）：表达式非法 / 时区名非法 / 起始时刻非有限数 ⇒ `ok:false` + 可读原因；
>   **合法但永不匹配**（`0 0 30 2 *`）⇒ `atMs:null`——不是错误。把后者当异常会让调度器在合法配置上崩掉，
>   当成功又会让调用方误判「有下次」。⑤ 编译结果**有界缓存**（上限 128，超出按插入序淘汰）。
>   ⑥ **接线是真的**（§11.3「声明即接线」）：CLI `routines` 路径已注入 `CronerSchedule`；判据从**对外行为**证明
>   接线发生——同一瞬时在 `Asia/Shanghai` 与 `UTC` 下判定**必须不同**；不注入时仍走自研路径，行为逐位不变。
>
> **⚠️ 行为变更（显式登记，不静默）**：CLI 的 routines 现按 **UTC** 判定 cron 到期（此前是宿主本地）。
> 非 UTC 宿主上，`0 9 * * *` 从「本地 09:00」变为「09:00 UTC」。**为什么接受这个变更**：环境相关的触发时刻
> 本身是缺陷，且无法用配置表达意图；改为确定性 UTC 后才谈得上可复现与可迁移。
> **尚未做（不假装）**：CLI 还没有 `--timezone` 旋钮（想按本地时间跑的用户暂时只能用自研路径或等下一片），
> 该旋钮需要走 argParser → 配置 → 装配 → 消费的完整接线，属独立一片。
> **A.5 其余两项未开始**：`openid-client`+`jose` 与 OTel（下一轮补记；当时对其缺口的表述已在下一条更正）。
>
> **第三十六轮｜A.5 依赖准入第二项：`jose` 正式准入（id_token 校验迁移）+ 更正上一轮的一处不准确表述 ✅**：
> **jose 6.2.12 · MIT · 零传递依赖 · 实测 206 KB**（预算 512 KB / 0 传递依赖），登记于 `dependency-allowlist.json`。
>
> ① **先更正上一轮的表述（诚实优先）**：上一轮写「`oidcClient.ts` 存在**解码 JWT 不校验签名**的路径」——**不准确**。
> 实测 `EnterpriseAuth.authenticate` **确实**验签（kid 匹配 + `kty` 校验 + `crypto.verify`），
> 只有 `decodeJwt` / `verifyIdTokenClaims` 这两个**公开**方法标注「不含签名」（接口面容易被误用，但主路径没问题）。
> 真实缺口是**窄与手写**，不是「不验签」：只支持 `RS256`、无时钟偏移容忍、`aud` 为多值时未校验 `azp`。
> ② **准入依据（D10「必要且更优」的可核验形式）**：新增 `IdTokenVerifierPort` + `JoseIdTokenVerifier`，
> 并把**既有自研实现**适配成同端口的 `LegacyIdTokenVerifier`（回退资产）⇒ 两个实现可**同端口差分对照**。
> 判据把分歧写成数字：`ES256` 合法令牌 jose 通过 / 自研拒绝；多受众缺 `azp` jose 拒绝 / 自研放行；
> 过期 5s + 容忍 30s jose 通过 / 自研拒绝。**一致面**（RS256 合法令牌两者都通过）也一并判死——
> 否则「全拒」也能骗过安全判据。
> ③ **安全判据（必须拒的都在）**：`alg=none`、**`HS256` 用公钥当密钥（算法混淆）**、篡改 payload、篡改签名、
> `iss`/`aud`/`nonce` 不匹配、过期、`nbf` 未到、多受众缺/错 `azp`、超体积令牌（>16 KiB）、
> 非 https 的 JWKS 端点、JWKS 拉取超时。算法面是**白名单**（RS/ES/PS 全族，显式排除 `none` 与 `HS*`）且**可审计**
> （`allowedAlgorithms()`）。
> ④ **过程抓到我自己的一个安全缺口**：第一版把 `nonce` 交给 `jose` 的 `jwtVerify`，而它**不认这个选项**——
> 被静默忽略 ⇒ 「nonce 不匹配的 id_token」会被当成合法令牌接受。判据当场红，已改为**自己实现** `nonce` 校验。
> ⑤ **导线真接**：`EnterpriseAuth` 增可选第四参（同端口实现）；CLI serve 的 `--auth-required` 热路径已注入
> `JoseIdTokenVerifier`。判据从对外行为证明接线：同一 ES256 令牌，不注入 ⇒ `null`，注入 ⇒ 认证成功；
> 且篡改签名/缺头/非 Bearer 在两条路径上都必须 `null`（接线不得放宽负路径）。回退 = 移除一个实参。
>
> **未做（不假装）**：**`openid-client` 未准入**——授权码流 + PKCE + discovery/token 交换仍走自研实现。
> 这一半的缺口更小（协议管道，而非手写密码学），但**尚未**按 A.5 判据「mock IdP 全流程契约测试逐条过」验证；
> `jose` 只接管了「令牌校验」这一层。OTel 导出评估仍未开始。
>
> **第三十七轮｜A.5 第三项：OTel 导出评估 —— 裁决「维持自研（不引入）」✅ + 补上两条此前不存在的判据**：
> 完整记录见 [OTEL_EXPORT_EVALUATION_2026-10.md](OTEL_EXPORT_EVALUATION_2026-10.md)。
>
> ① **评估第一步就发现判据本身不存在**：`ARCHITECTURE_TARGET` §5.3 判据②写「既有 golden 哈希不变
> （过渡键并行策略保留）」，但仓内**没有**这道判据（原测试只断言「POST 发生过 / 失败被丢弃」）——
> 线格式改一位、过渡键删一个**不会有任何判据变红**；判据①「observabilityReconcile 对账一致」断言的是
> **归因恒等式**（吃事件、与导出器无关），换不换 SDK 都不会变，属**必要不充分**。
> 故本轮先造判据、再评估（这也是本次评估最大的产出）：
> **线格式 golden 哈希**（报文体逐字节 `sha256`，跨两次运行实测稳定）+ **过渡键并行**（模型 span 上
> 新旧键**按字面量**并存——用常量枚举断言会「改常量+改实现」恒绿）+ **数值走 `intValue`** +
> **线 ↔ 账目对账**（线上 token 之和 == `TokenAttribution` 账目；缓存读是 prompt 子集**不得相加**）。
> 四条判据当前**全绿** ⇒ 自研导出器在这四面上没有已知缺口。
> ② **判据③（体积）实测超预算 8.9 倍**：临时前缀安装（不动本仓依赖）实测拉入 **10 个包 / 17.8 MB**
> （默认预算 2 MB；`semantic-conventions` 11.7 MB、被牵连的 `sdk-metrics` 1.8 MB、`api-logs`/`sdk-logs`），
> 许可证全 Apache-2.0（传递依赖数 10 ≤ 20 达标）。**体积本身不必然否决**（ONNX 有 override 先例），
> 但政策要求它换来「质变能力」——下一条说明并没有。
> ③ **能力增益不显著**：SDK 的增量是重试/退避、protobuf/gRPC、gzip、sampling/propagators、metrics+logs 导出；
> 而本仓当前只发 trace、失败口径是「丢弃 **+ 自观测计数**」（`spansDropped`/`lastDropReason`，HTTP 非 2xx 也算丢弃）。
> **真正会让线上出事的三个面（线格式漂移、过渡键丢失、token 与账目不一致）已被判据锁死**，与换不换 SDK 无关。
> 按 §5.3「收益不显著则维持自研」⇒ **不引入**；`dependency-allowlist.json` 与 `package.json` **零改动**。
> ④ **复评触发条件写清了**（免得下次从零讨论）：需要 metrics/logs 导出、需要「不丢」的重试队列、
> 需要 OTLP/gRPC 或 gzip、需要跨进程上下文传播（sampling/propagators/baggage）——任一出现即重评，
> 届时本轮四条判据就是**迁移验收基线**。
> ⑤ **诚实边界**：**没有**真的把生产路径切到 SDK 上端到端跑一遍（那要先引依赖，属「买了再测」，与 B 级相反）；
> 故结论口径是「当前资产在这四面上绿」，不是「SDK 在这四面上也绿」。另：写判据时自己踩了两次坑
> （夹具的 `exp` 被 `setExpirationTime` 覆盖 ⇒「已过期」用例什么都没验；拿单个 span 对整份账目 ⇒ 100 !== 110），
> 两次都是**判据没立住**而非实现错，已写进文件注释。
>
> **第三十八轮｜Wave D 尾巴：元数据可被 MCP 客户端消费（loopback）✅ —— D 的四条验收判据只剩一条（评估类）**：
> `ARCHITECTURE_TARGET` §7 的 Wave D 判据里，此前只落了「无验签包严格档被拒（J9）」，本轮补上第二条。
>
> ① **为什么必须过协议而不是调函数**：「导出元数据」有两个出口——CLI（**人**读）与 MCP 工具（**机器**读）。
> 本轮的判据用官方 SDK 的 `Client` 经 `InMemoryTransport` 连到本仓 `SdkMcpServerAdapter`，真跑
> `tools/list` + `tools/call`：这样才排除「函数能调通、但**注册 / 映射 / 序列化**任一环断了」的假绿。
> ② **新增 `capability_metadata` 只读工具**（`adapters/tool/capability/`）：元数据与 CLI `capability metadata`
> **同源同形**（两处各拼一份必然漂移）；未注册类型 ⇒ `isError` + 可读原因（不是空表）；
> 协议未启用 ⇒ **工具根本不在清单里**（比「在清单里但调用报未启用」更诚实：模型看不到就不会去调）。
> 只读分类判据钉住它**不在** `MUTATING_TOOL_NAMES` 内（错收进写类会让 plan 模式下每次读元数据都要审批），
> 并带正对照（`write_file` 确实在写类集合里，防「集合为空 ⇒ 判据恒绿」）。
> ③ **铁律第二次抓到装配体量**：`ConfigFactory.build` 因新增接线越基线（99 → 110）⇒ 按既有惯例抽出
> `buildToolStack`（而不是放宽阈值）。这个抽取顺带修掉一个**真实隐患**：工具集与 `ResolvedConfig`
> 若各调一次 `buildCapabilityStack`，会得到**两个切片实例**——工具读到的注册表与运行时用的那份不是同一个，
> 「装进去的资产在工具眼里看不见」（正是 Wave D 尾巴这类接线的典型暗坑，已写进 helper 注释与判据）。
> ④ **验收判据的当前状态（逐条登记）**：①无验签包严格档被拒 ✅（J9）；②元数据可被 MCP 客户端消费（loopback）✅ **本轮**；
> ③治理台台账可独立 `verify()` ——**台账 verify 已有判据**（改/删/插三类可检出），但**独立「治理台」UI 未做**（如实标注，不冒充）；
> ④**传输栈评估（fastify+ws）未做**（B 级「先测后买」，与 OTel 同类的评估项，属独立一片）。
>
> **第三十九轮｜Wave D ④：传输栈评估 ✅ —— 裁决「`fastify` 拒绝 / `ws` 暂不引入」，但审计修掉自研帧层 4 处协议缺陷**：
> 完整记录见 [TRANSPORT_STACK_EVALUATION_2026-10.md](TRANSPORT_STACK_EVALUATION_2026-10.md)。
>
> ① **实测双超预算**（临时前缀安装，不动本仓依赖）：`fastify` 5.12.5 + `ws` 8.22.0 拉入 **49 个包 / 7.66 MB**
> （默认预算 2 MB / 20 依赖 ⇒ **3.8× / 2.45×**）。**关键观测：49 个包全是 fastify 拉来的——`ws` 自身 148 KB 且零传递依赖。**
> ② **能力增益不成立**：`fastify` 替换的是一层已有命名护栏（`serverExposureGuard` / `serverAuthGuard` / `boundedRead`）
> 与判据的 410 行 `node:http` 实现，收益（路由树 / schema 序列化 / 插件生态）在本仓需求面（两条路径 `/rpc` `/ws`）上不成立；
> 且 fastify **不管 SSE 背压**（本仓那份 `sseBackpressureGuard` 仍得自己留）。⇒ **拒绝**（理由不是"零依赖"，是"必要性不成立 + 成本远超收益"）。
> ③ **审计才是本轮的核心产出**：逐条核对 RFC6455 后确认自研帧层有 **4 处协议一致性缺陷**并**全部修复 + 判据化**：
> **FIN 位被忽略** ⇒ 分片消息被当完整消息**提前交付**、续帧被丢弃（**数据截断**）；**无 ping/pong** ⇒ 第三方客户端判链路已死；
> **不校验 UTF-8** ⇒ 非法序列静默变 U+FFFD（规范要求 1007）；**不校验掩码位** ⇒ 未掩码帧照收（掩码是防中间设备缓存投毒的一环，规范要求 1002）；
> 另补**消息级重组上限**（只限单帧不限消息 ⇒ 无数小分片可撑爆缓冲 ⇒ 1009）。判据用假 socket 注入**原始字节**
> （合法 `WebSocket` 客户端测不出这些边界），7 例，**删掉修复即红**，并含正对照。
> ④ **`ws` 为何仍不引入**：不是它不好，而是**它的收益已被本轮吃掉**（最危险的四个面已自补并判据化），
> 而引入它要**重写本仓的背压与上限语义**（`MAX_FRAME_BYTES`/`MAX_MESSAGE_BYTES`/`MAX_QUEUE_BYTES`/fail-closed 断开），
> 迁移面大于收益。**这正是 B 级「先测后买」的价值：测完发现"该买的那部分我们已经自己补上了"。**
> ⑤ **复评触发条件写清了**：需要 permessage-deflate、需要二进制帧、出现第三方客户端全兼容要求、
> 或需要高吞吐帧处理（当前每帧 `Buffer.concat` 有 O(n²) 风险）——任一出现即重评，届时 `wsFrameConformance.test.ts` 就是**迁移验收基线**。
> ⑥ **判据自己踩了两次坑**（都已写进注释）：Node 流 `'data'` 派发是**异步**的，同步断言看到空数组 ⇒ 第一版 7 例全红；
> 帧夹具只写 7 位长度字段，而 **126/127 是转义标记不是长度** ⇒「超长控制帧」「1 MiB 分片」被编码成非法帧，解析器正确地等后续字节，
> 判据误判为失败。两次都是**判据没立住**而非实现没修好。
>
> **Wave D 判据现状（本轮后）**：①无验签包严格档被拒 ✅（J9）；②元数据可被 MCP 客户端消费（loopback）✅；
> ③治理台台账可独立 `verify()` —— 台账 verify 判据已有，**独立治理台 UI 未做**；④**传输栈评估 ✅ 本轮**。
> 即：**Wave D 的「可判据化」部分已全部落地**，剩余两项都是**产品面**（治理台 UI）与**尚未出现的需求**（换传输栈）。
>
> **第四十轮｜商业化路线图 阶段 0「插电」：E2+ 进化增益自证探针 ✅（含负结论与因果定位）**：
> 按 `EVOLUTION_COMMERCIALIZATION_2026-10.md` §5 阶段 0（E1–E5）与 `EVOLUTION_RD_RESEARCH_2026-10.md` §4.3 的细化
> （E1+/E2+/E3+/E4+/E5 + 新增 N1/N2）逐条核对代码后的**精确完成度**：
>
> | 步骤    | 内容                                              | 状态        | 证据                                                                                                                                                                                                                                    |
> | ------- | ------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **E1+** | 双源信号（失败→提案 / 成功→工作流模板候选）       | 🟡 **部分** | 失败侧蒸馏器在（`failurePatternMiner` 被 `signalIngestor`/`dormantExecutorActivation` 使用，Wave A）；**成功侧蒸馏器不存在**（`workflow-template` 只有 schema 注册、无候选生产者）；双源端到端与「掐断任一半边 ⇒ 候选恒 0」判据**未做** |
> | **E2+** | 进化增益自证探针（含 val/test 纪律闸）            | ✅ **本轮** | `tools/probes/evolutionLiftProbe.mjs`（已登记 README，过探针七条判据）                                                                                                                                                                  |
> | **E3+** | 提案回填（`rlvrLoop` 采样 prompt 加历史失败原因） | ⬜ 未做     | `src/evolution/rlvrLoop.ts` 内**零**失败/原因相关引用                                                                                                                                                                                   |
> | **E4+** | 级联评估（静态短路 + verify 推导按快→慢）         | ✅ 基本具备 | `cascadeReward` + `RlvrController` 的 `cascade: true`（Kernel 路径显式开；J5「静态失败 ⇒ verify 调用 0 次」判据绿）；verify 推导由 `SelfVerifyCommandDetector` 提供                                                                     |
> | **E5**  | 晋升级回滚                                        | ✅          | Wave A 台账 `rollback(seq)` + 快照；J4「回滚后注册表与快照逐条深相等」判据绿                                                                                                                                                            |
> | **N1**  | 覆盖度分桶（MAP-Elites 式）                       | ✅          | Wave A `bucketedCoverageMeter`（`CoverageMeter`/`CoverageReportSurface`）                                                                                                                                                               |
> | **N2**  | 冻结不删除（负结果可复活）                        | ✅          | Wave A `dormantExecutorActivation` + `CandidateArchive` 冻结语义                                                                                                                                                                        |
>
> **E2+ 探针结果（正负都进看板——这是 E2 的纪律）**：预注册配置下 **不显著** ——
> 评估 87 个候选仅 **1** 个过门禁；test 桶配对均值 **+0.016**、CI95 **[0, 0.045]**（**下界触 0 ⇒ 第一关不过**）、折 +11/−0
> ⇒ 按 E2 纪律：**进化保持默认关**，对外材料不得引用未过两关的增益数字。
> **判死能力自证 ✓**：结构性零对照（候选＝父副本）恒为 0、CI [0,0]、折 0/0 ⇒ 判据不会凭空造增益；
> **纪律闸 ✓**：选型只读 val，传入 test 索引即抛错（`exit 4`）。
>
> **因果定位（本轮最有价值的产出）**：敏感性分析显示把晋升阈值从 0.02 一路放宽到 **0**，也只从 0 晋升变 **1** 晋升
> ⇒ **瓶颈不在门禁严格度**；诊断臂把选父搜索从「每桶最优 2 个父」放宽到「前 **4** 个技能两两组合」（**仍只用 val**）后：
> 评估 522 / 晋升 12、配对均值 **+0.157**、CI95 **[0.040, 0.321]**、折 +20/−0 ⇒ **过两关**。
> ⇒ **进化环的瓶颈是候选搜索宽度**（不是门禁、不是算子）。这对 Wave E / 进化环 2.0 的算子调度有直接指导意义：
> 下一步应把「选父宽度」纳入 `TwistDiscoveryEngine` 调度，而**不是**放宽门禁——后者会同时放进来路不明的候选。
>
> **诚实边界**：夹具**对机制友好**（拍频目标按算子同构造生成）⇒ `+0.157` 只说明「目标族与该算子匹配时机制有效」，
> **不能**外推为生产增益；适配度是机械的"场相关"而非语义相关；未测真实模型任务成功率与真实遥测候选分布。
>
> **第四十一轮｜阶段 0「插电」全部落地（E1+ / E3+ 补齐）✅**：两片独立提交，阶段 0 的 E1+–E5 + N1/N2 **七项全绿**。
>
> ① **E1+ 成功侧蒸馏器**（`src/evolution/successPatternDistiller.ts`）：成功轨迹 ⇒ **工作流模板候选**。
> 原先成功半边只喂**固化器**（密度 ⇒ 冻结成**技能**），缺"流程复用"这一路——`workflow-template` 只有 schema 注册、
> **零候选生产者**。新增蒸馏器补上，并接入 `SignalIngestor`（路由结果新增 `distilled` 计数）+ **内核装配即启用** +
> **报告暴露 `workflowTemplates`**（接了必须可观测，否则就是「声明未接线」）。
> 判据 5 例，核心是**双源对称红线**：只有失败信号 ⇒ 模板候选**恒 0**；只有成功信号 ⇒ 防再犯提案**恒 0**；两者都有 ⇒ 都出（正对照）。
> 另钉三条纪律：只吃 `production`（seed-bootstrap / synthetic-lab 一律不入）、**M3：不蒸馏工具输出正文**
> （候选只由组合键构造，`evidence` 只存不解析；判据：evidence 里塞工具输出与主机路径，资产正文里**不得**出现）、
> 有界（记录 512 / 候选 64）。
> ② **E3+ 提案回填**（`RlvrLoop`）：采样 prompt 拼 `【历史失败原因（回填，避免重犯）】` 段。四条口径都被判据钉死：
> **空即原文**（缺省 / 空数组 / 全空白 ⇒ prompt **逐字节不变**，绝不留空标题段）、有回填 ⇒ 段内**每条**原因按序出现、
> **有界**（只回填最近 5 条 + 单条 200 字符截断并加省略号）、**贯通性**（确定性桩采样器按"prompt 是否含回填段"
> 产出不同代码 ⇒ 有回填绿样本 3 / 无回填 0 ⇒ 回填真的走通 prompt→采样→奖励→回放）。
> `RlvrStage.failureHints` 供给器取数失败按**无回填**处理（增益项不阻断主流程），`source` 分桶口径不受影响（判据断言）。
>
> **阶段 0 验收 gate 达成情况**：E1+ ✅ / E2+ ✅（探针已出首份报告：**不显著 ⇒ 进化保持默认关**）/
> E3+ ✅ / E4+ ✅ / E5 ✅ / N1 ✅ / N2 ✅ —— **七项全绿**。按商业化报告 §5，此时自进化子系统从 L1 升为
> **L2（动力学同构）候选**，升不升级由 E2 探针数字说了算（当前数字**不支持**升级：CI 下界触 0）。
>
> **下一步（阶段 1「单机商业版」）**：F1 License 引擎（机器指纹 + Ed25519：篡改 ⇒ 拒 / 过期 ⇒ **降级为核心功能而非停摆**）
> → F2 进化治理台（晋升史可视化 + 每条记录可独立 `verify()`）→ F3 RBAC-lite（越权拒 + reason 可读）；
> 阶段 2/3 的 G1/G3/G4、H2 与 F4 属**计费 / 多租户 / 市场运营**面（非离线可判的工程项），将单独裁决并如实标注。
>
> **第四十二轮｜阶段 1 起步：F1 License 引擎 ✅ + F2 治理台数据面 ✅**：两片独立提交。
>
> ① **F1 License 引擎**（`src/license/licenseEngine.ts` + CLI `license status`）：
> 先抽出 **`Ed25519PublicKey`** 公共工具（`ssh-ed25519 → SPKI` + 用**别人的**公钥验签；分发层 `AssetPackCodec`
> 改为委托，其判据保持全绿——同一份密码学解码不再有两份实现）。引擎按 F1 原文的两条硬判据收口：
> **篡改四类（档位/机器/到期/签名）一律拒**、**过期 ⇒ 降级为核心档而非停摆**（`tier:'core'` + `expired:true` +
> **不抛错**，且 `featureAllowed('core','harness')===true` / `('core','governance-console')===false`）。
> 另钉：跨机器拒、未来签发拒（超 24h 容差）、空/垃圾输入 fail-closed、**档位-功能表为唯一判断入口**
> （未登记功能名一律 false —— 新功能必须先登记档位）、机器指纹不读环境变量（16 位十六进制、同机恒同值）。
> CLI 出口：`0` 有效 / `1` 降级（并**明写"核心功能照常可用"**与续期路径）/ `2` 用法；**不内置任何公钥**（内置=把"谁能授权"写死在开源代码里）。
> ② **F2 治理台数据面**（`src/governance/promotionHistoryService.ts` + CLI `evolution history`）：
> F2 判据是「治理台展示的**每条**晋升记录都能独立复核（数据与证据同源）」。故服务**逐行自行重算**哈希
> 并检查链式连接（`prev` 是否接上上一条），而不是把台账整链 `verify()` 的结论抄一遍——
> 判据用**变异自证**钉死：改正文 / 删行 / 改哈希三类**都必须被检出**并指出第几条
> （只抄结论的实现在这里会全绿）。另给**回滚快照锚点**（时间倒序 + skillCount，治理台据此渲染"一键回滚"目标）。
> 配套改动：台账公开 **`hashOf`**（口径单一实现，不让调用方复制一份而漂移）、`PromotionLedgerPort` 增 `list()`
> （"第几条坏了"是运维第一问）。CLI 出口 `evolution history [--json]`：复核失败 ⇒ **非零退出**（CI 可察觉），只读，空台账沿 `status` 口径为 0（尚未产生 ≠ 错误）。
> **过程修掉一处自造缺陷**：首行创世 `prev` 我猜成空串/`genesis`，真实台账用**全零 64 位**哨兵 ⇒ 健康台账首行被误判断链
> （治理台"喊狼来了"比不报更糟），已按实测值改正并写进注释。
>
> **诚实边界（F1/F2）**：**F2 的 Web 工作台 tab（前端可视化）未做**——本轮落的是**数据面 + CLI 出口**
> （判据要求的"每条可独立复核"已在数据面成立，Web tab 日后消费**同一份**服务）；
> F1 的档位尚未接到真实功能开关上（`featureAllowed` 是唯一入口，接线随 F3 的 RBAC 与 F2 的治理台一起做）。
>
> **至此 `docs/ARCHITECTURE_UPGRADE_2026-10.md` §4 路线图的登记遗留项全部清零**（G1b-c / G8-c / G10-T2 / G20-b / G21-b / G25-b 六项本轮全部落地；
> 其中 G1b-c 的"L4 显式对齐是否必要"未被独立证明，另立 G1b-c2——**第二十九轮已收口**，机制结论见上）。
> 判据 ⑥ 四条：产物逐位相同 / 仪器自证 200ms / **绝对目标 ≤100ms 达成**（实测 31.9ms）/ **相对判据**（重复 5 次放大基线：同步 506ms vs
> 可让出 31.9ms = 15.9×；**变异**退回同步 ⇒ 219.5ms、1.6×，判据红）。**报告口径的 100ms 上限就此收回**。
> **变异**：让回滚不截断日志 ⇒ 端到端判据变红（有牙齿）。⚠️ **诚实登记 G1b-c2**：两条判据**都不区分** L4 的显式
> `rewindCompactionState()`（删掉它判据照样绿——压缩器面对不一致的 `previous` 会安全重折）⇒ 该修复的必要性**未获独立证明**。
>
> - 输出与 MCP `tools/list` 一律**名字升序**（顺序是 prompt 前缀的一部分，注册序漂移会废掉缓存）。判据 7 例：同输入恒同输出 /
>   **与输入排列无关** / **必需工具召回 100%** / 只增不减 / fail-safe 不变 / `tools/list` 确定性 / **生产接线检查**。
>   过程真问题：首版规划器全绿但**生产根本没传 `toolTexts`**（检索路是死的）⇒ 判据补第 ⑦ 条"声明即接线"，变异去掉接线即红。
>   判据 8 例、**4 处变异全红**；并在 `docs/README.md` 与 `llms.txt` 登记。
>   未命中类别时 **0%**（fail-safe 全放行，刻意保留）。判据新增第 ⑦ 例：schema 必须取自真实注册表、
>   节省量自洽、且 fail-safe 那条不能被"优化"掉；变异"换假 schema" ⇒ ⑦ 红。
>   开 80%/100%、ΔCI **[50,100]pp**、折负 **0/40**、**随机对照 37.5%** ⇒ 有区分力。判据 6 例可执行；⚠️ 明确声明**不是** LLM 任务增益。
>   **至此 G9（M1+M2+M3）收口；报告 §4 的 P0/P1/P3 全部项目均 ✅。**
>   （失败方向刻意偏向"留噪声"而非"丢信息"）。判据 6 例含**防误并反例**与 M3 交互；变异三处全红。
>   过程真问题：首版按空格取值位 ⇒ 中文粘英文时值位恒空 ⇒ 新事实被静默丢弃（既有测试从 `added=2` 变 1 才暴露），已改正则抽取。
>   余下仅 **G9-c（M1 记忆增益判据）**：须以"机制级可判死"口径落地（离线无 key 测不了 LLM 增益，不造数字）。
>   **P0（5 项）+ P1（10 项）+ P3（4 项）全部落地**；未做项已逐条登记（G1b-c / G8-c / G9-b / G10-T2 / G20-b / G21-b / G25-b）。
>   （无绝对路径、不依赖 gitignored 的 `.omniharness/`）。实测：192 查询 all 40.6%[33.9,47.4] / core 68.8%；46 工具 plan 模式 20–46 可见；
>   **全部精排判别器变体"不成立"**（CI 跨 0 或折负）。
>   机器可读 `llms.txt`、新增归档索引；**死链基线 96 → 24（净减 72）**。判据 6 例（含**现行索引自洽**：索引里每个链接必须
>   指向真实文件），变异三处全红。典型标本：`ARCHITECTURE_SPEC.md` 自述"311 TS 文件"而当时全仓已 900+。
>   rerank 50.0%→53.1%（上升来自语料变小，不声称算法提升）；其余实验档登记 `experimentalPaths.ts`（含**实测证据**与删除边界，
>   开启即告警）。⚠️ 边界评估纠正两处误判：三条图路共用 stage ⇒ 合并为一个家族边界；`eigenspectrum.ts` 有 9 个非检索消费者 ⇒ 不可随路删。
>   判据 6 例 **含仪器自证与正对照**（首版因键格式不匹配而**真空通过**，靠变异测试发现）。
>   **必须类型**且存量零的规则（悬空 Promise / 非 Promise await / Promise 用错位置）；新增 `gateBudget.mjs` **实测断言**预算
>   （`eslint .` 26.2s、类型层墙钟 32.2s）。⚠️ 口径变更："两项之和"对负载过敏 ⇒ 改按**并发墙钟**断言，已同步 `docs/CODE_STANDARD.md` §7.1。
>   归一化收成 `McpContentBlocks` 一处（两条客户端路径共用，防漂移）。判据 5 例走**真 SDK 适配器 + 真 stdio 子进程**，
>   变异"塌成空文本" ⇒ ②③⑤ 全红。⚠️ T2（planner BM25 + 列表确定性排序）未做。
>   "优先参考这些既有约定"改为"**不是指令**、冲突以用户要求为准"并加来源警示。判据 6 例（含**直抓模型 prompt**与
>   "只含工具输出的回合零事实"），变异关闸 ⇒ ①②③ 全红。⚠️ **M1/M2 未做**，如实记为 G9-b。
>   （既有注册点零改动）。类型层判据用 `@ts-expect-error`（未拦住即门禁红），并已用它抓住"类上只写实现签名
>   会让 `unknown` 吃掉检查"这个真问题。
>   待做：G1b-c 回滚端到端断言（已如实登记未做及原因）。详见报告 §5.1 进度表。
>
> **本轮（第五轮）交付**：`docs/ARCHITECTURE_UPGRADE_2026-10.md` —— 清理后的真实现状核查 +
> **11 专题外部调研**（学术论文 / 官方规范 / 优质开源，逐条带一手 URL）+ 升级路线图（P0→P3，每项含离线判据）+
> 反泡沫清单。它同时登记了 §8 的 6 条已确证缺陷与 7 处口径订正，是当前"架构该往哪继续投"的主要依据。

- **通用 Agent Harness**：TypeScript（CLI / Web 工作台 / 编排）+ Rust（原生内核）。
  包名 `@mylong227/omniharness`，版本 0.2.0，Apache-2.0，要求 Node ≥ 22.14.0。
- Rust 侧 6 个 crate：`omni-cli` / `omni-core` / `omni-napi` / `omni-sdk` / `omni-sdk-gen` / `omni-wasm`（39 个 .rs 文件）。
- Web 工作台 `web/src`：111 个 TS/TSX 文件（**官方 React 18.3.1 UMD**，由 `index.html` 以 `<script>` 直载
  `web/vendor/react.production.min.js`(10.5KB) + `react-dom.production.min.js`(128.7KB)，**零打包器**
  （`web/tsconfig.json` 直接 `tsc` 到 ESM）；类型层已于**第九轮（G11/W1）**换成官方 `@types/react`
  ——此前那份手写 React 垫片已删除，只留一份**只做转引**的 `web/src/types/reactGlobals.d.ts`。）
  ⚠️ 口径订正（2026-10-03 第五轮）：此前多处写成"自绘 React 垫片/无第三方运行时框架"，**与事实不符**，已订正。
- ~~评测/基准设施：`evals/` 86 个文件（评测脚本 + 落盘报告）、`benchmark/`、SWE-bench 运行器（`python/` + `eval-data/`）。~~
  **2026-10-03 已整体移除**（指令：「跑分不做了、都删掉，只要核心功能与项目完整」）：`benchmark/`、
  `evals/`、`python/`、`eval-data/`（本机 2.3 GB 级运行产物）、`scripts/*.py`（16 个图像生成基准
  run/evaluate）、`tests/bench/`、`BENCHMARKS.md` + 5 篇口径文档、`requirements.txt`，
  共 **87 个入库文件**（见 §7 变更登记）。

### 代码规模（2026-10-03 第五轮实测；**计数口径已订正**）

> **口径订正（本轮发现的历史错误）**：此前用 `Get-Content | Measure-Object -Line` 数行数，该 cmdlet
> **少计空行**——`src/context/contextEngine.ts` 实测 `(Get-Content).Count` = **646** 而行数口径给 609，
> 单文件就少 37 行。故历轮「91,079 / 92,124 行」等数字系统性偏低（全仓约低 5.6k 行）。
> **正确口径 = `(Get-Content <file>).Count` 逐文件求和**（等价于 `wc -l` 的「行数」语义）。

| 区域                                                 | 文件数  | 行数      |
| ---------------------------------------------------- | ------- | --------- |
| `src/` 全部                                          | **914** | 97,631    |
| —— adapters（协议/工具/存储/媒体/沙箱等适配器）      | 211     | 32,033    |
| —— ports（端口契约 + 组合接口）                      | **342** | 6,238     |
| —— server（HTTP/WS 服务与端点）                      | 47      | 9,104     |
| —— context（检索/压缩/仓库图/语料缓存）              | 46      | 9,948     |
| —— cli                                               | 29      | 6,212     |
| —— core（agent 循环 / 步执行 / 工具门禁 / 暴露规划） | 26      | 5,541     |
| —— util                                              | 32      | 4,248     |
| —— config（组合根）                                  | 22      | 4,104     |
| —— media / plugin / evolution / 其余                 | 约 159  | 约 12,200 |
| 单元测试 `tests/*.test.ts`                           | 385     | 53,136    |
| Web 工作台 `web/src`                                 | 111     | 17,245    |
| Rust `crates/**/*.rs`（6 crate）                     | 39      | 6,143     |

> 所有数字本机可复核：文件数 = `Get-ChildItem <dir> -Recurse -File -Filter <ext> | .Count`，
> 行数 = 对同一集合逐文件 `(Get-Content $f).Count` 求和。断言用例数 = `npm test` 输出（2,445 项）。

## 2. 当前门禁状态（2026-10-03 第四轮实跑；跑分/评测子系统已于同日整体移除）

| 门禁           | 命令                               | 结果                                                                                           |
| -------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| 类型（含 web） | `npm run typecheck`                | ✅ 零错误                                                                                      |
| 代码规范       | `npm run lint`（--max-warnings=0） | ✅ 0 告警                                                                                      |
| 铁律/体量      | `npm run check -- --strict`        | ✅ 908 文件零违规（存量白名单 13 处冻结）                                                      |
| 架构           | `npm run arch:gate`                | ✅ 依赖方向 0 / ports 纯度 0 / 依赖环新增 0                                                    |
| 成熟度         | `npm run audit:maturity`           | ✅ 40 项声明，L2/L3 均有测试证据                                                               |
| 接线完整性     | `npm run audit:config-wiring`      | ✅ 908 源文件全绿                                                                              |
| 文档死链       | `npm run check:doc-links`          | ✅ 新增 0（本轮删除产生的历史引用已冻结进基线，见 §7）                                         |
| 规范增量       | `npm run audit:standard:delta`     | ✅ 未新增标准违规                                                                              |
| 全量单测       | `npm test`                         | ✅ 2,445 项：2,441 过 / **0 失败 / 0 cancelled** / 4 skip（exit 0）                            |
| 覆盖率         | `npm run coverage`                 | ✅ **行 90.13% / 分支 83.61% / 函数 87.63%**（第五轮实测；注意"覆盖"≠"有效"，见调研报告 §3.9） |
| Rust 单测      | `npm run rust:test`                | ✅ 全绿                                                                                        |

> **已移除的门禁**（随跑分子系统一并删除，如实登记）：
> `eval:ci`（召回锚点 / rank-veto 回溯 / 缓存命中 / 工具选择 / 前缀稳定五件套）、
> `eval:veto`、`eval:recall-query-audit`、`eval:tool-exposure-e2e`、`eval:skill-routing --gate`、
> `eval:lsp-*`、`bench*`、`metrics:tool-exposure`。CI 的 `eval` job 已同步删除
> （**上一次删除 `eval:*` 却漏改 CI 有事故留档，本轮已按要求同步**）。
> 代价：召回率 / 前缀缓存复用率 / 工具暴露零损伤 / 技能路由三关**从此没有机械判据**，
> 相关历史数字只能引 git 历史且须标注「脚本已移除、不可复跑」。

依赖政策：`dependency-allowlist.json`（D10：必要且更优即可引入；`src/ports/**` 与 `src/core/**` 恒第三方-free），允许/拒绝许可清单见该文件。

### 2.1 修掉的一项**门禁级**性能缺陷（2026-10-03，blocking）

**现象**：`npm test` 报 `fail 0` 却 **exit 1**——`sessionLifecycle` / `workflowRunner` 两文件在并发
全量跑法下被 120s 文件级超时 cancelled（旧看板把这 2 个 cancelled 当作「并发产物」记账，实际是
性能缺陷）。单文件实测 sessionLifecycle **100.4s**。

**根因**（本机 CPU profile 实测，非推断）：`RepoMapContextEngine` 的全部价值都在进程内长寿命缓存上
（全仓语料索引，902 文件 **8.6s** 量级），而装配层在每个组合根（`ConfigFactory.build`）与**每个子代理**
里 `new` 一个实例 ⇒ ① 缓存生命期退化成「一次装配」；② 写类工具成功后走 `clear()` **硬删**，而
`shell` 里跑 `echo` / `git status` / `npm test` 并不改被索引的源码 ⇒ 单个回合把全仓索引**两遍**。

**改动**：进程级唯一引擎（`context/repoMap/repoMapEngineProvider.ts`）+ 写工具后改走
**软失效**（`CorpusIndexCache.invalidate`，先复核内容签名，未变即复用）。

| 对象                      | 修前                   | 修后           | 判据                                     |
| ------------------------- | ---------------------- | -------------- | ---------------------------------------- |
| `sessionLifecycle` 单文件 | 100.4s（贴 120s 门限） | **14.2s**      | `node --test … sessionLifecycle.test.js` |
| `workflowRunner` 单文件   | >120s（cancelled）     | **10.5s**      | 同上                                     |
| 子代理启动的索引成本      | 每子代理一次全仓索引   | 进程内复用一次 | `repoMapEngineProvider.test.ts`          |

## 3. §3 已清偿（2026-10-03 第二轮：原 6 项全部修完，各附回归判据）

> 上一版 §3 列了 6 项「经评估暂缓」的缺陷。本轮全部清偿，逐项留档如下（判据可本机复核）。
>
> ⚠️ **2026-10-03 同日追加说明**：本节第 5 项的判据曾用 `evals/skill-routing-ab.mjs --gate`
> （"三关齐过"），该脚本已随跑分/评测子系统整体删除 ⇒ **那些判据不再可复跑**，本节保留原文
> 以存史（按本板纪律不许无声改写结论），但引用其数字时必须标注「脚本已移除、不可复跑」。
> 其余各项的判据都是 `tests/unit/**` 单测，**仍然有效**。

1. **✅ 已修：rollback 不截断内存事件流**（原 P1）。新增 `LiveSessionRewindPort` +
   `LiveSessionRewindRegistry`（进程级登记表）→ `AppendOnlyEventLog.rewindTo`（越界 fail-closed）+
   `SessionRecorder.rewindTo`（夹回合起点、重算检索 seq、反注册被撤销文档）+
   `EventPersister.rewindTo`（**先等在飞全量写再强制重写**，长度相等时靠独立 `forceWrite` 判脏）。
   判据：`tests/unit/liveSessionRewind.test.ts` 11 例（含「回滚后照样 schedule 落盘，历史不复活」）。
   定位：`src/core/checkpointManager.ts` / `src/core/liveSessionRewindRegistry.ts` /
   `src/core/loop/eventPersister.ts` / `src/core/appendOnlyEventLog.ts` / `src/core/sessionRecorder.ts`。
2. **✅ 已修：TurnDiffHooks 基线跨回合不重置**（原 P2）。基线改为**只在 tracker 里存一份**
   （`hasBaseline` / `recordBaseline`；`noteWrite(path, after)`），钩子不再自持 Map ⇒
   跨回合复用**在结构上不可能**。判据：`tests/unit/turnDiffTracker.test.ts` 新增
   「回合边界后基线重置，diff 不跨回合累计」（旧实现该用例必红）。
3. **✅ 已修：压缩阈值 token 记账系统性偏低**（原 P2）。`TokenEstimator.estimateMessage` +
   `accountableText` 成为**唯一记账实现**（content → reasoning → toolCalls JSON → 附件信封；
   二进制载荷仍不计，理由成文）；`ContextBreakdownEstimator` 改为委派；
   `ContextCompactor.compact(messages, state, overhead)` 把**工具 schema + 未拼入的 repo-map 尾段**
   作为每请求固定开销并入同一预算（预留超预算时夹 20% 下限，不清空历史）；`StepRunner.requestModel`
   调序为先算工具集再组装消息。**Rust FFI 同步**（`handle_context_estimate` + `accountable_text`），
   本机 `npm run native:build` 后富载荷奇偶校验 **0 skip 通过**。
   判据：`tokenEstimator.test.ts` / `contextCompactor.test.ts` / `nativeTokenEstimator.test.ts`。
4. **✅ 已修：Ollama 流式工具调用按函数名合并**（原 P3）。有 `index` 按槽位分桶；字符串参数
   **按片段累积、流末只解析一次**；`id` 逐条唯一（旧实现用函数名当配对键）。无 `index` 保留按名
   合并——**无真实样本不推断该形态的并行语义**（遵「无样本不改协议解析」）。
   判据：`tests/unit/llamaCppToolCalls.test.ts` 5 例（脚本化 NDJSON）。
5. **✅ 已修：SkillSparsifier 在 BM25 生产路径上空转**（原 P3）。`SkillRegistry.rankForPrompt()`
   拆出**不截断**的比率过滤排名，生产改用它 + `sparsify(..., relevance)`（相关性作主序）；
   `selectForPrompt()` 契约不变。判定档同步改为生产真实两段管线并重跑
   `eval:skill-routing --gate`：召回 **92.3%**、噪声 **1.50** 条/查询、Δ **+65.38pp**、
   CI95 **[46.15, 84.62]pp**、留出折 0/40 为负 ⇒ 三关齐过（exit 0）。
   判据：`tests/unit/skillSparsifier.test.ts` 新增 3 例（含「上游预截断 ⇒ 判据必然退化」）。
6. **✅ 已修：apply_patch 多文件落盘非原子**（原 P3）。两阶段提交（准备：建父目录 + 已存在目标写
   `.bak`；提交：逐个落盘，任一次失败即**回滚**已写文件）＋「不存在」与「空文件」分离
   （只把 ENOENT 当不存在）。判据：`tests/unit/patchApplierFuzzy.test.ts` 新增 3 例
   （`.bak` 生成 / 目标 EISDIR 时一个字节都不落盘 / 只读目标写失败时回滚 one.txt）。

### 3.1 §3.1 两项遗留项已清偿（2026-10-03 第三轮）

1. **✅ 已修：写类工具后的全量重索引 → 增量重建**（原登记：真改源码后仍全量重建 8.6s 量级）。
   本机实测拆出三段成本（3227 文件 / 33.5 MB 语料）：遍历 **0.3s** + 读盘/分词/抽符号 **3.9s**
   - BM25 建索引 **3.0s**（file 2.2s + symbol 0.8s）。据此三处各降一档：
   * **解析规则单一实现**：新增 `context/corpusFileParser.ts`，全量路径（`indexCorpus`）与增量
     路径共用它——两处若各写一套，增量与全量结果会**静默**漂移。
   * **按内容哈希复用产物**：`context/corpusFileArtifact.ts` + `IndexOptions.artifactSink`；
     产物表随语料缓存条目（LRU 驱逐即释放）。
   * **BM25 就地替换**：`Bm25Index.setDocument(slot, tokens)`（+ `addDocument` / `slotCount`），
     只重算变化文件的 df/postings/文档长度，槽位不变（`setDocument` 越界 fail-closed 抛错）。
   * **签名复核与增量共用一次读盘**：`contentHashes()` 产出的逐文件字节哈希直接喂给增量重建器，
     只对真的变了的文件再读一次（此前「先签名、后重建」是两次遍历）。
   * **何时不增量（宁可慢不可错）**：文件集合/顺序变化、缺产物表、`light: false`（full 模式）、
     文件不可读 ⇒ 返回 `null` 回落全量重建。

   **实测（本仓，`npm run build` 后的 dist，TTL=0 强制复核）**：

   | 场景                       | 修前           | 修后         |
   | -------------------------- | -------------- | ------------ |
   | 首次全量建索引             | 9.4s           | 9.4s（不变） |
   | 无关写后取语料（内容未变） | 0.9s（软失效） | **0.9s**     |
   | **改 1 个源文件后取语料**  | **9.4s**       | **0.96s**    |
   | 再改 1 个源文件后取语料    | 9.4s           | **1.10s**    |

   即「真改了源码」这一档 **9.4s → 0.96s（≈10×）**；剩余 ~0.9s 是内容签名复核（读+哈希
   3227 个文件），它同时是变更判据与增量输入，不再是纯开销。
   判据：`tests/unit/corpusIncremental.test.ts`（6 例，**与全量重建逐位对拍**：files/symbols/
   fileText 逐字段相同 + 两套 BM25 在 5 条查询上命中 id 与分数逐位相同；覆盖「符号数不变」
   「符号数变化」「内容未变须复用同一对象」「文件集合变化须回落」）+ `tests/unit/bm25Incremental.test.ts`
   （4 例：替换后与全量重建的 id/分数/df/idf 逐位一致、越界抛错、空文档替换无残留）。

2. **✅ 已修：Ollama 多轮回传**（原登记：`buildRequest` 只透传 `role` + `content`）。
   **先查官方文档再动手**（`ollama/docs/api.md` 的「Generate a chat completion」message 字段表，
   2026-10-03 取用）：message 支持 `tool_calls`（`[{function:{name,arguments}}]`，**arguments 是
   对象**、条目**无 `id`**）与 `tool_name`（工具结果消息用）；**Ollama 没有 `tool_call_id`**
   （原先登记的「tool_call_id/tool_name」有一半是错的，已按文档更正）。改动：

   - assistant 消息回传 `tool_calls`（对象参数、不凭空加 `id`）；
   - 工具结果消息带 `tool_name`，且由**同请求 assistant 的 id→名映射**精确取值——
     不解析 id 字符串（本适配器合成的 id 形如 `name#2`，工具名本身含 `#` 时会解错）；
     映射里查不到就**不发**该字段（缺字段好过假字段）；
   - `images` 内联为**纯 base64**（剥 data URL 前缀）；`http(s)://` / `file://` 形式无法在不下载
     的前提下内联，**不发假字段**并记 debug。
     判据：`tests/unit/llamaCppToolRoundTrip.test.ts`（5 例，stub fetch **断言我们真正发出的请求体**：
     含「名字本身带 `#`」的用例证明映射优于字符串解析）+ 既有 `llamaCppToolCalls.test.ts` 5 例。

### 3.2 §3.2 两项登记结论（2026-10-03 第四轮）

1. **✅ 已修：`CorpusIndexCache` 之上的 embedding 重建**（原登记：语料一变就整仓重新嵌入）。
   新增 `context/embeddingContentCache.ts`（`EmbeddingContentCache`：按「角色 + 内容哈希」复用向量，
   **按代际清扫**保证常驻向量 ≈ 一份索引的量级）+ `context/cachedEmbeddingPort.ts`
   （`CachedEmbeddingPort`：装饰 `EmbeddingPort`，只把未命中文本交给真实模型，返回顺序与长度不变，
   `preload` 仅在内层支持时透出）；`SemanticIndexCache` 只为构建期包一层，索引仍按语料身份重建
   （审计 R3 的正确性不变），但**向量按内容复用**。

   **实测（本仓 3229 文件 / 67074 符号 / 一次索引 69773 条待嵌入）**：

   | 场景                                            | 修前          | 修后                      |
   | ----------------------------------------------- | ------------- | ------------------------- |
   | 首次建语义索引                                  | 69,773 次嵌入 | 69,773 次（不变）         |
   | 改 1 个源文件（改动落在**被嵌入窗口内**）       | **69,773 次** | **1 次**（复用 99.9986%） |
   | 改 1 个源文件（改动落在窗口外，被嵌入文本未变） | 69,773 次     | **0 次**                  |

   判据：`tests/unit/embeddingContentCache.test.ts`（5 例）——① 只重嵌变化条目（计数型假端口）；
   ② **与冷缓存从零构建的索引在 4 条查询上命中 id 与分数逐位一致**（省的是重复计算，不是正确性）；
   ③ 角色分离（query 与 document 不互相复用）；④ 代际清扫使条目数不随编辑次数增长；
   ⑤ **构建失败不清扫**（否则模型离线重试要从零嵌入）。
   边界如实登记：端口契约无模型标识 ⇒ 缓存假设「同一端口实例生命周期内模型不变」，另加一道
   维度校验兜住「换不同维度模型」；同维不同模型的极端情形未覆盖。

2. **⛔ 关闭（不实施）：full 模式的增量**（原登记：只服务 light 档）。
   本轮先查「谁会用」再决定做不做，结论是**没有受益方**，故按「不为模式而模式」关闭：

   - 生产路径 `src/**` 里 `light: false` 出现 **0 次**（唯一一处是 `contextEngine` 的文档注释）；
   - 全仓 `evals/**` 只有 **4 个脚本**用到 full 档，且每个脚本**一次进程内只建一次该配置的语料**
     （`diag-spectrum` / `rank-veto-retro` / `recall-codebase-real` 各 1 次；`context-efficiency/bench`
     2 次但两变体 `morph` 不同、本就是两份不同语料）⇒ 进程级增量缓存对它们**零收益**。
     （2026-10-03 追加：`evals/` 本身已整体删除，这条「无受益方」的结论因此**更加成立**——
     full 档现在在仓内**只剩 `light: false` 的零调用点**。用 `Select-String -Path src/**/*.ts
-Pattern 'light:\s*false'` 复核即可。）
   - 反方向代价明确：频谱 / 代码图 / LSA 都与符号下标强耦合，做增量要把「符号槽位平移」传播到
     三类派生结构，属于「只增耦合、无实测受益」的改动。

## 4. 挂起项（有明确外部条件，非「不知道怎么做」）

- ~~**官方跑分**（SWE-bench Verified / Terminal-Bench 官方口径）：依赖付费模型 API key 与
  Linux/docker 运行环境，本机（Windows、无代理、间歇外网）不可复现。~~
  **⛔ 2026-10-03 撤销（不再是挂起项）**：用户指令「跑分不做了、都删掉」。整个跑分/对外评测
  子系统（含 SWE-bench 容器运行器 `python/` 与 `eval-data/`）已删除，本项目**不再追求官方口径数字**。
  历史非官方口径数字仍在 `CHANGELOG.md` 与 git 历史里，但**没有可复跑判据，不得当作现状引用**。
- **注入攻击度量**（T4.4）：等待真实数据集快照；当前护栏为规则式（`promptInjectionGuard`，
  已接线 agent/config/cli 生产路径，enforce/shadow/off 三态）。
  （原 `eval:injection-*` 度量脚本已随跑分子系统删除，故该项现在**只剩护栏实现，没有度量口径**。）
- ~~**语义召回生产端到端验证**：向量落盘缓存（`diskCachedEmbeddingAdapter`）由假嵌入端口的
  单测覆盖；真实模型端到端未验证（本机无 ONNX 权重下载条件），不得声称已实测加速。~~
  **✅ 2026-10-03 已实测（推翻旧结论）**：本机权重其实**已就位**
  （`.omniharness/model-cache/Xenova/e5-small-v2`：config + tokenizer + model_quantized.onnx），
  配 `preset: 'e5-small-v2'` + `localFilesOnly: true` 可**完全离线**跑通（实测 dim=384、冷启 713ms、热 11ms）。
  ⚠️ **吞吐数字已订正（2026-10-03 第五轮复测）**：原写"180–320 texts/s"**复现不出**——用 256 条 ≈90 字符文本、
  e5-small-v2 量化档、batch 8/32 复测为 **26.1 / 29.7 texts/s**（另有独立调研测得 ~50 texts/s，差异来自文本长度与批构成）。
  ⇒ **吞吐是文本长度与批的强函数，任何单点数字必须连同方法一并引用**；此前的 180–320 属错误记录。
  当时的可复现脚本为 `evals/semantic-e2e-real.mjs`（**该脚本已于同日随跑分子系统删除**，故下表数字**不再可复跑**，
  仅作当次实测留档；语料是复制到临时目录的 `src/` 有界子集，60 文件 / 1108 条待编码）：

  | 段  | 场景                        | 编码条数 | 耗时  |
  | --- | --------------------------- | -------- | ----- |
  | ①   | 首建                        | 1,108    | 37.7s |
  | ②   | 同进程改 1 文件（内存复用） | **1**    | 0.17s |
  | ③   | 模拟重启（落盘复用）        | **0**    | 0.03s |
  | ④   | 重启后再改 1 文件           | **1**    | 0.56s |
  | ⑤   | 冷基线（独立缓存目录）      | 1,108    | 37.5s |

  硬判据（**通过**）：②↔③ 是同一批缓存向量（内存复用 vs 落盘复用），检索命中与分数
  **逐位相同**（最大差 0）⇒ 缓存不喂错向量。绝对耗时**不得外推**到全仓（全仓约 7 万条）。

  **顺带修掉一处真缺陷（本轮）**：`DiskCachedEmbeddingAdapter.flush()` 的类文档写明
  「公开给装配层在关停时显式调用」，而全仓**没有任何调用点** ⇒ 每次构建最多 `flushThreshold−1`
  条向量**静默不落盘**（实测残留 **84/1108** 条），重启后重付这段编码。
  现由 `SemanticIndexCache` 在**构建成功后**调用（`EmbeddingPort.flush?` 为可选契约，
  `CachedEmbeddingPort` 透传），实测 ③ 由 84 条/20.2s 降为 **0 条/0.03s**。

- **⚠️ 新增纪律级实测（语义检索的可比性边界，引用任何语义数字时必须一并说明）**：
  真实模型的向量**依赖批次构成**——同一文本 `solo` vs `batch(32)` 的分量最大差 **6.3e-3**、
  余弦 0.99904（同批次构成则逐位相同，跨会话亦然；本机 e5-small-v2 离线量化档实测）。
  后果：**跨运行 / 跨配置的语义对比不得以「逐位相等」或「top-1 相等」为判据**——
  近邻分差小于该噪声地板时排序会翻转（本轮实测到 top-5 内位置互换与 top-1 翻转，
  cosine 差 ~2.3e-3）。可操作判据：**同一批缓存向量**之间用逐位对拍（缓存正确性），
  跨批次一律用 top-k 覆盖率 + 分数容差（脚本按 ≥60% 覆盖率做粗损坏探测）。

## 5. 活跃纪律摘录（原决策日志 D1–D9 随旧看板删除，仍具约束力的口径摘录在此）

- **D6 翻默认两关**：改检索/排序类默认前，必须过 ① 否决器（新路与基线 Top-K 平均 Jaccard
  重合度过高 = 常量偏置，直接判负）② 同语料配对 bootstrap 95% CI 下界 > 0 且留出折多数为正。
  点估计为正但 CI 跨零 ⇒ 判「与噪声不可区分」，不得翻默认。**确定性集合成员**场景（如工具
  暴露）用该判据的可操作形态：接线活性 + 跨查询敏感度 + 假阳性分数地板 + CI/留出折。
  ⚠️ 2026-10-03：**判据本身保留，但执行它的评测脚手架已删除**（`evals/` 全量）。
  故该纪律现在只能靠**外部/自建**测量满足——没有脚手架就不得声称「已过两关」。
- **D7 行为变更登记**：默认行为变更必须量化代价与收益并留档（例：工具暴露翻默认时
  schema token −63.4%、平均可见工具 33→14，配零能力损伤 + 100% 必需召回两道判据）。
  ⚠️ 同上：上述数字来自已删评测脚本，**引用须标注「脚本已移除、不可复跑」**。
- **D10 依赖政策**：必要且更优即可引入，同等能力优先成熟第三方；「零依赖」不构成拒绝理由；
  手写实现降格为资产 + 回退路径。权威文件 `docs/DEPENDENCY_POLICY.md`。
- **随机性必须种子化 / 门禁输出必须干净 / 测试红先分清「测试错」还是「代码错」**：详见
  `omniharness-coding-standard` skill 与 `docs/CODE_STANDARD.md`。

## 6. 快速命令（生产口径）

```bash
npm run build          # tsc + 资产拷贝
npm test               # 构建 + 全量单测（官方门禁口径）
npm run typecheck      # tsc --noEmit（含 web）
npm run lint           # eslint --max-warnings=0
npm run check -- --strict && npm run arch:gate && npm run audit:maturity   # 标准三闸
npm run audit:config-wiring && npm run check:doc-links && npm run api:check
npm run rust:test      # cargo test --workspace
```

~~评测命令（`eval:ci` / `eval:skill-routing` / `eval:tool-exposure-e2e` 等）~~
**2026-10-03 全部移除**：跑分/评测子系统已删除，`package.json` 不再有 `eval:*` / `metrics:*` /
`bench*` 脚本（CI 的 `eval` job 同步删除）。改动检索/排序/压缩默认值时，须用**自建**测量
（可写一次性脚本，但不入库为门禁），并在看板登记「口径 + 语料规模 n + 是否带 CI」。若引用历史
评测数字，一律标注「脚本已移除、不可复跑」。

## 7. 变更登记：跑分/评测子系统移除（2026-10-03，第四轮）

**指令**：「跑分的不再做了，直接删除即可，我们只要保证项目核心功能、项目的完整」。

**已删除（87 个入库文件 + 本机 2.3 GB 级运行产物）**：

| 路径                                                                            | 文件数 | 说明                                                                             |
| ------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| `benchmark/`                                                                    | 6      | 效率基准 / 六属性自检 / 参数收紧闭环 / telemetry 配置                            |
| `evals/`                                                                        | 51     | 召回、重排、语义桥、爬虫、BM25、工具暴露等测量脚本与报告                         |
| `python/`                                                                       | 3      | SWE-bench 容器内的 OmniHarness 运行器                                            |
| `scripts/*.py`                                                                  | 16     | ComfyBench / GenEval / GenEval2 / KRIS-Bench / ReasonEdit / WISE 的 run+evaluate |
| `tests/bench/`                                                                  | 4      | 该目录下的微基准（compaction / nativeVsJs / tokenEstNative / agentTask）         |
| `BENCHMARKS.md` + `docs/SWEBENCH_*.md`(4) + `docs/ZERO_COST_CAPABILITY_EVAL.md` | 6      | 对外跑分口径与交接文档                                                           |
| `requirements.txt`                                                              | 1      | 上述评测栈（含 GenEval2/CUDA 轮子）的 Python 依赖                                |
| `eval-data/`（**本机，gitignored**）                                            | 0      | SWE-bench/Terminal-bench 运行产物：克隆仓库、testlogs、56.7 MB 向量缓存等        |

**配套同步（缺一即红，逐项已做）**：

1. `package.json`：删除全部 `eval:*` / `metrics:*` / `bench*` 脚本（**注意**：2026-10-02 的
   `ef2ac0f` 删了 `eval:*` 却漏改 CI，导致 CI job 三步 `Missing script` 恒红——本轮**同步**删了
   `.github/workflows/ci.yml` 的 `eval` job，避免重犯）。
2. 活跃文档改写：`README.md`（§2.4 基线段）、`docs/ARCHITECTURE_SPEC.md`（§8 尚缺 + §9 整体重写为
   「已移除」清单）、`docs/archive/compliance.md` 第 36 行（标注降幅数字无复跑判据）、
   `docs/archive/MIGRATION_MAP_2026-09.md`、`docs/archive/library/10-math-information-and-optimization.md`
   （保留实测结论，标注脚本已移除）。
3. 历史引用**冻结**（不改写历史结论，按 `ef2ac0f` 的既有做法）：新增死链按
   `scripts/docLinkBaseline.json` 纳入基线，涉及 `RECALL_HEADROOM_SURVEY` / `POLISH_PLAN` /
   `DEFICIENCY_AUDIT_2026-09-22` / `UPGRADE_PLAN_SYNTHESIS` / `U3_CONTEXT_RECALL_EXPERIMENT` /
   `TECH_DIRECTION_SYNTHESIS_2026-09-12` / `agent_evolution_research/*` / `CORE_CAPABILITY_AUDIT_2026-10-01`
   等**存档性审计与研究文档**。
4. 保留不受影响的部分：`src/`（运行期不读任何被删文件，仅注释/JSDoc 里的历史引用）、
   `tests/unit/**`（含召回查询夹具——它们是单测数据，不是评测脚本）、Rust crate、Web 工作台、
   `third-party/`（Laya 与模型权重缓存与跑分无关）。

**代价（如实登记，不得淡化）**：召回率、前缀缓存复用率、工具暴露「零能力损伤」、技能路由三关、
压缩降幅、SWE-bench 口径数字——**从此都没有机械判据**。看板 §3/§4 相关条目里的数字仍然保留为
历史记录，但引用时必须写明「脚本已移除、不可复跑」。核心功能与项目完整性由九道门禁 + 全量单测
（`npm test`）继续守住。

## 8. 已确证待修缺陷（2026-10-03 第五轮，架构复核 + 外部调研交叉发现）

### 8.0 ✅ 已修（2026-10-04 第二十九轮）：时间敏感的判据（偶发假红）

- **`memoryWriteQuality.test.ts` 第 ② 例**「值位冲突（`policy` → `restricted`）⇒ 新的可召回、旧的失效但**仍留存**」。
  - **现象**：全量并行跑 3 次里出现 1 次失败；单跑该文件 6/6 全过；随后全量复跑又全过。
  - **成因（读码判定）**：该用例的"可召回"过滤用**墙钟**（`Date.parse(f.expiresAt) > nowMs`，`nowMs = Date.now()`），
    而 `supersede` 写入的 `expiresAt` 与"现在"只差一个很小的余量（实为**零余量**：`new Date().toISOString()` 即调用时刻）
    ⇒ 门禁机器忙、时间跨过边界时，"旧事实已失效"与"旧事实仍留存"两条断言会互相打架。
  - **修法（已实施）**：`MemoryExtractorOptions` 注入可选 `now?: () => number`（默认 `Date.now`，缺省行为逐字节不变），
    `createdAt` 与替代 `expiresAt` 的时间源走该缝；判据 ② 注入**受控时钟**（时间前进一分钟再写冲突结论），
    断言"失效时刻 = 替代发生的受控时刻"且"受控时刻上可召回恰一条"——判据恢复确定性。
    其余用例（③④⑥）的采样点本就在替代**之后**（`expiresAt ≤ now` 恒成立），本就确定，不动。
  - **纪律**：判据必须确定性——偶发假红与偶发假绿同样是缺陷（`CODE_STANDARD.md` §11.3）。

### 8.1 ✅ 已修（2026-10-03 第六轮）：子代理的**文件写入被静默丢弃**（隔离有、回并路径无）

**现象**：委派给子代理的「改代码」任务会返回 `ok: true` + 一段声称已完成的总结，但**主仓库零改动**，
且改动内容不可恢复——工作树与分支都被删掉。等于「假成功 + 静默数据丢失」。

**证据（本机读码，可复核）**：`subagentOrchestrator.ts:62-68` 建独立工作树并把 `workspaceRoot` 指向它；
`:74-77` 的 `finally { worktree.cleanup() }`；`worktreeOps.ts:74-97` 的 cleanup =
`git worktree remove --force` **+ `git branch -D`**；`toolViewOf` 只剔递归入口（写类工具对子代理**可用**）；
`subagentResult.ts` 无 diff/patch 字段；全仓 `WorktreeOps` 仅 2 处引用 ⇒ **无合并路径**。
另：`run_workflow` 的 `execute()` 自称"隔离"，实际传父级 ports（无 worktree）⇒ **语义与文档相反**。

**修法（已实施，两条隔离档都不再静默）**：

| 档                          | 语义                    | 机制                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **worktree**（git 可用）    | 改动**可回收**          | `WorktreeOps.collectChanges()`（先 `git add -A` 纳入未跟踪新建文件，再 `git diff --cached --binary HEAD`；>4 MiB 截断标注）+ `persistChanges()` 落盘到 `.omniharness/subagent-patches/<sessionId>.patch`；编排层在 `cleanup()` **之前**采集并挂 `changedFiles`/`patchPath`/`patchBytes`/`patchTruncated`，并 `log.warn` |
| **copy**（git 不可用/失败） | **禁写（fail-closed）** | `SubagentToolScope.writeForbidden()` 从工具视图剔除全部 `MUTATING_TOOLS`，结果标 `writesForbidden`——没有 git 可比 ⇒ 改动不可能取回，故明确拒绝而不是假装成功                                                                                                                                                            |

另：采集失败置 `writesUnrecoverable`（fail-closed 标记，绝不静默）；`SubagentTool.render()` 把上述事实
**渲染给父模型**（改动清单 + patch 路径 + `git apply` 命令 / 禁写说明），否则"子代理说改好了"仍会被读成"已改好"。

**S3（工作流）**：docstring 订正为"构造**共享工作区**的子智能体"（并说明与子代理隔离相反的原因）；
新增 `WorkflowLayerPolicy`——同层＞1 步且任一步**可能写**（未声明 `tools`＝拿全集，或声明含写类）时
**该层退化为串行** + `log.warn('workflow.layer.serialized')`，消除并发覆盖同一文件的竞争。

**判据**：`tests/unit/worktree.test.ts` 新增 2 例（修改/新建/删除三形态可采集，patch 落盘后能
`git apply` 回主仓并真的拿到改动与删除；无改动时采集为空）；新增 `subagentToolScope.test.ts` 4 例
（收窄不含写类、只读保留、不改原请求、写类清单护栏）；新增 `workflowLayerPolicy.test.ts` 5 例（单步不退化、
只读层保持并发、未声明必串行、含写类必串行、三态判定）。

**遗留（如实登记）**：工作流同层冲突处理是**保守退化（串行）**而非"按声明精确判冲突"——
`WorkflowStep` 尚无"我写哪些文件"的声明字段；精确并发需先加声明契约，属独立改动（记入报告 §4 后续项）。
**✅ 已收口（2026-10-04 第三十轮）**：`WorkflowStep.writes` 写集声明 + `WorkflowLayerPolicy` 声明式精确并发落地，
判据与变异见本轮横幅与 `workflowLayerPolicy.test.ts`。

### 8.2 ✅ 已修（2026-10-03 第六轮）：回滚后「压缩游标」未复位（回滚对齐漏了第四层）

**现象**：同一进程内 `checkpoint` 回滚后，`StepContextBuilder` 的内存压缩游标仍指向**已被截断移除**的折叠点；
**重启进程反而正常**（新实例会重新恢复），故属"同进程不对、重启对了"这类最难查的形态。

**证据（本机复核）**：`src/core/stepContextBuilder.ts:44,46` 定义 `compactionState` / `stateRestored`；
`stateRestored = ` 全仓**只有两处**——L46 初始化为 `false`、L102（构造后首次 `buildMessages`）置 `true`，
**没有任何地方置回 false，也没有 reset()/setter**。而 `SessionRecorder.rewindTo` 会经 `eventsFrom` 把那条
`OMNI_COMPACTION_V1` 游标事件从日志移除 ⇒ 游标悬空。

**注**：另外三层回滚对齐本身是**做对的**（内存事件流 / 检索索引 / 磁盘 + 在飞写），且端口不支持 `remove` 时
会显式 `log.warn('session.retrieval.rewind_unsupported')` 而非静默——本缺陷是**第四层**（上下文游标）漏了。

**修法（已实施）**：新增 `StepContextBuilder.rewindCompactionState()`——**就地重新推导**游标
（取"截断后日志里的最后一条标记"，没有即 `undefined`）；经 `StepRunner` / `TurnRunner` 透传，
由 `Agent.registerRewinder` 在 `recorder.rewindTo(size)` **之后**调用（第 4 步接线；
`activeRunner` 用延迟绑定，因为回卷登记发生在 `buildTurnRunner` 之前）。
**刻意不把 `stateRestored` 置回 false**：那会让下一次构建走"首次恢复"路径并把 `previous` 当 `undefined`，
可能多付一次摘要 LLM 调用（正是该文件注释记录的旧缺陷 P0-1）。

**判据**：`tests/unit/contextIntegrityFixes.test.ts` 新增 ⑤——先用真压缩器产出真实游标事件，
再用记录型压缩器观察每次传入的 `previous`：① 首次构建恢复出游标；② **截断游标事件但不复位** ⇒ 仍复用
被移除的游标（复现缺陷形态）；③ 调用 `rewindCompactionState()` 后 ⇒ `previous === undefined`
（承认"截断后的日志里没有游标"，即已完成重新对齐）。

**仍未做（如实登记）**：接线（`Agent → TurnRunner → StepRunner → StepContextBuilder`）目前只有
类型检查 + 本次单测覆盖语义，**缺一条端到端断言**（真实回合里跑 `checkpoint` 回滚后核对下一次请求的消息）；
已并入 G1「最小行为回归守卫」的用例清单。

### 8.3 ✅ 已修（2026-10-03 第八轮 G7）：事件落盘是「全量快照重写」而非增量追加（写放大随会话长度增长）

**证据（本机复核）**：`EventPersister.saveSnapshot` → `storage.save(sessionId, events)`（`eventPersister.ts:139-163`），
而 `TurnRunner` **每步**调 `schedule()`（`turnRunner.ts:107-108`，默认 200 ms 批量）；三个适配器都**没有 append 通道**：
`jsonlStorage.ts:33-48` 整文件 tmp+rename；`sqliteStorage.ts:49-67` 一个事务里 **`DELETE` 全桶 + 逐条 `INSERT`**。

**影响**：与"append-only 事件溯源"的架构主张不一致，且长会话后段每次 flush 都在重写 N 条。
**本机实测（2026-10-03，`JsonlStorage.save` 单次调用成本）**：200 条 ≈ 28 ms / 89 KB；3,200 条 ≈ 41 ms / 1.6 MB；
**12,800 条 ≈ 139 ms / 6.5 MB** ⇒ 单次成本随 N **线性**，而 flush 每步触发 ⇒ 会话累计写入 ≈ `size_N × 步数 / 2`
（12,800 事件 × 1,000 步的尾部量级 ≈ **GB 级重写**）。**口径**：这是"实测单次成本 × 线性增长"的**外推**，
不是端到端实测（仓库现已无 perf 测试）。

**修法（已实施，第八轮 G7）**：`StoragePort` 新增**可选** `append?(sessionId, events, fromCount)`——fail-closed 契约
（写入前校验桶内条数 = 声明的 `fromCount`，不符即抛错）；jsonl 走**真追加**（`appendFile`，磁盘字节数做 O(1) 前缀校验）、
sqlite 走 `INSERT OR REPLACE`（**不再 DELETE 全桶**）；`EventPersister.write()` 优先 append（前置：后端实现 append、
本回合已有成功落盘、非回卷重写），任何失败回退全量 `save`；**回卷必全量**（`forceWrite`：追加只能表达"多写"，
截断语义必须覆盖）。适配器不实现 `append` 即自动回到全量行为。
**判据**：7 例（两路 `load()` 逐条深相等、写入量 = 新增条数 40 vs 100 等）；**变异**关掉追加 ⇒ ④⑤ 变红。
**销账注（2026-10-04 第三十轮盘点）**：修复落地后本节状态漏翻——与 §8.0 同为"修了没销账"形态，本轮补记。

### 8.4 ✅ 已修（2026-10-03 第六轮）：取消原因在 **AbortSignal 桥**上丢失（原诊断已订正）

**原诊断订正（读码复核后）**：本条原写"级联时把 reason 写死成 `'parent'` 与文档矛盾"。复核后：
`'parent'` 是 `CancelReason` 联合类型里的**一等值**，且 `loopCancellation.test.ts:45` 明确断言
`child2.cancelReason === 'parent'` ⇒ **级联标 `'parent'` 是有意设计**（表示"我是被父令牌级联取消的"），
不是缺陷；且 `child()` 在 `src/**` 里**没有任何生产调用点**（仅测试使用）。

**真正的缺陷在两处（读码 + 实测确认）**：

| #   | 位置                                                   | 事实                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/core/loop/cancellationToken.ts` `toAbortSignal()` | 两处 `controller.abort()` 都**不带 reason** ⇒ `AbortSignal.reason` 退化成通用 `AbortError`(DOMException)。而 `agent.ts:413` 正是把该 signal 交给模型层 ⇒ 下游**拿不到任何结构化原因**。                                   |
| 2   | `src/subagent/cancellableModel.ts` `reasonOf()`        | 白名单只有 `'user'\|'timeout'\|'shutdown'\|'parent'` ⇒ **`'loop-guard'`（失控熔断）与 `{custom}` 被静默折叠成 `'parent'`**（谎报"父级联"）；且兜底值返回 `'parent'`，与该函数自己 JSDoc 写的"缺省时为 `'user'`"**矛盾**。 |

**净后果**：生产路径上 `CancelledError.reason` 几乎恒为 `'parent'`——用户中断、超时、关机、失控熔断
全都被报成"父令牌级联"，而这正是 `CancelReason` 联合类型存在的理由。

**修法（已实施）**：① `toAbortSignal()` 把结构化原因一起过桥（未取消时兜底 `'user'`）；
② `reasonOf()` 认全五类字符串原因 + `{ custom }` 对象，兜底按文档取 `'user'`。

**判据（本机离线）**：

- 新增 `tests/unit/cancellableModelReason.test.ts` 4 例（五类原因 / `{custom}` / 无原因兜底 / 畸形输入不抛错）；
- `tests/unit/loopCancellation.test.ts` 增 1 例：`toAbortSignal()` 在"未取消即注册"与"已取消"两条路径上都必须带原因；
- `tests/unit/cancelPropagation.test.ts`（原先对原因**零断言**）新增 `childAbortReasons()` 观测，
  并在工作流 / 目标循环 / 子代理三条**真实路径**上断言 `=== ['user']`；
- 端到端探针（临时，未入库）：`token.cancel(x)` → `toAbortSignal()` → `reasonOf()` 对
  `user / timeout / shutdown / loop-guard / {custom}` **全部保真**。

**仍未做（如实登记）**：`child()`/`children` 这条父子令牌树在生产路径无调用者（仅测试），
故"子令牌集合只在 cancel 时清空、无 disposable"目前**不构成实际泄漏**；若将来接入生产，
需要同时补 dispose 语义。

### 8.5 ✅ 已如实标注（2026-10-03 第六轮 G5）：安全面三处「声明强于实现」——**能力边界未变，只让声明与实现一致**

> 本组是外部调研（Windows 隔离专题）读码 + **我逐条复核**得到的事实。它们不是"待修 bug"而是
> **当前真实能力边界**——写进威胁模型与文档时必须按此表述，不得声称已隔离。

| #   | 事实                                                                                                                                                                                                                             | 复核状态  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | 默认沙箱档是 `policy`（`appServerBase.ts:245` 的 `file.sandbox ?? 'policy'`），即**纯 TS 黑名单 + 路径白名单**，无内核强制                                                                                                       | ✅ 已复核 |
| 2   | Windows「OS 级」后端调 `CreateRestrictedToken(..., 0, null, 0, null, 0, null, ...)`——**三个 restricting-SID 计数参数全 0** ⇒ 无文件/网络拒绝语义（只删特权 + Job Object 限额，且未换桌面、未设 UILIMIT）                         | ✅ 已复核 |
| 3   | `networkEgressGuard` **只包 `globalThis.fetch`** ⇒ shell 子进程（`curl`/`certutil`/原生 socket）完全绕过；记忆/召回类工具被归入 `file` 信任档（阈值 2），比一次性 `external`（阈值 1）**更宽松**，而记忆是**跨会话持久**投毒载体 | ✅ 已复核 |

**结论（可引用口径）**：在不付费、支持 Windows 的前提下，本仓库**当前是 L2（同用户进程内约束）**；
可达的 L3 只有 AppContainer + 宿主路径 DACL 或 WSL2 内 bubblewrap/landlock 两条路（详见调研报告 §3.5）。
**用户可感知的行为后果**：模型若被注入说服，`shell` 里的下载/外联命令在本机**不会**被 fetch 守卫拦住。

> **文档死链基线说明（2026-10-03 第五轮）**：基线由 89 处更新为 **96 处**（`testCountParser` 已成真并已收紧），曾新增的 7 条来自
> `docs/ARCHITECTURE_UPGRADE_2026-10.md` 的**升级提案里的待建路径**
> （`scripts/memoryLiftProbe.mjs`、`tests/unit/{eventPersisterAppend,memoryTrustBoundary,subagentWriteGate,toolSchedulerReadyOrder,testCountParser,genAiSemconvConformance}.test.ts`）。
> 它们是有意引用（提案的判据落点），按 `docLinkCheck` 的既定流程 `--update` 纳入基线；
> **实现这些提案后应收紧基线**（`--update` 会同时清掉已存在的路径）。

### 8.6 ✅ 已修（2026-10-03 第六轮）：完成闸门把「零测试」判成「验证通过」（fail-open 漏洞）

**现象**：回合末验证闸门只看退出码；而"测试命令一条都没匹配到"在 Node 里**是成功退出** ⇒
"没跑任何测试"会被当成"验证通过"，正好落进本仓最忌讳的**假完成**形态。

**证据（本机复核）**：`node --test "dist/tests/unit/__nonexistent__*.test.js"` ⇒ 输出
`# tests 0 / # pass 0 / # fail 0` 且 **exit = 0**；而 `turnEndCompletionGate.ts:78` 的判据只有
`if (outcome.exitCode !== 0)`。本仓 `npm test` 正是 `npm run build && node --test "dist/tests/unit/*.test.js"`
⇒ 一旦 glob 落空（改名/构建产物缺失/路径漂移），闸门会给出"验证通过"。
外部佐证：pytest 把"没收集到测试"单列为 **exit 5**，Jest 需显式 `--passWithNoTests` —— 两个主流工具都刻意区分二者。

**修法（已实施）**：新增 `src/adapters/tool/verify/testCountParser.ts`（`TestCountParser`，识别
node-test / jest / vitest / pytest / go-test 五类汇总行）；闸门在 exit=0 时增补第二道判据——
**显式零测试证据 ⇒ 拦截**，以及**计数里有失败却以 0 退出 ⇒ 以计数为准拦截**。
判据刻意不过度 fail-closed：拿不到汇总行（日志被 `maxOutputBytes` 截断）或命令不是测试运行器
（如 `tsc --noEmit`）⇒ **不拦**（闸门是增强，不是环境检测器）。

**实施中踩到并修掉的真问题**：首版验证时"**9 个用例全过的真实输出也被判成零测试**"——根因是 node TAP
会**回显用例名**（`# Subtest: <名>` / `ok 1 - <名>`），而本仓测试名里恰好含 `no tests ran` /
`collected 0 items` / `No test files found` 字样 ⇒ 子串匹配命中了用例名。现已先剔除逐用例行的用例名回显
（node TAP / jest `✓✕` / pytest `PASSED|FAILED`）再判读，并补回归用例钉住该形态。
**这条值得记档：仪器不得把被测对象的名字当成自己的读数。**

**判据**：`tests/unit/testCountParser.test.ts`（12 例）+ `tests/unit/turnEndCompletionGate.test.ts`（新增 4 例）；
真实命令口径复核（临时探针）：空 glob ⇒ `zeroEvidence: true`；真跑 12 例 ⇒ `total=12 / zeroEvidence=false`。

## 9. 本板如何追加条目

1. 只追加「已复核事实」：命令 + 日期 + 结果；或「已确证缺陷」：定位（file:line）+ 复现逻辑 + 暂缓理由。
2. 推翻旧条目时**保留旧文并划掉**（~~~~），注明推翻依据——不许无声改写历史结论。
3. 与 `AGENTS.md` 分工：AGENTS.md 只放「不写就会重复踩坑」的环境事实与流程约束；本板放项目状态。

### 9.1 口径（**完整版在 [CODE_STANDARD.md](CODE_STANDARD.md) §11**）

本节只列最容易再犯的四条，细节与其余条款见 §11（`tests/unit/caliberSync.test.ts` 会交叉核对文档与门禁常量）：

1. **计数**：数行数用**逐文件 `(Get-Content $f).Count` 求和**，不用 `Measure-Object -Line`（后者少计空行；
   本机实测 `src` 99,799 vs 94,218）。对外规模数字必须带口径 + 范围 + 日期。
2. **评测**：任何"增益"必须过**两关**（配对 bootstrap 95% CI 不跨 0 **且** 留出折同向）；吞吐数字必须标注
   **文本长度与批量**（同一模型本机 26–30 texts/s，此前 180–320 复现不出）；缓存读 token **不与输入相加**。
3. **门禁**：判据钉**字面量**而非间接常量；新判据必须能对**已知坏输入**变红（正对照/仪器自证）；
   变异后判据仍绿时**先查变异是否落地**；耗时预算按**并发墙钟**或相对量，别用绝对秒数。
4. **基线**：冻结基线（死链/覆盖率）**只许收紧**；`--update` 仅用于**迁移类改动**并写明理由。
