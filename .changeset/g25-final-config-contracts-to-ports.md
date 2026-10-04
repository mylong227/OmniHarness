---
'@mylong227/omniharness': patch
---

**G25 收尾**：`CorePorts` 契约搬入 ports、实现类成员全部改挂端口类型，ports→实现层边归零并加固门禁（升级报告 §4 最后一行 ⏳ 销账）。

## 背景

升级报告 §4 登记「G25-b 剩余 4 成员配置子环」⏳：`SubagentPortSeed`/`CorePorts`/`MediaStack`/`ResolvedMediaOptions`
仍声明在实现文件里，移入 ports 会级联（成员类型是实现类，需先改成端口类型）——属**类型契约**级改动，与拆环分开做。
G25-b 已搬走 `SubagentPortSeed`/`MediaStack`，`ResolvedMediaOptions` 随后在 ports；本轮搬走最后一块 `CorePorts`。

## 改动

1. **三个新端口契约**（一接口一文件，纯类型，零第三方）：
   - `ports/context/toolResultSpillerPort.ts`——`ToolResultSpillerPort`（消费面：`apply`）；
   - `ports/tool/toolDiscoveryPort.ts`——`ToolDiscoveryPort`（消费面：`add`/`list`/`has`，#M1 延迟加载闭环）；
   - `ports/context/repoMapContextEnginePort.ts`——`RepoMapContextEnginePort`（消费面：两路 `getRepoMapContext` /
     `getHybridRepoMapContext` + U4 的 `invalidate`，即生产调用方的**全部**外部调用面）；
     其入参类型 `RepoMapContextOptions` 一并从 `context/recallKnobs.ts` 搬入 `ports/context/repoMapContextOptions.ts`
     （原位置桶再导出，公共 API 面不变）。
2. **实现类逐一 `implements`**：`ToolResultSpiller` / `ToolDiscovery` / `RepoMapContextEngine`（前两个类已有先例：
   `ToolHookRunner implements ToolHookRunnerPort`、`TurnDiffTracker implements TurnDiffTrackerPort`）。
3. **`CorePorts` 搬入 `ports/config/corePorts.ts`**：四个实现类成员（`spiller`/`discovery`/`hooks`/`turnDiffTracker`）
   全部改挂端口契约；原位置 `corePortsAssembler.ts` 桶再导出，`configFactory` 等调用点零改动。
   消费方类型引用随之切换：`ports/config/resolvedConfig.ts`、`ports/composition/omniHarnessRuntime.ts`、
   `ports/subagent/subagentPortsShape.ts`、`core/stepTypes.ts`，以及 `configBuilder.seedOf`/`buildHooks` 与
   `configToolRegistry` 的签名（收窄为端口契约）。

## 门禁加固（同轮）

ports→实现层规则 [3.5] 原来只覆盖 `core/adapters/config/composition`——`context/`、`search/` 是**漏网层**：
`ports/config/resolvedConfig.ts` 等曾长期 `import type` 绑定 `ToolResultSpiller`/`ToolDiscovery`/`RepoMapContextEngine`
实现类而门禁「看不见」。本轮三契约落地后该类边**归零**，[3.5] 随之补上 `context/`、`search/` 两层——「新增即红」。

## 验证

`typecheck` 零错误；`architectureGate`：依赖方向违规 0（白名单 0，新增 0）、ports 纯度 0、ports→实现层 0、依赖环 5 组（新增 0）；
`lint` 0 告警；`api:check` 绿（全部为新增端口类型与既有 `@beta` 面的桶再导出，无破坏性变更）。
