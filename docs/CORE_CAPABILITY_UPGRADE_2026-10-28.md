# OmniHarness 核心能力再调研与升级方案（2026-10-28）

> **文档性质**：带日期快照。进度、门禁状态与"哪些已落地"只认
> [`PROJECT_BOARD.md`](PROJECT_BOARD.md)；本文回答的是「核心能力现在在哪、外部世界到哪、
> 下一步投哪里」。外部星标/跑分/榜单均为检索时点数字，**未在本机复现**，不得当作本项目能力。
>
> 调研口径：4 路只读代码审计（主循环与上下文 / 记忆与检索 / 工具与协议 / 模型与评测）
>
> - 2026 年 3–10 月一手论文与规范 + 本机可复跑的门禁与判据。所有"本仓证据"都带
>   `文件:行`，所有外部结论都带 URL；两者都不拿"感觉"当证据。

---

## 0. TL;DR（先给结论）

1. **骨架不需要推倒**。OmniHarness 的七个子系统（主循环 / 模型接入 / 工具 / 记忆与上下文 /
   安全 / 编排 / 扩展）全部有真实实现，且 MCP 已双栈支持 **2026-07-28**（无状态
   `server/discover`、`subscriptions/listen`、MRTR、CacheableResult），压缩器已有
   「结构化摘要 + 确定性工具台账 + 前缀指纹游标 + 轮对齐」——这几项在 2026 年的开源
   harness 里属于第一梯队，不是补课项。
2. **真正的短板是"最后一公里的静默失效"**，不是缺功能：
   - 压缩摘要失败时把 7 字占位 `[历史已省略]` 当正式摘要写进游标并长期复用
     （`compactionSummarizer.ts:86-95` + `contextCompactor.ts:422-431`）；
   - 记忆写入被共振黏附吞掉却回 `stored:true`（`resonantFieldEngine.ts:134-164`）；
   - 开场 primer 的 fallback 不过滤 `expiresAt`，把已替代的旧值灌回
     （`sessionInjector.ts:222-231`）；
   - 蒸馏游标是单实例全局量，短会话完全不蒸馏（`memoryExtractor.ts:58,87,161`）；
   - 完成闸门以 `changedCount===0` 跳过，而 shell 改文件会让 tracker `invalidate()`
     把计数清成 0（`turnRunner.ts:549` + `turnDiffHooks.ts:103-106`）。
     这些缺陷共同的特征是：**不报错、不告警、指标看起来正常**，但长会话会失忆、记忆会记错。
3. **外部研究给出的方向不是"加机器"，而是"把判断做对"**：
   - harness 与模型的配对能把同一模型的解决率拉开 **44 个百分点**，且失败模式随配对变化
     （`arXiv:2610.32131`）——所以不能拿单模型单 harness 的成绩外推；
   - 压缩的关键不是"压不压"，而是**何时压、保留什么工作状态、压完怎么继续**
     （`arXiv:2610.02163`）；固定 80% 阈值只是启发式；
   - 验证-修复回环在验证器与修复器都有噪声时，**继续修会破坏本来正确的产物**，
     停止规则要基于"真实边际增益"而不是轮数（`arXiv:2607.17641`）；
   - 长期记忆的失败不只在"召回"，更在 **capture 不完整、recall 不全、unsafe deletion**
     （`arXiv:2610.03020`）。
4. **本轮已落地 6 项正确性修复**（§6，全部有离线判据）：压缩降级不污染游标、完成闸门识别
   "变更不可知"、primer 过滤过期事实、蒸馏游标按会话分桶、`recall` 保留 trust/expiresAt、
   记忆值冲突落盘并让旧值失效。另有 1 项（`stored:true` 谎报）在同一批收口。
5. **下一步按 U0→U3 四级推进**（§5）：先把"证据层"补起来（评测统计功效、流完整性、
   推理签名、缓存写入成本、JSON 修复），再做"自适应层"（压缩策略、验证停止、工具重试、
   模型能力探针），最后才是平台化（会话树 / steering / MCP 工具发现 / workflow 隔离）。
   在证据层完成前，**不引用任何"能力提升 X%"的数字**。

---

## 1. 方法与可复跑基线

### 1.1 本机基线（2026-10-28 实测）

| 项                        | 命令                                    | 结果                                      |
| ------------------------- | --------------------------------------- | ----------------------------------------- |
| 编码标准（服务端 + 前端） | `node scripts/check.mjs --strict`       | 1278 个服务端 TS + 190 个前端文件，零违规 |
| 服务端类型                | `npx tsc --noEmit`                      | 零错误                                    |
| 前端类型                  | `npx tsc -p web/tsconfig.json --noEmit` | 零错误                                    |
| 本轮新增/修改判据         | `vitest run --project node`（5 文件）   | 18/18 通过                                |
| 记忆/压缩回归             | 14 个相关文件                           | 107/107 通过                              |
| 记忆冲突批                | 5 个相关文件                            | 25/25 通过                                |

> 说明：本机 vitest 需要 spawn 子进程（esbuild service）；受限沙箱下会 `EPERM`。
> 这不是测试失败，换普通用户会话即可（与 `BLOCKERS_2026-10-25.md` 的口径一致）。

### 1.2 代码审计的分工与边界

四路只读审计各自回答"这条链真实怎么跑、哪里会静默坏"，不评价代码风格：

- **主循环 + 上下文**：`agent.ts` / `turnRunner.ts` / `stepRunner.ts` / `stepContextBuilder.ts` /
  `contextCompactor.ts` / `compactionComposer.ts` / `prefixStability.ts`。
- **记忆 + 检索**：`adapters/memory/**`、`core/sessionInjector.ts`、`search/**`、
  `tools/probes/*`、`memory*` 判据。
- **工具 + 协议**：`toolGate.ts` / `stepToolExecutor.ts` / `toolExposurePlanner.ts` /
  `subagent/**`、`mcp/**` / `a2a/**` / `acp/**` / `agui/**`。
- **模型 + 评测**：`adapters/model/**`、`eval/**`、`tools/eval/**`、`eval-data/**`。

审计的共同结论：**机制密度很高，但"机制是否真的在生效路径上"缺少交叉验证**。
典型例子是记忆探针直连 `FileLongTermMemory`，而生产端口是 `ResonantFieldEngine` 封包——
于是文档里的 80%/100% 命中率与线上路径无关（§4.3）。

---

## 2. 现状：七个子系统逐项对照

> 对照基准采用 2026 年 7 月的 11 个生产 harness 源码研究
> （[Harness Engineering, arXiv:2609.00006](https://arxiv.org/abs/2609.00006)）给出的
> 七子系统分解：Agent Loop / LLM Integration / Tools & Actions / Memory & Context /
> Safety & Permissions / Orchestration / Extensibility，外加 Interface Layer 与 Session Substrate。

| 子系统                   | OmniHarness 的实现（证据）                                                                                                                                                                                                                         | 成熟度自评                  | 与 2026 开源 SOTA 的差距                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent Loop**           | 事件溯源 + 每步投影；读类并行（有界池）、写类屏障、model-order 提交（`core/loop/toolScheduler.ts:79-145`）；LoopGuard 同调用重复/循环/墙钟（`core/loop/loopGuard.ts`）；软/硬 token 预算与步数预算；取消信号下传（`stepToolExecutor.ts:116-122`）  | L3（有大量真机判据）        | 基本对齐；缺**会话树/fork** 与**回合中 steering**                                                                                                   |
| **LLM Integration**      | 6 个适配器（mock / OpenAI Chat / Anthropic / Responses / llama.cpp-Ollama / Gemini）；五路 SSE；重试 3 次指数退避 + Retry-After；熔断；reasoning 档位五路映射；Anthropic cache_control；usage 含 cached（`adapters/model/*`）                      | L3                          | 缺 **thinking signature / thoughtSignature 回传**、**流截断判定**、**cache_creation 成本**、**JSON 修复**、`tool_choice`/`parallel_tool_calls` 契约 |
| **Tools & Actions**      | 31–33 个内置工具（条件注册，`configToolRegistry.ts:547-624`）；暴露策略 off/plan（BM25 + 类别，默认 plan）；大输出外溢 + 读回指引（`toolResultSpiller.ts:104-119`）；资源域闸（`core/toolResourceGate.ts`）；配对不变量（`stepToolExecutor` 类头） | L3                          | 缺**工具级重试/幂等**；MCP 桥接工具绕过 planner/ToolIndex；递归入口 `run_plan` 未在子代剔除；无统一工具超时                                         |
| **Memory & Context**     | BM25 + 可选语义 + RRF；压缩：8 段结构化摘要 + 确定性工具台账 + 前缀指纹游标 + 轮对齐 + 增量 seed（`context/contextCompactor.ts`）；长期记忆：文件落盘 + 时间衰减 + 冲突替代 + 共振场封包                                                           | L2–L3（机制强，正确性有洞） | **5 个已复现的正确性缺陷**（§4.3）；无记忆 token 预算/GC；无任务级增益判据                                                                          |
| **Safety & Permissions** | 审批六档；policy/restricted/passthrough/OS 级沙箱（不可用 fail-closed）；WorkspaceGuard；NetworkEgressGuard；来源追踪 SEC-03；插件权限白名单（`core/toolGate.ts`、`security/*`）                                                                   | L2（OS 级 L3 未验证）       | Windows 真 L3 隔离仍缺；语法感知的命令权限（AST 级）未做                                                                                            |
| **Orchestration**        | 子代理：深度 2 / 并发 16 / git worktree 隔离 / patch 回收（`subagentOrchestrator.ts:65-177`）；工作流 Kahn 分层 + 并发 4 + 失败下游 blocked + 规格哈希 resume；目标循环 10 轮 + 机械证据 + YES/NO                                                  | L2                          | 子代理步数默认 0=不限、无 token/费用聚合；workflow 共享主工作区、无回滚/超时重试；`run_plan` 递归口未收                                             |
| **Extensibility**        | Skills（SKILL.md + BM25 + 去重/预算/冲突/资源互斥）；MCP 双栈（2026-07-28 + 2025-06-18）；A2A 1.0；ACP v1；AG-UI 21 类事件；插件目录 + 权限白名单                                                                                                  | L2–L3                       | ACP 能力声明 > 实现（MCP http/sse、image/audio、cursor）；AG-UI 声明 STEP 事件但不产生；技能缺 lazy body 与信任分级                                 |
| **Interface**            | Web 工作台（React 19 + Vite）、CLI（27 子命令）、JSON-RPC stdio、SDK、Electron 桌面、AG-UI/ACP/A2A 端点                                                                                                                                            | L3                          | 平台化缺口：**会话 import/export、跨 harness 迁移、marketplace 信任链**                                                                             |

**一句话**：这是一个"机制密度高、验证密度不均"的 harness。它的差异化资产是
**fail-closed + 审计 + 离线可跑**；它的风险不是"少一个功能"，而是"某个机制在真实路径上
静默失效，而文档还在引用旧数字"。

---

## 3. 外部图景：开源社区与科学知识库

### 3.1 开源社区：2026 年 harness 已完成"从工具到平台"的转向

[Harness Engineering（arXiv:2609.00006）](https://arxiv.org/abs/2609.00006) 对 11 个生产
harness（Claude Code、Codex CLI、Gemini CLI、Mistral Vibe、OpenHands、Aider、
Mini-SWE-Agent、Hermes、Pi、OpenCode、OpenClaw）做了源码级解剖，另有 Omnigent 作为
meta-harness 对照。对本项目最有用的六条事实：

1. **没有运行时 import 通用 agent 框架**（LangChain/LangGraph/AutoGen 等），
   也**没有用向量嵌入检索代码**——生产系统靠手写异步循环 + 确定性检索
   （ripgrep、tree-sitter、glob、AGENTS.md）。这与本仓"BM25 为主、语义可选"的路线一致，
   说明"再上一个向量库"不是能力升级。
2. **SKILL.md 技能（9/11）已超过 MCP（8/11）成为第一扩展面**；ACP 在 6 个系统出现，
   并新增"harness hosting"角色（OpenHands 可把 Claude Code / Codex / Gemini CLI 当后端）。
   本仓三者都有，但技能的**信任分级/注册表/懒加载**仍弱。
3. **平台化**：harness 变成可 import 的 SDK、跨厂商 session 导入、插件/技能 marketplace、
   MDM 治理、"agent as a model" 网关。本仓有 SDK 与协议端点，缺**导入/导出与信任链**。
4. **meta-harness 出现**：Omnigent 把多个 harness 当可替换组件编排。对本仓的启示不是
   "再包一层"，而是**把自身能力做成可被编排的稳定契约**（已有 ports/SDK，方向正确）。
5. **收敛变成互相模仿**：Codex 采用 Claude Code 的 hook 词汇并导入其 session；
   OpenHands 读 Claude Code 插件格式。说明 **hook/skill/session 格式的兼容性**是真实采用门槛。
6. **最小 harness 只要 ~100 行**：能力差距不在"循环"，在安全、恢复、成本、扩展。
   本仓的护城河应继续押在**审计/治理/失败恢复**，而不是"更多工具"。

另一份社区整理的 [agentic-harness-patterns-skill](https://github.com/keli-wen/agentic-harness-patterns-skill)
把 Claude Code 的模式压成六层（Memory / Skills / Tools & Safety / Context Engineering /
Multi-agent / Lifecycle），其中三条"gotcha"直接命中本仓：

- **并发分类应按调用而非按工具**：同一工具对不同入参可能安全/不安全。本仓
  `ToolScheduler` 是**按工具名静态分类**（`toolScheduler.ts:157-163`），对 MCP/插件工具
  只能保守串行；这是"安全优先"的合理取舍，但要写进边界，别声称"并行调度"覆盖所有工具。
- **上下文构建器 memoize 后必须手动失效**：漏一个失效点，模型整段会话看旧数据。
- **记忆索引有硬上限，超限静默截断**：本仓目前无 GC/上限，属于"不会静默截断，但会无限长"。

[awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering)
可作为后续生态扫描的入口清单（tools / patterns / evals / memory / MCP / permissions /
observability / orchestration），本文不重复摘录。

### 3.2 科学知识库：六条可操作的机制结论

#### ① Harness 与模型的配对效应大于大多数单项优化

[Pairing Matters（arXiv:2610.32131）](https://arxiv.org/abs/2610.32131) 做了 6 个开源
harness × 3 个轻量模型 × 100 个 SWE-bench Verified 任务的全因子实验（1,800 次运行）：

- 同一模型换 harness，解决率最大差 **44 个百分点**；harness 排名随模型变化；
- 失败模式随配对变化（一个 harness 会放大/削弱/改写模型的主导失败倾向）；
- 即使都是"模型驱动循环"的 harness，**每个解决任务的计费 token 相差 20 倍以上**。

**对本仓的含义**：只有 DeepSeek 一家真机基线（`BLOCKERS` §3）时，不能把 pass@1 当
"harness 能力"对外；需要**模型能力探针 + 配对矩阵**（哪怕只有 2 个模型/端点），
并把失败模式按配对拆开记录。否则"换模型后变差"会被误判成"harness 退化"。

#### ② 压缩的关键是"何时压、保留什么、压完怎么继续"

[AutoCompact（arXiv:2610.02163）](https://arxiv.org/abs/2610.02163) 把"何时压缩、
保留什么工作状态、压缩后如何继续"训练进策略，在 SWE-bench Verified / SWE-PolyBench
上比基座绝对提升 9.2% / 5.0%，且在 256K 与 16K 窗口下都成立。
[Parallel Compaction（arXiv:2605.23296）](https://arxiv.org/abs/2605.23296) 指出顺序
摘要会阻塞推理数十秒、摘要量不可控、跨 run 保留知识波动大；并行分块压缩能在匹配
decode 量时降低端到端墙钟。

**对本仓的含义**：固定 `0.8×window` 触发 + 8 段摘要 + 工具台账是**正确的起点**，但：

- 摘要失败必须**不写游标**（本轮已修），否则一次 429 = 永久失忆；
- 单条超大消息必须**可裁**（当前只裁 tool >24k，见 §4.3）；
- 丢弃 tail 必须**按整轮**（当前 `compactionComposer.dropOldest` 可丢出
  "user + 整轮工具结果" 4 条，见 §4.3）；
- 下一步应做**压缩后状态审计**（目标/决策/已改文件/未完成待办是否仍在），
  而不是继续加摘要模板。

#### ③ 上下文退化是"主动重建"问题，不是"多留一点"问题

[ARC（ACL 2026 Findings）](https://aclanthology.org/2026.findings-acl.930/) 把上下文管理
形式化为**主动、反思驱动的内部状态维护**：检测到错位/退化时主动重组工作上下文，
在 BrowseComp-ZH 上比被动压缩最高提升 11 个绝对点。Anthropic 的 context engineering
文章也把 "context rot" 作为长窗口的默认现象（经上述源码研究转引）。

**对本仓的含义**：`longHorizonProtocol` 的 F1–F7 结构化进度是同一方向，但目前
`features.passes` **没有写入点**（`markFeature` 零调用），primer 恒为 0/N——"结构化进度"
在真实回合里没有闭环。这比再加一个摘要模板更值得修。

#### ④ 验证-修复回环需要"停止规则"，不是"多修几轮"

[VRR-Stop（arXiv:2607.17641）](https://arxiv.org/abs/2607.17641)：当验证器与修复器都有
噪声时，修复会破坏本来正确的计划，而"报告接受率"上升、真实有效率下降。论文用四参数
噪声模型 + 信念过滤估计"真实边际增益"，只在符号可识别时继续修；验证器区分度趋近 0 时
退化为"足够验证边际才替换"的无估计兜底。GSM8K 压力设置下，最终真实有效率比固定 5 轮
修复高 60.6 个百分点，平均只花 0.72 轮修复。

**对本仓的含义**：当前完成闸门"每回合至多一次，二次宣告直接 `unverified` 放行"是
**有界但粗糙**的停止规则；它避免了死循环，却没有"修复是否真的让事情变好"的判断。
下一步应做**验证签名 + 无进展检测**（同一失败签名重复出现 ⇒ 停止并如实报 `failed`，
而不是让模型继续烧步数），这与本仓"fail-closed + 诚实"的价值观一致。

#### ⑤ 长期记忆的失败在 capture / recall / deletion 三段

[DyadMem（arXiv:2610.03020）](https://arxiv.org/abs/2610.03020)：3,065 个 episode、
50,961 个 session、61,210 个 QA；20 个模型上 Gold-Memory QA 很强，但 **Full-Pipeline QA
急剧下降**；定量结果显示 frontier 模型仍有 **capture recall 低、recall 不全、unsafe
deletion**。论文还提出 User-conditioned Relational Agent Memory（URAM）——不只记"用户是
什么"，还记"这个 agent 应如何与该用户协作"。

**对本仓的含义**：

- 现有"primer 开 80%/100% hit@5"是**机制级**且跑在非生产端口上，不能当任务增益；
- 冲突消解（supersede）在 fallback 注入处被绕过（本轮已修）、写入被黏附吞掉（本轮已修）、
  短会话不蒸馏（本轮已修）——这三条正是 capture/recall 的真实漏洞；
- URAM 是 R&D 候选，不应在正确性修完前启动。

#### ⑥ 失败模式要按"配对/任务类型"分层，不能只报一个 pass@1

[Where Do AI Coding Agents Fail?（MSR 2026, arXiv:2601.15195）](https://arxiv.org/abs/2601.15195)
分析 33k 个 agent-authored PR：文档/CI/构建类任务合并率最高，性能与 bug-fix 最差；
未合并 PR 往往改动更大、触碰更多文件、CI 不通过；质性分析还发现"缺乏有意义的 reviewer
互动、重复 PR、不想要的功能、agent 目标错位"等社会技术因素。

**对本仓的含义**：20 个自建长任务里 16 个是"3 函数 + README"同模板（§4.4），
任务类型维度几乎没覆盖；报告只有 4 个失败桶，且没有 CI/成本/缓存/数据哈希。
这会让"harness 改动是否真的更好"不可判——正是 `G1` 当初要解决的问题，只是现在
问题转移到了**评测的代表性与统计功效**。

### 3.3 协议标准：本仓已经追上，下一步是"一致性"而非"追版本"

[MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
是一次大修订：移除协议级 session / `Mcp-Session-Id`、移除 `initialize` 握手、引入
`server/discover`、`subscriptions/listen`、MRTR（`resultType: input_required`）、
移除 SSE resumability、`CacheableResult`（`ttlMs`/`cacheScope`）、
`tools/list` 确定性排序、`_meta` OTel 上下文等。

本仓已经实现双栈与上述大部分能力（`mcpProtocol.ts` 的 `PROTOCOL_VERSION_V2`、
`server/discover`、`subscriptions/listen`、`mcpCachePolicy.ts`、`mcpRequestContext.ts`、
`mcpTraceContext.ts`、`mcpInputRequiredService.ts`），并有 `mcp*V2` 判据。
**结论：MCP 不是当前短板**；短板在"声明 > 实现"的 ACP/AG-UI（§4.2），以及
"桥接工具绕过暴露规划器"。

[Agent Skills 规范](https://agentskills.io/specification) 明确：skill 是目录 +
`SKILL.md`（YAML frontmatter：`name`/`description`，可选 `license`/`compatibility`/
`metadata`/`allowed-tools`），支持 `scripts/`、`references/`、`assets/` 与
**progressive disclosure**。本仓 `skillMdCodec` 支持 frontmatter + 正文，但
"发现只读元数据、正文按需加载"的懒加载语义还未在注入路径落地（§4.2）。

---

## 4. 缺口矩阵（按"会不会静默坏"排序）

> 评级：**P0 = 数据正确性/安全，静默失效**；**P1 = 证据与可证伪性**；
> **P2 = 能力/体验**；**P3 = 减法与卫生**。人日是单人净投入（含判据）。

### 4.1 P0：已经确认、必须修的静默失效

| ID  | 缺口                                                                   | 证据（file:line）                                                               | 影响                                                  | 离线判据                                                        | 状态              |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- | ----------------- |
| C1  | 摘要失败把 `[历史已省略]` 写进压缩游标并长期复用                       | `compactionSummarizer.ts:86-95`；`contextCompactor.ts:422-431`                  | 一次 429 ⇒ 后续每步都复用 7 字占位，长会话永久失忆    | 必抛模型 + `force` ⇒ `state===undefined`、`degraded===true`     | **✅ 本轮已修**   |
| C2  | 完成闸门以 `changedCount===0` 跳过；shell 写文件会 `invalidate()` 清 0 | `turnRunner.ts:544-553`；`turnDiffHooks.ts:103-106`；`turnDiffTracker.ts:88-92` | `node`/重定向/脚本改过文件后，宣布完成**从不跑验证**  | tracker `isValid:false` + count 0 ⇒ `gate.verify` 被调用        | **✅ 本轮已修**   |
| C3  | primer fallback 不过滤 `expiresAt`                                     | `sessionInjector.ts:222-231`                                                    | 已被 supersede 的旧值在每会话开场复活                 | `expiresAt=2020` + importance 5 ⇒ 不出现在 primer               | **✅ 本轮已修**   |
| C4  | 蒸馏游标是单实例全局量                                                 | `memoryExtractor.ts:58,87,161`；`memoryStackAssembler.ts:171-178`               | 短会话被长会话游标跳过，**完全不蒸馏且无日志**        | 同实例 A(5 事件) 后 B(2 事件) ⇒ 返回 1 而非 0                   | **✅ 本轮已修**   |
| C5  | 共振黏附吞掉同槽位新值，工具仍回 `stored:true`                         | `resonantFieldEngine.ts:134-164`；`rememberTool.ts:73-79`                       | 更正/新值永久丢失，recall 继续返回旧值                | 写 58217 → 58218 ⇒ base 2 条、旧值 `expiresAt`、recall 只回新值 | **✅ 本轮已修**   |
| C6  | `recall` 工具丢弃 `trust`/`expiresAt`                                  | `recallTool.ts:60-64`                                                           | 模型看不到"这条记忆来自未验证工具输出"                | 输出 JSON 含 `"trust":"untrusted"`                              | **✅ 本轮已修**   |
| C7  | 单条超大 user/assistant 消息不裁（仅 tool >24k 裁）                    | `contextShapers.ts:98-116`；`compactionComposer.ts:37-42`                       | 1MB 消息 ⇒ 恒超窗 ⇒ 400 ⇒ 强压无效 ⇒ 回合硬崩         | 1MB user ⇒ 估算 ≤ 预算或带截断标记                              | **✅ 第二批已修** |
| C8  | 丢弃 tail 非轮对齐，可一次丢 "user + 整轮工具结果" 4 条                | `compactionComposer.ts:37-42`                                                   | 丢掉最需要的当前工具结果/最新用户指令                 | dropped 按整轮计 + 保留最新非 orphan 消息                       | **✅ 第二批已修** |
| C9  | 同一步 assistant 文本在 tool_calls 分支被丢                            | `stepRunner.ts:131-147`                                                         | 模型的计划文字不进历史/摘要，压缩后"为什么这么做"消失 | text+toolCalls ⇒ 事件流含该文本                                 | **✅ 第二批已修** |
| C10 | 压缩游标指纹忽略 toolCalls/args                                        | `contextCompactor.ts:715-744`                                                   | 只改参数不改文本时复用旧摘要                          | 只改 args ⇒ 指纹必须变                                          | **✅ 第二批已修** |

### 4.2 P1：证据、统计与"声明=实现"

| ID    | 缺口                                                                     | 证据                                                                         | 影响                                         | 判据                                                           | 人日        |
| ----- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- | ----------- |
| ✅ E1 | 流截断被当正常完成：EOF 残余缓冲直接 emit，`finishReason` 可能 undefined | `sseParser.ts:60-63`；`openAiCompatibleModel.ts:170`                         | 半截工具参数被执行；重试重复已发前缀         | 无 `finish_reason`/`[DONE]` 的 SSE 必须报错/标 incomplete      | 已修        |
| E2    | Anthropic thinking signature / Gemini thoughtSignature 不回传            | `anthropicModel.ts:580-582`；`geminiModel.ts:515-534`                        | 多轮思考 + 工具丢上下文/降质（协议要求回传） | mock SSE 注入 signature ⇒ 下轮请求原样回传                     | 4           |
| ✅ E3 | `cache_creation` 折进 promptTokens 按普通输入计价                        | `anthropicModel.ts:491-495`；`costBudget.ts:127-130`                         | 缓存写入溢价漏记，硬预算低估                 | mock usage input=100/create=1000 ⇒ 成本含写入价                | 已修        |
| ✅ E4 | 非法工具参数回退 `{}`，无 schema 校验/修复重试                           | `toolArgumentParser.ts:22-31`                                                | 空参数执行，静默错操作                       | 喂 `{"a":1` ⇒ 修复或报错，不得 `{}`                            | 已修        |
| ◐ E5  | 评测无 CI/MDE/功效、k 默认 1、A/B 串行                                   | `abMetrics.ts:33-47`；`harnessAb.mjs`                                        | 2–10pp 差异不可判显著，时间漂移混淆          | 已知 10pp 效应的合成 run ⇒ 报告含 bootstrap CI/MDE 且 A/B 交错 | CI/MDE 已加 |
| E6    | 任务集 20 个、16 个同模板、无 held-out/digest/外部集                     | `longTaskCatalog.ts:14-15`；`long-tasks/README.md`                           | 分数不可外推，公开任务有污染风险             | 任务元数据（类别/多文件比例/n-gram 重叠）+ 数据哈希            | 10          |
| E7    | 记忆探针跑非生产端口；生产封包自评 L0 零增益                             | `memoryLiftProbe.mjs:109`；`longMemEval.mjs`；`resonantFieldEngine.ts:17-18` | 80%/100% 与线上无关                          | 同事实集两端口 recall 集合/排序对比                            | 2           |
| ✅ E8 | `OMNI_MEMORY_FORGETTING=1` 在生产端口是空开关                            | `fileLongTermMemory.ts:178-207` 被 `resonantFieldEngine.ts:331-350` 覆盖     | 打开遗忘无效果，指标不可归因                 | 开 env 经生产端口 recall，断言 `recallCount` 变化              | 已修        |
| E9    | ACP 能力声明 > 实现（mcp http/sse、image/audio、cursor）                 | `acpServer.ts:263-269`；`acpProtocol.ts:309-315`                             | 客户端按声明调用会失败                       | initialize 能力矩阵逐项断言                                    | 3           |
| E10   | AG-UI `STEP_STARTED/FINISHED` 声明但不产生；输入 state 被忽略            | `aguiProtocol.ts:72-86`；`aguiHttpServer.ts:188-189`                         | 事件子集可用，状态恢复缺失                   | 跑一步断言事件序列                                             | 3           |

### 4.3 P2：能力与体验

| ID    | 缺口                                                                             | 证据                                                      | 影响                                          | 人日                           |
| ----- | -------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------- | ------------------------------ |
| ✅ A1 | `run_plan` 未从子代工具视图剔除，可递归派生                                      | `subagentRunner.ts:26-30`；`runPlanTool.ts:66-86`         | `maxDepth` 形同虚设，成本/安全双风险          | 已修                           |
| A2    | MCP 桥接工具 `server__tool` 未登记，绕过 planner/ToolIndex；schema 无 token 上限 | `toolExposurePlanner.ts:456-477`；`cliBuildConfig.ts:436` | 工具越多每步越慢越贵，暴露规划器收益被抵消    | 2                              |
| A3    | 工具级重试缺失（只有模型层重试）                                                 | `stepToolExecutor.ts:218-230`；`mcpGateway.ts:331-358`    | 瞬时失败烧整步；副作用工具不敢重试            | 3                              |
| ◐ A4  | 子代理步数默认 0=不限，无 token/费用聚合                                         | `subagentTypes.ts:26`                                     | 不收敛子代可烧无限 token，父级看不到          | 用量聚合已修；0=不限是既定策略 |
| A5    | workflow 共享主工作区、无回滚/超时/重试、resume 不保证幂等                       | `workflowRunner.ts:571-624,545-561,177-179`               | 失败留半成品；挂起拖住整层；resume 重复副作用 | 5                              |
| ✅ A6 | A2A 同 `messageId` 重发会重建任务并重跑                                          | `a2aV1Methods.ts:99,351`；`a2aTaskStore.ts:90-98`         | 重试导致重复副作用                            | 已修                           |
| A7    | 技能发现索引全文，正文懒加载未落地；无信任分级/注册表                            | `skillRetriever.ts:61-71`；`skillActivationPlanner.ts`    | 发现成本随技能增长；第三方技能无信任档        | 4                              |
| A8    | 无会话 fork/树、无回合中 steering                                                | `grep forkSession/branchSession/steer` 零命中             | 用户不能"从这里分叉试另一条路"，长任务交互弱  | 6–8                            |
| A9    | 代码检索只测文件级，无符号级 hit@K                                               | `recallHitrate.mjs:41`；`recallKnobs.ts:52-58`            | 符号级劣化不可见                              | 2                              |
| A10   | 记忆无 token 预算/GC；多进程写同一 jsonl 可能互相覆盖（未验证）                  | `fileLongTermMemory.ts:375-388`；`recallKnobs.ts:52-58`   | 注入成本不可控；并发写丢数据                  | 3                              |

### 4.4 P3：减法与卫生

| ID  | 项                                                      | 证据                                                             | 建议                                                                                            |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| S1  | 共振场是 L0"与词袋冗余、实测零增益"，却默认封包生产记忆 | `resonantFieldEngine.ts:17-18`；`memoryStackAssembler.ts:49-58`  | 先修正确性（本轮），再用**同事实集两端口 A/B** 决定默认档；无增益则默认关，探针与生产走同一端口 |
| S2  | 前端 49 个函数 >80 行、2 个文件 >810 行（冻结基线）     | `scripts/checkFuncBaseline.json`；`checkFileLengthBaseline.json` | 按"改动即拆"清偿，不搞一次性大重构                                                              |
| S3  | 评测任务同模板                                          | `longTaskCatalog.ts:14-15`                                       | 扩到 40+，加入多文件重构、调试、上下文密集、误导性错误四类                                      |
| S4  | 文档历史数字被当现状                                    | 本文 §1.1 基线                                                   | 只认看板；带日期报告一律标快照                                                                  |

---

## 5. 升级路线图（U0–U3）

> 排序原则：**先让失败可见 → 再让判断可证 → 再加自适应 → 最后做平台化**。
> 每一级都给"本机可跑、离线、无付费 key"的判据；没有判据的提案不进入本表。

### U0（本轮，已完成）：正确性收口

| 项   | 内容                                                | 验收                                                      |
| ---- | --------------------------------------------------- | --------------------------------------------------------- |
| U0-1 | 压缩降级不写游标                                    | `degraded===true`、`state===undefined`；恢复后能重新摘要  |
| U0-2 | 完成闸门识别"变更不可知"                            | `isValid:false` + count 0 ⇒ 闸门被调用；有效 + 0 ⇒ 不白跑 |
| U0-3 | primer 过滤过期事实                                 | 过期高重要度事实不出现，有效事实仍在                      |
| U0-4 | 蒸馏游标按会话分桶                                  | A 长会话后 B 短会话仍蒸馏；游标 Map 有上限                |
| U0-5 | 记忆值冲突落盘 + 旧值失效                           | 58217→58218 落盘 2 条、旧值 expired、recall 只回新值      |
| U0-6 | `recall` 保留 trust/expiresAt；重复 remember 不谎报 | JSON 含 trust；重复写回 `stored:false, duplicateOf`       |

**边界**：这 6 项是**正确性修复**，不是能力提升；不产生任何 pass@1 增益声明。

### U1（建议 2–3 周）：证据层——让"是否更好"可证伪

1. **评测统计**（E5/E6）：`AbMetrics` 增加 bootstrap CI 与 MDE；A/B 交错执行；
   k 默认 ≥3；报告加 git SHA、任务集 digest、模型/温度/预算/缓存字段。
2. **流完整性**（E1）：SSE 必须在 `finish_reason`/`[DONE]` 缺失时报错或标 `incomplete`；
   retry 不得重复已发前缀。
3. **推理状态回传**（E2）与**缓存写入成本**（E3）：mock SSE 夹具可离线验。
4. **工具参数修复**（E4）：JSON 解析失败先做一次确定性修复（补引号/括号），
   再失败则报错给模型，不静默 `{}`。
5. **记忆探针搬到生产端口**（E7/E8）：同事实集两端口对比；`OMNI_MEMORY_FORGETTING`
   要么在生产端口生效，要么删掉这个开关（不能留空开关）。

**验收**：上述每项都有离线判据；`npm run test:fast` + `web:test` + typed 门禁全绿；
报告里出现的每个数字都能用一条命令复跑。

### U2（建议 3–5 周）：自适应层——把"判断"做对

1. **压缩策略**（C7/C8/C10 + AutoCompact 启发）：
   - 单条消息上限 + 截断标记；
   - tail 丢弃按整轮，保最新非 orphan；
   - 压缩后**状态审计**：目标/决策/已改文件/验证命令/未完成待办是否仍在摘要或台账里；
   - 触发信号从"固定 80%"改为"预算 + 轮数 + 工具结果占比 + 重复率"的组合，
     **默认 shadow 只记录不改变行为**，有对照数据再翻默认。
2. **验证-修复停止规则**（VRR-Stop 简化）：记录失败签名（exit code + 归一化输出尾），
   同一签名重复出现即停止注入"再修"、如实报 `failed`；不同签名才允许下一轮。
   每回合仍至多 N 轮，N 可配。
3. **工具重试与幂等**（A3/A6）：只对声明 `idempotent` 的工具重试；
   A2A 按 `messageId` 去重。
4. **模型能力探针 + 配对矩阵**（§3.2①）：`doctor` 扩展为 `model probe`，
   探测 tool calling / 并行工具 / JSON schema / reasoning / 流式 usage / 缓存，
   产出 capability card；至少跑 2 个端点，报告按配对拆分失败模式。

**验收**：每项都有"关/开逐位等价"或"两关统计"判据；没有显著增益的项默认关。

### U3（建议 4–6 周）：平台化——把能力变成可组合契约

1. **会话树 / fork / steering**（A8）：fork 单层、子代不继承写权限；steering 走
   user 消息注入，不打断工具配对。
2. **MCP 工具纳入 planner/ToolIndex + schema token 上限**（A2）。
3. **子代理/workflow 预算与隔离**（A1/A4/A5）：`run_plan` 从子代剔除；
   子代理强制 token 预算与用量聚合；workflow 可选 worktree + 回滚。
4. **技能运行时**（A7）：发现只读元数据、正文懒加载、信任分级（bundled/user/plugin）。
5. **平台互操作**：session 导入/导出（Claude Code/Codex 格式的最小兼容）、
   hook 词汇兼容、marketplace 签名信任链。

**验收**：协议一致性套件 + 真机 e2e；任何"声明支持"的能力必须有对应判据，
否则从文档与能力矩阵里删掉。

---

## 6. 本轮落地明细（U0）

> 代码与判据同批提交；每项都先写"缺陷现场"，再写"修法"，最后写"判据"。
> 这里的数字只证明"判据通过"，不证明"能力提升"。

### 6.1 C1：压缩摘要降级不得污染游标

- **缺陷**：`CompactionSummarizer.summarize` 在模型失败/缺席时返回 `[历史已省略]`；
  `ContextCompactor.compact` 把它当正式摘要写进 `state`。下一步 `tryReuseState`
  前缀命中即零 LLM 复用 ⇒ 一次 429 让长会话永久失忆。
- **修法**：新增 `CompactionSummarizer.PLACEHOLDER` 与 `isUnusable()`；
  `compact()` 在摘要不可用时**不写 `state`**，返回 `degraded:true`，本次仍带兜底消息
  （请求不能炸）。
- **判据**：`tests/unit/contextCompactorDegraded.test.ts` 3 例——必抛模型 ⇒
  `compacted:true` + `degraded:true` + `state===undefined`；可用摘要 ⇒ `state` 正常；
  `isUnusable` 空串/占位/正常三态。

### 6.2 C2：完成闸门识别"变更不可知"

- **缺陷**：`completionDigest` 只在 `turnDiff.changedCount > 0` 时问 `turn-end` 闸门；
  但 shell 重定向/脚本会 `invalidate()`，而 `invalidate()` 把 `changedCount` 清成 0。
  于是 `node build.js` 改过文件后，宣布完成**从不跑验证**。
- **修法**：`TurnDiffTrackerPort` 增加可选 `isValid`；闸门条件改为
  "有变更 **或** 变更不可知"（`changedCount>0 || isValid===false`）。
- **判据**：`tests/unit/turnCompletionGate.test.ts` 新增 2 例——失效 tracker + count 0
  ⇒ `gate.verify` 被调用、回灌后再给一步；有效 tracker + count 0 ⇒ 不白跑验证。

### 6.3 C3：primer fallback 过滤过期事实

- **缺陷**：无召回命中时 fallback 直接 `all()` 按 importance 取 top-5，不过滤
  `expiresAt`；已被 supersede 的旧值在每会话开场复活。
- **修法**：两个分支共用 `injectable()`，按 `<= now` 口径过滤；`isExpired` 内联在
  `SessionInjector`（core 不反向依赖 adapters）。
- **判据**：`tests/unit/memoryPrimerExpiry.test.ts` 1 例——`expiresAt=2020` +
  importance 5 不出现，有效事实仍在。

### 6.4 C4：蒸馏游标按会话分桶

- **缺陷**：`MemoryExtractor.cursor` 是单实例状态，组合根只建一个实例；
  会话 A 处理 5 条后，新会话 B 只有 2 条 ⇒ `slice(5)` 为空，B 永远不蒸馏。
- **修法**：`Map<sessionId, cursor>`；事件数组变短（回卷/压缩）时按 0 重放，
  去重仍由阶段二负责；Map 上限 512，超出淘汰最早活跃会话（防缓慢泄漏）。
- **判据**：`memoryExtractor.test.ts` 新增 1 例——A(5 事件) 后 B(2 事件) ⇒
  返回 1（旧实现 0），store 2 条。

### 6.5 C5：记忆值冲突落盘 + 旧值失效

- **缺陷**：`ResonantFieldEngine.remember` 只要频谱共振 ≥0.75 就黏附（不写 base）；
  "端口 58217" → "端口 58218" 被当近重复吞掉，`RememberTool` 仍回 `stored:true`。
- **修法**：新增 `MemoryValueSlot`（归一化 + 数字/版本槽骨架）；引擎在黏附前检测
  "同槽位、不同取值"冲突，冲突则**落盘 + 旧值 `expiresAt` 失效**（不删除）；
  `RememberTool` 同步做冲突失效（覆盖 `resonantField.enabled:false` 的裸存储路径），
  并对完全重复返回 `stored:false, duplicateOf`。
- **判据**：`resonantField.test.ts` ⑧ + `longTermMemoryTools.test.ts` 2 例——
  58217→58218 落盘 2 条、旧值 expired、recall 只回新值；重复 remember 不谎报。

### 6.6 C6：`recall` 保留 trust / expiresAt

- **缺陷**：`recallTool` 映射命中时只留 topic/text/importance；`ToolOutputTrust` 把
  recall 输出按最严档处理，但模型看不到"这条来自未验证工具输出"。
- **修法**：payload 增加 `trust`/`expiresAt`（存在才带）。
- **判据**：`longTermMemoryTools.test.ts` 1 例——JSON 含 `"trust":"untrusted"` 与
  `"expiresAt":"2030-..."`。

### 6.7 验证命令与结果

```text
npx vitest run --project node tests/unit/memoryPrimerExpiry.test.ts \
  tests/unit/memoryExtractor.test.ts tests/unit/longTermMemoryTools.test.ts \
  tests/unit/turnCompletionGate.test.ts tests/unit/contextCompactorDegraded.test.ts
# 5 files / 18 tests passed

npx vitest run --project node <14 个记忆/压缩回归文件>
# 14 files / 107 tests passed

npx vitest run --project node <agent|turnRunner|stepRunner|sessionInjector|longHorizon|memory|context 前缀的 33 个文件>
# 33 files / 219 tests passed（扩展核心回归）

npx vitest run --project node tests/unit/resonantField.test.ts \
  tests/unit/longTermMemoryTools.test.ts tests/unit/resonantFieldDefault.test.ts \
  tests/unit/memoryWriteQuality.test.ts tests/unit/memoryPrimerExpiry.test.ts
# 5 files / 25 tests passed

npx tsc --noEmit          # 零错误
node scripts/check.mjs --strict   # 1278 + 190 文件零违规
```

---

### 6.8 第二批（同日续）：上下文完整性 / 流与成本 / 工具韧性

> 这一批的目标是"把静默错误变成显式失败"，仍不产生能力增益声明。

| 项                  | 修法                                                                                                                                                                            | 判据                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **C7 超大消息**     | `ContextShapers` 增加 `maxMessageChars`（默认 48k，约 12k token）：user/assistant 超限时保留头 60% + 尾 30%，中段替换为可检索的裁剪标记；确定性、跨步稳定                       | `contextShapers.test.ts`：200k 消息被裁到 <2k、系统提示不动、重复应用逐字节一致                               |
| **C8 按轮丢弃**     | `CompactionComposer` 新增 `dropOldestTurn`：以下一个 user 消息为轮边界，整轮丢弃；无下一轮时只保留最后一条                                                                      | `compactionTurnDrop.test.ts`：丢弃 5 条整轮，旧轮 assistant/tool 不残留，latest 保留                          |
| **C9 文本+工具**    | `StepRunner` 在 toolCalls 分支先记录 `output.text`（投影层已支持 text → tool_calls 相邻），再做工具执行                                                                         | `stepAssistantText.test.ts`：事件序 text < tool_call；下一轮请求同时含文本与 toolCalls                        |
| **C10 指纹**        | `headFingerprint` 把 `JSON.stringify(toolCalls)` 纳入片段与缓存比较                                                                                                             | `compactorFingerprint.test.ts`：只改 args、甚至原地改 args，指纹都必须变                                      |
| **E1 流完整性**     | `StreamState.sawDone` + EOF 检查：无 `finish_reason` 且无 `[DONE]` ⇒ 抛**不可重试**的 `ModelCallError`（已投递增量，重试会重复前缀/二次副作用）                                 | `modelAdapters.test.ts`：截断流报"不完整"且 `retryable:false`；有 `[DONE]` 正常完成                           |
| **E3 缓存写入成本** | `ModelUsage.cacheCreationPromptTokens` + `RoutePrice.cacheWriteInputPer1M`；Anthropic 五条价目按 5 分钟档 1.25× 登记；`CostBudget` 把写入量从普通输入里拆出单独计价             | `costBudget.test.ts`：input=100/create=1000 ⇒ $0.00405（3 + 3.75 单价）                                       |
| **E4 JSON 修复**    | `ToolArgumentParser.parseDetailed`：围栏/单引号/尾逗号/未闭合字符串与括号的确定性修复；修不好返回 `error`；`ToolCall.parseError` 让执行器在**一切门禁之前**拒绝并补配对失败结果 | `toolArgumentParser.test.ts` 4 例；`stepToolExecutorPairing.test.ts` ⑤：不可修复 ⇒ 工具零执行、失败原因可行动 |
| **E5 统计功效**     | `AbMetrics.paired` 增加配对 bootstrap 95% CI（2000 次、固定种子）与 `mde80`（q90−q10 半宽）；`AbSummary` 增加 `passAt1`                                                         | `abMetrics.test.ts`：10pp 效应 CI 覆盖点估计、同数据两次结果逐位相同、n<3 不假装有区间                        |
| **E8 遗忘开关**     | `ResonantFieldEngine` 接入 `SpacingEffect.rankWithSpacing`：召回命中写回 `lastRecallAt`/`recallCount`/`stabilityDays`；`spacing` 可由选项或 env 控制                            | `resonantField.test.ts` ⑨：生产端口开 `spacing` ⇒ `recallCount=1`、稳定度增长                                 |
| **A1 递归入口**     | `SubagentRunner.RECURSION_TOOLS` 补 `run_plan` / `delegate` / `a2a_delegate`（原有 subagent/run_workflow/run_goal）                                                             | `subagent.test.ts`：子代工具视图对五个间接入口全部不可见                                                      |
| **A3 工具重试**     | 只读工具（read_file/list_dir/glob/grep/web_fetch/web_search/memory_search/recall）遇瞬态错误重试一次；写类/shell 一次到位                                                       | `stepToolExecutorPairing.test.ts` ⑤：read_file 两次尝试后成功；write_file 只尝试一次并记失败                  |
| **A4 用量回传**     | `AgentResult.usageTokens` → `SubagentResult.usageTokens`，父级可聚合派生成本（默认 0=不限步数是既定策略，不改）                                                                 | `subagent.test.ts`：子代 `usageTokens=15`                                                                     |
| **A6 A2A 幂等**     | `message/send` 以 `messageId` 为幂等键：任务已存在则原样返回快照，不重建、不重跑 handler                                                                                        | `a2aV1.test.ts`：同 messageId 发两次，handler 只执行 1 次、返回同一任务                                       |

**本批验证（实跑）**

```text
npx vitest run --project node tests/unit/contextShapers.test.ts \
  tests/unit/compactionTurnDrop.test.ts tests/unit/stepAssistantText.test.ts \
  tests/unit/compactorFingerprint.test.ts tests/unit/modelAdapters.test.ts \
  tests/unit/costBudget.test.ts tests/unit/toolArgumentParser.test.ts \
  tests/unit/stepToolExecutorPairing.test.ts tests/unit/abMetrics.test.ts \
  tests/unit/resonantField.test.ts tests/unit/subagent.test.ts tests/unit/a2aV1.test.ts
# 全部通过（逐文件计数见看板 §117）
```

### 6.9 第三批闭环与仍剩余项（2026-10-29）

| ID                      | 状态                  | 证据 / 下一步                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E7 记忆探针             | ✅ 已闭环             | 三个探针改走生产端口：`memoryLiftProbe` 经 `MemoryStackAssembler.buildMemoryPort`、`longMemEval` 同、`memorySpacingLift` 经 `ResonantFieldEngine`；新增 `--lens=resonant\|base`。实测：base **100%** hitRate@5、resonant **50%**（随机对照无区分力）                                                                                                                     |
| E9 ACP cursor           | ✅ 已闭环             | `session/list` 支持 `nextCursor`（页大小 50），未知 cursor fail-closed；判据 `acp.test.ts` 14                                                                                                                                                                                                                                                                            |
| E10 AG-UI STEP/state    | ✅ 已闭环             | run 级 `STEP_STARTED/FINISHED` 成对（取消/错误也配对）；`input.state` 作为首个 `STATE_SNAPSHOT` 下发；判据 `agui.test.ts` 19 例                                                                                                                                                                                                                                          |
| A2 MCP 工具纳入 planner | ✅ 已闭环             | `ToolSearchTool` 按名字签名惰性重建索引（后注册工具可检索）；`ToolExposurePlanner.boundBySchemaBudget` 12k token 软预算，恒可见工具不被挤掉；判据 `toolExposureBudgetBound.test.ts` 3 例                                                                                                                                                                                 |
| A10 记忆 GC / 预算      | ✅ 已闭环             | `FileLongTermMemoryOptions{maxFacts=2000, maxRecallTokens=4000}`：超限按「低重要度→更旧」淘汰并原子重写；召回按 token 截断；判据 `fileLongTermMemory.test.ts` 2 例                                                                                                                                                                                                       |
| S1 共振场默认档         | ✅ 已裁决             | 依 E7 两端口数据，`MemoryStackAssembler` 默认改为**裸文件记忆**（resonant 需显式 `enabled:true`）；判据 `memoryStackAssembler.test.ts` 两向                                                                                                                                                                                                                              |
| A8 会话 fork            | ✅ 已存在（审计误报） | `Agent`/CLI 早有 `--fork`（`forkId` → 新 sessionId + hydrate 源历史）；缺的只是**回合中 steering**                                                                                                                                                                                                                                                                       |
| E2 推理签名回传         | ✅ 已闭环             | Anthropic：`signature_delta` → `ModelOutput.reasoningSignature` → assistant 事件 payload → `ModelMessage.reasoningSignature` → `thinking` 块原样回传；Gemini：`functionCall.thoughtSignature` 解析 → `tool_call` 事件 → 投影回 `toolCalls` → 下一轮原样回传。mock SSE 与 wire 请求体判据（`modelAdapters.test.ts` / `geminiModel.test.ts` / `contextAssembler.test.ts`） |
| E6/S3 任务集扩容        | ◐ 部分闭环            | 20 → 32（新增 `interval-merge`、`matrix-rotate`、`deep-merge`、`text-wrap`、`math-safe`、`binary-search`、`slugify`、`bit-count`、`roman`、`bytes`、`color-hex`、`duration`，各含 fixture/verifier/参考解/自检）；距 40+ 仅差 8，逐个任务编写属作者工作量，未灌水                                                                                                        |
| A5 workflow 隔离/回滚   | ✅ 已闭环             | `step.timeoutMs` / `maxAttempts` / `rollbackOnFailure`；`WorkflowIsolation` worktree 隔离（成功 `diff --binary` 应用、失败丢弃）；`run_workflow` 新增 `isolate` 参数并接 `WorkflowIsolatedRun`；判据 `workflowIsolation.test.ts` 2 例 + `runWorkflowToolContract` 4 例。边界：`isolate` 与 `persist/resume` 互斥                                                         |
| A7 技能懒加载/信任分级  | ✅ 已闭环             | `SkillMdDiscovery.list()` 只元数据、`load()` 按名取正文；`SkillRegistry.registerLazy` 让**检索索引只含元数据**、选中时才加载正文并缓存；`Skill.trust` 标记 `bundled/workspace`，工作区技能受 `allowWorkspaceSkills` 闸。判据 `skillLazyDiscovery` / `skillRegistryLazy` / `skillStackAssembler`（5 例）                                                                  |
| A8 steering             | ✅ 已闭环             | 全链路：`TurnRunner` 步边界消费；`Agent.steering` 队列；`turns.steer` RPC；Composer busy 时发送=`↪` 插话（`ApiClient.steerTurn`）。判据 `turnSteering.test.ts` + `web/test/composerSteer.test.ts`；fork 既有 `Agent.fork`/CLI `--fork`                                                                                                                                   |
| A9 符号级召回指标       | ✅ 已闭环             | `recallHitrate --lens=symbol`：从 `src/` 真实导出声明推导「符号名 → 唯一定义文件」（120 条），报告 hitRate@K + CI；本机 fileK=24 实测 **100%**（符号名精确查询的上限基线，用于回归而非区分度）                                                                                                                                                                           |
| S2 前端长函数           | 未完成                | 49 个函数 >80 行、2 文件 >810 行（冻结基线），按"改动即拆"持续清偿                                                                                                                                                                                                                                                                                                       |

---

## 7. 反泡沫清单（明确不做）

与 [`ARCHITECTURE_UPGRADE_2026-10.md`](ARCHITECTURE_UPGRADE_2026-10.md) §5 一致的项不再重复；
本轮新增/再次确认的"不做"：

| 不做                                        | 为什么（带证据）                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 用 SFT/RL 训练一个"会决定何时压缩"的模型    | AutoCompact 的增益来自训练 + 环境反馈；本仓无训练数据/算力/评测闭环，做出来也无法证明优于启发式 |
| 上向量数据库或换 embedding 检索             | 11 个生产 harness 无一用嵌入检索代码；本仓语义路收益上限 18.2pp 且近似方法已被自证伪            |
| 引入通用 agent 框架（LangGraph/AutoGen 等） | 11 个生产 harness 无一 import；本仓端口 + 组合根已覆盖装配需求                                  |
| 多写者 swarm / 并行写子代理                 | 外部一致反对 + 本仓已有 worktree 隔离；写冲突的代价高于并行收益                                 |
| 照抄 Terminal-Bench / SWE-bench 榜单数字    | 本仓任务集是合成任务；榜单受模型/harness 配对影响，不能外推（§3.2①）                            |
| 为"平台化"先做 marketplace                  | 信任链/签名/导入导出未闭环前，marketplace 只会放大供应链风险                                    |
| 把 `resonantField` 直接删掉                 | 它是 L0 但也是真实实验；先修正确性，再用两端口 A/B 决定去留（§4.4 S1）                          |

---

## 8. 诚实边界

1. **单机单模型**：所有真机结论来自一台 Windows；真模型基线只有 `deepseek-v4-flash`。
   本文不声称跨厂商/跨机器可复现。
2. **两批共 19 项是正确性/证据修复**（A4 为部分：用量已回传，0=不限步数是既定策略）：
   没有跑真模型长任务，不产生 pass@1/成本增益数字。
3. **外部数字是检索快照**：44pp、9.2%、11pp、60.6pp 等均为论文自报，未在本机复现；
   引用它们是用于"方向判断"，不是"本仓成绩"。
4. **探针与生产端口不一致**：记忆 primer 的 80%/100% 仍是非生产端口数字；U1 的 E7
   完成前不得对外引用。
5. **L0 机制**：共振场自评"与词袋冗余、实测零增益"；本文只修其正确性，不为其能力背书。
6. **协议声明**：ACP/AG-UI 的能力矩阵仍"声明 > 实现"，U3 收口前按 §4.2 E9/E10 标注。

---

## 9. 来源索引

**一手论文 / 规范**

- Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents —
  <https://arxiv.org/abs/2609.00006>
- Meta-Harness: End-to-End Optimization of Model Harnesses —
  <https://arxiv.org/abs/2603.28052>
- AutoCompact: Learning When to Compact Context in Long-Horizon Coding Agents —
  <https://arxiv.org/abs/2610.02163>
- Parallel Context Compaction for Long-Horizon LLM Agent Serving —
  <https://arxiv.org/abs/2605.23296>
- DyadMem: A Long-Term Memory Benchmark of How Agents Work with Users —
  <https://arxiv.org/abs/2610.03020>
- ARC: Active and Reflection-driven Context Management for Long-Horizon
  Information Seeking Agents — <https://aclanthology.org/2026.findings-acl.930/>
- Verify, Repair, Repeat, or Stop? Robust Stopping for Noisy Verify-Repair Loops —
  <https://arxiv.org/abs/2607.17641>
- Pairing Matters: Performance, Failures, and Efficiency in Lightweight Coding Agents —
  <https://arxiv.org/abs/2610.32131>
- Where Do AI Coding Agents Fail? An Empirical Study of Failed Agentic Pull Requests —
  <https://arxiv.org/abs/2601.15195>
- openJiuwen: Beyond Static Harnesses for Long-Horizon Coding Agents —
  <https://arxiv.org/abs/2608.27969>
- MCP Specification 2026-07-28 — Key Changes —
  <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- Agent Skills Specification — <https://agentskills.io/specification>
- Terminal-Bench 2.0 Leaderboard — <https://www.tbench.ai/leaderboard/terminal-bench/2.0>

**开源社区**

- agentic-harness-patterns-skill（Claude Code 模式提炼） —
  <https://github.com/keli-wen/agentic-harness-patterns-skill>
- awesome-harness-engineering（生态清单） —
  <https://github.com/ai-boost/awesome-harness-engineering>
- agent-verify（自验证策略实证研究） —
  <https://github.com/SeungyounShin/agent-verify>

**本仓证据**

- `src/context/compactionSummarizer.ts` / `contextCompactor.ts` / `compactionComposer.ts`
- `src/core/turnRunner.ts` / `stepRunner.ts` / `sessionInjector.ts` / `stepToolExecutor.ts`
- `src/adapters/memory/resonantFieldEngine.ts` / `memoryExtractor.ts` / `fileLongTermMemory.ts`
- `src/adapters/tool/memory/recallTool.ts` / `rememberTool.ts`
- `src/ports/runtime/turnDiffTracker.ts`；`src/adapters/diff/turnDiffHooks.ts`
- `src/mcp/*`；`src/acp/*`；`src/agui/*`；`src/subagent/*`；`src/eval/*`
- `docs/PROJECT_BOARD.md`（唯一事实源）；`docs/ARCHITECTURE_UPGRADE_2026-10.md`（反泡沫）
