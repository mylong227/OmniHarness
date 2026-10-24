---
'@mylong227/omniharness': minor
---

Windows 原生写隔离：`CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED)` +
按工作区派生的写入 SID + DACL。工作区可写、越界写由内核拒绝；`--read-only` 零写授权。
可通过 `omni sandbox run --workspace <dir>` 或原生内核 `shell.run` 使用；读/网络仍不隔离。
