---
'@mylong227/omniharness': patch
---

**audit：ACP 未知帧证据保留 + 页内复核与 CLI 同口径**

- ACP 解析器对认不出的 method / `session/update` 类别：此前只计数、**整帧丢弃**；现在与
  OmniHarness / Claude Code / Codex 三个解析器同口径——未知帧以 `other` 记录**保留原始载荷**
  （证据不丢），同时计入 `coverage.unrecognized`。
- HTML 报告内嵌的浏览器复核器补上 `summary` / `coverage` 自洽对账（2026-11-03 CLI verify
  已有）：改摘要记录数或覆盖率数字的 JSON 报告，页面按钮同样判「不可信」——三个复核入口
  （CLI / 浏览器 / 第三方实现说明）口径一致。
- 新增 `tests/unit/codexLineWriter.test.ts` 4 例：Codex 两条支路的去重/文件表/token 口径
  逐分支钉死（该文件此前只有夹具级间接覆盖）。
