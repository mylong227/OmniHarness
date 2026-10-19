# 长会话质量分析：数据、病灶与下一批优化

> 数据截止：2026-10-20 00:15（本地）
> 数据源：`~/.omniharness/sessions/*.jsonl`，**152 个会话**（真实模型会话 8 个，mock 144 个）
> 工具：`tools/sessionTelemetry.mjs`（本轮新增，离线、零依赖；`npm run telemetry:sessions`）
> 前一篇：[鹈鹕会话复盘](PELICAN_SESSION_POSTMORTEM_2026-10-19.md)（单会话纵深）
> 本篇是横向视角：**长会话的共性病灶、已经修掉的、以及还值得做的**。

---

## 0. 一句话结论

**8 个真实会话里，有 137 次工具结果是「同一份内容被重复取回」——占全部工具结果的 33%；
其中 136 次集中在 3 个 2026-10-13/14 的会话里。** 根因是当时 8000 token 的压缩阈值导致
「压缩 → 摘要失忆 → 重新探索」的死循环；2026-10-14 已把阈值改为 0.8×真实窗口，之后的
会话（含鹈鹕）冗余降到 0–1 次、缓存命中升到 84–92.5%。

但这不代表可以收工：**当时没有任何检测器能看见「不连续的重复取回」**（LoopGuard 只认
连续重复与 ≤4 的短周期）。本轮补上了**结果指纹级**的 `redundant-result` 检测，并给压缩摘要
加了**确定性工具台账**——即使将来压缩策略再回归，也不会再无声地烧掉 30 分钟。

---

## 1. 数据与方法

### 1.1 口径

| 指标 | 定义 |
| --- | --- |
| 真实会话 | 至少有一条 `model` 事件的会话；mock 会话没有 `model` 事件 |
| 有效时长 | 墙钟 − 空闲间隔（>5 分钟且间隔之后是 `user` 事件的间隔） |
| 结果冗余 | 同一「工具名 + 结果内容 FNV 指纹」在会话内第 2 次及以后出现 |
| 缓存命中 | `cachedPromptTokens / promptTokens` |
| 成本 | 按 `deepseek-v4-flash` 公开单价 0.30 / 1.20 / 0.006 USD per 1M **估算** |

### 1.2 八个真实会话

| 会话 | 日期 | 有效/墙钟 | 调用 | prompt | 缓存 | 输出 | ctxMax | 压缩 | 冗余 | 失败 | 成本 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `mvf6q61y`（鹈鹕） | 10-19 | 1235s / 1235s | 45 | 3.31M | **92.5%** | 92.5k | 83.1k | 0 | 1 | 12 | $0.20 |
| `mv6rkj0k` | 10-13 | 356s / 356s | 17 | 124.9k | 41.9% | 7.9k | 7.7k | 1 | **43** | 0 | $0.03 |
| `mv88ycm7` | 10-14 | 333s / 333s | 51 | 408.4k | 74.3% | 29.5k | 9.9k | 1 | **59** | 0 | $0.07 |
| `mv9nl59c` | 10-15 | 237s / 237s | 34 | 1.26M | 83.9% | 25.6k | 57.0k | 0 | 0 | 0 | $0.10 |
| `mv8b8k5j` | 10-14/15 | **135s / 8.16h** | 34 | 1.11M | 88.0% | 18.6k | 49.7k | 0 | 0 | 5 | $0.07 |
| `mv6uvoyd` | 10-13 | 81s / 81s | 17 | 139.2k | 58.0% | 12.1k | 8.0k | 1 | **34** | 2 | $0.03 |
| `mv8a0fso` | 10-15 | 9s / 9s | 4 | 22.9k | 56.0% | 0.3k | 5.7k | 0 | 0 | 1 | $0.00 |
| `mve1s8c6` | 10-15 | 5s / 5s | 3 | 20.3k | 39.7% | 0.3k | 6.5k | 0 | 0 | 0 | $0.00 |
| **合计** | | **39.9 min** | **205** | **6.39M** | 86.8% | **186.8k** | | 3 | **137** | 20 | **$0.51** |

两个结构性事实：

1. **鹈鹕会话占了一半的真实计算**：有效时长 51.6%、prompt 51.8%、输出 49.5%、成本 39%。
   它不是异常值，而是「当前默认模型 + 当前 harness 配置」下的典型长任务。
2. **3 个 pre-fix 会话占 99% 的冗余**（136/137），而它们只占有效时长的 32%（770s）。

---

## 2. 病灶一：144/152 个会话是 mock，存档被测试数据淹没

- 152 个会话里 **144 个没有 `model` 事件**：工具调用是 `mock_call_1`，assistant 固定
  `任务完成（模拟模型适配器输出）`，首条用户消息多为「hi」「用一句话介绍自己」。
- 它们不产生 token/成本，但：
  - 会话列表被 144 条噪声占满（真实会话只有 8 条）；
  - 任何「会话数 / 活跃度 / 平均时长」统计都会失真（96% 的样本是假会话）；
  - 存档扫描、列表刷新、用量聚合都要为它们做无意义的 IO。
- 根因：`MockModel.name === 'mock'`，但 mock 会话**没有 model 事件**（MockModel 不返回 usage），
  因此存档里**没有任何字段能区分真假**——只能靠 `mock_call_1` 这种启发式。

**建议（P0）**：`session_meta` 增加 `adapter`/`model` 字段（真实运行时就该记），mock 会话
显式标记；列表默认过滤 mock、或把 mock 会话自动归入 `archive/`；给一个「仅显示真实会话」开关。
这不需要改 UI 结构，只要存档里有一个可靠字段。

---

## 3. 病灶二：压缩阈值过低导致的「上下文抖动」（已修，但值得记住）

### 3.1 现场

| 会话 | ctxMax | 压缩次数 | 冗余 | 缓存 |
| --- | --- | --- | --- | --- |
| `mv6rkj0k` | 7,672 | 1 | 43 / 74 工具结果 | 41.9% |
| `mv88ycm7` | 9,855 | 1 | 59 / 102 | 74.3% |
| `mv6uvoyd` | 7,963 | 1 | 34 / 103 | 58.0% |

具体形态（`mv88ycm7`）：

- `read_file backend/src/services/backfillEngine.ts` **34 次**，34 次结果指纹完全相同；
- `list_dir "."` **15 次**，结果完全相同；
- `read_file eastMoneyRealData.ts` 11 次、`simulatedHistoryGenerator.ts` 5 次；
- prompt 长期停在 **6,995** 附近：上下文被压到刚好装下摘要 + 最近几条，刚读的文件内容
  下一步就被折叠掉，模型于是再读一遍——**压缩越勤，重复越多**。

根因在 `Agent.buildCompactor`：当时默认阈值是固定 **8,000 token**，而 `keepRecent=6` 会把
刚读的工具结果整体折进摘要。128k 窗口的模型在 ~6k 用量就触发折叠，摘要又常常只有十几字
（「摘要塌陷」），模型每步失忆、无限重启探索。

### 3.2 已修

`Agent.buildCompactor`（2026-10-14）改为：未显式配置 `compactionMaxTokens` 时，
阈值 = **0.8×真实窗口**（`ContextWindowCatalog`；deepseek 系列 128k ⇒ 102.4k）。
pre-fix 的 3 个会话 `ctxMax` 都 <10k、post-fix 的 3 个会话 `ctxMax` 49.7k–83.1k 且 0 压缩——
数字与「阈值已生效」一致。

### 3.3 但这暴露了检测器的盲区

LoopGuard 原本只认两类重复：

- `exact-repeat`：**连续**相同签名；
- `cycle`：尾部 **2–4** 个调用的短周期。

`read_file a → list_dir . → read_file a → …` 这种「隔着别的调用、周期 7–8」的重复，
两个都看不见。**本轮补上了结果指纹检测**（见 §4）。

---

## 4. 本轮修复一：结果指纹级的冗余检测

### 4.1 实现

- `src/core/loop/loopGuard.ts`
  - 新增 `redundant-result` 违规类型与 `LoopResultObservation`；
  - 维护最近 64 个**成功且 ≥64 字符**的结果指纹（`工具::FNV(内容)`）；
  - 同一指纹出现 ≥4 次 ⇒ 首次 `nudge`，连续触发达 `nudgeLimit` ⇒ `abort`；
  - 触发后清空窗口：否则旧的 4 条重复会在窗口里留很久，模型改好后仍被误杀；
  - `maxRedundantResults=0` 可关闭；`OMNI_LOOPGUARD=0` 的全量关闭路径同步关掉它。
- `src/core/stepRunner.ts`：新增 `toolResultsOfLastStep`（从事件日志尾部按 callId 对齐，
  不侵入审批/沙箱/钩子链路）。
- `src/core/turnRunner.ts`：把 `results` 一并交给 LoopGuard。

### 4.2 回放证据

把历史会话按步回放（同一模型行为固定，只看检测器会不会响）：

| 会话 | 触发点 | 若不修复会浪费 |
| --- | --- | --- |
| `mv6rkj0k` | 第 8、15 步 `redundant-result` | 17 步里 43 次冗余结果 |
| `mv88ycm7` | 第 7/14/22/26/32/36/40/48 步冗余 + 2 次 cycle | 51 步里 59 次冗余 |
| `mv6uvoyd` | 第 9、14 步 `redundant-result` | 17 步里 34 次冗余 |
| **鹈鹕** | **0 次** | 45 步里仅 1 次（合法复查） |

回放里第一次 nudge 在 `mv6rkj0k` 第 8 步——如果能在那时打断，后面 9 步（含 43 次冗余结果
中的大部分）就不必发生。鹈鹕的 0 触发说明没有误伤：`apply_patch` 连续 4 次相同**状态文案**
（<64 字符）被长度阈值排除，不会被当成「重复内容」。

### 4.3 为什么是 4 次、64 字符、只算成功

- 2 次是合法复查（改完再读一遍确认）；3 次已偏多；4 次基本可判定「没有推进」。
- 64 字符以下多是 `ok` / `done` / 短状态，重复是常态。
- 失败结果的重试是合法行为（网络抖动、审批拒绝后调整），不参与。

---

## 5. 本轮修复二：压缩摘要 + 确定性工具台账

模型摘要可能漏掉「已经读过哪些文件、跑过哪些命令」。一旦漏掉，压缩后的下一步就会重新探索。
本轮在 `ContextCompactor` 里追加一段**由折叠事件直接生成**的台账（不依赖摘要质量）：

```
## 已执行工具台账（确定性生成，用于避免重复探索）
- read_file src/a.ts ×2
- shell npm test ×1（失败 1 次）
```

- 按「工具 + 目标（command/path/pattern/url）」聚合计数，重复在上下文里直接可见；
- 最多 40 行；目标截断 80 字符；
- **预算 <2000 token 时不加**：小预算下宁可少一行台账，也不能把最近的工具轮挤出 tail
  （这条是被 `contextCompactor.test.ts` 的「c3 必须留在 tail」用例逼出来的——第一版没加
  预算门控，直接把 50 token 测试预算下的 tail 挤掉了一条）。

---

## 6. 病灶三：墙钟 ≠ 有效时长

`sess_mv8b8k5j`：墙钟 **29,366 秒（8 小时 9 分）**，但中间有一次 **29,231 秒**的空闲
（用户离开后又回来），有效计算只有 **135 秒**。

如果 UI/统计直接展示「墙钟」，会得到两个错误结论：①这个任务跑了 8 小时；②平均会话时长
被这一条拉高几个数量级。`tools/sessionTelemetry.mjs` 已按「>5 分钟且后接 user 事件」剔除
空闲；建议服务端/UI 的会话列表也采用同一口径（或只显示「最后活动时间」）。

---

## 7. 病灶四：prompt cache 与压缩经济学

| 阶段 | 缓存命中 | 说明 |
| --- | --- | --- |
| pre-fix 3 会话 | 41.9% / 58.0% / 74.3% | 每次压缩重写摘要 + 丢弃 tail ⇒ 前缀反复失效 |
| post-fix 3 会话 | **92.5% / 83.9% / 88.0%** | 稳定增长的前缀，缓存几乎全中 |

两笔额外成本：

1. **压缩本身是一次模型调用**：摘要请求 = 原样重放 head + 压缩指令（前缀友好设计，能命中
   隐式缓存），但仍要付一次输出与一次往返；按 102k 阈值，一个 200k 的会话大约压缩 1–2 次。
2. **`tool_search` 会打断缓存**：鹈鹕第 16 次调用 `cachedPromptTokens` 从 51,200 掉到
   **3,712**，下一步才回到 58,112——因为工具表变了，prompt 前缀整体失效。一次 tool_search
   的代价不只是它自己的输出，还有一次全量 prefill。**上一轮修完工具暴露后，这类搜索应该
   在第一步就发生（或不再需要）**。

---

## 8. 病灶五：存档体积与内存

- 鹈鹕单会话 **6.28 MiB**，占 8 个真实会话总字节的 **81%**、全部存档（≈7.9 MiB）的 **80%**；
- 体积几乎全是 7 张截图的 base64（6.2M 字符）；
- `SessionScanCache.parseSummary` 用 `readFileSync` 整文件 + `split('\n')`；会话活跃时
  mtime 每步都变 ⇒ 列表刷新会反复整读 6.28 MB；
- `SessionArchive.dailyUsage` 对每个文件做全量 `readFileSync`，不走 usage 缓存；
- 进程内 `recorder.allEvents()` 持有全部事件（含 base64），回放/组装都基于它。

上一轮已经把**送模型**的附件压到 1600px JPEG（6–10×）并加了历史预算淘汰；但**存档**仍是
原图 base64。下一步建议（P1）：`tool_result.files` 只存 `{name, mediaType, path}`，base64
落到 `.omniharness/attachments/<session>/<hash>`，回放时按需读；摘要扫描改 head/tail 读。

---

## 9. 病灶六：回合没有默认时间/输出上限

- `maxSteps` 默认 **0**（不设硬步数上限，这是 2026-10-15 的刻意变更）；
- `OMNI_LOOP_MAX_MS` 默认 **0**（不设 wall-clock 上限）；
- 请求体没有 `max_tokens`，模型可以一次生成 20k token（鹈鹕首调）。

结果是：**唯一能拦住长会话的是模型自己愿意收尾**。LoopGuard 能拦「重复」，拦不住
「一直在做新事情但 40 分钟没收敛」。建议（P1）：

- 暴露「单回合软时限」（默认 30–45 分钟）：到点先 nudge 收尾，再由 `finalize` 强制总结；
- 暴露「单次输出上限」（如 8k–16k token）：治「一次思考 20k token 才动手」，同时保留
  写大文件的能力（`write_file` 的内容通常 5–10k token，8k 会误伤，建议 16k 或按任务类型分层）。

---

## 10. 其它长会话缺口（按性价比）

| # | 缺口 | 证据 | 建议 | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | mock 会话污染列表/统计 | 144/152 | `session_meta` 记 adapter；列表过滤/归档 | P0 |
| 2 | 存档内联 base64 | 6.28 MiB / 会话 | 附件外置 + head/tail 扫描 | P1 |
| 3 | 墙钟 ≠ 有效时长 | 8.16h vs 135s | 统计/UI 用有效时长 | P1 |
| 4 | 无软时限/输出上限 | 20k token 首调 | 可配置 deadline + max_tokens | P1 |
| 5 | 图片 token 不入账 | 107.6k vs 83.1k | 每图保守常数或 provider 回填 | P2 |
| 6 | nudge 污染查询文本 | LoopGuard nudge 记为 user | 加 `synthetic` 标记，`deriveQueryText` 跳过 | P2 |
| 7 | `deepseek-flash` 未定价 | 兜底价高估 10× | 价目别名 | P2 |
| 8 | repo-map 对非代码任务无意义 | 鹈鹕 reasoning 6 次「无关」 | 任务类型判定或首步后降级 | P3 |
| 9 | `dailyUsage` 全量扫描 | 每次读所有文件 | 复用 `SessionScanCache.readUsage` | P3 |
| 10 | `turn_diff` 漏 shell 删除 | `_preview_server.js` | mtime 指纹或专用删除工具 | P3 |

---

## 11. 本轮改动与验证

| 改动 | 文件 | 判据 |
| --- | --- | --- |
| 结果指纹冗余检测 + 全量关闭路径 | `src/core/loop/loopGuard.ts`、`src/core/agent.ts` | 新增 3 条单测（触发 / 不误伤 / 关闭） |
| 结果观测接线 | `src/core/stepRunner.ts`、`src/core/turnRunner.ts` | `tsc --noEmit` + LoopGuard 回放 |
| 压缩摘要确定性台账 | `src/context/contextCompactor.ts` | 新增 1 条单测（聚合 ×N / 失败计数 / 预算门控） |
| 会话遥测工具 | `tools/sessionTelemetry.mjs` | 本报告全部数字由它产出 |

运行结果：

- `tsc --noEmit` 通过；
- 11 个测试文件 **113 条**全绿（第一批；两批合并为 21 个文件 189 条，见 §12）；
- 回放：鹈鹕 0 误报；3 个 pre-fix 会话分别在 8、7、9 步首次命中。
- 数据复现：`npm run telemetry:sessions`（或 `node tools/sessionTelemetry.mjs --json=out.json`）。

---

## 12. 第二批落地（2026-10-20）

按上一节清单逐项实现（除附件外置，见 §13）：

| 原项 | 实现 | 位置 | 判据 |
| --- | --- | --- | --- |
| P0 mock 会话 | 新会话 `session_meta.model` 记模型名；旧存档按 `mock_call_` / 「模拟模型适配器输出」识别；`list` 默认过滤，`includeMock:true` 才列出 | `eventFactory.ts`、`sessionRecorder.ts`、`agent.ts`、`sessionScanCache.ts`、`sessionArchive.ts`、`appServer.ts` | `sessionArchive.test.ts` 新增 1 条（隐藏/包含/标记） |
| P1 有效时长 | 摘要新增 `activeMs` + `idleGaps`（>5 分钟且后接 user 的间隔剔除） | `sessionScanCache.ts` | 同上（10s+5s，剔除 1 小时挂机） |
| P1 软时限 | `LoopGuard.softDeadlineMs`：到点只 nudge 收尾；`Agent` 默认 **30 min 软 / 60 min 硬**，`OMNI_LOOP_SOFT_MS` / `OMNI_LOOP_MAX_MS` 可调（0 = 关） | `loopGuard.ts`、`agent.ts` | `loopGuard.test.ts` 新增 1 条（软 nudge / 硬 abort） |
| P1 输出上限 | `ModelRequest.maxOutputTokens` → OpenAI `max_tokens` / Anthropic `max_tokens`（不低于 thinking 地板）；`OMNI_MAX_OUTPUT_TOKENS` 配置（默认关） | `modelRequest.ts`、`stepTypes.ts`、`stepRunner.ts`、`agent.ts`、`openAiCompatibleModel.ts`、`anthropicModel.ts` | `modelOutputCap.test.ts`（透传 / 未设不发） |
| P2 图片 token | 压缩预算按 **1600 token/张** 扣减（不改 TokenEstimator 的对外记账，避免 Rust 镜像漂移） | `contextCompactor.ts` | `contextCompactor.test.ts` 新增 1 条（纯文本不压、加图就压） |
| P2 nudge synthetic | user 事件新增 `payload.synthetic`；`deriveQueryText` 跳过合成消息 | `eventFactory.ts`、`sessionRecorder.ts`、`turnRunner.ts`、`stepContextBuilder.ts` | `toolCatalogSnapshot.test.ts` 新增 1 条（nudge 的「文件」不得翻转工具表） |
| P2 定价别名 | `deepseek-flash` 精确命中 0.30/1.20/0.006 | `routePricing.ts` | `routePricingDefaults.test.ts` 新增 1 条 |
| P3 repo-map | `shouldBuildRepoMap` 任务形状闸：视觉/创作且无代码信号 ⇒ 跳过（剔除「不需要测试」否定短语） | `stepContextBuilder.ts` | `repoMapTaskGate.test.ts` 2 条 |
| P3 dailyUsage | 按 `(mtime,size,dayKey)` 缓存单文件当日用量 | `sessionArchive.ts` | `sessionArchive.test.ts` 新增 1 条（追加后失效） |
| P3 turn_diff | 单目标 `del/erase/rm` 渲染为全量删除行；其他可能写盘的 shell（copy/move/重定向/脚本/安装）让 diff 失效 | `turnDiffHooks.ts` | `turnDiffTracker.test.ts` 新增 3 条（分类/删除/invalidate） |
| P1 附件外置 | `JsonlStorage` 落盘/追加时把 >256K 字符的 `files[].data` 移到全局 `sessions/attachments/<sha256>.<ext>`；事件只留 `path`；`ContextAssembler` 投影时按路径水合 | `sessionAttachmentSpiller.ts`、`jsonlStorage.ts`、`contextAssembler.ts`、`fileAttachment.ts` | `sessionAttachmentSpill.test.ts` 2 条（存档不含 base64 / 回放水合一致 / 小附件内联） |

验证：`tsc --noEmit` 通过、ESLint（改动文件）通过、**22 个测试文件 191 条全绿**。

---

## 13. 附件外置的边界（已落地并迁移）

- **写侧**：`JsonlStorage.save` / `append` 在序列化前调用 `SessionAttachmentSpiller`，超过
  256K 字符的附件按 sha256 写到 `sessions/attachments/<sha256>.<ext>`；事件里只留
  `{name, mediaType, path}`。内容寻址 ⇒ 同一张图只存一份，fork 出来的会话共享同一份字节，
  删除原会话也不会把 fork 的图片一起删掉。
- **路径口径**：`path` 是**相对 sessions 根**的 POSIX 路径（`attachments/xxx.png`）。读侧
  `ContextAssembler` 用 `StoragePort.location` 拼绝对路径水合（上限 8 MiB）；旧存档里的绝对
  路径继续兼容。整个 sessions 目录搬移/备份后仍可解析。
- **内存侧**：当前回合的事件仍保留 data（recorder 不受影响）；只有落盘副本被替换。
- **旧存档**：`npm run migrate:attachments` 一次性迁移（默认 dry-run，`--apply` 才写盘，
  `--dir=` 指定目录）。本机已执行：`sess_mvf6q61y_e.jsonl` **6.28 MiB → 0.37 MiB**，
  7 张截图落到 `sessions/attachments/`，重跑 dry-run 为 0 变更（幂等）。
- **前端消费**：`SessionEntry` / `ApiClient` 已带 `activeMs`、`idleGaps`、`mock`、`model`；
  卡片视图与悬停文案展示「有效 12分 · 空闲 1 次」（`SessionRowMeta.activeDuration`），
  `sessions.list` 默认过滤 mock（API 可传 `includeMock`）。

---

## 14. 结论

清单里的 10 项全部落地，并完成了三项收尾：

1. **旧存档迁移**：6.28 MiB 的鹈鹕会话已外置为 0.37 MiB + 7 个附件文件；
2. **`path` 相对化**：相对 sessions 根，跨机器搬移/备份后仍可水合；
3. **前端消费**：会话卡片/悬停显示有效时长，mock 默认隐藏，`includeMock` 可选。

验证面：Node 侧 **22 个测试文件 191 条** + Web 侧 5 条，`tsc`（根与 web）与 ESLint 均通过。

后续只剩**非阻塞**打磨：

- 内容寻址附件的 **GC**：删除会话不会删共享附件（当前按需保留，避免 fork 断图）；可在
  `SessionArchive.delete` 里做引用计数，或定期清理无引用的 `<sha256>.*`。
- 会话摘要扫描仍是整文件读；当前最大会话已从 6.28 MiB 降到 0.37 MiB，head/tail 读的收益
  已不大，可作为锦上添花。

长会话的「时长 / token / 内存 / 存档体积」四条线，至此全部收口。
