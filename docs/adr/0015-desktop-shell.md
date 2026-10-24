# 0015 桌面壳：Electron + 固定 Node 侧车 + 回环 HTTP 契约

- 日期：2026-10-24
- 状态：提议（详细论证、体积/安全/路线见 [../DESKTOP_ARCHITECTURE_2026-10.md](../DESKTOP_ARCHITECTURE_2026-10.md)）
- 范围：Windows 优先的桌面客户端；不改 Harness 业务逻辑与 Web 工作台

## 背景

本仓已有完整的 Node/TS Harness（CLI、HTTP/SSE 服务、Web 工作台、审批/沙箱/插件、N-API 内核）。
桌面化要解决的问题不是“再写一个 UI”，而是把现有能力装进一个可安装、可升级、可退出、
具备托盘/通知/深链/文件对话框的 Windows 应用，同时不制造第二套业务实现。

三条现状约束决定了方案边界：

1. `ServerAuthGuard` 的 Origin 白名单**只允许回环 http(s)**；`file://` / 自定义协议加载 UI
   会让 `/rpc`、`/events` 全部 401。UI 必须继续由 Harness 回环托管。
2. Harness 多处用 `process.execPath` 当 Node 解释器（守护进程、插件 Worker、Windows `.cmd` 垫片）。
   在 Electron 主进程或 `utilityProcess` 里它是 `electron.exe`，语义会变。
3. 原生内核 `.node` 是 Windows-only；实测在 Node 24.22.1 与 Electron 44.7.0 的 Node 24.21
   下均可加载并 `ping`，但 `--experimental-permission` 在 Node 24 上已不可用。

## 决策

**桌面壳采用 Electron（45.x）；Harness 作为独立 `node.exe` 侧车运行，固定 Node 24 LTS；
桌面、Web、CLI 继续共用现有回环 HTTP/SSE 契约。**

具体约束：

1. **进程模型**：Electron 主进程（生命周期/OS 集成，无业务逻辑）+ Chromium 渲染层
   （sandbox、无 Node、仅 `window.omni` 桥）+ Node 侧车（Harness）+ Harness 的子进程。
2. **UI 交付**：窗口 `loadURL('http://127.0.0.1:<port>/?token=…')`；服务端用 HttpOnly Cookie
   固化会话；不引入 `file://` / `app://` 载入 UI。
3. **鉴权**：桌面生成 32 字节 Token，经 `OMNI_SERVE_TOKEN` 注入；Token 不写盘、不进日志
   （含 `OMNI_NO_UI_URL=1` 抑制默认的带 Token 横幅）；就绪文件只含端口/pid/版本等非敏感信息。
4. **就绪/退出**：新增 `OMNI_READY_FILE` 机器可读就绪文件；新增 `OMNI_CONTROL_STDIO`
   stdin 控制通道，解决 Windows 无法优雅发信号的问题。
5. **安全**：渲染层 sandbox + contextIsolation + IPC 白名单 + CSP + Electron Fuses +
   ASAR 完整性；生产关闭 `runAsNode` / `nodeOptions` / `nodeCliInspect`。
6. **打包**：`electron-builder` + NSIS 按用户安装 + GitHub Releases 自动更新；
   侧车与 Harness 产物放在 `resources/harness`，保持 `dist`/`web`/`native`/`defaults` 同级。

## 后果

- 正面：UI、CLI、服务端几乎零重写；`process.execPath`、插件 Worker、原生内核语义不变；
  Electron 壳可独立升级，Harness 运行时也可独立固定/迁移；桌面、浏览器、CLI 共用一套契约与测试。
- 负面：安装包多一个 `node.exe`（约 30 MB 压缩）；需要维护 Electron 与 Node 两条升级节奏；
  桌面壳引入 Electron 的安全面，必须按生产档加固。
- 前置（可独立合入，不应等桌面立项）：
  - `--experimental-permission` → `--permission`；
  - `OMNI_NO_UI_URL` 抑制带 Token 的启动横幅（避免 Token 经 stdout 进日志）；
  - `--port 0` 的 `ServeInstance` 路径不一致修复 / 桌面模式跳过实例记录；
  - ready 文件与 stdin 控制通道；
  - Node 24 CI 全量判据（失败则回退 Node 22.20 侧车，架构不变）。
- 边界：不承诺便携版；不做 32 位；Windows ARM64 原生内核后续；macOS/Linux 为后续里程碑。

## 替代方案

- **Electron + `utilityProcess`**：省一个 `node.exe`，但 `process.execPath` 与 `runAsNode` fuse
  冲突，需要改造守护进程/插件 Worker 等核心路径；列为体积硬约束时的备选（迁移路径见主文档 §10.1）。
- **Tauri 2 + Node 侧车**：壳更小，但 Node 仍要打包，且 UI 要跨 WebView2/WKWebView/WebKitGTK
  三套内核回归、维护两套 IPC；在本项目“Harness 本身占数百 MB”的背景下收益不足（主文档 §4.2）。
- **Wails v3 + Node 侧车**：仍是 beta，且引入 Go 壳，团队栈不匹配。
- **原生重写 / PWA**：前者成本不可接受，后者没有托盘/深链/自动更新/文件对话框，不构成桌面应用。

## 参考

- [DESKTOP_ARCHITECTURE_2026-10.md](../DESKTOP_ARCHITECTURE_2026-10.md)（完整调研、架构、路线、风险、验收）
- Electron Security / Fuses / utilityProcess / ASAR Integrity 官方文档
- electron-builder Auto Update / Code Signing / Fuses 文档
- Node.js Release Schedule / Permissions 文档
- 本机实测记录（主文档附录 F）
