---
'omniharness': minor
---

护栏生效模式三态化（`off`/`shadow`/`enforce`）+ 修两处既有缺陷（陈旧工具 schema、护栏兜底 fail-open）+ 阈值校准 harness。

**D1 · 三态生效模式（借鉴 dsh-jev 的 `provider` × `mode` 两正交开关）**

- 新增 `src/security/enforcementModeResolver.ts`：`off` 不跑 / `shadow` **跑·记·但不改行为** / `enforce` 跑且生效；兼容历史二值（`true ⇒ enforce`、`false / undefined ⇒ off`，零行为变更）。（2026-09-22 由 `enforcementMode.ts` 更名——主类名须与文件名一致，该增量门禁对新增文件是阻断项。）
- 新增 CLI `--guard-prompt-injection-mode off|shadow|enforce`（白名单校验，入 `VALUE_FLAGS`）；`--guard-prompt-injection` 语义不变（等价 `enforce`）。
- 全链透传：`stepTypes` / `stepToolExecutor` / `configFactory` / `cliEnums` / `cliFlagTable` / `argParser` / `cliBuildConfig`。
- **动机**：既有安全开关多为二值 opt-in，「默认关」丢覆盖面、「默认开」担误报责任；`shadow` 是出口——**只记不改**，用于在生产流量上攒真实误报/漏报（离线快照仅 32 例）。
- 顺带补上 `--guard-prompt-injection` 此前**缺失的帮助文案**。

**D2 · 配置层拒绝配出含糊语义 + 兜底 fail-closed**

- 未知模式**字符串在装配层抛错**（`ConfigFactory.build`），而非静默回落成 `off`——否则「配置写错」会静默退化成「护栏失效」。与 `cliEnums.ts`「安全相关枚举必须显式校验」同一纪律。
- `guardInjection` 的 `catch` 原为 `return result`（**fail-open**，其注释亦如此写），与模块头「fail-closed」的宣称不一致。内层 `scanForInjection` 已 fail-closed，故该外层此前不可达，但使保证**有条件**。现按模式区分：`enforce` ⇒ fail-closed 隔离；`shadow`/`off` ⇒ 原样（守住「不改行为」契约）。策略抽成纯函数 `guardFailureResult` 以便单测。

**D4 · 修缺陷：陈旧工具 schema 进模型上下文**

- `ToolDiscovery` 是按名累积的裸 Map；`effectiveTools()` 原先**无条件**并入已发现工具 ⇒ 工具/插件在会话中途卸载（`RegistryToolPort.unregister`，插件热卸载路径）后，陈旧 schema **仍进上下文**，模型据此调用必然命中**已不存在的工具**。
- 修法：以**当前目录**为准——目录无则丢弃、仍在则取**目录中的最新定义**；且**能核对才绑定、不能核对不丢能力**（`list` 缺失时保持既有行为，避免打断 #M1 闭环）。

**L3 · 阈值校准 harness**

- 新增 `evals/injection-calibrate.mjs` + npm `metrics:injection:calibrate`：**不改 src**，利用 `scanForInjection` 无论 tier 都收全量 `hits` 的特性做离线复算。
- 含**有效性闸**：候选值取当前手设值时必须与生产原生判决逐例一致（实测 32/32），否则中止。
- 实测：手设 `(1,1,2,3)` acc 排名 5/256；`external` 1→2 白丢 15pp recall、FP 零收益；`file` 档 2/2 样本 ⇒ 阈值**不可辨识**；最高 accuracy **9 向量并列**。
- **口径**：n=32 不足以选型，本报告仅用于证明手设值敏感性与暴露缺样本档位，**不作为生产阈值结论**。

**L6 · 降档决策带可读理由**

- `buildRepoMapContext` 降档分支增 `context.repomap.degrade` 观测（`reason` / `effect` / `queryChars`），使「档位为何变」可事后判断。

**行为变更提示**：默认**无**行为变更（护栏未设 ⇒ `off`；`--guard-prompt-injection` 仍等价 `enforce`）。
新增 env/CLI 取值 `--guard-prompt-injection-mode shadow`；非法取值现在会**抛错**而非静默忽略。
D4 修复后，已从工具目录移除的「已发现工具」不再进入模型上下文（此为缺陷修复，会改变该异常场景下的行为）。
