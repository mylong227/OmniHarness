# Codex vs OmniHarness —— UI 功能差距盘点与综合建议

> 日期：2026-09-09 ｜ 方法：联网核实 Codex 当前 UI（四形态）→ 主代理 Read 源码逐项核对 OmniHarness Web 现状 → 差距矩阵 + 分阶段建议
> 诚实边界：Codex 数据来自 2026-09-09 联网检索（OpenAI 官方文档 + 多源评测）；OmniHarness 现状均 `grep`/`Read` 实测，非印象。

---

## 0. 一句话结论

OmniHarness Web 的**单会话聊天 + 工具可视化 + 可观测 + 审批**能力已与 Codex Web/Cloud 对齐，并在**可观测性（11 tab）、工具人话叙述、真实审计链**上反超 Codex CLI；但与 **Codex 桌面端（Desktop App）** 相比，在三类 GUI 能力上有明确硬差距：**并行多智能体监督、内联 diff 审查（hunk 级 stage/revert + 行内评论）、回滚到检查点**——外加命令面板、增量流式、语音/应用内浏览器等体验项。这些恰是 ROI 最高、最该补的。

---

## 1. Codex UI 能力全景（2026 现状，已核实）

Codex 是"**单一 Agent、多入口（single agent, multiple ingress）**"：四形态共享同一 Agent、配置（`~/.codex/config.toml`）、记忆（`~/.codex/memory/`）、会话（`~/.codex/sessions/`），通过 **Codex App Server（JSON-RPC 2.0 / JSONL over stdio）** 互联，会话可跨形态续接。

| 形态                                                            | GUI 关键点（与 UI 差距相关）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLI TUI**（开源 Rust / Ratatui）                              | 全屏终端：transcript + 语法高亮 diff + 运行中的 plan；**字符级实时流式**；状态栏（模型/沙箱/审批策略/cwd/网络/token）；多行输入（Shift+Enter）、图片拖拽、`$skill`/`$app`；**快捷键体系**（Ctrl+R 续会话、Ctrl+P 命令面板、Tab 补全、↑/↓ 历史）；**内联审批**（`Accept once`/`Accept for session`/`Accept and add to policy`/`Decline`/`Cancel turn`）；会话落盘 `~/.codex/sessions/*.jsonl` 可 `resume`；主题（24-bit/256/16）、Vim 式编辑；slash 命令 `/model /approvals /review /diff /compact /init /status /undo /new /mcp /mention`                                                          |
| **Desktop App**（macOS 2026-02 / Windows 2026-03）              | **并行多 thread，每 thread 独立 Git worktree**；每 thread 集成终端；**Review 面板**：文件/hunk/整 diff 三级 stage+revert + **行内评论**（锚定到具体行）；**应用内浏览器**（打开本地/公网页、对渲染结果评论、让 Codex 修页面级反馈）；**Computer use**（看/操作 macOS 应用、点击输入做原生/模拟器/GUI 测试）；多终端 tab、摘要面板、更丰富 artifact 预览、SSH 连远程开发环境；**跨会话持久记忆 + thread 复用 + 定时任务**；**回滚到检查点**；三种运行模式 Local/Worktree/Cloud；`@terminal/@github/@browser` 插件提及、模型选择器（5.5）、**麦克风语音输入**；右侧栏（日志/终端/文件树/Agent 状态） |
| **Web/Cloud**（chatgpt.com/codex）                              | 隔离云容器异步跑任务（预载 GitHub 仓）；**并行任务 + GitHub @codex 提及 + Best-of-N（`--attempts 3`）**；产出 PR/diff + 可审阅日志；网络隔离（Agent 阶段禁外网、Setup 阶段可装依赖）                                                                                                                                                                                                                                                                                                                                                                                                               |
| **IDE 扩展**（VS Code/Cursor/Windsurf/JetBrains/Xcode/Eclipse） | 侧边栏 chat；模型选择器 + 推理强度（low/med/high）；`@filename` 引用带自动补全；三审批模式（Chat/Agent/Agent Full Access）；**云端委派（fire-and-forget）**；回滚（文件/hunk/检查点）；`/mcp /skills /status`                                                                                                                                                                                                                                                                                                                                                                                      |

---

## 2. OmniHarness Web 现状（已核实 `web/src`）

**已有（强）：**

- 聊天流 `StreamView.ts`(641 行) + 录入 `Composer.ts`（模型/推理强度/权限三切换、图片与文件附件、`WorkIndicator` 状态条）
- Markdown 渲染 + 文件语法高亮；外部链接卡片 `ExternalLinkCards`；`ReasoningBlock`
- 工具调用可视化：`ToolCallCard`（人话叙述）、`ProcessCluster`（折叠过程块）、`ArtifactCard`（文件/补丁下载+预览）、`liveInputs` 流式参数、`GraphTab`
- `NavRail` + `RightPanel` **11 tab**（Tools/Metrics/Changes/Settings/Plugins/Graph/Memory/Profiles/File/Detail）—— 可观测性远超 Codex CLI
- `SessionPanel`（listSessions/loadThread/newSession/workspace 标记，**单会话视图**）
- `ChangesTab`：按文件 patch 视图（`diffView`，**只读**）+ `turn_diff` 事件
- `ApprovalModal`：**允许(once) / 始终允许(session) / 拒绝** —— 与 Codex "Accept once / Accept for session" 对齐
- 主题 light/dark + 880px 响应式抽屉，localStorage 持久化
- `ToastService` 已存在（但错误仍用 `window.alert` 7 处）

**实测缺失（grep 全仓空）：** 命令面板、键盘快捷键体系、`parallel`/`worktree`/分支隔离、语音/麦克风、应用内浏览器、云端委派/异步任务、定时任务、`@mention` 插件、SSH/远程环境、hunk 级 stage/revert、行内评论、回滚到检查点。

---

## 3. UI 功能差距矩阵（逐项，带证据）

| #   | 能力                                       | Codex                          | OmniHarness Web                        | 差距             | 证据                                          |
| --- | ------------------------------------------ | ------------------------------ | -------------------------------------- | ---------------- | --------------------------------------------- |
| 1   | 多形态/跨设备续接                          | 4 形态 + 会话跨端续接          | 单 Web 面                              | **架构级**       | Codex App Server JSON-RPC；OH `web/` 仅一前端 |
| 2   | **并行多智能体监督**                       | Desktop 并行 thread + worktree | 单会话视图                             | **高**           | grep `parallel`/`worktree` 空                 |
| 3   | **内联 diff 审查（hunk 级 stage/revert）** | Review 面板三级控制            | 仅只读 diff 视图                       | **高**           | `ChangesTab.ts` 仅 `diffView` 展示            |
| 4   | **行内评论（锚定到行）**                   | 有                             | 无                                     | **高**           | grep 空                                       |
| 5   | **回滚到检查点**                           | 有（恢复对话点）               | 无                                     | **高**           | grep `rollback`/`checkpoint` 空               |
| 6   | 命令面板 + 快捷键体系                      | Ctrl+P 等全体系                | 仅基础 Enter/Esc                       | **中**           | 仅 Composer/FilePicker `onKeyDown`            |
| 7   | **增量流式（字符级）**                     | 字符级实时                     | 整事件渲染（无 token delta）           | **中**           | `StreamView.ts:510-542` 整段 `renderMarkdown` |
| 8   | 应用内浏览器 + 页面级视觉反馈              | Desktop 有                     | 无                                     | **中**           | grep 空                                       |
| 9   | 语音/麦克风输入                            | 有                             | 无                                     | **低**           | grep `voice`/`mic` 空                         |
| 10  | 云端委派 / 异步 / Best-of-N                | Web/Cloud 有                   | 无（本地优先）                         | **架构级**       | grep `cloud`/`schedule` 空                    |
| 11  | 定时任务 + 跨会话记忆调度                  | Desktop 有                     | MemoryTab 仅查看                       | **中**           | 无调度                                        |
| 12  | `@mention` 插件 / `$skill`                 | 有                             | Composer 无                            | **低**           | Composer 仅 import                            |
| 13  | SSH / 远程开发环境                         | Desktop 有                     | 无                                     | **低**（架构）   | grep 空                                       |
| 14  | 丰富 artifact 预览 / 摘要面板              | Desktop 有                     | 基础 `ArtifactCard`                    | **低-中**        | —                                             |
| 15  | 审批粒度                                   | once/session/**policy 持久**   | once/session（无 policy 持久）         | **低**（近对齐） | `ApprovalModal.ts:9,26,28`                    |
| 16  | 主题 / 响应式                              | 24-bit + 响应式                | light/dark + 880px                     | **对齐**         | `theme.css`/`layout.css`                      |
| 17  | 可观测/自省                                | Desktop 摘要面板               | **11 tab（Metrics/Graph/Memory）更强** | **OH 优势**      | `RightPanel`                                  |
| 18  | 工具调用人话叙述                           | CLI diff/plan                  | `ToolCallCard`+`ProcessCluster` 更强   | **OH 优势**      | `StreamView.ts`                               |
| 19  | 审计透明                                   | 基础                           | **真实哈希链审计**                     | **OH 优势**      | `audit.ts`                                    |

---

## 4. OmniHarness 相对 Codex 的优势（不卑不亢）

别只盯着差距。OH 在三处明显领先，且是 Codex 短期补不了的差异化卖点：

1. **深度可观测性**：11 tab 把 Metrics/Graph/Memory/Plugins/Profiles 摊开，Codex Desktop 只有摘要面板。
2. **工具人话叙述 + 过程折叠**：`ToolCallCard`/`ProcessCluster` 比 Codex 的裸 diff/plan 更易懂。
3. **真实哈希链审计**：`audit.ts` 的可验证防篡改链，是 Codex 没有的"可信"维度。

建议把这三件做成**对外透明化卖点**，而非只追 Codex 的 GUI 花活。

---

## 5. 综合建议（分阶段路线图，按 ROI）

> 与上一轮审计的 P0/P1（CI 构建 web、ESLint 纳入 web、web 单测骨架、a11y 基线、`window.alert`→Toast）合并推进——那是地基，不补则下面全是空中楼阁。

### 阶段 0 — 地基（低成本高杠杆，必做）

| 项                                                       | 成本  | 说明                                                        |
| -------------------------------------------------------- | ----- | ----------------------------------------------------------- |
| CI 加 web 构建 job + ESLint 取消忽略 `web/**`            | 低    | 把 UI 纳入看守                                              |
| Web 单测骨架（Vitest + @testing-library）                | 低-中 | 先锁 EventStream 解析 / StreamView 快照 / Composer 状态     |
| a11y 基线（role/aria-label/live-region/键盘焦点）        | 中    | 先在 NavRail/Composer/ApprovalModal                         |
| `window.alert`(7 处) → 内联 Toast（复用 `ToastService`） | 低    | 直接替换                                                    |
| **助手增量流式**（SSE token delta 累加）                 | 中    | 改 `App.handleEvent` + `StreamView` 文本累加（对应差距 #7） |

### 阶段 1 — 对齐 Codex 桌面端核心 GUI（中成本，优先级最高）

| 项                                                                  | 对应差距 | 成本  | 说明                               |
| ------------------------------------------------------------------- | -------- | ----- | ---------------------------------- |
| **内联 diff 审查**：`ChangesTab` 加 hunk 级 stage/revert + 行内评论 | #3 #4    | 中    | Codex 最强差异点，也是 OH 最该补的 |
| **回滚到检查点**                                                    | #5       | 中    | 需后端提供 turn 级快照/反演接口    |
| **命令面板（Ctrl+P）+ 快捷键体系**                                  | #6       | 低-中 | 提升专业度与效率                   |
| **并行/多任务视图**：UI 上支持多会话卡 + worktree 隔离开关          | #2       | 中-高 | 至少先把"并行任务卡"做出来         |

### 阶段 2 — 差异化/进阶（高成本，按需）

| 项                              | 对应差距 | 成本                                       |
| ------------------------------- | -------- | ------------------------------------------ |
| 应用内浏览器 + 渲染页视觉反馈   | #8       | 高                                         |
| 语音输入                        | #9       | 低（Web Speech API）                       |
| 云端委派 / 异步任务 / Best-of-N | #10      | 架构级（需后端 task scheduler + 隔离沙箱） |
| 定时任务 + 跨会话记忆调度       | #11      | 中                                         |
| `@mention` 插件 / `$skill` 引用 | #12      | 低                                         |
| SSH / 远程开发环境              | #13      | 架构级                                     |

### 阶段 3 — 放大 OH 优势（低成本，做成卖点）

- 把 11-tab 可观测性 + 哈希链审计做成"透明可信"对外展示页
- 强化 `ToolCallCard` 人话叙述为默认差异化体验

---

## 6. ROI 优先级速查

| 优先级 | 项                                         | 成本   | 影响                          |
| ------ | ------------------------------------------ | ------ | ----------------------------- |
| **P0** | 阶段 0 全部（CI/单测/a11y/Toast/增量流式） | 低-中  | 一票否决级，先把 UI 质量兜住  |
| **P1** | 内联 diff 审查 + 回滚检查点 + 命令面板     | 中     | 直接补齐 Codex 桌面端最强差异 |
| **P1** | 并行/多任务视图                            | 中-高  | 多智能体监督是未来主战场      |
| **P2** | 应用内浏览器 / 语音 / @mention / 定时      | 低-高  | 体验补全                      |
| **P3** | 云端委派 / SSH 远程 / 跨设备续接           | 架构级 | 需后端配套，排期靠后          |

---

## 7. 结论

OmniHarness Web **不是"不如 Codex"，而是"形态不同、各有所长"**：单会话交互、工具可视化、可观测性、审计可信度都已达标甚至反超；真正要补的是 **Codex 桌面端的三块硬骨头（并行监督 / 内联 diff 审查 / 回滚检查点）+ 工程化地基（测试/a11y/流式）**。建议先啃阶段 0 + 阶段 1，用最低成本把"与 Codex 桌面端对齐"这一最显性的差距抹平，再把 OH 自身优势做成对外卖点。云端委派/跨设备续接属架构级，应作为独立产品线规划，不混入本轮 UI 冲刺。
