# NSIS 安装包

`OmniHarness.nsi` 是**独立于 electron-builder NSIS target** 的安装脚本：electron-builder 在
压缩阶段必须 spawn `7za`，部分受限构建环境会 `EPERM`；这份脚本让 `makensis` 直接压缩
`release/win-unpacked`，安装/卸载/快捷方式/注册表项等价，且可离线复现。

```powershell
# desktop/ 下
npm run installer
# 或手动（UTF-8 脚本必须显式 INPUTCHARSET）
makensis -INPUTCHARSET UTF8 installer/OmniHarness.nsi
```

产物：`desktop/release/OmniHarness Setup 0.2.0.exe`（用户级安装到
`%LOCALAPPDATA%\Programs\OmniHarness`，卸载不删用户数据）。

升级时旧安装会重命名为 `OmniHarness.previous` 作为一次回滚点；回滚（应用关闭后）：

```powershell
Rename-Item "$env:LOCALAPPDATA\Programs\OmniHarness" "OmniHarness.failed"
Rename-Item "$env:LOCALAPPDATA\Programs\OmniHarness.previous" "OmniHarness"
```

边界：

- 不含 electron-updater 的 blockmap/差分信息；自动更新仍走 electron-builder 的发布链路。
- 未签名；正式发布需配置证书后对 exe 签名。
- 由 `release/win-unpacked` 打包，先跑 `npm run pack` / `npm run verify:package`。
