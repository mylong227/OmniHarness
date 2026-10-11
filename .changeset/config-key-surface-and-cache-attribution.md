---
'@mylong227/omniharness': patch
---

本批（目标第 2 轮）做三件事：**把"0%/告警"变成可行动结论**（F9 配置键出口、缓存命中率分因），
并**当场推翻一条我上一轮记错的"缺陷"**。

## ① F9：配置键出口（不再只说"不被支持"）

审计记的 F9：bundle 补丁层告警只有一句"忽略非法配置项: x"，用户**拿不到任何出口**。
三处一起修（本仓其实早有正确范式：`capabilityConfigValidator` 的未知键错误就会列可用键）：

- `ConfigError.knownConfigKeys()` 新增为**合法键唯一出口**（单一来源仍是本文件的 `KNOWN_KEYS`）；
- 未知键报错改为 `未知配置项 "x"（标准名 "x" 不被支持）；可用：a / b / …（共 N 项，完整清单见 omniharness.json.example）`
  —— 有界（前 12 项 + 总数）以免淹掉真正有用的那句，出口指向仓库那份**逐键合法**的示例配置；
- `loadBundlePatchLayer` 的告警不再 `catch {}` 吞原因：现在带 `；原因：<底层 ConfigError 原文>`，
  于是"未知键 / 枚举越界 / 类型错"三类**可分辨**，未知键那条还带合法键清单。

判据 `tests/unit/configKeySurface.test.ts`（3 例）并附**新契约**：`omniharness.json.example` 的每个
顶层键都必须被 `normalizeConfig` 接受（照抄示例不能再踩"未知配置项"）。
**正对照**：撤掉合法键出口 ⇒ 判据 ②③ 变红；撤掉告警原因 ⇒ 判据 ③ 变红（两次变异都实测过，还原后 3/3 绿）。

## ② 新能力：缓存命中率**分因**

此前会话面板与告警只报一个数字（`命中率 0%`），而 0% 至少对应四种处置完全不同的情形。
新增 `src/observability/cacheMissAttribution.ts`（纯静态、可穷举）：

| 分因             | 含义                                             | 该做什么                                         |
| ---------------- | ------------------------------------------------ | ------------------------------------------------ |
| `not-reported`   | 端点压根没上报缓存字段                           | **别改提示词**——"0%"是假读数                     |
| `cold-start`     | 本会话第一次请求，无前序前缀                     | 不用处置                                         |
| `prefix-rewrite` | 相邻请求公共前缀占比低于 0.9（字节级前缀被打断） | **本机可控**：查 `PrefixStability` / `canonical` |
| `ttl-expired`    | 间隔超过 provider TTL（缺省 5min，可覆盖）       | 外部条件                                         |
| `unknown`        | 有上报、前缀稳定、间隔也在 TTL 内                | 原因不在本机可控面                               |

优先级固定：`not-reported` > `hit` > `cold-start` > `prefix-rewrite` > `ttl-expired` > `unknown`
（`not-reported` 必须最先，否则"端点没给字段"会被引导成"去改提示词"；前缀问题必须早于 TTL，因为前缀断了 TTL 再新鲜也不命中）。
`attributeFromTexts` **复用** `PrefixStability.prefixReuse`（唯一实现，避免面板口径与治理口径漂移）。

**接进真实消费方**：`CacheHitRateWatch` 的 `CacheHitRateBreach` 新增 `cause` / `reason`，
`inspect` 的 warn 日志同时写出两者 ⇒ 告警不再只是"命中率低"，而是"**为什么**低 + 该动哪里"。
入参向后兼容（未给分因信号时按 `cachedPromptTokensReported` 推断，缺省即 `not-reported`）。

判据 `tests/unit/cacheMissAttribution.test.ts`（6 例：逐因触发 + **换信号必须换因**的正对照 +
优先级 + 两条边界「恰好等于阈值不得误判」+ 证据 JSON 安全 + 文本入口与 `prefixReuse` 逐位一致）；
`cacheHitRateWatch.test.ts` 的形状判据**升级**为同时钉 `cause`/`reason`，并新增一条"分因穿透"判据。

## ③ 推翻上一轮的一条错误登记（保留旧文）

上一轮我在看板登记"`omniharness <未知顶层子命令>` 会挂死"。**这是错的**：`omniharness --help`
的快速开始写着 `omniharness "列出当前目录的 .md 文件并总结"` —— **裸位置参数本来就是 prompt**（设计如此）；
带硬超时的探针实测 `--mock 你好` 30.7s 正常退出 0，而不带 `--mock` 时用的是**真模型**、

> 150s 仍在做 `read_file`/`list_dir`/`grep`（**长回合，不是卡死**）。旧结论已就地划掉并写明推翻依据。
> 教训：被杀那一刻"进程在干活"与"进程卡住"观测面完全相同 ⇒ 先看事件流是否在增长，再下结论。

另附一条本轮排除的嫌疑：`.omniharness/bundle-patches/a-signed.json` 那类遗留**不会**影响
`rewindCompactionCursor` 判据——该判据走 `ConfigFactory.build`，而 bundle 补丁层只在 CLI 的
`loadLayered` 里读（已由调用点核对）。该偶发 40 次隔离跑未复现（只在全量并发下出现），
本轮给它补了**全部捕获体的分类表**进失败消息，便于下次一眼判定"仪器漏标记"还是"产品真泄漏"。

## ④ 同轮修掉的门禁/测试基础设施缺陷（三处，都会在 CI 上复现）

1. **覆盖率门禁自杀于 `ENOBUFS`**：`execFileSync` 未设 `maxBuffer`（Node 缺省 1MB），而门禁要捕获
   **整套 TAP** ⇒ 套件一长大就 `spawnSync … ENOBUFS`，还被报成"测试可能根本没跑起来"
   （把"门禁读不下输出"伪装成"测试没启动"）。新增 `scripts/lib/childRunFailure.mjs`
   （`MAX_CAPTURE_BYTES=64MB` + `classifyRunFailure`；独立成模块才**可判据化**——门禁脚本 import 即执行），
   门禁显式传 `maxBuffer`，`capture-overflow` 走**另一套**文案与处置。
2. **清点判据的口径分叉**：纯类型模块的排除只加在报告分支，`--dump-inventory` 分支仍是手写过滤
   ⇒ 收紧基线时把 9 个纯类型端口模块误报成"新增未覆盖"。现抽 `classifyMissingArtifacts` 供**两分支共用**，
   基线由 **390 条收紧到 7 条**（383 个纯类型模块正确归类），输出同时报出"另有 N 个纯类型模块不计入"。
3. **`headless.test.ts` 撞 120s 文件预算**：根因量化后是 CLI 的 agent 路径默认开语义检索
   （4 条真 agent 回合每次 spawn 都加载嵌入模型与索引）⇒ 实测 **67.7s → 23.4s**、插桩下 **76s → 34s**。
   该文件每处 spawn 显式带 `OMNI_SEMANTIC_RECALL=0`（本文件不测检索 ⇒ 成本与确定性双赢）；
   并把 `applyCliRetrievalDefaults()` 从 `run()` 开头**收窄到 agent 路径**（不再让 `kv`/用法提示替它买单）。
   **诚实边界**：该收窄**不会**让子命令变快（`boost probe list` 1.67s → 1.72s；那 ~2s 是命令继承链加载）。

由此暴露一条值得记住的覆盖口径事实：**测试 spawn 的 CLI 子进程覆盖会并进报告** —— 关掉检索后
`cachedEmbeddingPort.js` 从 97.5% 掉到 93.75%（preload 透传那三行原本是 CLI 回合"顺手"覆盖的）。
处置**不是下调基线**，而是把该装饰器的能力透传契约显式判据化（`cachedEmbeddingPortContract.test.ts`：
preload/flush 仅在实现侧存在时透出 + 命中不得调内层）⇒ 覆盖率回到 **97.50%**。
