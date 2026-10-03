---
'@mylong227/omniharness': patch
---

修复**取消原因在 AbortSignal 桥上丢失**（G4-L3，对应调研报告 §3.1 发现 3 与看板 §8.4）。

## 诊断订正（先纠正原判断，再修）

原登记写"级联时把 reason 写死成 `'parent'`，与文档承诺矛盾"。读码复核后**订正**：
`'parent'` 是 `CancelReason` 联合类型里的**一等值**，且 `tests/unit/loopCancellation.test.ts:45` 明确断言
`child2.cancelReason === 'parent'` ⇒ 级联标 `'parent'` 是**有意设计**（表示"被父令牌级联取消"），
且 `child()` 在 `src/**` 里**没有任何生产调用点**（仅测试使用）。它不是缺陷。

**真正的缺陷是两处叠加**（读码 + 实测确认）：

1. `src/core/loop/cancellationToken.ts` 的 `toAbortSignal()` 两处 `controller.abort()` 都**不带 reason**
   ⇒ `AbortSignal.reason` 退化成通用 `AbortError`(DOMException)。而 `agent.ts:413` 正是把该 signal
   交给模型层 ⇒ 下游**拿不到任何结构化原因**。
2. `src/subagent/cancellableModel.ts` 的 `reasonOf()` 白名单只有 `'user' | 'timeout' | 'shutdown' | 'parent'`
   ⇒ **`'loop-guard'`（失控熔断）与 `{ custom }` 被静默折叠成 `'parent'`**（谎报"父级联"）；
   且兜底值返回 `'parent'`，与该函数**自己 JSDoc 写的"缺省时为 'user'"矛盾**。

净后果：生产路径上 `CancelledError.reason` 几乎恒为 `'parent'`——用户中断、超时、关机、失控熔断
全都被报成"父令牌级联"，而这正是 `CancelReason` 联合类型存在的理由。

## 改动

- `toAbortSignal()`：把结构化原因一起过桥（未取消时兜底 `'user'`），两条路径（未取消即注册 / 已取消）都带原因；
- `reasonOf()`：认全五类字符串原因 + `{ custom }` 对象，兜底按文档取 `'user'`。

## 判据（本机离线、无 key）

- 新增 `tests/unit/cancellableModelReason.test.ts` 4 例：五类原因（含原先被漏掉的 `loop-guard`）/
  `{custom}` 原样还原 / 无结构化原因兜底 `user` / 畸形输入不抛错；
- `tests/unit/loopCancellation.test.ts` 增 1 例：`toAbortSignal()` 在两条路径上都必须带真实原因；
- `tests/unit/cancelPropagation.test.ts`（原先对原因**零断言**）新增 `childAbortReasons()` 观测，并在
  **工作流 / 目标循环 / 子代理三条真实路径**上断言 `deepStrictEqual(..., ['user'])`——真实链路而非桩；
- 端到端探针（临时，未入库）：`token.cancel(x)` → `toAbortSignal()` → `reasonOf()` 对
  `user / timeout / shutdown / loop-guard / {custom}` **全部保真**（修前全部为 `'parent'`）。

## 兼容性

`CancelReason` 契约不变；未识别原因由 `'parent'` 改为 `'user'`（与 JSDoc 一致，且比谎报父级联更诚实）。
`src/**` 内**无任何分支依赖 `CancelledError.reason`**（已 grep 确认），故行为变更面仅限错误对象与文案。
