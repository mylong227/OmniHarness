# 缺陷修复与验收记录（2026-10-21）

> 对象：`D:\deepseek\omniharness`，基线 `07a2a09b`（2026-10-20）。
> 口径：只记录**本机可复跑**的修复与判据；不引用跑分，不把“设计取舍”写成“已修”。
> 本轮修复来源：对 `07a2a09b` 的代码复核（`reports/CORE_CAPABILITY_GAP_ANALYSIS_2026-10-20.md`
> 之后仍存在的实际问题）。

## 1. 修复清单

| #   | 缺陷（修复前）                                                                                        | 修复                                                                                                                                                                                               | 判据                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Anthropic `stop_reason=max_tokens` 不触发截断续写；半截 tool_use 可能被执行                           | 新增 `ModelFinishReasons`（`max_tokens`/`max_output_tokens` → `length`）；四个适配器在 wire 边界归一化；`StepRunner` 用 `isTruncated` 兜底并继续丢弃截断工具调用                                   | `modelFinishReason.test.ts`（3 例）、`turnRecovery.test.ts`（新增 2 例）、`modelAdapters.test.ts`                                                                  |
| 2   | 压缩游标快路径在 tail 超预算时静默丢弃中段历史（不更新摘要/游标/日志）                                | `tryReuseState` 在 boundary 可前移时返回 undefined 走主路径重新折叠并写回游标；budget 小到无法改善时**告警** `compaction.reuse.over_budget`，不再无声                                              | `contextCompactor.test.ts`（新增“游标复用后 tail 溢出必须重新折叠”）、`compactionState.test.ts`                                                                    |
| 3   | reviewer 默认不注入；即使开启也与主模型同源；advisory 默认不可见                                      | reviewer **默认注入**（`OMNI_REVIEW=off                                                                                                                                                            | 0` 关闭）；默认 advisory 写 system 事件；`OMNI_REVIEW_BLOCK=1` 才阻断；`OMNI_REVIEW_MODEL`命中`modelRouter.entries` 时用独立模型（`ResolvedConfig.reviewerModel`） | `turnReviewGate.test.ts`（新增 advisory 例） |
| 4   | `browser_act` 没有 CDP 回退（注释/文档说回退，实际只有 Playwright），optional 依赖缺失即全废          | `BrowserSession` 实现 `BrowserActionPort` 九个动作（goto/click/type/press/scroll/wait_for/aria_snapshot/console/network）；`BrowserActTool` 启动失败自动切 CDP，`OMNI_BROWSER_ENGINE=cdp` 显式直连 | `browserActFallback.test.ts`（3 例）、`browserSessionCdpActions.test.ts`（1 例）                                                                                   |
| 5   | 浏览器真机判据在缺 Chrome/`playwright-core` 时裸 `return`，vitest 记为 pass；`requireSwitches` 看不见 | 两个判据改用 `RequireEnv.skipUnlessBool('OMNI_REQUIRE_BROWSER', …)`；缺能力时**失败/跳过**而不是静默通过                                                                                           | `browserDefaultEngine.test.ts`、`browserPlaywrightE2E.test.ts`、`requireSwitches.test.ts`                                                                          |
| 6   | `TokenEstimatorCalibrator` 零接线（只有单测），token 估算没有反馈                                     | `StepRunner` 每次首次请求后 `observe(estimated, actual)`；`Agent` 持有单实例并注入 compactor；样本 ≥5 时按 `factor` 修正自动窗口阈值                                                               | `tokenEstimatorCalibratorWiring.test.ts`（2 例）                                                                                                                   |
| 7   | 回合结束无条件全量重写 JSONL，抵消 G7 追加优化                                                        | `EventPersister.hasUnsaved()`；Agent 仅在未落盘/回卷/追加失败时全量 save                                                                                                                           | `eventPersister.test.ts`（新增 hasUnsaved 例）、`agentLoopAudit.test.ts`                                                                                           |
| 8   | MCP 默认 legacy，2026-07-28 server 开箱接不上                                                         | `McpProtocolNegotiator` 默认 `auto`；连接器先 `server/discover`，失败在同一 transport 上回退 `initialize`；显式 `legacy`/`2026-07-28` 保持                                                         | `mcpProtocolNegotiator.test.ts`、`mcpAutoNegotiation.test.ts`（真实 JSON-RPC 假 transport）                                                                        |
| 9   | 工作区 `SKILL.md` 不会被发现（只有 `--skills` 文件入口）                                              | 新增 `SkillMdDiscovery`：扫 `.omniharness/skills/*/SKILL.md` 与 `.claude/skills/*/SKILL.md`，坏文件告警跳过、显式同名优先                                                                          | `skillMdDiscovery.test.ts`（2 例）                                                                                                                                 |
| 10  | 续跑引导只列工具名，同名不同目标无法区分                                                              | `ResumeGuidance` 从 args 提取 path/command/query 目标并去重（最多 10 条）                                                                                                                          | `resumeGuidance.test.ts`                                                                                                                                           |
| 11  | 每步从全量事件重新投影，8h 长会话 O(N)/步                                                             | `ContextAssembler` 增加增量投影缓存：事件前缀对象同一且确实追加时只投影新增事件；同长度/回卷/动态片段变化一律重建                                                                                  | `contextAssemblerIncremental.test.ts`（3 例）                                                                                                                      |
| 12  | headless `-p` 仍补 1h 硬时限，与 8h 长任务目标不一致                                                  | `execCli` 不再单独压 1h，沿用 Agent 默认 8h（`OMNI_LOOP_MAX_MS` 可覆盖）                                                                                                                           | `cliStartupBudget` / 全量单测                                                                                                                                      |

## 2. 验收命令与结果

> 以下均为本机实跑（2026-10-21，Asia/Shanghai）。完整输出见终端记录，数字以最后一次运行为准。

```bash
npm run typecheck          # tsc --noEmit + web tsc --noEmit：通过
npm run lint               # eslint . --max-warnings=0：通过
npm run check              # 铁律/函数体/依赖：通过（1113 个 TS 文件，0 违规）
npm run arch:gate -- --strict   # 0 新增违规（ports 纯度 0）
npm run audit:config-wiring     # 1113 个源文件全绿
npm run api:check          # index 161 / indexBeta 70 条 export 均带标注
npm run format:check       # Prettier：All matched files use Prettier code style
npm run check:doc-links    # 41 份 markdown，死链 0
npx vitest run --project node tests/unit   # 结果见 §2.1
```

### 2.1 全量单测

2026-10-21 本机实跑（`npx vitest run --project node tests/unit`）：

```
Test Files  589 passed | 1 skipped (590)
Tests       3617 passed | 7 skipped (3624)
Duration    ~337s
```

7 例 skipped 均为显式 `RequireEnv` 平台/能力开关（原生内核、WASM、Laya 权重等），
不是静默通过；浏览器两例已从“裸 return”改为开关控制。

### 2.2 集成 + 前端

```bash
npm run test:integration   # 7 files / 17 tests 全绿（含真 serve + 真 Chrome + Laya 真模型）
npm run test:frontend      # 93 files / 539 tests 全绿（vite build + 真 Chrome）
```

### 2.3 验收过程中修掉的**陈旧判据**（不是本轮功能回归）

| 判据                                       | 旧断言（失效原因）                                                                                                          | 本次修正                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `tests/integration/liveUiE2e.test.ts`      | 无 token 直接取 `/`（serve 早已默认生成临时令牌）；等待旧下拉 `.pp-menu`（面板早已改为 `PanelModal`）                       | 从启动横幅取 `?token=`；静态首屏带 token、RPC/metrics 带 Bearer；等待 `.panel-modal .sp-nav-item` |
| `tests/integration/uiBaseline.json`        | 仍是旧壳层：含“文件”入口/页签、回形针控件、3 条空态                                                                         | 按当前 UI 重生成基线（文件入口/页签、附件按钮是 2026-10-19 的有意移除；右栏空态为新增）           |
| `tests/integration/selfVerifyLoop.test.ts` | 断言成功写入“输出不含 `[自验证回环]`”；但 `FailureReflectionStore` 会把**上一次失败的摘要**作为历史反思回灌，其中含该字符串 | 改为断言“回环段数量不增加”：测试通过不**追加**新的回环段，历史反思允许存在                        |
| `web/test/colorSystem.test.ts`             | 断言发送按钮底色 == `--accent`；但 2026-10-20 设计已改为 `accent 12% + panel` 淡底                                          | 解析 `color(srgb ...)`，按 12% 混色逐通道比较（容差 1.5）                                         |
| `web/test/e2e.test.ts`                     | 假后端对 `threads.get` 返回 `{}`；而回合收尾后 UI 会重拉历史，把刚 push 的 `turn_diff`/`assistant` 覆盖成空                 | 假后端记录 `thread.event` 并让 `threads.get` 返回同一批事件（`EVENTS`）                           |

> 这五处修改均为“测试落后于已合入的 UI/安全/反思变更”，不是为了让新代码变绿而放宽断言；
> 每条的旧断言失效原因都写在上表，可在 git 历史里对照。

### 2.2 本轮新增/修改判据

- `tests/unit/modelFinishReason.test.ts`
- `tests/unit/turnRecovery.test.ts`（+2 例）
- `tests/unit/contextCompactor.test.ts`（+1 例）
- `tests/unit/tokenEstimatorCalibratorWiring.test.ts`
- `tests/unit/turnReviewGate.test.ts`（+1 例）
- `tests/unit/browserActFallback.test.ts`
- `tests/unit/browserSessionCdpActions.test.ts`
- `tests/unit/skillMdDiscovery.test.ts`
- `tests/unit/resumeGuidance.test.ts`
- `tests/unit/eventPersister.test.ts`（+1 例）
- `tests/unit/contextAssemblerIncremental.test.ts`
- `tests/unit/mcpAutoNegotiation.test.ts`

## 3. 本轮**没有**改的边界（避免把取舍说成修复）

| 边界                             | 现状                                                                                                                                                   | 为什么不在本轮改                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS 级隔离仍是 L2                 | 默认 `sandbox=policy`（TS 策略）；`wsl-bwrap`/`landlock`/`seatbelt` 需显式选择且依赖宿主能力；shell 出网仅在 `OMNI_NETWORK_ALLOW` 已配置时被工具层拦截 | 默认改 OS 级沙箱会改变平台契约（Windows 上 WSL2/bwrap 不是必装），且 `npm install`/`git clone` 等正常任务需要出网；这是环境/产品边界，不是一行代码能闭合 |
| A2A server 仍默认关              | `--a2a` 才监听端口                                                                                                                                     | 默认开一个可被外部调用的监听端口是安全决策，不应为“默认有互操作”而牺牲 fail-closed；MCP 的默认已改为 auto                                                |
| 目标达成仍由 LLM 做正向 YES/NO   | 机械证据只否决“有工具但全失败”，正向语义仍由 `GoalChecker` 调模型                                                                                      | “是否达成”本质是语义判断；机械层只能做否定门。独立 reviewer 已默认开启且可配独立模型，但不等价于形式化验证                                               |
| memory primer / evolution 默认关 | 机制存在，端到端增益未证                                                                                                                               | 过去已登记“无增益证据就保持默认关”；没有新证据不应翻默认                                                                                                 |
| `maxSteps=0` 且 token 预算默认 0 | 成本刹车需显式配 `--turn-token-budget` 或 `OMNI_TURN_TOKEN_BUDGET`                                                                                     | 没有通用合理的默认预算；8h 硬时限 + 30min 软提醒 + 失控检测是现有兜底                                                                                    |

> **不欺骗声明**：上表五项仍是现状，本轮没有把它们算进“已修复”。§1 的 12 项均有对应判据；
> 其中 §1-4 的 CDP 回退是**能力回退**（语义弱于 Playwright，没有 actionability 自动等待），
> 不是“与 Playwright 等价”。
