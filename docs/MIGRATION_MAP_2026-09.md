# 迁移映射表与残差清单（T1.3 · 2026-09-13）

> 任务来源：`docs/REFACTOR_BOARD_2026-09-12.md` §T1.3。
> 口径：**每次重构产出「旧 → 新」映射；无法用映射解释的差异一律登记为残差；残差 = 0 才算无缝迁移。**
> 本表覆盖 2026-09-12 至 2026-09-13 的 P1 解耦系列、P6.3 上帝类拆分、T2.5 新技术合规收口。
> 更早的 Phase 3/4/5/6 批次映射见 `docs/CODE_STANDARD_REFACTOR_PLAN.md`（历史账）。

## 一、迁移映射表（旧 → 新）

### 1. stepRunner 上帝类拆分（`6f5d016`，P6.3）

| 旧（均自 `src/core/stepRunner.ts` 526 行 / 22 方法） | 新                                         | 说明                              |
| ---------------------------------------------------- | ------------------------------------------ | --------------------------------- |
| 步骤类型 / 步骤结果类型定义                          | `src/core/stepTypes.ts`                    | 纯类型；`stepRunner` 保留编排门面 |
| 上下文装配逻辑                                       | `src/core/stepContextBuilder.ts`           | 构造每步模型请求上下文            |
| 工具执行编排                                         | `src/core/stepToolExecutor.ts`             | 工具调用分发与结果回收            |
| （顺带）顺带新增的容量估算                           | `src/context/contextBreakdownEstimator.ts` | 容量面板分母侧估算                |

### 2. ports 纯化 + 错误类迁移（`6f5d016`，P1.3）

| 旧                                              | 新                                  | 门面                                                                                               |
| ----------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/ports/model.ts` 内嵌 `ModelCallError`      | `src/errors/modelCallError.ts`      | `ports/model.ts` 保留 `export { ModelCallError } from '../errors/modelCallError.js'`，调用点零改动 |
| `src/ports/model.ts` 内嵌 `BudgetExceededError` | `src/errors/budgetExceededError.ts` | 同上                                                                                               |

### 3. P1 双向依赖解耦系列（`b605b89` → `508d0ea`，P1.1/P1.2/T1.2）

| 旧（违规边）                                                    | 新（端口化产物）                                                        | 提交      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- | --------- |
| `core/checkpointManager` → `adapters/git/...`（快照读 git）     | 快照逻辑迁回 core；无新端口                                             | `b605b89` |
| `adapters/tool/*Tool` 等 4 处直接用 `core/eventFactory`         | `src/ports/eventFactory.ts`（EventFactoryPort）+ 组合根注入             | `4540062` |
| `adapters/diff/turnDiffHooks` 等 2 处直接用 `CheckpointManager` | `src/ports/checkpointManager.ts` + 注入                                 | `e35db0b` |
| toolHook / turnDiffTracker 调用点                               | `src/ports/toolHook.ts`、`src/ports/turnDiffTracker.ts`                 | `1787064` |
| `core/runtime.ts` 组装 live/embedding 具体实现                  | `src/ports/memoryExtractor.ts` + 组合根装配（`runtime` 降级为装配函数） | `bdc53d1` |
| `core/toolGate` → sandbox 具体类                                | denial 上移 `src/ports/sandboxDenial.ts`；ToolGate fail-closed 内联     | `c9509ba` |
| `adapters/tool/runGoalTool` → `core/agent`（值导入，最后 1 条） | 改端口/依赖倒置                                                         | `508d0ea` |

### 4. T2.5 新技术合规收口（`689d0a1`，§8 第二批）

| 旧                                                       | 新                                                                                                                               | 门面                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/context/rankVeto.ts`（503 行上帝类，类名 ≠ 文件名） | `rankVetoOverlap.ts`（重合度量）/ `rankVetoSpectrum.ts`（结构性诊断）/ `rankVetoEvaluator.ts`（阈值+判据编排，`@maturity` 随迁） | `rankVeto.ts` 保留门面再导出，`tests/unit/rankVeto.test.ts` 与 `evals/rank-veto-retro.mjs` 零改动 |
| `layeredCodeGraph.ts` 112 行主函数                       | `indexByName` / `indexByFile` / `documentFrequency` / `layerWeight` / `pushEdge` / `collectEdges` / `toAdjacency` 7 个助手       | 单文件内拆分，无路径变化                                                                          |
| `configError.validateConfig`（88 行）                    | 8 个字段族校验器 + `FIELD_VALIDATORS` 注册表                                                                                     | 同文件内拆分                                                                                      |
| `projectInstructions.loadProjectInstructions`（90 行）   | 三级候选收集 + `mergeCandidates` / `appendLlmsTxt`                                                                               | 同文件内拆分                                                                                      |

## 二、残差清单

| #   | 残差             | 定性 | 处置                                                                                                                          |
| --- | ---------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| —   | **无未解释残差** | ✅   | 本轮全部迁移均满足「导出路径不变 / 门面再导出 / 调用点零改动」三约束；`arch:gate` 白名单清空后 0 违规、全量单测绿，为机械佐证 |

## 三、纪律（后续批次沿用）

1. 移动/拆分一律「新文件承接实现 + 原路径留门面（桶）」，调用点零改动（D3）。
2. 每个迁移在本表追加一行；每个批次提交信息带任务 ID，可由 `git log -- <新文件>` 反查。
3. 任何「无法解释的行为/导出差异」必须当天登记为残差并给出处置（修复或明示豁免），不得静默。
