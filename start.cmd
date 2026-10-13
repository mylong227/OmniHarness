@echo off
rem ===========================================================================
rem  OmniHarness - one-click start (Windows)
rem
rem  Usage: double-click this file, or from a terminal:
rem      start.cmd                      build + serve + open the workbench
rem      start.cmd --port 9000          pass any serve flag through (see --help)
rem      start.cmd --no-build           skip the build step (fast restart)
rem
rem  This file is kept ASCII-only on purpose: a .cmd holding non-ASCII text is
rem  mangled by whichever code page the console happens to use. The Chinese
rem  startup banner is printed by node itself, not by this script.
rem  Spec / troubleshooting: docs/STARTUP.md
rem ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul 2>nul
title OmniHarness - one-click start

where node >nul 2>nul
if errorlevel 1 goto noNode

rem --- Node version gate (mirrors package.json engines.node, fail-closed) -----
node -e "const need=/^[^0-9]*(\d+)\.(\d+)/.exec(String(require('./package.json').engines.node));const min=need?[+need[1],+need[2]]:[22,14];const cur=process.versions.node.split('.').map(Number);process.exit(cur[0]>min[0]||(cur[0]===min[0]&&cur[1]>=min[1])?0:1)"
if errorlevel 1 goto badNode

rem --- One-click start: build server + build frontend + serve + open browser --
node scripts\startAll.mjs --open %*
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" goto serveFailed
echo [OK] OmniHarness serve stopped normally.
goto done

:serveFailed
echo [X] OmniHarness serve exited with code %CODE%.
echo     - build or gate failure : see the [X] lines above
echo     - port already in use   : start.cmd --port 9000
echo     - plain restart         : start.cmd --no-build
set "EXITCODE=%CODE%"
goto done

:noNode
echo [X] Node.js was not found on PATH.
echo     Install Node.js 22.14.0 or newer, then run this file again.
set "EXITCODE=1"
goto done

:badNode
echo [X] Node.js version is too old for this repository.
node -v
echo     Required: 22.14.0 or newer (package.json engines / .nvmrc).
set "EXITCODE=1"
goto done

:done
if not defined EXITCODE set "EXITCODE=0"
echo.
pause
endlocal & exit /b %EXITCODE%
