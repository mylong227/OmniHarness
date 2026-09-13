# 自研 AI Agent Harness 差距审计 · 业界能力基线（2026-09）

> 调研时间：2026-09-06｜范围：成熟 coding agent / 通用 agent 框架 / 协议标准
> 判定口径：**成熟标配** = 没有就明显落后（行业 70%+ 已有）；**前沿探索** = 业界也多在试验或刚 GA。
> 每条尽量给「产品/版本/时间点 + 来源」。来源链接集中在文末。

---

## 0. 一句话结论（先给判读）

截至 2026-09，成熟的 harness 已经不是「能不能写代码」，而是「能不能把**本地仓库 + 云端执行 + GUI 验证 + 审查回滚 + 跨会话记忆 + 可观测审计**接成一个闭环」。你自研 harness 若要不落后，下列几项已是**必备项**：

- 上下文工程：分层常驻指令（CLAUDE.md/AGENTS.md 类）+ 长上下文自动压缩 + 跨会话 JSONL 持久化/恢复
- 自主性控制：多档权限模式（plan/acceptEdits/auto/bypass）+ allow/deny 规则 + 沙箱/工作树隔离 + 危险命令拦截
- 多智能体：subagent 派生（独立上下文窗口）+ 后台并行 + 编排（manager/worker 或 team）
- 可靠性：checkpoint + rewind/回滚 + 审计日志 + 可观测性（OTel/Langfuse 类 trace）
- 工具生态：MCP 客户端支持（2026-07-28 无状态规范）+ hooks + skills/插件 + 浏览器/computer use
- 工程化：headless/CI 模式 + token/成本可观测 + 企业级（SSO/审计导出/策略引擎）

**前沿探索**（做了是加分，不做不算落后）：RLVR 自训练闭环、self-evolving agent、agent 记忆标准化协议、跨厂商 A2A 协作、verifiable rewards 用于产品自身迭代、spec-driven 全自动开发。

---

## 1. 上下文工程

### 业界普遍水平

- **分层常驻指令**：Claude Code 的 `CLAUDE.md`（用户级 `~/.claude/`、项目级、子目录级、私有 `CLAUDE.local.md`、`@import` 引入；2026-08 仍生效）已是事实标准形态 [quidproquo.cc, 2026-08-26]。Codex 读取 `AGENTS.md`/`AGENTS.override.md` + 仓库文档兜底（默认 32 KiB 上限）[openai.com agent-loop]。Gemini/Antigravity 读 `GEMINI.md` 且兼容 `AGENTS.md` [sureprompts.com]。
- **长上下文压缩 / compaction**：Claude Code 在上下文约 95% 时自动压缩，可手动 `/compact`；Token 上限 1M（Opus）[quidproquo.cc]。Codex CLI 约 200K，Antigravity/Gemini CLI 最高 2M token [promptgenius.net migration]。OpenHands 用 **Condenser** 做记忆压缩（V1 架构，arXiv 2511.03690）[dev.to openhands]。Aider 走 repo-map / grep 路线，靠检索而非压缩 [youngju.dev]。
- **跨会话持久化**：Claude Code 每会话写明文 JSONL 到 `~/.claude/projects/`，支持 `--resume`/`--continue`/`--fork-session`；`MEMORY.md` 自动记忆（每会话加载前 200 行或 25KB）[quidproquo.cc]。Codex **Goal mode**（v0.133，2026-05 GA）把目标作为持久化 workflow 对象，可跨数小时/天数驱动 [codex.danielvaughan.com, 2026-05-22]。
- **语义检索 / repo map**：Cursor `@codebase`/`@docs`、Claude Code 的 Glob/Grep + 子代理隔离检索、OpenHands 事件流检索。语义检索多依赖向量库（框架侧 LangChain/LlamaIndex）。
- **记忆分层**：业界共识正在形成「**知识库（组织批准的事实）vs Agent 记忆（运行观察）**」分离治理 [clixlogix.com]。Claude Code `MEMORY.md`=长期，`CLAUDE.md`=权威指令；Codex `goals`/`memories` 跨会话；LangGraph 明确 short-term + long-term memory；Google ADK 内置 memory [langfuse.com 2026-07]。

### 必备 / 加分

- ✅ **必备**：分层常驻指令文件 + 自动 compaction + 会话 JSONL 持久化/恢复 + 自动记忆文件。
- ⚠️ **加分**：语义检索原生集成、记忆分层治理（KB vs working memory 分离）、显式「记忆工具化」主动决策（Agentic Memory/AgeMem 类，仍属前沿）[CSDN loop-engineering]。

---

## 2. 自主性控制

### 业界普遍水平

- **权限模型**：Claude Code 5 档模式 `default / acceptEdits / plan / auto / bypassPermissions`，`auto`（2026 中成为 Pro/Max/Team 默认）由分类器模型审查动作、拦截越权/注入 [quidproquo.cc, atticusli.com]。`settings.json` 内 `allow`/`deny` 支持 glob，`deny` 优先 [yottadynamics.com]。
- **审批流 / 沙箱**：Codex 用 **OS 强制沙箱**（Rust CLI，容器/微 VM 隔离）+ 独立审批策略，destructive 工具调用需审批，worktree 隔离；web 搜索有 cached/indexed/live/disabled 模式做网络隔离 [agenticindex.io openai-codex, openai.com agent-loop]。OpenHands **Docker 沙箱**（非 root、受限网络）[devradar openhands]。Antigravity 内置沙箱 [promptgenius.net]。Devin 云端沙箱。Claude Code 本身**默认在宿主机运行**（靠权限而非沙箱），Anthropic 于 2026-05-30 开源 **Sandbox Runtime (srt)** 供企业自建 [learnagent.org]。
- **危险命令拦截**：Claude Code 可在 `PreToolUse` 用 hook 拦截 `rm -rf /` 等；Codex 沙箱默认断网 + 危险命令审批 [aiwiki.ai claude-agent-sdk]。
- **网络隔离**：Codex 沙箱默认隔离；Claude Code 靠 `--permission-mode plan` + `--allowedTools` 白名单做 CI 最小权限 [yottadynamics.com]。Codex v0.133 增加 **permission profile 继承**做企业治理 [codex.danielvaughan.com]。

### 必备 / 加分

- ✅ **必备**：多档权限模式 + allow/deny 规则 + 危险命令拦截 + 工作树/分支隔离。
- ✅ **强烈建议**：**沙箱执行**（你的自研 harness 若直接在宿主机跑命令，是明显短板；应至少支持容器/微 VM 或 seccomp/landlock，参考 srt 与 Codex 做法）。
- ⚠️ **加分**：OS 级强制沙箱 + 网络分层隔离 + 企业策略继承——商业产品已做，但开源同类（Cline/Aider）靠本地+BYOK 规避，不算硬性落后。

---

## 3. 多智能体

### 业界普遍水平

- **subagent / spawn**：Claude Code `Agent` 工具派生 subagent，**每个独立上下文窗口 + 专属 system prompt + 工具集 + 权限**；后台 subagent 在 2026 中成为默认行为 [atticusli.com]。Codex 内置 `default/worker/explorer` 子代理 + TOML 自定义 + `spawn_agents_on_csv`，**subagents GA（2026-03-14），最多 8 并行** [morphllm.com, codex.danielvaughan.com]。
- **并行任务**：Antigravity 桌面端最多 **5 个并行自主 agent** + Mission Control 调度；CLI 异步多 agent [aitooltier.com, agentpedia.codes]。Cursor Agents Window 经 git worktree 最多 8 并行 + `/best-of-n` + nested subagents [learnagent.org, vibecoding.app]。Claude Code **Dynamic Workflows**（v2.1.154，2026-05-28）可在后台编排数十到上百 agent [learnagent.org]。
- **编排模式**：Claude Code **Agent Teams**（协调式，共享 task list + IPC 消息 + 依赖跟踪）[besthub.dev]。OpenAI Agents SDK **handoffs** 做 agent 间切换；Codex 经 **Agents SDK + Codex-as-MCP-server** 做层级编排（PM/设计/开发/测试）[codex.danielvaughan.com]。框架侧：LangGraph supervisor、CrewAI 角色协作、AutoGen 会话式、Google ADK 原生 A2A [langfuse.com, agentlist.top]。
- **agent 间通信协议**：A2A 1.0（见第 9 节）是跨厂商标准；厂商内多用私有 IPC/消息总线。

### 必备 / 加分

- ✅ **必备**：subagent 派生（独立上下文）+ 后台并行 + 至少一种编排（manager/worker 或 team）。
- ⚠️ **加分**：跨进程/跨厂商 A2A 协作、swarm 模式（basilisk-labs/codex-swarm）、best-of-n 自评估。

---

## 4. 可靠性工程

### 业界普遍水平

- **Checkpoint + rewind**：Claude Code 每次工具调用建隐式 checkpoint，`/rewind`（双击 Esc）可把**对话 + 代码**回滚到任意点；局限：只覆盖 Claude 自身文件编辑，**Bash 副作用/DB/部署不计入** [quidproquo.cc, atticusli.com]。这是目前 coding agent 最成熟的「断点回退」形态。
- **崩溃恢复 / 幂等 / 重试**：Claude Code `--max-turns` 设硬上限防失控循环 [yottadynamics.com]。OpenHands **事件流（EventLog）append-only、可重放、可调试**（V1 架构），自带 **stuck detection** 防死循环 [dev.to openhands]。Codex `update_plan` 工具 + 沙箱重试。
- **可观测性**：Codex 支持 **OpenTelemetry 审计导出** [agenticindex.io]。框架侧 LangGraph/LangSmith、OpenAI Agents SDK 内置 tracing、Langfuse 统一 trace（覆盖 LangGraph/OpenAI/Claude/Google ADK）[langfuse.com]。LangGraph **checkpointing + time-travel debugging**（回放任意一步）[pickaxe.co]。
- **审计日志**：Claude Code hook（`PostToolUse` 写 audit.log）、Codex OTel 审计导出、企业版（Copilot Enterprise/GitHub）强制审计日志 [mazdek.ch compliance]。

### 必备 / 加分

- ✅ **必备**：checkpoint/rewind 或等价回滚 + 会话持久化恢复 + 审计日志 + trace（至少能看每步工具调用）。
- ✅ **建议**：可重放事件流（OpenHands 模式值得借鉴）、max-turns 预算阀、stuck detection。
- ⚠️ **加分**：time-travel 逐节点调试（LangGraph 领先）、OTel 原生导出。

---

## 5. 工具生态

### 业界普遍水平

- **MCP**：已成为 agent↔tool 事实标准。Claude Code 是 MCP host；Codex 支持 MCP（含并行工具调用 + Codex MCP Server）；Antigravity/Cursor/Gemini 均支持。MCP **2026-07-28 发布无状态核心 RC**（详见第 9 节），月下载 4 亿+、约 18,850 个服务器 [modelcontextprotocol.io, it-blue.com]。
- **内置工具集**：Claude Code = Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch/AskUserQuestion/**Monitor**（后台事件流回会话）[claude agent-sdk overview]。Codex = `shell`/`update_plan`/`web_search` + MCP [openai.com agent-loop]。
- **自定义工具 / hooks**：Claude Code hooks（PreToolUse/PostToolUse/Stop/SessionStart/SessionEnd/UserPromptSubmit），组织可把安全 hook 放进 `.claude/settings.json` 统一生效 [aiwiki.ai]。Codex lifecycle hooks [agenticindex.io]。Antigravity hooks 保留 [agentpedia.codes]。
- **Skills / 插件**：Claude Code **Skills**（SKILL.md，2025-10-16 发布，progressive disclosure，YAML frontmatter + 正文）+ **Plugins marketplace** 打包 skills/subagents/hooks/MCP [aiwiki.ai, blog.csdn claude extension]。Codex **skills + plugin marketplace**（v0.131）+ `skills.sh` 成分发渠道 [codex.danielvaughan.com]。Antigravity Agent Skills、OpenHands Microagents（`.openhands/microagents/`）[devradar openhands]。
- **LSP / 浏览器 / Computer use**：Claude Code **Computer use（研究预览，2026 中）** 补 GUI 验证短板；OpenHands 内置浏览器验证 UI；Codex 有 Browser + Computer use + 浏览器扩展 [agenticindex.io]。LSP 集成在 CLI agent 中仍偏弱（Zed AI / Cursor 代码图更强）。

### 必备 / 加分

- ✅ **必备**：MCP 客户端 + hooks + skills/插件机制 + Web 搜索/抓取 + 文件/命令工具。
- ✅ **建议**：插件市场（团队分发是规模化关键）。
- ⚠️ **加分**：Computer use / 浏览器视觉验证（Claude Code/Codex 已做，但多仍是预览）、LSP 深度集成、MCP Apps（2026-07-28 新增的 server-rendered UI 扩展）。

---

## 6. 评估与质量

### 业界普遍水平

- **Benchmark**：SWE-bench Verified / Pro、Terminal-Bench 2.0、CursorBench、τ-bench 是主流。2026-07 实测：Claude Opus 4.8 → SWE-bench Verified **88.6%**、Pro **69.2%**；GPT-5.5 → Verified **88.7%**、Terminal-Bench **82.7%** [morphllm.com, hqwc.cn]。OpenHands + Sonnet 4.5 ≈ 77%，自称同日解决 87% bug 工单 [choose-your-ai, aicoolies.com]。
- **Eval harness**：LangGraph/Langfuse 做生产 eval+debug；Google ADK 内置 evaluations；OpenAI Agents SDK 内置 eval；OpenHands 有 OpenHands Index 跨模型基准 [langfuse.com, aicoolies.com]。
- **成本可观测**：各家均有 token 用量面板；agenticindex.io 做横向 vendor 比较；企业计费已从「按人头」转向「按 API token」（Anthropic/OpenAI 2026 中）[learnagent.org]。
- **回归 / A-B**：多模型并行评估（Cursor `/best-of-n`、Codex best-of-n）属工程实践，框架侧有 evaluation 模块；严格 A/B 多为厂商内部。

### 必备 / 加分

- ✅ **必备**：至少接入 SWE-bench/Terminal-Bench 类基准做自身能力回归 + token/成本可观测面板。
- ⚠️ **加分**：自建 eval harness 接 CI、best-of-n 自评估、τ-bench 类 agent 行为评测。

---

## 7. 工程化与企业特性

### 业界普遍水平

- **CI / 发布**：Claude Code headless `claude -p` + GitHub Actions + 定时任务；Codex `codex exec` + GitHub Action 非交互 CI/CD；OpenHands CLI/SDK 进 CI/CD [learnagent.org, aicoolies.com]。Claude Code 管理员版本控制 + rate limits 翻倍（2026-06）[learnagent.org]。
- **安全合规**：Codex `trust.openai.com` + 企业托管配置 + agent approvals security；Claude Code Enterprise **zero retention + EU 区域**（AWS Bedrock/Vertex EMEA）[mazdek.ch]。GitHub Copilot Enterprise 提供 SSO、审计日志、IP 赔偿 [mazdek.ch, bytepane.com]。Cursor Enterprise **Privacy Mode** [mazdek.ch]。
- **企业特性**：SSO/OIDC（Copilot Enterprise、Cursor Enterprise）、审计导出（OTel/审计日志）、策略引擎（Codex permission profile 继承、Claude Code 组织级 settings 下放到个人）[codex.danielvaughan.com, quidproquo.cc]。

### 必备 / 加分

- ✅ **必备**：headless/CI 模式 + 组织级配置下发 + token/成本上限 + 审计日志。
- ✅ **若面向企业则必备**：SSO/OIDC、zero-retention/数据驻留、审计导出、IP/责任条款。
- ⚠️ **加分**：SOC2 报告、策略引擎即代码、多区域数据驻留。

---

## 8. 2026 前沿趋势（做了是加分，不做不算落后）

1. **Agent 记忆标准化**：`AGENTS.md`（6 万+ 开源仓库，Linux Foundation Agentic AI Foundation 治理）、`llms.txt`（v1.7.0，2026-05，2,000+ 站点）、`CLAUDE.md`/`GEMINI.md`/`.cursor/rules` 收敛为「文件即 substrate」[llms-txt.io, clixlogix.com, danielvaughan llms]。**判定：正在成为标配边缘**，建议尽快支持读取 AGENTS.md/CLAUDE.md/llms.txt。
2. **Long-running agent**：Codex Goal mode（小时/天）、Antigravity 定时任务、Claude Code Monitor/后台 agent、OpenAI **Managed Agents**（单次 API 起隔离 Linux 沙箱、可恢复）[blog.google I/O 2026, codex.danielvaughan.com]。**判定：已成标配趋势**，后台/长任务能力必备。
3. **Computer use / 浏览器验证**：Claude Code computer use（研究预览）、Codex browser+computer use、Antigravity 内置 Chrome。**判定：加分**，但 GUI 验证是质量闭环关键缺口。
4. **RLVR / Verifiable Rewards**：编程天然适配「测试通过=奖励」。2026 出现 **Miles v0.1**（2026-08-18，LMSYS/RadixArk 开源 post-training，rollout+training+weight 闭环）、港大阿里 **ROLLART**、中科大 **Agent-R1 v2** [neodrop.ai, CSDN loop-engineering]。OpenAI 披露 3–7 人小团队 5 个月靠 Codex 生成约 100 万行生产代码 [CSDN loop-engineering]。**判定：前沿**，用于「产品自身进化」而非 harness 功能。
5. **Self-evolving agent**：Hermes Agent（Nous Research，2026-02，14 万★，完成任务写可复用 skill 自提升）、OpenClaw（10 万+★）[pickaxe.co]。**判定：前沿探索**。
6. **多模态 / 设计到代码**：Gemini 3.5 Flash（I/O 2026，~800 tok/s）、Claude Design（设计稿→可编辑前端→导出 Claude Code）、Antigravity 多模型路由（Gemini/Claude Opus 4.6/GPT-OSS）[blog.google, learnagent.org]。**判定：加分**。
7. **Spec-driven development**：AGENTS.md/Spec Kit + 规划-实现-验证闭环 + Devin/Copilot Workspace「Issue→plan→code→PR」[learnagent.org]。**判定：加分但快速普及**。

---

## 9. 标准与协议专项

- **MCP（Model Context Protocol）2026-07-28 RC**：
  - 最大修订：协议层**无状态核心**——移除 `initialize` 握手与 `Mcp-Session-Id`，每请求在 `_meta` 携带版本/客户端/能力，任意实例可处理，普通负载均衡即可横向扩展 [modelcontextprotocol.io]。
  - 新增 **Extensions 框架、Tasks（长任务）、MCP Apps（server-rendered UI）**；授权强化至 **OAuth 2.1**（`iss` 校验 RFC 9207），DCR 弃用改 Client ID Metadata Documents。
  - **弃用**：roots / sampling / logging / Dynamic Client Registration（12 个月弃用期）；JSON Schema 升 2020-12。
  - 生态：月下载 **4 亿+**（2026-07），~18,850 服务器，Linux Foundation 治理（OpenAI/Google/MS/Amazon 共同治理）[it-blue.com, besthub.dev]。
  - **判定：必备**——你的 harness 若自称支持 MCP，必须实现对 2026-07-28 无状态核心的兼容（旧 handshake 已不兼容）。

- **A2A（Agent-to-Agent）1.0**：
  - 2026-03-12 首个稳定版（部分来源称 2026-04 GA，150+ 组织支持，含 AWS/Cisco/Google/IBM/MS/Salesforce/SAP/ServiceNow）；v1.0.1 于 2026-05-26/28 [it-blue.com, zmiu.com]。
  - 核心 **Agent Card**（JSON，JWS 签名可验证身份）、task-based 交互、3 种绑定（JSON-RPC / gRPC / HTTP+JSON）、多租户 [it-blue.com]。
  - **判定：加分**——跨厂商 agent 协作标准，内部多 agent 用私有 IPC 即可，但对外互操作建议跟进。

- **AGENTS.md 约定**：
  - OpenAI 2025-08 创建，2025-12 移交 Linux Foundation Agentic AI Foundation；6 万+ 开源仓库；被 Codex/Cursor/Copilot/Gemini CLI/Jules/Devin/Zed/Warp/VS Code/Aider/goose/opencode 读取 [llms-txt.io, clixlogix.com]。
  - 与 `CLAUDE.md` 可 `@import` 互相引用；与 `llms.txt` 互补（前者管代码库，后者管文档）[llms-txt.io]。
  - **判定：正在变成标配**——建议 harness 至少读取 `AGENTS.md` + `CLAUDE.md` + 项目级指令。

- **llms.txt**：
  - v1.7.0（2026-05，Phase 6 标准化）；2,000+ 生产站点；Anthropic/Cloudflare/Vercel/Stripe/HuggingFace 发布；可选 `llms-full.txt` [danielvaughan llms, clixlogix.com]。
  - Shopify 2026-05 把 `/agents.md`（电商 agentic 契约）设为规范文件，与 llms.txt 并存 [weaverse.io]。
  - **判定：加分**（文档可发现性），但投入极低（半人日），建议发布。

---

## 10. 给你的优先级清单（自研 harness 补短板）

| 优先级 | 能力                                      | 当前业界基线                                      | 你若缺失则   |
| ------ | ----------------------------------------- | ------------------------------------------------- | ------------ |
| P0     | 分层常驻指令 + 自动压缩 + 会话持久化/恢复 | Claude Code CLAUDE.md/JSONL、Codex AGENTS.md/Goal | 明显落后     |
| P0     | 多档权限 + allow/deny + 危险命令拦截      | Claude Code 5 模式、Codex 沙箱审批                | 明显落后     |
| P0     | subagent 派生（独立上下文）+ 后台并行     | 双方 2026 均已 GA                                 | 明显落后     |
| P0     | checkpoint/rewind + 审计日志 + trace      | Claude Code /rewind、Codex OTel                   | 明显落后     |
| P0     | MCP 客户端（兼容 2026-07-28 无状态）      | 全行业标配                                        | 明显落后     |
| P1     | 沙箱执行（容器/微VM/seccomp）             | Codex/OpenHands/Devin 均有                        | 安全短板     |
| P1     | hooks + skills/插件 + 插件市场            | Claude Code/Codex/Antigravity                     | 工程化短板   |
| P1     | headless/CI 模式 + token 成本面板         | 全部支持                                          | 工程化短板   |
| P1     | 读取 AGENTS.md / CLAUDE.md                | 行业约定                                          | 兼容性短板   |
| P2     | 企业特性（SSO/审计导出/zero-retention）   | Copilot/Cursor/Claude Enterprise                  | 仅当面向企业 |
| P2     | Computer use / 浏览器验证                 | Claude/Codex 预览                                 | 加分         |
| P2     | A2A 跨厂商协作                            | 标准已 GA                                         | 加分         |
| P3     | RLVR / self-evolving / 记忆标准化协议     | 前沿                                              | 探索         |

---

## 来源链接

- Claude Agent SDK 概览：https://platform.claude.com/docs/en/agent-sdk/overview ｜ https://code.claude.com/docs/zh-TW/agent-sdk/overview
- Claude Code 工作原理（权限/checkpoint，2026-08）：http://quidproquo.cc/posts/tech/deep-deep/2026-08-26-claude-code-how-it-works-en
- Claude Code 通信套件（permission modes/rewind）：https://support.claude.com/en/articles/14555877-claude-code-communications-kit
- Claude Code 被忽略的新特性（auto/background subagent/rewind 局限）：https://www.atticusli.com/blog/posts/claude-code-features-worth-adopting
- Claude Code 终端深潜（权限/checkpoints/TASKS.md）：https://blog.yottadynamics.com/posts/claude-code-in-the-terminal/
- OpenAI Codex agent loop（shell/update_plan/MCP/AGENTS.md/沙箱）：https://openai.com/zh-Hant/index/unrolling-the-codex-agent-loop/
- OpenAI Codex vendor 页（沙箱/OTel/computer use/automations）：https://agenticindex.io/vendors/openai-codex
- Codex CLI State of Play 2026-05（Goal mode/subagents/plugin marketplace）：https://codex.danielvaughan.com/2026/05/22/codex-cli-state-of-play
- Google Antigravity 2.0 / I/O 2026（Managed Agents/SDK/并行）：https://blog.google/innovation-and-ai/technology/developers-tools/google-io-2026-developer-highlights/ ｜ https://agentpedia.codes/blog/google-antigravity-2-0-launch
- Gemini CLI → Antigravity 迁移（2026-06-18 切 consumer）：https://www.promptgenius.net/blog/gemini-cli-to-antigravity-migration-guide ｜ https://sureprompts.com/blog/antigravity-cli-prompting-guide
- OpenHands 架构深潜（EventLog/Condenser/Microagents/Docker 沙箱）：https://dev.to/truongpx396/openhands-deep-dive-build-your-own-guide-1al0 ｜ https://aicoolies.com/reviews/openhands-review
- AI coding agents 横向（Cursor/Claude/Codex/Devin/Aider/Continue）：https://learnagent.org/library/compare/ai-coding-agents-2026/ ｜ https://blog.prompt20.com/posts/ai-coding-agents-ultimate-guide/ ｜ https://vibecoding.app/ai-coding-agents
- Codex vs Claude Code 基准（2026-07）：https://www.morphllm.com/comparisons/codex-vs-claude-code ｜ http://www.hqwc.cn/news/152543.html
- 瑞士合规对比（SWE-bench/审计/数据驻留）：https://mazdek.ch/en/blog/ai-coding-assistants-cursor-claude-code-copilot-schweiz-2026
- 框架对比（LangGraph/CrewAI/OpenAI/Google ADK/MS Agent Framework/Mastra/Pydantic/smolagents）：https://langfuse.com/blog/2025-03-19-ai-agent-comparison ｜ https://nriglobe.com/business/agentic-ai-frameworks-2026 ｜ https://www.agentlist.top/en/articles/best-ai-agent-framework-2026 ｜ https://pickaxe.co/post/top-ai-agent-frameworks
- MCP 2026-07-28 RC（无状态核心/Extensions/Tasks/授权）：https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ ｜ https://it-blue.com/blog/mcp-a2a-protocol-layer ｜ https://zmiu.com/ai-agents-mcp-a2a-2026-guide
- A2A 1.0（Agent Card/JWS/绑定/治理）：https://it-blue.com/blog/mcp-a2a-protocol-layer
- AGENTS.md 指南（采用面/Linux Foundation/与 llms.txt 关系）：http://llms-txt.io/blog/what-is-agents-md ｜ https://www.clixlogix.com/knowledge-base-agentic-ai-strategy/
- llms.txt 规范（v1.7.0/采用）：https://codex.danielvaughan.com/2026/06/06/llms-txt-specification-codex-cli-machine-readable-documentation-agent-context ｜ https://weaverse.io/blogs/shopify-agents-md-llms-txt-theme-template-customization-may-28-2026
- 2026 趋势（RLVR/Miles v0.1/self-evolving/long-running）：https://neodrop.ai/post/3mVI5Uvok7T ｜ https://blog.csdn.net/m0_59164520/article/details/162014675 ｜ https://wallstreetcn.com/articles/3763033

---

_说明：本调研基于 2026-09-06 可检索的公开来源（官方文档、厂商博客、第三方横评）。部分基准数字来自社区横评，模型版本迭代快，引用时建议以厂商最新官方页复核。_
