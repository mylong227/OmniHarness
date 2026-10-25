---
'@mylong227/omniharness': minor
---

Windows 原生写隔离：`CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED)` +
按工作区派生的写入 SID + DACL。工作区可写、越界写由内核拒绝；`--read-only` 零写授权。
新增 `--sandbox windows-native` profile（策略面同 restricted，执行面走原生启动器），
默认 `shell` 工具经 `wrapCommand` 自动使用；`omni sandbox run --workspace <dir>` 可直接调用。
读/网络仍不隔离。
