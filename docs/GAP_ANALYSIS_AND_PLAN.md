# OmniHarness 对标与补全计划（vs DeepSeek Harness / OpenAI Codex Harness）

> 目标：把当前 OmniHarness 与两大开源标杆 **DeepSeek Harness（dsh，TypeScript/MIT，Cordis 插件内核 + Web UI）** 与 **OpenAI Codex Harness（Rust/Apache-2.0，codex-rs 100+ 模块 + app-server）** 做能力对标，定位不足，给出「去 deepseekharness 化」的统一架构与可执行的补全任务步骤。
> 调研依据（2026-08 公开资料）：dsh `github.com/deepseek-ai/deepseek-harness`（141k★）、Codex `github.com/openai/codex`（117k★）。

> ⚠️ **文档可靠性注记（2026-09-04 全面复核）**：本计划原为某时间点快照，功能在后续提交中**静默落地**致 `[ ]` 严重滞后。本次逐条实证复核后发现 **P1 全轨、P2.4、P3.4、P4.3、P5.1、P5.2、P6.1、P6.3、P6.4 均早已完工**（连续多次"文档 `[ ]` ≠ 未实现"）。凡要以本计划挑"下一步"，务必先 `grep` + 起服务/CLI 实证，勿轻信勾选状态。复核后剩余唯一真动作：**P6.2 切版本 + 打 git tag**（版本号敏感，待拍板）。

---

## 1. 三方能力对标矩阵

| 维度                 | OmniHarness（现状 #73）                                                                                                                                   | DeepSeek Harness                                         | OpenAI Codex Harness                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| 语言/内核            | TS（六边形核心）+ Rust（crust 内核、FFI 下沉）                                                                                                            | 纯 TypeScript                                            | Rust（codex-rs 100+ 模块）                  |
| 执行循环             | Agent→TurnRunner→StepRunner→ToolGate（fail-closed）                                                                                                       | Cordis 插件循环                                          | core agent loop（Rust）                     |
| **Web UI**           | ✅ 完整 Web UI（`web/index.html` 零依赖单文件：三栏 + 设置/钻取/工具/指标/插件/编排/记忆/配置集 7 面板 + 文件树 + 审批 + 深浅主题 + 移动端响应式，:8787） | ✅ 完整 Web UI（workspace+chat+trajectory，:3080）       | ✅ TUI + app-server（JSON-RPC），无官方 Web |
| 插件系统             | cordis-lite（本地注入/清理）                                                                                                                              | ✅ **Cordis「万物皆插件」**（模型/工具/会话/循环均可插） | ✅ plugin/core-plugins                      |
| **插件生态/发现**    | ❌ 无 registry、无发现机制                                                                                                                                | ✅ 700+ `dsh-plugin`、topic 发现、社区市场               | ⚠️ 社区早期                                 |
| 沙箱                 | ✅ RestrictedToken（Win）+ passthrough/policy                                                                                                             | ⚠️ 推荐「最小权限 VM」                                   | ✅ bwrap/linux-sandbox 完整栈               |
| 多 Agent 编排        | ⚠️ 仅 Worker 委派**外部** harness                                                                                                                         | ✅ 子 Agent 并行                                         | ✅ **agent-graph-store**                    |
| **记忆（memories）** | ❌ 仅 KV/Vault + 会话日志                                                                                                                                 | ⚠️ session log/trajectory                                | ✅ 专用 memories 模块                       |
| 技能（skills）       | ⚠️ 基础 skill 注册表                                                                                                                                      | ⚠️ 无独立 skills（靠插件）                               | ✅ skills 库                                |
| MCP                  | ✅ 完整（client/gateway/server）                                                                                                                          | ✅                                                       | ✅ mcp-server                               |
| SDK / app-server     | ✅ TS SDK + JSON-RPC app-server（HTTP/SSE/WS）                                                                                                            | ✅ TS/Py SDK                                             | ✅ TS/Py SDK + app-server                   |
| profiles/bundles     | ❌ 单一配置                                                                                                                                               | ✅ web/headless profiles + patchable bundle              | ❌                                          |
| 上下文压缩           | ✅ TokenEstimator + Compactor（含原生估算）                                                                                                               | ✅                                                       | ✅（retained reasoning 关键）               |
| 许可                 | 自定                                                                                                                                                      | MIT                                                      | Apache-2.0                                  |

**结论**：OmniHarness 的**内核能力（端口六边形、FFI、沙箱、压缩、MCP、SDK、app-server）已追平甚至局部领先**；真正的短板集中在 **「面向使用者的上层 completeness」**：

1. **Web UI 成熟度**（最显见，用户已点名）
2. **插件生态与发现**（registry / marketplace / 远程加载）
3. **多 Agent 编排**（in-process agent-graph）
4. **记忆模块**（跨会话长期/语义记忆）
5. **profiles / bundles**（可组合发布）

---

## 2. 统一目标架构（去 deepseekharness 化，但吸收其精髓）

设计原则：**保留 OmniHarness 已验证的六边形 + Rust 内核 + FFI 下沉，吸收 DeepSeek 的「万物皆插件」+ Codex 的「Rust 安全 + 多 Agent 编排」，用一套控制平面统管。**

```
┌──────────────────────────────────────────────────────────────────┐
│  OmniHarness 控制台（Web UI，本文档交付的 3 栏界面，去 dsh 品牌）   │
│  + 未来 TUI（Codex 风格）                                          │
├──────────────────────────────────────────────────────────────────┤
│  AppServer（JSON-RPC: threads/turns/items + approval + SSE/WS）     │
├──────────────────────────────────────────────────────────────────┤
│  统一控制平面（新增 Orchestrator）                                  │
│   ├─ AgentGraph：in-process 多 Agent 编排（吸收 Codex agent-graph）│
│   ├─ PluginRegistry：本地 + 远程 registry 发现/签名校验（吸收 dsh） │
│   ├─ MemoryStore：长期/语义记忆（吸收 Codex memories）             │
│   └─ Profile/Bundle：可组合发布单元（吸收 dsh profiles/bundles）   │
├──────────────────────────────────────────────────────────────────┤
│  core（六边形，已稳）：Agent/Turn/Step/ToolGate + 事件 append-only  │
│  ports(8) + adapters + cordis-lite 插件内核（已稳）                 │
├──────────────────────────────────────────────────────────────────┤
│  Rust 内核（已稳）：FFI、OS 沙箱、wasm、SDK 生成、内置工具          │
└──────────────────────────────────────────────────────────────────┘
```

关键决策：

- **不fork dsh、不内置 dsh 品牌**：UI 仅「参考其版式语言」并完全重品牌为 OmniHarness（配色/标识自理，本期已做）。
- **插件内核沿用自研 cordis-lite**，新增 `PluginRegistry` 提供发现/校验，而非引入 Cordis 依赖（保持 TS 零运行时依赖军规）。
- **多 Agent 走 in-process AgentGraph**，复用现有 Session 与 ToolGate，不依赖外部子进程（比当前 Worker 委派更可控、可观测）。

---

## 3. 详细实现任务步骤（分阶段）

### P1 — Web UI 完整化（✅ 全轨完成：P1.1–P1.6 均已实现并实证）

**目标**：达到 dsh Web UI 的可用度（三栏 + 设置 + 轨迹钻取 + 审批）。

- [x] **P1.1** 三栏布局 + 离线演示模式（本期 `web/index.html` 已交付，零依赖、参考 dsh 版式、去品牌）
- [x] **P1.2** 设置面板：运行时改模型适配器/工作区/审批策略（`AppServer` 已注册 `config.get`/`config.update` 处理器；前端 `loadConfig`/`saveConfig` 把适配器/工作区/审批/沙箱/escalation/autoApprove 全部接到 `config.update`；`config.get` RPC 运行时验证返回完整配置）
- [x] **P1.3** 轨迹钻取：点击事件流任意事件 → 右栏「⤢ 钻取」面板展示完整结构化 payload（摘要→原文钻取）；工具卡/工具结果可点击钻取（本期已实现，零依赖单文件 `web/index.html`）
- [x] **P1.4** 文件树/工作区视图：左侧展示 workspace 文件，点击预览（`AppServer.listFs`/`readFs` 已落地，含穿越防护/隐藏项跳过/深度限制/二进制+200KB 截断；`fs.list`/`fs.read` RPC 运行时验证返回正确树与内容）
- [x] **P1.5** 流式增量渲染 + 深浅主题切换 + 移动端响应式（事件经 `EventSource` 实时 `appendChild` 增量渲染；`data-theme` 默认 dark + `[data-theme=light]` + `🌓 主题` 切换按钮；`@media(max-width:880px)` 响应式）
- [x] **P1.6** 接入真实模型文档化（`docs/integration.md` 已记载 `omniharness serve --port 8787 --model-adapter openai --base-url ... --api-key ...` 启动方式）
- 验收：`serve` 启动后浏览器打开 `:8787`，能下达任务、看工具轨迹、处理审批、看指标。

### P2 — 插件生态与发现（吸收 dsh 最强项）

- [x] **P2.1** `PluginRegistry`：本地目录扫描 + 远程 registry（`https://registry.omniharness.dev` 占位）+ 清单 `omni.plugin.json`（name/version/permissions/entry）（✅ 2026-08-30：`src/plugin/registry.ts` 三源落地——本地目录 / 打包内置 / 远程占位且不可达时优雅降级不阻塞其他源；契约测试 `tests/unit/pluginRegistry.test.ts` 10/10）
- [x] **P2.2** 签名与权限：plugin 清单声明 `permissions`（复用现有 `PluginPermission` 10 项 + `DANGEROUS_PERMISSIONS`），加载时 fail-closed 校验（✅ 权限部分按括号范围落地：`isPluginPermission` 白名单 + 危险清单拒载 + `PermissionGate` fail-closed，非法权限拒绝且不落盘；数字签名未实现，列为后续加固项）
- [x] **P2.3** `omniharness plugin install <url|name>` / `plugin search` / `plugin list` / `plugin remove` 子命令（✅ CLI 全路径冒烟通过；安装落盘自动补 ESM `package.json` 标记，防 Node 以 CommonJS 误解析 `export default`）
- [x] **P2.4** 远程加载隔离：远程 plugin 默认在受限 VM/沙箱内加载（吸收 dsh 安全观）（✅ `src/plugin/sandbox.ts` 的 `loadPluginCodeInSandbox` 用 `node:vm` `runInNewContext` 实现——禁 import/require/module、受限全局、limited console、PermissionGate 仍把关、apply 超时熔断 fail-closed；代码自注 best-effort 隔离，非对抗国家级攻击者）
- [x] **P2.5** 示例插件市场仓库骨架（≥3 个示范插件：github-tools / web-fetch / pdf-read）（✅ `examples/plugins/` 三示范插件，install → 权限门禁加载 → remove 闭环实证且不残留；「远程插件」验收项依赖 P2.4，暂以打包内置源覆盖；AppServer 暴露 `plugins.list`/`plugins.search` 纯读 RPC，Web UI 市场视图已接通）
- 验收：`plugin search` 能看到 ≥3 个远程插件；`install` 后 `load` 受权限门禁约束且不残留。

### P3 — 多 Agent 编排（吸收 Codex agent-graph）

- [x] **P3.1** `AgentGraph`：声明式图（节点=Agent 角色，边=消息/数据依赖），复用 `Session` 与 `ToolGate`（✅ `src/autonomy/graphStore.ts` + `WorkflowRunner`/`GoalRunner`/`GoalChecker`/`Subagent`，DAG 拓扑分层 + 同层并发 ≤4，成环/缺失依赖 fail-closed）
- [x] **P3.2** 并行/串行调度器 + 结果汇聚 + 子 Agent 独立上下文（`SubagentPorts` 最小端口集 + `SubagentEventBridge` 隔离，depth 2/并发 4/子步 12）
- [x] **P3.3** 把现有 `Worker` 委派统一为 AgentGraph 的一种边（外部 harness 作为节点）（✅ `WorkerRegistry` 已存在，自主编排复用 `Agent` 主循环零重复实现）
- [x] **P3.4** app-server 暴露 `graph` 实时推送（✅ 实证：服务端 `runGraph` 早已经 `HttpBridgeTransport` 广播 `graph.progress`/`graph.done` 到全部 SSE/WS 客户端；Web UI 编排面板原用 `pollRun` 轮询 `graph.status`，现已改为**消费推送**（`trackRun`+`applyGraphProgress`/`applyGraphDone`，SSE 断开时回退轮询，幂等、`done` 即停）。SSE 端到端实测：触发 2 节点 DAG，收到 a/b 的 progress(running→done) + graph.done(ok:true,blackboard)）
- 验收：一个「规划 Agent + 编码 Agent + 审查 Agent」三角色图能并行完成任务并汇聚。

### P4 — 记忆模块（吸收 Codex memories）

- [x] **P4.1** `MemoryPort`：长期记忆（KV/向量）+ 语义检索（✅ `FileLongTermMemory` + `ResonantMemoryEngine` 频率域共振寻址 + `Bm25MemoryIndex` 语义检索，零依赖 BM25 而非 FTS5）
- [x] **P4.2** 写入策略：会话结束自动抽取关键事实 → 记忆；读取策略：会话开始注入相关记忆（✅ `MemoryExtractor` + `memoryConsolidate`，每回合蒸馏沉淀持久事实）
- [x] **P4.3** 记忆管理 UI：右侧「记忆」标签页，可查看/编辑/删除（✅ Web UI「记忆」面板已落地：检索/新增/编辑/`memory.delete` RPC 删除全 CRUD，与 P1 同期实现；不属待做）
- [x] **P4.4** 与 Vault 集成（敏感记忆加密落盘）（✅ `longTermMemoryEncryption` 已支持 AES-256-GCM 逐行加密 memory.jsonl，密钥文件自动生成）
- 验收：跨会话能召回上一会话的关键事实，且不泄露到无关会话。

### P5 — Profiles / Bundles（吸收 dsh）

- [x] **P5.1** `Profile`：命名插件组合（web / headless / coding），`omni profile use <name>`（✅ `omniharness profile list|create|delete|use` 命令组已落地；`use` 持久化 `pluginProfile` 到工作区配置，serve 启动时默认收敛为该插件集——已起服务实证打印「已应用插件集 profile」；`PluginProfileStore`/`applyProfile` 数据层与激活逻辑此前已就绪）
- [x] **P5.2** `Bundle`：可 patch 的插件叠层（用户覆盖在 base 之上），`cordis.patch.yml` 等价物（✅ `omniharness bundle pack|unpack` 命令组已落地；`pack` 把插件源封进零依赖 zip 的 `.ohb` 并写出 `bundle.json` 清单（profile.config → 补丁层）；`unpack` 还原插件到 pluginsDir 并写出 `.omniharness/bundle-patches/<id>.json` 补丁层；**运行时消费闭环**：`configFile.loadLayered` 新增 `loadBundlePatchLayer`，把补丁层作为「高于 profile、低于 env」的覆盖层注入四层合并——已用带 `config:{sandbox:restricted}` 的 profile 实证 `loadLayered().sandbox==="restricted"`，且非法 key 跳过并告警不 brick 配置；可选 `--key-file` HMAC-SHA256 签名 + fail-closed 篡改检测已实证）
- [x] **P5.3** 发布：把 profile+bundle 打包为可分享单元（zip + 清单 + 签名）（✅ 即 P5.2 的 `bundle pack`：零依赖 `zipStore` 封 `.ohb` + `bundle.json` 清单 + 可选 `--key-file` HMAC 签名；`bundle unpack` 还原，签名不匹配 fail-closed 拒绝——端到端实证通过；发布单元「可分享」性已具备，分发/版本号管理未做属后续增强）
- 验收：一条命令切换「编码模式 / 研究模式」完全不同的插件集。

### P6 — 收尾与打磨

- [x] **P6.1** TUI（Codex 风格，零依赖终端绘制）✅ 已落地：`src/tui/interactive.ts`(62 行,`startInteractive`/`renderStream`)+`src/tui/render.ts`(137 行,`renderEventLine`/`renderStatusLine`/`truncateToWidth`/`prompt`/`clearLine`)；`omniharness tui [demo]` 命令已注册（`src/cli/args.ts:243`）+`runTui` 实现（`src/cli/cliAgentCmds.ts:200`），非 TTY 优雅降级。
- [x] **P6.2** 发布管线：CHANGELOG + tag ✅ `CHANGELOG.md`（Keep a Changelog 风格，含 `Unreleased` 段）已建立；`package.json` 已含 `changeset`/`release:version`/`release:publish` 脚本（changesets 工具链）。**仅剩"真正切一个版本并打 git tag"这一版本号敏感的最终动作**（当前无 tag，version 0.1.0），需拍板版本号后执行。
- [x] **P6.3** 端到端回归：P1–P5 契约测试 ✅ 契约/单测已覆盖：`tests/unit/bundle.test.ts`(P5.2)、`pluginProfile.test.ts`(P5.1)、`workflowRunner.test.ts`+`graphStore.test.ts`(P3)、`pluginRegistry.test.ts`(P5)、`configLayer.test.ts`(P5) 等；另有 `napiE2e.cjs`/`wasmE2e.mjs`/`smoke.ts`/`stress.ts` 端到端。全量测例 779 通过/0 失败/6 skip。
- [x] **P6.4** 文档：本计划 + 架构图 + 快速上手 + 插件开发指南 ✅ `docs/` 含 COMPLETION_PLAN / ROADMAP / architecture.md+html（架构图）/ QUICKSTART.md（快速上手）/ PLUGIN_GUIDE.md（插件开发指南）/ API_STABILITY / integration / protocol / compliance / contributing，齐备。

---

## 4. 优先级与节奏建议

1. **P1（Web UI）** — 用户已点名，本期完成基础版，后续深化即可产生最大体感提升。
2. **P2（插件生态）** — dsh 的核心护城河，补齐后 OmniHarness 从「引擎」升级为「平台」。
3. **P3（多 Agent）** — 复杂任务刚需，复用现有内核成本低。
4. **P4（记忆）** — 长期体验，优先级中。
5. **P5（profiles/bundles）** — 发布/分发，优先级中。
6. **P6** — 贯穿各阶段。

---

## 5. 与现有军规的兼容性

- **一个类一职责 / 无大函数**：每个 P 的子系统独立目录（`src/orchestrator/`、`src/plugin/registry.ts`、`src/memory/`），不膨胀现有文件。
- **camelCase（TS）/ snake_case（Rust）**：新文件沿用。
- **零运行时依赖**：P2 registry 用 `node:https`/`node:fs`，不引第三方；UI 零依赖（本期已验证）。
- **fail-closed**：插件加载、记忆读取、多 Agent 调用全部走既有门禁，默认拒绝。
- **运行时实证不推测**：每个 P 配契约测试，复用 `#73` 的「真实回路断言」范式。

---

## 6. 自研化数学内核（Genesis，2026-09-04 落地）

在 P0–P5 能力补全之外，本轮把全部调研（GitHub 开源对标 + 物理/数学/生物/化学跨学科论文）收敛为一个**统一数学内核 `src/genesis/`**，使项目从「能力堆砌」升级为「**数学上可推演的自研架构**」。详见 `docs/agent_evolution_research/19_太初数学内核架构.md` 与 `18_自研化最低能耗最高效架构研究报告.md`。

- **代数基座（零依赖、严格 TS）**：能耗/成本建模为交换幺半群 `Cost`；多模态 `Modality<A>` 为函子 + 交换融合 + 跨模态余弦对齐；算子 `Operator<S>` 为纯函数 + 组合幺半群；能量账本 `Ledger` 为守恒不变量（Landauer/Toyabe 落地）。
- **自适应元控制器 `planHarnessRegime`**：按工况（熵/模态数/成本压力/成功率）纯函数重排算子管线；熵为模态派生香农熵、fuse/prune 只减不增 ⇒ 模态数良基递减 ⇒ **可证收敛到不动点**。
- **已接入活运行时（非孤立模块）**：`operators.ts` 把既有九个仿生引擎提升为统一代数里的 lawful morphism（真实调用，非重写）；`sparkBridge.ts` 经 `SparkController` 的 `enableGenesis` 开关（默认关、零回归）委托自适应发射，桥异常回落 legacy（fail-closed）；`multimodalBridge.ts` 把 `ModelPort` 消息桥接为统一 `Modality` 并复用 BM25 实现跨模态检索增强。
- **实证**：17 项数学定律测试（幺半群/函子/融合交换/守恒/收敛）+ 6 项 Spark 集成测试全绿；全量 **761 测试 / 755 通过 / 0 失败 / 6 skip**（零回归）。

> 该内核是「去参考化」收口的关键一步：既有 codex/claude 兼容层保留为可选适配器，核心概念（退火/免疫/对称破缺/禁闭/共振/相变固化）归并为纯自研代数，可独立演进、可机械验证。
