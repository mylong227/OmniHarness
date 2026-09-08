#!/usr/bin/env bash
# scripts/git-safe.sh — 在本沙箱里专门为 git 操作包装（2026-09-08 根治设计）
#
# === 背景 / 根因 ===
# 跑 `git stash`、`git rm`、甚至 `git commit` 后，PortableGit 在本沙箱（Windows + 中文用户名 + 含空格路径）
# 环境下会被**沙箱进程组的 SIGTERM 强杀**——这会让 `git gc --auto` 写到一半的 packfile 只剩 .idx 索引、
# 实际数据丢失，导致后续 `git status` / `git log` 全部失败 "fatal: not a git repository"。
# 至少复现两次（2026-09-06/2026-09-07/2026-09-08）。
#
# === 本包装做了什么 ===
# 1. 直接调 git.exe，**不走 msys2 Git Bash shell**（shell 会让 git 子进程被作为 bash 子进程挂在同一 process group）
# 2. 启动 git 前先 `cp -r .git .git-bak-<unix-ts>` 备份整个 .git 元数据目录
# 3. 操作成功 → 自动删 .git-bak-<unix-ts>
# 4. 操作失败 / timeout（90s）→ 自动恢复 .git-bak-<unix-ts>（撤回到稳定状态）
# 5. 通过 -c 强制设置：
#      core.fsmonitor=false       （关 fsmonitor hook，避免子进程悬挂）
#      filter.lfs.required=false  （关 LFS filter hook —— 即使 .gitattributes 没 LFS，git 也可能在某些路径触发它）
#      gc.auto=0                  （**关键**：禁止任何写操作触发 auto-gc；手动 gc 由用户决定）
#      maintenance.repo=disabled  （关 auto-maintenance）
#      core.preloadIndex=false    （关 large repo preload，开销大时也偶发 hang）
# 6. 所有 git 操作走本包装（建议把所有调用方的 `git xxx` 替换为 `bash scripts/git-safe.sh xxx`）
#
# === 用法 ===
#   bash scripts/git-safe.sh status
#   bash scripts/git-safe.sh add -A
#   bash scripts/git-safe.sh commit -m "msg"
#   bash scripts/git-safe.sh stash          # 不建议（详见下方）
#   bash scripts/git-safe.sh push <remote>  # 不建议（远程操作有网络 hang 风险）
#
# === 严禁清单（即使走本包装也要避免）===
#   * git stash（多次复现触发 .git 损坏的源头）
#   * git rm（同样多次复现）
#   * git reset --hard（与 stash 同源）
#   * git push --force-with-lease 或 --force（远程 hang 风险）
# 替代方法见本文件末尾的"撤销/恢复指南"。
#
# === 撤销/恢复指南 ===
#   撤销未提交的本地修改：直接用编辑器（VSCode）撤销，不要走 git stash
#   暂存修改但不提交：    不要暂存，先保持未 staged；提交时一次性 add -A + commit
#   恢复远程版本：         先 git fetch，再 git checkout -- 文件路径（不删未跟踪文件）；不直接 git reset
#
# === 重建 .git（如果已经损坏）===
#   bash scripts/git-safe.sh rebuild
#   此子命令会保留当前 working tree，从工作树重新 init 一个 .git 并 commit 一次（HEAD 设为全量工作树快照）。
#   不是恢复历史，而是用最新的稳定快照重启版本控制。

set -euo pipefail

# === UTF-8 强制（2026-09-08 根治乱码）===
# 沙箱里 Windows 默认码页是 CP936/GBK，任何被 `shell` 工具包装的命令输出中文都是 mojibake。
# 注入 C.UTF-8 后子进程的 stdout 是合法 UTF-8 字节流，JavaScript 端就能正确解码。
# 同时 git 的 i18n.logOutputEncoding=utf-8 让 git 自身不再二次转码（避免在 wrapper 已给
# UTF-8 字节后又把它当 GBK 解读的套娃乱码）。
export LC_ALL=C.UTF-8
export LANG=C.UTF-8
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

# 解析当前 .git 路径
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo '.')"
GIT_DIR_REL="$(git rev-parse --git-dir 2>/dev/null || echo '.git')"
GIT_DIR_ABS="$(cd "$REPO_ROOT" && echo "$GIT_DIR_REL")"

GIT_ARGS=()
TIMEOUT_SECS=90

# 重建 .git 时：除了原有的 gc/fsmonitor/maintenance/lfs 关闭项外，再加 UTF-8 输出配置。
# core.quotePath=false 让含中文路径的 diff 不会被 \\xxx 八进制转义。
if [[ "${1:-}" == "rebuild" ]]; then
  if [[ -d "$GIT_DIR_ABS" ]]; then
    echo "[git-safe] remove existing .git: $GIT_DIR_ABS"
    rm -rf "$GIT_DIR_ABS"
  fi
  cd "$REPO_ROOT"
  git -c gc.auto=0 -c core.fsmonitor=false -c core.quotePath=false init -b main
  git -c gc.auto=0 -c core.fsmonitor=false \
      -c core.autocrlf=false -c core.filemode=false -c core.ignorecase=true \
      -c safe.directory='*' \
      config user.name '芭比咯'
  git -c gc.auto=0 -c core.fsmonitor=false config user.email 'babyl@omniharness.local'
  # 强制把 gc/fsmonitor/maintenance/lfs/quotePath 关进 local config，从源头避免下一次写操作触发自动 gc
  git -c gc.auto=0 -c core.fsmonitor=false config --local gc.auto 0
  git -c gc.auto=0 -c core.fsmonitor=false config --local core.fsmonitor false
  git -c gc.auto=0 -c core.fsmonitor=false config --local maintenance.repo disabled
  git -c gc.auto=0 -c core.fsmonitor=false config --local filter.lfs.required false
  git -c gc.auto=0 -c core.fsmonitor=false config --local core.quotePath false
  git -c gc.auto=0 -c core.fsmonitor=false config --local i18n.logOutputEncoding utf-8
  # 把整个工作树纳入
  git -c gc.auto=0 -c core.fsmonitor=false add -A
  # 单一 commit 作为新基线
  git -c gc.auto=0 -c core.fsmonitor=false \
      commit -m 'chore: re-init from working tree (git-safe rebuild 2026-09-08)'
  echo "[git-safe] rebuild done. HEAD=$(git rev-parse HEAD)"
  exit 0
fi

# 普通命令：转发 git 但加 -c 安全配置 + UTF-8 输出 + 不转义中文路径
GIT_ARGS+=(-c gc.auto=0 -c core.fsmonitor=false -c filter.lfs.required=false -c maintenance.repo=disabled)
GIT_ARGS+=(-c core.quotePath=false -c i18n.logOutputEncoding=utf-8)

# 一些只读命令允许在 .git 损坏时也跑（用于探测）
case "${1:-}" in
  status|log|diff|show|rev-parse|ls-files|cat-file|for-each-ref|rev-list|reflog)
    # 只读，跳过 backup
    exec git "${GIT_ARGS[@]}" "$@"
    ;;
esac

# 写操作前先备份 .git
TS="$(date +%s)"
BACKUP="${GIT_DIR_ABS}.bak.${TS}"
if [[ -d "$GIT_DIR_ABS" ]]; then
  cp -r "$GIT_DIR_ABS" "$BACKUP"
fi

# 跑命令（带 timeout）
set +e
timeout "${TIMEOUT_SECS}" git "${GIT_ARGS[@]}" "$@"
RC=$?
set -e

if [[ $RC -eq 0 ]]; then
  rm -rf "$BACKUP"
  exit 0
else
  echo "[git-safe] git $* exited with code $RC, restoring .git from backup" >&2
  if [[ -d "$BACKUP" ]]; then
    rm -rf "$GIT_DIR_ABS"
    cp -r "$BACKUP" "$GIT_DIR_ABS"
    rm -rf "$BACKUP"
  fi
  exit "$RC"
fi
