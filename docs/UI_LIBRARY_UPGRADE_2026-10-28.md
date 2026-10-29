# 前端 UI 升级规划：Ant Design 6 · 全站一次替换

> 状态：**实施中（2026-10-28 用户拍板「全面开工」；W0 已完成，见 §0.5；分支 `feat/antd-ui`，
> 独立 worktree `D:\deepseek\omniharness-antd`——主工作区由并行会话占用，合并前 main 不动）**。
> 配套决策记录：[adr/0018-antd-ui-redesign.md](adr/0018-antd-ui-redesign.md)（已接受）。
> 进度与门禁状态只认 [PROJECT_BOARD.md](PROJECT_BOARD.md)；本文件是 2026-10-28 的**规划快照**，
> 数字在 W0 实测后更新一次（§0.5 已更新）。

## 0. 结论（TL;DR）

- **选型**：**Ant Design 6.6.8** 作为全站控件基座（MIT；48 个直接运行时依赖；49.1MB unpacked；
  2026-10-26 仍在发版；peer `react >= 18`，本仓 React 19.2 可用）。
- **节奏**：按已确认的「一次性替换全站」执行——**单分支 `feat/antd-ui`、单次合并**；合并前 `main`
  的旧 UI 一行不动。所谓"一次性"指**最终状态没有新旧两套控件并存**，不是"一个提交写完"。
- **视觉立场**：**Ant 做骨架，纸与墨 v2 做皮肤**。组件行为、焦点、键盘、浮层、动效直接用 antd；
  颜色、圆角、字体、密度、留白仍由我们定义。否则「缺少品牌记忆点」这条痛点会被 antd 的默认观感放大。
- **规模**：68 个 `.tsx` / 14,049 行；13 个样式表 / 9,766 行；123 个前端判据文件 / 641 例；
  169 处 class 契约；12 条真 Chrome 判据；入口 bundle **849KB / 上限 900KB**。
- **估算**：**12–17 个工作日**（按本仓 agent 批次约 10–14 批），其中 W0 PoC 0.5–1 天。
- **三个必须先拍板的闸**：① 依赖准入（49MB / 48 依赖，超默认 2MB / 20）；② 入口与总 JS 预算；
  ③ 工具提示策略（124 处原生 `title`）——**2026-10-29 改为：保留 `title`，由 `TooltipLayer` 全站接管**，见 §6.3。
  —— **均已拍板（2026-10-28 用户「全面开工」+ W0 实测）**：①已登记 allowlist（override 52000KB / 60 依赖）；
  ②预算按 §0.5 实测重写；③按 §6.3 执行。

## 0.5 W0 实测结论（2026-10-28，**Go**）

> 隔离入口 PoC（`web/poc/antd.html`，产物 `web/dist-poc/`，独立构建 `vite.poc.config.ts`，主产物零影响）。
> 组件面：Button/Table/Select/Modal/Tree/Form/DatePicker/Tooltip/Tabs/Progress/Tag/Alert/Switch + ThemeProvider + zh_CN。

**体积（gzip 口径，`vite build` 实测）**

| 产物                        | raw      | gzip         | 说明                                               |
| --------------------------- | -------- | ------------ | -------------------------------------------------- |
| 基线主入口（无 antd）       | 824.8 KB | 281.9 KB     | 含 react 基座 / markdown-it / highlight.js         |
| 基线异步块 ×13              | 330.4 KB | 103.7 KB     | katex 77.7 KB 为最大件                             |
| PoC vendor-react            | 223.6 KB | 69.4 KB      | react + react-dom + scheduler（基线里已含）        |
| **PoC vendor-antd（子集）** | 893.7 KB | **289.9 KB** | 含 Form/DatePicker/Table(virtual)/Tree/dayjs/zh_CN |
| PoC 应用码                  | 9.1 KB   | 3.9 KB       | PoC 页本体                                         |

- **增量结论**：antd 基座 ≈ **+290 KB gzip**（超出规划预估的 120–200 KB）；全量面板迁移预计再
  +20–40 KB（Descriptions/Timeline/Statistic/Upload/AutoComplete/Dropdown/Drawer 等轻组件），
  最终 vendor-antd ≈ 310–330 KB gzip。**预算重写**（合并闸 §8 第 2 条替换为）：
  首屏 JS = entry + vendor-react + vendor-antd **≤ 630 KB gzip**；async ≤ 170 KB（现有 104 + antd 面板懒加载余量）；
  CSS ≤ 40 KB 不变（antd 是 CSS-in-JS 运行时注入，不进静态 CSS；W5 删旧 CSS 后预期降至 ~15 KB）。
  vendor 分块使发版只失效应用 chunk，vendor 跨版本命中缓存。
- **口径修正**：`manualChunks` 必须用**函数形态**（object 形态抓不到 react/cjs 重导出，实测产出 0KB 空 chunk）。

**皮肤接线（真机实测，探针 `web/test/antdPocProbe.ts`）**

- `--ant-*` CSS 变量：**默认不注入**；`theme.cssVar: { prefix: 'ant' }` 显式开启后注入 381 个，
  作用域在 antd App 包裹层（`.ant-app.css-var-*`），不在 `:root`——antd.css 与判据从该作用域取值。
- **darkAlgorithm 会把语义 seed 强制压暗**（#a8b4e8 → #929cc8），且四条补救路全堵（实测）：
  显式传 token 无效（seed 层映射）、嵌套 Provider 继承算法、反解 seed 色相漂移、布尔 cssVar 已废。
  ⇒ **两套主题同走 defaultAlgorithm + 中性面全量显式覆盖**（表面阶梯本来就是我们的 token）；
  dark 语义 hover/active 用显式 map token 给提亮档（实测显式 map token 会被保留）。
- **主按钮底色 === palette accent**：dark #a8b4e8 / light #3d4a86 精确命中（colorSystem ③ 契约保持）。

**对比度（WCAG，`web/src/ui/theme/contrast.ts` 计算）**

- dark：正文 on bg 15.16:1、次要 8.23:1、主按钮字 on 靛墨 8.92:1、靛墨强调字 8.69:1、
  边线 3.41:1（≥3 非文本）——**14 组关键配对全达标**；light 同清单全达标。
- 样张：`web/archive/antd-poc-{dark,light}-*.png`（密度 controlHeight 32 / fontSize 14 / 圆角 10·14·8，
  纸面卡片、panel-2 表头、白气泡口径全部成立）。

**Go / No-Go**：**Go**——体积按上述预算重写执行；回退候选 Mantine 9 不再启用（除非 W1 分块实测超预算 +10%）。

## 1. 现状基线（2026-10-28 实测）

| 维度 | 实测                                                          | 含义                                     |
| ---- | ------------------------------------------------------------- | ---------------------------------------- |
| 组件 | 68 个 `.tsx`，14,049 行                                       | 全部手写，无 UI 库                       |
| 样式 | 13 个文件，9,766 行；`minimal.css` 3,929 行                   | 唯一视觉事实源，级联顺序受判据保护       |
| 判据 | 123 个文件 / 641 例；169 处 class 契约；12 条真 Chrome        | class 选择器与 DOM 结构强耦合            |
| 构建 | 单入口 `index-*.js` 848,660 B（上限 900,000 B）；KaTeX 异步块 | 预算余量仅 ~51KB                         |
| 主题 | `theme.css` 双主题 token（纸与墨）                            | 颜色单一事实源；CSS-in-JS 接入需定新边界 |
| 依赖 | react 19.2 / markdown-it / katex / highlight.js               | 无任何 UI 库；准入清单 7 条              |
| 桌面 | Electron 壳 + 同一份 Web 产物；未发现 CSP `style-src` 限制    | antd 的 CSS-in-JS 可运行                 |

## 2. 痛点 → 方案映射

| 你勾选的痛点       | antd 直接给什么                                                     | 我们还要补什么                                                           |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 控件观感旧、不统一 | Button / Menu / Select / Modal / Tooltip / Tabs 的统一状态矩阵      | 主题 token + 「禁止再手写 `.btn`/`.dd`/`.modal`」纪律                    |
| 层级与留白不清     | Layout / Card / Space / Divider / Typography 的间距体系             | 紧凑密度 token、4px 栅格、页面级留白规范（antd 默认偏松）                |
| 交互反馈不精致     | 内建 motion、loading、hover/active/focus、message/notification      | 统一时长/曲线、`prefers-reduced-motion`、面板过渡                        |
| 缺少品牌记忆点     | **不提供**                                                          | Ω 字标、靛墨、纸面、自研图标与空态；antd 只做骨架                        |
| 复杂控件缺失       | Table（含 `virtual`）、Tree、Form、DatePicker、AutoComplete、Upload | 日志/审计大表用虚拟表格；日期统一 dayjs；命令面板用 Modal + AutoComplete |

## 3. 选型与依赖准入

### 3.1 候选实测（2026-10-28，npm registry）

| 库           | 版本       | 直接依赖          | unpacked | 许可 | 判断                                                        |
| ------------ | ---------- | ----------------- | -------- | ---- | ----------------------------------------------------------- |
| **antd**     | 6.6.8      | 48                | 49.1MB   | MIT  | **选定**：组件面最全（表格/树/表单/日期/上传），正好补痛点⑤ |
| Mantine      | 9.7.4      | 5                 | 10.1MB   | MIT  | 更轻、现代；作为 W0 不通过时的回退候选                      |
| Radix Themes | 3.3.0      | 4                 | 4.9MB    | MIT  | 最轻的"带观感"库，但复杂控件少                              |
| Chakra       | 3.37.0     | 7 (+emotion peer) | 2.7MB    | MIT  | 需额外 emotion 运行时                                       |
| Base UI      | 1.0.0-rc.0 | 7                 | 4.3MB    | MIT  | 仍是 rc，且无样式                                           |

### 3.2 准入登记草案（实施 W1 时写入 `dependency-allowlist.json`）

```json
"antd": {
  "reason": "全站 UI 升级：68 个自研组件 / 9,766 行 CSS 在控件状态矩阵、复杂控件与可达性上重复造轮子；antd 是 React 生态组件覆盖最完整的库，用户明确要求用组件库重做前端。",
  "capability": "30+ 组件族（Button/Menu/Select/Table/Tree/Form/DatePicker/Modal/Tooltip/Tabs/Upload…）、主题 token 与暗色算法、i18n、焦点/键盘/浮层行为、动效。",
  "license": "MIT",
  "approvedAt": "（实施日）",
  "layer": "web/src/ui",
  "exitPlan": "业务组件只经 ui/theme（token）与 ui/kit（产品封装）消费 antd；若停更，替换目标为 Mantine 9 / Radix Themes 3，替换面 = theme + kit + 可枚举的直接 import 点（codemod），数据层/RPC/状态零改动。",
  "maxInstallKb": 52000,
  "maxTransitiveDeps": 60,
  "budgetOverrideReason": "实测 49.1MB / 48 个直接依赖，双超默认 2MB/20；它是整站 UI 唯一基座、覆盖全部页面，MIT，且 2026-10-26 仍在发版。"
}
```

> 这是本仓**第一次**引入全站级 UI 框架，按 `docs/DEPENDENCY_POLICY.md` 需要单独审批与 ADR。

## 4. 视觉规格 v2（Ant 骨架 + 纸与墨皮肤）

### 4.1 seed / map token

| token                         | light               | dark      | 来源                   |
| ----------------------------- | ------------------- | --------- | ---------------------- |
| `colorPrimary`                | `#3d4a86`           | `#a8b4e8` | 现有 `--accent`        |
| `colorSuccess`                | `#3a7150`           | `#8fbf9f` | `--ok`                 |
| `colorWarning`                | `#7d5a1c`           | `#d4b06a` | `--warn`               |
| `colorError`                  | `#a6362f`           | `#e89a92` | `--err`                |
| `colorInfo`                   | `#3f5680`           | `#9fb3d9` | `--info`               |
| `colorBgBase`                 | `#f8f7f4`           | `#17191c` | `--bg`                 |
| `colorTextBase`               | `#1a1d21`           | `#eceef2` | `--text`               |
| `borderRadius` / `LG` / `SM`  | 10 / 14 / 8         | 同左      | `--r-md/--r-lg/--r-sm` |
| `controlHeight` / `SM` / `LG` | 32 / 28 / 38        | 同左      | 紧凑 IDE 密度          |
| `fontSize` / `lineHeight`     | 14 / 1.6            | 同左      | 中文正文可读性         |
| `boxShadow` / `Secondary`     | 现有 `--shadow-1/2` | 同左      | 浮层语言不变           |

### 4.2 组件级覆盖（只列会"露馅"的）

- **Button**：`defaultShadow: none`、`primaryShadow: none`、`fontWeight: 500`、`paddingInline: 14`。
- **Card**：`headerBg: transparent`、`paddingLG: 16`、`boxShadowTertiary: none`（纸面不投影）。
- **Menu**：`itemHeight: 34`、`itemBorderRadius: 8`、`itemMarginInline: 4`、`itemBg: transparent`。
- **Table**：`headerBg: panel-2`、`cellPaddingBlockSM: 6`、`headerSplitColor: transparent`、`size: small`。
- **Tabs**：`horizontalItemPadding: 10px 0`、`titleFontSize: 14`、去默认 ink bar 换 2px 墨线。
- **Modal / Drawer**：`borderRadiusLG: 16`、`contentBg: panel`、遮罩沿用现有 `rgba(10,12,16,.62)`。
- **Tooltip**：`colorBgSpotlight` 按主题取纸片色（浅色纯白 / 深色近白）、`colorTextLightSolid` 取深字，
  保持 2026-10-28 已定的"白气泡"观感；`borderRadius: 10`。
- **Layout**：`siderBg/bg` 沿用表面阶梯；**不引入 antd 默认蓝**。
- **Progress / Tag / Segmented / Collapse / Descriptions / Empty**：统一走 4.1 的半径与语义色。

### 4.3 品牌层（antd 不提供，必须自己做）

- Ω 标记 + `OmniHarness` 字标 + 靛墨强调，保持唯一签名色。
- 图标：**保留现有自研线性图标**（产品动作），antd 图标只用于通用动作（关闭/搜索/箭头/更多）。
- 空态 / 加载 / 错误三种插画用 CSS/SVG 自绘，不引图库。
- 反目标：渐变、玻璃拟态、重投影、antd 默认蓝、默认 6px 圆角、默认字体。

## 5. 组件映射表（当前 → antd）

### 5.1 壳层与导航

| 现在                                  | 目标                               | 备注                                                                                                                                               |
| ------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.app` / `.body` / `.col` + `Resizer` | Layout + 自研 grid                 | **保留 Resizer**（antd 无拖拽分栏）                                                                                                                |
| `ChatHeader`                          | Flex / Space / Typography / Button | 标题截断与来源路径保留                                                                                                                             |
| `SidebarHeader`                       | Flex + 自研 Ω 字标                 | 品牌区                                                                                                                                             |
| `SessionPanel` / `SessionViews`       | List + Dropdown + Tree             | 会话行仍是自研虚拟/分组逻辑                                                                                                                        |
| 文件树                                | Tree                               | 拖拽/右键重命名走 Tree API                                                                                                                         |
| 会话拖拽排序                          | **保留自研 pointer 逻辑**          | antd 无 DnD；不为此引 dnd-kit                                                                                                                      |
| `ConsoleView` 左导航                  | Layout.Sider + Menu                | 设置/面板唯一入口                                                                                                                                  |
| 右栏标签                              | Tabs（editable-card）              | 关闭按钮与溢出滚动                                                                                                                                 |
| `CommandPalette`                      | Modal + 自研 listbox               | 键盘模型（↑↓/Enter/Esc）与 combobox 语义保留自研；AutoComplete 会渲染第二个下拉并抢 `aria-activedescendant`，实测与自研键盘模型冲突（见看板 §172） |
| `Drawer` / backdrop                   | Drawer                             | 移动端左栏                                                                                                                                         |

### 5.2 输入区

| 现在               | 目标                                   | 备注                                  |
| ------------------ | -------------------------------------- | ------------------------------------- |
| `textarea`         | Input.TextArea `autoSize`              | 上限 140px、Enter 发送逻辑不动        |
| 附件 chip          | Tag closable / Upload                  | 文件选择仍走现有 RPC                  |
| 权限 / 模型 / 容量 | Dropdown / Select / Popover / Progress | 三个弹层的互斥逻辑保留 `PopoverStack` |
| 发送 / 停止 / 语音 | Button + Spin                          | 快捷键与禁用态不变                    |
| 悬浮提示           | 保留原生 `title` + `TooltipLayer` 接管 | 见 §6.3（2026-10-29 口径反转）        |

### 5.3 会话流（**热路径，谨慎**）

| 现在                              | 目标                                | 备注                              |
| --------------------------------- | ----------------------------------- | --------------------------------- |
| `StreamView` 虚拟化容器           | **保留自研**                        | 400/800 条渲染上界判据不动        |
| `UserCard` / `AssistantCard`      | Typography + Space（助手不套 Card） | 避免"卡片套卡片"回归              |
| `ToolCallCard` / `ReasoningBlock` | Collapse + Descriptions + Tag       | 折叠状态与钻取事件保留            |
| `TurnSummaryCard`                 | Card + List + Button                | 文件行仍用表格布局                |
| `Todo`                            | Progress + Checkbox/List            |                                   |
| `ApprovalModal`                   | Modal + Button                      | 键盘焦点与 Esc 语义不变           |
| `QuestionCard`                    | Radio / Checkbox / Input / Button   | 逐题作答逻辑不动                  |
| Markdown / 代码高亮 / Diff / 图表 | **保留自研**                        | antd 无等价物；只换排版变量与外框 |
| Toast / Dialog                    | `App.useApp()` 的 message/modal     | 删除 `Toast` / `DialogHost`       |

### 5.4 控制台与面板

| 现在                                                        | 目标                                                |
| ----------------------------------------------------------- | --------------------------------------------------- |
| `SettingsSurface` 表单                                      | Form + Select + Switch + InputNumber + Card + Alert |
| `PermissionTab` / `ProviderCard` / `MemoryTab` / `VaultTab` | Form + Table + Empty + Alert                        |
| `ActivityTab` / `MetricsTab` / `GovernanceTab`              | Table（virtual）+ Statistic + Descriptions          |
| `TraceTab` / `DetailTab`                                    | Descriptions + Collapse + Timeline                  |
| `ChangesTab` / patch 视图                                   | Tree + **保留自研 diff 渲染**                       |
| `PluginsTab` / `SkillsTab` / `AutomationsTab`               | Card + Table + Tag + Switch                         |
| `FilePicker` / `FolderPicker`                               | Modal + Tree + Input + Button                       |
| `FileTab` / `BrowserPane`                                   | 保留 iframe 与代码渲染，只换外框与工具栏            |
| `GraphTab`                                                  | **保留自研图渲染**，工具条换 antd                   |

## 6. 架构与边界

### 6.1 新增目录

```
web/src/ui/theme/
  palette.ts        # 唯一颜色事实源（hex），供 antd token 与对比度判据共用
  antdTheme.ts      # light/dark 两套 ThemeConfig + 组件级 token
  ThemeProvider.tsx # ConfigProvider + AntApp + zhCN + reduced-motion
web/src/ui/kit/
  PageHeader / PanelSection / DataTable / EmptyState / StatusTag / FormField / ConfirmButton
web/styles/
  antd.css          # reset + 壳层/自定义表面（diff、markdown、代码、图）
```

- **单一颜色事实源**：`palette.ts` 的 hex 同时喂 antd token 与 `antdTheme.test.ts` 的 WCAG 计算；
  删除 `theme.css` 里重复的颜色定义，自定义 CSS 一律消费 antd 生成的 `--ant-*` 变量
  （CSS 变量模式由 ConfigProvider 注入；v6 若默认关闭则在 W0 显式开启并验证变量名稳定）。
- **antd 只出现在 `web/src/ui/**`**：后端 `src/**` 继续零第三方；新增一条源码守卫，禁止
  `web/src/core/**` 与 `web/src/types/**` 引用 antd。
- **状态层不动**：AppController / 各子控制器 / RPC / SSE / 虚拟化 / markdown / diff / 图 全部保留；
  这次只换视图层与样式层。

### 6.2 运行时装配

- `App` 外层：`ThemeProvider`（`theme` 由现有 `themePref` 解析）→ `ConfigProvider locale={zhCN}` →
  antd `App`（提供 message/modal/notification 上下文）→ 现有 App。
- 组件尺寸：`ConfigProvider componentSize="middle"` + `controlHeight: 32`；表格统一 `size="small"`。
- i18n：antd 内建文案走 `zhCN`；业务文案继续走现有 `t()`，不把中文散进 antd props。
- 动效：统一 110–180ms / `cubic-bezier(.16,1,.3,1)`；`prefers-reduced-motion` 全局关。

### 6.3 工具提示（124 处 `title`）——**2026-10-29 口径反转，以 `TooltipLayer` 为准**

- **终态（2026-10-29 用户拍板）**：保留原生 `title`，由 `HoverTips` + `TooltipLayer` 全站接管
  （事件委托读 `title` → 扁平纸片气泡、280px 限宽，见 `docs/DESIGN_SYSTEM.md`「悬浮提示」节）。
  **不做** antd `Tooltip` 逐处迁移；W2 批一已按此回滚（revert `9ea15d04`），
  `antdBoundary` 的「已迁移组件不得再有原生 title」守卫一并撤除。
- **为什么不走 antd Tooltip**：① 全站 120+ 处，逐处包装要动 flex/grid 层级（下面「风险」那条正是它）；
  ② 组件库的 Tooltip 没有「整站统一」的入口——新加一处 `title` 就又漏一处；
  ③ 用户 2026-10-28 要的是「收窄 + 圆角 + 扁平」，事件委托一层就能覆盖全部，且跟随主题。
- **例外**：`iframe[title]` / `abbr[title]` 等**语义/无障碍必需的 title 保留**（接管只影响悬停展示：
  显示期间把 `title` 暂存到 `data-tip`、离开即还原）。
- 风险（仍成立）：antd `Tooltip` 若在个别弹层内需要，包装会改变 flex/grid 层级，需逐处确认布局。

### 6.4 测试与门禁改造

| 现状                                                                | 改造                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `rtlHarness` 裸渲染                                                 | 统一包 `ThemeProvider`；W1 新增测试 setup（`matchMedia` / `ResizeObserver` polyfill，落在 `web/test/`） |
| 169 处 class 契约                                                   | 改 `getByRole` / `data-testid`；kit 组件统一透传 `data-testid`                                          |
| 12 条真 Chrome 选择器（`.dd.perm`、`.session`、`.composer-input`…） | 改为 role/testid；悬停仍用 `CdpSession.hover`                                                           |
| `vendorFreePipeline` 入口 <900KB、单入口                            | 新增 vendor 分块；预算按 W0 实测重设；断言"总数 + 分块存在"                                             |
| `colorSystem` / `a11yContrast`                                      | 颜色源改为 `palette.ts`；新增 `antdTheme.test.ts`（seed 与 palette 一致、对比度 ≥4.5）                  |
| `longSessionPerf` / `streamScrollCoverage`                          | 保留；新增"antd 组件不进入虚拟窗口热路径"的守卫                                                         |
| axe（两主题 × 两状态）                                              | 保留；antd 弹层新增扫描（菜单/模态/Tooltip）                                                            |

## 7. 工作包（分支内顺序，对外一次合并）

### W0 · 基线与 PoC（0.5–1 天）— **Go / No-Go**

- 建分支 `feat/antd-ui`；截 8 个关键界面 × 双主题基线图（空态、会话流、输入区菜单、设置、右栏、
  审批、命令面板、窄视口）。
- 在隔离入口做 PoC：`Button/Table/Select/Modal/Tree/Form/DatePicker/Tooltip` + ThemeProvider，
  实测 gzip、分块、首屏 JS 增量、暗色对比度。
- 产出：体积/预算结论 + 密度与字体样张 + Go/No-Go（不通过则回退 Mantine 9，映射表可复用）。
- **退出判据**：PoC 页双主题可读、axe 0 serious、体积数字写回本文件与看板。

### W1 · 基础设施（1–2 天）

- 依赖准入登记 + ADR 接受；`antd@6.6.8` 精确锁版本。
- `palette.ts` / `antdTheme.ts` / `ThemeProvider` / `antd.css`；CSS 变量边界。
- `ui/kit` 骨架 + 测试 setup + 源码守卫（antd 只在 `web/src/ui/**`）；构建分块与预算判据。
- **退出判据**：旧 UI 在 ThemeProvider 下不回归；`web:test` 全绿；新主题判据绿。

### W2 · 壳层与导航（2–3 天）

- App/Header/侧栏/会话列表/文件树/右栏标签/抽屉/命令面板骨架换 antd；删除对应旧 CSS 段。
- **退出判据**：三栏几何、Resizer、拖拽排序、快捷键、`[` 图标条判据全绿。

### W3 · 会话流与输入区（3–4 天）

- 流内卡片/折叠/标签、Composer、三个弹层、审批/提问/todo、Toast→message（工具提示不再迁移，见 §6.3）。
- **退出判据**：虚拟化渲染上界、滚动无空洞、键盘全链路、审批门户、axe 全绿。

### W4 · 控制台与全部面板（3–4 天）

- 设置 + 15 个面板换 Form/Table/Tree/Descriptions/Card；文件/文件夹选择器；图表与 diff 外框。
- **退出判据**：每个面板的既有契约测试改绿；大表滚动性能实测；窄视口无横向溢出。

### W5 · 收口（2–3 天）

- 删除旧样式表（约 9.7k 行）；**保留** `HoverTips/TooltipLayer` 与全站 `title`（§6.3 口径）。
- 641 例判据改写完成；截图复核双主题；`DESIGN_SYSTEM.md` v2；看板记档；合并 `main`。
- **退出判据**：见 §8。

## 8. 验收口径（合并闸）

1. `web:test` 全绿（含改写后的组件/Chrome 判据），新增主题与体积判据。
2. 入口 + vendor 分块总量 ≤ W0 实测预算 + 10%；KaTeX 仍异步。
3. axe：两主题 × 空态/控制台/弹层，0 serious/critical。
4. 长会话：400/800 条渲染上界不变；滚动无空洞；输入区焦点/快捷键判据全绿。
5. 8 个关键界面 × 双主题截图人工复核（层级、密度、品牌、中文排版）。
6. `node scripts/check.mjs --strict` + `gate:typed` 全绿；依赖准入/许可证门禁绿。
7. 无原生 `title` 气泡（语义必需的 `iframe/abbr` 除外）。

## 9. 风险登记册

| 风险                      | 概率/影响 | 缓解                                                                            |
| ------------------------- | --------- | ------------------------------------------------------------------------------- |
| 观感变成"通用 antd"       | 高 / 高   | 品牌层 + 主题 token；每屏截图复核；默认蓝/默认圆角列入反目标                    |
| 密度过松，一屏信息量下降  | 高 / 中   | `controlHeight 32`、表格 small、Menu 34；以现有截图逐屏对比                     |
| 体积超预算                | 高 / 中   | W0 实测；`manualChunks` 拆 vendor；重组件（Table/DatePicker）按需               |
| 169 处 class 契约改写遗漏 | 中 / 高   | 先改测试基座（role/testid），按组件批次迁移；Chrome 判据兜底                    |
| CSS-in-JS 运行时开销      | 中 / 中   | v6 CSS 变量模式；热路径（虚拟流）不套 antd 组件                                 |
| antd v6 较新（2026 发布） | 中 / 中   | 精确锁版本；W0 验证关键组件；读 changelog                                       |
| 触屏/长按无法触发 `title` | 中 / 中   | 提示只做"补齐说明"，关键信息与 aria-label 同源；不把唯一入口放进悬停            |
| 一次性分支长期不同步      | 中 / 高   | 每周从 main rebase；W1 后先合"基础设施"空转批？——不，保持单次合并，但每周跑全量 |
| 桌面端打包/离线异常       | 低 / 高   | W0 在 Electron 里跑一遍 PoC；无 CSP 限制已确认                                  |

## 10. 拍板记录（2026-10-28，用户「全面开工」+ W0 实测）

1. **依赖准入**：✅ antd@6.6.8 精确锁版写入 `dependency-allowlist.json`（override 52000KB / 60 依赖，MIT）。
2. **体积预算**：✅ 按 W0 实测重写——首屏 JS = entry + vendor ≤ 630 KB gzip、async ≤ 170 KB、
   CSS ≤ 40 KB（见 §0.5）。实际增量 +290 KB gzip 超出原预估 120–200 KB，用户在拍板②里已授权
   「以 W0 实测为准」；Mantine 9 回退线保留在「W1 分块实测超预算 +10%」。
3. **视觉立场**：✅ 「Ant 骨架 + 纸与墨 v2 皮肤」，§4 token 映射全部落地（PoC 样张已复核）。

执行从 **W0** 开始（已完成）：建分支、装精确版本、截基线、跑 PoC，实测结论见 §0.5，随后进入 W1。
