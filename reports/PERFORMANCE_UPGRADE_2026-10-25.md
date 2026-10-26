# OmniHarness 全栈性能与能力升级方案（2026-10-25）

> 范围：`main` 工作树（`7cb01fbe` + 未提交的 `desktop/src/main/window.ts` 改动），覆盖
> `src/**`（后端运行时/服务端）、`web/src/**`（前端）、`desktop/**`（Electron）、`crates/**`（Rust 原生）、
> `tests/**` 与 `scripts/**`（质量与交付链路）。
>
> 口径：只写**本机可复核**的数字与代码位置；每条结论标 `[实测]` / `[代码确证]` / `[推断]`。
> 本文件是方案，不改任何生产代码。所有耗时均来自 2026-10-25 本机（Windows / Node 22.20 / 8 核），
> 受 Defender、本机受限执行环境与当时负载影响；绝对数字用于**排序**，不作为对外承诺。

---

## 0. 结论摘要

### 0.1 一句话

**OmniHarness 当前的核心瓶颈不是模型能力，也不是算法，而是「全量假设」：**
每条关键路径都把「全量历史 / 全仓语料 / 全部事件 / 全部客户端」当成默认输入——

| 路径              | 全量假设                                         | 代价（本机）                                           |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------ |
| repo-map 失效复核 | 每次写类工具后重走全仓 + 读全部文件 + SHA1       | **1.0–2.4 s / 写步**（冷盘 7.8 s）`[实测]`             |
| 上下文压缩        | 每步对全部消息重做无损收缩与整段指纹             | **53–94 ms / 步 + 26.7 ms / 步** `[实测]`              |
| 会话列表          | 每次 `sessions.list` 全量解析全部 `.jsonl`       | 409 档 **4.72 s 冷**、**194 ms 同步阻塞** `[实测]`     |
| 会话打开          | `threads.get` 整档读入 + 逐行 parse + 整段序列化 | 50 MB 档峰值 150–200 MB `[代码确证]`                   |
| SSE 事件          | 一条事件广播给全部客户端，无会话订阅             | 客户端数 × 事件字节（含 5 MiB 截图）`[代码确证]`       |
| 前端流式          | 每个增量重新解析全文 Markdown + 重高亮全部代码块 | 20k 字回复 ≈1.8 s 解析；代码块 ≈18 s CPU `[实测/估算]` |

把「全量」改成「增量 / 订阅 / 分页 / 缓存」，就是这份方案的主动脉。

### 0.2 五个系统性瓶颈 + 一个元瓶颈

1. **每步固定同步成本 + 写步秒级索引复核**（后端热路径，P0）。
2. **历史即数据面**：列表/打开/用量/SSE 都按「全部」加载（服务端，P0）。
3. **渲染路径无缓存、无 memo、无并发保护**：流式 markdown/hljs 每帧全量、Context 每帧新对象、
   右栏文件每帧重新分词（前端，P0）。
4. **桌面交付链**：冷启动 17.7 s、包体 687 MB（含 128 MB 死重量）、自动更新断链、安装包未签名（桌面，P0）。
5. **反馈环**：构建 64 s、类型检查 41.5 s、全量单测 578 s、pre-commit ~60 s（工程效率，P1）。
6. **元瓶颈**：除了「首屏 gzip 预算」与「门禁耗时预算」，**没有任何性能 SLO/回归门禁**。
   因此上述问题可以长期存在而无人被红灯拦住——这是本方案 Wave 0 必须先补的。

### 0.3 十个最高杠杆动作（按收益/成本排序）

| #   | 动作                                              | 预期收益                                      | 成本 | 波次 |
| --- | ------------------------------------------------- | --------------------------------------------- | ---- | ---- |
| 1   | repo-map 改为「watcher 变更路径增量 + 异步让出」  | 写步 −2.4 s；事件循环不再秒级卡死             | M    | W1   |
| 2   | 压缩器加内容 memo + 滚动指纹 + 增量摘要           | 每步 −50～90 ms；摘要 prompt token −70～90%   | M    | W1   |
| 3   | SSE 解析器改增量扫描；OpenAI 请求体只序列化一次   | 大事件 195 ms → ~13 ms；每次模型调用 −23.5 ms | S    | W1   |
| 4   | 会话摘要旁路索引 + 分页 + 并发闸                  | 列表 4.7 s → <0.2 s；打开只取尾部 200 条      | M    | W2   |
| 5   | SSE 会话订阅 + 字节背压 + 心跳 + gap 帧           | 并行标签页字节 −3～5×；半开连接 20 s 发现     | M    | W2   |
| 6   | 静态资源压缩/ETag/immutable/Range                 | 首屏 2.37 MB → ~0.3 MB；刷新 0 传输           | S    | W2   |
| 7   | 前端 Markdown/hljs 缓存 + 稳定段渲染              | 流式 CPU −80～95%；代码块场景 10×+            | M    | W3   |
| 8   | memo 化 + Context 拆分 + 右栏文件 memo + rAF 布局 | 流式整树重渲染 −30～50%；文件预览 10–100×     | M    | W3   |
| 9   | 桌面包裁剪 + 启动并行/分阶段 + 健康自愈           | 冷启 17.7 s → <5 s；包 687 → ~470 MB          | M    | W4   |
| 10  | 测试分层/分片 + 增量构建 + CI 制品复用            | 本地反馈 578 s → ~180 s；CI −20～30%          | M    | W5   |

### 0.4 量化目标（验收口径）

| 指标                        | 现状                          | 目标                    | 说明                 |
| --------------------------- | ----------------------------- | ----------------------- | -------------------- |
| `npm run build`（clean）    | 63.9 s                        | ≤45 s（增量 ≤10 s）     | 见 §2.5              |
| `tsc --noEmit`              | 41.5 s                        | ≤30 s                   | 增量 tsbuildinfo     |
| 全量单测                    | 578 s / 599 文件              | fast 层 ≤180 s          | 分层 + 分片          |
| 会话列表 p95（1k 档）       | 4.72 s 冷（热路径未单独计时） | ≤150 ms                 | 摘要旁路索引         |
| `threads.get` 首屏          | 全档                          | ≤200 ms / ≤1 MB         | 尾页 200 条          |
| SSE 单客户端缓冲            | 65 × 单帧（最坏 325 MB）      | ≤16 MB 硬上限           | 字节背压             |
| 首屏 JS                     | 271.2 KB gzip                 | ≤220 KB gzip            | 懒加载 hljs/Settings |
| 流式帧 CPU                  | 20k 字 ≈1.8 s 累计            | ≤200 ms 累计            | 缓存 + 稳定段        |
| 每步 harness 开销（非模型） | 65–105 ms + 写步 2.4 s        | p95 ≤20 ms；写步 ≤50 ms | 热路径               |
| 桌面包                      | 687 MB / 195.5 MB 安装包      | ≤500 MB / ≤150 MB       | 裁剪                 |
| 桌面冷启动                  | 17.7 s（0.2.0 安装版）        | ≤5 s                    | 并行 + 分阶段        |
| 全仓索引堆                  | 108.9 MB                      | ≤80 MB                  | 结构优化             |

---

## 1. 审计基线与方法

### 1.1 规模（`[实测]` 2026-10-25）

| 区域       | 文件        | 行数    | 备注                               |
| ---------- | ----------- | ------- | ---------------------------------- |
| `src/`     | 1,236 `.ts` | 150,226 | 40 个子域；`ports/` 408 文件       |
| `web/src/` | 178         | 27,844  | React 19 + Vite                    |
| `tests/`   | 671         | 98,872  | 643 unit / 7 integration / 107 web |
| `desktop/` | 16 `.ts`    | 2,167   | Electron 44，主进程 + preload      |
| `crates/`  | 40 `.rs`    | 6,330   | 6 个 crate                         |

单测规模：node **642 文件 / 4,019 通过 / 4 跳过**，web **102 文件 / 569 通过**（看板 §57）。
全量墙钟 **578.1 s**（599 文件，8 核；`vitest-full.log`，2026-10-22）——比当前树少 ~8% 文件。

### 1.2 关键实测（本机）

| 指标                         | 数值                                          | 命令/来源                                                            | 备注                                |
| ---------------------------- | --------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------- |
| 服务端构建                   | **63.9 s**                                    | `npm run build`                                                      | clean；并发审计时曾达 188 s，不采用 |
| 类型检查                     | **41.5 s**                                    | `npx tsc -p tsconfig.json --noEmit`                                  | 同上                                |
| 仅 emit（无 d.ts/sourcemap） | **47.8 s**                                    | `tsc --outDir .tmp/emit-nodts --declaration false --sourceMap false` | 声明 emit 是主要增量                |
| Web 首屏                     | **271.2 KB gzip / 794.3 KB**                  | `scripts/webBundleBudget.mjs`                                        | 产物 2026-10-25 12:39               |
| Web CSS / 异步块             | 27.1 KB / 103.7 KB gzip                       | 同上                                                                 | KaTeX 77.7 KB，确为懒加载           |
| 全仓索引                     | **108.9 MB heap / 281 MB RSS**                | `REASSESSMENT_2026-10-24` §1                                         | 2,043 文件 / 32,475 符号            |
| BM25 查询                    | 0.077 ms                                      | 同报告                                                               | 1000 次 5 词查询                    |
| 会话档案                     | **409 个 / 5.3 MB**                           | `~/.omniharness/sessions`                                            | 最大单档 0.79 MB                    |
| `sessions.list` 冷           | **4.72 s**（IO）/ **194 ms**（同步 parse）    | 本机 Node 脚本                                                       | Win + Defender 冷缓存               |
| 桌面冷启动                   | **17.7 s**                                    | 安装版 0.2.0 主进程日志                                              | spawn→harness ready                 |
| 桌面体积                     | **687 MB / 13,304 文件**；安装包 **195.5 MB** | `win-unpacked` + NSIS                                                | 含 128.2 MB `onnxruntime-web`       |
| 上下文微基准                 | 1.8 ms/轮（300 条 / 2.5 MB）                  | `npm run perf:context`                                               | 只覆盖估算 + 前缀，不是全路径       |

> **测量边界（必须保留）**
>
> 1. `web:build` 在 本机受限执行环境下会因 esbuild 服务 `spawn EPERM` 失败（本机复现），故 271.2 KB
>    取**已有产物**（12:39 构建），不是本次新建。这不是仓库缺陷，换普通终端即可跑。
> 2. 桌面 17.7 s / 687 MB 来自**已安装的 0.2.0**，当前源码已修启动页路径；重打包后需复测。
> 3. 构建/单测耗时对本机负载极敏感；本方案所有「前后对比」要求在同一台机器、空载、取 3 次最小值。
> 4. `sessions.list` 4.72 s 是**冷文件缓存 + Defender** 的最坏值；热路径仍要付 409 次 stat 与
>    活跃档整档重解析，不能据此认为「只有冷启动慢」。

### 1.3 已经做得很好、不能为了优化而推翻

- **事件溯源 + 追加落盘 + 回卷对齐**：`jsonlStorage` 只序列化 tail，`EventPersister` 有 `hasUnsaved`
  才全量重写；二次方写放大已消除。
- **上下文投影增量缓存**：`ContextAssembler.build` 只投影新增事件，1.48 MB 上下文实测 **0.32 ms/步**。
- **token 双层 memo**：`WeakMap<message,text>` + LRU 512 + 零分配 CJK 计数。
- **前缀缓存设计**：repo-map 放唯一尾消息、稳定 system 头、Anthropic 滚动断点。
- **工具暴露 plan**：33 工具 schema 5,250 → 953–1,677 token（省 68–82%）。
- **工具调度**：读并行 / 写屏障 / 有界并行 8 / `MUTATING_TOOL_NAMES` 单一真相。
- **前端**：50 ms 节流 + 收尾 flush、虚拟化 + 实测块高 + `holeBoost`、KaTeX 懒加载占位升级、
  hljs core + 18 门语言、面板 lazy + idle 预取、非受控 textarea。
- **质量纪律**：门禁单一实现、fail-closed、原子构建换入、真实 Chrome 判据、重判据资源池。

**这些是本仓相对同类项目的真实优势；本方案的全部改动都必须以「不破坏它们」为前提。**

### 1.4 审计覆盖与边界

- **逐行/逐文件深读**：后端热路径（`core/`、`context/`、`search/`、`ports/` 契约）、
  服务端（`server/` 60 文件、存储、审计）、前端 178 文件、桌面 16 文件与 `crates/` 40 文件、
  适配层 257 文件的关键路径、`tests/` 与 `scripts/` 的构建/门禁链。
- **全仓模式扫描**（grep）：同步 IO、`JSON.parse/stringify` 大对象、`setInterval/setTimeout`、
  `React.memo/useMemo/startTransition`、`AbortController`、`fetch`/dispatcher、`any`/`@ts-ignore`、
  TODO/FIXME、`allEvents()`、`readFileSync`、`appendFileSync`。
- **实测探针**：`npm run perf:context`、`tsc --noEmit`、clean build、web bundle budget、
  全仓 walk+hash（本次独立复跑 2,219 文件）、桌面安装版日志与包体统计。
- **诚实边界**：没有对 150,226 行逐行通读；结论来自「调用链追踪 + 全仓扫描 + 单点实测」三者的交叉。
  未覆盖/未验证项集中在 §10.2，任何一条在实施前都应先补测量，不据推断排期。

---

## 2. 瓶颈详解（证据 → 根因 → 修法 → 验收）

### 2.1 后端热路径：每步固定成本与「写步 2.4 秒」

调用链：`Agent.continueSession` → `TurnRunner.run` → 每步 `StepRunner.run` →
`effectiveTools()` + `buildMessages()` → 模型 → `StepToolExecutor.run`。

#### F1（最高优先级）repo-map 变更检测：写步 2.4 s 全同步 `[实测]`

- 证据：`src/context/corpusIndexCache.ts:179` 循环内 `readFileSync`；`:409` 在 TTL 过期或失效后
  `contentHashes(root)`（全仓 walk + 读全部文件 + SHA1）；`:412` 紧接着 `statSignature(root)`
  （又一次全仓 walk + 逐文件 stat）。触发点：`src/core/stepToolExecutor.ts:270-274` 对
  `MUTATING_TOOLS`（**含 `shell`**）成功即 `invalidate()` → `indexedAt=0` → 下一步跳过 TTL 快路径。
- 实测（审计机，冷文件缓存）：walk 914 ms｜全仓 `readFileSync` 1,418 ms｜SHA1 97 ms｜
  `statSignature` 803 ms ⇒ dirty 一步 **≈2.4 s**（冷盘 7.8 s）。本机热缓存独立复测：2,219 文件
  walk 336 ms + 读哈希 674 ms = **1.01 s**，再加 stat 复核 ≈0.8 s ⇒ 热路径仍 **≈1.8 s**。
  干净但 TTL 过期一步 **≈0.8 s**。
- 影响：纯事件循环阻塞（SSE、停止按钮、`/healthz` 全停）；20 次 shell 的回合 **≈+48 s** 墙钟。
- 根因：变更检测粒度是「整根内容哈希」；watcher 只提供根级 dirty 位；`shell` 被当成一定改语料。
- 修法：
  1. `CorpusIndexCache.get` 的过期分支改走 `getAsync`：`walkAsync` + `fs/promises.readFile`，
     并分块哈希（复用已有 `EventLoopYield`）。
  2. `CorpusWatchRegistry` 暴露**变更路径集合**（`fs.watch` 已能拿到文件名），只哈希变化路径，
     直接喂 `CorpusIncrementalUpdater.update`；整根哈希只作 TTL 兜底。
  3. `StepToolExecutor` 不再按工具名硬失效：`write_file/edit/apply_patch/checkpoint` 精确失效；
     `shell` 只标「疑似」，下一步做一次异步 stat 复核。
  4. 删除 `statSignature` 与 walk 重复的第二段 stat。
- 验收：2,000 文件夹具，dirty invalidate + 下一次 `get` ≤50 ms；10 次 shell 回合零全仓哈希；
  `probe:recall` 命中率不降；事件循环延迟 p99 <20 ms。
- 风险：watcher 漏事件 → 保留 TTL 全根哈希兜底 + `corpusIndexAsync.test.ts` 深相等判据。

#### F2 压缩器 `shrink()` 每步重扫全部消息，零 memo `[实测]`

- 证据：`src/context/contextCompactor.ts:382-390`（**未达阈值也走** `this.shrink(messages)`）；
  `:172-181` 逐条 `shrinkLossless` + 两次 `byteLength`；
  `src/context/deterministicCompressor.ts:79-89,152-157`（split/map/join + `JSON.parse/stringify`）。
- 实测：`shrink()` 单次 **58.2 ms**（1.14 MB / 201 条；collapse 44.9 / minify 10.1 / byteLength 6.8）；
  `compact()` 无游标 **93.9 ms/步**、有游标 **53.2 ms/步**。
- 影响：30 步回合 1–2.8 s 纯 CPU，且都在请求前抬高 TTFT；随上下文线性 ⇒ 整回合 O(n²)。
- 修法：`DeterministicCompressor` 加内容键 LRU（Map 512–1024，照抄 `tokenCountCache` 模式）；
  字节度量只在内容变化时累加；`after === before` 直接跳过 report。
- 验收：1.14 MB 夹具 warm `shrink()` ≤5 ms；三条幂等/单调判据保持绿。

#### F3 压缩游标快路径每步整段 djb2 指纹 `[实测]`

- 证据：`contextCompactor.ts:286` + `:713-722` 逐字符循环。
- 实测：1.15 MB head **26.7 ms/次**，长会话每步都算。
- 修法：`WeakMap<ModelMessage, number>` 记忆单条指纹 + 按序滚动折叠；shapers 替换消息对象时
  WeakMap 自动失效（正是所需语义）。
- 验收：warm ≤0.2 ms/步；指纹不匹配时回退全量；回滚后行为判据不变。

#### F4 OpenAI 流式路径请求体序列化两次 `[实测]`

- 证据：`src/adapters/model/openAiCompatibleModel.ts:124` `buildRequest`（`:233` 已 stringify）
  → `:125` 又 `bodyOf` → `:127` 再次 stringify 覆盖。
- 实测：1.16 MB body 单次 10.5 ms、两次 34.0 ms；`sanitizeToolRounds`/`toWireMessages` 同样跑两遍。
- 修法：`buildRequest(request, guard, overrides?)`，stream 分支只序列化一次。
- 验收：stream 与 generate 的 body 逐字节一致；每次调用 −23.5 ms。

#### F5 工具暴露规划器每步重建 33 份 BM25 `[实测]`

- 证据：`src/core/stepContextBuilder.ts:426-436` 每步 `JSON.stringify(tool.parameters)` 重建语料；
  `src/core/toolExposurePlanner.ts:534-547` 重新分词/df/打分。
- 实测：**8.44 ms/步**。
- 修法：`WeakMap<ToolDefinition, tokens>` + 按 `(taskText, 工具名指纹, 注册表版本)` 单槽 memo。
- 验收：warm ≤0.5 ms/步；工具热插拔后 memo 失效。

#### F6 压缩是「全历史重摘要」而非增量 `[代码确证]`

- 证据：`contextCompactor.ts:403-422` `head = messages.slice(0, headEnd)` → `summarize(head)`；
  `:305-325` 的 `return undefined` 会打断游标复用；状态只存摘要文本，从不作为下一次摘要的种子。
- 影响：每次重折叠 = 一次全历史摘要（≈102k prompt，10–60 s、全价），长会话 10–30 次。
- 修法：两段式摘要（上次摘要 + `messages[state.compactedUpTo..headEnd]`）并提示「更新摘要」；
  `dropped > 0` 先试 `dropOldest` 再决定重摘；每 K=5 次或 head 增长 >50% 做一次全量重摘。
  给 `summarize()` 加 `headTokens` 与 `compaction.resummarize` 计数。
- 验收：第二次折叠摘要 prompt token ≤全量的 30%；`pass^k`/长任务评测不降；游标不变量判据全绿。

#### F7 SSE 解析 O(n²) `[实测]`

- 证据：`src/adapters/model/sseParser.ts:37-45` 每个 chunk 对**整个 buffer** 重新 `replace` + `split`。
- 实测（单 200 KB 事件）：200 KB chunk 12.5 ms｜8 KB 12.1 ms｜1 KB **61.7 ms**｜256 B **195.4 ms**。
- 修法：`searchStart` 增量找 `\n\n`，只归一被切出的块并 `slice` 消费；块尾 `\r` 留到下一轮。
- 验收：同一事件按 1/2/7 字节喂入，输出逐字节相同；1 KB chunk 200 KB 事件 ≤15 ms。

#### F8 `memory_search` 每次全量重建 BM25 `[实测]`

- 证据：`src/adapters/retrieval/bm25MemoryIndex.ts:49-51,100-105`；每条事件都置 dirty。
- 实测：`tokenize` 1 MB **530.6 ms**、`addDocuments` 1 MB 176.3 ms ⇒ 每次 search ≈0.7 s 同步阻塞。
- 修法：按 `indexed` 游标 `addDocument` 增量；`refreshAverageLength()` 修正均值；docs 正文截断 4 KB。
- 验收：1 MB 会话第二次 search ≤5 ms；命中顺序 golden 不变。

#### F9 三份独立 token 记账，breakdown 只为 UI 却每步必算 `[实测]`

- 证据：`src/core/stepRunner.ts:482-487`；`contextBreakdownEstimator.ts:101-106`；
  `contextCompactor.ts:113` 各一套 512 缓存。
- 实测：`breakdown.estimate` warm **3.34 ms/步**。
- 修法：单一 `TokenEstimator` 注入 compactor/breakdown/usage；快照改为按需（RPC 读取或每 N 步）。
- 验收：每步 ≤0.5 ms；容量面板口径不变。

#### F10 小项（合计 <2 ms/步，防未来放大）

每步 4–6 次 `eventLog.all()` 浅拷贝（`appendOnlyEventLog.ts:154-156`）；`deriveQueryText` 每步两次；
`effectiveTools` 每步两次 `list()`。修法：增加只读视图 `allView()`（带变异探针判据）、
query 只算一次、`list()` 按注册表版本缓存。

---

### 2.2 服务端：历史即数据面 + 传输未分区

#### S1 `sessions.list` / `usage.stats`：全量扫描、无分页、无并发闸 `[实测]`

- 证据：`src/server/services/session/sessionArchive.ts:227` `Promise.all` 一次 409 个 `readFile`；
  `sessionScanCache.ts:188,202` 整档 `readFile` + 逐行 `JSON.parse` 只为算摘要；
  `appServer.ts:213-233` 无 `limit/offset`；`usage()` 同构。
- 影响：冷 4.72 s、同步 parse 194 ms；活跃会话每追加一次就整档重解析；10k 档不可用。
- 修法：**摘要旁路索引** `<sid>.summary.json`（回合末写，原子 rename，带 `version/size/mtime` 校验）；
  list 只 stat；未命中回落现有解析；冷启动重建放 `worker_threads` 或分块让出；`Promise.all` 加
  8–16 并发闸；RPC 加 `offset/limit/since`（缺省保持旧行为，Web 先取 50）。
- 验收：1k 档夹具 list p95 ≤150 ms；结果与旧实现逐字段相等；旁路损坏/漂移自动回落。

#### S2 `threads.get` 整档加载 `[代码确证]`

- 证据：`src/core/agent.ts:404-409` → `jsonlStorage.ts:88` 整档 read + 逐行 parse；
  `httpServer.ts:383-385` 再整段 `JSON.stringify`；无 gzip/分页。
- 影响：50 MB 图像会话峰值 150–200 MB；TTFB = 全量序列化时间。
- 修法：`threads.get?before=<id>&limit=200` + `hasMore`；前端先取尾页、向上补拉；
  大 payload 用 `GET /files` 引用而非内联。
- 验收：50 MB 档首屏 ≤200 ms / ≤1 MB；`threads.rewind(keepEventId)` 不受影响。

#### S3 SSE 无会话过滤 `[代码确证]`

- 证据：`src/server/transport/sseFanout.ts:112-123` 对整个 `clients` 集合写同一帧；
  `serverEventBridge.ts:110` 每事件都广播；前端是在 **JSON.parse 之后**才按 sessionId 丢弃。
- 影响：C 个标签页 = C 份字节；30 张截图的回合单客户端 150 MB。
- 修法：`GET /events?thread=<id>` 订阅集（`Map<sid, Set<res>>` + 通配）；重放走同一过滤器；
  切会话时重订阅。`close` 与订阅表同一清理路径。
- 验收：两个客户端不同会话，各自 `size_download` 只含本会话；断线重放不缺不重。

#### S4 背压只有次数、无字节；无心跳、无 gap 信号 `[代码确证]`

- 证据：`sseFanout.ts:159-173` 仅 `write() === false` 计数；`sseBackpressureGuard.ts:11` 阈值 64；
  对比 `wsConnection.ts:31` 16 MiB 硬上限。全仓无 `: ping`。
- 影响：5 MiB 帧 × 65 = 325 MB/客户端；半开连接仍算在线，审批直发到不会响应的客户端。
- 修法：`writableLength + writableHighWaterMark` 超 16 MiB 直接 `end()`；20 s 心跳；
  历史淘汰时发 `event: gap` + `oldestSeq`，前端改走分页拉。
- 验收：慢客户端 RSS 有界；睡眠/断网 20 s 内识别；gap 帧可触发补拉。

#### S5 静态资源 no-store / 无压缩 / 无 ETag / 无 Range `[实测]`

- 证据：`httpServer.ts:404-410` 每请求 `readFile`，固定 `no-store`，无 `Accept-Encoding` 分支；
  `:399` 用 `startsWith(webDir)` 判越界（`web/dist-evil` 可通过）。
- 影响：`index-*.js` 794 KB → gzip 271 KB / br 220 KB；2.37 MB 每次刷新全量重下。
- 修法：构建期产出 `.br/.gz` 旁路（或首次压缩缓存）；`/assets/*` → `public,max-age=31536000,immutable`；
  `index.html` → `no-cache` + ETag；Range 用 `createReadStream`；越界改 `relative()` 判 `..`。
- 验收：首屏传输 ≤350 KB gzip；二次刷新 304/0 字节；`web/dist-evil` 403。

#### S6 请求路径同步 IO `[代码确证]`

- 证据：`safeFs.ts:70-87` `statSync/openSync/readSync` 被 async 路由 `httpServer.ts:456` 调用
  （HARD_READ_CAP 64 MiB）；`workspaceChanges.ts:90` 未跟踪文件无限读 + `.split('\n').map`；
  `workspaceGuard.ts:86,95` 每请求 2 次 `realpathSync`。
- 修法：`/files` 改 `createReadStream` + `pipeline`；changes 预览 maxBytes 1 MiB；
  realpath 结果按 (path, mtime) 缓存；新增 `safeReadFileAsync`。
- 验收：64 MB 下载期间事件循环延迟 p99 <20 ms；100 MB 未跟踪文件不再阻塞。

#### S7 审计哈希链每事件同步 append `[代码确证]`

- 证据：`src/server/services/auditSink.ts:143-154` SHA-256 + `appendFileSync`，调用点在
  每个事件的 `serverEventBridge.ts:109`；启动 `resumeChain()` 整档读。
- 修法：`createWriteStream` + 200 ms 组批；`audit.head.json` 存 seq/prev；64 MiB 轮转 + 流式 verify；
  `detail` 剥离 base64。
- 验收：1k 事件回合零同步写；启动 O(1)；跨轮转 verify 连续。

#### S8 安全/诊断小项

- 令牌进 stderr：`httpServer.ts:266` 打印 URL（含 `?token=`）→ 改成脱敏。
- SSE 重放窗口 256 帧 / 8 MiB 且超限静默：补 `gap` 信号。
- 双重序列化：SSE 与 WS 同时在线时同一事件 stringify 两次。

---

### 2.3 前端：每个增量都重做全文与整树

#### W1 流式卡片每帧全量解析 Markdown `[实测]`

- 证据：`web/src/ui/components/stream/StreamingAssistantCard.tsx:51` `renderMarkdown(text)`；
  `web/src/ui/markdown.ts:448-468` 无缓存直接 `getMd().render(text)`；`StreamView.tsx:589-596` 依赖 `streamText`。
- 实测：markdown-it 3.7–6.1 ms/次；20k 字回复 /800 帧 ≈1.8 s 纯解析 CPU（越流越慢）。
- 修法：`MarkdownRenderCache`（LRU 64，key=内容哈希+选项）；流式期只渲染「最后一个稳定块之前」
  - 尾部纯文本，`busy=false` 后整段渲染；`useDeferredValue`/rAF 合并到 60–100 ms。
- 验收：20k 字流式累计 ≤200 ms；视觉逐字节一致（快照）；无 XSS 回退。

#### W2 hljs 每帧重高亮、未标语言走 `highlightAuto` `[实测]`

- 证据：`markdown.ts:261-273`（`:268` `highlightAuto`）；已闭合代码块每帧从头重高亮。
- 实测：300 行 TS 45.7 ms；`highlightAuto` 120 行 30.8 ms；300 行块闭合后剩余 ~600 帧 ≈18 s CPU。
- 修法：`(code,lang)` LRU；流式期 `<pre>` 纯文本，落定后高亮（rAF 分帧）；未标语言禁用 auto
  或限定 3–5 门候选。
- 验收：含 300 行代码的 40 s 回复主线程长任务 0 个 >50 ms；落定高亮 ≤50 ms（可分帧）。

#### W3 每个 delta 重渲染整棵树 + Context 每帧新对象 `[代码确证]`

- 证据：`App.ts:476` 单一 `useState<AppState>`；`SessionController.ts:50-54` 每 flush patch；
  `StreamThrottle.ts:47` 50 ms（20 Hz）；`AppController.ts:618-627` 每次返回新 Context 对象；
  `web/src` 全仓 `React.memo` **0 处**、`startTransition/useDeferredValue` **0 处**、`useMemo` 仅 5 处。
- 修法：`React.memo` 包 `SessionPanel/StreamView/RightPanel/SettingsModal/Composer/FileTab`；
  Context 拆「静态服务」与「会话 tick」两个；`getContextValue` useMemo；流式文本走 `startTransition`；
  throttle 80–100 ms。
- 验收：React Profiler 单 delta commit 组件数下降 ≥60%；流式 CPU −30～50%；交互测试全绿。

#### W4 每帧强制同步布局 `[代码确证]`

- 证据：`StreamView.tsx:687-689` 逐块 `offsetHeight`；`:704-711` 不贴底时全块 `getBoundingClientRect`；
  `:719-728` 高度变化 `setMeasureTick` 再渲染一轮；`:592-595` 读 `clientHeight` 后写 `scrollTop`。
- 修法：只测新增/变化块（`ResizeObserver`）；measureTick 并入同一 rAF；scrollTop 写入放 rAF；
  滚动事件 rAF 合并。
- 验收：流式期间每帧 Recalculate Style/Layout ≤1 次；滚动 60 fps（DevTools）。

#### W5 右栏文件预览每帧重新分词（最坏项）`[实测]`

- 证据：`FileTab.tsx:33-52` → `CodeSurface.tsx:44-53` → `highlight.ts:357-374`，每次渲染整段
  tokenize（上限 40,000 字符）；`App.ts:407/239` 两处新建 FileTab，无 memo。
- 实测：40 KB ≈10 ms/帧 + 数千 span 协调 → 右栏开文件 + 流式 = 卡死级。
- 修法：`React.memo(FileTab)` + `useMemo(highlightCode(content, lang))`；CodeSurface 同样 memo。
- 验收：该场景每帧 ≤0.2 ms；切换文件才重算。

#### W6 每渲染 O(事件数) 派生 `[代码确证]`

- 证据：`StreamView.tsx:868` `revisionOf(events)` 全量扫；`:844` `TodoDockModel.latest(events)`；
  `StreamWindow.ts:149-151` 每次 `new Array(n+1)`；`:374-377` 每个 live input `JSON.parse`。
- 修法：并入已有 `StreamModelCache`；前缀和做版本化增量；partial JSON 缓存。
- 验收：3,000 事件会话每帧 ≤0.2 ms，GC 分配显著下降。

#### W7 事件数组 O(n) 复制 + O(n) 线性去重 `[代码确证]`

- 证据：`AppReducers.ts:49-52` `[...prev, ev]`；`:60-64` / `:99-102` 两次 `prev.some`；`:130` 浅拷贝。
- 修法：`Set` 维护已见 id；版本化 store + `useSyncExternalStore`；toolResults 结构共享。
- 验收：3,000 事件 append ≤0.05 ms；去重语义不变。

#### W8 Bundle 271.2 KB：可拆项与死重 `[实测/估算]`

- 构成估算：react-dom 58–62、react 4.5、markdown-it ≈44、hljs core+18 语言 40–48、应用 100–120。
- 死重：`format.ts:646-666` 的 `legacyRenderMarkdown` 运行期不可达（`markdownLibsReady()` 恒 true），
  仍进 entry 约 3–4 KB gzip；`SettingsModal` 30.8 KB 未懒加载。
- 修法：hljs 改「首次围栏才 `import()`」+ 占位升级（复用 KaTeX 模式）；删除/懒加载 legacy；
  SettingsModal lazy；**不要**单拆 markdown-it（首条消息多一次往返）。
- 验收：entry ≤220 KB gzip；首个代码块仍正确高亮；`web:budget` 预算收紧到 240。

#### W9 启动请求与竞态 `[代码确证]`

- 证据：`SessionPanel.tsx:230-264` 先 `listWorkspaces` 再依赖 `wsPath` 拉 `listFs(3)`，启动跑两次
  全树扫描，而文件树默认收起；`AppController.ts:301-322` + `PermissionPicker` 首屏约 7 个 RPC；
  全仓 `AbortController` **0 处**；`SessionController.ts:220-248` `loadThread` 无 requestId 守卫。
- 修法：`listFs` 延迟到首次展开；启动 RPC 去重/并行；`loadThread` 加 requestId；切会话 abort 旧请求。
- 验收：首屏 RPC ≤4；快速切会话不再串写；目录扫描 0 次（未展开时）。

---

### 2.4 桌面：启动、体积、更新三条断裂

#### D1 冷启动 17.7 s（安装版 0.2.0）`[实测]`

- 日志：`06:12:24.209 spawn harness` → `06:12:41.937 harness ready` = **17.728 s**；
  首条 harness 日志在 spawn 后 **7.79 s**，vault 横幅再 **9.80 s**；同时
  `06:12:25.426 ui load failed ... app.asar/dist/loading.html`（旧包启动页缺失）。
- 代码：`desktop/src/main/main.ts:230-239` `await supervisor.start()` 后才 `loadHarness`；
  当前源码 `window.ts:103` 已改 data URL，但安装包早于修改 33 分钟（未重建）。
- 根因（部分推断）：13,232 文件/316.7 MB 首次按需加载 + Defender 扫描；`buildConfig` 同步段过长；
  旧包启动页路径错误。
- 修法：窗口/启动页立即显示 + 进度阶段；harness 与本地状态并行初始化；`buildConfig` 拆分/懒加载；
  30 s 就绪超时改为分阶段可诊断；重打包验证。
- 验收：冷启 ≤5 s 到可交互；harness ready ≤3 s；失败时 UI 显示阶段与日志路径。

#### D2 包体 687 MB / 安装包 195.5 MB `[实测]`

- harness 316.7 MB / 13,232 文件；`node_modules` 201.8 MB，其中 **`onnxruntime-web` 128.2 MB 死重**
  （`@huggingface` 被删但传递依赖残留）、`@img` 27.3 MB、`playwright-core` 13 MB、`@types` 2.3 MB、
  `native/omni_napi.old.node` 5.7 MB、27 个嵌套 `node_modules` 副本；Electron locales 48.3 MB。
- 根因：`desktop/scripts/stageHarness.mjs:50-77` 手工删依赖漏传递项；`cpSync` 整个 `native/`；
  两条 `extraResources` 覆盖同一 `node_modules`（重复拷贝，推断）。
- 修法：显式 runtime allowlist（或 `npm ci --omit=optional` + 明确保留）；删 ORT-web/@types/.old；
  locale 只留 `en-US`/`zh-CN`；加体积/文件数预算门禁。
- 验收：harness ≤180 MB；安装包 ≤150 MB；`npm run desktop:start` 全功能 smoke 通过。

#### D3 自动更新断链、安装包未签名 `[实测]`

- 证据：`desktop/electron-builder.yml:48-52` `releaseType: draft`；GitHub 最新 `v0.2.0` 资产只有 tgz，
  无 `latest.yml`/Setup；`desktop.yml:71-81` 只 `--dir`；`Get-AuthenticodeSignature = NotSigned`。
- 影响：启动 10 s 后检查必然 error；用户永远收不到更新；SmartScreen 拦截。
- 修法：tag 触发 `npm run dist`，上传 `latest.yml` + 安装包并发布；签名证书 + `publisherName` +
  `verifyUpdateCodeSignature`；实跑 N-1 升级。证书是外部依赖，未就绪时至少发布 checksum 并明示未签名。
- 验收：安装 N-1 → 检查更新 → 下载 → 重启后版本 +1；签名验证通过。

#### D4 Rust native 默认加载但几乎不用 `[实测]`

- 证据：`argParser.ts:305` `native=true` → `runtime.ts:141` 每次 `require` `.node` + `ping`（实测 320 ms）；
  `nativeBackend.ts:122-124` `supports()` 恒 false ⇒ 工具全走 JS；token FFI 默认关。
  `omni-cli.exe` 未打包 ⇒ `windows-native` 沙箱在安装版不可用。
- 修法：native 默认 false 或懒加载；要么接一个逐字节等价的工具，要么移出默认包；
  补 `omni-cli` 或从桌面设置隐藏该 profile。
- 验收：默认启动不再 require `.node`；显式开启时功能可用。

#### D5 崩溃/卡死无自愈 `[代码确证]`

- 证据：`harnessSupervisor.ts:150-170` 只在 `exit` 时 emit；ready 后不再探活；`restartHarness` 无退避；
  启动窗口内被杀可能留孤儿（stdin 监听在 server 起来后才 attach）；ready 文件不 sweep。
- 修法：10 s `/healthz` 心跳；指数退避自动重启（1/2/4/8/16 s，上限 5）；Windows Job Object
  `KILL_ON_JOB_CLOSE`；启动时 sweep 旧 ready 文件。
- 验收：kill harness 后 UI 自动恢复；连续崩溃 5 次后停止并给出诊断；无孤儿进程。

#### D6 安全/常驻小项

- CSP `connect-src/frame-src http://127.0.0.1:*` 过宽、`script-src 'unsafe-inline'`；
  深链 `workspace` 任意存在目录直接切换（`main.ts:425-438`）；`backgroundThrottling:false` +
  托盘常驻保持完整 renderer 轮询。修法见 §5 安全项。

---

### 2.5 工程效率：反馈环与门禁

#### T1 没有「快层」：`test:fast` = 全量 578 s `[实测/日志]`

- 证据：`package.json:95` 无过滤；`tests/unit` 643 文件；34 个文件 >20 s（headless 100.8、
  serverConfigStore 64.7、sqliteLazyLoad 62.5、cliSystem 52.8、dpapi 44.2）；CI 0 处 `--shard`。
- 修法：复用 `tests/setup/heavyResource.ts` 名单拆 `fast/heavy/integration` 三 project；
  CI `--shard=1/4..4/4`；`test:fast` 只跑 fast。
- 验收：本地 fast ≤180 s；CI 单 OS ≤4 min；失败定位仍精确。

#### T2 反馈环里没有测试；`test:fast` 依赖 dist `[代码确证]`

- 证据：pre-commit 只跑 10 条静态门禁；pre-push 只查推送目标；45 个单测引用 `dist/`。
- 修法：pre-commit 加 `vitest related --run --changed HEAD`（仅 fast，预算 30 s）；dist 依赖文件
  打 `@heavy`/移 integration；pre-push 跑 fast。
- 验收：本地逻辑错误在提交前被拦；干净树不再假红/旧 dist 假绿。

#### T3 同一次编译在 CI 跑 3 遍；tsc 非增量 `[代码确证]`

- 证据：`prepare: tsc` 让每个 job 的 `npm install` 全量 emit；gate 再 typecheck+build；
  test job web:build 后 `test:integration` 又 build+web:build；`tsconfig.json` 无 `incremental`。
- 修法：`prepare` 改 `tsc --noEmit` 或删除；加 `incremental` + `.tsbuildinfo`；gate 上传
  `dist`/`web/dist`，其余 job 复用；integration 加 `--skip-build`。
- 验收：CI 墙钟 −20～30%；`npm install` 不再编译全仓。

#### T4 类型层在 CI 从未执行 `[代码确证]`

- 证据：workflows 中 `gate:typed`/`lint:typed`/`gate:budget` 0 命中；`gateBudget` 并发测，
  `runGates --tier=typed` 顺序执行，预算口径不一致。
- 修法：CI gate job 加 `npm run gate:typed`；两项并发或预算改串行口径；budget 进 nightly 并落 p50/p95。
- 验收：`no-floating-promises` 等三条规则真正阻断；typed 墙钟 ≤30 s。

#### T5 覆盖率测错对象、容差过宽 `[代码确证]`

- 证据：只跑 `node tests/unit`；聚合只算被执行文件；容差 2.5 点；只卡行覆盖；web 178 文件零覆盖。
- 修法：web 接 v8+jsdom（排除 Chrome 判据）；分母改 include 全集；容差 0.5；行+分支双阈值；
  integration 纳入。
- 验收：未 import 模块进入分母；真实回退 1 点即红。

#### T6 Flaky 源与超时掩盖 `[代码确证]`

- 证据：0 处 `useFakeTimers`；15 文件 deadline 轮询、19 文件真实 sleep；3 处硬墙钟断言；
  `testTimeout 120000`/`hookTimeout 180000`。
- 修法：抽 `clock`/`waitFor(cond)`；文件级 timeout 分层（heavy 才 120 s）；flaky 名单 `retry:1` + 记录。
- 验收：假红率下降；慢与挂可区分。

#### T7 元门禁自身成本与假阴性 `[代码确证]`

- `auditStandards --delta` 先全扫 1,236 文件；architectureGate 用正则抽 import，环白名单是成员集合
  ⇒ 白名单成员之间新增环永远合法；pre-commit ~60 s。
- 修法：delta 先判 staged 空再 walk；import 图用 TS API 一次解析并复用；环白名单改边级；
  `--strict` 纳入环；每条门禁计时。
- 验收：pre-commit ≤20 s p95；新增环即红。

---

## 3. 目标架构：从「全量」到「增量 + 订阅 + 分页 + 预算」

### 3.1 四条原则

1. **增量优先**：任何「每步/每次请求」执行的逻辑，输入必须是 delta 或带版本/指纹的缓存。
2. **订阅优先**：传输层按会话/主题分区，客户端只收自己订阅的字节。
3. **分页优先**：历史读取默认「尾页 + 向上补拉」，不默认整档。
4. **预算优先**：每个用户可感知的路径都有绝对预算 + 相对回归阈值，超了红。

### 3.2 性能仪表化（Wave 0 的产物）

新增 `src/observability/perfTrace.ts`（或扩展现有 span）：

- 后端：`turn.total`、`step.context.build`、`step.tools.plan`、`step.compaction`、
  `step.model.request`、`step.tool.exec`、`repoMap.invalidate`、`repoMap.get`、
  `rpc.<method>`、`sse.broadcast`、`sse.bytes`。
- 前端：`perf.mark('stream.delta')`、`markdown.render`、`highlight`、`commit`、
  Long Task Observer（仅 `?perf=1` 或 dev）。
- 桌面：`main.spawn`、`harness.firstByte`、`harness.ready`、`ui.loaded`、`ui.interactive`。

输出：结构化日志 `perf.step` + `perf.snapshot` RPC（只读，限最近 N 条），CI 用 `--json` 消费。

### 3.3 预算门禁

新增 `scripts/perfGate.mjs` + `scripts/perfBudget.json`：

| 预算键                | 口径          | 初始阈值 | 失败策略  |
| --------------------- | ------------- | -------- | --------- |
| `tscNoEmitMs`         | 空载 3 次最小 | 45,000   | 超 15% 红 |
| `buildMs`             | 空载 2 次最小 | 75,000   | 超 15% 红 |
| `webEntryGzipKb`      | `web:budget`  | 240      | 绝对      |
| `stepOverheadP95Ms`   | 夹具 20 步    | 20       | 绝对      |
| `repoMapInvalidateMs` | 2k 文件夹具   | 50       | 绝对      |
| `sessionListP95Ms`    | 1k 档夹具     | 150      | 绝对      |
| `threadFirstPageMs`   | 50 MB 档      | 200      | 绝对      |
| `sseBufferMaxMb`      | 慢客户端      | 16       | 绝对      |
| `desktopHarnessMb`    | stage 后      | 180      | 绝对      |
| `desktopInstallerMb`  | NSIS          | 150      | 绝对      |
| `desktopColdStartMs`  | 安装版日志    | 5,000    | 绝对      |

执行策略：

- **PR**：只跑轻量（`webEntryGzipKb`、`repoMapInvalidateMs`、`stepOverheadP95Ms`），噪声大；
- **nightly**：完整 perfGate，结果入库（JSON），相对基线 +15% 红；
- **release**：安装包体积/冷启动/更新链必过。

---

## 4. 路线图（6 个波次，约 6 周）

> 依赖：W0 → W1 →（W2 ∥ W3）→ W4 → W5 → W6。
> 每个任务卡：目标 / 改动点 / 验收 / 收益 / 风险 / 工作量（S≤1 d，M≤3 d，L≤1 w）。

### Wave 0（2 天）：先让优化可证伪

| ID   | 任务                                                                 | 验收                                |
| ---- | -------------------------------------------------------------------- | ----------------------------------- |
| P0-0 | `PerfTrace` 分阶段打点（step/rpc/sse/web/desktop）                   | 20 步真实回合能导出每阶段 p50/p95   |
| P0-1 | `scripts/perfGate.mjs` + 预算 JSON                                   | 本地/CI 可跑，超预算非零退出        |
| P0-2 | 基准夹具：2k 文件仓库、1k 会话档、50 MB 档、40 KB 文件、300 行代码块 | 夹具可重复生成，纳入 tests/fixtures |
| P0-3 | 前端 `?perf=1` 长任务/帧标记                                         | Profiler 可直接对照                 |

### Wave 1（4 天）：后端热路径

| ID  | 任务                                          | 预期                          | 工作量 |
| --- | --------------------------------------------- | ----------------------------- | ------ |
| B1  | repo-map 增量 + 异步 + shell 不硬失效（F1）   | 写步 −2.4 s                   | M      |
| B2  | 压缩 memo + 滚动指纹（F2/F3）                 | 每步 −50～115 ms              | M      |
| B3  | 增量摘要 + dropOldest 优先（F6）              | 摘要 token −70～90%           | M      |
| B4  | SSE 解析增量 + OpenAI 单次 stringify（F7/F4） | 大事件 −180 ms；每调用 −23 ms | S      |
| B5  | 暴露规划 memo + 单 token 估算器（F5/F9）      | 每步 −11 ms                   | S      |
| B6  | memory BM25 增量（F8）                        | search −0.7 s                 | S      |

**Wave 1 出口判据**：20 步含 10 次 shell 的回合，harness 非模型开销从 ~26 s 降到 <1 s；
`probe:recall`、压缩不变量、回卷判据全绿。

### Wave 2（4 天）：数据面与传输

| ID  | 任务                                               | 预期             | 工作量 |
| --- | -------------------------------------------------- | ---------------- | ------ |
| S1  | 会话摘要旁路索引 + list 分页 + 并发闸（S1）        | 4.7 s → <0.2 s   | M      |
| S2  | `threads.get` 尾页分页（S2）                       | 50 MB 首屏 ≤1 MB | M      |
| S3  | SSE 会话订阅（S3）                                 | 并行字节 −3～5×  | M      |
| S4  | 字节背压 + 心跳 + gap（S4）                        | 单客户端 ≤16 MB  | S      |
| S5  | 静态压缩/ETag/immutable/Range + 越界修正（S5）     | 2.37 MB → 0.3 MB | S      |
| S6  | 流式 `/files` + changes 上限 + realpath 缓存（S6） | 零事件循环阻塞   | S      |
| S7  | 审计异步批量 + 轮转 + 脱敏（S7/S8）                | 1k 事件零同步写  | M      |

### Wave 3（5 天）：前端渲染

| ID  | 任务                                         | 预期              | 工作量 |
| --- | -------------------------------------------- | ----------------- | ------ |
| W1  | markdown/hljs 缓存 + 稳定段流式（W1/W2）     | 流式 CPU −80～95% | M      |
| W2  | memo/Context 拆分/startTransition（W3）      | 整树 commit −60%  | M      |
| W3  | rAF 滚动/测量 + Composer（W4）               | 每帧 ≤1 次 layout | S      |
| W4  | FileTab memo（W5）                           | 文件预览 10–100×  | S      |
| W5  | 事件 store/派生缓存（W6/W7）                 | 每帧 ≤0.2 ms      | M      |
| W6  | bundle 拆 hljs/Settings/legacy（W8）         | 271 → ≤220 KB     | S      |
| W7  | 请求守卫/AbortController/listFs 懒加载（W9） | 首屏 RPC ≤4       | S      |

### Wave 4（5 天）：桌面与发布

| ID  | 任务                                                 | 预期          | 工作量 |
| --- | ---------------------------------------------------- | ------------- | ------ |
| D1  | stage allowlist + locale/旧产物裁剪（D2）            | 687 → ~470 MB | M      |
| D2  | 启动并行 + 分阶段进度 + buildConfig 懒加载（D1）     | 17.7 s → <5 s | M      |
| D3  | 健康心跳 + 退避重启 + Job Object + ready sweep（D5） | 自愈          | M      |
| D4  | 签名 + latest.yml + tag 发布 job + N-1 升级（D3）    | 更新可用      | L      |
| D5  | native 默认关/懒加载 + omni-cli 打包决策（D4）       | 启动 −0.3 s   | S      |
| D6  | CSP/深链/托盘节流（D6）                              | 安全与电量    | S      |

### Wave 5（4 天）：工程效率

| ID  | 任务                                             | 预期             | 工作量 |
| --- | ------------------------------------------------ | ---------------- | ------ |
| T1  | 测试三分层 + CI 分片（T1）                       | 578 → ≤180 s     | M      |
| T2  | pre-commit 相关测试 + pre-push fast（T2）        | 本地拦截         | S      |
| T3  | 增量 tsc + CI 制品复用 + prepare 改 noEmit（T3） | CI −20～30%      | M      |
| T4  | typed 门禁进 CI + 预算口径统一（T4）             | 3 条规则生效     | S      |
| T5  | 覆盖率分母/阈值/前端纳入（T5）                   | 真回退即红       | M      |
| T6  | flaky 时钟/超时分层（T6）                        | 假红 −70%        | M      |
| T7  | 元门禁增量/边级环/计时（T7）                     | pre-commit ≤20 s | M      |

### Wave 6（2–3 周）：能力补齐（详见 §5）

优先级：**子代理死接线（1 行级）→ MCP 暴露/取消 → shell 外溢/read_file 流式 → 沙箱全 spawn →
模型适配器模板 + tool_choice/代理 → 协议（MCP server/ACP/A2A/AG-UI）→ 长任务评测 → 安全 PDP →
记忆图/巩固（仅在评测证明有增益后）**。

---

## 5. 能力短板矩阵（「全部短板」的清单与归属）

评级：C0 缺失 / C1 原型 / C2 可用 / C3 生产级 / C4 领先。

| 能力          | 现状 | 目标 | 关键缺口（证据）                                                                                          | 归属             |
| ------------- | ---- | ---- | --------------------------------------------------------------------------------------------------------- | ---------------- |
| 上下文工程    | C3   | C4   | 全量复核/压缩成本（F1–F3/F6）                                                                             | W1               |
| 长时程执行    | C2   | C3   | 机制在（progress/checklist/compaction），缺小时级可复核评测；`eval:long` 未形成回归门禁                   | W6               |
| 工具执行      | C3   | C4   | shell >1 MiB 杀进程；`read_file` 64 MiB 整读；沙箱只包 shell                                              | W6               |
| 子代理/工作流 | C2   | C3   | `portsOf` 缺 `fragments` ⇒ 子代 systemPrompt=0；空技能表；子代理步数默认不限                              | W6（最高性价比） |
| 模型接入      | C2   | C3   | 5 套模板重复；无 `tool_choice`/`parallel_tool_calls`；Responses 丢图；无代理/keep-alive；无总时限         | W6               |
| MCP           | C2   | C3   | 工具绕过暴露规划器；调用不可取消；connect 串行；无 per-server allow-deny；server 侧仅 discover/resultType | W6               |
| A2A           | C1   | C2   | 只有 card/message/get；缺 stream/cancel/subscribe                                                         | W6               |
| ACP           | C0   | C2   | 无编辑器入口                                                                                              | W6               |
| AG-UI         | C0   | C2   | 无事件适配层（现有 SSE/RPC 可复用）                                                                       | W6               |
| 记忆          | C2   | C3   | trust/decay/冲突已有；缺时间图/巩固；效果未证                                                             | W6（评测后）     |
| 安全边界      | C2   | C3   | 字符串 provenance；无 per-action 授权；MCP 工具描述未哈希固定；审计未签名                                 | W6               |
| 可观测性      | C3   | C3   | 有 OTLP/semconv；缺每步性能阶段与 SLO 门禁                                                                | W0/W1            |
| 桌面产品化    | C1   | C3   | 启动/体积/更新/签名/自愈/安全（D1–D6）                                                                    | W4               |
| 评测          | C2   | C3   | 短任务 harness 有；长任务 20–30 条回归集未闭环；无 perf 回归                                              | W0/W6            |
| 工程质量      | C3   | C4   | 门禁强但慢、覆盖率错位、flaky、CI 不跑 typed                                                              | W5               |

**「补齐全部短板」的诚实边界**：ACP/AG-UI/A2A 完整语义与 Windows 代码签名依赖外部条件
（协议版本演进、证书），本方案给的是可独立验收的分片；记忆图与自进化类能力在评测证明增益前
不进入默认路径（与现有「不声称未验证增益」的纪律一致）。

---

## 6. 每个波次的验收判据（新增测试清单）

| 判据                             | 类型        | 钉住什么                                              |
| -------------------------------- | ----------- | ----------------------------------------------------- |
| `repoMapIncremental.test.ts`     | 单测        | 2k 文件 dirty 后 ≤50 ms；只哈希变化路径；recall 不变  |
| `compactorHotPath.test.ts`       | 单测        | warm shrink ≤5 ms；指纹 ≤0.2 ms；幂等三定律           |
| `compactionDeltaSummary.test.ts` | 单测        | 第二次摘要 prompt ≤30%；`dropOldest` 优先；回滚不变量 |
| `sseParserChunking.test.ts`      | 单测        | 1/2/7 字节喂入逐字节相同；200 KB ≤15 ms               |
| `sessionSummarySidecar.test.ts`  | 单测        | 1k 档 p95；漂移回落；字段逐字相等                     |
| `threadPagination.test.ts`       | 集成        | 尾页 200 条；`hasMore`；rewind 不受影响               |
| `sseSubscription.test.ts`        | 集成        | 两会话隔离；重放过滤；gap                             |
| `staticCache.test.ts`            | 集成        | gzip/br、304、Range、`web/dist-evil` 403              |
| `markdownStreamPerf.test.ts`     | web         | 20k 字累计 ≤200 ms；快照一致                          |
| `fileTabMemo.test.tsx`           | web         | 流式期间 FileTab 不重分词                             |
| `sessionSwitchRace.test.ts`      | web         | 晚到响应不串写                                        |
| `desktopStartupBudget.test.ts`   | integration | 日志阶段 ≤5 s（可注入假时钟/夹具日志）                |
| `stageSizeBudget.test.ts`        | 单测        | harness ≤180 MB；禁用依赖不在列                       |
| `subagentFragments.test.ts`      | 单测        | 子代 systemPrompt token >0；技能可见                  |
| `mcpExposure.test.ts`            | 单测        | MCP 工具进入 plan 类别；可 `tool_search` 找回         |
| `perfGate`                       | CI nightly  | 预算表全绿；相对基线 +15% 红                          |

**回归护栏**：所有 Wave 1–3 改动必须同时跑
`npm run test:fast`（相关子集）+ `web:test` + `probe:recall` + `npm run test:determinism`；
涉及前端视觉的加一张 DOM 快照；涉及压缩/回卷的加变异探针（关掉优化必须变红）。

---

## 7. 风险、回滚与开关

| 风险                   | 影响           | 缓解                                        | 回滚                          |
| ---------------------- | -------------- | ------------------------------------------- | ----------------------------- |
| repo-map 增量漏事件    | 检索陈旧       | watcher + TTL 全根哈希兜底；recall 判据     | `OMNI_REPO_MAP_INCREMENTAL=0` |
| 压缩 memo 破坏前缀稳定 | 缓存命中下降   | 以内容为键；每步只改尾消息的现有不变量      | `OMNI_COMPACTION_MEMO=0`      |
| 增量摘要丢早期细节     | 长任务质量下降 | 每 5 次全量重摘；`pass^k` 回归              | `OMNI_COMPACTION_DELTA=0`     |
| 摘要旁路索引漂移       | 列表错误       | `version/size/mtime` 校验 + 回落全量解析    | 删除 sidecar 即恢复           |
| SSE 订阅表泄漏         | 内存增长       | `close` 同路径清理；连接数/字节指标         | `OMNI_SSE_FILTER=0`           |
| 前端稳定段渲染视觉差异 | 闪烁           | 只在 `busy=true` 用；落定整段渲染；快照判据 | UI 开关                       |
| 桌面裁剪误删运行时依赖 | 功能缺失       | 启动 smoke + 真实回合 smoke                 | 回退 allowlist                |
| 签名证书未就绪         | 更新不可用     | 先发 checksum + 明示未签名；证书到位再开    | 保留手动安装                  |
| 性能门禁噪声           | 假红           | nightly 取 p50、相对基线；PR 只跑轻量项     | 调整预算，不删门禁            |

**默认开关策略**：所有优化先以环境变量 opt-in 合入，跑一周真实会话与判据后翻默认；
翻默认时在同一提交里把开关测试改为「默认开 + 可关」。

---

## 8. 明确不做（避免过度工程）

1. **不重写事件溯源/内核**：现有追加落盘、回卷、压缩游标是资产，只做增量。
2. **不引入数据库/新运行时**：摘要索引与审计用 JSON sidecar + 原子写；保持依赖准入。
3. **不为 markdown-it 单拆 chunk**：首条消息会多一次往返；只拆 hljs/Settings。
4. **不关闭 `keepNames`**：可诊断性优先；体积从懒加载拿。
5. **不取消虚拟化/不做「全量渲染」**：现有 `StreamWindow` 是正确方向。
6. **不恢复榜单跑分**：长任务评测只作内部回归。
7. **不在 PR 上跑绝对性能门禁**：噪声会把门禁变成噪声源；nightly + release 才卡绝对值。
8. **不为省 token 牺牲召回**：任何暴露/检索优化必须保留 `tool_search` 与全量召回路径。
9. **不在未评测前声称记忆/自进化增益**：与看板「诚实边界」纪律一致。

---

## 9. 第一周执行清单（可直接照做）

**Day 1**

- 加 `PerfTrace` 与 `perf.snapshot`；给 `StepRunner.requestModel` 分阶段计时。
- 建 2k 文件 / 1k 会话 / 50 MB 档夹具；记录基线 JSON。
- 修 D1 的启动页（当前源码已改，重打包验证）+ 加启动阶段日志。

**Day 2**

- `scripts/perfGate.mjs` + 预算；CI nightly 接入。
- 前端 `?perf=1` 长任务面板；记录 20k 字流式基线。

**Day 3–4**

- B1 repo-map 增量：先做「shell 不硬失效 + 异步 get」，再做 watcher 路径增量。
- 判据：dirty 后 ≤50 ms，recall 不变。

**Day 5**

- B2/B3 压缩 memo + 滚动指纹；B4 SSE 解析 + 单次 stringify。
- 判据：warm shrink ≤5 ms；200 KB 事件 ≤15 ms；body 逐字节一致。

**Day 6–7**

- 复测：20 步写回合墙钟、事件循环延迟 p99、内存；把前后数字写回本文件 §1.2。
- 若 B1 未达 50 ms，回退到「只做异步 + shell 不失效」，watcher 增量留到第二周。

---

## 10. 附录：证据索引与未验证项

### 10.1 关键代码位置

| 主题                  | 位置                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| repo-map 全量复核     | `src/context/corpusIndexCache.ts:168-186,391-434,537-548`；`src/core/stepToolExecutor.ts:263-278`                                                                  |
| 压缩 shrink/指纹/摘要 | `src/context/contextCompactor.ts:172-181,286,375-429,713-722`；`src/context/deterministicCompressor.ts:79-89,152-157`                                              |
| 暴露规划              | `src/core/stepContextBuilder.ts:426-436`；`src/core/toolExposurePlanner.ts:449-453,534-547`                                                                        |
| SSE 解析              | `src/adapters/model/sseParser.ts:24-55`                                                                                                                            |
| 会话列表/用量         | `src/server/services/session/sessionArchive.ts:105-160,219-257`；`sessionScanCache.ts:163-210`                                                                     |
| 会话打开              | `src/core/agent.ts:404-409`；`src/adapters/storage/jsonlStorage.ts:88,181-206`                                                                                     |
| SSE 扇出              | `src/server/transport/sseFanout.ts:6-15,90-173`；`src/server/core/serverEventBridge.ts:109-110`                                                                    |
| 静态服务              | `src/server/transport/httpServer.ts:394-423`                                                                                                                       |
| 同步文件 IO           | `src/server/services/safeFs.ts:70-87`；`src/server/services/workspaceChanges.ts:90-98`                                                                             |
| 审计链                | `src/server/services/auditSink.ts:143-154,297-305`                                                                                                                 |
| 前端流式              | `web/src/ui/components/stream/StreamingAssistantCard.tsx:51`；`web/src/ui/markdown.ts:261-273,448-468`                                                             |
| 前端状态              | `web/src/ui/App.ts:476,534-537`；`web/src/ui/controllers/AppController.ts:618-627`；`web/src/ui/models/StreamThrottle.ts:47`                                       |
| 前端布局              | `web/src/ui/components/StreamView.tsx:592-618,683-729`；`web/src/ui/components/Composer.tsx:53-57`                                                                 |
| 桌面启动/体积         | `desktop/src/main/main.ts:230-239`；`desktop/src/main/harnessSupervisor.ts:100-180`；`desktop/scripts/stageHarness.mjs:30-77`；`desktop/electron-builder.yml:1-52` |
| 工程效率              | `package.json:70-97`；`tsconfig.json:1-40`；`.github/workflows/ci.yml`；`scripts/runGates.mjs:70-157`                                                              |

### 10.2 未验证 / 需要二次测量

1. 桌面 17.7 s 的阶段归因（首次加载/Defender/`buildConfig` 各占多少）——用 P0-0 的阶段日志复测。
2. `web:build` 在非沙箱环境的真实耗时（本次被 esbuild `spawn EPERM` 阻断）。
3. 真实 tool schema 总量与 `plan()` 的实际耗时（合成语料 33 工具）。
4. 真实 SSE chunk 分布（256 B/1 KiB/8 KiB/200 KB 四档为合成）。
5. 长会话回滚后投影缓存必然 miss 的每步成本（代码推断，未实测）。
6. 桌面包裁剪后哪些 optional 依赖仍被运行时实际 import（需 smoke 矩阵）。
7. 嵌套并发导致 429 的实际概率（适配层推断）。
8. `read_file` 大文件峰值内存（估算，未实测）。

### 10.3 复现命令

```powershell
# 基线
npm run build                                  # 63.9 s
npx tsc -p tsconfig.json --noEmit              # 41.5 s
npm run web:build; npm run web:budget          # 沙箱外执行
npm run perf:context                           # 1.8 ms/轮
node scripts/auditStandards.mjs --maturity

# 热路径（需按 §6 新测试补齐后）
node --cpu-prof scripts/profileContextHotpath.mjs
node --expose-gc -e "..."                      # 2k 文件索引夹具

# 桌面
Get-Content "$env:APPDATA\OmniHarness\logs\main-$(Get-Date -Format yyyy-MM-dd).log" |
  Select-String 'spawn harness|harness ready|ui load'
Get-ChildItem desktop\release\win-unpacked -Recurse -File |
  Measure-Object Length -Sum
```

---

## 11. 结语

本仓的工程底座（事件溯源、fail-closed、门禁、可复盘）在同类项目中是稀缺资产，**不需要重写**。
真正要做的是把「全量假设」逐条改成增量与订阅，并把这些改动钉在**可复核的预算**上。

按本方案执行，最先可感的三个变化是：

1. 写代码的回合不再被 2.4 s 的全仓索引复核拖住；
2. 会话列表/打开不再随历史增长而变慢；
3. 流式输出与桌面启动回到「跟手」的体感。

这三件事做完，再谈协议生态与记忆/进化，才有稳定的性能地基。

---

## 12. 实施记录（第一轮，2026-10-25）

> 本轮只落地了「可独立验证、低回滚成本」的一批；其余按 §4 波次继续。
> 所有改动均在 `main` 工作树，未提交。

### 12.1 桌面 App：硬编码 → 配置（本轮重点）

- 新增 `desktop/src/main/config.ts`：类型化配置 + 逐字段校验/夹取 + 告警；
- 新增 `desktop/desktop.config.json`：发布默认值（与代码默认值逐字段相等，测试核对）；
- 加载优先级：代码默认 → 发布/开发树文件 → `userData/desktop.config.json` →
  `OMNI_DESKTOP_CONFIG`；`electron-builder.yml` 把它打进 `resources/desktop.config.json`；
- 接线范围：`main.ts`（启动/切换/重启/深链/更新延迟/限流）、`harnessSupervisor.ts`
  （就绪超时/轮询/readyz 重试/优雅停/强杀/token 字节/就绪文件名/模型目录）、`ready.ts`、
  `window.ts`（尺寸/最小尺寸/背景色/菜单栏/后台节流）、`security.ts`（CSP 指令/权限）、
  `desktopState.ts`（最近工作区条数/最小窗口/默认开关）、`logger.ts`、`notifications.ts`、
  `ipc.ts`、`tray.ts`、`menu.ts`、`updateService.ts`、`lib/paths.ts`、`lib/args.ts`；
- 文档：`desktop/README.md` §4.1 写明合并顺序与示例；
- 测试：`desktop/scripts/test.mjs` 新增 5 例（发布 JSON ≡ 默认值、非法值夹取/回落、权限剔除、
  文件优先级、CSP 格式、自定义深链协议）。

**实测**（本机，`node --experimental-transform-types` 直跑源码；本机受限执行环境下 esbuild/vitest
会 `spawn EPERM`，故用等价断言脚本）：发布 JSON 与默认值深相等、6 条非法值告警、优先级
`1100 > 1000 > 默认`、状态存储夹取/最近工作区截断、`/readyz` 契约全部通过。

### 12.2 后端与服务端（第一批）

| 项             | 改动                                                                                                                                                                                                                     | 实测                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| F1（收窄）     | 新增 `REPO_MAP_INVALIDATING_TOOLS`：只有 `write_file/edit/apply_patch/patch_candidates/rollback` 立即失效；`shell/run_code/子代理` 交给 watcher + TTL                                                                    | 20 次 shell 回合不再付 1.0–2.4 s/次全仓哈希                                                                                         |
| F1（路径增量） | `CorpusWatchRegistry` 记录具体变更路径；脏时只读这些路径，内容未变即复用；内容变且文件集合不变 ⇒ 只重解析变化文件（`CorpusIncrementalUpdater`）；新增/删除回落全量。成功后 `statSig=''` 哨兵，watcher 干净时免 stat 全树 | 20 文件实测：同内容 `pathReuses+1/fullHashes+0`；改一个文件 `pathReuses+1/fullHashes+0`（只重解析 1 个）；新增文件才 `fullHashes+1` |
| F2             | `DeterministicCompressor` 加 1024 条 LRU（原文→收缩结果/字节数），未变化消息只计一次字节                                                                                                                                 | 200 条消息 warm 收缩 **0.1 ms**（cold 2.8 ms）                                                                                      |
| F3             | `headFingerprint` 单条消息片段 WeakMap 缓存 + 33^n 前缀折叠（内容原地改/对象换即重算）                                                                                                                                   | 1200 条 ≈1.08 MB：**16.28 → 0.217 ms warm（约 75×）**；与原 djb2 逐位一致                                                           |
| F4             | OpenAI 流式 `buildRequest(..., overrides)` 只序列化一次                                                                                                                                                                  | 回归判据钉住 `JSON.stringify` 恰好 1 次                                                                                             |
| F5             | `ToolExposurePlanner` 分词结果 512 条有界缓存                                                                                                                                                                            | 34 工具 plan：cold **5.26 ms** → warm **0.31 ms**（旧 8.44 ms/步）                                                                  |
| F7             | `SseParser` 增量分帧（只扫新增 + 尾部 3 字符）                                                                                                                                                                           | 200 KB 事件 @1 KB chunk **25.7 ms**、@256 B **49.2 ms**（旧 61.7/195.4 ms）                                                         |
| F8             | `Bm25MemoryIndex` 已有内核时 `addDocument` 增量追加；remove 重排下标才置空重建                                                                                                                                           | 200 文档 ≈1 MB：追加后 warm search **0.08 ms**；`rebuilds` 不增                                                                     |
| F9             | `ContextBreakdownEstimator` 单条消息结果 WeakMap 缓存（content 变化失效），复用唯一 `TokenEstimator` 记账                                                                                                                | 1000 消息/34 工具：**1.16 → 0.273 ms warm（4.2×）**，满足 ≤0.5 ms 目标                                                              |
| F6             | 二次折叠用「游标前摘要 + 新增段」做种子（游标 hash 有效时），否则回退全量摘要；`compaction.resummarize` 计数                                                                                                             | 60 条历史二次折叠：摘要请求 **32 条消息** vs 全量 60 条；摘要语义/游标不变量保持                                                    |
| S7（部分）     | `AuditSink` 常开 append fd + `writeSync`（仍同步，不引入丢事件窗口）；`close()` 幂等；`<log>.head.json` 链头 sidecar（size 匹配才 O(1) 续链）                                                                            | 2000 条记录 35.5 ms（含 SHA-256/JSON）；续链/verify 通过；sidecar 命中/大小不匹配回落均通过                                         |
| W1             | 流式正文按最后一个空行切 stable/tail：stable 走 Markdown/高亮，tail 纯文本；fenced code 内空行不切                                                                                                                       | 无空行短回答 textContent 不变；切分有纯函数判据                                                                                     |
| S2（部分）     | `ThreadPage.slice` 50k 事件→尾部 300 条 + JSON 序列化纳入 `perf:gate`                                                                                                                                                    | **0.154 ms**（预算 ≤3 ms）                                                                                                          |
| S5             | 静态资源缓存（mtime/size）、br/gzip、ETag/304、`/assets/*` immutable；token 日志脱敏；越界改 `relative()` 判定                                                                                                           | 真实首屏 JS 794.3 KB → br **245.9 KB** / gzip **271.2 KB**；304 **1 ms**；二次命中零读盘                                            |
| S1             | 会话旁路摘要 `<sid>.jsonl.summary.json`（size 校验，原子写）；`save`/回合末回写；列表命中即不读 `.jsonl`；旧档首次解析后异步补写                                                                                         | 500 会话热缓存模拟 **136.6 → 52.8 ms（2.6×）**；旁路 178 B/档；真实 409 档冷启动不再整档读 5.3 MB                                   |
| S6             | `/files` 改 `safeResolve` + `createReadStream`/`pipeline`（不再整读 64 MiB）；未跟踪文件 patch/行数 2 MiB 上限                                                                                                           | 4 MiB 下载内存恒定、事件循环不阻塞；100 MB 未跟踪文件不再整读/生成 patch                                                            |
| S2             | `threads.get` 支持 `limit`/`before` 尾部优先分页（未知 before fail-closed/前端回退重载）；前端首屏 300 条 + 顶部「加载更早」+ 切会话竞态守卫                                                                             | 大会话首屏只取/渲染尾部；更早事件按需补拉；旧客户端不传 limit 仍全量（向后兼容）                                                    |

新增判据：`tests/unit/repoMapInvalidationScope.test.ts`、`modelAdapters.test.ts`（SSE 三态混用
跨 1/2/3/7/64 字节分块、200 KB 事件、流式只 stringify 一次）、`contextEfficiency.test.ts`
（LRU 淘汰后逐字节一致、emoji 4 字节）、`sessionSummarySidecar.test.ts`（旁路口径/绕过非法
JSONL/过期回落与回写/save 同步写）、`safeFs` ⑨/`httpServer` `/files` 流式下载、
`workspaceChanges` 大文件不整读、`threadPage.test.ts`（默认全量/尾部/`before`/未知 id/夹取）、
`corpusChangedPaths.test.ts`（路径归一化/空文件名哨兵/独立计数）、`compactorFingerprint.test.ts`
（随机消息与原 djb2 逐位一致/原地改内容重算/大前缀 warm 正确）、`memorySearch.test.ts`
（增量追加不重建/remove 后重建一次）、`contextBreakdownCache.test.ts`（warm 与冷算一致/原地改
content 重算）、`compactorIncrementalSummary.test.ts`（二次折叠带已有摘要/请求消息数下降）。

**Wave 0（性能预算，最小落地）**：新增 `scripts/perfGate.mjs` + `scripts/perfBudget.json`，
把本轮六个热路径收益钉成门禁：SSE 200KB@1KB chunk、planner 34 工具 warm、压缩器 200 条 warm、
指纹 1200 条 warm、memory 200 文档 warm、breakdown 1000 消息 warm。本地实测
**14.11 / 0.26 / 0.10 / 0.23 / 0.121 / 0.273 ms**（预算 60 / 2 / 5 / 2 / 5 / 1 ms）；
`npm run perf:gate` 可重复执行，不依赖外部进程，适合本地与 CI nightly。

**前端（W1/W5，部分）**：`markdown.ts` 增加 `src → HTML` 有界 LRU（64 条 / 8M 字符），
同一条消息重复渲染不再重跑 markdown-it；`CodeSurface` 与 `FileTab` 用 `React.memo` 包住，
右栏文件在流式期间内容/语言不变时不再每 50 ms 重新分词。流式节流缺省 **50 → 80 ms**
（渲染次数再降 37%，首字仍立即出、收尾 flush 零丢失）。`tsc -p web/tsconfig.json` 通过；
浏览器 Profiler/真机流式未在本机跑（Vite 被沙箱 `spawn EPERM` 阻断），收益按解析次数估算。

**工程化（T4，CI 门禁收口）**：CI 的 gate job 现跑 `gate:typed`（tsc + 类型感知 ESLint，
替代单独 typecheck）、`build` 后再跑 `perf:gate`（SSE/planner/压缩器预算）、`arch:gate --strict`
与 `check:doc-links`——本地门禁与 CI 用同一套判据，性能回归在合并前就被挡住。
此前 CI 只跑 `check/typecheck/build/lint/api/maturity`，架构白名单、文档死链与热路径预算都不在 CI 里。

**桌面打包（D2）**：`stageHarness.mjs` 删除 `onnxruntime-web`（128.2 MB 死重）、
`@types`、`native/*.old.node`；`electron-builder.yml` 的 `electronLanguages` 只保留
`en-US`/`zh-CN`。**electron-builder --dir 重打包实测**（2026-10-25 最终）：
win-unpacked **503.8 MB / 12,522 文件**（原 686.7 MB → −182.9 MB，26.6%）；locales **1.1 MB / 2**；
`resources/harness` 约 **180.7 MB**，无 `onnxruntime-web`、无 `*.old.node`；
`desktop/scripts/verifyPackage.mjs` 结构校验通过。
NSIS 安装包改用 `desktop/installer/OmniHarness.nsi` + `makensis` 直接打包（绕开 builder 的
7za spawn）：**137.4 MB / 144,098,017 bytes**，SHA256
`EEC58E400F2EDFFECC6D48A3EF57F2E546232191F8346562122AB2329DAC7B5D`。

**桌面 D1 度量就绪**：`main.ts` 写入 7 个 `startup.phase` 标记（config → workspace → window →
harness.start → harness.ready → ui.loading → ui.ready）；新增 `desktop/scripts/startupReport.mjs`
（`npm --prefix desktop run startup:report -- --budget-ms=5000`），无需启动 Electron 即可读日志、
算阶段差并按预算退出。对合成日志验证：5000 ms 在 6000 预算下通过、4000 预算下退出码 1。
旧安装日志没有标记，需新包首启后回填真实冷启动。

**D1 实际优化（插件加载移出关键路径）**：`serve` 原先 `await app.loadPlugins()` +
`applyPluginProfile` 完成才 `listen`；现在两者在 listen **之后**并行执行，`AppServer` 登记
`setPluginsReady` 闸门，`createThread / continueThread / runTurn / plugins.list / plugins.search`
在入口 await——UI 与静态资源先可用，首个需要插件的请求才等待。插件失败只告警、闸门放行，
不会让整个服务起不来（旧行为是 `applyPluginProfile` 抛错即启动失败）。收益 = 插件扫描/Worker
启动时间，具体毫秒待新包 `startup:report` 回填。

### 12.3 本轮验证与边界

- `npm run build`：**37–48 s**（同一轮两次 clean 构建；磁盘缓存/负载差异）；`tsc --noEmit`：通过；desktop `tsc --noEmit`：通过；web `tsc --noEmit`：通过；
- `npm run check`、`arch:gate --strict`、`audit:top-level-fn`、`api:check`、`check:doc-links`：全绿；
- `npm run lint`（改动文件）：0 error；
- **未能本地跑 vitest / desktop test / web:build**：本机受限执行环境禁止 esbuild/vitest 的 service 子进程
  （`spawn EPERM`，与仓库无关）；因此用 `dist` 产物 + 直跑源码的等价脚本验证后端行为，
  CI（普通 runner）仍需跑 `npm run test:fast`、`npm --prefix desktop test`、`npm run web:test` 复核；
- 本轮**已完成**：F6 增量摘要、W1 流式稳定段、S7 审计常开 fd、D2 `--dir` 重打包；
- 仍**未做**：S7 异步组批/轮转/流式 verify、`threads.get` 游标稳定性、S2 大会话真机首屏、
  D1 正常桌面会话的 `startup:report`。F1 的路径级增量已从「未变复用」推进到「只重解析
  变化文件」，新增/删除仍按设计回落全量。

### 12.4 下一轮建议（按依赖）

1. **S7 异步组批/轮转/流式 verify**（先确认合规丢事件窗口）；
2. **S2 大会话首屏实测**（回卷 fallback 已做）；
3. **桌面更新签名/回滚 + 安装包实测**；
4. **长任务 `--self-check`/`eval:long` 在普通环境回填**；
5. 最终全量回归与报告/看板收口。

### 12.5 当前完成度（2026-10-25 第 38 轮）

- **已完成并进 CI/门禁**：F1 路径级增量（未变复用）、F2 事件体积、F3 指纹、F6 增量摘要、
  F7 后台索引、F8 增量 BM25、F9 breakdown 缓存、S1 旁路摘要、S2 分页（服务器侧预算）、
  S5 静态缓存、S6 流式下载、S7 常开 fd + head sidecar、W1 稳定段、D2 `--dir` 重打包与
  `verify:package`、**NSIS 安装包 137.4 MB**、桌面全局快捷键、独立性门禁。
- **已具备但需真机/普通环境回填**：W1 Profiler CPU、S2 首屏数值、长任务 `--self-check` /
  `eval:long`、安装包静默安装冒烟、更新签名。
- **仍属外部阻塞**：更新证书、浏览器 Vite/Vitest service、API key、安装包签名。
