---
'@mylong227/omniharness': patch
---

子代理写入语义闭环：**改动不再静默丢弃**（G2，对应调研报告 §1.4 发现 1/2 与看板 §8.1）。

## 问题（本机复核）

- 子代理的写入落在 `WorktreeOps.createWorktree()` 建出的隔离工作树里，而 `cleanup()` 是
  `git worktree remove --force` **+ `git branch -D`** ⇒ 改动**静默消失**；
  `SubagentResult` 又没有 diff/patch 字段 ⇒ 父代理收到 `ok:true` + 一段"已完成"的总结，
  主仓库却零改动。这是"假成功 + 静默数据丢失"。
- `run_workflow` 的 `execute()` docstring 自称"构造**隔离**子智能体"，实际传的是**父级 ports**
  （无 worktree）⇒ 同层并发步骤直接写同一工作区、无冲突检测，**语义与文档相反**。

## 改动（两种隔离档，两条都不再静默）

1. **worktree 档（git 可用）＝改动可回收**：新增 `WorktreeOps.collectChanges()`（先 `git add -A`
   以纳入**未跟踪的新建文件**，再 `git diff --cached --binary HEAD`；超 4 MiB 截断并标注）与
   `WorktreeOps.persistChanges()`（落盘到 `.omniharness/subagent-patches/<sessionId>.patch`，可 `git apply`）。
   `SubagentOrchestrator` 在 `cleanup()` **之前**采集并挂到结果上（`changedFiles` / `patchPath` /
   `patchBytes` / `patchTruncated`），同时 `log.warn('subagent.writes.isolated')`。
2. **copy 档（git 不可用/失败）＝禁写（fail-closed）**：没有 git 可比 ⇒ 改动不可能取回，
   故新增 `SubagentToolScope.writeForbidden()` 从工具视图剔除全部 `MUTATING_TOOLS`，
   结果标 `writesForbidden`。宁可让子代理明确说"我改不了代码"，也不要改完再无声丢弃。
3. **采集失败也必须显式**：`writesUnrecoverable`（fail-closed 标记，绝不静默）。
4. **父模型一定看得到**：`SubagentTool.render()` 增渲染块——有改动时报明"隔离工作树里改了 N 个文件、
   主工作区尚未改动、patch 路径 + `git apply` 命令"；禁写档报明"写类工具已禁用，结论里的'已修改'不可信"。
5. **`run_workflow` 语义显式化**：docstring 改为"构造**共享工作区**的子智能体"（说明为何与子代理隔离相反），
   并新增 `WorkflowLayerPolicy`——同层＞1 步且任一步**可能写**（未声明 `tools`＝拿全集，或声明含写类）时
   **该层退化为串行** + `log.warn('workflow.layer.serialized')`，消除并发覆盖竞争。

## 判据（本机离线、无 key）

- `tests/unit/worktree.test.ts` 新增 2 例：**修改 + 新建（未跟踪）+ 删除**三种形态都被采集，
  patch 落盘后能 `git apply` 回主仓并真的拿到改动/删除；无改动时采集为空（不凭空产出 patch）。
- 新增 `tests/unit/subagentToolScope.test.ts` 4 例：未声明 tools 时收窄后不含任何写类且只读仍在、
  显式声明时按序剔除、**不改原请求**、写类清单非空且覆盖落盘/执行面。
- 新增 `tests/unit/workflowLayerPolicy.test.ts` 5 例：单步不退化、只读层保持并发、未声明 tools 必须串行、
  显式含写类必须串行、三态判定。

## 兼容性

`SubagentResult` 新增字段全部可选（`changedFiles`/`patchPath`/`patchBytes`/`patchTruncated`/
`writesUnrecoverable`/`writesForbidden`），既有消费方零改动；copy 档工具面收窄是**行为变更**，
但改的是"原本必然丢失"的那条路径（现在会明确拒绝而非假装成功）。

## 遗留（如实登记）

工作流的同层冲突检测是**保守退化（串行）**，不是"按声明精确判冲突"：因为 `WorkflowStep` 没有
"我写哪些文件"的声明字段。要做到精确并发需先加声明契约，属独立改动，已记入报告 §4 的后续项。
