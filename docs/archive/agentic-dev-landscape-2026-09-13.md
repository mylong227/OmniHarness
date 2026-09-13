# AI Coding-Agent / Agentic-Dev-Tool Landscape — Feature-Gap Analysis (Sept 2026)

_Audience: OmniHarness (TypeScript + Rust agent harness for autonomous coding). Sources are GitHub repos and 2026 vendor/community write-ups; vendor-reported benchmark numbers are flagged. Where a 2026 detail is uncertain I say so._

## (a) Project characterizations

**OpenAI Codex CLI** — `github.com/openai/codex` (Rust sibling `github.com/openai/codex-rs`). Single-binary Rust CLI on GPT-5.x. Best known for a rigorous, composable **safety model**: orthogonal `sandbox_mode` (read-only / workspace-write / danger-full-access) × `approval_policy` (untrusted / on-request / never / granular), plus per-profile permission blocks and a `auto_review` "guardian" subagent. Supports `model_reasoning_effort`, `config.toml`, `AGENTS.md`, `codex exec` headless, `codex mcp`, and tool-search to limit context. Rust tags at v0.150.x (Aug 2026).

**Claude Code / Claude Agent SDK** — `github.com/anthropics/claude-code`; SDK `@anthropic-ai/claude-agent-sdk` (TS + Python). Node CLI + library. Best known for the **deepest subagent + hooks + MCP stack**: background subagents (nested 3 layers), Agent Teams, June-2026 Dynamic Workflows (fan-out of hundreds), 12+ lifecycle hooks, 4 permission modes plus parameter-level `Tool(param:value)` rules and a hard-deny classifier, skills/plugins, `/loop` cron, Bedrock/Vertex/Foundry routing, and 1M-token context. Reads `CLAUDE.md` (and `AGENTS.md`).

**Gemini CLI** — `github.com/google-gemini/gemini-cli` (Apache-2.0, Node). Best known for **strong default OS sandboxing** (Docker / gVisor / LXC / bubblewrap+seccomp) and native **multimodal** input (`@image`, `@pdf`) on a 1M window. Reads `GEMINI.md`; MCP client; Flash/Pro model routing. Lighter on subagents (added a codebase-investigator subagent + Jules/Conductor/Maestro extensions) and has no native skills/hooks system. ~103k stars, v0.42/0.43.

**OpenHands** — `github.com/All-Hands-AI/OpenHands` (formerly OpenDevin; Python+TS). Best known as a **full autonomous platform**: Docker-isolated event-stream agent, the "Resolver" that auto-fixes GitHub issues into PRs, **microagents** (repo/keyword/org Markdown personas), multi-agent delegation (Delegator → Browsing/RepoStudy/Verifier), CLI/GUI/Cloud/SDK surfaces, BYOK. v1.7.0 (May 2026), ~72k stars.

**Aider** — `github.com/Aider-AI/aider` (Python, Apache-2.0). Best known for **git-native transactional edits** (every change auto-committed) and the **repo-map**: a tree-sitter AST + PageRank graph that gives the model structural context without dumping files. LiteLLM spans 100+ models; architect mode splits planner/editor models; multiple edit formats; `/web`, voice, watch mode; own polyglot leaderboard. ~46k stars.

**Cline** — `github.com/cline/cline` (VS Code ext, Apache-2.0). Best known as the **high-adoption open IDE agent**: Plan/Act loop, BYOK (OpenRouter/Ollama/Bedrock/Vertex/Azure), MCP, checkpointing, configurable auto-approve, plus a CLI. 5M+ installs. (Roo Code, `github.com/RooVetGit/Roo-Code`, was archived 2026-05-15; Kilo Code is its maintained successor.)

**Goose** — `github.com/aaif-goose/goose` (formerly `block/goose`; Apache-2.0, Rust CLI + desktop). Best known for **model-agnostic "recipes"** (YAML workflows with steps/retry/params) and a deep MCP ecosystem (70+ first-party extensions + MCP Apps). Four exec modes (Autonomous/Manual/Smart-approval/Chat), parallel subagents, an "adversary reviewer," and Linux-Foundation (AAIF) governance since Apr 2026. v1.46.0.

**Amp** — `github.com/sourcegraph/amp` (proprietary; CLI + VS Code/Cursor/Windsurf). Best known for **frontier-first autonomy with zero-markup PAYG**: four effort modes (low/med/high/ultra), parallel subagents, remote "orbs," MCP client, plugins, and Sourcegraph's Librarian code-graph. Enterprise tier adds SSO, audit logs, SOC 2. Not open source.

**Qwen Code** — `github.com/QwenLM/qwen-code` (Apache-2.0, TS; fork of Gemini CLI). Best known for being a **provider-flexible multi-agent CLI**: Qwen3-Coder-480B default but also OpenAI/Anthropic/Gemini/Vertex/Ollama; Auto-Memory, Auto-Skills, SubAgents, Agent Teams, MCP, daemon mode (`qwen serve`) + TS/Py/Java SDKs, VS Code/Zed/JetBrains. v0.18 (Jun 2026), ~26k stars.

**Continue** — `github.com/continuedev/continue` (Apache-2.0; VS Code/JetBrains/CLI `cn`). Best known as the **BYO-model IDE assistant** with agent mode, MCP, skills, subagent delegation, and `@Codebase/@Docs` context providers. Acquired by Cursor in 2026; repo reached final 2.0.0 (read-only) Jun 2026. ~35k stars.

**Kilo Code** — `github.com/Kilo-Code/kilo-code` (Apache-2.0 ext + MIT CLI; rebuilt Apr 2026 on the OpenCode server). Best known for **5 agent modes (Ask/Architect/Code/Debug/Orchestrator) + Agent Manager** running parallel agents across git worktrees, 500+ models, MCP marketplace, JetBrains + CLI coverage. ~26k stars / 3M users.

**Cursor** — `cursor.com` (proprietary VS Code fork). Best known for the **Agents Window** (up to 8 parallel agents in isolated Ubuntu VMs), Composer multi-file edits, background agents, Design Mode (annotate UI screenshots), Automations triggered from Slack/Linear/GitHub, and broad multi-model support.

**Zed** — `github.com/zed-industries/zed` (Rust/GPUI, GPLv3). Best known for **raw editor speed** and an open-standards agent stance: it is an **ACP (Agent Client Protocol) host** that runs external agents (Claude Code, Codex CLI, Gemini CLI, OpenCode) as first-class processes, plus native MCP and `spawn_agent`.

**Windsurf / Devin Desktop** — `windsurf.com` (now Cognition; proprietary). Best known for **Cascade** (flow-aware, persistent memory, repo-scale RAG context) and, post-merger, embedding Devin cloud VMs; ACP host; FedRAMP High.

**SWE-agent** — `github.com/SWE-agent/SWE-agent` (MIT, Python+Pydantic). Best known for the **Agent-Computer Interface (ACI)** research design and the SWE-bench evaluation harness; Docker isolation via SWE-ReX, LiteLLM 100+ models, EnIGMA CTF mode, trajectory logging, RetryAgent+reviewer loop. Now in maintenance mode (maintainers recommend the lighter `mini-swe-agent`).

**OpenClaude** — `github.com/gitlawb/openclaude` (MIT, Node; note: name collides with Anthropic's product). A model-agnostic **open Claude-Code alternative**: terminal agent loop, 7+ provider families, repo-map + LSP diagnostics, session branch/rewind, headless gRPC, MCP, skills, fine-grained agent routing. ~30k stars (2026). _(The user's "OpenCLA (various)" likely refers to this open-Claude-Code family; I flag the naming ambiguity.)_

**Protocols / SDKs (2026 newcomers):** OpenAI Agents SDK (`github.com/openai/openai-agents-sdk`, GA Mar 2026; handoffs, guardrails, tracing, adopted MCP); Anthropic Claude Agent SDK (above); Google ADK (`github.com/google/adk-python`, native **A2A**, Python/TS/Java/Go); **A2A** (`github.com/google/A2A`, Agent-to-Agent, consolidated under the Linux Foundation with ACP); **MCP** (`modelcontextprotocol.org`, Anthropic's tool protocol, 200+ server implementations — the de-facto "USB-C" of agent tools); **AGENTS.md / agents.toml** conventions (Codex/OpenAI read `AGENTS.md`; OpenAI contributed it to the AAIF). **ACP** (Zed/JetBrains) is a separate _agent-connection_ protocol from A2A.

## (b) Capability matrix

Legend: ✅ first-class · ◐ partial/limited · — absent/unreported · ? uncertain.

| Capability               | Codex                       | Claude Code                              | Gemini CLI               | OpenHands                | Aider                      | Cline                       | Goose                  | Amp                 | Qwen               | Continue           | SWE-agent            |
| ------------------------ | --------------------------- | ---------------------------------------- | ------------------------ | ------------------------ | -------------------------- | --------------------------- | ---------------------- | ------------------- | ------------------ | ------------------ | -------------------- |
| Multi-model / provider   | ◐ OpenAI+compat BYOK        | — Claude only (+Bedrock/Vertex)          | — Gemini/Vertex          | ✅ BYOK many             | ✅ LiteLLM 100+            | ✅ 300+ (OpenRouter/Ollama) | ✅ 15+                 | ✅ GPT/Claude       | ✅ multi           | ✅ 30+             | ✅ LiteLLM           |
| Reasoning-effort control | ✅ `model_reasoning_effort` | ✅ effort param + thinking               | ◐ thinking models        | ◐ model-dep              | ◐ architect split          | ◐ model                     | ◐ model                | ✅ 4 effort modes   | ◐ model            | ◐ model            | ◐ model              |
| Subagent / multi-agent   | ◐ guardian reviewer         | ✅ teams + dynamic workflows             | ◐ subagent/Jules/Maestro | ✅ delegator+microagents | ◐ 2-model architect        | ✅ Orchestrator/worktrees   | ✅ parallel            | ✅ parallel+Puck    | ✅ SubAgents/Teams | ◐ delegation       | ◐ RetryAgent         |
| Workflow / DAG           | ◐ exec scripts              | ✅ dynamic workflows+hooks               | ◐ Conductor              | ✅ automations           | —                          | ◐ modes                     | ✅ Recipes (YAML)      | ✅ plugins          | ✅ /loop /batch    | ◐ skills           | ◐ YAML agent         |
| Long-term memory         | ◐ AGENTS.md+resume          | ✅ user/project/local                    | ◐ GEMINI.md+/memory      | ◐ microagents            | ✅ repo-map(graph)         | ◐ rules                     | ✅ memory ext          | ✅ persistence      | ✅ Auto-Memory     | ✅ @Codebase/@Docs | ◐ history proc       |
| Context compaction/eng   | ✅ tool-search              | ✅ 1M ctx mgmt                           | ✅ /compress 1M          | ◐ event-stream           | ✅ repo-map+`--map-tokens` | ◐                           | ◐                      | ✅ thread compact   | ◐                  | ✅ providers       | ✅ LastN/cache       |
| Tool sandboxing          | ✅ landlock/seccomp+net-off | ◐ permission-based (OS sandbox limited?) | ✅ gVisor/LXC/seccomp    | ✅ Docker                | — (git only)               | — approval only             | ✅ FS/network restrict | ✅ orbs sandbox     | ◐                  | —                  | ✅ Docker SWE-ReX    |
| Permission / approval    | ✅ granular+profiles        | ✅ 4 modes+param rules                   | ◐ sequential/—yolo       | ◐ confirm mode           | —                          | ✅ auto-approve             | ✅ 4 modes             | ✅ policy plugins   | ✅                 | ✅ modes           | ◐ YAML               |
| MCP client & server      | ✅ client                   | ✅ deepest (200+)                        | ✅ client                | ✅                       | — (3rd-party)              | ✅ marketplace              | ✅ 70+ +Apps           | ◐ client only       | ✅ client+host     | ✅                 | —                    |
| A2A / agent interop      | —                           | ◐ ACP only                               | —                        | —                        | —                          | —                           | ◐ ACP                  | —                   | —                  | —                  | —                    |
| Skill / plugin system    | ✅ skills                   | ✅ skills+plugins+hooks                  | ◐ experimental           | ✅ microagents           | —                          | ◐ rules/modes               | ✅ Recipes+ext         | ✅ plugins          | ✅ Auto-Skills     | ✅ skills          | ◐ tool bundles       |
| Native app / CLI / web   | CLI+TUI                     | CLI                                      | CLI                      | ✅ CLI/GUI/Cloud/SDK     | CLI                        | IDE+CLI                     | ✅ desktop+CLI+API     | ✅ CLI+web+orb      | ✅ CLI+IDE+daemon  | IDE+CLI            | CLI/API/web          |
| Enterprise SSO/audit     | ?                           | ◐ managed settings                       | ?                        | ✅ SAML/VPC              | —                          | ◐ Enterprise                | ◐ AAIF gov             | ✅ SSO+audit+SOC2   | ?                  | ✅ SSO/OIDC        | —                    |
| Agent identity / signing | —                           | —                                        | —                        | —                        | —                          | —                           | —                      | —                   | —                  | —                  | —                    |
| Autonomous loops         | ✅ exec                     | ✅ teams+reflect                         | ◐ Jules                  | ✅ Resolver+self-improve | ✅ watch+self-heal         | ✅                          | ✅ autonomous          | ✅ self-schedule    | ✅ /loop           | ◐                  | ✅ retry+reviewer    |
| Multi-modal input        | ✅ vision (GPT-5)           | ✅ image tools                           | ✅ @image/@pdf           | ✅ browser+image         | ✅ /add image              | ✅                          | ◐                      | ✅ image            | ✅                 | ◐                  | —                    |
| Benchmarks / eval        | ✅ Terminal-Bench           | ✅ skill-eval loop                       | ✅ SWE-bench             | ✅ SWE-bench             | ✅ polyglot leaderboard    | —                           | —                      | —                   | ✅ SWE-bench       | —                  | ✅ SWE-bench harness |
| Cost / token budget      | ✅ BYOK+budgets             | ✅ SDK credit pool                       | ◐ free tier              | ◐                        | ✅ cost-transparent        | ✅ routing tiers            | ✅ Smart approv        | ✅ zero-markup PAYG | ◐ free tier ended  | ✅ BYO             | ✅ $3/instance cap   |

IDEs (Cursor/Zed/Windsurf) add: parallel background agents + MCP + ACP (Zed/Windsurf/Devin), persistent memory (Windsurf), multi-model (Cursor). They are proprietary and out of OmniHarness's open-source scope but set the UX bar.

## (c) Notable patterns OmniHarness could learn from

1. **Orthogonal sandbox × approval (Codex).** Model containment (filesystem/network) and human approval as two independent axes, composed, with named profiles (`read-only`/`:workspace`/`:danger-full-access`) and domain allowlists. This is the cleanest security design and maps well to a TS/Rust harness — use landlock/seccomp on Linux, macOS seatbelt, Windows RestrictedToken (Codex/Gemini lead here; Claude Code is weaker).
2. **Repo-map / graph context (Aider + SWE-agent history processors).** Tree-sitter AST → PageRank symbol ranking → bounded token budget beats naive RAG for code. First-class context compaction (`--map-tokens`, LastN/cache) is a differentiator worth building in.
3. **Subagents with isolated context + tool scoping (Claude Code).** Each subagent gets its own window, tools, model, and `maxTurns`; orchestration moves _outside_ the conversation (Dynamic Workflows). OmniHarness (TS) can mirror this with typed agent definitions.
4. **MCP as the tool layer, ACP as the agent-connection layer.** Adopt MCP (200+ servers exist) for tools; consider ACP to let external agents plug into a UI. A2A is still immature in harnesses — a gap/opportunity.
5. **Recipes / skills as portable YAML+Markdown (Goose, Claude Code, Qwen).** Shareable, version-controllable workflow definitions lower the cost of new capabilities. Combine with `AGENTS.md`/`agents.toml` provenance.
6. **Transactional git commits (Aider) + permission param rules (Claude Code).** Atomic, semantically-messaged commits give auditability and `git bisect` leverage; `Tool(param:value)` deny rules give surgical policy.
7. **Explicit effort/budget knobs (Codex `reasoning_effort`, Amp effort modes, SWE-agent $/instance cap).** Cost governance is a product feature, not an afterthought.
8. **Autonomous self-improvement loop (OpenHands ~20% self-authored commits).** A measurable "agent evolves the harness" signal — a stretch goal for OmniHarness.

**Gaps across the field (opportunities):** agent identity / cryptographic signing is essentially absent everywhere in 2026; true vector/semantic long-term memory beyond repo-maps is rare; A2A interoperability is thin in CLI harnesses; enterprise SSO/audit is mostly missing from open tools (Amp/Continue/OpenHands are exceptions).

---

## 中文简要总结

截至 2026 年 9 月，编码智能体生态已收敛到几类原语：状态图/子智能体、MCP（工具层事实标准，200+ 服务器）、ACP（智能体连接层，Zed/Windsurf 采用）、A2A（跨厂商互操作，仍不成熟）。**Codex CLI** 的"沙箱×审批"正交安全模型与推理强度控制最严谨；**Claude Code** 的子智能体/钩子/MCP 栈最深；**Aider** 的 repo-map 图上下文与成本透明最佳；**OpenHands** 是完整自主平台；**Goose/Qwen/Kilo/Cline** 在开源多模型与 IDE 代理上领先；**Gemini CLI** 默认沙箱与多模态最强；**SWE-agent** 仍是基准/eval 参考实现。对 OmniHarness（TS+Rust）最值得借鉴的是：可组合沙箱+审批、AST 图上下文压缩、隔离上下文的子智能体、MCP+ACP 双协议、YAML/Markdown 技能、显式成本/预算旋钮。全行业普遍缺失**智能体身份/加密签名**与成熟 **A2A**，是差异化空白点。
