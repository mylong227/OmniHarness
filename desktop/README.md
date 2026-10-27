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
  static/loading.html # 启动画面（当前主进程用内联 data URL，保留作源文件）
  static/icon.svg     # 项目 Ω 标志源文件
  static/icon.png     # 512×512 窗口/托盘图标
  static/icon.ico     # 多尺寸 Windows 安装包/任务栏图标
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

> **本机限制**：当前执行环境（无图形会话）中 Electron GUI 启动会返回 `STATUS_BREAKPOINT`
> （Chromium 初始化被环境拦截），所以 GUI 级验证需在真实 Windows 桌面执行。主进程的 Harness
> 生命周期已用 `node` 集成测试验证（见 §6）。

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

本机实测：`npm run stage`（完整生产依赖）+ `npx electron-builder --dir -c.win.signAndEditExecutable=false` 可产出
`release/win-unpacked`（含 `resources/harness/node_modules`、`app.asar`、`node.exe`）；Electron 下载建议走
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。安装包/签名仍未验证。

### 布局

```text
OmniHarness/
  OmniHarness.exe
  resources/
    app.asar                 # Electron main/preload/loading.html
    desktop.config.json      # 发布默认配置（可被 userData/OMNI_DESKTOP_CONFIG 覆盖）
    harness/
      node.exe
      dist/ web/ defaults/ native/
      node_modules/
      package.json
```

保持 `dist`/`web`/`native`/`defaults` 同级，是 `NativeKernel`、`runHttpServe`、`ConfigFactory`
三处路径解析的共同前提。

### 4.1 桌面配置（`desktop.config.json`）

所有可调技术参数（窗口尺寸、侧车超时、重试/停止宽限、更新策略、日志环形缓冲、IPC 长度上限、
CSP/权限、路径目录名）都集中在配置里，**不再散落在主进程代码**。

加载顺序（后者覆盖前者，逐字段深合并）：

1. 代码内置默认值（`src/main/config/defaults.ts` 的 `DEFAULT_DESKTOP_CONFIG`，缺文件也能启动）；
2. 发布包/开发树内置 `desktop.config.json`（打包后位于 `resources/desktop.config.json`）；
3. 用户覆盖 `%APPDATA%/OmniHarness/desktop.config.json`；
4. `OMNI_DESKTOP_CONFIG=<path>` 指定的最后一份覆盖文件。

非法值（类型错/越界/非回环主机/非法 CSP token）会**回落默认并写告警到主进程日志**，
不会静默采纳。发布包内置配置与代码默认值逐字段相等，`desktop/scripts/test.mjs` 会核对防漂移。

示例（只写要改的字段即可）：

```json
{
  "app": { "language": "system" },
  "harness": { "readyTimeoutMs": 45000, "stopGraceMs": 8000, "autoRestart": true },
  "window": { "width": 1440, "height": 900, "showShortcut": "CommandOrControl+Shift+O" },
  "update": {
    "autoCheckDelayMs": 30000,
    "channel": "latest",
    "allowDowngrade": false
  },
  "logging": { "ringLines": 500 }
}
```

`app.language` 取 `system`（跟随系统，`en*` → 英文，其余 → 中文）、`zh-CN` 或 `en-US`。
它只影响**原生壳**（菜单/托盘/对话框/启动页）；渲染层工作台的语言仍由 Web UI 自己的设置决定。

`update.channel` 取 `latest` / `beta` / `alpha`；`allowDowngrade=true` 允许安装低于当前版本的
构建（仅用于回滚演练，默认关闭）。

`window.showShortcut` 是全局「显示窗口」快捷键（Electron accelerator，如
`CommandOrControl+Shift+O`）；空串关闭。注册失败只写日志，不阻断启动。

`harness.autoRestart`（默认 true）在崩溃后自动重启；`restartMax`/`restartWindowMs`
限制窗口内次数（默认 3 次 / 10 分钟），超限才弹崩溃对话框，避免崩溃循环。

> `harness.host` 只接受 `127.0.0.1`：当前 `serve` 固定绑回环，没有 `--host` 旗标。
> CSP 只允许修改指令值，token 内含 `;`/换行会被剔除（防注入额外指令）。

### 4.2 启动阶段报告

主进程会在日志里写固定格式的阶段标记：

```text
startup.phase phase=config.loaded elapsedMs=...
startup.phase phase=workspace.resolved elapsedMs=...
startup.phase phase=window.created elapsedMs=...
startup.phase phase=harness.start elapsedMs=...
startup.phase phase=harness.ready elapsedMs=...
startup.phase phase=ui.loading elapsedMs=...
startup.phase phase=ui.ready elapsedMs=...
```

不需要启动 Electron，直接读最近一份日志：

```powershell
npm --prefix desktop run startup:report
# 带预算：超过 5s 退出码 1（可直接进 CI/发布检查）
npm --prefix desktop run startup:report -- --budget-ms=5000
```

日志目录默认 `%APPDATA%/OmniHarness/logs`；可用 `--dir=<path>` 指定。

## 5. 安全基线

- 渲染层：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webviewTag: false`。
- preload 只暴露 `window.omni`（getInfo/工作区/日志/外链/重启/通知/更新/深链订阅/退出），
  IPC 校验 sender + 主 frame + harness origin；通知/更新参数再做结构/长度校验。
- CSP 由主进程注入；导航/窗口打开/权限白名单；外链只允许 http(s)/mailto。
- 侧车环境清洗：删除 `NODE_OPTIONS`/`NODE_PATH`/`NODE_EXTRA_CA_CERTS`/`ELECTRON_RUN_AS_NODE`。
- Token：32 字节、仅内存；`OMNI_SERVE_TOKEN` 注入；`OMNI_NO_UI_URL=1` 抑制侧车横幅；日志脱敏。
- Harness：`--port 0`、`OMNI_READY_FILE`、`OMNI_CONTROL_STDIO`、`OMNI_NO_SERVE_INSTANCE=1`。

## 6. 桌面能力（已接线）

| 能力       | 实现                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 托盘       | `TrayService`：显示/打开工作区/日志/检查更新/关闭到托盘/开机启动/退出                                                                       |
| 关闭到托盘 | 默认开；托盘不存在时自动不拦截关闭，避免“隐藏后找不回来”                                                                                    |
| 原生通知   | 审批/提问/回合完成时由 UI 调 `window.omni.notify`；窗口聚焦时主进程自动不打扰；点击通知聚焦会话                                             |
| 深链       | 注册 `omniharness://`；支持 `open?workspace=...&session=...`；第二实例/`open-url` 转发给 UI                                                 |
| 单实例     | 第二实例聚焦已有窗口，并处理 `--workspace`/深链                                                                                             |
| 开机启动   | `app.setLoginItemSettings`（Windows/macOS）；Linux 暂不伪装支持                                                                             |
| 自动更新   | `electron-updater` + GitHub Releases；菜单/托盘/设置面板“检查更新”，下载后确认安装；安装前优雅停 Harness                                    |
| 设置面板   | Web 设置新增「桌面」栏：版本/平台/工作区、关闭到托盘、开机启动、更新状态与诊断动作                                                          |
| 项目/线程  | 中栏「项目 / 线程」面包屑；左栏项目行显示线程数，支持项目内新建线程与在文件管理器中打开目录                                                 |
| 活动       | 活动面板聚合当前状态、待审批/提问、变更摘要与最近事件，可跳转 Trace/工具/变更                                                               |
| 技能       | 技能目录面板（搜索）+ 输入框 `/` 触发选择器；`skills.list` 只回名称/描述/标签                                                               |
| 自动化     | 自动化面板 + `automations.*` RPC；任务持久化到 `~/.omniharness/automations.json`，serve 每 30s 检查并新建会话                               |
| 窗口状态   | 保存 bounds，恢复时校验可见屏幕；多显示器/DPI 变化兜底                                                                                      |
| 渲染层自愈 | UI 加载失败/渲染进程崩溃（abnormal-exit/oom/memory-eviction）自动用当前句柄重载（窗口内限次，`recovery` 配置）；耗尽后弹「重试/退出」对话框 |
| 日志       | 主进程/Harness 分文件、脱敏、环形缓冲；菜单/托盘可打开目录                                                                                  |

## 7. 测试

```powershell
cd desktop
npm run typecheck
npm test        # args / ready 契约 / 环境清洗 / 桌面偏好
npm run verify:package  # 检查 release/win-unpacked 结构/裁剪/配置
npm run installer       # 由 win-unpacked 生成 NSIS 安装包（需 makensis）
```

已执行的集成验证（本机 Node 22.20）：

```text
HarnessSupervisor.start() → /healthz 200 → stop()
结果：READY <随机端口> ok <pid>；STOPPED idle；ready 文件删除；无子进程残留
```

GUI 级验证（窗口、CSP、菜单、IPC）需要在真实桌面跑；本会话的 Electron 沙箱不允许。

### 7.1 GUI 冒烟验收（真实桌面会话，2026-10-27 起）

受限执行环境（无图形会话）里 Electron 起不来（STATUS_BREAKPOINT），GUI 级断言此前只能靠
人工、从未跑过。现在主进程内置**冒烟入口**：`OMNI_SMOKE=1` 时 UI 加载完成后自动采集运行
事实（窗口可见性 / 侧车端点 / UI 加载来源 / React 根挂载 / preload 桥版本），判定结果落盘
`userData/smoke-result.json` 并以退出码回传：

```powershell
cd desktop
npm run smoke                       # 退出码 0=全过 / 1=断言失败 / 2=90s 超时
npm run smoke -- --workspace D:\deepseek\omniharness   # 免首次目录选择框
$env:OMNI_SMOKE_OUT='D:\tmp\smoke.json'; npm run smoke # 指定结果落盘位置
```

判定逻辑（致命 5 项 + 观测 3 项）在 `src/main/app/SmokeHarness.ts`，**零 electron 依赖**、
`npm test` 直接覆盖（含五类致命断言与「观测项不判死」）。托盘图标/系统通知/深链注册在受限
会话合法缺失，按观测项记录、不影响结论。

## 8. 下一步

1. **真实桌面验收**：跑 `npm run smoke`（§7.1，一键出结论与明细 JSON）；托盘/深链/通知的
   手工核对项在其观测明细里列出。
2. **安装包**：代码签名、N-1 升级实跑、安装/卸载保留 `~/.omniharness`、高 DPI 验收。
3. **安全复核**：精确 Origin/Host 校验、CSP 收紧到实际端口、Renderer 权限白名单。
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
- GUI 冒烟验收已脚本化（§7.1）但**执行**仍需真实桌面会话（受限 shell 里 Electron 起不来）；
  macOS/Linux 未验证；`stageHarness`/`nodeBinary` 已按平台分支，但 electron-builder 配置目前只配 Windows。
