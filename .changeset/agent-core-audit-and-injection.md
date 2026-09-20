---
'omniharness': patch
---

Agent 核心探针审计（7 处真实缺陷）+ 开场注入幂等化（长会话不再重复堆同一段技能/记忆指令）。

**修掉的 7 处缺陷（每处都有「修前红 → 修后绿」探针）**

- **工具调用链抛错留下孤儿 `tool_call`**：`ToolScheduler.safeExecute` 的失败结果被 `StepToolExecutor` 丢弃 ⇒ 投影出含**未响应 `tool_call_id`** 的 `assistant(tool_calls)`，上游兼容端点硬 400（可达路径：插件 `pre` 钩子抛错、外溢落盘失败、工具端口抛错）。现补录失败 `tool_result` 并上报 supervisor。
- **native 执行成功后回退 JS 重跑**：`catch` 把「记录结果/`post` 钩子失败」误判为原生失败 ⇒ 写类工具可能双写。现 `try` 只包住 `native.runTool`。
- **plan 只读白名单漏 3 个只读工具**（`lsp_workspace_symbols` / `recall` / `spill_read`）：文档与档位描述都说要放行，实现漏登记（写类工具仍逐一断言拒绝）。
- **`SemanticIndexCache.clear(root)` 是空操作**：键含两个 `|` 却按第一个切分 ⇒ 陈旧向量索引脏读。
- **`ToolResultSpiller.replace` 丢 `error`**：失败结果外溢后模型只看到「未知错误」，且拿不到 `spill://` 读回句柄。
- **`DeterministicCompressor` 破自身「三大定律」**：截断不按 `maxLines` 收敛 ⇒ 逐轮变长（16→17→18）、非幂等、`ratio>1`、标记自称「省略 0 行」。
- **`run_workflow` 步骤失败仍返回 `ok:true`**（与其 `@returns` 相反）⇒ 所有按 `ok` 分流的消费者被骗。

**开场注入幂等化（本笔同时修）**

- `resume`/`fork` 会先 hydrate 历史，而技能/记忆 primer 原先**每回合**无条件注入 ⇒ 同一段技能指令在长会话里出现 N 次（第 3 轮 3 份），白烧 token 并稀释注意力。
- 现改为：技能**按逐条渲染文本判重**（保留「每回合重新匹配、任务转向后新技能仍注入」的能力），记忆 primer 按内容特征前缀判重；primer 仍默认关闭。行为可观测：长会话 prompt token 与重复 system 条数下降。

**验证**：新增探针/回归 5 个文件共 **22 例全绿**；既有 `planApproval` 4/4、`deterministicCompressor` 13/13、`contextEfficiency` 16/16 未退；`typecheck`/`build`/`check --strict`（554 文件零违规）/`arch:gate`/`audit:config-wiring`/`audit:maturity`/`eslint --max-warnings=0` 全绿。

**行为变更提示**：① 工具 `pre` 钩子抛错从「注释声称上抛、实际被吞且丢结果」改为「记为失败 `tool_result` 并继续」（保住配对不变量，否则上游 400）；② 压缩后长会话 prompt token 显著下降（每次压缩从 O(steps) 份摘要降到 O(1)）；③ plan 模式放行 3 个只读工具；④ `run_workflow` 失败时返回 `ok:false`。

**已知未修（如实登记，待产品决策）**：压缩器「无模型则退化为截断」未实现且 head 空分支 fail-open（超预算可能原样透传却报 `compacted:true`）；`shrinkLossless` 的 JSON 往返并非无损（`1e400`→`null`、重复键、>2^53 精度）；原生 token 估算用 Unicode 标量而 JS 用 UTF-16 码元（emoji/星平面不一致）；`run_workflow` 的 `maxConcurrency:0` 可能永久挂起（疑，未独立复现）；子代理/工作流的取消不传播（功能缺口）。
