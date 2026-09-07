# OmniHarness 调研差距清单与补全计划（2026-09-01）

> 依据：本轮对 **DeepSeek Harness（dsh）**、**OpenAI Codex Harness**、**OpenCode / Aider / Goose-Block** 的重新调研与对标。
> 目标：把"能力已对齐 codex"推进到"像 codex 一样独立可用、且有完整 Web UI 工作台"，并明确 UI 实现路线。

---

## 0. 调研来源与核心结论

| 来源                       | 关键能力                                                                                                             | 对 OmniHarness 的启示                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **DeepSeek Harness (dsh)** | TS/Cordis 插件内核 + **完整 Web UI**（`apps/web` + `packages/client/ui-*` 组件库）+ 700+ 插件生态 + profiles/bundles | Web UI 版式语言、插件生态/发现是标杆 |
| **OpenAI Codex**           | Rust 内核 + TUI + app-server(JSON-RPC) + **agent-graph-store** + dedicated **memories**                              | 多 Agent 编排、长期记忆是标杆        |
| **OpenCode (Go)**          | 95% 窗口自动压缩、repo map、声明式 agents、snapshot/revert                                                           | 长会话健壮性、会话可回滚             |
| **Aider**                  | git 自动提交安全网 + `/undo`、tree-sitter repo map、architect 双模型、lint/test 循环                                 | `--auto-commit`（已抄）、仓库地图    |
| **Goose / Block**          | MCP-first、YAML recipes、并行子 agent、ACP server                                                                    | MCP 优先、声明式编排                 |

**核心结论**：OmniHarness **引擎层（六边形 + FFI + 沙箱 + 压缩 + MCP + SDK + app-server + 自主长循环 + workflow DAG + LSP）已追平甚至局部领先**；真正的"显式差距"集中在 **面向使用者的上层 completeness** 与 **Web UI 成熟度**。

---

## 1. 调研后显式差距清单（按优先级）

### 1.1 已关闭（本轮 S36 独立可用就绪，已交付）

- CLI 位置参数 prompt（`omniharness "fix bug"`）
- 安装即构建（`package.json` 加 `prepare: tsc`）
- 读 `OPENAI_*` 环境变量（含默认 baseURL）
- 安全默认：`jsonl` 持久化 + `console` 事件 + `rules` 审批
- 干净输出：事件走 stderr，stdout 仅最终答案
- `--dump-config` / `--auto-commit` / `--context-window`

### 1.2 仍开放的差距

**G-A · Web UI 成熟度（最显见，用户已点名）**

- 现状：`web/index.html`（vanilla 单栏事件流）+ `web/index-react.html`（CDN React 简版双栏）。仅是**事件查看器**。
- 缺：三栏工作台、工具调用树(tool-call-tree)、reasoning 行、DiffBlock(patch 可视化)、精细化审批弹窗、设置面板(运行时改配置)、文件树/工作区视图、指标仪表盘(token/成本/步数)、深浅主题、移动端响应式、记忆/编排视图。
- dsh 对照：`packages/client/ui-layout`(app-frame 三栏) + `ui-chat`(tool-call-tree/reasoning/approval) + `ui-primitives`(Button/DiffBlock/ConnectionBanner/Logo) 全套组件库。

**G-B · 插件生态闭环**

- 已落地：registry(本地/内置/远程占位三源)、权限门禁、install/search/list/remove 子命令、≥3 示例插件。
- 缺：P2.4 远程插件隔离加载(受限 VM/沙箱)、真实 registry 服务、市场 UI 深化。

**G-C · 多 Agent 编排（in-process AgentGraph）**

- 现状：仅 Worker **外部**委派。
- 缺：声明式图、并行/串行调度、子 Agent 独立上下文、AppServer `graph.*` RPC、Web 编排视图。codex 有 agent-graph-store，dsh 有子 Agent 并行。

**G-D · 记忆模块（跨会话长期/语义）**

- 现状：仅 KV/Vault + 会话日志 + M2 BM25 会话检索。
- 缺：结构化长期记忆抽取/注入、MemoryPort、记忆管理 UI。codex 有 dedicated memories。

**G-E · Profiles / Bundles**

- 缺：命名插件组合、可 patch 插件叠层、发布单元。dsh 有 web/headless profiles + patchable bundle。

**G-F · 配置模板开箱**

- 缺：首次运行 `omniharness.json` 示例 + 引导。

**G-G · 文档 / 上手**

- 缺：快速上手、插件开发指南、可视化架构图（现有 GAP 文档有矩阵但无 step-by-step 与架构图）。

---

## 2. UI 技术路线决策（关键分叉，影响阶段 0/1 全部）

> ⚠️ **硬约束冲突**：字面"照搬 dsh 的 React `ui-*` 包" = React18 + Vite6 + Cordis + 250+ 依赖 → **直接违反 OmniHarness 零运行时依赖军规**（这是项目相对 dsh/codex 的核心差异化卖点）。两条路：

### 路线 A — 零依赖镜像（推荐，守军规）

以**零依赖静态 UI** 镜像 dsh 版式语言 + 借更美观通用 UI 的观感：

- **布局**：镜像 dsh `ui-layout` 三栏 app-frame（会话/文件树 · 对话+轨迹 · 工具树+指标+设置）
- **视觉/交互**：参照 **LobeChat**（78k★，颜值担当、中文原生、玻璃拟态、插件市场、会话侧栏）
- **工件/工具渲染**：参照 **OpenWebUI**（131k★，DiffBlock / artifact / 工具调用可视化最强）
- **极简基线**：参照 **ChatGPT-Next-Web / NextChat**（88k★，轻量响应式 PWA）
- **实现**：扩展现有 `web/index-react.html`（CDN React 单文件、零构建）或转纯 vanilla TS/CSS；确立设计令牌（颜色/间距/圆角/暗亮主题）；**不引入任何 npm 运行时依赖**。

### 路线 B — 字面 fork dsh React UI（需你显式放行，破军规）

- 把 `apps/web` + `packages/client/ui-*` 移植进 `apps/web`（Vite 构建）。
- 像素级还原 dsh，但拖入 React + Vite + Cordis 依赖树，**放弃零依赖卖点**。

→ **已确认路线 A（2026-09-01 用户拍板）**；路线 B 需另行显式放行方可启用。

---

## 3. 详细补全计划（按图推进，每阶段带验收）

### 阶段 0 — UI 路线锁定与基座（必须先做）

- [x] 0.1 确认路线 A（2026-09-01 用户拍板，守零依赖军规）
- [ ] 0.2 统一 `web/` 为单一生产 UI（升级 `index.html` 三栏，合并/弃用 react 版）
- [ ] 0.3 确立设计令牌与设计语言（暗/亮主题 CSS 变量、间距尺度、圆角、强调色取自 dsh 但去品牌）
- [ ] 0.4 接入 AppServer：`/rpc` + SSE `/events` 已通，补齐 `config.update` / `graph.*` / `memory.*`（若缺）
- **验收**：单一 UI 入口可启动、暗亮主题切换、连 AppServer 能收事件。

### 阶段 1 — Web UI 完整化（三栏工作台）[对标 dsh P1]

- [ ] 1.1 三栏布局：左=会话列表+工作区文件树；中=对话+轨迹流式；右=工具树钻取+指标+设置（镜像 ui-layout app-frame）
- [ ] 1.2 工具调用树 tool-call-tree + reasoning 行 + DiffBlock（patch 可视化，镜像 ui-chat / ui-primitives）
- [ ] 1.3 审批弹窗：工具名/目标/参数预览/允许拒绝/始终允许（镜像 ui-approval）
- [ ] 1.4 设置面板：模型适配器/工作区/审批策略/主题，运行时改 → `config.update`
- [ ] 1.5 指标仪表盘：token/成本/步数/工具调用数（复用事件统计）
- [ ] 1.6 深浅主题 + 移动端响应式（借 LobeChat / NextChat 观感）
- [ ] 1.7 工作区文件树预览 + 接入真实模型文档（`serve --model-adapter openai --api-key ...`）
- **验收**：`serve` 起后浏览器打开 `:8787`，能下达任务、看工具轨迹树、处理审批、看指标、切主题、看文件。

### 阶段 2 — 插件生态闭环 [G-B]

- [x] 2.1 远程插件隔离加载（受限 VM/沙箱）
  - 新增 `src/plugin/sandbox.ts`：`loadPluginCodeInSandbox(code, filename, timeout)` 用 `node:vm` 在受限上下文加载不可信插件。安全模型（保守 fail-closed）：① 自包含，禁 `import`/`require`/`module.`；② 受限全局，不注入 `require`/`process`/`global`/`fetch`，插件无法触达宿主 Node 能力；③ 能力仍由 `PluginManager` 权限门禁把关（越白名单即拒）；④ apply 超时熔断（默认 10s，防挂死）。
  - `pluginLoader.loadInstalledPlugins`：manifest `source==='remote'` 的已安装插件改走沙箱分支（`readFileSync`+`loadPluginCodeInSandbox`），本地/内置源仍走动态 import。
  - 注：VM 隔离为 best-effort；彻底不可信代码应放独立进程/Worker + OS 级沙箱。
- [x] 2.2 真实 registry 占位服务 + 市场 UI 深化（卡片/权限展示/安装进度）
  - **真实 registry 占位服务（离线可用）**：新增 `FileRegistrySource`（读本地 catalog JSON，与 `RemoteHttpSource` 同 schema），默认挂载仓库内 `examples/catalog/registry.json` 占位目录；`PluginRegistry` 默认源顺序 = 本地 > 内置 > 文件占位 > 远程。用户可直接编辑该 JSON 扩展市场，无需改代码。新增 `demo-notes` 插件（仅由 catalog 提供）证明文件源端到端可用。
  - **市场 UI 深化**：权限改为中文可读标签 + 原始权限 `title` tooltip + 危险权限（删/执行/网络/写）高亮；安装/卸载按钮带「安装中…/卸载中…」进度态 + 成功轻提示 toast；已安装带「已加载/未加载」徽章 + 「重新加载」热加载。
- [x] 2.3 运行时插件热加载闭环（本轮核心新增）
  - `PluginRegistry.install` 仅落盘 → 新增 `pluginLoader.loadInstalledPlugins` + `AppServer.loadPlugins()`（serve 启动即扫 pluginsDir、动态 import、经共享 `port.tools` 容器 `PluginManager.register`）
  - 新增 `plugins.reload` RPC（热加载新装插件进 Agent 工具表，无需重启）+ `plugin.loaded`/`plugin.loadError` 通知
  - 关闭此前「装完需重启 serve 才生效」缺口
- **验收**：`install` 远程插件在沙箱内加载，不污染主进程；市场可见 ≥3 插件。
  - 当前已达成：市场可见 ≥4 插件 ✅；运行时闭环（安装→reload→工具对 Agent 可见）✅；远程源插件走 VM 沙箱隔离 ✅（单测 + 实跑 serve 冒烟验证）

### 阶段 3 — in-process 多 Agent 编排 AgentGraph [G-C]

- [x] 3.1 AgentGraph 声明式图（节点=角色，边=依赖），复用 WorkflowRunner DAG 编排器（Kahn 拓扑分层 + 失败传播 skip）
- [x] 3.2 并行/串行调度 + 结果汇聚（blackboard 注入后续 prompt）+ 子 Agent 独立上下文（SubagentRuntimeFactory）
- [x] 3.3 Worker 委派统一为图边（WorkflowRunner 复用 Agent 主循环，零重复实现）
- [x] 3.4 AppServer `graph.list`/`graph.get`/`graph.save`/`graph.delete`/`graph.run`/`graph.status` RPC（节点状态经 `graph.progress`/`graph.done` 通知实时推送）+ Web 编排视图（tab+编辑+实时节点状态+示例）
- **验收**：4 节点 DAG（plan → a/b 并行 → merge）经 `graph.run` 端到端跑通，全部 `done`、`ok=true`、blackboard 含 4 条产出（`_smoke_graph.mjs` 8/8 通过）。
- **注意**：serve 下 `graph.run` 曾因上行审批端口（默认 `approvalUplink`）死等 `approval.respond` 而挂死；已固定图运行走 `AUTO_ALLOW`（用户点击「运行」即授权，与 CLI `workflow` 语义一致）。主 Agent `turns.run` 在真实 UI 中走上行审批（Web 审批卡 `approval.request`→`approval.respond`，index.html:629），**已于 2026-09-01 E2E 实测确认闭环正常**：`serve --mock`（不加 `--auto-approve`）下 `turns.run` 的 HTTP 在收到 allow 后正常返回 `{threadId,finalText,steps}`（`_smoke_approval.mjs` ALL GREEN）。

### 阶段 4 — 记忆模块 [G-D]

- [x] 4.1 MemoryPort（长期/语义）：`LongTermMemoryPort` + `FileLongTermMemory`（JSONL 落盘）+ `MemoryExtractor`（回合末 LLM 蒸馏 + 确定性去重，S28 已建）
- [x] 4.2 写入（回合末 `consolidate` + `remember` 工具）/读取（会话开始注入 primer）：`Agent.injectMemoryPrimer` 在开场以 system 事件注入 top 相关/重要事实（零侵入核心循环）
- [x] 4.3 记忆管理 RPC + UI：`memory.list/get/add/update/delete/search` 六 RPC + `memory.changed` 实时通知；Web 右栏「记忆」tab（查看/检索/增/改/删）
- [x] 4.4 Vault 加密集成：`AesGcmTextCodec`（复用 CryptoVault 同级 AES-256-GCM，逐行独立加密保 append-only）+ `longTermMemoryEncryption` 配置/CLI `--memory-encrypt` 开关 + 密钥文件自动生成
- **验收**：`_smoke_memory.mjs` 10/10（增/查/改/删/检索/跨进程持久 + turns.run 开场事件含「长期记忆」primer）；`_smoke_memory_enc.mjs` 4/4（落盘密文、跨进程用本地密钥还原）；单测 `fileLongTermMemory.test.ts` 7/7（CRUD + 加密 + 错误密钥拒绝）。

### 阶段 5 — Profiles / Bundles [G-E]

- [x] 5.1 Profile 命名插件组合（web/headless/coding）：`PluginProfile` + `PluginProfileStore` + `applyProfile`（安装缺失→按子集激活→卸载其余）+ CLI `--plugin-profile`
- [x] 5.2 Bundle 可 patch 插件叠层（config 覆盖层 `profile.config` → 补丁层 `.json`）
- [x] 5.3 发布单元（零依赖 store-zip + 清单 + HMAC-SHA256 签名校验）
- **验收**：一条命令切换编码/研究模式插件集（profile.save/apply + bundle.pack/unpack 端到端 10/10 验证）。

### 阶段 6 — 收尾与打磨 [G-F / G-G]

- [x] 6.1 配置模板开箱（`omniharness.json` 示例 + 首次运行引导）
- [x] 6.2 TUI 富终端（可选，复用现有零依赖终端绘制）
- [x] 6.3 端到端回归：P1–P5 各加契约测试；`cargo test` + `npm test` + `native:test` 全绿
- [x] 6.4 文档：快速上手 + 插件开发指南 + 可视化架构图（hexagon + Rust + UI）
- **验收**：文档齐备，回归全绿。

---

## 4. 与军规兼容性

- **零运行时依赖**：路线 A 全程守；路线 B 需破例（须显式放行）。
- **一个类一职责 / 无大函数**：每阶段独立目录，不膨胀现有文件。
- **camelCase(TS) / snake_case(Rust)** 沿用；fail-closed 门禁复用；运行时实证配契约测试。

## 5. 建议推进顺序

`0 → 1`（体感最大、用户点名）→ `2 → 3 → 4 → 5 → 6`，阶段 6 贯穿全程。

---

## 6. 进度记录（实际推进）

### 2026-09-01 — 阶段 0.2/0.3 + 阶段 1 核心落地 ✅

**后端（AppServer 增量，未动现有逻辑）**

- 新增 3 个真实 RPC：`config.get` / `config.update` / `fs.list`（撑起设置面板、文件树、指标）
- `runServe` 注入 config 摘要 + auto-approve 开关；`config.get` 回 `model/approval/sandbox/escalation/workspace/autoApprove/webDir`

**前端（web/index.html 重写为零依赖三栏工作台）**

- 左：会话/文件树（fs.list）；中：事件流（user/assistant/reasoning/tool_call/tool_result/todo/plan/question）；右：设置（config.update）+ 指标（/metrics）+ 插件市场（plugins.list）
- 暗/亮主题切换（CSS 变量设计令牌，LobeChat 玻璃拟态观感，零品牌）
- 工具调用树、reasoning 块、审批卡（approval.request 上行 approval.respond）、文件 DiffBlock 占位
- 纯 vanilla + 内联 CSS/JS，零构建、零 npm 运行时依赖（守路线 A）

**验证全绿**

- `tsc --noEmit` 通过；`cliSystem.test.js` 7/7；`smoke.js` 全过
- 实跑链路：`serve --auto-approve` → `turns.run` 回 threadId+finalText → `threads.get` 回放 2 事件 → `/metrics` 累加
- UI 内联脚本 `vm.Script` 语法校验通过（13.3KB）
- 临时 serve 进程已停止

**待补（阶段 1 收尾）**

- [x] SSE 实时订阅 `/events` 接入（EventSource 已接；实证收到 user→tool_call→tool_result→assistant 四条实时事件）
- [x] 设置面板「保存」真正落盘（`ConfigFile.save` 写回 `omniharness.json`；`PERSISTABLE_KEYS` 白名单防凭据/工作区泄露；GitBash `/d/...` 路径经 `toWindowsPath` 转换，落盘到正确工作区并重启可读回）
- [x] 文件树点击 → 打开真实内容（新增 `fs.read` RPC + 预览弹窗；越界路径拒绝）
- [x] 插件市场搜索/安装/卸载（`plugins.search`/`plugins.install`/`plugins.remove` 三 RPC 闭环；前端「插件」tab：搜索框 + 已安装/可获取分栏 + 权限危险标记 + 安装/卸载按钮；内置 github-tools/web-fetch/pdf-read 可一键装）
- [x] 移动端响应式 + 空状态插画（左/右栏从 `display:none` 改为抽屉式 off-canvas：顶栏新增 ☰/⚙ 切换按钮 + 半透明 backdrop，点击/切回桌面自动复位；会话/对话/工具/文件树/插件等空态升级为图标+提示的插画版 `.empty.illu`）

### 2026-09-01 — 阶段 2 收尾第 1 刀：插件运行时热加载闭环 ✅

- **关键发现**：主 `run`/`serve` 流程此前**根本没有自动加载已安装插件的代码**——`PluginManager` 只在 `plugin load` 子命令被手工实例化；市场安装的插件仅落盘，**从未进 Agent 工具表**（连「重启 serve 才生效」的备注都低估了缺口）。`samplePlugin.ts` 点明插件模型：`apply(ctx)` 经 `ctx.services.get('port.tools').register(...)` 直接挂工具进 `RegistryToolPort`。
- **新增 `src/plugin/pluginLoader.ts`**：`loadInstalledPlugins(manager, pluginsDir, onError?)`——扫 pluginsDir、动态 `import()` entry、按目录名去重（幂等）、单插件坏不影响其余（onError 回调上报）、已加载跳过。
- **`src/server/appServer.ts` 增量**：`AppServerOptions` 加 `pluginsDir`；`loadPlugins()`（公开，serve 启动即调）+ `ensurePlugins()`（私有幂等）——用**与 Agent 共享 `port.tools` 的 Container** 建 `PluginManager`（`PermissionGate.fromList(ALL_PERMISSIONS)`，安装时已 fail-closed 校验），加载后下发 `plugin.loaded` 通知；`plugins.list`/`plugins.search` 回带 `loaded` 标记；新增 `plugins.reload` RPC（热加载新装插件，下发 `plugin.loaded{reloaded:true}`）。
- **`src/cli/exec.ts`**：`runServe`/`runServer` 计算 `pluginsDir` 注入 AppServer 并在启动后 `await app.loadPlugins()`；`createRegistry` 收可选 `pluginsDir` 参数。
- **示例工具插件**：新增 `examples/plugins/hello-tool`（注册 `hello` 工具、无敏感权限）+ 挂入 `BUNDLED_PLUGINS`，市场可见插件 3→4，且能真实验证「安装→工具对 Agent 可见」闭环（另三个内置示例仅注册内部服务、不挂工具）。
- **Web UI（`web/index.html`）**：插件市场「已安装」卡带「已加载/未加载」状态徽章；「重新加载」按钮调 `plugins.reload` 热加载。
- **测试**：新增 `tests/unit/pluginLoader.test.ts`（直接测 `loadInstalledPlugins` + AppServer 集成测 `plugins.reload`→工具注入+`loaded:true`+通知）；修 `httpServer.test.ts` 过期断言（`OmniHarness 控制台`→`OmniHarness 工作台`）。
- **验证全绿**：`tsc` 通过；全量单测 445 过/0 失败/3 跳过；`smoke` 全过；**真实 `serve` 冒烟**（install hello-tool→reload→`loaded:true`→search 命中）端到端通关；临时 serve 已关、临时目录已清。
- **阶段 2 全收**：2.1 沙箱隔离 ✅（VM 受限上下文加载远程源插件）+ 2.2 占位 registry/UI 深化 ✅ + 2.3 热加载闭环 ✅。下一阶段按序为 阶段 3 AgentGraph。

### 2026-09-01 — 阶段 6 收尾 [G-F / G-G] ✅

- **6.1 配置模板开箱**：新增 `omniharness.json.example`（14 个合法 key，全在 `configLayer.ts` 的 `KNOWN_KEYS` 白名单内）+ `scripts/init-config.mjs` 脚手架（零依赖 ESM，生成/复制配置到 cwd）+ CLI `loadDefaults`（主 `run` 等）与 `runServe`（serve 独立路径）双入口加「未找到配置文件」友好提示（仅 stderr、不阻断、默认 mock）。
- **6.2 TUI 富终端**：由既有 #S35 零依赖 TUI 覆盖（`src/tui/interactive.ts` + `src/tui/render.ts`，CLI `omniharness tui` 已接线），标完成不重复造轮子。
- **6.3 端到端回归**：全量单测 **471 通过 / 0 失败 / 3 跳过**（474 总）确认仍绿；新增 `_smoke_stage6.mjs` 启动 `serve --mock` 串联 P2–P5 后端 RPC 契约冒烟（plugins/memory/profile/graph + config）。
- **6.4 文档**：`docs/QUICKSTART.md`（快速上手：mock→真实模型→Web UI→CLI 速查→故障排查）+ `docs/PLUGIN_GUIDE.md`（PluginManifest 字段表 + 10 项权限白名单 + `apply(ctx)` 模式 + hello-tool 逐行 + registry/bundle）+ `docs/architecture.html`（零依赖 SVG 架构图，暗亮主题可切换，六边形端口 + TS 插件层 + Rust 内核 + 边界）。
- **验收**：`tsc --noEmit` 通过；init-config 脚手架在临时目录生成合法配置（`modelAdapter=openai / approval=rules / storageAdapter=jsonl`）；阶段 6 四项全部 [x]。OmniHarness 完成计划（阶段 0–6）全收口。

### 2026-09-01（续四）— 审批闭环 E2E 真验收 ✅（含一次"假 bug"排雷）

- **目标**：把"代码存在但未被实跑证明"的审批上行闭环做成以 **`turns.run` 的 HTTP 返回**为判据的真实 E2E 绿（此前 `_smoke_approval.mjs` 用事件流当判据，掩盖了"逻辑跑完但 HTTP 不返回"的真问题）。
- **插桩排查**：在 `appServer.runTurn` / `agent.continueSession` / `httpServer.handleRpc` 三处加 `[DIAG]` 标记重跑。结果颠覆假设——
  - `runTurn` 完整执行：`before runTask` → `agent: after runner.run` → `agent: after storage.save` → `runTurn: after runTask` → `returning threadResult`；
  - 但 `handleRpc` 对 `turns.run` **只打印 `body=`，永不打印 `result=`**——即方法已返回结果，`bridge.handlePost(turns.run)` 这个 Promise 始终不 settle。
- **根因（非产品缺陷，是测试 harness 的 id 撞车）**：`HttpBridgeTransport` 用**请求自带的 `id`** 当 `pending` Map 的 key。诊断脚本两次 RPC（`turns.run` 与 `approval.respond`）都写死 `id:1`：
  - `turns.run` → `pending['1']=resolveTurnsRun`；
  - `approval.respond`（id=1）到来 → **`pending['1']` 被覆盖**成 `resolveApprovalRespond`；
  - `approval.respond` 处理完 → `bridge.send(response id=1)` → 命中 `pending['1']`，resolve 掉 `resolveApprovalRespond` 并 `delete pending['1']`；
  - 之后 `turns.run` 真正跑完 → `bridge.send(response id=1 for turns.run)` → `pending['1']` 已空 → **resolve 永不调用 → HTTP 挂死**。
  - **真实 Web UI 用 `id:++rpcId` 唯一递增 id（index.html:454），绝不会撞车**，故产品逻辑本身完全正常。
- **修复（仅测试侧）**：诊断脚本与 `_smoke_approval.mjs` 改为每次 RPC 用唯一递增 id；`_smoke_approval.mjs` 改写为以 **`turns.run` HTTP 在 35s 内返回 `{threadId,finalText,steps}`** 为唯一判据（事件流仅作佐证）。
- **产物改动（已 build + typecheck 通过）**：
  - 回退三处 `[DIAG]` 插桩（`appServer.ts` / `agent.ts` / `httpServer.ts` 恢复原样）；
  - `turnRunner.ts` 保留 `consolidateMemory` 异步化（`void ...catch()`），但**修正注释**——它本就不是 bug 修复，而是稳健性改进（不让 best-effort 蒸馏阻塞 HTTP 响应），与审批上行无关。
- **验收全绿**：
  - `_smoke_approval.mjs`：上行审批→放行→工具执行→模型产出，`turns.run` HTTP 正常返回 ✅ ALL GREEN；
  - 全量单测 **471 通过 / 0 失败 / 3 跳过（474 总）**，无回归；
  - `_smoke_stage6.mjs` 5/5 全绿。
- **结论**：OmniHarness「独立可用」路径（配置开箱→CLI→Web UI→审批闭环）全部经实跑验证；原以为的"uplink 挂死"是测试客户端 id 复用所致，非代码缺陷。
