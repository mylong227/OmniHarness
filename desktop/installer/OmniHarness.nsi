; OmniHarness 桌面安装包（NSIS 3，用户级安装）。
;
; 为什么单独一份 .nsi：electron-builder 的 NSIS target 在压缩阶段必须 spawn 7za，
; 受限构建环境会 EPERM；这份脚本让 makensis 直接压缩 win-unpacked，产物功能等价
; （安装/卸载/快捷方式/注册表项），失败面更小、可离线复现。
;
; 用法（在 desktop/ 下）：
;   makensis installer/OmniHarness.nsi
; 或在普通环境：npm run installer

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APP_NAME "OmniHarness"
!define APP_VERSION "0.2.0"
!define APP_PUBLISHER "mylong227"
!define APP_EXE "OmniHarness.exe"
!define APPDIR "..\release\win-unpacked"

Name "${APP_NAME}"
OutFile "..\release\OmniHarness Setup ${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
XPStyle on

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright © 2026 ${APP_PUBLISHER}"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "启动 ${APP_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  ; 升级前把旧版本重命名为 .previous，保留一次回滚点；不复制 500MB。
  IfFileExists "$INSTDIR\${APP_EXE}" 0 no_previous
    RMDir /r "$INSTDIR.previous"
    Rename "$INSTDIR" "$INSTDIR.previous"
  no_previous:
  SetOutPath "$INSTDIR"
  ; 整个解包目录：exe + resources(app.asar/harness/config) + locales。
  File /r "${APPDIR}\*.*"

  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
  DeleteRegKey HKCU "Software\${APP_NAME}"
  ; 先删 exe/dll，再递归删目录（用户数据在 %APPDATA%，不在此目录）。
  Delete "$INSTDIR\${APP_EXE}"
  RMDir /r "$INSTDIR"
  RMDir /r "$INSTDIR.previous"
SectionEnd
