# 全库代码规范重构计划

> 目标：让全部 `.ts`（`src/`、`tests/`、`web/src/`）符合 `docs/CODE_STANDARD.md` 的八条规范。
> 盘点口径：AST 全量扫描（`node scripts/auditStandards.mjs`），非正则印象。
> 纪律：每批次完成即跑门禁（typecheck / build / web:build / lint / test），可回滚；
> 并行会话热区文件（`core/stepRunner.ts`、`core/turnRunner.ts`、`adapters/live/**`、
> `ports/toolInputSink.ts`）**不触碰**。

## 盘点基线（改造前）

| 指标 | 基线 | 现状 |
|---|---|---|
| `.ts` 文件数（excl dist/tests 内联） | 333 | 333 |
| `var` 用法 | 0 | 0 ✅ |
| `any` 用法 | 0（源码）/ 1（web shim） | 0 ✅ |
| 隐式 public 的类成员 | **1332** | **0** ✅ |
| 顶层 function（src） | 261（已导出 163） | 261 |
| 缺 JSDoc 的公开成员 | 288 / 813 | 待办 |
| 文件名 ≠ 主类名 | 69 | 待办 |
| 上帝类（>500 行 或 >25 方法） | 8 | 待办 |
| `static` 用量 | 206 / 36 文件 | 待办 |
| 单文件 ≥3 个导出类 | 3 | 待办 |

## 批次状态

### Phase 0 — 门禁与工具（✅ 已完成）
- `eslint.config.mjs`：`no-explicit-any` 升为 `error`；新增
  `@typescript-eslint/explicit-member-accessibility: error`；热区文件加覆盖块豁免（TODO 待撤）。
- 新增 `scripts/auditStandards.mjs`（AST 盘点）与 `scripts/codemod/memberAccessibility.mjs`（机械修复）。

### Phase 1 — 显式访问权限（✅ 已完成）
- 机械 codemod 补全 **1332 处** 隐式 public 成员为显式 `public`（含构造器参数属性），覆盖 **269 个文件**。
- 语义零变更（隐式 public ≡ 显式 public）；`web/src/types/react-shim.d.ts` 手工补 12 处 + 去 `any`。
- 门禁：typecheck / build / web:build 0 error；lint **0 error**；全量单测 1012/1028 通过
  （8 失败均为既有的 WebSocket/端口 15s 超时环境问题，与本改动无关）。

### Phase 2 — JSDoc 覆盖（待办）
- 目标：813 个公开成员中缺文档的 288 个（src）补齐，含 `@param`/`@returns`。
- 风险：需逐方法理解语义，**不可机械批量**；按模块分批，每批单独提交。
- 建议顺序：`util/` → `context/` → `adapters/` 小文件 → `ports/` 接口。

### Phase 3 — 文件名 = 类名（待办，69 文件）
- 二选一策略（逐文件判定）：
  - **改文件名**：`errors.ts` → `omniError.ts`（类名 `OmniError`）——推荐，改动集中。
  - **改类名**：仅当类名语义弱于文件名时。
- 必须同步更新全部 import 路径（ESM `.js` 后缀）与 `api:check` 导出清单；`index.ts` 桶文件豁免。
- 批次内以 `tsc --noEmit` 立即校验。

### Phase 4 — 上帝类拆分（进行中，3/7；最高风险）

**已完成（各独立提交，行为零变更 + 门禁绿 + 单测通过）**
- ✅ `adapters/lsp/lspProcess.ts`（371 行 / 26 方法）→ 抽出 `LspJsonRpcConnection`（stdio JSON-RPC 传输/分帧/超时），
  适配器只留 LSP 协议语义。提交 `24d0a7c`；lspProcess+lspTools 17/17。
- ✅ `spark/sparkController.ts`（430 行 / 23 字段）→ 抽出 `SparkEngineSet`（20 引擎归拢）与
  `SparkCycleTelemetry`（~95 行遥测映射），控制器字段 23→4。提交 `f903cde`；spark 系列 24/24。
- ✅ `context/repoMapContext.ts`（620 行 / 13 方法）→ 抽出四协作者 `RecallKnobs`（旋钮三级解析，集中 env）、
  `CorpusIndexCache`（TTL/LRU 语料缓存 + 驱逐回调）、`SemanticIndexCache`（语义索引构建/缓存 + 文档装配）、
  `HybridRanker`（RRF 多路融合排序，纯算法可复用）；引擎降为薄编排门面。提交 `b44401e`；repoMapContext 16/16，
  顺带修正 LRU 驱逐对语义缓存失效的空操作 bug。

**剩余（待办）**
- 候选与拆分方向：
  - `server/appServerBase.ts`（1260 行 / 55 方法）→ 按职责拆为 `appServerThreads` / `appServerTurns` / `appServerApprovals` 等。
  - `config/omniharnessConfig.ts`（764）→ 实为「类型声明 + 单方法工厂」，非真上帝类，拆分价值低。
  - `server/appServer.ts`（659 / 31）→ 委托 `appServerBase` + 处理器分离（已有 `appServerHandlers`）。
  - `cli/cliDataCmds.ts`（570）→ 按子命令拆。
  - `core/stepRunner.ts`（526）→ **热区，暂缓**。
- ⚠️ `appServer*` 两兄弟的单测在本机因 WS/端口 15s 超时**不可靠**，拆分只能靠 typecheck + api:check 兜底，须最谨慎。
- 每个文件**独立提交**并跑全量单测，确保行为零变更。
- 拆分范式（已验证，可复用）：读全文件找**职责缝** → 抽出新类**文件名=类名**（顺带满足规范 #2）
  → 原文件留组合门面、导出名与路径不变（调用点零改动）→ 逐文件独立提交 + 跑该模块单测。

### Phase 5 — 削减 static（待办，36 文件 / 206 处）
- 范式：`export class Xxx` 静态方法族 → 实例类 + 组合根单例 + 薄门面（沿用批次 A 已验证模式）。
- 优先处理 ≥4 static 的文件：
  `mcp/mcpProtocol`(14)、`util/commandCanonicalizer`(14)、`core/eventFactory`(13)、
  `enterprise/sso`(13)、`cli/doctor`(10)、`config/configBuilders`(10)、`util/unifiedDiff`(10)、
  `cli/args`(9)、`context/prefixStability`(9)、`genesis/modality`(9)、`tui/render`(9)、
  `plugin/bundle`(8)、`skill/skillComposer`(8)、`util/eigenspectrum`(8)、`genesis/multimodalBridge`(7)、
  `server/jsonRpc`(7)、`config/configFile`(6)、`server/auditExport`(6)、`cli/toolLoader`(4)。

### Phase 6 — 一文件一类（待办，3 文件）
- `adapters/tool/lspTools`（4 类）→ 拆为每类一文件。
- `adapters/tool/planTool`（3 类）→ 同上。
- `plugin/registrySources`（4 类）→ 同上。

### Phase 7 — 封装收紧（待办，判断批）
- Phase 1 只是把「隐式 public」显式化；本批在其中识别**本应 private/protected** 的成员并收紧。
- 纯人工判断 + 单测护栏，按模块小步推进。

## 收口判定

全部批次完成后：
- `node scripts/auditStandards.mjs` 中：隐式 public = 0、`any` = 0、`var` = 0、
  文件名≠类名 = 0、上帝类 = 0、单文件多类 = 0。
- `npm run lint` / `typecheck` / `build` / `web:build` 全绿；`npm test` 无新增失败。
