---
'@mylong227/omniharness': patch
---

把「二次宣告完成仍未核验通过」变成**一等完成状态**（G3-V2，补齐 G3）。

## 问题（假完成的落点）

完成闸门每回合**至多跑一次**（有界设计，避免把步数预算烧在反复验证上）。模型首次宣告完成时若验证未通过，
闸门回灌失败摘要并再给一步；当模型**第二次**宣告完成时，`TurnRunner` 只能放行——而"放行"被上游读成了
"验证通过"：`AgentResult` 里**没有任何字段**表达"这一回合的核验并没有以通过收尾"。
于是"改坏代码 + 两次宣布完成"就能拿到一个看起来干净的 `ok`。

## 改动

1. 新增端口类型 `VerificationState`（`ports/runtime/completionGate/verificationState.ts`）：
   `'not-run' | 'failed' | 'unverified'`。**不含 `'passed'`**——当前 `CompletionGate.verify()` 返回
   `string | undefined`，`undefined` 同时表示"通过"与"无需核验"，无法区分；与其造一个永不出现的值，
   不如把口径写清（要区分需把闸门契约改为富结果，已记入报告后续项）。
2. `TurnRunner`：完成判定抽成 `handleCompletionClaim()`（同时守住 `run` 的函数体上限），
   二次宣告完成时记 `verificationState = 'unverified'` 并写一条 **system 留痕**
   （"请勿把本回合的'已完成'当作已验证事实"）——状态不能只活在返回值里，审计与 UI 都要看得见。
3. 透传：`TurnOutcome` → `AgentResult.verificationState` → `SubagentResult.verificationState`；
   `SubagentTool.render()` 在 `unverified` 时给父模型加一条显式告警。

## 判据（`tests/unit/verificationState.test.ts`，3 例，离线零 key）

给临时工作区写 `package.json` + `check.js`，驱动**真实的 `turn-end` 闸门**（不启用写时自验证，
否则工厂会改走读"写时结论"的 `status` 闸门）：

| #   | 场景                                                               | 断言                                                                                                    |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| ①   | `check.js` 退出 1（验证恒失败）+「改文件 → 宣布完成 → 再宣布完成」 | 前置 `gateKind === 'turn-end'`；状态**必须是 `unverified`**（绝不 `not-run`）；事件流必须有"未验证"留痕 |
| ②   | 工作区探测不到测试命令（不设闸门）                                 | 状态 `not-run`，且**不得**留下"未验证"假警报                                                            |
| ③   | `check.js` 退出 0（验证通过）                                      | 不得报 `failed`/`unverified`，也不得有留痕（通过的回合不该被冤枉）                                      |

**变异测试验证有牙齿**：临时删掉 `verificationState = 'unverified'` 赋值（回到旧行为）⇒ ① **变红**
（`# pass 2 / # fail 1`）；回滚后恢复全绿。

## 兼容性

全部为**可选**字段（`TurnOutcome` / `AgentResult` / `SubagentResult` 的 `verificationState`），
既有消费方零改动；行为变更仅限"多写一条 system 留痕"与"多一个可读状态"。
