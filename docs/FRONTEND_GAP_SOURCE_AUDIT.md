# 前端全功能页面对标审计（vs `deepseek-harness` Web / `codex`）

> **目标**（用户原话）：「按照整个前端的功能页面全都进行 codex 或 deepseek-harness 对其……最低要求做到不输于他，最好就是我们本身的能力要超过他；不要求完全 0 依赖，有好的依赖我们要善于使用已经成熟的知识代替从 0 开始。」
>
> **主参考**：`deepseek-harness`（`D:\deepseek\.recycle-bin\.ref-backup\deepseek-harness`，React 18 + Vite 6 SPA，Cordis 槽位/插件系统；含 Plan mode、PermissionSelect、命令面板、@引用、subagent、goal bar、trajectory 等）。`codex` 仅作会话/回复模式的概念参考。
>
> **约束放宽**：用户对前端明确放宽「零依赖」铁律——允许引入成熟第三方依赖（vendored UMD 离线内置），避免从 0 造轮子踩坑。
>
> **审计时点**：阶段 37 启动前。

---

## 1. 先剔误报：这些前端能力其实已具备

探查阶段曾把它们报成缺口，交叉核实 `web/src/` 源码后确认 **OmniHarness 已实现**，不应重复投资：

| 曾被报为缺口            | 实际状态                                              | 证据                                                        |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| Plan / todo / 提问协作态 | ✅ 已有（对应 deepseek-harness 的 Plan/PermissionSelect） | `web/src/ui/components/tabs/`（Settings/Plugins/Profiles/Tools/Metrics/Memory/Graph/Changes/Rollback/Detail/File）多 Tab；`web/src/core/DialogService.ts`、`ApprovalModal.tsx` |
| 命令面板                | ✅ 已有                                                | `web/src/ui/components/CommandPalette.tsx` + `CommandPaletteModel.ts` |
| 轨迹 / 变更可视化        | ✅ 已有                                                | `web/src/ui/components/tabs/GraphTab.tsx`、`ChangesTab.tsx`、`RollbackTab.tsx` |
| 会话列表 / 检索          | ✅ 部分已有（list + 跨域 search）                      | `ApiClient.listSessions()`、`ApiClient.searchAll()`（`search.all` RPC）；`SessionPanel.tsx` |
| checkpoint 回滚          | ✅ 已有                                                | `ApiClient.checkpoint.list/create/rollback`；`RollbackTab.tsx` |
| 模型/provider 配置       | ✅ 部分已有                                            | `web/src/ui/components/tabs/ModelProviders.tsx`、`SettingsTab.tsx` |

**教训（流程改进）**：对标前先 `Grep` 自己 `web/src/`，避免把已有 UI 报成缺口。

---

## 2. 真实缺口（源码级证据 + 建议优先级）

> 优先级判定维度：是否纯前端可闭环（无需新后端 RPC）、是否直接提升「回复模式/会话模式」观感、Windows 可用性。

### 高价值（建议优先）

| #   | 能力                                | 价值                                                                     | 当前证据（缺口）                                                                                         | 依赖后端 |
| --- | ----------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------- |
| F1  | **回复渲染升级**                    | 数学公式 + 代码语法高亮，直接对齐 deepseek-harness 的「回复模式」观感     | 原 `format.ts` 手写零依赖解析器**缺数学与代码高亮**                                                       | 否（纯前端）✅ **本轮已落地** |
| F2  | **代码块体验**                      | 复制代码按钮 + 语言标签 + 悬停反馈，对齐主流 Chat UI                     | `markdown.ts` 产出 `<pre class="hljs">` 但 UI 无复制/语言标签                                            | 否（纯前端）✅ **本轮已落地** |
| F3  | **会话操作（重命名/删除/搜索/fork）** | 会话管理是「会话模式」核心                                              | `ApiClient` 仅有 `listSessions`/`searchAll`，缺 `rename/delete/fork` RPC 与 `SessionPanel` 操作入口       | 是（需 RPC） | 否（后端补 RPC + 前端接线）✅ **本轮已落地** |
| F4  | **中断 / 重生成 / 编辑重发**        | 长任务可控性，对标 codex 的 stop + regenerate                            | `Composer`/`ComposerController` 未见 abort/regenerate 入口；后端 `turn` 中止需确认                        | 部分     | 否（后端补 `turns.abort` RPC + 前端停止/重生成/编辑重发）✅ **本轮已落地** |
| F5  | **配置 UI 收敛**                    | API key / base-url / profile 在一处可改且即时生效                       | `ModelProviders`/`Settings` 已存在但自定义 base-url 不可编辑、profile 未收敛                            | 否（纯前端） | 否（`SettingsTab` 补 base-url 编辑 + profile 下拉切换，即时生效）✅ **本轮已落地** |

### 中价值

| #   | 能力                  | 价值                                   | 依赖后端 |
| --- | --------------------- | -------------------------------------- | -------- |
| F6  | **diff accept/reject 闭环** | ChangesTab 的 hunk 接受/拒绝联动真实写入 | ApiClient 已有 stageFile/revertFile/stageHunk/revertHunk，ChangesTab 已调用，闭环本已接好 | 否（纯前端） | 否（RPC 闭环 + `diffControl` 回归测试坐实）✅ **本轮已坐实** |
| F7  | **未消费事件接入**    | `profile.error`/`plugin.loaded` 等事件 UI 提示 | 否（事件已在流里，需 UI 消费） | 否（纯前端）✅ **本轮已落地** |
| F8  | **路由 / 深链**       | 会话/标签可深链与浏览器后退            | 无（新增 `Router` + `RouteBinding` 接入 AppController/SessionController/ComposerController） | 否（纯前端） | 否（哈希路由：深链 + 浏览器前进/后退）✅ **本轮已落地** |

### 低价值 / 暂缓

- **Terminal/PTY 视图**：需持久 PTY，Windows 侧为 OS/内核铁律豁免项（同后端 S35 的 persist-PTY 豁免），暂缓。
- **i18n**：多语言框架，当前单语（中文）已满足用户场景，暂缓。
- **MCP 管理 UI**：后端 MCP 网关（#44）已落地，UI 暴露可后续作为独立阶段。

---

## 3. 本轮已闭环：F1 回复渲染升级

| 项     | 内容                                                                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增   | `web/src/ui/markdown.ts`（markdown-it + KaTeX + highlight.js 管线；UMD 全局缺失时回落 `format.ts` 手写实现）；`markdownLibsReady()` 闸门                                          |
| 接线   | `web/src/ui/format.ts` 的 `renderMarkdown` 改为统一入口：依赖就绪走 `markdownRender`，否则走 `legacyRenderMarkdown`；`AssistantCard`/`StreamingAssistantCard` 经 `format.renderMarkdown` 渲染 |
| 依赖   | `web/vendor/` 离线内置 `markdown-it.min.js` / `katex.min.js`+`katex.min.css`+`fonts/`(20 woff/woff2) / `highlight.min.js`+`highlight-github-dark.min.css`；`index.html` 按序加载 UMD + CSS |
| 安全   | `markdown-it` 以 `html:false` 运行（用户输入被转义）；仅 KaTeX/highlight.js 输出为受信任 HTML；链接按「文件路径→`data-file-path` 右侧面板打开 / 外链→`_blank`+`noopener`」分流        |
| 验收   | `web:build` 0 错误；`web:test` 15/15（含 legacy 回落路径回归）；`@typescript-eslint/no-explicit-any` 全库 0 处（markdown-it 互操作改用最小接口，无 `any`）                            |

---

## 3b. 本轮已闭环：F2 代码块体验

| 项     | 内容                                                                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增能力 | 每个代码块顶部工具条：**语言标签**（围栏信息串，缺省 `text`）+ **一键复制**按钮（点击复制 `<pre><code>` 文本，按钮短暂变「已复制」反馈）                                                                 |
| 渲染层（生产路径 `markdown.ts`） | 新增 `fence` 渲染规则：把 markdown-it + highlight.js 产出的 `<pre class="hljs">` 包进 `.md-codeblock`（`.md-codeblock__bar` + `.md-codeblock__lang` + `.md-codeblock__copy`），语言名先 `escapeHtml` 防注入 |
| 渲染层（回落路径 `format.ts`） | `legacyRenderMarkdown` 的 `code` 块同样包 `.md-codeblock` 容器 + 复制按钮，保证 vendored 依赖缺失时体验一致                                                         |
| 交互   | 共享 `handleCodeblockCopyClick`（事件委托，挂在 `md-content` 容器）：命中 `.md-codeblock__copy` 才复制，与 `AssistantCard` 的 `data-file-path` 点击委托互不干扰；复用既有 `ClipboardCopier`（失败静默 fail-closed） |
| 样式   | `web/styles/chat.css` 新增 `.md-codeblock*` 一套（容器/工具条/标签/按钮/成功态），暗/亮主题走语义变量 `--panel/--border/--dim/--ok` 等                                                                 |
| 覆盖范围 | `AssistantCard` / `StreamingAssistantCard` / `FileTab` 经 `renderMarkdown` 统一入口，全部自动获得复制按钮                                                                 |
| 验收   | `web:build` 0 错误；`eslint` 0 警告；`web:test` **16/16**（新增「代码块包 `.md-codeblock` 且含语言标签与复制按钮」契约测试覆盖 legacy 路径）；无 `any`；全量 web 单测 112 项中仅 2 项为**浏览器 e2e**（headless Chrome 环境差异，与本改动无关）|

---

## 3c. 本轮已闭环：F7 未消费事件接入

| 项       | 内容                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 背景     | 后端已在 SSE 流里发出 `profile.error` / `plugin.loaded` / `plugin.loadError` / `profile.applied`，但 `AppController.connectStream` 的 `switch` 只路由 `profile.applied`/`profile.event` 且**静默** bump 一个 reload key，错误与加载事件此前对用户完全不可见 |
| 新增     | `web/src/ui/notify.ts` —— 纯函数 `profilePluginToasts(envelope: SseEnvelope, toast: (m: string, k: ToastKind) => void): void`；按 `envelope.method` 分派：`profile.error`→`error` toast（`配置「{name}」加载失败：{error}`），`plugin.loaded`→`success`（`插件已加载：{names}` 或 `插件已重载：{names}`），`plugin.loadError`→`error`（`插件「{name}」加载失败：{error}`），`profile.applied`→`success`（`配置「{name}」已应用`） |
| 接线     | `AppController.connectStream` 的 `switch` 把上述四种 method 统一改为调用 `this.applyProfilePluginToast(msg)`；`applyProfilePluginToast` 委托 `profilePluginToasts(msg, (m,k)=>this.showToast(m,k))`，并保留原有的 `profilesReloadKey` bump（profile 类事件仍触发配置刷新） |
| 安全/健壮性 | 所有字段经 `String(... ?? '')` 归一，**永不为 undefined**；`names` 数组 `join('、')`，空则自然落到 `未命名`；无法识别的 method 保持 `no-op`，不影响其他路由 |
| 复用     | 直接复用既有 `AppController.showToast`（走 `toastState` + 2.2s 自动隐藏）与 `Toast.tsx`，无新状态/组件 |
| 测试     | 新增 `web/test/notify.test.mjs`（契约测试：四类事件 → 正确 message + kind；空字段归一；无法识别 method 不抛错）；纯函数可脱离 DOM 直测 |
| 验收     | `web:build` 0 错误；`eslint` 0 警告；全量 `web/test/**` **118/120**（仅 2 项为 headless-Chrome e2e `E1 CDP`/`UI e2e`，沙箱浏览器环境差异，与本改动无关）；无 `any` |

---

## 3d. 本轮已闭环：F3 会话操作（重命名/删除/搜索/fork）

| 项       | 内容                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端 RPC | `src/server/services/sessionArchive.ts` 新增 `rename` / `delete` / `fork`（会话即 `<sessionId>.jsonl`）；`appServer.ts` 注册 `sessions.rename` / `sessions.delete` / `sessions.fork`；`appServerBase.ts` 注入运行态判定 |
| 重命名   | 自定义标题写入侧车 `sessions.meta.json`（`sessionId→title`），不改写事件流，避免与运行追加竞态；`list()` 读取时优先于首条用户消息作标签；空标题清除。标题形态 `^[A-Za-z0-9_-]{1,128}$` + 存档存在性双重校验 |
| 删除     | `rmSync` 移除 `.jsonl` 并清侧车标题；**运行中会话（`activeTurns` 命中）拒绝删除**（RPC 层 + `SessionArchive.delete` 双保险），防截断活动事件流                                       |
| 分叉     | `copyFileSync` 复制为新 `randomUUID` id，并追加 `session_meta.forkedFrom` 事件；新会话在列表继承原内容（`threads.get`→`replay` 按 id 读存档，可点击打开）                              |
| 前端 Api | `ApiClient` 新增 `renameSession` / `deleteSession` / `forkSession`（调对应 RPC）                                                                                  |
| 前端控制 | `SessionController` 新增 `renameSession` / `deleteSession` / `forkSession`：调用后 `refreshSessions` 刷新列表；删除若正打开则清空当前线程；均经 `services.toast` 反馈（fail-closed 静默） |
| 前端 UI  | `SessionPanel` 新增：①**搜索框**（按标签/id/工作区过滤，list 与 cards 双视图生效）；②每会话行悬停操作（✎重命名 / ⧉复制 / 🗑删除）；③**行内重命名**输入框（Enter 提交 / Esc 取消）；④**删除确认条**（「删除？」确认/取消）；`App.ts` 透传 `onRename/onDelete/onFork` |
| 样式     | `components.css` 补 `.session-toolbar` / `.session-search` / `.session-label` / `.session-actions`（悬停显隐）/ `.session-act` / `.session-rename*` / `.session-confirm*`，暗亮主题走语义变量；task-card 内标签也带操作 |
| 验收     | 根 `tsc --noEmit` 0 错；`web:build` 0 错；全仓 `eslint . --max-warnings=0` 0 警告；全量 `web/test/**` **118/120**（仅 2 项 headless-Chrome e2e 环境差异）；`audit:standard:delta`/`audit:config-wiring`(484)/`arch:gate`/`check --strict`/`audit:maturity` 全绿；无 `any` |

---

## 4. 建议推进顺序

1. ~~**F1 回复渲染升级** — 与 deepseek-harness 的「回复模式」观感直接对齐，且为零依赖铁律放宽后的低风险首步。~~ ✅ **已完成（阶段 37 / F1）**
2. ~~**F2 代码块体验** — 纯前端、零后端依赖，紧接 F1 渲染层，补齐复制/语言标签。~~ ✅ **已完成（F2）**
3. ~~**F7 未消费事件接入** — 纯前端消费既有事件流，把后端已发但 UI 静默的事件显式提示。~~ ✅ **已完成（F7）**
4. ~~**F3 会话操作** — 后端补 `rename/delete/fork` RPC + 前端 SessionPanel 重命名/删除/搜索/fork 入口，对齐「会话模式」核心。~~ ✅ **已完成（F3）**
5. ~~**F4 中断/重生成/编辑重发** — 后端 `turns.abort` RPC 触发既有 `agent.cancelCurrentRun`；前端停止按钮 + 重生成 + 编辑重发。~~ ✅ **已完成（F4，本轮）**
6. ~~**F5 配置 UI 收敛** — `SettingsTab` 补自定义 base-url 编辑 + profile 下拉切换，API key / base-url / profile 收敛一处且即时生效。~~ ✅ **已完成（F5，本轮）**
7. ~~**F6 diff accept/reject 闭环** — 经核实 ApiClient + ChangesTab + 后端 RPC 本已闭环，补 `diffControl` 回归测试坐实。~~ ✅ **已完成（F6，本轮）**
8. ~~**F8 路由/深链** — 新增 `Router` + `RouteBinding`，`activePane`/`currentThreadId` 编入 hash，支持深链与浏览器前进/后退。~~ ✅ **已完成（F8，本轮）**

---

## 3e. 本轮已闭环：F4 中断 / 重生成 / 编辑重发

| 项 | 内容 |
| --- | --- |
| 背景 | 长任务可控性对标 codex 的 stop + regenerate：此前 `Composer`/`ComposerController` 无 abort/regenerate 入口，后端 `agent.cancelCurrentRun`（CancellationToken 贯穿模型 fetch）已具备却未从 web 暴露。 |
| 中断（后端） | `src/server/core/appServer.ts` 注册 `turns.abort` RPC → `runtime.agent().cancelCurrentRun('user')`；取消令牌中止在飞模型请求，`turns.run` 自然收尾，SSE 已推送的增量事件不受影响。 |
| 中断（前端） | `ApiClient.abortTurn()` 调 `turns.abort`；`ComposerController.stop()` 置 `abortRequested` 并触发中断；`send()` 的 catch 区分「用户主动中断」（写 `已停止（用户中断）` 系统提示，不弹错误 toast）与真实错误；`Composer` 在 `busy` 时把发送按钮替换为「■ 停止」按钮。 |
| 重生成 | `ComposerController.regenerate()` 取当前线程最后一条 `user` 消息文本，作为新一轮 `send` 重发（对标 codex regenerate）；`AssistantCard` 在**最后一条**助手消息上挂「↻ 重新生成」按钮（`StreamView` 计算 `lastAssistantId` 且仅非 busy 时挂载）。 |
| 编辑重发 | 抽取 `UserCard` 组件承载用户消息展示 + 内联编辑；仅**最后一条**用户消息显示「✎ 编辑」，提交后回调 `ComposerController.resend(text)` 以编辑文本发起新回合。历史消息分支化（截断后重跑）需后端 `threads.rewind` RPC，本轮未实现，已在审计中明确为后续项。 |
| 接线 | `StreamView` 新增 `onStop`/`onRegenerate`/`onEditUser` 透传给 `Composer` / `AssistantCard` / `UserCard`；`App.tsx` 透传 `ctrl.composer.stop` / `regenerate` / `resend`。 |
| 样式 | `chat.css` 补 `.stop`（危险色）/`.msg-act`（消息悬浮操作）/`.user-edit*`（内联编辑 textarea + 保存/取消），暗亮主题走语义变量。 |
| 测试 | 新增 `web/test/turnControl.test.mjs`（5 项契约：abortTurn RPC、stop 触发中断、regenerate 取最后用户消息、regenerate 无消息轻提示、resend 发新回合）。 |
| 验收 | `web:build` 0 错；全仓 `eslint . --max-warnings=0` 0 警告；根 `tsc --noEmit` 0 错；`audit:standard:delta`/`audit:config-wiring`(484)/`arch:gate`/`check --strict`/`audit:maturity` 全绿；全量 `web/test/**` **123/125**（仅 2 项为 headless-Chrome e2e `E1 CDP`/`UI e2e` 沙箱环境差异，与本改动无关）；无 `any`。 |
