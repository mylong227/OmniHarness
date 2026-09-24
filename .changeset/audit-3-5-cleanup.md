---
'omniharness': patch
---

**审计 §3.5 六项清理**（用户指定「全部进行清理过」）：哈希链算法合一 + 修裸 NUL 缺陷、覆盖率门禁从**假绿**改成真门禁（并挖出同源第二层假绿）、eval 脚本全部接入 npm script、文档死链门禁、并**更正一条不成立的审计结论**。

- **审计哈希链**：新增 `src/util/hashChain.ts`（`HashChain.GENESIS` + `static hash(prev, canonical, sep)`）
  作为算法与创世哈希的**唯一定义**；`auditSink` 与 `jsonlRuntimeTelemetry` 改为调用它，各自保留
  自己的**规范化正文**与**分隔符**——分隔符参与哈希，改它等于改写已落盘历史，故**不做统一**（这才是先前
  「分叉」的真相，审计只说对了一半）。顺带修掉一个真缺陷：`auditSink.ts` 的分隔符原为源码内的**裸 NUL 字节**
  （不是转义序列），使该文件被读取工具 / diff 判为二进制；改为 `'\u0000'` 后**行为逐字节不变**（golden 实测一致）。
  新增 `tests/unit/hashChain.test.ts`：两条链各一条 golden 哈希（防止静默改链）、算法等价性与分隔符敏感性、
  以及 **`src/**` 与 `defaults/**` 内无裸 NUL 字节**的守卫。**已落盘的审计链与遥测链哈希不变。**
- **覆盖率门禁（修 bug，两层）**：`coverage` 脚本里的 `--test-coverage-include='dist/**'` **匹配不到任何文件**，
  覆盖率表只输出 `# all files | 100.00` 一行 ⇒ 旧门禁**恒真**（审计以为只是「粒度粗」，实测是假绿）。
  修正为 `dist/src/**/*.js` 后真实聚合 **90.54%（508 文件）**；`scripts/coverageGate.mjs` 重写为
  **按文件冻结基线**（`scripts/coverageBaseline.json`）：任一文件低于基线（容差 0.01）即红、
  新增文件低于 `MIN_NEW_FILE_COVERAGE`（默认 30%）即红、高于基线则提示用 `--dump-baseline` 收紧。
  支持 `--from-file <报告>`（离线复核，兼容 PowerShell 重定向产出的 UTF-16LE）与 `--list`。
  **同源第二层假绿（收尾时实测发现）**：npm 在 Windows 走 `cmd.exe`，脚本里的**单引号是字面量**，
  于是 include 变成带引号的字符串、又匹配不到文件，报告再度只剩聚合行——**门禁只在看「表里有几行」，
  不在看「本该有行」**。故：① 脚本引号改双引号（cmd/sh 均正确）；② 门禁新增**空表守卫**，
  没有任何逐文件行即阻断，并把「检查引号口径」写进报错（已用旧报告反证能被拦下）。
  另：按文件冻结值会**随宿主漂移**（`bashAppRootMapper.js` 的被覆盖分支取决于本机能否发现 POSIX bash；
  本机 `bash` 是 WSL 存根，源码未改动而单测重跑两次一致 72.85%，基线 78.81% 来自当时能探到 bash 的运行），
  故新增 `scripts/coverageEnvDependent.json`：**经实测诊断**的宿主相关文件按**下限**校验并在输出中标注，
  **不对任何文件静默放宽**。
- **eval 接入 npm script**：新增 `scripts/runEval.mjs`（唯一入口：`--list`、缺 `dist` 时给出构建提示、
  参数与退出码透传、脚本名不存在时退出 2 并列出可用项），新增 `eval:list` / `eval:run`，
  并把**顶层 `evals/*.mjs` 全部 38 个**接成 `eval:<名字>` 别名。`evals/context-efficiency/bench.mjs`
  **有意未接线**（依赖同目录 `run.sh` 的 bash + tsc 管线，硬接成别名在无 bash 的 Windows 上会「永远红」）。
- **文档死链门禁**：新增 `scripts/docLinkCheck.mjs` —— **markdown 链接目标**不存在即红（阻塞），
  反引号内的路径提及按**文档相对 OR 仓库根相对**双口径解析后与冻结基线比较（基线
  `scripts/docLinkBaseline.json`，当前 90 处唯一提及），并接入 `pre-commit` 与 `npm run check:doc-links`。
  实测：**markdown 链接目标 0 处死链**。
- **审计结论更正（不改代码）**：「公开面泄漏测试替身（`MockModel` / `MemoryStorage` / `PassthroughSandbox`）」
  **不成立**——三者都是**生产可达**的正式实现（默认模型适配器 / `--storage-adapter memory` 的实现 /
  沙箱档位 `passthrough` 的注册实现）。按原建议弃用或删除，等于宣布默认适配器与可选档位将移除。
  核验证据与「不要删」的结论已写入 `docs/API_STABILITY.md`。
- **仍未清（1 项，附迁移清单）**：JSON-RPC pending 六处**去重**。其**缺陷层**（`mcpClient` 无 reject 通道）
  已修并有回归；去重层未做，因为实测六个站点形态不一致（`httpBridgeTransport` 只有 `resolve` 回调、
  `serverEventBridge` 是 `{resolve, timer?}` + 计数式 `denyAllPending`、`a2aClient`/`cdpClient`/
  `lspJsonRpcConnection` 是 `{resolve, reject, timer}`、`sdkClient` 是 `{resolve, reject}` + socket close 钩子），
  统一需一张支持「可选 reject / 可选定时器 / 纯回调」且保留 `failAll → count` 的泛型表。
