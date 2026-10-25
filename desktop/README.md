# OmniHarness Desktop（Electron + React/TS）

按 **Codex 官方桌面 App 的同构方式**实现：Electron 主进程 + 沙箱渲染层（现有 React 工作台）+
独立 Node Harness 侧车。主界面是 WebView（与 Codex App 一样），不是原生控件。

> 当前是 **MVP**：跑通“启动 → 加载现有工作台 → 原生菜单/工作区切换 → 优雅退出 → 可打包”。
> Codex 式项目/线程 UI 尚未做，见文末“下一步”。

## 1. 结构

```text
desktop/
  src/main/           # Electron 主进程（生命周期/工作区/菜单/日志/安全/侧车）
  src/main/lib/       # 纯逻辑：args / ready 契约 / 路径
  src/preload/        # contextBridge：只暴露 window.omni 最小桥
  src/main/harnessSupervisor.ts  # spawn node.exe serve --port 0 / ready / 优雅停
  static/loading.html # 启动画面
  scripts/build.mjs   # esbuild → dist/main.cjs + dist/preload.cjs
  scripts/stageHarness.mjs # 打包用 Harness + node.exe + 生产依赖
  scripts/test.mjs    # 纯逻辑测试（node:test）
  electron-builder.yml
```

运行时：

```text
Electron main（受信）
  ├─ BrowserWindow（sandbox/contextIsolation/无 Node）
  │    └─ preload（window.omni 最小桥）
  ├─ HarnessSupervisor
  │    └─ node.exe dist/src/cli/exec.js serve --port 0 --workspace <ws>
  │         └─ HTTP/SSE 127.0.0.1:<port>（Bearer + HttpOnly Cookie）
  └─ 菜单/日志/工作区/安全守卫
```

## 2. 前置

- Windows 10/11 x64；Node.js **>= 22.14**（Harness 侧车用系统 `node`；打包时复制 `node.exe`）。
- 先在**仓库根**构建 Harness 与前端：

```powershell
cd D:\deepseek\omniharness
npm run build
npm run web:build
```

## 3. 开发运行

```powershell
cd desktop
npm install
npm start
# 指定工作区（不弹目录选择框）：
npm start -- --workspace D:\deepseek\omniharness
```

`npm start` = `npm run build && electron .`：构建主进程/preload 后启动 Electron。
首次启动若没有工作区，会弹原生目录选择框。

> **本机限制**：本会话的 DSH 沙箱内 Electron GUI 启动会返回 `STATUS_BREAKPOINT`（Chromium 初始化
> 被环境拦截），所以 GUI 级验证需在真实 Windows 桌面执行。主进程的 Harness 生命周期已用
> `node` 集成测试验证（见 §6）。

### Electron 二进制下载失败时

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
node node_modules/electron/install.js
```

## 4. 打包

```powershell
cd desktop
npm run stage   # 复制 dist/web/defaults/native + node.exe + 生产依赖到 .desktop-stage/harness
npm run pack    # 只出 --dir（验证布局）
npm run dist    # NSIS 安装包（未配置签名）
```

`stage` 会：

- 复制 `dist`、`web/dist`、`defaults`、`native`、`package.json`、`package-lock.json`；
- 复制当前 `node.exe`（或 `OMNI_NODE_BIN`）；
- `npm ci --omit=dev --ignore-scripts` 后删除前端库（React/KaTeX/highlight 已打进 `web/dist`）
  与 ONNX/transformers 重型可选包；
- 断言 `web/dist/index.html`、`native/omni_napi.node`、`dist/src/cli/exec.js` 存在。

`SKIP_DEPS=1` 可只复制产物（不装依赖），用于快速验证目录布局。

### 布局

```text
OmniHarness/
  OmniHarness.exe
  resources/
    app.asar                 # Electron main/preload/loading.html
    harness/
      node.exe
      dist/ web/ defaults/ native/
      node_modules/
      package.json
```

保持 `dist`/`web`/`native`/`defaults` 同级，是 `NativeKernel`、`runHttpServe`、`ConfigFactory`
三处路径解析的共同前提。

## 5. 安全基线

- 渲染层：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webviewTag: false`。
- preload 只暴露 `window.omni`（getInfo/工作区/日志/外链/重启/通知/更新/深链订阅/退出），
  IPC 校验 sender + 主 frame + harness origin；通知/更新参数再做结构/长度校验。
- CSP 由主进程注入；导航/窗口打开/权限白名单；外链只允许 http(s)/mailto。
- 侧车环境清洗：删除 `NODE_OPTIONS`/`NODE_PATH`/`NODE_EXTRA_CA_CERTS`/`ELECTRON_RUN_AS_NODE`。
- Token：32 字节、仅内存；`OMNI_SERVE_TOKEN` 注入；`OMNI_NO_UI_URL=1` 抑制侧车横幅；日志脱敏。
- Harness：`--port 0`、`OMNI_READY_FILE`、`OMNI_CONTROL_STDIO`、`OMNI_NO_SERVE_INSTANCE=1`。

## 6. 桌面能力（已接线）

| 能力       | 实现                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 托盘       | `TrayService`：显示/打开工作区/日志/检查更新/关闭到托盘/开机启动/退出                                    |
| 关闭到托盘 | 默认开；托盘不存在时自动不拦截关闭，避免“隐藏后找不回来”                                                 |
| 原生通知   | 审批/提问/回合完成时由 UI 调 `window.omni.notify`；窗口聚焦时主进程自动不打扰；点击通知聚焦会话          |
| 深链       | 注册 `omniharness://`；支持 `open?workspace=...&session=...`；第二实例/`open-url` 转发给 UI              |
| 单实例     | 第二实例聚焦已有窗口，并处理 `--workspace`/深链                                                          |
| 开机启动   | `app.setLoginItemSettings`（Windows/macOS）；Linux 暂不伪装支持                                          |
| 自动更新   | `electron-updater` + GitHub Releases；菜单/托盘/设置面板“检查更新”，下载后确认安装；安装前优雅停 Harness |
| 设置面板   | Web 设置新增「桌面」栏：版本/平台/工作区、关闭到托盘、开机启动、更新状态与诊断动作                       |
| 窗口状态   | 保存 bounds，恢复时校验可见屏幕；多显示器/DPI 变化兜底                                                   |
| 日志       | 主进程/Harness 分文件、脱敏、环形缓冲；菜单/托盘可打开目录                                               |

## 7. 测试

```powershell
cd desktop
npm run typecheck
npm test        # args / ready 契约 / 环境清洗 / 桌面偏好
```

已执行的集成验证（本机 Node 22.20）：

```text
HarnessSupervisor.start() → /healthz 200 → stop()
结果：READY <随机端口> ok <pid>；STOPPED idle；ready 文件删除；无子进程残留
```

GUI 级验证（窗口、CSP、菜单、IPC）需要在真实桌面跑；本会话的 Electron 沙箱不允许。

## 8. 下一步（按 Codex 官方 App 对齐）

1. **React UI 演进**：把 Codex 式的“项目 → 线程”、活动流、diff、`@` 文件、`/` 技能、
   Skills/Automations 做进 `web/src`，而不是只加载旧工作台。
2. **安全**：精确 Origin/Host 校验、CSP 收紧到实际端口、Renderer 权限白名单复核。
3. **打包**：代码签名、N-1 升级实跑、安装/卸载保留 `~/.omniharness`、Windows 10/11 + 高 DPI 验收。
4. **平台**：macOS 签名/公证；Linux 的托盘/通知能力按桌面环境降级验证。

## 9. 与文档的关系

- 当前架构决策：[ADR-0017](../docs/adr/0017-electron-official-app.md)（已接受）。
- 历史方案：[ADR-0016](../docs/adr/0016-native-desktop-ui.md)（Avalonia 原生，已废止）、
  [ADR-0015](../docs/adr/0015-desktop-shell.md)（Electron 早期版本，已废止）。
- 原生 UI 调研：[DESKTOP_ARCHITECTURE_2026-10.md](../docs/DESKTOP_ARCHITECTURE_2026-10.md)（v2，历史）。

## 10. 已知限制

- 当前直接复用现有 Web 工作台；**还不是 Codex 式的全新 React UI**。
- 托盘/通知/深链/开机启动/更新已接线，但 GUI 级验证需真实桌面；本会话 Electron 沙箱不允许。
- 自动更新/安装包未签名，未完成 N-1 实跑；`npm run dist` 需要 electron-builder 下载 NSIS/winCodeSign。
- macOS/Linux 未验证；`stageHarness`/`nodeBinary` 已按平台分支，但 electron-builder 配置目前只配 Windows。
