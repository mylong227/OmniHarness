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
| F3  | **会话操作（重命名/删除/搜索/fork）** | 会话管理是「会话模式」核心                                              | `ApiClient` 仅有 `listSessions`/`searchAll`，缺 `rename/delete/fork` RPC 与 `SessionPanel` 操作入口       | 是（需 RPC） |
| F4  | **中断 / 重生成 / 编辑重发**        | 长任务可控性，对标 codex 的 stop + regenerate                            | `Composer`/`ComposerController` 未见 abort/regenerate 入口；后端 `turn` 中止需确认                        | 部分     |
| F5  | **配置 UI 收敛**                    | API key / base-url / profile 在一处可改且即时生效                       | `ModelProviders`/`Settings` 已存在但字段接线完整度待核                                                    | 部分     |

### 中价值

| #   | 能力                  | 价值                                   | 依赖后端 |
| --- | --------------------- | -------------------------------------- | -------- |
| F6  | **diff accept/reject 闭环** | ChangesTab 的 hunk 接受/拒绝联动真实写入 | 是（需写回 RPC） |
| F7  | **未消费事件接入**    | `profile.error`/`plugin.loaded` 等事件 UI 提示 | 否（事件已在流里，需 UI 消费） |
| F8  | **路由 / 深链**       | 会话/标签可深链与浏览器后退            | 否（前端路由层） |

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

## 4. 建议推进顺序

1. ~~**F1 回复渲染升级** — 与 deepseek-harness 的「回复模式」观感直接对齐，且为零依赖铁律放宽后的低风险首步。~~ ✅ **已完成（阶段 37 / F1）**
2. ~~**F2 代码块体验** — 纯前端、零后端依赖，紧接 F1 渲染层，补齐复制/语言标签。~~ ✅ **已完成（F2）**
3. **F7 未消费事件接入** — 纯前端消费既有事件流，补齐 UI 完整性。
4. **F3 会话操作** — 需后端补 `rename/delete/fork` RPC（StoragePort 已有 fork 能力，需暴露到 Web RPC），再在 `SessionPanel` 加操作入口。
5. **F4 中断/重生成** — 需确认后端 `turn` 中止与 regenerate 能力，再接 UI。
6. **F5 配置 UI 收敛** — 核实现有 `ModelProviders`/`Settings` 字段接线完整度，补缺失项。
7. **F6 diff accept/reject 闭环** — 需写回 RPC。
8. **F8 路由/深链** — 前端路由层，独立阶段。
