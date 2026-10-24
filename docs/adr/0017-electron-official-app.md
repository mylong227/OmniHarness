# 0017 桌面客户端：按 Codex 官方 App 的 Electron + React/TS 形态

- 日期：2026-10-24
- 状态：**已接受（用户决策）**
- 取代：[0015](./0015-desktop-shell.md)（Electron WebView，已废止）、[0016](./0016-native-desktop-ui.md)（Avalonia 原生 UI，已废止）
- 实现：`desktop/`（Electron 主进程 + preload + 既有 React 工作台）

## 背景

用户先明确“不做套壳”，团队因此调研了 Avalonia/WinUI 原生路线（ADR-0016）。随后用户要求
**按 Codex 官方桌面 App 的方式完成**。对 Codex 官方 App 的事实核对：

- 官方 Codex App 是 **Electron + Node.js**；前端为 **React + TypeScript**（OpenAI Codex App
  前端招聘明确要求；Simon Willison 的预览文章明确 Electron/Node）。
- 它不是原生控件应用，而是 Chromium 里的 React UI；本地 Codex CLI/Agent 由主进程/Node 侧承载。
- Codex CLI 本身是 Rust + Ratatui（TUI）；IDE 扩展是 VS Code Webview。

因此本 ADR 接受“与官方 App 同构”的取舍：**用 Electron + React/TypeScript 做桌面客户端，
接受 WebView 主界面**。这解决了“按官方 App 方式完成”的诉求，但不再满足 ADR-0016 的“无 WebView”
约束。

## 决策

1. **桌面壳**：Electron 44.x；主进程只做生命周期、窗口、工作区、原生菜单、日志、安全守卫。
2. **渲染层**：复用现有 React 工作台（`web/dist`），由 Harness 回环托管；窗口加载
   `http://127.0.0.1:<port>/?token=...`，首屏换 HttpOnly Cookie。**不新建第二套 React UI**。
3. **Harness**：独立 `node.exe` 侧车；`serve --port 0`；Token 经 `OMNI_SERVE_TOKEN` 注入；
   `OMNI_READY_FILE` 机器可读就绪；`OMNI_CONTROL_STDIO` 优雅停；`OMNI_NO_UI_URL` 抑制 Token 横幅。
4. **安全**：渲染层 `sandbox + contextIsolation + nodeIntegration=false`；preload 只暴露
   `window.omni` 最小桥；CSP；导航/窗口打开/权限白名单；IPC sender/origin 校验；侧车 env 清洗。
5. **打包**：`electron-builder` + NSIS 按用户安装；Harness 产物 + `node.exe` 放
   `resources/harness`；保持 `dist`/`web`/`native`/`defaults` 同级。
6. **UI 演进**：MVP 复用现有工作台；后续可把 Codex 式“项目/线程/活动流/技能/自动化”交互
   逐步做进 React 层，而不换壳。

## 后果

- 正面：与官方 App 同构；UI 100% 复用；6–8 周可出可安装 Beta；OS 集成/更新生态成熟；
  Harness 前置（ready/control/token）一次修好，Web/CLI 同样受益。
- 负面：仍是 WebView/套壳；安全面比原生大；Web UI 与桌面壳的桥接需要长期维护；
  与用户此前“不做套壳”的口径冲突——这是用户显式改选后的取舍，记录在案。
- 边界：MVP 不做托盘/自动更新/深链/多窗口；先跑通“启动 → 工作台 → 优雅退出 → 可打包”。
- 已接受成本：需要修 Harness 的 `--permission`、ready 文件、stdin 控制、Token 横幅；
  这些与 UI 框架无关，已在 `desktop/` 实现中落地。

## 替代方案

- **Avalonia 原生 UI（0016）**：满足“无 WebView”，但 6–8 个月、需重写 26k 行 UI；在用户改选
  官方 App 路线后转为历史备选。
- **Tauri 2**：更小的 WebView 壳；但不是 Codex 官方栈，生态/调试链路不同。
- **Flutter/Qt/WinUI 原生**：均需重写 UI；与“按官方 App 方式完成”不符。

## 参考

- `desktop/README.md`（构建/运行/打包）
- `docs/DESKTOP_ARCHITECTURE_2026-10.md`（v2 原生研究；顶部已标注被本 ADR 取代）
- Codex 官方 App：Electron + Node.js / React + TypeScript（Simon Willison 2026-02-02；OpenAI 招聘）
- Codex CLI TUI：Rust + Ratatui
