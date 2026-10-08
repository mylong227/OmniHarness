---
'@mylong227/omniharness': patch
---

**提问不再只能看**：新增提问上行（`question.request` → `question.respond`），Web 端提问卡可作答；serve 的提问不再落到服务端终端。

## 背景（用户报障）

用户在 Web UI 里被 `ask_user` 提问后**无法作答**：提问卡有完整内容（标题、问题、选项、说明），
但选项是恒 `disabled` 的按钮、底部没有任何提交入口，卡片还写着「当前非交互式环境，已自动返回默认值继续执行」——
而事实并非如此（回合一直停在「正在调用 ask_user」，处于等待状态）。用户只能干等或放弃该会话。

## 根因（两条链都断，缺一条都复现）

1. **前端只有只读渲染**：`web/src/ui/format.ts#questionView` 把选项渲染成 `disabled` 按钮 + 一句与事实不符的说明；
   全仓没有任何「把作答提交给等待中的工具」的调用点（`question.respond` 不存在）。
2. **服务端没有提问上行通道**：`serve` 的 `userResponder` 取自 `ConfigBuilder.autoUserResponder()`
   （TTY ⇒ `ConsoleUserResponder`：在**服务端终端**里问人；非 TTY ⇒ `DefaultUserResponder`：直接放弃作答），
   Web 端两条路都拿不到作答权。审批早有上行（`approval.request`/`approval.respond`），提问从未接上。

## 改动

**服务端**

- `ServerEventBridge`（`src/server/core/serverEventBridge.ts`）新增提问上行：`questionPort(): UserResponder`
  - `requestQuestion` / `respondQuestion` / `failAllQuestions` / `pendingQuestionCount`，
    通知 `question.request`（带 `requestId`、`sessionId`、`questions`、`timeoutMs`）；
    超时（缺省 300s，`OMNI_QUESTION_UPLINK_TIMEOUT_MS` 可覆盖）与客户端全部断开时按
    **fail-soft**「未拿到回答」继续，文案与 `DefaultUserResponder` 同源（`answersFor`，单一实现）；
    `denyAllPending` 一并收尾挂起提问。
- 新增 `src/server/core/questionAnswers.ts`：作答**严格校验**（题 id 必须属于本次提问、`selected` 只能选
  提供过的标签、单选不得多选、`custom` 限长）；不合法 ⇒ `{ ok: false, error }` 且**保留挂起**可重提——
  答案原文会作为工具结果喂回模型，透传等于给外部输入一条注入模型上下文的通道。
- 端口 `UserResponder.ask(questions, context?)` 增加可选 `AskContext`（会话归属），`ask_user` 与
  `plan_present` 都传 `sessionId`（多会话并存时 UI 知道问题属于谁）。
- 接线：`AppServer.registerHandlers` 注册 `question.respond`；`AppServerOptions` 允许注入 `eventBridge`；
  `buildConfig(args, overrides)` 支持注入 `userResponder`；`runServe` 抽出 `buildServeUpstream`，
  在**配置构建之前**建桥并把 `questionPort()` 注入配置（`ask_user` 在 `ConfigFactory.build` 期就捕获了
  `userResponder`，晚一步就注不进去），AppServer 复用同一实例（否则作答会送进一张没登记过请求的表）。
- `protocolSchema` 增 `question.respond`（单源协议面 7 → 8），`docs/protocol.md` 同步。

**前端**

- 新增 `web/src/ui/components/QuestionCard.tsx`：可作答提问卡——选项是真正的 radio/checkbox
  （`aria-checked`、键盘可达、≥44px 触控目标）、每题可补充自由输入、逐题作答后才允许提交、
  另有「全部跳过」显式出口、按 `timeoutMs` 显示倒计时、错误就近显示（`role="alert"`）。
- `StreamView` 把卡片渲染在**输入框正上方**（与输入同屏；对话流可能被滚走，且 `question` 事件未必到达前端）；
  `AppController` 持有 `question` 状态（`question.request` 通知驱动）、`answerQuestion`（`question.respond`，
  失败/被拒都不关闭卡片）与 `expireQuestion`（倒计时归零收卡）。
- `ApiClient.respondQuestion(requestId, answers)`；`questionView` 纠错：选项改为**只读内容**（不再伪装成可点按钮），
  删掉与事实不符的说明，仅在真有提问等待时给出「请在下方提问卡中作答并提交」的指引。

## 判据

- `tests/unit/questionUplink.test.ts`（4 例）：① 端到端 `AskUserTool` → `question.request` → `question.respond` →
  作答进工具结果（含 `sessionId` / `timeoutMs` / 多选标记穿线）；② 超时 fail-soft 且逐题同序；③ 五类非法答案一律
  拒收、挂起保留、改正后可兑现，未知 requestId 返回 `unknown_request`；④ 断连即刻 fail-soft 收尾且幂等。
- `tests/unit/questionUplinkWiring.test.ts`（2 例，**判「接线」而非判零件**）：① 真 AppServer + 真 Agent + 脚本模型
  跑 `turns.run`：出 `question.request`（含会话归属与等待上限）→ `question.respond` → 作答进工具结果 → 回合跑完；
  ② `buildServeUpstream` 产出的配置里 `userResponder` 就是这座桥的提问端口（行为指纹：经配置里的回答器发问
  ⇒ 桥里真的多出一条挂起提问）——防的正是「零件都在、没人接线」。
- `web/test/questionCard.test.mjs`（3 例）：结构（每题选项控件 + 自由输入 + 提交/跳过）、提交门禁与载荷同序、
  自由输入独立作答与「全部跳过」提交空选择。
- `web/test/questionCardProbe.mjs`（真 Chrome / CDP 探针，1 例；`node --test web/test/questionCardProbe.mjs`）：
  推 `question.request` → 卡片可见 → 真鼠标点选项（`aria-checked` 转 true）→ 真鼠标点「提交回答」→
  断言发出的 `question.respond` 载荷恰为 `[{ id, scope… }]` 且卡片收起。刻意**不放进 `web:test` 的并行 glob**：
  同仓的 `chromeCleanup.test.mjs` 用「全机 Chrome 进程数」判收尾，多一个并发起浏览器的用例会让它误判
  （实测：单独跑全绿、并行必红），故沿用 `responsiveProbe/visualProbe/virtualProbe` 的独立探针形态。
- `web/test/format.test.mjs`：提问记录不再是 disabled 按钮；`pending` 时才出现指引。
- `tests/unit/codeGenerator.test.ts`：协议方法数 7 → 8 且含 `question.respond`。
- `web/test/browserHarness.mjs` 假后端补 `question.respond: { ok:true }`（与既有 `approval.respond` 同形；
  缺了它，提问类浏览器用例会因 `ok` 缺失被判「被拒」而假红）。

## 验证（本机实跑）

- `npx tsc --noEmit` 零错误；`node scripts/check.mjs --strict` 零违规（`runServe` 体量按职责搬出
  `buildServeUpstream`，未放宽阈值）；`node scripts/runGates.mjs` fast 10/10 ✓；`--tier=typed` 2/2 ✓。
- `node --test dist/tests/unit/*.test.js`：3066 项（3062 通过 / 0 失败 / 4 跳过，全量单测）。
- `node --test web/test/*.test.mjs`：353 项全绿。
- `node --test web/test/questionCardProbe.mjs`：真浏览器 1 项通过（卡片可见、可点、提交载荷正确、提交后收起）。
