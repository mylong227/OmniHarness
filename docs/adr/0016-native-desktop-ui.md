# 0016 原生桌面 UI：Avalonia 主选 / WinUI 3 备选（不做 WebView 套壳）

- 日期：2026-10-24
- 状态：**已废止**（用户改选“按 Codex 官方 App 方式完成”，由 [0017](./0017-electron-official-app.md) 取代）
- 原取代：[0015](./0015-desktop-shell.md)（Electron + WebView，已废止）
- 范围：桌面客户端主界面；不改 Harness 业务逻辑、HTTP/SSE 契约与 CLI

## 背景

用户明确要求**不做套壳的桌面应用**：主界面不能是“把现有 Web 工作台装进 WebView”的
Electron/Tauri 形态。桌面应用必须是原生 UI 树、原生输入/焦点/无障碍/渲染；Harness 仍是
本地服务。

现状约束：

1. 现有 Web 工作台规模为 172 个源文件 / 26,573 行 TS/TSX、62 个 TSX 组件、259 KB CSS、
   99 个测试文件 / 14,036 行。原生化不是“换个壳”，而是重写 UI 层。
2. 产品是中文优先的 AI Agent 工作台，流式 Markdown、代码、LaTeX、长会话、IME、无障碍
   是核心体验，不是附属功能。
3. Harness 是核心资产，必须复用。桌面 UI 只替换“浏览器客户端”；Node 侧车仍是
   `process.execPath`、N-API、插件 Worker、沙箱语义的载体。
4. 团队以 TS/Rust 为主，没有 C#/XAML 经验；引入新语言是重大成本，必须选生态最成熟、
   最接近现有工程文化的方案。

## 决策

**主方案：Avalonia 12.1.x + .NET 10 + LiveMarkdown.Avalonia 2.5.x + Node 24 侧车 + Velopack。**

**备选：WinUI 3 / Windows App SDK 2.5**，仅在产品明确 Windows-only、且 Phase 0 bake-off
证明 Avalonia 的 IME/无障碍/文本保真不达标时启用。

具体约束：

1. **主界面无 WebView**：不允许 Electron/Tauri/NW.js/WebView2 承载主 UI；Avalonia 的
   控件树、文本布局、输入、焦点、无障碍、渲染都是原生的。
2. **Harness 不变**：仍跑 `node.exe serve --port 0`，原生客户端用 `Authorization: Bearer`
   调 `/rpc`、`/events`；不再有 Cookie/CORS/CSP/ASAR 这层。
3. **富文本用现成件**：LiveMarkdown.Avalonia（Apache-2.0）负责流式 Markdown、代码高亮、
   LaTeX、Mermaid、表格、选择/搜索；不自研 Markdown 渲染器。
4. **先修 Harness 前置**：`--experimental-permission` → `--permission`；`OMNI_READY_FILE`；
   `OMNI_CONTROL_STDIO`；`OMNI_NO_UI_URL`；`OMNI_NO_SERVE_INSTANCE`；缓存目录指向
   `%LOCALAPPDATA%`。
5. **打包/更新**：Velopack 1.2.x，自包含 .NET 10；第三方控件 AOT 兼容后再评估 NativeAOT；
   per-user 安装、代码签名、差分包、N-1 回滚。
6. **保留 Web UI 作为浏览器/远程客户端**；原生 Beta 前冻结 Web 新功能，避免双端追逐。

## 后果

- 正面：满足“不做套壳”；无 Chromium 的 WebView 攻击面；跨平台（Win/macOS/Linux）；
  富文本/流式渲染有现成高质量组件；IME/无障碍有官方支持；安装包比 Electron 方案小一半左右。
- 负面：UI 层重写，Windows Beta 约 6–8 个月（2 人），跨平台 GA 约 10–14 个月；团队需新增
  C#/XAML；Web UI 在一段时间内双维护；Avalonia 的“原生感”不如 WinUI 3，需要 Fluent 主题 +
  Mica + 自定义 chrome 贴近。
- 边界：v1 不做内置终端/编辑器/多窗口；预览网页先用系统浏览器（可选隔离 WebView2 仅作
  功能级预览，不作为主界面）。
- 前置可独立合入：Harness 的 P0 修复不应等桌面立项。

## 替代方案

- **WinUI 3**：Windows-only 的“最原生”，Fluent/IME/UIA 最好；但 Markdown/数学/流式需自研，
  无官方 DataGrid/可视化设计器，锁死 Windows。作为 bake-off 备选，不作默认。
- **Flutter**：自定义 UI 强、跨平台；但 Windows IME 仍有未闭环缺陷（#190042/#191194），
  对中文优先产品是红线。
- **Qt**：文本排版顶级；但 C++/QML + LGPL/商业许可 + 数学/Markdown 自研，团队不匹配。
- **Slint / egui / GPUI**：Rust 原生方向对，但富文本/聊天/无障碍生态不足；GPUI 是 Zed 内部
  框架，不是通用 SDK。
- **React Native Windows**：TS/React 心智可复用，但桌面生态窄、IME/文本/无障碍风险、C++
  工具链；不作主方案。
- **Electron / Tauri / WebView2**：仍是套壳，按用户要求否决（见 0015）。

## 参考

- [DESKTOP_ARCHITECTURE_2026-10.md](../DESKTOP_ARCHITECTURE_2026-10.md)（完整调研、架构、路线、风险、验收）
- Avalonia 12 / 12.1、Accessibility、IME、NativeAOT、Headless Testing、TrayIcon 文档
- LiveMarkdown.Avalonia 2.5.1（Apache-2.0）与 Everywhere（Avalonia AI 助手）
- WinUI 3 / Windows App SDK 2.5、MSIX App Installer
- Flutter 3.47.8 与 Windows IME issues #190042/#191194
- Velopack 1.2
