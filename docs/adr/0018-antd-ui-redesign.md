# 0018 前端组件库：Ant Design 6 全站重做（Ant 骨架 + 纸与墨皮肤）

- 日期：2026-10-28
- 状态：**已接受（2026-10-28 用户拍板「全面开工」；W0 PoC 实测通过，见 Go 结论）**
- 关联：[UI_LIBRARY_UPGRADE_2026-10-28.md](../UI_LIBRARY_UPGRADE_2026-10-28.md)（实施规划）
- 影响面：`web/src/ui/**` 全部视图、`web/styles/**`、前端判据与构建预算

## 背景

前端现有 **68 个自研组件 / 14,049 行 TSX**、**13 个样式表 / 9,766 行 CSS**（`minimal.css` 是唯一
视觉事实源），控件状态矩阵、复杂控件（表格/树/表单/日期/浮层）与焦点/键盘/可达性全部手写，
每加一个页面都在重复造轮子。2026-10-28 用户在结构化选择中明确：

- 痛点全选：控件观感不统一、层级留白不清、动效反馈弱、缺品牌记忆点、复杂控件缺失；
- 方向：**Ant Design 重做**；
- 节奏：**一次性替换全站**（最终状态不并存新旧两套控件）。

选型实测（2026-10-28）：antd 6.6.8，MIT，48 个直接运行时依赖，49.1MB unpacked，2026-10-26 仍在
发版，peer `react >= 18`（本仓 React 19.2）。

## 决策

1. **采用 `antd@6.6.8` 作为全站控件基座**，精确锁版本；按依赖准入政策登记并申请体积 override
   （52,000KB / 60 依赖）。
2. **单分支 `feat/antd-ui`、单次合并**：合并前 `main` 旧 UI 不动；"一次性"指最终状态不并存。
3. **Ant 做骨架，纸与墨 v2 做皮肤**：颜色、圆角、字体、密度、留白由 `ui/theme` 定义；
   antd 只提供组件行为、焦点/键盘、浮层、动效。**不采用 antd 默认蓝/默认圆角**。
4. **边界**：antd 仅允许出现在 `web/src/ui/**`（后端与 `web/src/core` 零第三方）；业务组件经
   `ui/theme` + `ui/kit` 消费；状态层（AppController / RPC / SSE / 虚拟化）不动。
5. **保留自研**：Markdown/代码高亮、Diff、图表、虚拟会话流、拖拽分栏与拖拽排序——这些没有
   antd 等价物，换成库只会更差。
6. **工具提示终态**：改用 antd `Tooltip`，删除 2026-10-28 的自绘 `HoverTips/TooltipLayer`；
   语义必需的 `iframe/abbr[title]` 例外。
7. **判据同步改造**：169 处 class 契约改 role/testid；新增 `antdTheme.test.ts`（palette 与
   token 一致、对比度 ≥4.5）与体积分块判据；axe、虚拟化、长会话判据保留。

## 后果

- **正面**：30+ 组件族一次到位（Table 含 virtual、Tree、Form、DatePicker、Upload、Modal、
  Tooltip、Tabs），状态矩阵与可达性由成熟实现承担；设计系统可收敛为一套 token；后续页面开发
  不再手写按钮/菜单/表单。
- **负面（W0 实测后更新）**：安装树从 7 条 allowlist 条目跳到 +48 个直接依赖 / 49.1MB；
  **antd 基座实测 +290KB gzip**（PoC 子集 vendor-antd 289.9KB，超出本 ADR 初稿预估的 120–200KB；
  全量面板迁移预计最终 310–330KB），预算已按实测重写为「entry + vendor ≤ 630KB gzip」
  （[UI_LIBRARY_UPGRADE §0.5](../UI_LIBRARY_UPGRADE_2026-10-28.md)）；`web/styles` 约 9.7k 行旧 CSS 要删；
  169 处 class 契约与 12 条真 Chrome 选择器要改写；一次性分支周期长（预计 12–17 个工作日）。
- **品牌风险**：antd 默认观感偏"通用企业后台"，与已勾选的"缺品牌记忆点"直接冲突 ⇒ 主题映射与
  品牌层（Ω/靛墨/纸面/图标/空态）是**硬要求**，不是可选项。
  **W0 已证实可行**：两主题同走 defaultAlgorithm + 中性面显式覆盖（darkAlgorithm 会强制压暗语义 seed，
  实测 #a8b4e8 → #929cc8 且四条补救路全堵），主按钮底色与 `--accent` 精确一致，对比度 14 组配对全达标。
- **回退**：W0 PoC 已达标，Mantine 9（5 依赖 / 10.1MB）回退线收窄为「W1 分块实测超预算 +10%」；
  组件映射表与 theme/kit 边界可复用，替换面集中在 `ui/theme` + `ui/kit`。

## 替代方案

- **Mantine 9.7.4**（5 依赖 / 10.1MB / MIT）：更轻、更现代；复杂控件略少于 antd，作为回退首选。
- **Radix Themes 3.3.0**（4 依赖 / 4.9MB）：最轻的"带观感"库；复杂控件需配 Radix primitives 自组。
- **Chakra 3.37**（7 依赖 + emotion peer）：需额外 CSS-in-JS 运行时。
- **无样式基座（Radix / Base UI）**：体积与测试改动最小，但"美观升级"仍需自建设计语言；
  用户明确选择 antd 后不采用。
- **继续自研**：维持现状 68 组件/9.7k CSS，每页重复造控件；与用户决策相反。

## 参考

- [UI_LIBRARY_UPGRADE_2026-10-28.md](../UI_LIBRARY_UPGRADE_2026-10-28.md)（基线、映射、W0–W5、风险）
- [DEPENDENCY_POLICY.md](../DEPENDENCY_POLICY.md)（准入六项、体积预算、退出计划）
- npm registry 实测（2026-10-28）：`antd@6.6.8` 依赖与体积、`react@19.2`
- 现有视觉事实源：`web/styles/minimal.css`、`web/styles/theme.css`、`docs/DESIGN_SYSTEM.md`
