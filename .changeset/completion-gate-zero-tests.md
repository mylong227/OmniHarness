---
'@mylong227/omniharness': patch
---

修复完成闸门的 **fail-open 漏洞**：退出码为 0 不再等于"验证通过"（G3-V1，对应调研报告 §3.9 与看板 §8.6）。

## 问题（本机实测）

`node --test "<一条都没匹配到的 glob>"` 会打印 `# tests 0 / # pass 0 / # fail 0` 并**以 0 退出**；
而本仓 `npm test` 正是 `npm run build && node --test "dist/tests/unit/*.test.js"`。原闸门判据只有
`outcome.exitCode !== 0`（`turnEndCompletionGate.ts`）⇒ **"一条测试都没跑"会被判成"验证通过"**，
正好落进本仓最忌讳的假完成形态（外部调研亦量化：假成功占单控制域失败轨迹的 45–48%）。
主流工具刻意区分二者：pytest 把"没收集到测试"单列为 **exit 5**，Jest 需显式 `--passWithNoTests`。

## 改动

1. 新增 `src/adapters/tool/verify/testCountParser.ts`（`TestCountParser`）：识别 node-test / jest /
   vitest / pytest / go-test 五类运行器的汇总行，输出 `{ runner, total, passed, failed, zeroEvidence }`。
   命令特征优先、输出特征兜底（`npm test` 这类包装命令也能识别）。
2. `TurnEndCompletionGate` 在退出码为 0 时增补**第二道判据**：① 显式零测试证据 ⇒ 拦截；
   ② 计数里有失败用例却以 0 退出 ⇒ 以计数为准拦截。
3. 判据取向**刻意不做过度 fail-closed**：拿不到汇总行（日志被 `maxOutputBytes` 截断）或命令不是
   测试运行器（如 `tsc --noEmit`）⇒ **不拦**——闸门是增强，不是环境检测器。

## 实现中踩到并修掉的一个真问题（仪器不得把被测对象的名字当读数）

首版验证时发现：**9 个用例全过的真实输出也被判成"零测试"**。根因是 node 的 TAP 会把每个**用例名
原样回显**（`# Subtest: <名>` / `ok 1 - <名>`），而本仓 `testCountParser.test.ts` 自己的用例名里就含
`no tests ran` / `collected 0 items` / `No test files found` 字样 ⇒ 子串匹配命中了用例名。
现先剔除逐用例行的用例名回显（node TAP / jest `✓✕` / pytest `PASSED|FAILED`）再做判读，
并补两条回归用例钉住该形态。

## 判据（本机离线、无 key）

- `tests/unit/testCountParser.test.ts` 12 例：五类运行器汇总、零测试证据、包装命令兜底、非测试命令不拦、
  异常输入不抛错，以及**用例名回显不得当证据**的回归；
- `tests/unit/turnEndCompletionGate.test.ts` 新增 4 例：`# tests 0` 且 exit 0 **必须拦截**、
  真跑测试必须放行、计数有失败必须拦、截断/静态检查必须放行；
- 真实命令口径复核（临时探针，未入库）：空 glob ⇒ `zeroEvidence: true`；真跑 12 例 ⇒
  `total=12 / zeroEvidence=false`。

## 兼容性

新增一个导出类与一道判据，不改现有端口契约；对"非测试类验证命令"（`tsc --noEmit` 等）行为**逐位不变**。
