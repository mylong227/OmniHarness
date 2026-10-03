# OmniHarness 项目看板（唯一事实源）

> **本文件是仓内唯一的看板**。旧看板（`TASK_BOARD.md` / `REFACTOR_BOARD_2026-09-12.md` /
> `UPGRADE_BOARD_2026-09-12.md` / `archive/UPGRADE_BOARD_2026-09-05.md`）已于 2026-10-03 删除，
> 内容永久可查于 git 历史（`git show b49d96e^:docs/TASK_BOARD.md` 等）。
>
> **记录纪律（不可妥协）**：写入本板的每一条信息必须「本机可复核」——或附上产生它的命令/测试，
> 或标注复核日期。禁止复制未经验证的宣称；历史看板里的数字在重新实测前一律视为**待复核**。

---

## 1. 项目是什么

> **第六轮进度（P0 逐步落地）**：G3-V1 完成判定 fail-closed ✅ ｜ **G3-V2 `unverified` 一等完成状态 ✅** ｜
> G4-L3 取消原因保真 ✅ ｜ G4-L4 回滚重推压缩游标 ✅ ｜ G2 子代理写入语义闭环 ✅ ｜
> G1a 最小行为回归守卫 ✅（4 例行为不变量 + 变异测试验证有牙齿）｜
> **G1b-a 检索质量回归守卫 ✅**（锚点审计 + `plain`/`rerank` 两镜头 recall@14/MRR 对基线；变异测试验证有牙齿，并诚实登记"对符号池规模不敏感"的盲区）｜
> **G1b-b 前缀复用守卫 ✅**（`PrefixStability` 首次接进请求路径；三条结构不变量；变异"动态段挪回头部"⇒ 三例全红）｜
> **G5 安全边界显式化 ✅（P0 收口）**：记忆信任档收紧（新增 `memory` 档、阈值 1）＋ 网络守卫自述"只覆盖 fetch"＋ 能力表去掉 OS 级隔离暗示 ＋ `doctor` 增「隔离强度 L2／shell 出网被拦=否」如实输出 ＋ `compliance.md` 降级为 ⚠️。｜
> 待做：G1b-c 回滚端到端断言（已如实登记未做及原因）。详见报告 §5.1 进度表。
>
> **本轮（第五轮）交付**：`docs/ARCHITECTURE_UPGRADE_2026-10.md` —— 清理后的真实现状核查 +
> **11 专题外部调研**（学术论文 / 官方规范 / 优质开源，逐条带一手 URL）+ 升级路线图（P0→P3，每项含离线判据）+
> 反泡沫清单。它同时登记了 §8 的 6 条已确证缺陷与 7 处口径订正，是当前"架构该往哪继续投"的主要依据。

- **通用 Agent Harness**：TypeScript（CLI / Web 工作台 / 编排）+ Rust（原生内核）。
  包名 `@mylong227/omniharness`，版本 0.2.0，Apache-2.0，要求 Node ≥ 22.14.0。
- Rust 侧 6 个 crate：`omni-cli` / `omni-core` / `omni-napi` / `omni-sdk` / `omni-sdk-gen` / `omni-wasm`（39 个 .rs 文件）。
- Web 工作台 `web/src`：111 个 TS/TSX 文件（**官方 React 18.3.1 UMD**，由 `index.html` 以 `<script>` 直载
  `web/vendor/react.production.min.js`(10.5KB) + `react-dom.production.min.js`(128.7KB)，**零打包器**
  （`web/tsconfig.json` 直接 `tsc` 到 ESM）；手写的只是**类型声明** `web/src/types/react-shim.d.ts`。）
  ⚠️ 口径订正（2026-10-03 第五轮）：此前多处写成"自绘 React 垫片/无第三方运行时框架"，**与事实不符**，已订正。
- ~~评测/基准设施：`evals/` 86 个文件（评测脚本 + 落盘报告）、`benchmark/`、SWE-bench 运行器（`python/` + `eval-data/`）。~~
  **2026-10-03 已整体移除**（指令：「跑分不做了、都删掉，只要核心功能与项目完整」）：`benchmark/`、
  `evals/`、`python/`、`eval-data/`（本机 2.3 GB 级运行产物）、`scripts/*.py`（16 个图像生成基准
  run/evaluate）、`tests/bench/`、`BENCHMARKS.md` + 5 篇口径文档、`requirements.txt`，
  共 **87 个入库文件**（见 §7 变更登记）。

### 代码规模（2026-10-03 第五轮实测；**计数口径已订正**）

> **口径订正（本轮发现的历史错误）**：此前用 `Get-Content | Measure-Object -Line` 数行数，该 cmdlet
> **少计空行**——`src/context/contextEngine.ts` 实测 `(Get-Content).Count` = **646** 而行数口径给 609，
> 单文件就少 37 行。故历轮「91,079 / 92,124 行」等数字系统性偏低（全仓约低 5.6k 行）。
> **正确口径 = `(Get-Content <file>).Count` 逐文件求和**（等价于 `wc -l` 的「行数」语义）。

| 区域                                                 | 文件数  | 行数      |
| ---------------------------------------------------- | ------- | --------- |
| `src/` 全部                                          | **914** | 97,631    |
| —— adapters（协议/工具/存储/媒体/沙箱等适配器）      | 211     | 32,033    |
| —— ports（端口契约 + 组合接口）                      | **342** | 6,238     |
| —— server（HTTP/WS 服务与端点）                      | 47      | 9,104     |
| —— context（检索/压缩/仓库图/语料缓存）              | 46      | 9,948     |
| —— cli                                               | 29      | 6,212     |
| —— core（agent 循环 / 步执行 / 工具门禁 / 暴露规划） | 26      | 5,541     |
| —— util                                              | 32      | 4,248     |
| —— config（组合根）                                  | 22      | 4,104     |
| —— media / plugin / evolution / 其余                 | 约 159  | 约 12,200 |
| 单元测试 `tests/*.test.ts`                           | 385     | 53,136    |
| Web 工作台 `web/src`                                 | 111     | 17,245    |
| Rust `crates/**/*.rs`（6 crate）                     | 39      | 6,143     |

> 所有数字本机可复核：文件数 = `Get-ChildItem <dir> -Recurse -File -Filter <ext> | .Count`，
> 行数 = 对同一集合逐文件 `(Get-Content $f).Count` 求和。断言用例数 = `npm test` 输出（2,445 项）。

## 2. 当前门禁状态（2026-10-03 第四轮实跑；跑分/评测子系统已于同日整体移除）

| 门禁           | 命令                               | 结果                                                                                           |
| -------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| 类型（含 web） | `npm run typecheck`                | ✅ 零错误                                                                                      |
| 代码规范       | `npm run lint`（--max-warnings=0） | ✅ 0 告警                                                                                      |
| 铁律/体量      | `npm run check -- --strict`        | ✅ 908 文件零违规（存量白名单 13 处冻结）                                                      |
| 架构           | `npm run arch:gate`                | ✅ 依赖方向 0 / ports 纯度 0 / 依赖环新增 0                                                    |
| 成熟度         | `npm run audit:maturity`           | ✅ 40 项声明，L2/L3 均有测试证据                                                               |
| 接线完整性     | `npm run audit:config-wiring`      | ✅ 908 源文件全绿                                                                              |
| 文档死链       | `npm run check:doc-links`          | ✅ 新增 0（本轮删除产生的历史引用已冻结进基线，见 §7）                                         |
| 规范增量       | `npm run audit:standard:delta`     | ✅ 未新增标准违规                                                                              |
| 全量单测       | `npm test`                         | ✅ 2,445 项：2,441 过 / **0 失败 / 0 cancelled** / 4 skip（exit 0）                            |
| 覆盖率         | `npm run coverage`                 | ✅ **行 90.13% / 分支 83.61% / 函数 87.63%**（第五轮实测；注意"覆盖"≠"有效"，见调研报告 §3.9） |
| Rust 单测      | `npm run rust:test`                | ✅ 全绿                                                                                        |

> **已移除的门禁**（随跑分子系统一并删除，如实登记）：
> `eval:ci`（召回锚点 / rank-veto 回溯 / 缓存命中 / 工具选择 / 前缀稳定五件套）、
> `eval:veto`、`eval:recall-query-audit`、`eval:tool-exposure-e2e`、`eval:skill-routing --gate`、
> `eval:lsp-*`、`bench*`、`metrics:tool-exposure`。CI 的 `eval` job 已同步删除
> （**上一次删除 `eval:*` 却漏改 CI 有事故留档，本轮已按要求同步**）。
> 代价：召回率 / 前缀缓存复用率 / 工具暴露零损伤 / 技能路由三关**从此没有机械判据**，
> 相关历史数字只能引 git 历史且须标注「脚本已移除、不可复跑」。

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
>
> ⚠️ **2026-10-03 同日追加说明**：本节第 5 项的判据曾用 `evals/skill-routing-ab.mjs --gate`
> （"三关齐过"），该脚本已随跑分/评测子系统整体删除 ⇒ **那些判据不再可复跑**，本节保留原文
> 以存史（按本板纪律不许无声改写结论），但引用其数字时必须标注「脚本已移除、不可复跑」。
> 其余各项的判据都是 `tests/unit/**` 单测，**仍然有效**。

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
     （2026-10-03 追加：`evals/` 本身已整体删除，这条「无受益方」的结论因此**更加成立**——
     full 档现在在仓内**只剩 `light: false` 的零调用点**。用 `Select-String -Path src/**/*.ts
-Pattern 'light:\s*false'` 复核即可。）
   - 反方向代价明确：频谱 / 代码图 / LSA 都与符号下标强耦合，做增量要把「符号槽位平移」传播到
     三类派生结构，属于「只增耦合、无实测受益」的改动。

## 4. 挂起项（有明确外部条件，非「不知道怎么做」）

- ~~**官方跑分**（SWE-bench Verified / Terminal-Bench 官方口径）：依赖付费模型 API key 与
  Linux/docker 运行环境，本机（Windows、无代理、间歇外网）不可复现。~~
  **⛔ 2026-10-03 撤销（不再是挂起项）**：用户指令「跑分不做了、都删掉」。整个跑分/对外评测
  子系统（含 SWE-bench 容器运行器 `python/` 与 `eval-data/`）已删除，本项目**不再追求官方口径数字**。
  历史非官方口径数字仍在 `CHANGELOG.md` 与 git 历史里，但**没有可复跑判据，不得当作现状引用**。
- **注入攻击度量**（T4.4）：等待真实数据集快照；当前护栏为规则式（`promptInjectionGuard`，
  已接线 agent/config/cli 生产路径，enforce/shadow/off 三态）。
  （原 `eval:injection-*` 度量脚本已随跑分子系统删除，故该项现在**只剩护栏实现，没有度量口径**。）
- ~~**语义召回生产端到端验证**：向量落盘缓存（`diskCachedEmbeddingAdapter`）由假嵌入端口的
  单测覆盖；真实模型端到端未验证（本机无 ONNX 权重下载条件），不得声称已实测加速。~~
  **✅ 2026-10-03 已实测（推翻旧结论）**：本机权重其实**已就位**
  （`.omniharness/model-cache/Xenova/e5-small-v2`：config + tokenizer + model_quantized.onnx），
  配 `preset: 'e5-small-v2'` + `localFilesOnly: true` 可**完全离线**跑通（实测 dim=384、冷启 713ms、热 11ms）。
  ⚠️ **吞吐数字已订正（2026-10-03 第五轮复测）**：原写"180–320 texts/s"**复现不出**——用 256 条 ≈90 字符文本、
  e5-small-v2 量化档、batch 8/32 复测为 **26.1 / 29.7 texts/s**（另有独立调研测得 ~50 texts/s，差异来自文本长度与批构成）。
  ⇒ **吞吐是文本长度与批的强函数，任何单点数字必须连同方法一并引用**；此前的 180–320 属错误记录。
  当时的可复现脚本为 `evals/semantic-e2e-real.mjs`（**该脚本已于同日随跑分子系统删除**，故下表数字**不再可复跑**，
  仅作当次实测留档；语料是复制到临时目录的 `src/` 有界子集，60 文件 / 1108 条待编码）：

  | 段  | 场景                        | 编码条数 | 耗时  |
  | --- | --------------------------- | -------- | ----- |
  | ①   | 首建                        | 1,108    | 37.7s |
  | ②   | 同进程改 1 文件（内存复用） | **1**    | 0.17s |
  | ③   | 模拟重启（落盘复用）        | **0**    | 0.03s |
  | ④   | 重启后再改 1 文件           | **1**    | 0.56s |
  | ⑤   | 冷基线（独立缓存目录）      | 1,108    | 37.5s |

  硬判据（**通过**）：②↔③ 是同一批缓存向量（内存复用 vs 落盘复用），检索命中与分数
  **逐位相同**（最大差 0）⇒ 缓存不喂错向量。绝对耗时**不得外推**到全仓（全仓约 7 万条）。

  **顺带修掉一处真缺陷（本轮）**：`DiskCachedEmbeddingAdapter.flush()` 的类文档写明
  「公开给装配层在关停时显式调用」，而全仓**没有任何调用点** ⇒ 每次构建最多 `flushThreshold−1`
  条向量**静默不落盘**（实测残留 **84/1108** 条），重启后重付这段编码。
  现由 `SemanticIndexCache` 在**构建成功后**调用（`EmbeddingPort.flush?` 为可选契约，
  `CachedEmbeddingPort` 透传），实测 ③ 由 84 条/20.2s 降为 **0 条/0.03s**。

- **⚠️ 新增纪律级实测（语义检索的可比性边界，引用任何语义数字时必须一并说明）**：
  真实模型的向量**依赖批次构成**——同一文本 `solo` vs `batch(32)` 的分量最大差 **6.3e-3**、
  余弦 0.99904（同批次构成则逐位相同，跨会话亦然；本机 e5-small-v2 离线量化档实测）。
  后果：**跨运行 / 跨配置的语义对比不得以「逐位相等」或「top-1 相等」为判据**——
  近邻分差小于该噪声地板时排序会翻转（本轮实测到 top-5 内位置互换与 top-1 翻转，
  cosine 差 ~2.3e-3）。可操作判据：**同一批缓存向量**之间用逐位对拍（缓存正确性），
  跨批次一律用 top-k 覆盖率 + 分数容差（脚本按 ≥60% 覆盖率做粗损坏探测）。

## 5. 活跃纪律摘录（原决策日志 D1–D9 随旧看板删除，仍具约束力的口径摘录在此）

- **D6 翻默认两关**：改检索/排序类默认前，必须过 ① 否决器（新路与基线 Top-K 平均 Jaccard
  重合度过高 = 常量偏置，直接判负）② 同语料配对 bootstrap 95% CI 下界 > 0 且留出折多数为正。
  点估计为正但 CI 跨零 ⇒ 判「与噪声不可区分」，不得翻默认。**确定性集合成员**场景（如工具
  暴露）用该判据的可操作形态：接线活性 + 跨查询敏感度 + 假阳性分数地板 + CI/留出折。
  ⚠️ 2026-10-03：**判据本身保留，但执行它的评测脚手架已删除**（`evals/` 全量）。
  故该纪律现在只能靠**外部/自建**测量满足——没有脚手架就不得声称「已过两关」。
- **D7 行为变更登记**：默认行为变更必须量化代价与收益并留档（例：工具暴露翻默认时
  schema token −63.4%、平均可见工具 33→14，配零能力损伤 + 100% 必需召回两道判据）。
  ⚠️ 同上：上述数字来自已删评测脚本，**引用须标注「脚本已移除、不可复跑」**。
- **D10 依赖政策**：必要且更优即可引入，同等能力优先成熟第三方；「零依赖」不构成拒绝理由；
  手写实现降格为资产 + 回退路径。权威文件 `docs/DEPENDENCY_POLICY.md`。
- **随机性必须种子化 / 门禁输出必须干净 / 测试红先分清「测试错」还是「代码错」**：详见
  `omniharness-coding-standard` skill 与 `docs/CODE_STANDARD.md`。

## 6. 快速命令（生产口径）

```bash
npm run build          # tsc + 资产拷贝
npm test               # 构建 + 全量单测（官方门禁口径）
npm run typecheck      # tsc --noEmit（含 web）
npm run lint           # eslint --max-warnings=0
npm run check -- --strict && npm run arch:gate && npm run audit:maturity   # 标准三闸
npm run audit:config-wiring && npm run check:doc-links && npm run api:check
npm run rust:test      # cargo test --workspace
```

~~评测命令（`eval:ci` / `eval:skill-routing` / `eval:tool-exposure-e2e` 等）~~
**2026-10-03 全部移除**：跑分/评测子系统已删除，`package.json` 不再有 `eval:*` / `metrics:*` /
`bench*` 脚本（CI 的 `eval` job 同步删除）。改动检索/排序/压缩默认值时，须用**自建**测量
（可写一次性脚本，但不入库为门禁），并在看板登记「口径 + 语料规模 n + 是否带 CI」。若引用历史
评测数字，一律标注「脚本已移除、不可复跑」。

## 7. 变更登记：跑分/评测子系统移除（2026-10-03，第四轮）

**指令**：「跑分的不再做了，直接删除即可，我们只要保证项目核心功能、项目的完整」。

**已删除（87 个入库文件 + 本机 2.3 GB 级运行产物）**：

| 路径                                                                            | 文件数 | 说明                                                                             |
| ------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| `benchmark/`                                                                    | 6      | 效率基准 / 六属性自检 / 参数收紧闭环 / telemetry 配置                            |
| `evals/`                                                                        | 51     | 召回、重排、语义桥、爬虫、BM25、工具暴露等测量脚本与报告                         |
| `python/`                                                                       | 3      | SWE-bench 容器内的 OmniHarness 运行器                                            |
| `scripts/*.py`                                                                  | 16     | ComfyBench / GenEval / GenEval2 / KRIS-Bench / ReasonEdit / WISE 的 run+evaluate |
| `tests/bench/`                                                                  | 4      | 该目录下的微基准（compaction / nativeVsJs / tokenEstNative / agentTask）         |
| `BENCHMARKS.md` + `docs/SWEBENCH_*.md`(4) + `docs/ZERO_COST_CAPABILITY_EVAL.md` | 6      | 对外跑分口径与交接文档                                                           |
| `requirements.txt`                                                              | 1      | 上述评测栈（含 GenEval2/CUDA 轮子）的 Python 依赖                                |
| `eval-data/`（**本机，gitignored**）                                            | 0      | SWE-bench/Terminal-bench 运行产物：克隆仓库、testlogs、56.7 MB 向量缓存等        |

**配套同步（缺一即红，逐项已做）**：

1. `package.json`：删除全部 `eval:*` / `metrics:*` / `bench*` 脚本（**注意**：2026-10-02 的
   `ef2ac0f` 删了 `eval:*` 却漏改 CI，导致 CI job 三步 `Missing script` 恒红——本轮**同步**删了
   `.github/workflows/ci.yml` 的 `eval` job，避免重犯）。
2. 活跃文档改写：`README.md`（§2.4 基线段）、`docs/ARCHITECTURE_SPEC.md`（§8 尚缺 + §9 整体重写为
   「已移除」清单）、`docs/compliance.md` 第 36 行（标注降幅数字无复跑判据）、
   `docs/MIGRATION_MAP_2026-09.md`、`docs/library/10-math-information-and-optimization.md`
   （保留实测结论，标注脚本已移除）。
3. 历史引用**冻结**（不改写历史结论，按 `ef2ac0f` 的既有做法）：新增死链按
   `scripts/docLinkBaseline.json` 纳入基线，涉及 `RECALL_HEADROOM_SURVEY` / `POLISH_PLAN` /
   `DEFICIENCY_AUDIT_2026-09-22` / `UPGRADE_PLAN_SYNTHESIS` / `U3_CONTEXT_RECALL_EXPERIMENT` /
   `TECH_DIRECTION_SYNTHESIS_2026-09-12` / `agent_evolution_research/*` / `CORE_CAPABILITY_AUDIT_2026-10-01`
   等**存档性审计与研究文档**。
4. 保留不受影响的部分：`src/`（运行期不读任何被删文件，仅注释/JSDoc 里的历史引用）、
   `tests/unit/**`（含召回查询夹具——它们是单测数据，不是评测脚本）、Rust crate、Web 工作台、
   `third-party/`（Laya 与模型权重缓存与跑分无关）。

**代价（如实登记，不得淡化）**：召回率、前缀缓存复用率、工具暴露「零能力损伤」、技能路由三关、
压缩降幅、SWE-bench 口径数字——**从此都没有机械判据**。看板 §3/§4 相关条目里的数字仍然保留为
历史记录，但引用时必须写明「脚本已移除、不可复跑」。核心功能与项目完整性由九道门禁 + 全量单测
（`npm test`）继续守住。

## 8. 已确证待修缺陷（2026-10-03 第五轮，架构复核 + 外部调研交叉发现）

### 8.1 ✅ 已修（2026-10-03 第六轮）：子代理的**文件写入被静默丢弃**（隔离有、回并路径无）

**现象**：委派给子代理的「改代码」任务会返回 `ok: true` + 一段声称已完成的总结，但**主仓库零改动**，
且改动内容不可恢复——工作树与分支都被删掉。等于「假成功 + 静默数据丢失」。

**证据（本机读码，可复核）**：`subagentOrchestrator.ts:62-68` 建独立工作树并把 `workspaceRoot` 指向它；
`:74-77` 的 `finally { worktree.cleanup() }`；`worktreeOps.ts:74-97` 的 cleanup =
`git worktree remove --force` **+ `git branch -D`**；`toolViewOf` 只剔递归入口（写类工具对子代理**可用**）；
`subagentResult.ts` 无 diff/patch 字段；全仓 `WorktreeOps` 仅 2 处引用 ⇒ **无合并路径**。
另：`run_workflow` 的 `execute()` 自称"隔离"，实际传父级 ports（无 worktree）⇒ **语义与文档相反**。

**修法（已实施，两条隔离档都不再静默）**：

| 档                          | 语义                    | 机制                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **worktree**（git 可用）    | 改动**可回收**          | `WorktreeOps.collectChanges()`（先 `git add -A` 纳入未跟踪新建文件，再 `git diff --cached --binary HEAD`；>4 MiB 截断标注）+ `persistChanges()` 落盘到 `.omniharness/subagent-patches/<sessionId>.patch`；编排层在 `cleanup()` **之前**采集并挂 `changedFiles`/`patchPath`/`patchBytes`/`patchTruncated`，并 `log.warn` |
| **copy**（git 不可用/失败） | **禁写（fail-closed）** | `SubagentToolScope.writeForbidden()` 从工具视图剔除全部 `MUTATING_TOOLS`，结果标 `writesForbidden`——没有 git 可比 ⇒ 改动不可能取回，故明确拒绝而不是假装成功                                                                                                                                                            |

另：采集失败置 `writesUnrecoverable`（fail-closed 标记，绝不静默）；`SubagentTool.render()` 把上述事实
**渲染给父模型**（改动清单 + patch 路径 + `git apply` 命令 / 禁写说明），否则"子代理说改好了"仍会被读成"已改好"。

**S3（工作流）**：docstring 订正为"构造**共享工作区**的子智能体"（并说明与子代理隔离相反的原因）；
新增 `WorkflowLayerPolicy`——同层＞1 步且任一步**可能写**（未声明 `tools`＝拿全集，或声明含写类）时
**该层退化为串行** + `log.warn('workflow.layer.serialized')`，消除并发覆盖同一文件的竞争。

**判据**：`tests/unit/worktree.test.ts` 新增 2 例（修改/新建/删除三形态可采集，patch 落盘后能
`git apply` 回主仓并真的拿到改动与删除；无改动时采集为空）；新增 `subagentToolScope.test.ts` 4 例
（收窄不含写类、只读保留、不改原请求、写类清单护栏）；新增 `workflowLayerPolicy.test.ts` 5 例（单步不退化、
只读层保持并发、未声明必串行、含写类必串行、三态判定）。

**遗留（如实登记）**：工作流同层冲突处理是**保守退化（串行）**而非"按声明精确判冲突"——
`WorkflowStep` 尚无"我写哪些文件"的声明字段；精确并发需先加声明契约，属独立改动（记入报告 §4 后续项）。

### 8.2 ✅ 已修（2026-10-03 第六轮）：回滚后「压缩游标」未复位（回滚对齐漏了第四层）

**现象**：同一进程内 `checkpoint` 回滚后，`StepContextBuilder` 的内存压缩游标仍指向**已被截断移除**的折叠点；
**重启进程反而正常**（新实例会重新恢复），故属"同进程不对、重启对了"这类最难查的形态。

**证据（本机复核）**：`src/core/stepContextBuilder.ts:44,46` 定义 `compactionState` / `stateRestored`；
`stateRestored = ` 全仓**只有两处**——L46 初始化为 `false`、L102（构造后首次 `buildMessages`）置 `true`，
**没有任何地方置回 false，也没有 reset()/setter**。而 `SessionRecorder.rewindTo` 会经 `eventsFrom` 把那条
`OMNI_COMPACTION_V1` 游标事件从日志移除 ⇒ 游标悬空。

**注**：另外三层回滚对齐本身是**做对的**（内存事件流 / 检索索引 / 磁盘 + 在飞写），且端口不支持 `remove` 时
会显式 `log.warn('session.retrieval.rewind_unsupported')` 而非静默——本缺陷是**第四层**（上下文游标）漏了。

**修法（已实施）**：新增 `StepContextBuilder.rewindCompactionState()`——**就地重新推导**游标
（取"截断后日志里的最后一条标记"，没有即 `undefined`）；经 `StepRunner` / `TurnRunner` 透传，
由 `Agent.registerRewinder` 在 `recorder.rewindTo(size)` **之后**调用（第 4 步接线；
`activeRunner` 用延迟绑定，因为回卷登记发生在 `buildTurnRunner` 之前）。
**刻意不把 `stateRestored` 置回 false**：那会让下一次构建走"首次恢复"路径并把 `previous` 当 `undefined`，
可能多付一次摘要 LLM 调用（正是该文件注释记录的旧缺陷 P0-1）。

**判据**：`tests/unit/contextIntegrityFixes.test.ts` 新增 ⑤——先用真压缩器产出真实游标事件，
再用记录型压缩器观察每次传入的 `previous`：① 首次构建恢复出游标；② **截断游标事件但不复位** ⇒ 仍复用
被移除的游标（复现缺陷形态）；③ 调用 `rewindCompactionState()` 后 ⇒ `previous === undefined`
（承认"截断后的日志里没有游标"，即已完成重新对齐）。

**仍未做（如实登记）**：接线（`Agent → TurnRunner → StepRunner → StepContextBuilder`）目前只有
类型检查 + 本次单测覆盖语义，**缺一条端到端断言**（真实回合里跑 `checkpoint` 回滚后核对下一次请求的消息）；
已并入 G1「最小行为回归守卫」的用例清单。

### 8.3 🟠 P1：事件落盘是「全量快照重写」而非增量追加（写放大随会话长度增长）

**证据（本机复核）**：`EventPersister.saveSnapshot` → `storage.save(sessionId, events)`（`eventPersister.ts:139-163`），
而 `TurnRunner` **每步**调 `schedule()`（`turnRunner.ts:107-108`，默认 200 ms 批量）；三个适配器都**没有 append 通道**：
`jsonlStorage.ts:33-48` 整文件 tmp+rename；`sqliteStorage.ts:49-67` 一个事务里 **`DELETE` 全桶 + 逐条 `INSERT`**。

**影响**：与"append-only 事件溯源"的架构主张不一致，且长会话后段每次 flush 都在重写 N 条。
**本机实测（2026-10-03，`JsonlStorage.save` 单次调用成本）**：200 条 ≈ 28 ms / 89 KB；3,200 条 ≈ 41 ms / 1.6 MB；
**12,800 条 ≈ 139 ms / 6.5 MB** ⇒ 单次成本随 N **线性**，而 flush 每步触发 ⇒ 会话累计写入 ≈ `size_N × 步数 / 2`
（12,800 事件 × 1,000 步的尾部量级 ≈ **GB 级重写**）。**口径**：这是"实测单次成本 × 线性增长"的**外推**，
不是端到端实测（仓库现已无 perf 测试）。

**修法（建议）**：`StoragePort` 加**可选** `append?`（明确 fail-closed 契约：只追加不覆盖、写入前校验前缀完整），
jsonl 走真追加、sqlite 走 `INSERT OR REPLACE` 不 DELETE，`EventPersister` 优先 append、失败回退全量 save。
**回退方式天然存在**：适配器不实现 `append` 即自动回到现有行为。

### 8.4 ✅ 已修（2026-10-03 第六轮）：取消原因在 **AbortSignal 桥**上丢失（原诊断已订正）

**原诊断订正（读码复核后）**：本条原写"级联时把 reason 写死成 `'parent'` 与文档矛盾"。复核后：
`'parent'` 是 `CancelReason` 联合类型里的**一等值**，且 `loopCancellation.test.ts:45` 明确断言
`child2.cancelReason === 'parent'` ⇒ **级联标 `'parent'` 是有意设计**（表示"我是被父令牌级联取消的"），
不是缺陷；且 `child()` 在 `src/**` 里**没有任何生产调用点**（仅测试使用）。

**真正的缺陷在两处（读码 + 实测确认）**：

| #   | 位置                                                   | 事实                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/core/loop/cancellationToken.ts` `toAbortSignal()` | 两处 `controller.abort()` 都**不带 reason** ⇒ `AbortSignal.reason` 退化成通用 `AbortError`(DOMException)。而 `agent.ts:413` 正是把该 signal 交给模型层 ⇒ 下游**拿不到任何结构化原因**。                                   |
| 2   | `src/subagent/cancellableModel.ts` `reasonOf()`        | 白名单只有 `'user'\|'timeout'\|'shutdown'\|'parent'` ⇒ **`'loop-guard'`（失控熔断）与 `{custom}` 被静默折叠成 `'parent'`**（谎报"父级联"）；且兜底值返回 `'parent'`，与该函数自己 JSDoc 写的"缺省时为 `'user'`"**矛盾**。 |

**净后果**：生产路径上 `CancelledError.reason` 几乎恒为 `'parent'`——用户中断、超时、关机、失控熔断
全都被报成"父令牌级联"，而这正是 `CancelReason` 联合类型存在的理由。

**修法（已实施）**：① `toAbortSignal()` 把结构化原因一起过桥（未取消时兜底 `'user'`）；
② `reasonOf()` 认全五类字符串原因 + `{ custom }` 对象，兜底按文档取 `'user'`。

**判据（本机离线）**：

- 新增 `tests/unit/cancellableModelReason.test.ts` 4 例（五类原因 / `{custom}` / 无原因兜底 / 畸形输入不抛错）；
- `tests/unit/loopCancellation.test.ts` 增 1 例：`toAbortSignal()` 在"未取消即注册"与"已取消"两条路径上都必须带原因；
- `tests/unit/cancelPropagation.test.ts`（原先对原因**零断言**）新增 `childAbortReasons()` 观测，
  并在工作流 / 目标循环 / 子代理三条**真实路径**上断言 `=== ['user']`；
- 端到端探针（临时，未入库）：`token.cancel(x)` → `toAbortSignal()` → `reasonOf()` 对
  `user / timeout / shutdown / loop-guard / {custom}` **全部保真**。

**仍未做（如实登记）**：`child()`/`children` 这条父子令牌树在生产路径无调用者（仅测试），
故"子令牌集合只在 cancel 时清空、无 disposable"目前**不构成实际泄漏**；若将来接入生产，
需要同时补 dispose 语义。

### 8.5 ✅ 已如实标注（2026-10-03 第六轮 G5）：安全面三处「声明强于实现」——**能力边界未变，只让声明与实现一致**

> 本组是外部调研（Windows 隔离专题）读码 + **我逐条复核**得到的事实。它们不是"待修 bug"而是
> **当前真实能力边界**——写进威胁模型与文档时必须按此表述，不得声称已隔离。

| #   | 事实                                                                                                                                                                                                                             | 复核状态  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | 默认沙箱档是 `policy`（`appServerBase.ts:245` 的 `file.sandbox ?? 'policy'`），即**纯 TS 黑名单 + 路径白名单**，无内核强制                                                                                                       | ✅ 已复核 |
| 2   | Windows「OS 级」后端调 `CreateRestrictedToken(..., 0, null, 0, null, 0, null, ...)`——**三个 restricting-SID 计数参数全 0** ⇒ 无文件/网络拒绝语义（只删特权 + Job Object 限额，且未换桌面、未设 UILIMIT）                         | ✅ 已复核 |
| 3   | `networkEgressGuard` **只包 `globalThis.fetch`** ⇒ shell 子进程（`curl`/`certutil`/原生 socket）完全绕过；记忆/召回类工具被归入 `file` 信任档（阈值 2），比一次性 `external`（阈值 1）**更宽松**，而记忆是**跨会话持久**投毒载体 | ✅ 已复核 |

**结论（可引用口径）**：在不付费、支持 Windows 的前提下，本仓库**当前是 L2（同用户进程内约束）**；
可达的 L3 只有 AppContainer + 宿主路径 DACL 或 WSL2 内 bubblewrap/landlock 两条路（详见调研报告 §3.5）。
**用户可感知的行为后果**：模型若被注入说服，`shell` 里的下载/外联命令在本机**不会**被 fetch 守卫拦住。

> **文档死链基线说明（2026-10-03 第五轮）**：基线由 89 处更新为 **96 处**（`testCountParser` 已成真并已收紧），曾新增的 7 条来自
> `docs/ARCHITECTURE_UPGRADE_2026-10.md` 的**升级提案里的待建路径**
> （`scripts/memoryLiftProbe.mjs`、`tests/unit/{eventPersisterAppend,memoryTrustBoundary,subagentWriteGate,toolSchedulerReadyOrder,testCountParser,genAiSemconvConformance}.test.ts`）。
> 它们是有意引用（提案的判据落点），按 `docLinkCheck` 的既定流程 `--update` 纳入基线；
> **实现这些提案后应收紧基线**（`--update` 会同时清掉已存在的路径）。

### 8.6 ✅ 已修（2026-10-03 第六轮）：完成闸门把「零测试」判成「验证通过」（fail-open 漏洞）

**现象**：回合末验证闸门只看退出码；而"测试命令一条都没匹配到"在 Node 里**是成功退出** ⇒
"没跑任何测试"会被当成"验证通过"，正好落进本仓最忌讳的**假完成**形态。

**证据（本机复核）**：`node --test "dist/tests/unit/__nonexistent__*.test.js"` ⇒ 输出
`# tests 0 / # pass 0 / # fail 0` 且 **exit = 0**；而 `turnEndCompletionGate.ts:78` 的判据只有
`if (outcome.exitCode !== 0)`。本仓 `npm test` 正是 `npm run build && node --test "dist/tests/unit/*.test.js"`
⇒ 一旦 glob 落空（改名/构建产物缺失/路径漂移），闸门会给出"验证通过"。
外部佐证：pytest 把"没收集到测试"单列为 **exit 5**，Jest 需显式 `--passWithNoTests` —— 两个主流工具都刻意区分二者。

**修法（已实施）**：新增 `src/adapters/tool/verify/testCountParser.ts`（`TestCountParser`，识别
node-test / jest / vitest / pytest / go-test 五类汇总行）；闸门在 exit=0 时增补第二道判据——
**显式零测试证据 ⇒ 拦截**，以及**计数里有失败却以 0 退出 ⇒ 以计数为准拦截**。
判据刻意不过度 fail-closed：拿不到汇总行（日志被 `maxOutputBytes` 截断）或命令不是测试运行器
（如 `tsc --noEmit`）⇒ **不拦**（闸门是增强，不是环境检测器）。

**实施中踩到并修掉的真问题**：首版验证时"**9 个用例全过的真实输出也被判成零测试**"——根因是 node TAP
会**回显用例名**（`# Subtest: <名>` / `ok 1 - <名>`），而本仓测试名里恰好含 `no tests ran` /
`collected 0 items` / `No test files found` 字样 ⇒ 子串匹配命中了用例名。现已先剔除逐用例行的用例名回显
（node TAP / jest `✓✕` / pytest `PASSED|FAILED`）再判读，并补回归用例钉住该形态。
**这条值得记档：仪器不得把被测对象的名字当成自己的读数。**

**判据**：`tests/unit/testCountParser.test.ts`（12 例）+ `tests/unit/turnEndCompletionGate.test.ts`（新增 4 例）；
真实命令口径复核（临时探针）：空 glob ⇒ `zeroEvidence: true`；真跑 12 例 ⇒ `total=12 / zeroEvidence=false`。

## 9. 本板如何追加条目

1. 只追加「已复核事实」：命令 + 日期 + 结果；或「已确证缺陷」：定位（file:line）+ 复现逻辑 + 暂缓理由。
2. 推翻旧条目时**保留旧文并划掉**（~~~~），注明推翻依据——不许无声改写历史结论。
3. 与 `AGENTS.md` 分工：AGENTS.md 只放「不写就会重复踩坑」的环境事实与流程约束；本板放项目状态。
