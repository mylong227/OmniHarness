---
'@mylong227/omniharness': patch
---

修复：**缺 `decision` 的参数级权限规则此前会被接受，然后在运行期被静默忽略**。

## 现象与后果链

`omniharness.json` 里写 `{ "permission": { "rules": [{ "toolName": "shell" }] } }`：

1. 写入校验通过 —— `PermissionConfigValidator.checkDecision` 对 `value === undefined` 直接放行；
2. 运行期 `RuleApproval.matchingDecisions` 只是 `map(rule => rule.decision)` ⇒ 该规则产出
   `decisions = [undefined]`，而聚合分支只有 `deny / ask / allow` 三个 ⇒ **全部不命中**；
3. 结果：规则**静默不生效**。用户以为"我给 shell 加了限制"，实际什么都没发生。

而类型契约 `ApprovalRule.decision` **一直是必填**（`tests/unit/approvalRuleContract.test.ts` 用类型级断言钉着），
故这是"声明强于实现"：类型说必填，运行期却放行。

## 修法（fail-closed）

`PermissionConfigValidator.checkRule` 现在要求 `decision` 必填，错误消息点名字段、给出合法取值，
并**说明后果**：

```
permission.rules[0] 缺 decision（必填：allow | deny | ask）；没有它这条规则不会生效（会被静默忽略）
```

该判定同时覆盖**直接调用校验器**与**写入路径**（`ConfigError.normalizeConfig` ⇒ `config.update` RPC
与手改文件的加载），两处不会各说一套。

## 影响与迁移

- **可能有人的配置里存在这种规则**（此前被接受）。升级后加载这类配置会 **fail-closed 报错**并指明是哪一条
  —— 这是刻意的：静默不生效的规则是安全边界上的"看起来有、实际没有"，比报错危险得多，应显式暴露。
- 迁移：给该规则补一个 `decision`（想放行写 `allow`，想拦写 `deny`，想每次问写 `ask`）。

## 判据

`tests/unit/permissionWritePath.test.ts`（4 例）：缺 decision 被写入路径拦下且消息点明"不会生效"、
完整规则/空规则集/只改默认裁决放行（正对照）、未知字段与非法枚举与类型错仍拦、
**类型契约与运行期校验一致**（编译期断言 + 运行期拦截并列）。
