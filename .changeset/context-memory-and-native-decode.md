---
'omniharness': patch
---

把上一条审计里"未根治/残留/假红"的四类问题全部闭环。

1. full 模式（`light:false`）不再可能静默吃内存：`IndexOptions.light` 语义由"默认 full"翻为
   `light !== false`（不传即安全档 light，生产 `CorpusIndexCache` 行为不变），并给 full 加硬预算
   `MAX_TOTAL_BYTES_FULL = 5 MiB`（依据实测 0.37 GB/MiB ⇒ 峰值 ≤ ~1.9 GB）：触顶即**拒跑**
   （fail-closed，绝不静默只索引一半），确需更大语料必须显式传 `maxTotalBytes` 承认代价。
   两个确需 full 的评测脚本（`rank-veto-retro.mjs`、`context-efficiency/bench.mjs`）改为显式声明。
2. 两个按 root 键的进程级缓存加界：`codeReferenceGraph` 图信号缓存 `MAX_CACHED_ROOTS=8` +
   插入序淘汰；`projectInstructions` 指令缓存 `MAX_INSTRUCTIONS_CACHE_KEYS=16` + 先清过期再淘汰最旧。
3. 修掉一个真缺陷：原生内核 `decode_output` 只按 `CP_OEMCP` 解码，而受限令牌子进程实测输出
   UTF-8 ⇒ `echo 别名桥-ok` 回传 `鍒悕妗?ok`（`?` 不可逆）。现与 JS 侧 `OutputDecoder` 对齐为
   "先严格 UTF-8、再 OEM 回退"，并加 Rust 单测。
4. 清掉假红与门禁污染：3 例 shell 单测原本在 Windows 上用 POSIX 命令（`ls`/`cat|grep|wc`）而
   平台 shell 是 cmd.exe，改为各平台自洽命令（意图不变），`shellTool` 14/14；`.omniharness/**`
   进 eslint ignore、`.omniharness/`+`.omni-worktrees/`+`target/` 进 `.prettierignore`（运行时产物
   不再能让门禁 EPERM）；`nativeAliasBridge` 增"预编译产物 vs 源码 mtime"判定，产物过期时显式
   skip 并提示 `npm run native:build`，不伪装通过也不制造假红。

终态：全量单测 1763 项 / 1758 通过 / 0 失败 / 5 skip；`npm run smoke` 退出码 0；`npm run lint`
0 告警；`check --strict` 零违规；`arch:gate` 无新增违规。诚实边界：本机无 Rust 工具链，第 3 项
的内核修复无法在本机重编验证（由 CI 的 cargo job 覆盖）。
