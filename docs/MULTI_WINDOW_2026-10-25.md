# 桌面多窗口（2026-10-25）

> 看板并发写入期间单独记录；待看板锁释放后合并到 `PROJECT_BOARD.md` §103。

## 实现

- 新增单类 `desktop/src/main/app/SecondaryWindows.ts`：
  - 额外窗口集合；
  - `owns(webContents)` 供 IPC 信任面判断；
  - `reloadAll(handle)`：Harness 重启/切换工作区后重载；
  - `closeAll()`：退出清理。
- `desktop/src/main/menu.ts`：视图菜单「新建窗口」（`CmdOrCtrl+Shift+N`）。
- `desktop/src/main/tray.ts`：托盘「新建窗口」。
- `desktop/src/main/ipc.ts`：`IpcDeps.isTrustedContents?`，`assertTrusted` 接受主窗口或
  额外窗口，仍校验主 frame 与当前 harness origin。
- `main.ts`：菜单/托盘接 `openNewWindow`；重启与切换工作区调用 `secondary.reloadAll`；
  `will-quit` 调 `closeAll`。

## 判据

- desktop `tsc`、Prettier；
- desktop 19/19 测试；
- 多窗口复用同一 Harness handle；关闭额外窗口不触发托盘拦截。

## 边界

- 额外窗口关闭即销毁，不拦截为托盘；
- 窗口间 UI 状态独立，不是 per-thread 路由；
- 主窗口仍是 `context.window`，托盘/深链聚焦主窗口。
