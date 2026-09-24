---
'omniharness': patch
---

**余项清理**（用户指定「把余下的问题全部处理干净」）：文档化全部 CLI 旗标、修掉 `mcpClient` 缺拒绝通道、shell 超时口径合一、Python 源码迁出 `src/`、README 死引用改正。

- **CLI 帮助**：上轮冻结的 15 个「在 `FLAG_TABLE` 里但帮助未记载」的旗标全部补进 `defaults/cliHelp.json`
  （`--prompt` / `--model` / `--memory-encrypt` / `--memory-key-file` / `--model-router` / `--model-router-file` /
  `--turn-token-budget` / `--stream-text` / `--no-model-retry` / `--no-model-circuit-breaker` /
  `--model-circuit-breaker-threshold` / `--model-circuit-breaker-open-ms` / `--cost-budget-usd` /
  `--cost-budget-on-exceed` / `--cost-budget-soft-ratio`）。测试里的「未文档化冻结基线」随之**清空**
  ⇒ 此后**任何**新增旗标未写进帮助即测试失败。`--cost-budget-on-exceed` 的取值也纳入「枚举必须派生」检查。
- **`McpClient` 拒绝通道（修 bug）**：`PendingRequest` 增加 `reject` 与超时定时器句柄，新增 `close(reason)`
  立即拒绝全部在途请求并拒绝新请求；`mcpConnector` 的连接句柄关闭改为**先 `client.close()`、再关传输**
  （原先 `Transport` 契约无关闭通知 ⇒ 在途请求只能等各自超时（默认 10s）才被拒，调用方表现为「卡住」）。
  回归测试：`close()` 立即拒绝（超时故意设 60s，证明不是等超时）+ 幂等 + 关闭后新请求快速失败。
- **shell 工具族超时**：新增 `adapters/tool/shell/shellTimeouts.ts`，把两族**重复的 1s 下限**收成一处；
  默认值与上限**刻意保持分开**并注明语义差异（前台 shell 的 600s 是**钳制上界**；交互式另有**默认超时**
  与 1 小时上限）。新增两条断言钉住「下限共用 / 上限确实不同」。
- **Python 源码迁出 `src/`**：`src/omniharness/*.py`（3 文件 3919 行，此前不在任何 TS 门禁内）移至
  `python/omniharness/`；`scripts/run_omniharness.py` 的 `SOURCE_ROOT` 与文档串同步（路径深度不变）。
- **文档死引用**：`docs/TASK_BOARD_2026-09-13.md` 从未存在（真实看板为 `docs/TASK_BOARD.md`），而 README
  写明「以它为准」；非归档文档 8 处引用（README、docs/README、两张历史板、llms.txt）全部改正。
- **如实说明**：`--auth-required` 由裸 `serveArgs.includes(...)` 改为 `CliArgReader.has(...)` 属**惯例统一**，
  **不是** bug 修复（`Array.includes` 本就是精确匹配）。

**仍未清（附理由，见 `docs/DEFICIENCY_AUDIT_2026-09-22.md` §3.5 逐项状态）**：审计哈希链 canonical 分叉
（改哈希须逐字节保真 + golden 测试）、JSON-RPC pending 六处重复（7 个传输类语义各异，需专项重构）、
公开面泄漏测试替身（破坏性 API 变更，须走弃用流程）、覆盖率门禁聚合（门禁政策决策）、
35 个 eval 脚本接线（需决策且可能变「永远红」）、余下文档死路径（建议先做死链检查器再按批修）。
