---
'@mylong227/omniharness': patch
---

**serve 两处接线补齐**：工具侧事件真正到达客户端（不再只进控制台），并给 serve 侧图运行存档补上判据。

## 1. 工具侧事件端口（用户可见的缺口）

- **现象**：serve 下 `ask_user` 的 `question`、`todo_write` 的 `todo`、`plan_write` 的 `plan` 只在
  服务端控制台可见；对话流里那块「提问」要么不出现、要么**只在切换过工作区之后**才偶然出现
  （`switchWorkspace` 重建配置时顺手换成了服务端端口）。
- **根因**：这些工具在 `ConfigFactory.build` 期就捕获了事件端口，而 serve 的构建期端口取自
  `--events`——**缺省就是 `console`**，客户端出口从未注入。
- **修法**：`buildConfig(args, { events })` 支持注入**追加出口**，解析落在新增的
  `src/cli/cliEventPort.ts`（`CliEventPort.of`——按职责搬出，避免顶破 `CliBuildConfig` 的
  上帝类体量闸）；新增 `src/adapters/event/compositeEventPort.ts`（扇出 + 成员间 fail-soft：
  一个出口抛错不丢事件、不打断回合）；`runServe` 的 `buildServeUpstream` 把桥的事件端口一并注入。
  `--events console`（缺省）时控制台与客户端**并存**，`--events silent` 时客户端出口取代静默占位。
- **判据**：`questionUplinkWiring.test.ts` 正例（`question` 事件必须到达客户端）+ **反例**
  （事件端口不接客户端 ⇒ 同一回合里 `tool_result` 照常到达、`question` 永久缺席）+
  `buildServeUpstream` 的端口构成判据；`compositeEventPort.test.ts`（扇出顺序 / 单成员抛错不拖累 /
  flush 只冲刷有缓冲成员且失败不外抛 / `CliEventPort` 的四种组合语义）。
- **真机**：重启 serve 后（**未切换工作区**）在真实 UI 跑提问回合，对话流出现「提问」事件块
  （`b-question` 块数 = 1），且输入框上方的提问卡可作答。

## 2. serve 侧图运行存档的判据（这条接线此前没有任何判据）

`appServer.startGraphRun` 的 `persist: true` + `runId`（存档 id 用台账 runId，使通知/`graph.status`
与「可续跑的 runId」是同一个）已在上一笔提交随文件带入，但**没有 serve 侧判据**——既有
`workflowRunLog` / `workflowControlledRun` 测的是 runner 本身，都不经过 RPC 装配。新增
`tests/unit/graphRunPersist.test.ts`：`graph.run` → 真图运行 → 落盘
`<workspace>/.omniharness/graph-runs/<runId>.jsonl` → 首行 `run.start` 的 `runId` 等于返回的台账
runId → 收尾 `run.end` → `WorkflowRunLog.read` 读回步骤终态（续跑的前提）。
**变异验证**：把 `persist` 改回 `false` ⇒ 该判据变红（「必须落盘」）。

## 验证（本机实跑）

见提交正文：门禁 fast/typed、全量单测、web 用例与真机闭环的结果。
