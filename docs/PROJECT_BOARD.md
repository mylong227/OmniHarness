# OmniHarness 项目看板（唯一事实源）

> **本文件是仓内唯一的看板**。旧看板（`TASK_BOARD.md` / `REFACTOR_BOARD_2026-09-12.md` /
> `UPGRADE_BOARD_2026-09-12.md` / `archive/UPGRADE_BOARD_2026-09-05.md`）已于 2026-10-03 删除，
> 内容永久可查于 git 历史（`git show b49d96e^:docs/TASK_BOARD.md` 等）。
>
> **记录纪律（不可妥协）**：写入本板的每一条信息必须「本机可复核」——或附上产生它的命令/测试，
> 或标注复核日期。禁止复制未经验证的宣称；历史看板里的数字在重新实测前一律视为**待复核**。

---

## 1. 项目是什么

- **通用 Agent Harness**：TypeScript（CLI / Web 工作台 / 编排）+ Rust（原生内核）。
  包名 `@mylong227/omniharness`，版本 0.2.0，Apache-2.0，要求 Node ≥ 22.14.0。
- Rust 侧 6 个 crate：`omni-cli` / `omni-core` / `omni-napi` / `omni-sdk` / `omni-sdk-gen` / `omni-wasm`（39 个 .rs 文件）。
- Web 工作台 `web/src`：111 个 TS 文件（无第三方运行时框架，自绘 React 垫片）。
- 评测/基准设施：`evals/` 86 个文件（评测脚本 + 落盘报告）、`benchmark/`、SWE-bench 运行器（`python/` + `eval-data/`）。

### 代码规模（2026-10-03 第二轮实测；行数口径 = 各文件行数之和）

| 区域                                                      | 文件数          | 行数                  |
| --------------------------------------------------------- | --------------- | --------------------- |
| `src/` 全部（本轮实测）                                   | 908             | 91,079                |
| ~~`src/` 全部（上一轮口径，行数对不上，已由本轮值取代）~~ | ~~905~~         | ~~95,448~~            |
| —— adapters（协议/工具/存储/媒体/沙箱等适配器）           | 211             | 31,685                |
| —— ports（端口契约 + 组合接口）                           | 341             | 6,165                 |
| —— server（HTTP/WS 服务与端点）                           | 47              | 9,104                 |
| —— context（检索/压缩/仓库图/记忆注入）                   | 40              | 8,821                 |
| —— cli                                                    | 29              | 6,212                 |
| —— core（agent 循环 / 步执行 / 工具门禁 / 暴露规划）      | 24              | 5,077                 |
| —— util / config / evolution / genesis / media / 其余     | 约 216          | 约 24,000             |
| 单元测试 `tests/`                                         | 384 个 .test.ts | 全量 2,443 项断言用例 |

> 子区域行数为上一轮 905 文件口径的存量值（本轮只重测了 `src/` 合计与文件数，未逐区域重跑）；
> 「其余」一行按合计差额回填，故标「约」。所有数字均为本机可复核：文件数 =
> `(Get-ChildItem src -Recurse -File -Filter *.ts).Count`，行数 = 同名管道 + `Measure-Object -Line`。

## 2. 当前门禁状态（2026-10-03 第二轮实跑；同日先修 §3 全部 6 项 + 官方门禁性能缺陷）

| 门禁           | 命令                                   | 结果                                                                    |
| -------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| 类型（含 web） | `npm run typecheck`                    | ✅ 零错误                                                               |
| 代码规范       | `npm run lint`（--max-warnings=0）     | ✅ 0 告警                                                               |
| 铁律/体量      | `npm run check -- --strict`            | ✅ 908 文件零违规（存量白名单 13 处冻结）                               |
| 架构           | `npm run arch:gate`                    | ✅ 依赖方向 0 / ports 纯度 0 / 依赖环新增 0                             |
| 成熟度         | `npm run audit:maturity`               | ✅ 40 项声明，L2/L3 均有测试证据                                        |
| 接线完整性     | `npm run audit:config-wiring`          | ✅ 908 源文件全绿                                                       |
| 文档死链       | `npm run check:doc-links`              | ✅ 新增 0（存量基线冻结）                                               |
| 原生估算奇偶   | `npm run native:build` + 单测          | ✅ Rust `context.estimate` 与 TS 记账**逐位一致**（0 skip）             |
| 技能路由       | `npm run eval:skill-routing -- --gate` | ✅ 三关齐过：召回 92.3% / 噪声 1.50 条 / Δ +65.38pp CI95 [46.15, 84.62] |
| 全量单测       | `npm test`                             | ✅ 2,443 项：2,439 过 / **0 失败 / 0 cancelled** / 4 skip（exit 0）     |

依赖政策：`dependency-allowlist.json`（D10：必要且更优即可引入；`src/ports/**` 与 `src/core/**` 恒第三方-free），允许/拒绝许可清单见该文件。

### 2.1 修掉的一项**门禁级**性能缺陷（2026-10-03，blocking）

**现象**：`npm test` 报 `fail 0` 却 **exit 1**——`sessionLifecycle` / `workflowRunner` 两文件在并发
全量跑法下被 120s 文件级超时 cancelled（旧看板把这 2 个 cancelled 当作「并发产物」记账，实际是
性能缺陷）。单文件实测 sessionLifecycle **100.4s**。

**根因**（本机 CPU profile 实测，非推断）：`RepoMapContextEngine` 的全部价值都在进程内长寿命缓存上
（全仓语料索引，902 文件 **8.6s** 量级），而装配层在每个组合根（`ConfigFactory.build`）与**每个子代理**
里 `new` 一个实例 ⇒ ① 缓存生命期退化成「一次装配」；② 写类工具成功后走 `clear()` **硬删**，而
`shell` 里跑 `echo` / `git status` / `npm test` 并不改被索引的源码 ⇒ 单个回合把全仓索引**两遍**。

**改动**：进程级唯一引擎（`context/repoMap/repoMapEngineProvider.ts`）+ 写工具后改走
**软失效**（`CorpusIndexCache.invalidate`，先复核内容签名，未变即复用）。

| 对象                      | 修前                   | 修后           | 判据                                     |
| ------------------------- | ---------------------- | -------------- | ---------------------------------------- |
| `sessionLifecycle` 单文件 | 100.4s（贴 120s 门限） | **14.2s**      | `node --test … sessionLifecycle.test.js` |
| `workflowRunner` 单文件   | >120s（cancelled）     | **10.5s**      | 同上                                     |
| 子代理启动的索引成本      | 每子代理一次全仓索引   | 进程内复用一次 | `repoMapEngineProvider.test.ts`          |

## 3. §3 已清偿（2026-10-03 第二轮：原 6 项全部修完，各附回归判据）

> 上一版 §3 列了 6 项「经评估暂缓」的缺陷。本轮全部清偿，逐项留档如下（判据可本机复核）。

1. **✅ 已修：rollback 不截断内存事件流**（原 P1）。新增 `LiveSessionRewindPort` +
   `LiveSessionRewindRegistry`（进程级登记表）→ `AppendOnlyEventLog.rewindTo`（越界 fail-closed）+
   `SessionRecorder.rewindTo`（夹回合起点、重算检索 seq、反注册被撤销文档）+
   `EventPersister.rewindTo`（**先等在飞全量写再强制重写**，长度相等时靠独立 `forceWrite` 判脏）。
   判据：`tests/unit/liveSessionRewind.test.ts` 11 例（含「回滚后照样 schedule 落盘，历史不复活」）。
   定位：`src/core/checkpointManager.ts` / `src/core/liveSessionRewindRegistry.ts` /
   `src/core/loop/eventPersister.ts` / `src/core/appendOnlyEventLog.ts` / `src/core/sessionRecorder.ts`。
2. **✅ 已修：TurnDiffHooks 基线跨回合不重置**（原 P2）。基线改为**只在 tracker 里存一份**
   （`hasBaseline` / `recordBaseline`；`noteWrite(path, after)`），钩子不再自持 Map ⇒
   跨回合复用**在结构上不可能**。判据：`tests/unit/turnDiffTracker.test.ts` 新增
   「回合边界后基线重置，diff 不跨回合累计」（旧实现该用例必红）。
3. **✅ 已修：压缩阈值 token 记账系统性偏低**（原 P2）。`TokenEstimator.estimateMessage` +
   `accountableText` 成为**唯一记账实现**（content → reasoning → toolCalls JSON → 附件信封；
   二进制载荷仍不计，理由成文）；`ContextBreakdownEstimator` 改为委派；
   `ContextCompactor.compact(messages, state, overhead)` 把**工具 schema + 未拼入的 repo-map 尾段**
   作为每请求固定开销并入同一预算（预留超预算时夹 20% 下限，不清空历史）；`StepRunner.requestModel`
   调序为先算工具集再组装消息。**Rust FFI 同步**（`handle_context_estimate` + `accountable_text`），
   本机 `npm run native:build` 后富载荷奇偶校验 **0 skip 通过**。
   判据：`tokenEstimator.test.ts` / `contextCompactor.test.ts` / `nativeTokenEstimator.test.ts`。
4. **✅ 已修：Ollama 流式工具调用按函数名合并**（原 P3）。有 `index` 按槽位分桶；字符串参数
   **按片段累积、流末只解析一次**；`id` 逐条唯一（旧实现用函数名当配对键）。无 `index` 保留按名
   合并——**无真实样本不推断该形态的并行语义**（遵「无样本不改协议解析」）。
   判据：`tests/unit/llamaCppToolCalls.test.ts` 5 例（脚本化 NDJSON）。
5. **✅ 已修：SkillSparsifier 在 BM25 生产路径上空转**（原 P3）。`SkillRegistry.rankForPrompt()`
   拆出**不截断**的比率过滤排名，生产改用它 + `sparsify(..., relevance)`（相关性作主序）；
   `selectForPrompt()` 契约不变。判定档同步改为生产真实两段管线并重跑
   `eval:skill-routing --gate`：召回 **92.3%**、噪声 **1.50** 条/查询、Δ **+65.38pp**、
   CI95 **[46.15, 84.62]pp**、留出折 0/40 为负 ⇒ 三关齐过（exit 0）。
   判据：`tests/unit/skillSparsifier.test.ts` 新增 3 例（含「上游预截断 ⇒ 判据必然退化」）。
6. **✅ 已修：apply_patch 多文件落盘非原子**（原 P3）。两阶段提交（准备：建父目录 + 已存在目标写
   `.bak`；提交：逐个落盘，任一次失败即**回滚**已写文件）＋「不存在」与「空文件」分离
   （只把 ENOENT 当不存在）。判据：`tests/unit/patchApplierFuzzy.test.ts` 新增 3 例
   （`.bak` 生成 / 目标 EISDIR 时一个字节都不落盘 / 只读目标写失败时回滚 one.txt）。

### 3.1 §3.1 两项遗留项已清偿（2026-10-03 第三轮）

1. **✅ 已修：写类工具后的全量重索引 → 增量重建**（原登记：真改源码后仍全量重建 8.6s 量级）。
   本机实测拆出三段成本（3227 文件 / 33.5 MB 语料）：遍历 **0.3s** + 读盘/分词/抽符号 **3.9s**
   - BM25 建索引 **3.0s**（file 2.2s + symbol 0.8s）。据此三处各降一档：
   * **解析规则单一实现**：新增 `context/corpusFileParser.ts`，全量路径（`indexCorpus`）与增量
     路径共用它——两处若各写一套，增量与全量结果会**静默**漂移。
   * **按内容哈希复用产物**：`context/corpusFileArtifact.ts` + `IndexOptions.artifactSink`；
     产物表随语料缓存条目（LRU 驱逐即释放）。
   * **BM25 就地替换**：`Bm25Index.setDocument(slot, tokens)`（+ `addDocument` / `slotCount`），
     只重算变化文件的 df/postings/文档长度，槽位不变（`setDocument` 越界 fail-closed 抛错）。
   * **签名复核与增量共用一次读盘**：`contentHashes()` 产出的逐文件字节哈希直接喂给增量重建器，
     只对真的变了的文件再读一次（此前「先签名、后重建」是两次遍历）。
   * **何时不增量（宁可慢不可错）**：文件集合/顺序变化、缺产物表、`light: false`（full 模式）、
     文件不可读 ⇒ 返回 `null` 回落全量重建。

   **实测（本仓，`npm run build` 后的 dist，TTL=0 强制复核）**：

   | 场景                       | 修前           | 修后         |
   | -------------------------- | -------------- | ------------ |
   | 首次全量建索引             | 9.4s           | 9.4s（不变） |
   | 无关写后取语料（内容未变） | 0.9s（软失效） | **0.9s**     |
   | **改 1 个源文件后取语料**  | **9.4s**       | **0.96s**    |
   | 再改 1 个源文件后取语料    | 9.4s           | **1.10s**    |

   即「真改了源码」这一档 **9.4s → 0.96s（≈10×）**；剩余 ~0.9s 是内容签名复核（读+哈希
   3227 个文件），它同时是变更判据与增量输入，不再是纯开销。
   判据：`tests/unit/corpusIncremental.test.ts`（6 例，**与全量重建逐位对拍**：files/symbols/
   fileText 逐字段相同 + 两套 BM25 在 5 条查询上命中 id 与分数逐位相同；覆盖「符号数不变」
   「符号数变化」「内容未变须复用同一对象」「文件集合变化须回落」）+ `tests/unit/bm25Incremental.test.ts`
   （4 例：替换后与全量重建的 id/分数/df/idf 逐位一致、越界抛错、空文档替换无残留）。

2. **✅ 已修：Ollama 多轮回传**（原登记：`buildRequest` 只透传 `role` + `content`）。
   **先查官方文档再动手**（`ollama/docs/api.md` 的「Generate a chat completion」message 字段表，
   2026-10-03 取用）：message 支持 `tool_calls`（`[{function:{name,arguments}}]`，**arguments 是
   对象**、条目**无 `id`**）与 `tool_name`（工具结果消息用）；**Ollama 没有 `tool_call_id`**
   （原先登记的「tool_call_id/tool_name」有一半是错的，已按文档更正）。改动：

   - assistant 消息回传 `tool_calls`（对象参数、不凭空加 `id`）；
   - 工具结果消息带 `tool_name`，且由**同请求 assistant 的 id→名映射**精确取值——
     不解析 id 字符串（本适配器合成的 id 形如 `name#2`，工具名本身含 `#` 时会解错）；
     映射里查不到就**不发**该字段（缺字段好过假字段）；
   - `images` 内联为**纯 base64**（剥 data URL 前缀）；`http(s)://` / `file://` 形式无法在不下载
     的前提下内联，**不发假字段**并记 debug。
     判据：`tests/unit/llamaCppToolRoundTrip.test.ts`（5 例，stub fetch **断言我们真正发出的请求体**：
     含「名字本身带 `#`」的用例证明映射优于字符串解析）+ 既有 `llamaCppToolCalls.test.ts` 5 例。

### 3.2 §3.2 两项登记结论（2026-10-03 第四轮）

1. **✅ 已修：`CorpusIndexCache` 之上的 embedding 重建**（原登记：语料一变就整仓重新嵌入）。
   新增 `context/embeddingContentCache.ts`（`EmbeddingContentCache`：按「角色 + 内容哈希」复用向量，
   **按代际清扫**保证常驻向量 ≈ 一份索引的量级）+ `context/cachedEmbeddingPort.ts`
   （`CachedEmbeddingPort`：装饰 `EmbeddingPort`，只把未命中文本交给真实模型，返回顺序与长度不变，
   `preload` 仅在内层支持时透出）；`SemanticIndexCache` 只为构建期包一层，索引仍按语料身份重建
   （审计 R3 的正确性不变），但**向量按内容复用**。

   **实测（本仓 3229 文件 / 67074 符号 / 一次索引 69773 条待嵌入）**：

   | 场景                                            | 修前          | 修后                      |
   | ----------------------------------------------- | ------------- | ------------------------- |
   | 首次建语义索引                                  | 69,773 次嵌入 | 69,773 次（不变）         |
   | 改 1 个源文件（改动落在**被嵌入窗口内**）       | **69,773 次** | **1 次**（复用 99.9986%） |
   | 改 1 个源文件（改动落在窗口外，被嵌入文本未变） | 69,773 次     | **0 次**                  |

   判据：`tests/unit/embeddingContentCache.test.ts`（5 例）——① 只重嵌变化条目（计数型假端口）；
   ② **与冷缓存从零构建的索引在 4 条查询上命中 id 与分数逐位一致**（省的是重复计算，不是正确性）；
   ③ 角色分离（query 与 document 不互相复用）；④ 代际清扫使条目数不随编辑次数增长；
   ⑤ **构建失败不清扫**（否则模型离线重试要从零嵌入）。
   边界如实登记：端口契约无模型标识 ⇒ 缓存假设「同一端口实例生命周期内模型不变」，另加一道
   维度校验兜住「换不同维度模型」；同维不同模型的极端情形未覆盖。

2. **⛔ 关闭（不实施）：full 模式的增量**（原登记：只服务 light 档）。
   本轮先查「谁会用」再决定做不做，结论是**没有受益方**，故按「不为模式而模式」关闭：

   - 生产路径 `src/**` 里 `light: false` 出现 **0 次**（唯一一处是 `contextEngine` 的文档注释）；
   - 全仓 `evals/**` 只有 **4 个脚本**用到 full 档，且每个脚本**一次进程内只建一次该配置的语料**
     （`diag-spectrum` / `rank-veto-retro` / `recall-codebase-real` 各 1 次；`context-efficiency/bench`
     2 次但两变体 `morph` 不同、本就是两份不同语料）⇒ 进程级增量缓存对它们**零收益**。
   - 反方向代价明确：频谱 / 代码图 / LSA 都与符号下标强耦合，做增量要把「符号槽位平移」传播到
     三类派生结构，属于「只增耦合、无实测受益」的改动。

   复核方式（本机可重跑）：`rg 'light: ?false' src/ evals/`（PowerShell：
   `Select-String -Path src/**/*.ts,evals/*.mjs -Pattern 'light:\s*false'`）。

## 4. 挂起项（有明确外部条件，非「不知道怎么做」）

- **官方跑分**（SWE-bench Verified / Terminal-Bench 官方口径）：依赖付费模型 API key 与
  Linux/docker 运行环境，本机（Windows、无代理、间歇外网）不可复现。历史非官方口径数字
  见 `CHANGELOG.md`（如实标注为子集口径）；交接文档 `docs/SWEBENCH_DOCKER_HANDOVER.md` 等。
- **注入攻击度量**（T4.4）：等待真实数据集快照；当前护栏为规则式（`promptInjectionGuard`，
  已接线 agent/config/cli 生产路径，enforce/shadow/off 三态）。
- **语义召回生产端到端验证**：向量落盘缓存（`diskCachedEmbeddingAdapter`）由假嵌入端口的
  单测覆盖；真实模型端到端未验证（本机无 ONNX 权重下载条件），不得声称已实测加速。

## 5. 活跃纪律摘录（原决策日志 D1–D9 随旧看板删除，仍具约束力的口径摘录在此）

- **D6 翻默认两关**：改检索/排序类默认前，必须过 ① 否决器（新路与基线 Top-K 平均 Jaccard
  重合度过高 = 常量偏置，直接判负）② 同语料配对 bootstrap 95% CI 下界 > 0 且留出折多数为正。
  点估计为正但 CI 跨零 ⇒ 判「与噪声不可区分」，不得翻默认。**确定性集合成员**场景（如工具
  暴露）用该判据的可操作形态：接线活性 + 跨查询敏感度 + 假阳性分数地板 + CI/留出折。
- **D7 行为变更登记**：默认行为变更必须量化代价与收益并留档（例：工具暴露翻默认时
  schema token −63.4%、平均可见工具 33→14，配零能力损伤 + 100% 必需召回两道判据）。
- **D10 依赖政策**：必要且更优即可引入，同等能力优先成熟第三方；「零依赖」不构成拒绝理由；
  手写实现降格为资产 + 回退路径。权威文件 `docs/DEPENDENCY_POLICY.md`。
- **随机性必须种子化 / 门禁输出必须干净 / 测试红先分清「测试错」还是「代码错」**：详见
  `omniharness-coding-standard` skill 与 `docs/CODE_STANDARD.md`。

## 6. 快速命令（生产口径）

```bash
npm run build          # tsc + 资产拷贝
npm test               # 构建 + 全量单测（官方门禁口径）
npm run eval:ci        # 评测门禁：召回审计 + rank-veto + 缓存命中 + 工具选择 + 前缀稳定
npm run eval:skill-routing -- --gate   # 技能路由三判据（语料 defaults/skills/harness-core.json，13 条）
npm run eval:tool-exposure-e2e         # 工具按需暴露端到端（零能力损伤判据）
npm run check -- --strict && npm run arch:gate && npm run audit:maturity   # 标准三闸
```

评测纪律：`eval:lsp-ab` 依赖语言服务器，实测净负已判负、不进 CI；任何评测结论必须连同
CI 宽度与语料规模（n）一并引用，单独引用点估计视为违规。

## 7. 本板如何追加条目

1. 只追加「已复核事实」：命令 + 日期 + 结果；或「已确证缺陷」：定位（file:line）+ 复现逻辑 + 暂缓理由。
2. 推翻旧条目时**保留旧文并划掉**（~~~~），注明推翻依据——不许无声改写历史结论。
3. 与 `AGENTS.md` 分工：AGENTS.md 只放「不写就会重复踩坑」的环境事实与流程约束；本板放项目状态。
