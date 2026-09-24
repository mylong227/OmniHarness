---
'omniharness': minor
---

**CLI 帮助数据化 + 适配器/存储声明收成单一来源**（用户指定：帮助这类内容也该按配置实现，不该硬写在代码里）。

**① CLI 帮助移出代码**（`defaults/cliHelp.json` + `src/cli/cliHelp.ts`）

- 原先整份帮助是 `argParser.printUsage()` 里一段 **73 行字符串数组**，于是 CLI 表面出现**第三份副本**：
  旗标名 / 枚举取值 / 默认值在 `cliFlagTable`（解析）、`cliEnums`（校验）、`CliDefaults`（默认值）各一份，
  帮助里再抄一遍。**实测已经漂移**：帮助写 `--storage-adapter memory|jsonl`，而白名单早已是
  `memory|jsonl|sqlite` ⇒ 用户照帮助选不到 `sqlite`。
- 现帮助的**文案**在 `defaults/cliHelp.json`（改文案不改代码），**枚举取值**在渲染时从 `cliEnums` 派生
  （数据里写 `{{storageAdapters}}` 等占位符）；占位符无法解析即**抛错**（fail-closed，绝不把 `{{x}}`
  渲染给用户）。排版口径（描述列 36、过长留 3 空格）由 `CliHelp.lineOf` 统一保证，
  不再有旧数组那种手工对齐的参差。
- **行为变更（唯一一处语义变化，属修复）**：`--storage-adapter` 的帮助取值由 `memory|jsonl` 变为
  `memory|jsonl|sqlite`（与解析期白名单一致）。其余 72 行文案逐字不变；15 行的描述起始列因统一对齐
  有若干空格位移（旧数组手工对齐不一致）。

**② 适配器标识与存储后端的声明收成单一来源**

- `src/ports/model/modelAdapterId.ts`：`MODEL_ADAPTER_IDS` + `ModelAdapterId` 成为**唯一名字来源**，
  原先在 5 处各写一遍（`CliArgs.modelAdapter` / `FileConfig.modelAdapter` / `cliEnums.MODEL_ADAPTERS` /
  `configError.ENUM_VALUES.modelAdapter` / daemon `RoutineModelAdapter`）+ 厂商预设置子集。
  注册表的表体用 `Record<ModelAdapterId, …>` 表达 ⇒ **漏一行即编译报错**。
- 顺带修掉一个真缺陷：`configError.ENUM_VALUES.modelAdapter` **漏 `llamacpp`** ⇒ 配置文件里写
  `"modelAdapter": "llamacpp"` 被判非法（声明支持、校验拒绝，与 `approval` 的 `'plan'` 同型）。

**机械防线**（新增 `tests/unit/cliHelp.test.ts` 6 例 + `tests/unit/adapterFactories.test.ts` 6 例）：

- 帮助：枚举取值必须来自 `cliEnums`（含 `--storage-adapter … sqlite`）；排版描述列恒为 36；占位符
  fail-closed；**帮助不得宣传不存在的旗标**（幽灵文档；例外为 CLI 自解析旗标 `--config`/`--profile`/
  `--auth-required`，且例外清单腐化也会失败）；**新增旗标必须文档化**（存量 15 个未文档化旗标冻结，
  只增即红）；渲染确定性。
- 适配器：三方声明一致（每个注册 id 必须能过 `normalizeConfig`）；表里每个兜底 id 在数据文件真实存在；
  **模型适配器的 `new` 只允许出现在注册表**；**存储后端名分支只允许出现在存储工厂**。

**验证**：`npm test` 全绿（详见看板 §20.17）；`typecheck`（含 web）/ `lint`（0 告警）/ `format:check` /
`check --strict` / `arch:gate --strict` / `audit:config-wiring` / `api:check` 全通过。
