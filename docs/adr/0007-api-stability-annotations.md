# 0007 API 稳定性标注分区（@public/@beta/@deprecated）

- 日期：2026-09-06
- 状态：已接受

## 背景

项目处于 0.x 预发布阶段，API 仍在快速演进。调用方无法从签名判断「这个导出符号稳定吗」。
没有显式标注，破坏性变更会悄然发生。

## 决策

导出符号按稳定性分区标注（JSDoc 标签）：

- 不标：核心稳定层（`ports` 基础接口、`Agent`、`Container`、`RuntimeFactory`、基础适配器）；
- `@beta`：实验性子系统（autonomy / subagent / spill / lsp / identity / policy / tui / plan-todo /
  worker / code / native / mcp / search / eval / schema / daemon / model 新增适配 / retrieval /
  live / audit / enterprise / skill / plugin 等）；
- `@deprecated`：预留给未来淘汰项（当前无候选）。

CI 不强制阻断未标注符号，但要求新增实验性导出显式标 `@beta`，避免调用方误判稳定性。

## 后果

- 正面：调用方可据标注决定耦合程度；破坏性变更在 `@beta` 区可接受。
- 负面：标注需人工维护，存在滞后风险。
- 替代方案：不加标注（调用方无据可依，否决）。
