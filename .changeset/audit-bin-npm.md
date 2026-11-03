---
'@mylong227/omniharness': minor
---

**新增独立瘦命令 `audit`**（P1 一条命令）

- `bin.audit` → `dist/bin/audit.mjs`：esbuild 单文件 bundle（**71 KB**，≤ 300 KB 判据
  fail-closed），只含零运行时依赖的 audit 应用 + `AuditCommand`，不拖全量 CLI——
  `npx -y @mylong227/omniharness audit <会话文件> --out report.html` 即可出证。
- `audit --help` 顶部打印 Node 版本门槛（engines.node ≥ 22.14）与当前版本；
  `--version` 打印 `omniharness audit <API_VERSION>`。
- 旗标与退出码与主 CLI 的 `audit` 子命令完全一致（同一实现）；`prepublishOnly` 现在
  连带构建 audit bin（`npm run build:audit-bin`），发布物自带 `dist/bin`。
- 结构判据 `tests/unit/auditBinDeps.test.ts`：瘦入口的 import 面封闭（禁装配层模块）+
  内联 Node 门槛常量与 `engines.node` 机械对账。
