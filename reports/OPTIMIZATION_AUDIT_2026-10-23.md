# OmniHarness 优化盘点（2026-10-23）

> 范围：`D:\deepseek\omniharness`，`main` 工作树（含未提交前端改动）。
> 口径：只写**本机可复核**的代码位置、命令与数字；估算值明确标「估算」。
> 2026-10-23 晚已完成 P0/P1/P2 与 §8.3 的 4 项结构性优化（见 §8）。

---

## 0. 结论（先看这 10 条）

| #   | 事项                                                       | 证据（本机）                                                                      | 收益                                      | 优先级 |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------- | ------ |
| 1   | 检查点快照把二进制按 UTF-8 读写，回滚会**损坏文件**        | 实测 4 个非 UTF-8 字节回滚后变成 `EF BF BD`×4；16B 内容变 24B                     | 数据完整性；避免设计/图片任务回滚即毁文件 | **P0** |
| 2   | 检查点快照无单文件/总量上限、无保留策略                    | `.omni-checkpoints` 本机 **507.9 MB**，单文件 **161.3 MB**；全量 `JSON.stringify` | 内存峰值、磁盘占用                        | **P0** |
| 3   | `run_code` 失败原因被投影层丢弃                            | 真实会话 27 次失败中 **9 次 error 为空**；投影实际输出「工具执行失败: 未知错误」  | 准确率 + 减少无效重试（成本）             | **P0** |
| 4   | 仓库索引单份 **258.8 MB 堆**，缓存上限 4 条                | 全仓 2032 文件/32,240 符号；`src/` 单份 141.2 MB（含 artifacts）                  | 内存（最大头）；4 条推算约 1.0 GB         | **P1** |
| 5   | `repo-map` 默认 `fileK=20`，召回率仅 36.6%                 | 191 条查询：K20 36.6% / K30 43.5% / K40 46.6%                                     | 准确率 +6.9～10.0pp，token 仅 +9.5%～17%  | **P1** |
| 6   | 推理 token 约占输出 **59%**，但没有按任务/角色分层         | 340,640 推理字符 vs 191,793 completion（chars/3 估算）；鹈鹕会话约 73%            | 成本 + 延迟（输出占成本 44%）             | **P1** |
| 7   | 默认没有 token/成本/输出硬预算                             | `turnTokenBudget=0`、`costBudgetUsd` 未设不构造、`maxOutputTokens` 仅 env         | 失控回合的最后一道刹车                    | **P1** |
| 8   | 会话内存日志仍持有附件 base64；SSE 重放只按条数不按字节    | 附件外置只改**落盘副本**；`SSE_HISTORY_MAX=256` 无字节上限                        | 内存（截图型会话）；最坏情况可达数百 MB   | **P1** |
| 9   | `grep` 内联 `(?i)`、沙箱拒绝、路径 ENOENT 的错误不够可行动 | 真实失败：grep 3 次、sandbox 2 次、ENOENT 2 次（`list_dir` 1 / `read_file` 1）    | 准确率 + 减少重试                         | **P2** |
| 10  | `read_file` 可返回 512 KiB，但外溢后只给 **2 KiB** 预览    | `FileLineWindow.MAX_WINDOW_BYTES=512 KiB`；spill 16 KiB/2 KiB                     | 准确率（读代码时可能看不到关键段）        | **P2** |

> **实施状态（2026-10-23 晚）**：上表 1–10 已全部落地（含判据），详见 §8「实施记录」；
> §8.3 的 4 项结构性优化（token-id 压缩、前缀增量、stat 预筛、CI 资源池）也已收口。

---

## 1. 现状基线

### 1.1 规模与工程约束

- `src/**/*.ts` **1162 文件 / 5.68 MB**（`Get-ChildItem` 统计），测试与前端独立。
- 门禁仍是同类项目里的强项：`scripts/runGates.mjs` 快层 + typed 层、`arch:gate --strict`、`check`、`lint`、`audit:config-wiring`、`api:check` 等。
- 事件流单源 + 追加落盘 + 审计哈希链 + 检查点回滚，是「可复盘」的底座；本轮不建议重写。
- 前端已迁移 Vite + React 19；`web:test` 用真 Chrome 判据，`fileParallelism:false`。

### 1.2 本机真实会话基线（`node tools/sessionTelemetry.mjs`）

| 指标       | 数值                          | 说明                         |
| ---------- | ----------------------------- | ---------------------------- |
| 会话       | 258（真实 20 / mock 238）     | mock 默认不出现在列表        |
| 模型调用   | 232                           | 工具调用 443                 |
| prompt     | 6,602,115                     | 其中缓存 5,742,592（87%）    |
| completion | 191,793                       | 输出是成本大头               |
| 估算成本   | **$0.52**                     | deepseek-flash 公开单价      |
| 工具失败   | 27 / 443（**6.1%**）          | 9 次为 `run_code` 空错误     |
| 冗余结果   | 137（历史 3 个 pre-fix 会话） | 结果指纹守卫已上线           |
| 存档体积   | 1.91 MiB（附件已外置）        | 6.28 MiB 会话已降到 0.37 MiB |

两个结构性事实：

1. **缓存命中率已经很高（87%）**，继续从「输入 token」抠钱的边际收益小；输出/推理与失败重试才是主战场。
2. **工具失败 6.1%**，其中三分之一是「模型看不到失败原因」——这不是模型能力问题，是投影/错误通道问题。

### 1.3 强项（不要为了优化而推翻）

- 事件日志 + 追加落盘 + 回卷对齐：长会话/崩溃恢复的可复盘底座。
- 工具暴露 `plan` 默认 + `tool_search` 找回 + 延迟清单：schema token 实测 6,167 → 1,325–1,964（省 68–78%）。
- 结果指纹级冗余检测、压缩摘要确定性工具台账、前缀稳定排序。
- 角色化模型路由、`TokenEstimatorCalibrator`、`ContextImageBudget` 等已接线。
- `ContextAssembler` 增量投影、`EventPersister` 追加写、语义缓存/语料缓存均有界（但「有界」不等于「省内存」，见 M1）。

---

## 2. 内存：先修「单份就很大」的三处

### M1. 仓库语料索引：单份 258.8 MB，缓存 4 条

**现象与证据**

- 生产路径 `RepoMapContextEngine` 默认启用（`OMNI_REPO_MAP != '0'`，`src/core/agent.ts#L577`），首次组装上下文即建索引。
- 本机实测（`node --expose-gc`，`ContextEngine.indexCorpus('.', {light:true, artifactSink})`）：

| 语料                   | 文件  | 符号   | 建索引 | 堆增量       | RSS      |
| ---------------------- | ----- | ------ | ------ | ------------ | -------- |
| 仓库根（含 tests/web） | 2,032 | 32,240 | ~5.0 s | **258.8 MB** | 367.8 MB |
| `src/`                 | 1,163 | 14,682 | ~2.4 s | **141.2 MB** | —        |
| `src/`（无 artifacts） | 1,163 | 14,682 | —      | 119.8 MB     | —        |

- 其中 `Bm25Index.documents`（全部文档的 token 字符串数组）占 **53.3 MB**（`src/` 实测：119.7 → 66.4 MB）；`CorpusFileArtifact` 又保存一份 `fileDoc`/`symbolDocs`（`src/context/corpusFileArtifact.ts#L19-L26`）。
- `CorpusIndexCache` 的 `DEFAULT_MAX_ENTRIES = 4`（`src/context/corpusIndexCache.ts#L52`），按条数淘汰，没有字节预算/空闲淘汰。按本机条目大小推算，4 条全仓索引约 **1.0 GB 堆**；语料上限 32 MB（`src/context/corpusWalker.ts#L91`）时更差。

**影响**

- 单工作区首次交互固定 2.4–5.0 s 延迟 + 259 MB 常驻；多工作区/切换项目会叠加。
- 对「生产部署端口是多少」这类不需要代码地图的问题也照建不误。
- 这是当前项目**最大的可优化内存项**，优先级高于事件日志。

**建议**

1. **短期（低风险）**：`maxEntries` 4→1（或 2）；增加 `maxTotalBytes`（如 256 MB）按估算大小淘汰；空闲 5–10 分钟释放；`serve` 打印当前索引占用。
2. **中期（结构性）**：
   - `Bm25Index` 用 token id + `Int32Array` 存 postings，`documents` 在 build 后释放/改为按需重建；
   - `CorpusFileArtifact` 不再保存完整 token 数组（只留 hash + 符号元数据，变更文件重分词）；
   - 预计可把单份索引压到 60–90 MB（−50%～−65%），召回不变。
3. **策略**：对纯问答/非代码任务延迟建索引（复用 `TaskComplexityClassifier` 或扩展 `shouldBuildRepoMap`），首次需要代码上下文时再建。

**验收**

- 单测/脚本：同一语料索引后 `heapUsed` 增量有上限；插入 2 个工作区后按字节淘汰；空闲 TTL 后条目释放。
- 回归：`probe:recall` 的 core@K14 不低于基线容差；`npm run perf:context` 不劣化。

> 诚实边界：259 MB 是 Node 堆增量，RSS 367.8 MB；不同仓库大小/文件类型差异很大，不能外推到所有项目。缓存上限 4 是代码事实，1.0 GB 是按本机条目推算的**上界示意**。

---

### M2. 检查点快照：二进制损坏 + 无上限 + 无保留

**现象与证据**

- `GitWorkspaceSnapshot.entryFor` 对所有 dirty 文件 `readFile(..., 'utf8')`（`src/adapters/workspace/gitWorkspaceSnapshot.ts#L99`），`restore` 以 `writeFile(..., 'utf8')` 写回（`#L135`）。
- `SnapshotFileIo.writeSnapshotFile` 对整份快照 `JSON.stringify`（`src/core/snapshotFileIo.ts#L18`），没有单文件/总量上限；`capture` 把所有条目内容同时留在内存。
- `CheckpointManager` 没有保留/清理策略（`src/core/checkpointManager.ts#L108` 起）；显式 `checkpoint` 工具与 UI 检查点使用 `GitWorkspaceSnapshot`（`src/config/configToolRegistry.ts#L385`、`src/server/services/session/sessionCheckpoints.ts#L81`）。自动检查点（每 20 步）是纯事件检查点，不带文件快照（`src/core/agent.ts#L118`），所以磁盘大头来自显式/UI 检查点。
- 本机 `.omni-checkpoints` **507.9 MB**；最大单文件 **161.3 MB**（`sess_muw0wyr3_m/cp1.files.json`）。

**二进制损坏实测（本机，使用真实 `GitWorkspaceSnapshot`）**

- 原文件 12 字节：`00 01 02 FF FE 00 80 C8 0A 0D 00 07`；修改后 16 字节。
- 捕获、再 restore：得到 24 字节，4 个非 UTF-8 字节（`FF FE 80 C8`）变成 `EF BF BD`×4（U+FFFD）。
- 结论：**含非 UTF-8 字节的文件（PNG/PDF/压缩包/二进制资源）一旦进入检查点并回滚，字节被替换，文件损坏**。现有测试只覆盖文本（`tests/unit/checkpointFileRollback.test.ts`）。

**影响**

- 数据完整性（P0）：用户回滚代码时可能同时毁掉图片/资源文件。
- 内存（P0/P1）：161 MB 快照的 capture/restore 峰值可达数百 MB（字符串 + JSON + 对象图）。
- 磁盘（P1）：无保留策略，长期运行会持续增长。

**建议**

1. **二进制安全**：捕获时做 NUL 嗅探（前 8 KiB）或按扩展名识别二进制，使用 base64/二进制分块存储；restore 按原编码写回；文本与二进制分流。若暂不做二进制支持，至少**跳过并显式标记**，不能静默损坏。
2. **上限**：单文件上限（如 2 MB）+ 单快照总量上限（如 32 MB）；超限跳过并标记 `truncated/skipped`，不静默截断。
3. **流式落盘**：按文件写 NDJSON/分块，避免把整份快照和 `JSON.stringify` 结果同时留在内存。
4. **保留**：每会话保留最近 N 个（如 10）或总量上限（如 256 MB），淘汰最旧；增加 `checkpoint:sweep` 命令；启动时清理超龄。
5. **判据**：二进制 round-trip 逐字节相等；超限快照不产生超大文件；保留策略测试；峰值内存测试。

> 诚实边界：本机 161 MB 文件来自用户工作区的大文件；不是所有项目都会触发。但「按 UTF-8 读写二进制」是代码事实，与文件大小无关。

---

### M3. 会话事件日志仍持有附件 base64；SSE 重放只按条数

**现象与证据**

- `AppendOnlyEventLog` 持有全量事件（`src/core/appendOnlyEventLog.ts#L8`），`SessionRecorder.allEvents()` 每次返回浅拷贝（`src/core/sessionRecorder.ts#L217`）。
- `SessionAttachmentSpiller` 只在 `JsonlStorage.save/append` 时把大附件移到磁盘，**内存里的 recorder 事件仍是 base64**（`src/context/contextAssembler.ts#L368-L388` 只在投影时按路径水合）。
- `ContextImageBudget` 只裁剪**发给模型**的投影（`src/context/contextImageBudget.ts#L14`），不裁剪事件日志。
- `SseFanout` 重放历史上限 256 条（`src/server/transport/sseFanout.ts#L6`），帧里是完整 `thread.event` JSON（`#L78`），没有字节上限。

**影响**

- 截图/图片型会话：每张 `view_image` 上限 5 MiB（base64 约 6.7 MiB），10 张即 ~67 MB；50 张 ~335 MB（估算）。这些字节同时存在于事件日志、SSE 帧、可能的 UI 内存中。
- 256 条 × 单帧 6.7 MB 的最坏情况是 ~1.7 GB（理论值，不代表典型）；按单张上限估算 7 张约 47 MB，鹈鹕实际 7 张合计 6.2 MB，典型值小得多，但**上限没有被约束**。
- 磁盘已外置，但**内存没有**；长会话截图越多越明显。

**建议**

1. 落盘外置成功后，把内存事件的 `files[].data` 也替换为 `{path,...}`；UI/RPC 需要时按需水合（已有 `hydrateAttachment` 基础）。
2. 或者给每个会话设「内存附件预算」（如 8 MB），超出部分只留路径；与 `ContextImageBudget` 分离。
3. `SseFanout` 增加 `SSE_HISTORY_MAX_BYTES`（如 8 MB），超限丢最旧；对图片事件可只推元数据/URL。
4. 判据：100 张 5 MB 附件的会话，进程堆不随张数线性增长；断线重放仍能拿到最近事件；UI 图片仍可显示。

---

### M4. `FileSpill` / `MemorySpill` 的上限不完整

- `FileSpill` 只限制文件数 512（`src/adapters/spill/fileSpill.ts#L11`），没有总字节上限；单次 shell 输出可能是几十 MB，512 个文件可占数 GB。
- `MemorySpill` 是 `Map<string,string>`（`src/adapters/spill/memorySpill.ts#L13`），没有 LRU/上限；用户选 `spillAdapter='memory'` 时随会话单调增长。

**建议**：两者都加总字节预算（如 64 MB/32 MB）+ LRU；`MemorySpill` 超限淘汰最旧；判据覆盖「写入超过预算后总量有界」。

---

### M5. 每步前缀复用测量会序列化全量上下文

- `StepContextBuilder.measurePrefixReuse` 每步 `messages.map(serializeMessage).join(',')`（`src/core/stepContextBuilder.ts#L285`），并把完整字符串留在 `lastSerialized`；只为产出 `prefixReuse` 遥测。
- 对 2.5 MB 上下文，每步多一次 2.5 MB 字符串分配 + 比较，GC 压力与 CPU 都是白付；且与「省内存」方向相反。

**建议**：默认关闭（`OMNI_PREFIX_METRICS=1` 才开），或改为增量哈希/只比较新增尾部；保留 `PrefixStability` 的单测。判据：关闭时 `prefixReuse` 显示「未采集」而不是假 0；开启时与旧值一致。

---

### M6. 语料内容签名每 30 秒整仓读盘（CPU/IO，不是常驻内存）

- `CorpusIndexCache.contentHashes` 在 TTL 到期时对**全部文件** `readFileSync` + SHA-1（`src/context/corpusIndexCache.ts#L310-L329`），默认 TTL 30 s（`#L54`）。
- 本仓 2032 文件/约 20 MB，每 30 秒读一遍；大仓（32 MB 上限）更明显。
- 写类工具已经会 `invalidate`（软失效），TTL 只是外部编辑的兜底。

**建议**：混合签名——先 `stat`（mtimeMs+size+ino）比对，未变则复用上次 hash，变了才读文件；TTL 可放宽到 2–5 分钟。判据：内容真变仍能检出（touch 不算变）；读盘次数下降。

---

### M7. 事件日志 `all()` 的浅拷贝与投影缓存

- `AppendOnlyEventLog.all()` 每次 `[...this.events]`（`src/core/appendOnlyEventLog.ts#L154`）；`SessionRecorder.allEvents()`、`ProvenanceTracker.fromEvents`、`deriveQueryText`、`restoreCompactionState` 等每步多次调用。
- `ContextAssembler` 的投影缓存又保存一份 `events` 引用数组和 `messages` 数组（`src/context/contextAssembler.ts#L133-L141`）。
- 单条数组元素是指针，10k 事件也只是 ~80 KB/次；不是主因，但每步多次浅拷贝会制造 GC 噪声。

**建议**：提供只读视图/版本号（调用方不得修改），或让 `allEvents()` 返回 `readonly` 的稳定快照；`ContextAssembler` 缓存只存 `events.length` + 前缀指纹，不存整个数组。优先级 P3。

---

## 3. 成本：推理预算是第一杠杆，预算是第二道闸

### C1. 推理 token 占输出约 59%，但没有按任务/角色分层

**证据**

- 232 次调用 completion 共 191,793 token；事件里的 reasoning 文本 340,640 字符，assistant 文本 47,642 字符。按 chars/3 粗估，reasoning ≈ 113.5k token，**约占 completion 的 59%**（估算；不同模型 tokenizer 不同）。
- 鹈鹕会话 `sess_mvf6q61y_e`：completion 92,529，reasoning 201,668 字符，assistant 仅 712 字符，reasoning 占比约 **73%**（粗估）。
- 代码把 `runtime.config.reasoning` 原样传给每一步（`src/core/agent.ts#L572`、`src/core/stepRunner.ts#L188`）；压缩、记忆、目标、guardian、reviewer 也共用同一档（`src/context/contextCompactor.ts#L658`、`src/adapters/memory/memoryExtractor.ts#L177`、`src/autonomy/goalChecker.ts#L60`、`src/adapters/approval/guardianApproval.ts#L80`、`src/adapters/tool/verify/reviewDiffTool.ts#L94`）。
- `TaskComplexityClassifier` 已在回合开始计算复杂度（`src/core/agent.ts#L293-L298`），但没有用于推理预算。

**建议**

1. **按任务复杂度分层**：简单问答/单步任务 `low`/`none`；复杂任务保持 `high`；在 `TaskComplexityClassifier` 旁增加 `reasoningBudgetFor(complexity)`，先 shadow 记录「若降档会省多少」，不直接改默认。
2. **按角色分层**：`compactor`/`memory`/`guardian`/`goal` 用 `none`/`low`，并给 `maxOutputTokens`（如 512–2048）；`reviewer` 用 `low`/`medium`；`planner` 可高。
3. **A/B 验收**：用 `tools/eval/harnessAb.mjs`（已有 manifest/paired Δ）跑 k≥3 的真实任务；只有任务成功率不降、成本下降才翻默认。
4. **可观测**：`ModelUsage` 增加 `reasoningTokens`（若端点上报），否则至少记录 reasoning 字符数，让「省了多少」可复核。

**预期**：推理占输出 59%，若简单任务/辅助角色降档覆盖 30–40% 的调用，总成本可降 10–20%（估算，需 A/B）。

---

### C2. 默认没有 token/成本/输出预算

**证据**

- `turnTokenBudget` 默认 0（`src/core/turnRunner.ts#L166` 只在 >0 时生效）；`OMNI_TURN_TOKEN_BUDGET`/`--turn-token-budget` 可设，但默认关。
- `costBudgetUsd` 未设/≤0 时不构造 `CostBudget`（`src/config/configFactory.ts#L417-L435`）；`budget_status` 工具也只在配置后注册。
- `maxOutputTokens` 只从 env `OMNI_MAX_OUTPUT_TOKENS` 读（`src/core/agentLimits.ts#L12`），默认不下发。
- 默认只有 30 min 软提醒 + 8 h 硬熔断（`src/core/agent.ts#L46-L52`）；「一直在做新事情」的回合没有 token 刹车。

**建议**

1. 增加**软 token 预算**：到 80% 注入「开始收尾」nudge（类似 LoopGuard 的软时限），到 100% 才硬停；默认给一个宽松值（如 5M/回合）并可关闭，避免直接改变长任务行为。
2. `budget_status` 默认注册（无预算时显示 `unlimited` + 当前用量），让用户/模型看得见消耗；成本预算仍由用户显式设。
3. 辅助角色一律带 `maxOutputTokens`；executor 的输出上限要谨慎（写大文件需要数万 token），建议按工具/任务分层，或只在「无工具文本回复」时限制。
4. 判据：软预算触发只 nudge 不中断；硬预算中断有明确文案；预算关闭时零行为变更。

---

### C3. 失败重试是可见的成本项

- 443 次工具调用 27 次失败（6.1%）；9 次 `run_code` 失败模型只看到「未知错误」，极可能重试（见 A1）。
- grep 内联 `(?i)` 3 次失败；模型重复同一写法，说明错误信息没有给出可行动的修正。
- 每次失败都至少多一次模型调用（输入缓存可能仍命中，但输出/推理是新 token）。

**建议**：先修 A1/A6 的错误通道；把「同类失败重试次数」纳入遥测（`sessionTelemetry` 已能聚合失败，可加「同一工具+同一错误指纹的连续次数」）。

---

### C4. 工具 schema 与 `tool_search` 的缓存代价

- `ToolExposurePlanner` 默认 `plan`（`src/core/toolExposurePlanner.ts#L399-L403`），实测 schema 6,167 → 1,325–1,964 token（省 68–78%），这是真实的上下文/注意力收益。
- 但 87% 的 prompt 已命中缓存，schema token 的**美元成本**没有 68% 那么夸张；不要把它当主要省钱项。
- `tool_search` 改变工具表会让前缀缓存整体失效（历史实测 cachedPromptTokens 51,200 → 3,712）；当前用「延迟工具清单」鼓励第一步搜索，方向正确。

**建议**：保留 plan 默认；若继续优化，优先「首次就给出正确工具」而不是「更多隐藏」；不要把 schema 排序/集合做成每步变化。

---

### C5. `repo-map` 的 token 与 `fileK`

- 默认 `fileK=20`（`src/context/repoMap/repoMapContextEngine.ts#L101`），`payloadShape='tiered'` 已把 token 压到约 914/请求（5 条代表性查询平均）。
- 提到 30/40 只增加约 87/156 token（+9.5%/+17%），但召回 +6.9/+10.0pp（见 A2）。这是本轮**性价比最高的准确率改动**。

---

## 4. 准确率：先修「模型看不到真相」，再修检索

### A1. `run_code` 失败原因被丢弃（P0）

**链路（本机代码复核）**

1. `CodeInterpreter` 失败时把原因放 `output`（`src/adapters/tool/code/codeInterpreter.ts#L76-L110`）。
2. `CodeExecutorTool.handle` 返回 `{callId, ok: result.ok, output: result.output}`，**没有 `error`**（`src/adapters/tool/code/codeExecutorTool.ts#L77`）。
3. `ContextAssembler.toolContentOf` 对 `ok=false` **只读 `error`**（`src/context/contextAssembler.ts#L432-L437`），于是模型看到 `工具执行失败: 未知错误`。

**实测**

```js
// dist 上的最小复现
const ev = {
  type: 'tool_result',
  payload: { callId: 'c1', ok: false, output: 'ReferenceError: fs is not defined...' },
};
new ContextAssembler().build([ev]); // → content: "工具执行失败: 未知错误"
```

真实会话聚合：27 次失败中 **9 次 `run_code` 的 error 为空**；这 9 次模型都拿不到原因。

**修复**

- `CodeExecutorTool`：`ok=false` 时把 `result.output` 放到 `error`（保留 output 也可以）。
- `ContextAssembler.toolContentOf`：失败时 `error ?? output ?? '未知错误'`（防御其他工具的同型问题）。
- 测试：`tool_result{ok:false, output:'boom'}` 投影后必须包含 `boom`；`contextIntegrityFixes.test.ts` 现有「error 必须保留」的用例保留，并新增「无 error 时用 output」。
- 判据：真实失败回放中 9 条都能看到原因；不改变成功路径。

最小改动示意（两处都做，互为兜底）：

```ts
// src/adapters/tool/code/codeExecutorTool.ts:70-78
return result.ok
  ? { callId: call.id, ok: true, output: result.output }
  : { callId: call.id, ok: false, error: result.output || 'run_code 执行失败' };

// src/context/contextAssembler.ts:432-438
const detail = payload.error ?? payload.output ?? '未知错误';
return `工具执行失败: ${detail}`;
```

---

### A2. 检索召回：K20 只有 36.6%，K30/40 几乎免费

**本机实测**（`node tools/probes/recallHitrate.mjs --fileK=N`，语料 `src/` 1163 文件/14,682 符号，191 条冻结查询）：

| fileK | all   | core  | ext   | repo-map 平均 token（5 条查询） |
| ----- | ----- | ----- | ----- | ------------------------------- |
| 14    | 31.4% | 53.1% | 27.0% | —                               |
| 20    | 36.6% | 65.6% | 30.8% | 914                             |
| 30    | 43.5% | 71.9% | 37.7% | 1,001                           |
| 40    | 46.6% | 71.9% | 41.5% | 1,070                           |

- K20→K30：all **+6.9pp**，token **+9.5%**；K20→K40：all **+10.0pp**，token **+17%**。
- `payloadShape='tiered'` 是这笔交易成立的前提：尾部文件只多一行路径，几乎不增加 token。
- 核心 32 条在 K14 为 53.1%，低于 2026-10-03 基线 56.3%（仍在新容差 ±3 条内）；说明语料增长后检索没有同步变好，K 提升是直接补偿。

**建议**

1. 把 `DEFAULT_FILE_K` 20→30（或 40）作为候选；用配对 bootstrap/McNemar 跑 191 条查询的**配对 Δ**，确认 CI 下界 > 0（当前 probe 的逐档 CI 有重叠，不能直接当显著）。
2. token 增量按**真实 assembly** 再测一次（本表只算了 repo-map 文本，不含工具 schema/系统提示）。
3. 若 A/B 任务成功率不降，翻默认；更新 `docs/ARCHITECTURE_SPEC`/probe 默认值。
4. 不要同时开 `rerank` 作为默认：本机 K14 精排 30.4% vs 31.4%（略降），K20 未复测；精排的收益在更深的池子，但当前证据不支持翻默认。

> 诚实边界：191 条是英文自然语言查询，其中 159 条是扩展集，不能代表所有用户任务；召回率是「目标文件是否进 Top-K」，不是最终任务成功率。翻默认前必须做任务级 A/B。

---

### A3. 检查点二进制损坏（P0，数据完整性）

见 M2。这里只强调准确率维度：**回滚后文件字节变了**，用户会以为「代码回到了检查点」，实际资源文件已损坏。这是比「检索少一个文件」更严重的正确性问题。

建议优先级：先做「检测到二进制就跳过并标记」，再做 base64/分块支持；不要在未处理二进制前继续把检查点宣传成「代码+对话一起回滚」。

---

### A4. 压缩后的任务保持率没有端到端判据

**现状**

- `ContextCompactor` 的 8 段摘要模板 + 确定性工具台账 + pinned system 消息，设计是合理的（`src/context/contextCompactor.ts#L95-L105`、`#L421`、`#L510`）。
- 但看板/长会话报告自己承认：压缩仍是单次摘要为主，缺「压缩后任务保持率」的端到端数字；本轮也没有找到 `compactionRetention` 一类探针。
- `summarize` 调用没有 `maxOutputTokens`（`src/context/contextCompactor.ts#L651-L664`），摘要模型可以生成很长输出。

**建议**

1. 新增离线探针 `tools/probes/compactionRetention.mjs`：构造含「文件路径/命令/错误/下一步」针脚的长历史，压缩后检查摘要+台账是否保留这些针脚（确定性部分）；需要真实模型时再用 `eval:harness` 做任务级 A/B。
2. 给摘要调用加 `maxOutputTokens`（如 2,000–4,000）并在超限时截断/重试；摘要模板已要求 8 节，长输出没有收益。
3. 判据：针脚召回率（确定性台账 100%）；压缩后 3 步内不重复已执行工具（可用 LoopGuard 遥测）。

---

### A5. 自动 reviewer 只看 diff + goal，不看测试结果

- `TurnRunner` 在完成声明时调用 `reviewer.review({diff, goal})`（`src/core/turnRunner.ts#L368-L420`），没有把本回合的验证/测试输出传进去；`ReviewDiffTool` 的 `tests` 参数是给手动 `review_diff` 工具用的（`src/adapters/tool/verify/reviewDiffTool.ts#L55-L63`）。
- 结果是 reviewer 无法判断「diff 看起来对，但测试挂了」。

**建议**：把本回合最近一次 shell/测试的结论（命令、退出码、失败摘要）作为 `tests` 传入 reviewer；仍保持 advisory 默认，避免误杀。判据：reviewer 输入包含测试结果；对「测试失败但 diff 干净」的样本能报出 blocker/major。

---

### A6. 工具错误信息的可行动性

| 现象（真实失败）              | 次数 | 现有信息                                        | 建议                                                                                                                                                                                                                                                    |
| ----------------------------- | ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grep` 用 `(?i)`              | 3    | `Invalid regular expression: ... Invalid group` | 错误里直接提示「JS 正则不支持内联 `(?i)`，请用 `case_insensitive=true`」；可在 `GrepTool` 前缀解析时归一化 `(?i)`（`src/adapters/tool/fs/grepTool.ts#L121`）                                                                                            |
| 沙箱拒绝 `node -e` / `del /q` | 2    | `命中危险命令规则: <rule>`                      | 追加「写文件用 write_file/apply_patch；删除请用专用工具/确认」；规则命中时给替代路径（`src/adapters/sandbox/policySandbox.ts#L55`）                                                                                                                     |
| `read_file`/`list_dir` ENOENT | 2    | `ENOENT ... stat/scandir 'D:\work\...'`         | `list_dir` 目前裸透传 Node 错误（`src/adapters/tool/fs/listDirTool.ts#L48-L50`）；补「当前工作区根 + 用 glob/list_dir 确认」。`read_file` 已有人话文案（`src/adapters/tool/fs/readFileTool.ts#L161-L180`），但真实会话仍有一条原始 ENOENT，需按版本复核 |
| `apply_patch` 缺 `+++`/`@@`   | 2    | 已比较清楚                                      | 可附一个最小合法模板；优先级低                                                                                                                                                                                                                          |

这些改动不改变模型能力，只把「模型已经知道的错误」变成「模型能立刻修正的错误」，直接减少重试成本。

---

### A7. `read_file` 的 512 KiB 与 2 KiB 预览不匹配（假设，需 A/B）

- `read_file` 本身允许 512 KiB 窗口（`src/adapters/tool/fs/fileLineWindow.ts#L57`），但 `ToolResultSpiller` 默认 >16 KiB 就外溢，只给 2 KiB 预览（`src/config/corePortsAssembler.ts#L95-L96`）。
- 一个 30 KiB 的源文件（约 800 行）会被压到 2 KiB（约 50 行）+ `spill://` 句柄；模型若不再 `spill_read`，就会基于片段改代码。
- 这是**假设**：模型可能确实会回读；需要真实任务 A/B。但当前阈值对代码阅读偏激进。

**建议**：按工具分层——`read_file` 内联阈值 32–48 KiB、预览 8 KiB；`shell/grep` 保持 16 KiB/2 KiB（错误优先预览）。用 `spill_read` 回读的调用次数与任务成功率做判据。

---

### A8. 工具参数只校验「必填 + 顶层类型」

- `RegistryToolPort.validate` 只检查 `required` 与顶层 `typeof`（`src/adapters/tool/registryToolPort.ts#L111-L128`），不校验 enum/范围/嵌套；`ToolArgumentParser` 遇到非法 JSON 回退 `{}`（`src/adapters/model/toolArgumentParser.ts#L16-L29`），模型只会看到「缺少必填参数」。
- 影响有限（工具内部还会校验），但错误信息可以更准确：非法 JSON 时提示「参数 JSON 解析失败」并附前 200 字符，而不是伪装成缺参。

**建议**：低优先；在 `ToolArgumentParser` 返回结构化错误，或让 `RegistryToolPort` 区分「解析失败」与「缺参」。判据：非法 JSON 的失败文案包含 `invalid_json`。

---

## 5. 质量与工程：门禁很强，但有三处「口径/证据」债

### Q1. 文档与代码默认值漂移

- `reports/REASSESSMENT_2026-10-22.md` §2.4 写「工具暴露规划默认 `off`（`OMNI_TOOL_EXPOSURE=plan` 才开）」；代码 `modeFromEnv` **默认 `plan`**（`src/core/toolExposurePlanner.ts#L399-L403`）。
- `docs/LONG_SESSION_QUALITY_2026-10-20.md` 末尾写「时长/token/内存/存档体积四条线全部收口」；本轮的语料索引/检查点/事件日志说明「内存」仍有明显余量。
- 这类漂移会误导下一轮审计。建议：把「关键默认值」纳入 `auditStandards`/`standard-delta` 的交叉核对（已有类似机制），或至少在本轮更新这两处措辞。

### Q2. 测试确定性

- `reports/REASSESSMENT_2026-10-22.md` §1.1 记录：全量并行时 3 例「单跑绿、并行红」（pluginWorker 超时、layaWarmWorker 热进程）。这不是产品缺陷，但会侵蚀「门禁可信」。
- 建议：CI 同 commit 连跑两次，或给资源重的判据单独分池；`web:test` 已 `fileParallelism:false`，node 侧可参考。

### Q3. 缺任务级回放/失败样本集

- 现有单测很强，但 `run_code` 空错误这种「工具结果 → 模型投影」的端到端缺陷能穿过测试，因为测试只断言结果对象，不断言模型可见内容。
- 建议：从 `~/.omniharness/sessions` 抽 10–20 条真实失败轨迹（脱敏）做回放夹具，断言「模型可见的 tool 消息包含失败原因/读回句柄/下一步提示」。这比再加一个引擎更有价值。

### Q4. 缓存/预算缺「字节」维度的判据

- 看板 §51 说「热点 Map 均有界」；但语料缓存是**按条数**有界（4 条），单条 259 MB；检查点/SSE/FileSpill 也没有字节上限。
- 建议：把「按字节/按内存」纳入缓存审计，新增判据：任何缓存必须有 `maxEntries` **且** `maxBytes`（或明确的「单条有硬上限」论证）。

---

## 6. 路线图（按影响/风险排序）

### P0：数据完整性与「模型看不到真相」（建议先做）

1. **检查点二进制安全**：NUL 嗅探/扩展名分流；二进制用 base64 或跳过并标记；round-trip 测试。
2. **检查点上限与保留**：单文件/单快照上限；每会话保留 N 个/总量上限；`checkpoint:sweep`。
3. **`run_code` 错误透传**：`CodeExecutorTool` + `ContextAssembler` 双保险；投影级测试。
4. **失败回放夹具**：把 9 条空错误会话做成脱敏夹具，防回归。

### P1：内存与准确率的主杠杆

5. **语料缓存字节预算**：`maxEntries` 4→1/2 + `maxBytes` + 空闲淘汰；先观测再翻默认。
6. **`fileK` 20→30/40**：先跑配对 Δ + 任务级 A/B；token 增量 <200/请求可接受。
7. **推理/输出预算分层**：复杂度 + 角色；辅助调用 `maxOutputTokens`；A/B 后翻默认。
8. **SSE 字节上限 + 事件日志附件外置到内存**：先做 SSE（低风险），再做事件日志（需 UI 水合）。
9. **压缩保持率探针 + 摘要输出上限**：确定性针脚 + 任务级 A/B。

### P2：体验与长期结构

10. **工具错误可行动化**：grep `(?i)`、sandbox 替代路径、ENOENT 带工作区根。
11. **`read_file` 外溢阈值分层**：32–48 KiB/8 KiB 预览，A/B 验证。
12. **语料索引 compact（token id/typed array）**：结构性降内存 50%+。
13. **FileSpill/MemorySpill 字节上限**；**前缀遥测默认关**；**内容签名 stat 混合**。
14. **文档漂移/测试确定性**：更新两处措辞；CI 双跑或分池。

---

## 7. 不建议做（避免为了「优化」引入更大风险）

1. **默认开语义嵌入**：本机 e5-small 也要额外模型内存/启动时间，且历史实验的增益不足以翻默认；先用 `OMNI_SEMANTIC_RECALL=1` 做 A/B。
2. **降低压缩阈值**：会回到「压缩→失忆→重新探索」的旧病灶；当前 0.8×窗口是有依据的。
3. **从历史消息里删推理文本**：DeepSeek 思考模式要求回传，且删改历史会打断 prompt 前缀缓存；省不了多少钱。
4. **为了省 token 把工具 schema 做成每步动态**：会反复打断缓存，净成本可能更高。
5. **重写事件日志为纯流式/外部数据库**：收益不确定，风险极高；先做字节预算和懒水合。
6. **引入向量库/图数据库**：当前依赖面克制是资产；没有证据表明它比「BM25 + 更好的文件表示」更划算。

---

## 8. 实施记录（2026-10-23 晚）

### 8.1 已落地

| 项                | 改动                                                                                                                                                 | 判据                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P0 检查点二进制   | `FileSnapshotEntry` 增加 `encoding:'base64'`/`skipped`；`GitWorkspaceSnapshot` 用「UTF-8 往返逐字节相等」判定文本，否则 base64；`restore` 按编码写回 | `checkpointFileRollback.test.ts` 二进制逐字节相等；skipped 保留现场                |
| P0 检查点上限     | 单文件 2 MiB、单快照 32 MiB（超限标 skipped，不静默截断）                                                                                            | 新增 too-large 用例；超限条目 restore 不删除                                       |
| P0 检查点保留     | `CheckpointManager` 每会话保留 20 个/256 MiB 文件快照，删最旧；`scripts/checkpointSweep.mjs` + `npm run checkpoint:sweep`（默认 dry-run，14 天阈值） | 保留策略用例；本机 dry-run 扫到 228 个/197.2 MiB 可清理                            |
| P0 run_code 错误  | `CodeExecutorTool` 失败时 `error=output`；`ContextAssembler` 兜底 `error ?? output`                                                                  | `contextAssembler` 新增「只有 output」用例；`codeMode` 新增失败原因断言            |
| P1 语料缓存       | `maxEntries` 4→2；新增 `maxBytes`（256 MiB）与 `idleMs`（10 分钟）淘汰；`estimatedBytes`/`bytesInUse`                                                | `corpusIndexByteBudget.test.ts` 3 例（字节淘汰/空闲/条数）                         |
| P1 fileK          | 默认 20→**30**；191 条查询配对 McNemar：K20→K30 13 胜 0 负 p=0.0002；K30→K40 p=0.0625 未过                                                           | `probe:recall` 默认 30；`repoMapContext.test` 20 例                                |
| P1 推理预算       | 新增 `ReasoningBudget`：executor 简单 `low`/复杂 `high`，辅助角色压到 `low`；`OMNI_REASONING_POLICY=off` 回退                                        | `reasoningBudget.test.ts` 5 例；compactor/goal/guardian/memory/reviewer 请求带档位 |
| P1 输出上限       | 压缩摘要 3k、记忆 1.5k、目标/guardian 800、reviewer 4k                                                                                               | `contextCompactor` 新增请求捕获用例                                                |
| P1 软 token 预算  | `TurnRunner` 达软预算只提醒收尾、不截断；默认 5M（硬预算存在时取 80%）；`OMNI_TURN_SOFT_TOKEN_BUDGET` 可调                                           | `turnRunnerFinalize` 新增「提醒但不截断」用例                                      |
| P1 SSE 内存       | `SseFanout` 历史增加 8 MiB 字节上限；单帧超预算不入历史但照常广播                                                                                    | `sseReconnect` 新增字节上限用例                                                    |
| P1 事件日志附件   | 新增 `AttachmentSpillPort`；`StepToolExecutor` 记录前把 >64K 字符附件写盘，事件只留 path；模型按 path 水合；子代用自己的 sessions 根                 | `sessionAttachmentSpill` 新增内存外置用例                                          |
| P2 工具错误       | grep 开头 `(?i)` 归一化 + 内联修饰符提示；list_dir ENOENT 带工作区根；sandbox 规则附替代路径                                                         | `searchTools` 新增 2 例                                                            |
| P2 read_file 外溢 | 按工具策略：read_file 48 KiB 内联/8 KiB 预览，shell 仍 16 KiB/2 KiB                                                                                  | `spill.test` 新增按工具策略用例                                                    |
| P2 spill 字节上限 | FileSpill 64 MiB + MemorySpill 64 MiB（LRU/至少保留最新一份）                                                                                        | `spill.test` 新增 2 例；原失败分支用例保持绿                                       |
| P2 文档           | 本报告与 `repoMapContextOptions` 注释同步；`checkpoint:sweep` 入口写入 package.json                                                                  | `format:check` / `check:doc-links`                                                 |

### 8.2 本机验证

- `npx tsc --noEmit` ✅
- `npm run check` ✅（函数体白名单未增长；`configFactory.build` 99 = 基线 99）
- `npm run arch:gate -- --strict` ✅（依赖方向 0、端口纯度 0、新增环 0）
- `npm run lint` ✅
- `npm run format:check` ✅
- 定点测试：checkpoint 7、corpus 3、reasoning 5、compactor 22、codeMode 7、spill 21、sse 5、attachment 3、turnRunner 5 全绿
- 结构性定点：bm25 13、corpusIncremental 6、prefix 9、stat 2、heavyPool 2 + sandbox 9 全绿
- 全量单测：`npm run test:fast` → **619 files passed / 1 skipped，3,794 tests passed / 7 skipped**（2026-10-23 22:40 冻结工作树复跑）
- `npm run build` ✅（tsc → dist.next + 资源镜像 + 原子换入）
- `node tools/probes/recallHitrate.mjs`（默认 30）→ all **44.0%** / core 71.9% / ext 38.4%（语料 1166 文件/14,776 符号；比报告初测 43.5% 高 0.5pp，来自语料变化）
- BM25 检索性能：1000 次 5 词查询 **76.9 ms（0.077 ms/次）**，压缩后无退化
- `npm run audit:config-wiring` ✅（1165 个源文件）
- `npm run test:integration`：**7/7 files、17/17 tests 全绿**（2026-10-23 22:44；heavy 资源池下 liveUiE2e 与 laya 不再互相抢资源）
- `npm run web:test`：718/720 files、4,349/4,357 tests；`chromeCleanup` 在并行负载下超时，**单跑 15.1s 通过**（同上）
- 本轮未跑真实模型小时级 A/B；`fileK`/推理档位的任务级验收仍需真实 API key

### 8.3 结构性优化（本轮已完成）

| 项                     | 改动                                                                                                                                                                                                     | 结果 / 判据                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 语料索引 token-id 压缩 | `Bm25Index.documents` 改 `Uint32Array` token id；倒排表键改 token id；单 posting 用 packed `docId*2^20+tf` 一个数组；`CorpusFileArtifact` 词项改「单串编码」（`\u0000` 分隔）                            | 全仓索引 **258.8 → 108.9 MB（−57.9%）**、`src/` **141.2 → 63.6 MB（−55.0%）**；召回 44.0% 不变；`bm25Index` 13 例 / `corpusIncremental` 6 例全绿 |
| 前缀复用测量增量       | `StepContextBuilder` 保留逐消息 JSON 片段，按片段边界算公共前缀，不再拼整串；`PrefixStability` 仍是唯一公式                                                                                              | `stepContextBuilderPrefix` / `prefixReuseSnapshot` / `prefixReuseGuard` 9 例逐位一致                                                             |
| 内容签名 stat 预筛     | `CorpusIndexCache` 加递归 `fs.watch`（过滤 `.git`/`node_modules`/dist 等），未变更时只 stat、不读内容；watcher 不可用/有事件仍走内容哈希                                                                 | `corpusIndexStatPrefilter` 2 例；Windows 上 `statReuses` 生效，Linux 自动回落                                                                    |
| CI 资源分池            | 新增 `tests/helpers/heavyResourcePool.ts`（跨进程文件锁槽）+ `tests/setup/heavyResource.ts`；重判据（pluginWorker/layaWarmWorker/sandbox/codeSandbox/liveUiE2e/laya*）默认 1 槽，`OMNI_HEAVY_SLOTS` 可调 | `heavyResourcePool` 2 例 + sandbox 9 例；CI coverage/integration env 显式 `OMNI_HEAVY_SLOTS=1`                                                   |

> 边界：108.9 MB 是 Node 堆增量（RSS 280.8 MB），来自本机全仓 2040 文件/32,461 符号；不同仓库规模不能直接外推。

---

## 附录 A：本机证据命令

```powershell
# 1) 真实会话基线
node tools/sessionTelemetry.mjs

# 2) 工具失败聚合（按工具名 + 错误指纹）
node .tmp\errs2.mjs   # 本轮临时脚本；逻辑见正文

# 3) 检索召回（src/ 1163 文件，191 条查询）
node tools/probes/recallHitrate.mjs --fileK=14
node tools/probes/recallHitrate.mjs --fileK=20
node tools/probes/recallHitrate.mjs --fileK=30
node tools/probes/recallHitrate.mjs --fileK=40

# 4) 工具暴露 schema token
node tools/probes/toolExposureBudget.mjs

# 5) 语料索引内存（临时脚本，--expose-gc）
node --expose-gc .tmp\idxmem7.mjs   # 仓库根 258.8 MB / 367.8 MB RSS
node --expose-gc .tmp\idxmem6.mjs   # src/ 141.2 MB（含 artifacts）

# 6) 检查点体积
Get-ChildItem .omni-checkpoints -Recurse -File | Measure-Object Length -Sum
Get-ChildItem .omni-checkpoints -Recurse -File | Sort-Object Length -Descending | Select-Object -First 3

# 7) 二进制损坏复现（使用真实 GitWorkspaceSnapshot）
#    见正文 M2；临时 repo 在 .tmp/snapbin（未提交）
```

## 附录 B：口径与边界

- 所有数字来自本机 2026-10-23 的 `main` 工作树；`src/` 文件数 1162/1163 随统计口径（是否含 `.d.ts`/生成物）略有差异。
- 召回率是「目标文件是否进 Top-K」，不是任务成功率；191 条查询以英文自然语言为主，ext 159 条为扩展集。
- 推理占比用 `字符数/3` 粗估，未按真实 tokenizer 复算；方向（推理是输出大头）比绝对值更可信。
- 语料索引内存是 Node 堆增量 + RSS，受 V8 GC/语料内容影响；4 条缓存约 1.0 GB 是**按本机条目大小推算**，不是所有仓库的承诺。
- 检查点 161 MB 来自本机用户工作区；二进制损坏是代码事实（UTF-8 往返），与文件大小无关。
- 本轮**没有**跑真实 API 的小时级 A/B；所有「翻默认」建议都必须先过任务级 A/B（`tools/eval/harnessAb.mjs`，k≥3）。
