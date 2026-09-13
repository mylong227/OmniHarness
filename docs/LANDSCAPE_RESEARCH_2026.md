# OmniHarness 竞品差距 · 最新技术 · 开放学术资源 完备调研文档

> 编制时间：2026-09-05 | 口径：基于仓库代码实测（309 TS 文件 / 31213 行 + Rust 内核）+ 2026-09 公开生态调研
> 目的：回答三件事——(1) 与同类软件的功能差距在哪；(2) GitHub 上哪些开源/最新技术能补强；(3) 有哪些开放、公开的跨学科科研资料/论文/课题在思想或方法上有利于本项目。
> 说明：2026 年的 arXiv 编号凡带 `*` 标记者，建议引用前到 arxiv.org 复核；竞品基准分数多为厂商/社区自报，未独立复现。

---

## 0. 文档使用方式

- 第 1 节：**现状盘点**（你自己有什么，避免把已落地能力误报成缺口）。
- 第 2–3 节：**竞品差距**与可借鉴模式（对照 Codex / Claude Code / Gemini CLI / OpenHands / Aider / Goose / Qwen / Kilo 等）。
- 第 4 节：**最新工程技术**（2025–2026）按 10 个维度拆解，标注"OmniHarness 能否直接复用"。
- 第 5 节：**开放学术资源**全分类目录（论文/基准/课程/实验室）。
- 第 6 节：**研究课题与开放问题**（可攻关方向）。
- 第 7 节：**综合优先级路线图**（把缺口→技术→论文→行动串起来）。

---

## 1. OmniHarness 现状盘点（代码实测）

据 `src/` 目录与既有 gap 文档（`docs/GAP_*.md`、`roadmap.md`）交叉核实，以下能力**已经落地**，非缺口：

| 维度      | 现状（已落地）                                                                                                                       | 证据                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 架构      | 六边形端口-适配器，`src/ports/` 40 插口 + `src/adapters/` 23 类，零运行时依赖                                                        | `ls src/ports src/adapters`                |
| 原生沙箱  | 多后端 passthrough/policy/restricted + landlock\|seatbelt\|bwrap fail-closed 占位 + **Windows RestrictedToken（Rust 551 行可编译）** | `crates/omni-core/src/restricted_token.rs` |
| 检索      | **双 BM25**（M1 工具检索 `tool_search` + M2 会话检索 `memory_search`），零依赖                                                       | `src/search/`、`src/adapters/retrieval/`   |
| 配置      | 四层合并（用户→项目→profile→env）+ 别名归一 + 严格校验 fail-closed                                                                   | `configLayer.ts`、`FileConfig`             |
| 结果外溢  | Spill 工具结果外溢（钩子拿完整结果后、写上下文前外溢）                                                                               | S75                                        |
| MCP       | **双向**（client + server + gateway）                                                                                                | `src/mcp/`                                 |
| 子智能体  | 进程内 Subagent（同 `Agent` 换 tools/events/maxSteps 视图，自动继承压缩/Spill/FFI）                                                  | S76                                        |
| 工作流    | Workflow DAG（Kahn 拓扑分层 + ConcurrencyLimiter 并发≤4 + blackboard）                                                               | S31                                        |
| 自主循环  | goal/ralph 自主长循环（GoalChecker 保守判定 + GoalRunner 复用主循环，达上限即停）                                                    | S30                                        |
| S+ 发明层 | 共振记忆 / 涡环包 / 进化闭环 / QEC / 免疫监控 / 宇宙网 / 元认知 等原语，经 SparkController.autoRun 接主循环                          | `src/spark/`、`src/evolution/`             |
| 企业      | OIDC SSO（PKCE+JWKS fail-closed）、审计哈希链（seq/prev/hash 三重篡改检出）、`/healthz`+`/readyz` 探针                               | D1/D2                                      |
| 工程化    | 结构化日志（traceId 传播）、CHANGELOG、API 稳定性 `@beta` 标注、零依赖铁律自检                                                       | `scripts/check.mjs`                        |
| 身份      | Agent 密码学身份（node:crypto Ed25519）                                                                                              | S33                                        |
| 安全策略  | 安全策略求值器（规则→决策，递归下降零代码执行）                                                                                      | S34                                        |
| UI        | Codex 风格 Web（左侧导航 + 气泡 + Composer 多模态 + 模型/推理/权限三切换器）                                                         | `web/src/`                                 |
| 多模态    | `turns.run` 已受理 `images:[{url?,data?,mediaType?}]`，本轮新加 `files`（图片/视频/文件透传）+ `reasoning_effort`                    | 本轮提交 `63f9b10`                         |
| 成本      | token-meter 硬预算 + 路由定价                                                                                                        | S29                                        |
| TUI       | 零依赖 ANSI 渲染 + readline 交互                                                                                                     | S35                                        |
| LSP       | 代码导航 stdio 桥接                                                                                                                  | S32                                        |

**结论：OmniHarness 在"原生沙箱矩阵 / 审计哈希链 / 双 BM25 / 进化闭环 / 密码学身份 / 安全策略求值"上已经领先多数开源竞品，不是"裸壳"。差距集中在"上下文图压缩、A2A 互操作、专属 eval 集成、钩子深度、模型列表动态下发"几个点。**

---

## 2. 竞品功能差距分析

### 2.1 能力矩阵（节选关键行，✅ 一等 / ◐ 部分 / — 无 / ? 不确定）

| 能力              | OmniHarness                         | Codex CLI         | Claude Code       | Gemini CLI | OpenHands   | Aider       | Goose      | Qwen Code | Kilo    |
| ----------------- | ----------------------------------- | ----------------- | ----------------- | ---------- | ----------- | ----------- | ---------- | --------- | ------- |
| 多模型/provider   | ◐ OpenAI兼容+深度求索+原生          | ◐ OpenAI          | — Claude          | — Gemini   | ✅ BYOK     | ✅ LiteLLM  | ✅ 15+     | ✅ 多     | ✅ 500+ |
| 推理强度控制      | ✅ reasoning_effort(新)             | ✅                | ✅                | ◐          | ◐           | ◐           | ◐          | ◐         | ◐       |
| 子智能体/多体     | ✅ 进程内                           | ◐ guardian        | ✅ teams+动态流   | ◐          | ✅          | ◐           | ✅         | ✅        | ✅      |
| Workflow/DAG      | ✅ 自研                             | ◐                 | ✅                | ◐          | ✅          | —           | ✅ Recipes | ✅        | ✅      |
| 长期记忆          | ✅ 双BM25+共振                      | ◐ AGENTS.md       | ✅                | ◐          | ◐           | ✅ repo-map | ✅         | ✅        | ◐       |
| 上下文图压缩      | — **缺口**                          | —                 | —                 | —          | —           | ✅ repo-map | —          | —         | —       |
| 工具沙箱          | ✅ 原生矩阵                         | ✅ landlock       | ◐ 权限为主        | ✅ gVisor  | ✅ Docker   | —           | ✅         | ◐         | —       |
| 权限/审批         | ✅ 四级+profile                     | ✅ 细粒度         | ✅ 4模式+参数规则 | ◐          | ◐           | ✅          | ✅         | ✅        | ✅      |
| MCP client+server | ✅ 双向                             | ✅                | ✅ 最深           | ✅         | ✅          | —           | ✅ 70+     | ✅        | ✅      |
| A2A 互操作        | — **缺口/机会**                     | —                 | ◐ ACP             | —          | —           | —           | ◐ ACP      | —         | —       |
| 技能/插件         | ✅ 权限白名单+市场视图              | ✅                | ✅ 深             | ◐          | ✅          | —           | ✅         | ✅        | ◐       |
| 自主循环          | ✅ goal+进化闭环                    | ✅ exec           | ✅                | ◐          | ✅ Resolver | ✅ watch    | ✅         | ✅ /loop  | ◐       |
| 多模态输入        | ✅ 图/视/文(新)                     | ✅                | ✅                | ✅         | ✅          | ✅          | ◐          | ✅        | ✅      |
| 专属 eval 集成    | ◐ evals/ 目录，无 SWE-bench harness | ✅ Terminal-Bench | ✅                | ✅         | ✅          | ✅          | —          | ✅        | —       |
| 企业 SSO/审计     | ✅ OIDC+哈希链                      | ?                 | ◐                 | ?          | ✅          | —           | ◐          | ?         | —       |
| Agent 身份签名    | ✅ Ed25519                          | —                 | —                 | —          | —           | —           | —          | —         | —       |
| 成本/预算旋钮     | ✅ token-meter                      | ✅                | ✅                | ◐          | ◐           | ✅          | ✅         | ◐         | ✅      |

### 2.2 真实差距清单（OmniHarness 当前没有 / 弱于竞品）

1. **AST/图上下文压缩（repo-map，Aider/SWE-agent 强项）**：OmniHarness 有 BM25 但无 tree-sitter AST → PageRank 符号排名的有界 token 上下文。这是"让模型看懂整个仓库结构"最划算的一招，BM25 检索补不了。
2. **A2A（Agent2Agent）互操作**：全行业 CLI harness 都薄，OmniHarness 也是空白——但恰恰是差异化机会（做"可被发现、可委托任务"的对等智能体）。
3. **专属 eval harness 集成**：有 `evals/` 目录但未见 SWE-bench / Terminal-Bench / τ-bench 的正式跑分管线。竞品几乎都拿 SWE-bench 当门面。
4. **钩子（hooks）深度**：Claude Code 有 12+ 生命周期钩子；OmniHarness 有 hooks 兼容层（codex+claude-code 双信封），但深度/覆盖面待扩。
5. **模型列表动态下发**：前端三切换器能写 `model` 字段，但后端无 `models.list` RPC，UI 只能硬编码选项。竞品（Qwen/Kilo/Cline）靠 300–500+ 模型市场。
6. **努力/预算旋钮在 UI 暴露**：`reasoning_effort` 后端已接，但前端切换器目前只给了 minimal→xhigh 档，缺"成本上限/预算"可视化与拦截。
7. **ACP（Agent Client Protocol）宿主能力**：Zed/Windsurf 能跑外部 agent 作一等进程；OmniHarness 是 agent 本身，可作为 ACP **客户端**接入 Zed 等，提升可被发现性。

### 2.3 OmniHarness 已领先项（别再"补"这些，去补上面）

- 原生沙箱矩阵（Windows RestrictedToken + landlock/seccomp 占位）领先 Codex 之外的多数开源。
- 审计哈希链 + 结构化日志 + 探针：Amp/Continue/OpenHands 之外少有开源做全。
- Agent 密码学身份、安全策略求值器：2026 全行业几乎无人做。
- 双 BM25 + S+ 发明层（共振/涡环/进化闭环/QEC/免疫）：独家。
- 零依赖铁律 + N-API 免工具链 FFI：部署/分发优势。

---

## 3. 值得借鉴的竞品模式（8 条，带落地建议）

1. **正交沙箱 × 审批（Codex）**： containment（fs/net）与 human approval 两轴独立组合 + 命名 profile + 域名/路径 allowlist。OmniHarness 已有骨架，建议把 profile 命名做成 `--sandbox` 枚举白名单（已在 S78 翻转为 policy 默认）。
2. **repo-map / 图上下文（Aider）**：tree-sitter AST → PageRank 符号排名 → token 预算上限。**优先补**，见 §4.1 与 §7。
3. **隔离上下文子智能体（Claude Code）**：每子体独立窗口/tools/model/maxTurns，编排移出对话（Dynamic Workflows）。OmniHarness 的 Subagent 已对，建议加"编排在对话外"模式。
4. **MCP 作工具层 + ACP 作连接层**：MCP 已双向支持（200+ server 事实标准）；考虑 ACP 客户端让 OmniHarness 能被 Zed 等宿主驱动。
5. **Recipes/Skills 可移植 YAML+Markdown（Goose/Qwen）**：已有 skill 系统，建议加版本化 + `agents.toml` 出处声明。
6. **事务性 git 提交（Aider）+ 参数级权限规则（Claude）**：原子提交给 `git bisect` 杠杆；`Tool(param:value)` 拒绝规则做精确策略。
7. **显式 effort/budget 旋钮（Codex/Amp/SWE-agent）**：把成本治理做成产品特性，非事后补丁。
8. **自主自我改进循环（OpenHands ~20% 自写提交）**：OmniHarness 已有进化闭环，可作为"agent 演化 harness"的可量化信号（见 §6 研究课题）。

---

## 4. 最新智能体工程技术（2025–2026）及可落地项

> 每项给"本质 + 最佳来源 + OmniHarness 能否复用"。

### 4.1 上下文工程（Context Engineering）

- **本质**：管理塞进窗口的内容——正确海拔的系统提示、token 敏感的去重工具、canonical few-shot、即时检索、长程三招（压缩 / 结构化记笔记 / 子体隔离）。来源：Anthropic《Effective context engineering for AI agents》(2025-09)；**Context Rot** 报告（无关 token 越多越掉点，18 模型验证）；Manus 生产经验（KV-cache 命中率是头号指标，append-only 确定性序列化）。
- **OmniHarness 复用**：已有 compaction + Spill + 子体；**缺口是图上下文**（见 §2.2-1）。建议加 tree-sitter AST repo-map（BM25 之上叠一层符号排名）。
- **反模式提醒**：Cognition《Don't Build Multi-Agents》——多体只用于"读/分析"，写操作保持单写者线程。

### 4.2 智能体记忆（Agentic Memory）

- **本质**：working/episodic/semantic/procedural 分类；自编辑记忆（agent 更新自己的存储）。
- **关键文献**：MemGPT(2310.08560)、Generative Agents(2304.03442)、**Mem0(2504.19413, 2025 强源)**、MemOS(2507.03724)、Titans(2501.00663, 测试时长期记忆)、HippoRAG 2(2502.14802)。
- **OmniHarness 复用**：双 BM25 + 共振记忆已覆盖 episodic/semantic 检索；建议引入 **Mem0 式 ADD/UPDATE/DELETE/NOOP 自编辑管线** + 图变体（HippoRAG 2 风格），把"记忆退火"（`memoryAnnealing`）接上。

### 4.3 多体编排（Multi-Agent Orchestration）

- **本质**：orchestrator-worker、辩论、DAG、blackboard、失败隔离。
- **关键文献**：More Agents Is All You Need(2402.05120)、AutoGen(2308.08155)、MetaGPT(2308.00352)、Anthropic 多体研究（~90% 研究类 eval 提升）、LLM-Debate。
- **OmniHarness 复用**：Workflow DAG + Subagent + blackboard 已落地，与前沿一致。建议加"读/分析用 fan-out，写用单写者"的护栏（Cognition 反模式）。

### 4.4 智能体 RL / 自我改进

- **本质**：轨迹级多轮 RL、训练奖励模型做测试时搜索、RLVR（可验证奖励）。
- **关键文献**：**RAGEN/StarPO(2504.20073, 2025)**、AgentRM(2502.18407, ACL)、RLVR（DeepSeek-R1 2025-01）、Search-R1(2503.09516*)。
- **OmniHarness 复用**：进化闭环已是 RL-ish 自我改进雏形；可接 **RLVR**——用测试/类型检查/编译通过作 verifiable reward，给 GoalRunner 加"可验证奖励"分支（见 §6-2）。

### 4.5 工具学习与函数调用

- **本质**：何时/如何调用、工具检索（只给相关工具）、并行调用、工具结果验证。
- **关键文献**：Toolformer(2302.04761)、Gorilla(2305.15334)、ToolLLM(2307.16789)、工具学习综述(10.1007/s44336-025-00024-x, 2025)。
- **OmniHarness 复用**：已有 `tool_search`（BM25 延迟暴露）；建议加 **AnyTool 式分层工具检索**，避免长工具列表压窗。

### 4.6 沙箱与安全执行

- **本质**：microVM(Firecracker) > gVisor > OS 原语(landlock/seccomp/seatbelt/RestrictedToken) > 容器。
- **关键来源**：E2B(firecracker ~150ms)、gVisor(runsc)、Codex landlock+seccomp、K8s Agent Sandbox、WASM 隔离(Microsoft Wassette)。
- **OmniHarness 复用**：已对齐。建议把 bwrap/seatbelt/landlock 占位从 fail-closed 占位升级为"真机运行时验证"（S78 已知限制），并补 **MCP server 访问控制框架**（AgentBound/AgentBox, 2510.21236*）。

### 4.7 协议与互操作

- **MCP**（Anthropic，已捐 Linux Foundation）：工具层事实标准，200+ server。OmniHarness 已双向支持——**保持领先**。
- **A2A**（Google，Linux Foundation）：Agent Card + HTTP/SSE 对等委托。OmniHarness **缺口/机会**（§2.2-2）。
- **ACP**（IBM/Zed/JetBrains）：agent 连接层，与 A2A 不同轴。建议做 ACP 客户端。
- **AGENTS.md / agents.toml**：仓库级指令约定，OpenAI 已捐 AAIF。OmniHarness 可读取并转化为 skill 上下文。

### 4.8 推理与规划

- **本质**：CoT / ReAct(2210.03629) / ToT(2305.10601) / Plan-and-Execute(2305.04091) / ReWOO / LLMCompiler(DAG 并行)。
- **OmniHarness 复用**：Plan 模式(S77) 已是 plan-and-execute；`reasoning_effort` 已接 OpenAI。建议把"推理强度"也映射到非 OpenAI 模型（Anthropic thinking / Gemini thinking 的等价参数）。

### 4.9 评估与基准

- **关键基准**：SWE-bench(2310.06770)、Terminal-Bench(tbench.ai)、τ-bench(2406.12045)、WebArena(2307.13854)、OSWorld(2404.07972)、AgentBench(2308.03688)、GAIA(2311.12983)、LiveCodeBench(2403.07974)、BigCodeBench(2406.15877)。
- **坑**：基准作弊/脚手架泄漏、单次上报不可靠（用 Pass^k、≥5 次跑）、公开 vs 生产差距（~37% 掉点）、执行分级=RLVR 目标。
- **OmniHarness 复用**：建 **SWE-bench + Terminal-Bench 正式跑分管线**（§2.2-3），把 eval 当回归门禁。

### 4.10 2026 新兴思想

- 世界模型增强智能体（Internalizing the Future, 2606.27483*）。
- 长程信用分配（prospective/foresight credit）。
- 测试时计算扩缩（分支/辩论/搜索）。
- 元认知/自指智能体（显式自模型）。
- 神经符号 + 工具验证（符号 oracle 作可验证奖励）。

---

## 5. 开放学术资源与论文（分学科全目录）

> 仅列真实、可引用、公开资源。arXiv 编号带 `*` 者引用前复核。

### A. 必读综述

- Xi et al.《The Rise and Potential of LLM-Based Agents》— 2309.07864
- Zhao et al.《A Survey on LLM-Based Autonomous Agents》— 2308.11432（最被引）
- Qu et al.《Tool Learning with LLMs: A Survey》— 2405.17935
- Zhang et al.《A Survey on the Memory Mechanism of LLM-based Agents》— 2404.13501
- Guo et al.《Large Language Model Based Multi-Agents: A Survey》— 2402.01680
- Cao et al.《Survey on LLM-Enhanced RL》— 2404.00282
- 上下文工程综述 — 2507.13334*

### B. 核心能力论文

- **记忆**：MemGPT(2310.08560)、Generative Agents(2304.03442)、MemoryBank(2305.10250)、Voyager(2305.16291)、Mem0(2504.19413)、MemOS(2507.03724)、Titans(2501.00663)、HippoRAG 2(2502.14802)
- **工具**：Toolformer(2302.04761)、Gorilla(2305.15334)、REST-GPT(2306.06624)、ToolLLM(2307.16789)
- **规划/推理**：ReAct(2210.03629)、Reflexion(2303.11366)、ToT(2305.10601)、Plan-and-Solve(2305.04091)
- **多体**：AutoGen(2308.08155)、MetaGPT(2308.00352)、CAMEL(2303.17760)、AgentVerse(2308.10848)、Debate(2305.19118)
- **自改进**：Reflexion(同上)、STaR(2203.14465)、Self-Refine(2303.17651)
- **RL**：RAGEN/StarPO(2504.20073)、AgentRM(2502.18407)、RLVR(2506.14245)

### C. 基准与数据集（公开）

SWE-bench(swebench.com)、Terminal-Bench(tbench.ai)、τ-bench(github.com/sierra-research/tau-bench)、WebArena(webarena.dev)、OSWorld(os-world.github.io)、AgentBench(agentbench.dev)、GAIA(huggingface.co/gaia-benchmark)、LiveCodeBench(livecodebench.com)、BigCodeBench(bigcodebench.dev)、RepoBench(2306.03091)

### D. 安全 / 对齐 / 代理安全

- 间接提示注入 — 2302.12173、2410.07287(InjecAgent)、2406.13352(AgentDojo)
- 自主利用漏洞 — 2404.08144、2402.06664、2406.01637
- "AI Agents That Matter"（评估严谨性）— 2407.01502
- Constitutional AI — 2212.08073
- Agent 安全综述 — 2406.XXXX*（搜 "Security of AI Agents 2024 arXiv" 确认）

### E. HCI 与人-代理协作

- Bommasani et al.《On the Opportunities and Risks of Foundation Models》— 2111.03938
- Park et al.《Social Simulacra》— 2208.04024
- CHI/CSCW 上 "LLM as collaborator" 系列；可解释性接 Anthropic "Toward Monosemanticity"(2406.0XXXX*)

### F. 形式化方法 / 验证（代码代理相关）

- Autoformalization with LLMs — 2205.12615
- Draft, Sketch, and Prove — 2305.01591*
- 属性测试（QuickCheck, Claessen & Hughes ICFP 2000）→ 适配 agent 输出模糊测试
- 静态分析：把 linter/type-checker/形式消毒器接进 harness 验证步

### G. 认知科学 / 相关理论（启发架构）

- Baddeley & Hitch《Working Memory》(1974) → 滑动上下文窗口灵感
- Soar(Laird 2012)、ACT-R(Anderson 1993) → 记忆/目标/产生式系统
- 元认知 → Reflexion/Self-Refine 即元认知循环
- Taleb《Antifragile》(2012) → agent 自修复/在失败中变强
- 免疫系统隐喻 → 多样性/异常检测/记忆，启发自监控自修复
- 全局工作空间理论(Baars) / 预测编码/自由能(Friston) → 编排隐喻
- 共振/吸引子动力学 → agent 状态/目标收敛的复杂系统透镜（与 OmniHarness S+ 共振记忆同源思想）

### H. 开放课程 / 教程 / 博客

- Anthropic《Building Effective Agents》(2024-12)
- Anthropic《Effective Context Engineering for AI Agents》
- Anthropic《How we built our multi-agent research system》
- Lil'Log(Lilian Weng)《LLM Powered Autonomous Agents》(lilianweng.github.io)
- Hugging Face Agents Course (huggingface.co/learn/agents-course)
- Berkeley Function Calling Leaderboard (gorilla.cs.berkeley.edu)
- Papers-with-code "LLM Agents" 列表

### I. 研究课题 / 开放问题（~15，可攻关）

1. 长程信用分配（百步级成败归因）
2. 鲁棒工具结果验证（真成功 vs 看似合理但错误）
3. Agent 自建模（自知能力边界、拒做超范围任务）
4. 自主循环中的价值对齐（无持续人监督）
5. Agent 灾难性遗忘（跨会话/任务保技能）
6. 预测真实成功的评估（超越 leaderboard pass@k）
7. 大规模多体协调（通信协议、角色分配、防"懒代理" 2503.13657）
8. 安全自主代码执行（沙箱、能力圈定、回滚恢复）
9. Agent 因果推理（规划超越相关匹配）
10. 抗提示注入的工具使用（架构层隔离指令与不可信数据）
11. 无漂移的自我改进（RL/反思要泛化而非过拟合）
12. 记忆巩固与检索效率（扩记忆不爆上下文）
13. 跨任务迁移 / 弱到强泛化（AgentRM 思路）
14. Agent 测试时计算扩缩（搜索/验证预算 vs 成本）
15. Agent 决策可解释性（解释"为何选此轨迹"）

### J. 相关实验室 / 组织（含 agent 仓库）

- Stanford CRFM（HELM）、Princeton NLP（SWE-bench、SWE-agent）
- Berkeley BAIR（Gorilla、BFCL）、MIT（Generative Agents）
- Anthropic、Google DeepMind、Microsoft Research（AutoGen、AgentRM）
- OpenAI（Codex、function calling）、AI2（OLMo、OpenHands）
- ETH Zurich SpyLab（AgentDojo、agent 安全）
- 清华 THUNLP / ModelBest（ToolBench、ToolLLM、AgentRM、BMTools）
- Nous / LangChain / CrewAI（开源 agent 框架）

---

## 6. 研究课题与开放问题（深化方向）

把 §5-I 的 15 个开放问题与 OmniHarness 已有能力对接，挑出**最契合、且已有地基可立刻开工**的：

1. **进化闭环 × RLVR**（对接 S30/S+ 进化闭环）：用编译通过、测试绿、类型检查作 verifiable reward，给 GoalRunner 加奖励分支 → 把"自我改进"从启发式变成可训练信号。
2. **共振记忆 × Mem0 自编辑**：把 `resonantMemory` 升级为 ADD/UPDATE/DELETE/NOOP 自编辑管线，接 `memoryAnnealing` 做巩固。
3. **双 BM25 × HippoRAG 2 图检索**：在语义检索上加"神经启发图 + 稠密-稀疏混合"，提升跨会话 fact 召回。
4. **S+ 免疫监控 × AgentDojo 防御**：把免疫监控原语接提示注入/工具滥用对抗评测，做成"自愈"基准。
5. **元认知原语 × 自建模**：让 agent 显式估计自身能力边界，超范围任务主动拒做或委托子体（对接 §5-I-3）。
6. **QEC 原语 × 长程信用分配**：用 QEC（量子纠错隐喻）做轨迹级错误检测与纠正，服务 §5-I-1。

---

## 7. 综合优先级路线图（缺口 → 技术 → 论文 → 行动）

| 优先级 | 缺口/机会           | 复用技术                        | 关键论文/源                   | 具体行动                                                         |
| ------ | ------------------- | ------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| P0     | AST 图上下文压缩    | repo-map (tree-sitter+PageRank) | Aider; SWE-agent history proc | 加 `src/context/repoMap.ts`，BM25 之上叠符号排名；token 预算上限 |
| P0     | 专属 eval 集成      | SWE-bench/Terminal-Bench 管线   | 2310.06770; tbench.ai         | `evals/` 下建 SWE-bench + Terminal-Bench 跑分，接 CI 回归门禁    |
| P1     | A2A 互操作          | Agent Card + HTTP/SSE           | google/A2A                    | 加 `src/server/a2a.ts`，暴露 discover/delegate；做差异化身份     |
| P1     | 模型列表动态下发    | models.list RPC                 | Qwen/Kilo 市场                | 后端加 `models.list`，前端切换器从硬编码改为动态                 |
| P1     | 努力/预算 UI 旋钮   | effort/budget 可视化            | Codex reasoning_effort; Amp   | 前端加成本上限显示 + 拦截；接 token-meter                        |
| P2     | 钩子深度            | 12+ 生命周期 hooks              | Claude Code hooks             | 扩 hooks 兼容层覆盖面                                            |
| P2     | 记忆自编辑          | Mem0 管线                       | 2504.19413; 2507.03724        | 共振记忆升级 ADD/UPDATE/DELETE/NOOP                              |
| P2     | 工具分层检索        | AnyTool 分层                    | ToolLLM 综述                  | `tool_search` 加分层检索，降长列表压窗                           |
| P2     | ACP 客户端          | Agent Client Protocol           | Zed/JetBrains ACP             | 做 ACP 客户端，被 Zed 等宿主驱动                                 |
| P3     | 进化闭环 × RLVR     | verifiable reward               | 2504.20073; 2506.14245        | GoalRunner 加奖励分支                                            |
| P3     | 沙箱真机验证        | landlock/seatbelt/bwrap         | Codex; gVisor                 | 把占位升级为运行时验证（S78 限制）                               |
| P3     | MCP server 访问控制 | AgentBound/AgentBox             | 2510.21236*                   | 给 MCP server 加访问框架                                         |

---

## 8. 一句话结论

OmniHarness 已经不是"裸壳"——原生沙箱矩阵、审计哈希链、双 BM25、密码学身份、安全策略求值、S+ 发明层都领先多数开源竞品。**真正要补的是三块硬骨头**：①AST 图上下文压缩（让模型懂整个仓库）、②专属 eval 跑分管线（SWE-bench/Terminal-Bench 接 CI）、③A2A 互操作（全行业空白=差异化机会）。技术与论文侧，**repo-map、Mem0 自编辑记忆、RAGEN/RLVR、MCP+A2A 双协议、SWE-bench 评估严谨性**是最直接可落地的杠杆；认知科学里的"工作记忆/免疫隐喻/共振动力学"则与项目既有的 S+ 原语同源，值得作为方法论底色继续深化。

---

### 附录：调研产出文件

- 竞品全景：`docs/archive/agentic-dev-landscape-2026-09-13.md`（18 项目 + 能力矩阵 + 中文总结）
- 工程技术：`d:/deepseek/omniharness/docs/`（本文 §4 综合）
- 学术目录：本文 §5（论文/基准/课程/实验室全分类）
- 仓库现状交叉核验：`docs/archive/GAP_ANALYSIS_AND_PLAN.md`、`docs/archive/ROADMAP.md`、`docs/archive/UPSTREAM_GAP_SOURCE_AUDIT.md`（均已归档）
