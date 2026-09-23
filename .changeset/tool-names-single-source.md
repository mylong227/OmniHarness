---
'omniharness': minor
---

**工具名收成单一来源**（用户指定，收尾审计 §3.4 的最后一项）：新增 `src/ports/tool/toolNames.ts`，`TOOL_NAMES` 成为工具标识在全仓的唯一声明处。

**动机**：工具名此前「两头都写」——注册侧 33 个工具类各写一遍 `name: 'read_file'`，消费侧的策略表再写一遍
（`MUTATING_TOOLS`、plan 模式只读白名单、调度器串行屏障、工具输出信任分级、diff 追踪钩子、变更目标解析、
默认审批规则、类别暴露表、评估夹具）。改一个名字要改多处，而**漏改策略表不会报错**：只会让
「写类必须串行 / plan 模式必须拦」这类安全契约对该工具静默失效（§20.8 就实测过
`rollback | read_file | remember` 同批并发）。

**改动**：

- 新增 `src/ports/tool/toolNames.ts`：`TOOL_NAMES`（45 个工具名常量）+ `ToolName` 类型 +
  `MUTATING_TOOL_NAMES`（写类单一口径）。放在**端口层**是因为消费方横跨 core / adapters / security / cli / eval，
  而 `adapters/**`、`security/**` 都不得 import `core/`——只有端口层是共同下游；文件本身是纯常量 + 纯类型。
- 注册侧：33 个工具类改为 `name: TOOL_NAMES.xxx`（含 `--defer-tools` 涉及的 shell/lsp 全族）。
- 消费侧：上述策略表全部改为引用 `TOOL_NAMES.*`；`core/toolGate.ts` 的 `MUTATING_TOOLS` 保留导出名与
  `ReadonlySet<string>` 形态（`indexBeta` 有导出），内容直接取自 `MUTATING_TOOL_NAMES` ⇒ 既有调用点零改动。
- 域内既有常量（`LSP_*_TOOL_NAME`、`RUN_GOAL_TOOL_NAME`、`RUN_WORKFLOW_TOOL_NAME`、`POLICY_EVAL_TOOL_NAME`、
  `AGENT_IDENTITY_TOOL_NAME`）改为别名指向同一张表：导出名不变，值只声明一次。
- 顺带修掉 `autonomy/workflowRunner.ts` 里残留的 `'run_goal'` 字面量。

**兼容性**：全部工具名字面量**逐字未变**（有测试逐条钉住历史值）；对外可见的导出名、集合形态、
审批/白名单语义均不变。`TOOL_NAMES` 未进公开桶（内部单一来源）。

**机械防线**：新增 `tests/unit/toolNames.test.ts` 4 例，其中两条是**反硬编码守卫**——
① 策划分级模块不得再出现工具名字面量（`keywords:` 任务文本模式与类别 `id:`/`hint:` 除外，注释不计）；
② `src/adapters/tool/**` 的工具类不得写 `name: '<字面量>'`。以后新增工具若忘了登记，测试直接失败。

**验证**：`npm test` 2089 例 / 2084 过 / 1 失败（本机 Chrome 环境用例，与基线同一条）/ 4 skip；
`typecheck`（含 web）/ `lint` / `format:check` / `check --strict`（569 文件零违规）/ `arch:gate --strict` /
`audit:config-wiring`（569 文件）全通过。
