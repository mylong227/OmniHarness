# OmniHarness 整体架构与同类差距全景报告（2026-09-13）

> 性质：**当前唯一的全景对标文档**，回答两个问题：
> ① 整体架构现在长什么样、往哪个方向演进；
> ② 与全部成熟同类（OpenAI Codex CLI / Claude Code / Gemini CLI / OpenHands / Aider / Cline / Goose / Amp / Qwen Code / Continue / Kilo Code / SWE-agent 等）相比，**核心**与**边缘**各差什么。
> 方法：三层证据——既有审计（2026-09-06 差距审计 → 2026-09-09 成熟度审计，均已归档于 `docs/archive/`）+ 2026-09-12 技术方向书 + **2026-09-13 代码实测复核**（git log 111 commits 逐条核对 / grep 关键能力 / Read 源码钉死关键项）。
> 时效口径：除注明外，所有数字为 2026-09-13 实测；外部产品数字为厂商/社区自报，未独立复现。

---

## 0. 一页判读（TL;DR）

1. **架构构想分两层**：工程层是「六边形端口-适配器 + Rust 原生内核 + S+ 发明层」，已落地约 3.9 万行 TS + 6 千行 Rust；理论层（2026-09-12 方向书）是「受约束的耗散推理系统」，以 UCE 四公理为骨架，**新增的第四公理「度量」**把全部历史负结果统一解释为"度量错配"。
2. **2026-09-06 审计列出的兼容性 P0 已基本闭掉**：AGENTS.md/CLAUDE.md 读取、headless/CI 模式、CI 安全（gitleaks+SSRF）、checkpoint 文件级回滚、弱断言清零，全部落地（一周 111 个 commit）。
3. **当前核心差距收敛为四件事**：官方基准跑分缺失、OS 级沙箱真实后端未验证、MCP 未升到 2026-07-28 无状态核心、多档权限模式残缺——外加方向书自立的 T2「度量升级」主线（最拿得出手也最难）。
4. **边缘差距高度集中**：Web UI 工程化收口（测试/CI/a11y/流式）、浏览器/computer use 空白、A2A 互操作未建、若干后端零测试模块。
5. 最大风险不是缺功能，而是**叙事跑在验证前面**——保持"可证伪验收 + 反泡沫清单"的自律是本项目区别于同类自研项目的核心竞争力。

---

## 1. 项目定位与总体构想

### 1.1 一句话定位

> **受约束的耗散推理系统**——靠持续耗散资源维持一个低熵、可审计、可验证、可自演化的推理秩序。

2026 年的竞争维度已从「模型能力」转向「Harness 质量」。本项目的自我定位：**不拼积木丰富度，拼可靠执行的默认架构**。

### 1.2 双层构想

| 层         | 内容                                                                                       | 状态                                  |
| ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| **工程层** | 六边形端口-适配器 + Rust 原生内核 + S+ 发明层（24 个隐喻引擎，全部声明成熟度等级且默认关） | 已落地（§2）                          |
| **理论层** | UCE 四公理（归一/守恒/演变/**度量**）+ 七条升级主线 T0–T6，全部带可证伪验收标准            | 方向已立，T0 已落地，其余推进中（§3） |

---

## 2. 已落地工程架构（2026-09-13 实测）

### 2.1 总体形态与铁律

- **语言**：TS（ESM + strict，约 38,764 行 src/）+ Rust（38 文件 / 5,975 行，crate：omni-cli / omni-core / omni-napi / omni-sdk / omni-sdk-gen / omni-wasm）。
- **零运行时第三方依赖**：不引入 tree-sitter / 向量库 / FFI 库；FFI 走宿主 node.exe `GetProcAddress` 解析 napi_*。
- **形态**：六边形（端口-适配器）——`src/core/` 只依赖 `src/ports/` 接口，实现在 `src/adapters/`；`core→adapters` 违规边已清零（架构门禁 `--strict` 全阻断）。
- **装配**：组合根 `ConfigFactory` + `RuntimeFactory` + `ServiceKeys`；门禁统一注入，禁业务代码内 new。
- **fail-closed**：审批门禁 → 沙箱门禁 → 执行 → 记录；未知枚举抛错，绝不静默回落。

### 2.2 分层与目录域（35 个顶层域，摘录）

| 域                                                | 职责                                                                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ports/`                                          | 15+ 端口接口（Model/Tool/Storage/Event/Sandbox/Approval/Escalation/Kv/Vault/Retrieval/Spill/Todo/Plan/UserResponder/ResonantMemory/CosmicWeb…），零实现零第三方 |
| `core/`                                           | agent 主循环、stepRunner（已拆分 stepTypes/stepContextBuilder/stepToolExecutor）、审批/沙箱门禁、checkpointManager                                              |
| `adapters/`                                       | 104+ 适配器：model（openai 兼容/anthropic）、memory（resonantMemory/cosmicWeb）、sandbox、kv、vault、lsp、git、diff、embedding、approval、skill                 |
| `context/` + `search/`                            | 上下文引擎（repo-map 符号抽取 + 双 BM25 混合打分）与零依赖检索原语                                                                                              |
| `mcp/` + `a2a/`                                   | 协议域：MCP 2025-06-18（tools/resources/prompts）客户端与服务端；A2A 协议域（互操作未建）                                                                       |
| `enterprise/` + `security/` + `supervisor/`       | OIDC SSO + 审计哈希链 + 合规导出；SSRF 网段拦截 + 提示注入观测；FDIR 监督状态机                                                                                 |
| `subagent/` + `worker/` + `daemon/` + `autonomy/` | 子代理编排器（worktree 隔离 + 工具子集，687 行）、DSH 子进程 worker、常驻例行任务、自治循环                                                                     |
| `server/` + `web/` + `cli/` + `sdk/` + `tui/`     | 接入层：AppServer/RPC、React 工作台、命令行、嵌入 SDK、终端渲染                                                                                                 |
| `eval/` + `evolution/`                            | Pass@k bootstrap 置信区间、SWE replay；RLVR 可验证奖励 + fail-closed 进化门                                                                                     |
| `genesis/` + `spark/`                             | S+ 发明层：模态/算子/ledger 数学基板（L2/L3 声明区）、燧核引擎集                                                                                                |

完整归属表（与 `scripts/architectureGate.mjs` 门禁口径一致）见 `ARCHITECTURE_SPEC.md` §2.1。

### 2.3 核心数据流（一次 `turns.run`）

```
CLI / Web 工作台 ──> 组合根 ConfigFactory ──> agent.runTask(prompt, images, files)
    └─> StepRunner
          ├─ ApprovalGate（审批门禁，rules/escalation 热切换）
          ├─ SandboxGate（沙箱门禁，fail-closed：未知 profile 一律拒绝，不回落 passthrough）
          ├─ ContextAssembler.build(events)
          │     └─ contextEngine.query()：注入紧凑 repo-map（Top-14 文件大纲 + Top-30 符号），替代整文件硬塞
          ├─ ModelRequest{ messages, reasoningEffort } ──> OpenAiCompatibleModel / Anthropic 流式
          └─ eventFactory → sessionRecorder → AuditSink（哈希链）→ session storage（JSONL，支持 --resume/--fork）
```

### 2.4 关键子系统

- **沙箱矩阵（native）**：`passthrough / policy / restricted` + `landlock | seatbelt | bwrap`（后三者 fail-closed 占位）；真实生效：policy/restricted + Windows RestrictedToken（Rust `omni-core/restricted_token.rs`）。路径穿越防护 `workspaceGuard` 四工具 + 两后端全接入。
- **审计哈希链（enterprise）**：`h_n = SHA256(prev ‖ canonical(e_n))`，`verify()` 三重篡改检出——多数开源同类没有可验证审计链，本项目超配项。
- **上下文引擎（context）**：零依赖正则抽取符号（TS/JS/Py），文件级 + 符号级双 BM25，混合打分。**诚实基线（2026-09-12 修正）**：生产默认 BM25 文件召回 **43.3%**（零成本）；语义 Hybrid **59.1%**（+15.8pp，需 22MB 模型 / 81s 构建）；e5-large **64.8%**（321MB / 23.6min，17.5× 构建税）。符号精确率@30 = 25.5%。（早期 67.0% 口径已被方向书判为虚高并修正。）
- **记忆系统**：共振寻址 + 宇宙网 + **三态生命周期循环**（充能/衰减/解离，对齐耗散自组装；2026-09-13 落地，触底事实解离出耦合图、外部充能复活、封顶排序 id 决断保可复现）+ 失效条件与时间衰减。
- **S+ 发明层**：24 个隐喻引擎，L0=8 / L1=8 / L2=3 / L3=5，全部声明等级 + 对应测试门禁（`npm run audit:maturity` 进 CI），默认关、零破坏旁路。
- **Web 工作台**：React 单实现（classic 双实现已归档删除），聊天流 + 工具调用可视化（人话叙述/过程折叠/产物卡片）+ 11 tab 右侧栏 + 会话管理 + 主题；工作台能力（上下文容量/配额/会话模式/权限档位/混合检索/智能体目录）前后端已打通。

### 2.5 质量与门禁体系

| 项       | 实测                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 测试     | tests/ 193 个单测文件（unit 目录实测）；约 4,564 真实用例 / 11,587 断言；弱断言（松散 assert.equal）已清零                                   |
| Rust     | 89 个 `#[test]` + wasm E2E 10 + native E2E 9（**未接默认 JS 测试流**，需手动 cargo）                                                         |
| CI       | 6 job（gate/test/security/rust/e2e/wasm）+ gitleaks + `api:check` 契约检查 + `audit:maturity` + 覆盖率门禁 80% + `architectureGate --strict` |
| API 稳定 | 每 export 强制 `@public/@beta/@deprecated` 标注（`@beta` 293 处），契约式 `api:check` CI 阻断                                                |

### 2.6 诚实清单（现存的"知道但没做/没验证"）

- landlock / seatbelt / bwrap 未在真机验证（本机缺失时 fail-closed，无静默放行）。
- 官方 SWE-bench Verified 大规模跑分缺——现有 `benchmark/capability-swebench.json` 为自研 10 题套件（deepseek-chat live 10/10，$0.20 / 64.7s），非官方数据集。
- A2A 互操作客户端未建。
- HF 本地 embedding 权重未实测（fail-closed 回退 BM25）；OIDC 仅 mock IdP 验证。

---

## 3. 理论方向（UCE 四公理 + 七条主线）

> 全文见 `TECH_DIRECTION_SYNTHESIS_2026-09-12.md`，此处只留骨架。

**四公理**：Ⅰ 归一（表示统一，copresheaf/粘合）· Ⅱ 守恒（**记账不变量**，非物理守恒）· Ⅲ 演变（适应度爬山 + 退火，Lyapunov 单调量）· **Ⅳ 度量（新增，差异化核心）**——优化/检索/匹配必须在正确的几何上进行。

**为什么第四公理关键**：项目全部实测负结果（LSA 叠加后符号精度 25.5%→10.5%、PageRank 零增益、频域共振零增益、PRF 有害、层化图路由 −9.1pp）根因统一诊断为**度量错配**——在错误的空间里比较相似。因此升级主轴不是加能力，而是**换到正确的数学空间做同一件事**。

**七条主线**（可证伪验收是唯一完成判据，状态以 `REFACTOR_BOARD_2026-09-12.md` 为唯一口径）：

| 主线            | 内容                                                                                                                   | 状态                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| T0 成熟度治理   | 24 引擎声明 L0–L3 + 测试门禁 + 措辞红线（"记账不变量"非"能量守恒"）                                                    | ✅ 已落地进 CI            |
| T1 表示归一     | 组合律证明（lift 同态律已证）+ core↔adapters 违规清零 + 迁移映射表                                                     | 基本完成（残差清单 =0）   |
| T2 度量升级     | BM25 43.3%→≥50%、Hybrid 59.1%→≥65%；**层化 repo-map 已实测判负（−9.1pp）并禁默认启用**；查询敏感度否决器已建并回溯 3/3 | 推进中（负结果已留档）    |
| T3 记忆生命周期 | 时间衰减 + 充能/衰减/解离循环（三态计数 9/9 绿）                                                                       | 已落地，Ghost Memory 待验 |
| T4 验证闭环     | 自验证清单/反漂移/失败挖掘/工具描述即不可信输入/agent 读自身 trace                                                     | 待建（正面战场）          |
| T5 训练信号     | RLVR 势函数覆盖率体检 + 多样性保留 + 技能稀疏化                                                                        | 待建（需 T0/T4 先行）     |
| T6 栈升级       | TS 6/7 清废弃配置，类型门禁不被绕过                                                                                    | P3（收益确定但绝对量小）  |

**反泡沫清单**（明确不做）：向量数据库 / tree-sitter / microVM 容器 / GPU RL 训练 / 新增隐喻引擎 / 物理量背书。理由：违零依赖铁律，且实测证明"换度量"比"换存储"更根本。

---

## 4. 成熟同类全景对标

### 4.1 对标对象与标志能力（2026-09）

| 同类                                   | 标志能力（对本项目最有参照价值的）                                                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI Codex CLI**（Rust，v0.150.x） | **沙箱 × 审批正交安全模型**（read-only / workspace-write / danger-full-access × untrusted / on-request / never）+ profile 权限块；`AGENTS.md`；`codex exec` headless；Goal mode 长任务；subagents 8 并行 GA                 |
| **Claude Code / Agent SDK**（Node）    | **最深的 subagent + hooks + MCP 栈**：3 层嵌套 subagent、Agent Teams、Dynamic Workflows 百级扇出、12+ lifecycle hooks、5 档权限 + 参数级 `Tool(param:value)` 规则、`/rewind` 对话+代码回滚、1M 上下文、skills/plugins       |
| **Gemini CLI**（Node，~103k★）         | **最强默认 OS 沙箱**（Docker/gVisor/LXC/bwrap+seccomp）+ 原生多模态（@image/@pdf）+ 1M 窗口                                                                                                                                 |
| **OpenHands**（Python+TS，~72k★）      | **完整自主平台**：Docker 隔离事件流、Resolver 自动修 issue 成 PR、microagents、Condenser 记忆压缩、多面（CLI/GUI/Cloud/SDK）                                                                                                |
| **Aider**（Python，~46k★）             | **git 原生事务性提交**（每改动自动 commit）+ **repo-map**（tree-sitter AST + PageRank 符号图）；LiteLLM 100+ 模型；architect 双模型分工                                                                                     |
| **Cline**（VS Code，5M+ 装机）         | Plan/Act 循环、BYOK 300+、checkpointing、可配置自动批准                                                                                                                                                                     |
| **Goose**（Rust，AAIF 治理）           | **YAML Recipes 工作流** + 70+ 第一方 MCP 扩展 + 四执行模式                                                                                                                                                                  |
| **Amp**（Sourcegraph，商业）           | 四档 effort 模式、parallel subagents、remote orbs、SSO+审计+SOC2、零加价 PAYG                                                                                                                                               |
| **Qwen Code**（TS，~26k★）             | 供应商灵活多代理 CLI：Auto-Memory/Auto-Skills/SubAgents/Agent Teams、daemon 模式 + 三语言 SDK                                                                                                                               |
| **Continue / Kilo Code**               | BYO 模型 IDE 助手 + agent 模式；Kilo 五 agent 模式 + Agent Manager 跨 worktree 并行                                                                                                                                         |
| **Cursor / Zed / Windsurf**（商业）    | Agents Window 8 并行隔离 VM、ACP host（外部 agent 一等接入）、repo 级 RAG 记忆——UX 标杆                                                                                                                                     |
| **SWE-agent**（MIT）                   | ACI 研究设计 + SWE-bench 评测基准参考实现（已转维护模式）                                                                                                                                                                   |
| **协议层**                             | **MCP**（工具层事实标准，2026-07-28 无状态核心 RC，月下载 4 亿+、~18,850 server）；**A2A 1.0**（跨厂商 agent 互操作，Agent Card JWS 签名）；**AGENTS.md**（6 万+ 仓库，Linux Foundation 治理）；**llms.txt**（2,000+ 站点） |

### 4.2 能力矩阵（OmniHarness 列为 2026-09-13 实测）

图例：✅ 一等支持 · ◐ 部分/受限 · ✗ 缺失

| 能力                   | Codex                    | Claude Code         | Gemini CLI      | OpenHands     | Aider       | **OmniHarness**                                                                       |
| ---------------------- | ------------------------ | ------------------- | --------------- | ------------- | ----------- | ------------------------------------------------------------------------------------- |
| 多模型/供应商接入      | ◐ OpenAI+兼容            | ✗ Claude 系         | ✗ Gemini 系     | ✅ BYOK       | ✅ 100+     | ✅ openai 兼容 + anthropic 适配器                                                     |
| 推理强度控制           | ✅                       | ✅                  | ◐               | ◐             | ◐           | ✅ `reasoning` 配置直达模型请求                                                       |
| 子代理/多智能体        | ◐ guardian               | ✅ teams+动态工作流 | ◐               | ✅ delegator  | ◐           | ◐ 编排器+worktree+工具子集（687 行，偏薄）                                            |
| 长期记忆               | ◐ AGENTS.md+resume       | ✅ MEMORY.md 分层   | ◐               | ◐ microagents | ✅ repo-map | ✅ 共振记忆+宇宙网+三态生命周期（前沿但 L 级待升）                                    |
| 上下文压缩/工程        | ✅ tool-search           | ✅ 1M 管理          | ✅ /compress    | ◐ Condenser   | ✅ repo-map | ✅ compactor + 混合检索（BM25 43.3% / Hybrid 59.1%）                                  |
| 工具沙箱               | ✅ landlock/seccomp+断网 | ◐ 权限为主          | ✅ gVisor/bwrap | ✅ Docker     | ✗           | ◐ Windows RestrictedToken 真实；landlock/seatbelt/bwrap 占位 fail-closed              |
| 权限/审批              | ✅ 正交多档              | ✅ 5 档+参数规则    | ◐               | ◐             | ✗           | ◐ rules+escalation；**无多档 permissionMode**                                         |
| MCP                    | ✅ client                | ✅ 最深 200+        | ✅              | ✅            | ✗           | ◐ 2025-06-18 client+server（tools/resources/prompts）；**未到 2026-07-28 无状态核心** |
| A2A 互操作             | ✗                        | ◐ ACP               | ✗               | ✗             | ✗           | ◐ 协议域在、客户端未建                                                                |
| 技能/插件/hooks        | ✅                       | ✅ 最全             | ◐               | ✅            | ✗           | ✅ skills+plugins+hooks+插件宿主                                                      |
| headless/CI            | ✅ `codex exec`          | ✅ `claude -p`      | ✅              | ✅            | ✗           | ✅（2026-09-06 后落地）                                                               |
| 企业 SSO/审计          | ?                        | ◐                   | ?               | ✅ SAML/VPC   | ✗           | ◐ OIDC（mock 验证）+ 审计哈希链 + SSRF 拦截；缺 vault                                 |
| 浏览器/computer use    | ✅ 预览                  | ✅ 预览             | ✅              | ✅            | ✗           | ✗ **零**                                                                              |
| 基准/评测              | ✅ Terminal-Bench        | ✅                  | ✅ SWE-bench    | ✅            | ✅ 自办榜   | ◐ 自研 10 题套件 live 10/10；**官方 SWE-bench 未跑**                                  |
| 成本/预算              | ✅                       | ✅                  | ◐               | ◐             | ✅          | ✅ costBudget + budgetStatusTool                                                      |
| 会话持久化/resume/fork | ✅                       | ✅ JSONL            | ✅              | ✅            | ✗           | ✅ JSONL + `--resume`/`--fork`                                                        |
| checkpoint/rewind      | ◐                        | ✅ 对话+代码        | ◐               | ◐             | ✗           | ✅ 对话+文件快照手术式还原（9-13 实测核验）                                           |

---

## 5. 已达标与超配清单（相对 2026-09-06 审计的收敛记录）

| 能力域                                | 9-06 状态         | 9-13 状态                                                          |
| ------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| 读取 AGENTS.md / CLAUDE.md / llms.txt | 🔴 P0 零实现      | 🟢 `context/projectInstructions.ts` 已接入 stepContextBuilder      |
| headless / CI 模式                    | 🔴 P0 零实现      | 🟢 cli 参数落地                                                    |
| CI 安全（gitleaks + SSRF 网段屏蔽）   | 🔴 薄弱           | 🟢 已进 CI（`NetworkEgressGuard` 默认拦私网，白名单不可覆盖）      |
| checkpoint 只回滚对话                 | 🟠 P1 半截 rewind | 🟢 文件快照手术式还原（`checkpointManager.restoreFiles` 实测核验） |
| 断言质量（70% 松散 equal）            | 🟠                | 🟢 弱断言清零（9-09 审计实测）                                     |
| MCP 协议版本                          | 🔴 过期握手       | 🟡 升至 2025-06-18（tools/resources/prompts）；未到无状态核心      |
| shellTool 注释与实现不符              | 🟠 安全边界误导   | 🟡 注释已改诚实 + 可选 guard；实现仍 `promisify(exec)` 走 shell    |
| OTel 导出                             | 🟡 缺             | 🟢 `observability/otlpTraceExporter.ts` 已在                       |
| Rust native 产物过期                  | 🟠                | 🟢 已重建（napiE2E 跑新内核）                                      |

---

## 6. 核心差距（决定"敢不敢自称生产级"，按重要度）

### 6.1 官方基准跑分缺失 —— 最硬的信誉缺口

所有成熟同类都有公开可查的 SWE-bench Verified / Terminal-Bench 数字；本项目只有自研 10 题套件。在扩到官方子集之前，任何能力对标叙事都立不住。**这是把"功能炫技"变成"可信能力"的第一优先级。**

### 6.2 OS 级沙箱真实后端未验证

landlock / seatbelt / bwrap 全部 fail-closed 占位，真实生效的只有 policy/restricted + Windows RestrictedToken。Codex（landlock/seccomp + 默认断网）与 Gemini CLI（gVisor/bwrap）在此维领先明显。注意这是**零依赖铁律下的主动取舍**（方向书明确不做容器/microVM），但取舍不等于差距消失——Linux/macOS 真机验证 +（若坚持不引依赖）至少给出与容器方案的能力边界说明。

### 6.3 MCP 未升到 2026-07-28 无状态核心

当前 2025-06-18 握手版缺：无状态核心（去 initialize/`Mcp-Session-Id`，`_meta` 携带版本能力）、Tasks 长任务、OAuth 2.1（`iss` 校验）、Extensions / MCP Apps。全行业标配且规范已 RC，与最新 server 互通性未验证。**兼容性硬伤，估算 2–3 人日。**

### 6.4 多档权限模式残缺

`permissionMode` 全仓零命中（仅 web 工作台有一处"权限档位"字段）。业界基线：Claude Code 5 档（default/acceptEdits/plan/auto/bypass）+ 参数级 deny 规则；Codex 的 sandbox_mode × approval_policy 正交组合 + profile 继承。这是自主性控制的骨架，**建议对齐 Codex 的正交设计**（沙箱档 × 审批档两个独立轴）而非照抄档位枚举。

### 6.5 提示注入只观测不阻断

`security/promptInjection.ts` 仅记录。成熟方向是可配置阻断/隔离；方向书 T4-④ 也自认"需接 AgentDojo/InjecAgent 子集，否则只是有净化而非有度量"。同时 shellTool 仍 `promisify(exec)` 走 shell 解释器（上层 ToolGate 有门禁，工具层自身零纵深）。

### 6.6 验证闭环（T4）未建

自验证清单、反漂移检测、失败模式自动挖掘、工具描述即不可信输入、agent 读自身 trace、eval 与生成路径隔离——方向书认定的"2026 竞争维度正面战场"，基建有（门禁链/审计链/hooks）但机制没有。

### 6.7 subagent 深度偏薄

全目录 687 行（编排器/worktree/工具子集）。对比 Claude Code 的 3 层嵌套 + Agent Teams（共享 task list + IPC）+ Dynamic Workflows 百级扇出，是"能用"与"深度"的差距；对比 Codex 的 8 并行 + worker/explorer 角色分工，缺角色化与后台默认行为。

---

## 7. 边缘差距（工程收口 / 协议生态 / 体验）

### 7.1 Web UI 工程化（9-09 审计最大短板，收口中）

- 9-09 实测：web/ 36 文件 5,498 行 **0 测试**、ESLint 整体忽略、CI 不构建、a11y 标记 2 处、`window.alert` 7 处、助手文本非增量流式（整段 renderMarkdown）。
- 9-12/13 进展：React 组件基座统一（33/33 接入 AppComponent）+ 零依赖 DOM 桩挂载契约测试（6 用例绿）+ 双实现归档删除。
- 仍欠：**CI web job、web 测试门禁、a11y 基线（role/aria/焦点/对比度）、token delta 增量流式、UI e2e/视觉回归（playwright 为零）、alert→Toast 替换**。

### 7.2 浏览器 / computer use —— 零

同类全部已有预览级实现。GUI 验证是"质量闭环"最后一块：web 产物无法自证渲染正确。零依赖铁律下可先做"驱动本机已装浏览器（CDP）"路线，不引运行时依赖。

### 7.3 A2A 互操作客户端未建（U6）

协议域目录在、传输骨架在；对外的 Agent Card 暴露/消费未做。A2A 1.0 已 GA（150+ 组织），是差异化空白点（全行业也普遍缺失）。

### 7.4 测试覆盖残段

- 后端零测试模块：`lsaRecall`（284 行）/ `cliDataCmds`（569）/ `configBuilders`（252）/ `registrySources`（293），合计约 1,400 行。
- Rust 单测未接默认 CI 流（需手动 cargo PATH），Windows RestrictedToken 的 Rust 实现默认不被跑。
- eval 集未常态化进 CI（Pass@k 门禁已进，语料未定期跑）。

### 7.5 企业收尾

OIDC 仅 mock IdP 验证（未对真实 IdP）；vault 密钥管理缺；熔断缺；集中重试/backoff 策略散在 747 处未收敛；zero-retention/数据驻留叙事未建。

### 7.6 体验面

无 artifact 画廊/分享链路（`artifactFromTool` 仅覆盖 write_file/apply_patch）；无命令面板/快捷键；Settings 单 tab 无细粒度权限矩阵；权限仅下拉切换。

---

## 8. 待办优先级（ROI 排序，合并三份审计与方向书）

| 优先级 | 项                                                                           | 成本      | 为什么排这里                                            |
| ------ | ---------------------------------------------------------------------------- | --------- | ------------------------------------------------------- |
| **P0** | 官方 SWE-bench Verified 子集跑分                                             | 1–2d      | 信誉缺口第一名；eval 基建已备（SWE replay + Pass@k CI） |
| **P0** | MCP 升 2026-07-28 无状态核心 + OAuth 2.1                                     | 2–3d      | 唯一剩余的兼容性硬伤                                    |
| **P0** | 多档权限 `permissionMode`（建议沙箱×审批正交）                               | 1–2d      | 自主性控制骨架                                          |
| **P0** | OS 沙箱真机验证（landlock/seatbelt）或诚实降级表述                           | 0.5–1d    | 消除"占位当能力"的叙事风险                              |
| **P1** | UI 工程化收口：CI web job + web 测试门禁 + a11y + 增量流式                   | 2–3d      | 成本最低、ROI 最高的一类                                |
| **P1** | T4 验证闭环第一批（自验证清单 + 工具描述即不可信输入 + Pass@k 下置信界门禁） | 3–5d      | 2026 竞争维度正面战场                                   |
| **P1** | T2 度量升级（UCB bandit 路由 + Top-50→Top-10 重排实验）                      | 3–5d      | 差异化核心；否决器已备                                  |
| **P1** | 提示注入可配置阻断 + shellTool 改 spawn 数组                                 | 1–2d      | 纵深防御补全                                            |
| **P2** | subagent 深化（角色化 + 后台默认 + 并行上限）                                | 3–5d      | 补"能用→深度"                                           |
| **P2** | 浏览器验证（CDP 驱动本机浏览器）                                             | 3–5d      | 质量闭环最后一块                                        |
| **P2** | A2A Agent Card 对外暴露                                                      | 1–2d      | 差异化空白点，成本低                                    |
| **P2** | 后端零测试模块 + Rust 进 CI + eval 常态化                                    | 2–3d      | 测试覆盖残段                                            |
| **P3** | vault / 熔断 / OIDC 真机 / artifact 分享 / 命令面板 / llms.txt 发布          | 各 0.5–2d | 企业与体验收尾                                          |

---

## 9. 业界基线速查（吸收自已归档调研，来源见 archive）

> 详细来源链接（20+ 条）全文见 `archive/agent-harness-audit-2026-09-06.md`（业界能力基线）与 `archive/agentic-dev-landscape-2026.md`（18 项目横评矩阵）。

- **MCP 2026-07-28 RC**：无状态核心（去握手/会话 ID）、Tasks、MCP Apps、Extensions、OAuth 2.1；弃用 roots/sampling/DCR（12 个月期）。
- **A2A 1.0**：Agent Card（JWS 签名）、task-based 交互、JSON-RPC/gRPC/HTTP+JSON 三绑定、多租户。
- **AGENTS.md**：6 万+ 仓库、Linux Foundation 治理；与 CLAUDE.md 可 `@import` 互引。
- **分层常驻指令**：CLAUDE.md（用户/项目/子目录/local 四级 + import）是事实标准形态；Codex 默认 32KiB 上限。
- **权限形态**：Claude 5 档 + glob allow/deny + 分类器审查；Codex 沙箱×审批正交 + profile 继承。
- **checkpoint 基线**：Claude `/rewind` 回滚对话+代码（Bash 副作用不计入）——本项目文件快照方案已对齐此基线。
- **评测基线**（2026-07 实测，社区口径）：Claude Opus 4.8 SWE-bench Verified 88.6%；GPT-5.5 Verified 88.7% / Terminal-Bench 82.7%；OpenHands+Sonnet 4.5 ≈ 77%。
- **全行业空白**（差异化机会）：agent 身份/加密签名、超越 repo-map 的语义长期记忆、CLI 侧成熟 A2A。

---

## 10. 诚实边界

1. 本报告的外部产品数字（SWE-bench 分数、star 数、版本号）均为厂商/社区自报，未独立复现。
2. 本项目自身的全部基线数字（BM25 43.3%、Hybrid 59.1%、符号精度 25.5%、自研套件 10/10）为仓库内实测，可由 `evals/` 与 `benchmark/` 复跑。
3. "核心/边缘"的划分是**判断**不是事实：若产品目标转向企业私有化部署，§6.2（沙箱）与 §7.5（企业收尾）应升为 P0。
4. 历史口径差异（如 67.0% vs 43.3% 召回基线）以 `TECH_DIRECTION_SYNTHESIS_2026-09-12.md` 的修正为准。

---

_编纂：2026-09-13。取代关系：本文档取代 `archive/omniharness-maturity-audit-2026-09-06.md` 的对标职能（其 P0 结论已逐条复核并入 §5/§6）；后续状态一律以 `REFACTOR_BOARD_2026-09-12.md` 为唯一执行口径。_
