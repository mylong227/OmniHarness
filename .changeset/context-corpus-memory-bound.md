---
'omniharness': patch
---

修 `npm run smoke` 的 4 GB 堆爆（确定性、非网络问题）。根因：`ContextEngine.walk` 自带一套只跳 `node_modules`/`dist`/点目录的遍历，与本仓 `WorkspaceFileWalker.DEFAULT_IGNORED_DIRS` 不一致，于是 `eval-data/`（2.3 GB、10.4 万个随仓克隆的 `.py`）与 `target/`（2.2 GB Rust 产物）被 repo-map 全量读进内存（本工作区实测可遍历语料 152,249 文件 / 4.6 GB）。修法：忽略策略收敛为一份（复用 walker 清单）+ 跳过符号链接 + 三道内存闸（文件数 2 万 / 单文件 512 KiB / 语料总量 32 MiB），并把「截断」与「超大文件被排除」经 `IndexedCorpus.truncated` / `skippedLargeFiles` 与 repo-map 尾部一行「覆盖度」如实回报，不静默。顺带修掉被堆爆掩盖的第二个真缺陷：repo-map 作为尾部 system 消息注入时，`MockModel` 按「末条必须是 user」判定首回合，导致工具回路在真实装配下走不到（`smoke` 步数 1 而非 ≥2）——改判「末条非 system 消息是 user」。验收：`npm run smoke` 退出码 0；新增 `contextEngineCoverage` 单测 5/5（含真机回归：索引本仓根目录 4.6 GB → 1.5 秒）。
