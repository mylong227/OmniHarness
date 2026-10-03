---
'@mylong227/omniharness': patch
---

**拆掉架构环⑥**：20 成员的「装配-运行时大环」消失（G25，TS1）。

## 问题（报告 §3.x / TS1）

`architectureGate` 的依赖环规则把 6 组 SCC 冻结在白名单里，其中环⑥ 是 **20 成员**的
「组合根 / 配置装配 / 子代理 / 工具适配器 / core.agent / a2a 互引」大环。报告 TS1 的处方是
"把环内散落的 `SubagentPortsShape` / `OmniHarnessRuntime` / `ResolvedConfig` 抽到 `src/ports/**`"。

**复核后发现这三者其实早已在 `src/ports/**`**——真正的成因是另一种形态：**类型已在 ports 声明，
调用点却绕道实现文件导入**（例如 `a2aTaskExecutor` 从 `composition/runtime` 取 `OmniHarnessRuntime`，
而该接口的声明文件是 `ports/composition/omniHarnessRuntime.ts`）。于是"实现文件 → 实现文件"的
**假依赖**把 20 个模块焊成了一个环。

## 改动

1. 逐个测出环内 **51 条内部边**，定位 5 个"ports 已有、却绕道实现文件"的类型：
   `OmniHarnessRuntime`、`ResolvedConfig`、`SubagentPortsShape`、`OmniHarnessConfig`、`ExtraTool`。
2. 用一次性迁移脚本把 **34 处导入说明符**改为**直连 ports 模块**（只改导入路径，不动任何实现；
   脚本跑完即删、不入库）。手工修复了脚本对**多行 import** 的一处插入错误（1 个文件）。
3. 三处 type-only 导入补齐 `type` 关键字（`verbatimModuleSyntax` 要求）。

**结果**：环⑥ **消失**，剩下一个 4 成员的配置子环（`configBuilder | configFactory |
configToolRegistry | corePortsAssembler`）；环内内部边 **51 → 32**；`CYCLE_WL_MEMBERS` 从
**41 → 25 成员**（删掉已不成环的 16 个）。报告里那条"环⑥ 是 20 成员"的记载同步更新。

## 判据

`node scripts/architectureGate.mjs --strict` **通过**（依赖环：6 组、新增 0；目录告警不变），
且 `CYCLE_WL_MEMBERS` 中环⑥ 的 16 个成员已删除——这正是 TS1 判据的两条。
另：`npm test` **2,520 项 / 0 失败**（34 处导入重定向全部是纯路径改动，行为零变化）；
`tsc --noEmit` 零错误；`arch:gate` / `audit:config-wiring`(922) / `audit:maturity`(40) /
`check --strict`(922 文件零违规) / `check:doc-links`（新增 0）/ `api:check` / `audit:standard:delta` /
`rust:test` / `web:test`(300) 全绿；`lint` 0 告警。

## 遗留（如实登记为 G25-b）

剩下的 4 成员配置子环**未**继续拆：它的成因是 `SubagentPortSeed` / `CorePorts` / `MediaStack` /
`ResolvedMediaOptions` 等类型仍声明在实现文件里，而把它们移入 ports 会**级联**——例如
`CorePorts.turnDiffTracker` 的类型是 `core/turnDiffTracker` 的**类**，要移进 ports 必须先把该字段
改成端口类型（`TurnDiffTrackerPort`），那是**类型契约**级改动、会影响字段消费方。
按"宁少勿险"处理：本轮把它记成 G25-b，不在拆环的同一提交里顺手改契约。
