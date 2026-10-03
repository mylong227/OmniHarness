---
'@mylong227/omniharness': patch
---

工具暴露探针接入**真实 schema**：量到 schema token 预算（G21-b）。

## 背景（G21 的登记遗留）

G21 入库的 `tools/probes/toolExposureBudget.mjs` 只量**可见工具数**——当时的理由是"规划器只看名字，
看不到 schema，所以要 token 数得另接真实 schema"。本项把那一半补上。

## 改动

**关键发现**：`ConfigFactory.build({ workspaceRoot })` 是**同步、离线**的生产装配入口（不建模型连接、
不读密钥）⇒ 探针可以直接拿到**默认配置下真实注册**的工具定义（name + description + parameters，
实测 **33** 个），无需人工构造 schema，也无需新增夹具文件。

1. 探针新增 **schema token 预算**段：用 `TokenEstimator.estimate` 对每个工具的
   `name + description + JSON(parameters)` 估算 token；`off` = 全部下发；`plan` = 规划器选中子集的合计；
2. 报告与打印给出：off 总量、逐任务可见子集 token、**节省量与节省比例**、区间；
3. 判据 `tests/unit/probesInRepo.test.ts` 新增第 ⑦ 例：schema 必须取自**默认配置的真实注册表**
   （`registeredTools ≥ 25` 且口径字符串写明"默认配置"）、`offSchemaTokens > 0`、逐任务
   `savedTokens === off − 可见子集`（**自洽性**）、`savedRatio ∈ [0,1]`，并要求**至少一条任务节省为 0**
   ——即"未命中类别 ⇒ fail-safe 全放行"这条保守行为**不能被优化掉**。

## 实测（2026-10-03 本机）

| 模式                            | 工具数  | schema token                                          |
| ------------------------------- | ------- | ----------------------------------------------------- |
| `off`（全部下发）               | 33/33   | **5,250**                                             |
| `plan` 命中类别（6/8 条任务）   | 8–13/33 | **953–1,677**（省 **3,573–4,297** ⇒ **68.1%–81.8%**） |
| `plan` 未命中类别（2/8 条任务） | 33/33   | 5,250（省 **0%**，fail-safe）                         |

另观察到一处**值得记下的事实**：`TOOL_NAMES` 名字表 **46** 项，而默认配置只注册 **33** 个
（LSP/MCP/媒体等工具按条件注册）⇒ "名字表 ⊃ 默认注册集"，已在探针文件头与 README 写明。

## 变异测试

把 schema 来源换成人工构造的假定义 ⇒ ⑦ 红（`registeredTools` 不足）；回滚后 7/7 绿。

## 验证

`tsc --noEmit` 零错误；`npm test` 全绿；`node scripts/runGates.mjs --tier=all` 两层跑通；
`api:check` / `rust:test` / `web:test` 全绿。看板第二十三轮横幅与报告 §4 G21 行同步。

## 口径边界（如实登记）

schema token 由 `TokenEstimator` **估算**（启发式，非真 tokenizer）⇒ 适合同机同版本对比，不当作绝对账；
只含工具 schema，**不含工具结果**（运行时大头另由上下文预算管）。
