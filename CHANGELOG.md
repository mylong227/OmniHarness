# Changelog

## 0.2.0

### Minor Changes

- 7ea74a6: **适配器名与存储后端名各收成一张表**（用户指定，结项审计 §3.4 的两项遗留）。

  **动机**：审计 §3.4 记的「扩展接缝是改一处漏一处」还剩两项——① 模型适配器名 → 构造器的分支散在三处；
  ② 会话存储后端名 → 实现 + 缺省落盘路径内联在 `cliBuildConfig`（而 KV 后端另有同形工厂）。

  **改动 1：模型适配器注册表**（`src/adapters/model/modelAdapterRegistry.ts`）

  - `modelAdapterRegistry`：`id → { defaultsId, create }` 的**一张表**；这是全仓唯一允许 `new` 模型适配器的地方。
    兜底端点/模型/凭据 env 名仍来自 `defaults/endpoints.json`（改数据不改代码），表只持有构造器与引用。
  - 三处构造分支改为查表：`cliBuildConfig.buildModel`（原 4 分支）、`configBuilder.buildRouterAdapter`（原 3 分支）、
    `providerProbe.buildModelForProvider`（原 2 分支）。未知 id 由调用方定夺：路由条目/厂商预设**抛错**，
    CLI **回落 mock**（`MOCK_ADAPTER_ID`）——与历史语义逐字一致。
  - **顺带修掉一个真缺陷**：`configError.ENUM_VALUES.modelAdapter` **漏了 `llamacpp`**，而 `FileConfig` 类型与
    `cliEnums.MODEL_ADAPTERS` 都早已包含它 ⇒ 配置文件写 `"modelAdapter": "llamacpp"` 会被判非法
    （与 `approval` 的 `'plan'` 同型：声明支持、校验拒绝）。现三方一致性由测试机械核对。

  **改动 2：会话存储工厂**（`src/cli/storageFactory.ts`）

  - `StorageFactory.createFor(adapter, dir)`：后端名 → 实现 + 缺省落盘路径的**单一实现来源**
    （`DEFAULT_SQLITE_FILE` 成命名常量；sqlite 懒加载保留）；`cliBuildConfig.buildStorage` 退化为一次转发。

  **机械防线**（`tests/unit/adapterFactories.test.ts` 6 例）：① 注册表 ↔ `cliEnums.MODEL_ADAPTERS` ↔ 配置校验
  白名单三方一致（每个适配器名都必须能通过 `normalizeConfig`）；② 表里每个 `defaultsId` 在数据文件中真实存在；
  ③ 探测/路由两条路径按表造出正确类；④ 存储工厂的选择与缺省；⑤ **构造守卫**：模型适配器的 `new` 只允许出现在
  注册表内；⑤-2 存储后端名的字符串分支只允许出现在存储工厂内。

  **兼容性**：所有对外行为与文案不变（护栏/兜底/报错口径逐字保留）；模型适配器构造从「三处分支」变为「一次查表」。
  `buildModel` 的返回类型由具体类联合收敛为 `ModelPort`（`protected` 方法，唯一调用点在同一类内）。

  **验证**：`npm test` 2099 例 / 2094 过 / 1 失败（本机 Chrome 环境用例，与基线同一条）/ 4 skip；
  `typecheck`（含 web）/ `lint`（0 告警）/ `format:check` / `check --strict`（571 文件零违规）/
  `arch:gate --strict` / `audit:config-wiring`（571 文件）/ `api:check` 全通过。

- abc26a3: 提示缓存真正接入（含真机命中率数字）**+** 上下文预算不再 fail-open。

  **缓存（Anthropic + 可观测 + 真机证据）**

  - **Anthropic 滚动缓存断点**：新增 `AnthropicCacheBreakpoints`（纯函数），名额 `4−(有 system?1:0)`，从**已完成轮次**取最近若干条 user 消息打断点（**不打在最新消息上**——字节前缀缓存对「本轮才成形的内容」无可复用字节；改写历史消息的字节反而会葬送已缓存前缀）。OpenAI/DeepSeek 为自动前缀缓存，未加字段，也未在消息头部插入动态内容。
  - **命中率语义与加固**：`cacheStat` 原先原样累加 `promptTokens`，一条脏事件即可让整会话命中率变 `NaN` 或 `>100%`；现整条忽略非法 payload（非对象/非有限数/负数/缺分母）并把 cached 钳制到 prompt。新增 30 例单测覆盖 measured/estimated/empty 三态、除零、钳制、**按 token 加权**、舍入口径。
  - **坍塌可执行化**：新增 `CacheHitRateWatch`（只告警不阻断）——会话 ≥5 次模型调用且命中率低于阈值时产出 `model.cache.lowHitRate`（warn，带四个数字）。阈值 env `OMNI_CACHE_HIT_WARN`，默认 50%（依据：各模型缓存价≈原价 1/3，p=50% 时成本≈原价 67%）。
  - **真机证据**：新增 `evals/cache-probe.mjs`（同前缀两轮，命中量用生产同一份读者读取；第 2 轮零命中即 exit 非 0）。实测 DeepSeek `deepseek-chat`：第 2 轮 `946 prompt / 768 cached = 81.2%`（第 1 轮 81.7% 系与先前探针前缀重叠的"预热"，不作为稳态数字）。
  - **未真机验证**：Anthropic 断点收益仅有「请求体结构 + 上限 + 前缀稳定性」单测级证明（本机无 Anthropic 凭据）；探针目前只走 OpenAI 协议。

  **上下文压缩不再 fail-open**

  - 缺陷：`keepRecent ≥ 消息总数`（无 head 可折叠）时，`ContextCompactor` **原样返回消息却报 `compacted: true` + `summary: '[历史已省略]'`**，类里根本没有截断调用。实测：阈值 100、输入 4 万字符 → **输出仍 4 万字符**、`out === in` ⇒ 假称已压缩、超窗请求照发（下一步直接撞端点上限）。
  - 修法：该分支改为按真实预算**从最旧一端逐条丢弃**（每次丢弃后重新 `sanitizeToolRounds`，避免留下 orphan tool 被上游 400），并把丢弃条数如实写进摘要；本就在预算内则如实回 `compacted: false`（不谎报）。主路径同时补兜底：摘要 + 最近消息仍超预算时丢弃较旧的 tail 消息（保留摘要与最新一条）。
  - **契约变更**：三个既有断言原先钉住了 fail-open（如 `{maxTokens:1, keepRecent:10}` 保留全部 3 条），已改为新不变量——「超预算必须真丢弃且如实报告」+「未超预算不得谎报已压缩」。

  **行为变更提示**：① Anthropic 请求体消息侧新增 ≤3 个 `cache_control` 断点；② 新增 env `OMNI_CACHE_HIT_WARN` 与观测事件 `model.cache.lowHitRate`；③ 压缩结果在超预算时会真的丢弃最旧消息（此前会假称已压缩）。

- 7ea74a6: **CLI 帮助数据化 + 适配器/存储声明收成单一来源**（用户指定：帮助这类内容也该按配置实现，不该硬写在代码里）。

  **① CLI 帮助移出代码**（`defaults/cliHelp.json` + `src/cli/cliHelp.ts`）

  - 原先整份帮助是 `argParser.printUsage()` 里一段 **73 行字符串数组**，于是 CLI 表面出现**第三份副本**：
    旗标名 / 枚举取值 / 默认值在 `cliFlagTable`（解析）、`cliEnums`（校验）、`CliDefaults`（默认值）各一份，
    帮助里再抄一遍。**实测已经漂移**：帮助写 `--storage-adapter memory|jsonl`，而白名单早已是
    `memory|jsonl|sqlite` ⇒ 用户照帮助选不到 `sqlite`。
  - 现帮助的**文案**在 `defaults/cliHelp.json`（改文案不改代码），**枚举取值**在渲染时从 `cliEnums` 派生
    （数据里写 `{{storageAdapters}}` 等占位符）；占位符无法解析即**抛错**（fail-closed，绝不把 `{{x}}`
    渲染给用户）。排版口径（描述列 36、过长留 3 空格）由 `CliHelp.lineOf` 统一保证，
    不再有旧数组那种手工对齐的参差。
  - **行为变更（唯一一处语义变化，属修复）**：`--storage-adapter` 的帮助取值由 `memory|jsonl` 变为
    `memory|jsonl|sqlite`（与解析期白名单一致）。其余 72 行文案逐字不变；15 行的描述起始列因统一对齐
    有若干空格位移（旧数组手工对齐不一致）。

  **② 适配器标识与存储后端的声明收成单一来源**

  - `src/ports/model/modelAdapterId.ts`：`MODEL_ADAPTER_IDS` + `ModelAdapterId` 成为**唯一名字来源**，
    原先在 5 处各写一遍（`CliArgs.modelAdapter` / `FileConfig.modelAdapter` / `cliEnums.MODEL_ADAPTERS` /
    `configError.ENUM_VALUES.modelAdapter` / daemon `RoutineModelAdapter`）+ 厂商预设置子集。
    注册表的表体用 `Record<ModelAdapterId, …>` 表达 ⇒ **漏一行即编译报错**。
  - 顺带修掉一个真缺陷：`configError.ENUM_VALUES.modelAdapter` **漏 `llamacpp`** ⇒ 配置文件里写
    `"modelAdapter": "llamacpp"` 被判非法（声明支持、校验拒绝，与 `approval` 的 `'plan'` 同型）。

  **机械防线**（新增 `tests/unit/cliHelp.test.ts` 6 例 + `tests/unit/adapterFactories.test.ts` 6 例）：

  - 帮助：枚举取值必须来自 `cliEnums`（含 `--storage-adapter … sqlite`）；排版描述列恒为 36；占位符
    fail-closed；**帮助不得宣传不存在的旗标**（幽灵文档；例外为 CLI 自解析旗标 `--config`/`--profile`/
    `--auth-required`，且例外清单腐化也会失败）；**新增旗标必须文档化**（存量 15 个未文档化旗标冻结，
    只增即红）；渲染确定性。
  - 适配器：三方声明一致（每个注册 id 必须能过 `normalizeConfig`）；表里每个兜底 id 在数据文件真实存在；
    **模型适配器的 `new` 只允许出现在注册表**；**存储后端名分支只允许出现在存储工厂**。

  **验证**：`npm test` 全绿（详见看板 §20.17）；`typecheck`（含 web）/ `lint`（0 告警）/ `format:check` /
  `check --strict` / `arch:gate --strict` / `audit:config-wiring` / `api:check` 全通过。

- 8de336a: **硬编码策略表全部移出代码**（用户指定：不要在代码里硬编码，方便以后维护）：默认数据改为随包发布的 `defaults/*.json`，用户侧由 `omniharness.json` 覆盖。

  **动机**：上一轮已把 SSRF 三表变成**配置字段**，但三张表的**默认值**仍写在 `src/security/ssrfPolicy.ts` 与
  `src/util/ipAddress.ts` 里；厂商目录更是硬编码在 `server/services/providerPresets.ts`，而 CLI 又独立维护了一份
  `ADAPTER_PRESETS` 手工副本（注释自称「与 providerPresets.ts 同源同步」）——加一家厂商要改两处，两处一旦漂移就会出现
  「UI 有这家厂商、CLI 解析不到」的隐性缺口。这类表都是**随环境/厂商变化的数据**，不该是逻辑。

  **改动**：

  - 新增数据文件：`defaults/ssrf.json`（元数据主机 / 内网后缀 / IPv4 网段）与 `defaults/providers.json`
    （厂商端点 / 默认模型 / 兜底模型清单 / 推理档位 / **`cliAdapters`** / 维护说明 `notes`）；`package.json#files`
    加入 `defaults`，随 npm 包发布。
  - 新增 `src/util/builtinDefaults.ts`（`BuiltinDefaults`）：按**模块相对路径**反推包根读取 `defaults/*.json`，
    带缓存；文件缺失 / 不可读 / 非合法 JSON **一律抛错**（fail-closed——安全默认档读不到时静默退化成空表，
    等于护栏「看着还在、实际更松」）。
  - 新增 `src/config/providerPresets.ts`（`ProviderPresets`）：厂商目录的**单一来源**。合并语义为
    「`id` 相同**整条替换**、新 `id` **追加**」，不做字段级隐式继承；非法条目（缺字段 / `adapter` 越界 /
    未知 key / 重复 id）一律抛错。
  - `FileConfig.providerPresets` 新配置段 + `src/config/providerPresetValidator.ts` 接入 `configError` 校验链
    （与运行时求解器**同源**）；消费方为 CLI 凭据兜底、`ModelCatalogService`（catalog/probe/resolveOverride）、
    `AppServer.warmActiveProvider`、`serverConfigStore` 的厂商启用校验。
  - 删除 CLI 的 `ADAPTER_PRESETS` 副本：CLI 专属映射（`responses` → openai、`llamacpp` → ollama）改由预设自带的
    `cliAdapters` **数据**表达，派生逻辑只有 `ProviderPresets.forAdapter` 一份。
  - `src/util/ipAddress.ts` 不再内置网段表：`isPrivateIpv4` / `isPrivateIpv6` 的网段表改为**必传参数**
    （`PRIVATE_IPV4_CIDRS` 已删除）。

  **顺带修掉两个真实缺陷**：

  1. **「声明未接线」**：`configDefaults()` 从不映射 `file.ssrfPolicy`，于是 `args.ssrfPolicy` 恒为 `undefined`——
     写在 `omniharness.json` 里的 `ssrfPolicy` **从未生效**（只有编程 API 路径生效）。接线完整性门禁 I5a 只对
     `src/cli` 做字符串匹配（`args.ssrfPolicy` 足以命中），所以这条断链一直是绿的。已补齐映射并加回归测试。
  2. **IPv6 内嵌 IPv4 绕过配置网段**：`isPrivateIpv6` 内嵌 IPv4 的判定走的是函数默认参数（内置表），
     配置过的 `ipv4Blocks` 只对纯 IPv4 生效 ⇒ `[::ffff:10.0.0.1]` 这类等价写法仍按出厂网段判定（双口径）。
     两个守卫（`SsrfGuard` / `NetworkEgressGuard`）现统一传入策略表，口径合一。

  **兼容性**：默认行为**逐字不变**（默认档数据与历史硬编码值逐项一致，有测试钉住）；`defaults/` 未随包发布时
  会在启动期显式报错而不是静默放宽。`PRIVATE_IPV4_CIDRS` 与 `isPrivateIpv4` / `isPrivateIpv6` 的签名属包内模块
  （`package.json#exports` 只暴露 `.` 与 `./beta`，无深层导入契约）。

  **验证**：`npm test` 2079 例 / 2074 过 / 1 失败（本机 Chrome 环境用例，与基线一致）/ 4 skip——新增 18 例
  （`tests/unit/providerPresets.test.ts` 7 例 + `tests/unit/ssrfPolicy.test.ts` 新增 5 例，其余为既有用例扩展）；
  `typecheck`（含 web）/ `lint` / `format:check` / `check --strict`（567 文件零违规）/ `arch:gate --strict` /
  `audit:config-wiring`（567 文件六条不变量全绿）全通过。

- e8747d2: 遗留记忆引擎标记 `@deprecated`（DEFICIENCY_AUDIT §3.2 弃用流程第一步）

  `ResonantMemoryEngine` 与 `CosmicWebMemoryEngine` 与 U1 统一记忆基板同算法重复，按既定弃用流程标记 `@deprecated` 并将在**下一个次版本移除**（届时迁移到 U1 基板路径）；本版本内存量装配（`resonance.enabled` 等）行为不变。

- 9cb124f: 嵌入预热接线（L5）+ 工具暴露规划器热路径提速（7.3×）+ 修「嵌入冷启动失败后永久瘫痪」。

  **L5 · 嵌入预热与冷启动可观测**

  - 新增可注入 loader 接缝（`TransformersModuleLoader` / `TransformersModuleLike`）：生产缺省仍是真动态 `import('@huggingface/transformers')`；**唯一目的**是让冷启动/预热能在**离线**下被单测钉住（否则验证需真下载 2.2GB 依赖与模型权重）。
  - 新增 `TransformersEmbeddingAdapter.preload()`：返回 `{ok, ms, built, error}`，`built` 区分「真由本次构建」与「本来就热」；成功记 `embedding.pipeline.built`、失败记 `embedding.pipeline.failed`。
  - `EmbeddingPort` 增**可选**能力 `preload?(): Promise<EmbeddingPreloadOutcome>`（契约：**不得抛错**，失败以 `{ok:false}` 回报）。
  - 装配接线：`configFactory` 抽出 `buildEmbeddingPort()`；`OMNI_EMBED_PRELOAD=1`（**默认关 ⇒ 零行为变更**）时**后台**触发预热——刻意不 `await`，不阻塞启动；可用性仍由首次真实 `embed` 的 fail-closed 决定。
  - 开关解析 `shouldPreloadEmbedding(env)` 与 `resolveRemoteHostFromEnv` 同址（同一惯例）。

  **修缺陷 · 嵌入冷启动失败后永久瘫痪**

  - `getPipeline()` 原先把构建 Promise 直接缓存：**一次瞬时失败（下载/加载）会把已 reject 的 Promise 永久钉在字段上**，此后每一步都复用它 ⇒ 该适配器此后再不可能恢复，语义路整会话静默失效。
  - 修法：失败即清空缓存以便重试，并以 `=== pending` 守卫避免误清新一轮尝试。

  **优化 · `ToolExposurePlanner.plan()` 热路径**

  - 问题：`plan()` **每步**调用一次，而原实现对「每类别 × 每关键词」都 `new RegExp(...)`（默认类别表约 **81** 个关键词）⇒ 每步重建约 81 个正则。
  - 改法：① 同类 ASCII 关键词合并成**单条交替正则**（尾边界用前瞻，对布尔判定与原先的消费式等价）；② 按类别表对象引用用 `WeakMap` 缓存预编译匹配器。
  - 实测：**47.53 µs → 6.49 µs/次（−86.3%，7.3×）**；**行为逐字不变**由差分回归测试钉住（测试内保留优化前的朴素匹配器，在 28 条含边界陷阱的语料上逐条比对）。

  **顺带处理**

  - `configFactory.ts` 文件尾一处**悬空 JSDoc**（后面无任何声明）会被**下一个**声明吸收、造成文档误挂，已降级为普通注释（内容一字未删）。

  **行为变更提示**：默认**无**行为变更（`OMNI_EMBED_PRELOAD` 未设 ⇒ 不预热；语义路仍由 `OMNI_SEMANTIC_RECALL=1` 控制；`plan()` 输出逐字不变）。
  新增 env `OMNI_EMBED_PRELOAD=1` 与端口可选方法 `EmbeddingPort.preload`。

- 8de336a: **端点/地址硬编码移出代码**（用户指定：地址类硬编码也要专门的配置文件管理）：新增 `defaults/endpoints.json`，`buildModel` 与 `buildRouterAdapter` 不再各写一份端点字面量。

  **动机**：`cliBuildConfig.buildModel` 里硬编码了 `https://api.openai.com/v1` / `https://api.anthropic.com` /
  `http://localhost:11434` 与兜底模型名、凭据环境变量名，而 `configBuilder.buildRouterAdapter` **又写了一遍同样的三个端点**——
  典型的「改一处漏一处」。插件市场索引、SWE-bench 的 GitHub 基址、浏览器 CDP 自检地址也各自硬编码，
  企业换私有 registry / GitHub Enterprise / 自建网关必须改代码重发。

  **改动**：

  - 新增数据文件 `defaults/endpoints.json`：`modelAdapters`（适配器 → 兜底 `baseUrl` / `model` /
    `requiresApiKey` / `apiKeyEnv` / `baseUrlEnv` / `modelEnv` / 维护说明）+ `services`（服务标识 → 地址 +
    可选 env 覆盖 + 说明）。
  - 新增 `src/util/endpointDefaults.ts`（`EndpointDefaults`）：解析 + 严格校验（未知 key / 缺字段 / 类型错 /
    id 重复一律抛错），提供 `resolveAdapter(id, env)` 与 `urlOf(id, env)`；**未知服务标识也抛错**，
    不静默返回 undefined（否则会拼出 `undefined/repos/...` 这种请求）。放在公共层 `util/` 是为了避免
    `adapters/`、`plugin/`、`eval/` 反向依赖装配层（见 `ARCHITECTURE_SPEC.md` §2.1 目录归属表）。
  - 消费点改造（值全部来自数据，优先级不变）：
    `cliBuildConfig.buildModel`（4 个适配器分支）、`configBuilder.buildRouterAdapter`（**消除与前者重复的端点**）、
    `plugin/registrySourcesShared.DEFAULT_REGISTRY_URL`（env `OMNI_REGISTRY_URL` 仍优先）、
    `eval/nativeExecutor` 的 `repoBaseUrl` 兜底（显式 `repoBaseUrl` 仍优先）、
    `benchmark/terminalbench/taskFetcher` 的 GitHub API 基址（新增标准名 `GITHUB_API_URL` 覆盖，
    GitHub Enterprise 天然生效）、`adapters/browser/cdpClient` 与 `browserAvailability` 的 CDP 自检地址/路径。
  - 错误提示文案也改为拼数据值：改了 `apiKeyEnv` 或 `cdpVersionPath` 之后，提示不会再说谎。

  **兼容性**：所有兜底值与历史**逐字一致**（有测试逐条钉住）；错误提示文案除环境变量名/路径改为动态拼接外，
  文本不变；新增的唯一新旋钮是 `GITHUB_API_URL`（未设置时行为完全不变，GitHub Actions 里其值本就等于
  `https://api.github.com`）。

  **验证**：新增 `tests/unit/endpointDefaults.test.ts` 6 例（兜底值与历史逐字一致 / env 覆盖与空白语义 /
  未知标识抛错 / 非法数据 fail-closed / **反硬编码守卫**（扫描 `src/**` 代码行，地址字面量只允许存在于
  `defaults/`，注释除外）/ 消费点走数据）；`npm test` 2085 例 / 2080 过 / 1 失败（本机 Chrome 环境用例，
  与基线同一条）/ 4 skip；`typecheck`（含 web）/ `lint` / `format:check` / `check --strict`（568 文件零违规）/
  `arch:gate --strict` / `audit:config-wiring`（568 文件六条不变量全绿）全通过。

- 6d1d393: 前端五项收口（性能 / 键盘 / 评审 / 可访问性 / 视觉基线）——先审计再动手，键盘与命令面板经真机确认已达标故未重复造。

  **长会话性能与稳定性**

  - 事件流虚拟化（可视窗口 + 上下 overscan 8 + 占位高度），贴底改为「此前在底部才贴底」（上滚查看历史不再被拽回）。
  - `StreamThrottle` 把 `thread.text_delta` 压到 ≤1 次/50ms，并在 `SessionController` 真正接线（`flushStream()` 由回合收尾在定稿 `streamText` 之前调用，保证零丢字）。
  - 实测：400/800 条事件都只渲染 16 块、vnode 节点 37（与总条数不成正比）；2000 次 delta → 41 次刷新（降 98.0%），flush 后逐字节一致。

  **评审体验**

  - 变更页键盘评审：j/k 移动、a 接受、r 拒绝、c 评论、? 帮助（打字语境不响应）。
  - 检查点时间线：按天分组 + 相对时间 + `含文件快照/仅对话` 徽标 + 最新标记。
  - 会话搜索接 `search.all`：分组、命中高亮、↑↓/Enter、220ms 防抖 + 乱序丢弃、确定性排序。
  - 顺带拆薄两个臃肿组件（ChangesTab 420→370、SessionPanel 457→276 实现行）。

  **可访问性与自适应**

  - 右栏页签补 WAI-ARIA Tabs（tablist/tab/aria-selected/roving tabindex + 方向键）；FileModal 补 dialog 语义；纯图标按钮补 `aria-label`；流式卡补粗粒度 `aria-live` 播报。
  - 全库补 `:focus-visible` 焦点环（原先 `outline:none` 会吃掉默认环）。
  - CSS 层收敛窄窗溢出；真机实测 640px（三种抽屉态）与 1280px 全部无横向溢出。

  **视觉基线（新增机制）**

  - 不做像素 diff（字体/缩放差异必然假红），改**结构快照**：页签、图标栏条目数、输入区文案与控件无障碍名、空态文案；`OMNI_UI_BASELINE_UPDATE=1` 重写基线。含一条「采集选择器」契约测试，防选择器漂移导致采到空数组却永远绿。

  **修掉的三处真缺陷**

  1. 窄屏「回滚」面板不可达（`rollback` 缺失于右栏 TABS，而 `.rail` 在 <880px 隐藏）。
  2. `responsiveProbe.mjs` 两处语法错误（CDP evaluate 裸对象字面量、Node 侧变量未插值）⇒ 探针此前跑不到测量阶段。
  3. 节流导致 `web/test/e2e.test.mjs` 的「push 后立刻合并」断言失效 ⇒ 改为有界等待（1200ms），契约从「立刻」变「短时间内」，真丢字仍红。

  **验证**：`web:test` 223/223；`test:integration` 11/11；全量单测与覆盖率门禁 exit 0（行覆盖 100%）；`lint` 0 告警；`check --strict` 零违规；`arch:gate` 0 违规；`audit:config-wiring` 全绿；`format:check` 通过；真机 640/1280 无横向溢出。

- 9cb124f: 护栏生效模式三态化（`off`/`shadow`/`enforce`）+ 修两处既有缺陷（陈旧工具 schema、护栏兜底 fail-open）+ 阈值校准 harness。

  **D1 · 三态生效模式（借鉴 dsh-jev 的 `provider` × `mode` 两正交开关）**

  - 新增 `src/security/enforcementModeResolver.ts`：`off` 不跑 / `shadow` **跑·记·但不改行为** / `enforce` 跑且生效；兼容历史二值（`true ⇒ enforce`、`false / undefined ⇒ off`，零行为变更）。（2026-09-22 由 `enforcementMode.ts` 更名——主类名须与文件名一致，该增量门禁对新增文件是阻断项。）
  - 新增 CLI `--guard-prompt-injection-mode off|shadow|enforce`（白名单校验，入 `VALUE_FLAGS`）；`--guard-prompt-injection` 语义不变（等价 `enforce`）。
  - 全链透传：`stepTypes` / `stepToolExecutor` / `configFactory` / `cliEnums` / `cliFlagTable` / `argParser` / `cliBuildConfig`。
  - **动机**：既有安全开关多为二值 opt-in，「默认关」丢覆盖面、「默认开」担误报责任；`shadow` 是出口——**只记不改**，用于在生产流量上攒真实误报/漏报（离线快照仅 32 例）。
  - 顺带补上 `--guard-prompt-injection` 此前**缺失的帮助文案**。

  **D2 · 配置层拒绝配出含糊语义 + 兜底 fail-closed**

  - 未知模式**字符串在装配层抛错**（`ConfigFactory.build`），而非静默回落成 `off`——否则「配置写错」会静默退化成「护栏失效」。与 `cliEnums.ts`「安全相关枚举必须显式校验」同一纪律。
  - `guardInjection` 的 `catch` 原为 `return result`（**fail-open**，其注释亦如此写），与模块头「fail-closed」的宣称不一致。内层 `scanForInjection` 已 fail-closed，故该外层此前不可达，但使保证**有条件**。现按模式区分：`enforce` ⇒ fail-closed 隔离；`shadow`/`off` ⇒ 原样（守住「不改行为」契约）。策略抽成纯函数 `guardFailureResult` 以便单测。

  **D4 · 修缺陷：陈旧工具 schema 进模型上下文**

  - `ToolDiscovery` 是按名累积的裸 Map；`effectiveTools()` 原先**无条件**并入已发现工具 ⇒ 工具/插件在会话中途卸载（`RegistryToolPort.unregister`，插件热卸载路径）后，陈旧 schema **仍进上下文**，模型据此调用必然命中**已不存在的工具**。
  - 修法：以**当前目录**为准——目录无则丢弃、仍在则取**目录中的最新定义**；且**能核对才绑定、不能核对不丢能力**（`list` 缺失时保持既有行为，避免打断 #M1 闭环）。

  **L3 · 阈值校准 harness**

  - 新增 `evals/injection-calibrate.mjs` + npm `metrics:injection:calibrate`：**不改 src**，利用 `scanForInjection` 无论 tier 都收全量 `hits` 的特性做离线复算。
  - 含**有效性闸**：候选值取当前手设值时必须与生产原生判决逐例一致（实测 32/32），否则中止。
  - 实测：手设 `(1,1,2,3)` acc 排名 5/256；`external` 1→2 白丢 15pp recall、FP 零收益；`file` 档 2/2 样本 ⇒ 阈值**不可辨识**；最高 accuracy **9 向量并列**。
  - **口径**：n=32 不足以选型，本报告仅用于证明手设值敏感性与暴露缺样本档位，**不作为生产阈值结论**。

  **L6 · 降档决策带可读理由**

  - `buildRepoMapContext` 降档分支增 `context.repomap.degrade` 观测（`reason` / `effect` / `queryChars`），使「档位为何变」可事后判断。

  **行为变更提示**：默认**无**行为变更（护栏未设 ⇒ `off`；`--guard-prompt-injection` 仍等价 `enforce`）。
  新增 env/CLI 取值 `--guard-prompt-injection-mode shadow`；非法取值现在会**抛错**而非静默忽略。
  D4 修复后，已从工具目录移除的「已发现工具」不再进入模型上下文（此为缺陷修复，会改变该异常场景下的行为）。

- 40833c6: 完善度补齐（headless / 权限 / MCP / 检查点）：

  - headless 模式：新增 `-p` / `--print` 单次非交互执行，支持 `--output-format json` 机器可读输出；`approval=ask` 在 CI 无 stdin 环境显式失败（避免永久挂起）。
  - 多档权限：在 auto/deny/rules/guardian/ask 基础上新增 `plan` 只读档（仅放行读类工具，fail-closed 不漏可变工具）。
  - MCP：协议版本对齐 2025-06-18，新增 resources/prompts 能力声明与 resources/list·read·prompts/list·get 方法（未配置后端返回空列表，不伪造）。
  - 检查点：新增文件级回滚——checkpoint 同时快照工作区（基于 git 工作树差异），rollback 同时还原对话与代码（对齐 /rewind）。

- 40833c6: 新增仓库常驻指令加载：支持 AGENTS.md / AGENTS.override.md / CLAUDE.md / CLAUDE.local.md（含 @import 嵌套）与 llms.txt，按用户级/项目级/子目录级分层注入系统上下文（fail-closed：读取失败静默跳过，不阻断主流程）。
- 80cb12d: 检索评测集第二方复核收口 + 精排默认回关（opt-in）

  - `tests/fixtures/recallQueries.ts` EXTENDED 51 条经第二方独立逐条复核（KEEP 43 / FIX_ANCHOR 4 / REPLACE_QUERY 4 / DROP 0）：4 处过泛锚点改为定义字面（`scanForInjection` / `class LineTransport` / `class AuditSink` / `class MemoryExtractor`），4 处答非所问的查询重写；修正后单测三不变量与 `recall-query-audit` 门禁复验通过，all84 命中画像 63.1%（冻结 core33 78.8% 不变）。
  - `evals/rerank-ab.mjs` 退役内联 33 条，改接 fixture 全量 84 条（新增 core33 / extended51 分层增益与 querySource 口径）；复核后复跑：core33 +5.9pp / extended51 +0.4pp，基准档（K=14）点增益 +2.6pp 但 CI95 [−1.59, +7.59] 跨 0 ⇒ 两关未过。
  - **行为变更**：按「CI 下界 > 0 才配当默认」纪律，`RepoMapContextEngine` 精排默认回关为 opt-in（`opts.rerank: true` 或 env `OMNI_RERANK=1` 显式开启）；`evals/production-defaults-check.mjs`（默认档/opt-in 双逐字对拍 + env 探针改向）与 `benchmark/swebench_predict.mjs`（复刻解析口径跟随生产默认）同步。core33 上 opt-in 仍 +9.1pp（78.8% vs 69.7%），深池场景建议显式开启。新增 `tests/unit/rerankDefault.test.ts` 三例行为钉（默认==关、env==开、产出可区分防死旋钮）。

- 40833c6: 安全左移与网络防护：CI 新增 `security` job（依赖审计 npm audit + 密钥扫描 gitleaks + 依赖准入检查）；新增 SSRF 防护 `src/security/ssrfGuard.ts`，默认拦截云元数据端点（169.254.169.254 等），对 A2A HTTP 传输与 provider 探针做 fail-closed 校验。
- 501c24a: 受种技能（`skills`）从「只有编程入口」补成可用能力：配置文件 `skills` 内联数组 + `--skills <file.json>`（可重复），两条通道同一份 fail-closed 校验；并修掉沿线暴露的两处真缺陷。

  **新增输入通道**

  - 配置文件：`omniharness.json` 的 `skills: [{ name, description, instructions, tags? }]`（`FileConfig` + `KNOWN_KEYS` + `FIELD_VALIDATORS` 三处登记）。
  - CLI：`--skills <file.json>`（可重复；文件为数组或 `{"skills": [...]}`），与内联数组合并，**同名以旗标为准**（技能注册表对重名直接抛错，故合并时显式去重）。
  - 链路：`argParser.configDefaults`（file→CLI）→ `CliBuildConfig`（CLI→partial，`CliSkillFlags` 合并两条来源）→ `ConfigFactory`（`assembleSkillStack` → `SkillRegistry`）。
  - 校验 fail-closed 且**带位置**：非数组 / 单项非对象 / `name|description|instructions` 缺失或全空白 / `tags` 非字符串数组 / 同源重名 / 文件读不到 / JSON 非法 —— 报错指明 `omniharness.json: skills[0].xxx` 或 `--skills <path>: ...`。
  - 只收**声明式子集**（`SkillEntry = Pick<Skill,'name'|'description'|'instructions'|'tags'>`）：莫尔组合 / 相变固化等运行时字段不允许由配置注入（否则等于让配置伪造「这技能是涌现/固化来的」）。归一化结果**写回**配置（`name: " a "` 会被裁剪），避免「校验通过但 `match()` 永不命中」的静默失效。

  **沿线修掉的两处真缺陷**

  - **S1 受种技能从不注入**：`Agent` 的技能注册表是可选第 2 参数，而 11 个 `new Agent(runtime)` 生产调用点里**只有 1 个**传了它 ⇒ CLI / 子代理 / 工作流 / eval 全部路径上，受种技能永不进上下文（真机修前：`--skills` 与配置文件两条通道都只有 user 事件、无 `# 技能：…`）。修法：`Agent` 构造函数缺省取运行时组合根那一份（`runtime.config.skillRegistry`），新增调用点不会再漏。
  - **S2 `approval: "plan"` 被校验白名单拒绝**：`ENUM_VALUES.approval` 漏了 `'plan'`，而 CLI 枚举（`cliEnums.APPROVALS`）、`FileConfig.approval` 与运行时（`cliBuildConfig` 的 planMode 分支、`agentRuntimeHost` 的 `'plan'` 覆盖）都支持它 ⇒ 配置文件写 `"approval":"plan"` 直接报非法。已三处对齐并加回归用例。

  **同批新增：全栈真机体检（前端）** —— `tests/integration/liveUiE2e.test.ts`：起**真实 `serve`**、用**真 Chrome** 打开**真实构建产物**，跑通 `SPA → /rpc turns.run → Agent → SSE → UI` 并钉住 HTTP 面（`/healthz`、`/`、`/metrics`、`/rpc`）；以服务端日志 `/rpc 200` 作反向印证，防「前端自嗨、后端没跑」的假绿；`cwd` 与 `storage-dir` 均为临时目录（零额度、零副作用），缺浏览器则显式 skip。`npm run test:integration` 由 10/10 变 **11/11**。

  **验证**：`tests/unit/configSkillsWiring.test.ts` 11/11（文件校验/映射、旗标解析、合并语义、两种文件形态、7 类非法输入的报错位置、`ConfigFactory.build` → 注册表、真 Agent 命中即注入 / 未命中零注入、`approval:'plan'` 回归）；**真机双通道实测**（`--model-adapter mock` 看事件流）两条通道各自注入 `# 技能：…` system 事件；`check --strict` 554 文件零违规、`audit:config-wiring` 554 文件全绿、`lint` 0 告警、`arch:gate` 0 违规、`format:check` 通过、全量单测 + 覆盖率达标记（覆盖率门禁 exit 0，行覆盖 100%）。文档：`omniharness.json.example` 补 `skills` 示例、`docs/integration.md` §6 补「受种技能」小节。

- 8de336a: SSRF / 出站策略表**配置化**（用户指定）：`METADATA_HOSTS` / `INTERNAL_SUFFIXES` / `IPV4_BLOCKS` 三张硬编码表移入配置。

  **动机**：三张表原先写死在 `SsrfGuard` 里——想加一个自建元数据端点、或放行某个内网域，都必须改代码重新发布；
  而这类表本身就是**策略数据**（随云厂商清单与企业网络拓扑变化）。现下沉为配置字段 `ssrfPolicy`，
  实现里只保留**默认档**（缺失字段回落默认，零配置开箱即用、行为与历史一致）。

  **改动（装配→运行时→消费全链）**：

  - 新增 `src/security/ssrfPolicy.ts`：`SsrfPolicy` / `SsrfPolicyConfig` / `DEFAULT_SSRF_POLICY` /
    `resolveSsrfPolicy()`（缺省回落默认；非法条目**抛错**而非静默丢弃）。
  - 配置声明：`FileConfig.ssrfPolicy` 与 `OmniHarnessConfig.ssrfPolicy`；新增
    `src/config/ssrfPolicyValidator.ts` 并接入 `configError` 校验链（与运行时解析器**同源**，
    杜绝「配置层说合法、运行时抛错」的双口径）。
  - 消费方：`SsrfGuard`（元数据主机 / 内网后缀 / IPv4 网段全部取自策略，含 IPv6 内嵌 IPv4 等价写法）、
    `NetworkEgressGuard`（与 SSRF 护栏共用同一份策略与同一 IP 分类器）、CLI 出站守卫
    （`applyNetworkGuard` 用 `resolveSsrfPolicy(args.ssrfPolicy)`）、组合根 A2A 传输
    （`resolveSsrfPolicy(config.ssrfPolicy)`）。配置链路：`omniharness.json` → CLI 层 → 组合根。

  **语义（显式，不静默）**：字段缺省 ⇒ 默认表；字段**显式给空数组** ⇒ 该项清空（危险但显式）；
  非法条目（坏 CIDR、越界前缀长度、不以 `.` 开头的后缀、含空白的主机）⇒ 抛错。

  **行为变更（收紧，已登记）**：`.corp` 原先只存在于出站守卫的私有主机正则里，SSRF 护栏没有它
  ⇒ 两个守卫对企业内网域名判定不一致。配置化时合一，**默认后缀表并入 `.corp`**，SSRF 护栏现在也拦 `.corp`。

  **回归测试**：新增 `tests/unit/ssrfPolicy.test.ts` 7 例（默认档与历史逐字一致 / 自定义表替换语义生效 /
  出站守卫同源 / 非法条目抛错 / 显式清空语义 / 校验器与解析器同源）；既有 `ssrfGuard`、`networkEgress`
  用例全绿；`audit:config-wiring` 六条不变量全绿（新增字段真的被读、被透传、被消费）。

- c0919a8: 去 Docker 化：Terminal-Bench 环境契约改为容器无关。删除 `src/benchmark/terminalbench/dockerfileReader.ts` 与契约里的全部 Docker 语义（`imageBase` / `dockerfilePath` / `workingDir` / `copyDirectives` / `setupCommands`、`SetupCommand` / `CopyDirective`），改为新增 `taskEnvironment.ts`——任务用 `env.json` 显式声明 `python` / `pip` / `apt` / `shell` / `seeds`，未声明的字段回落 Python 生态标准清单（`.python-version` / `requirements.txt` / `pyproject.toml#requires-python` / `apt.txt`，Binder·uv 同款约定），`pip` 参数原样透传给宿主的 `uv pip install`（无镜像拉取、无层解压，且 `-e .[dev]` 这类可编辑安装照样表达）。原生给不出的声明（apt 系统包、构建期 shell 步骤）逐条进 `warnings`，不假装成功；语料侧 20 题的 `Dockerfile`/`docker-compose.yaml` 已删除（环境改由每题 `env.json` 表达）。顺带修正 `TaskParser` 未绝对化路径导致相对 `--tasks` 下参考解 `exit 127`、把环境边界误记成能力失败的真缺陷。
- 9cb124f: 工具按需暴露：默认 33 个工具的完整 schema **不再每步全量注入**（opt-in `OMNI_TOOL_EXPOSURE=plan`）。

  **动机（借鉴 Laya 的高基数实测）**

  - Laya（Apache-2.0 System 1 决策模型）实测：选项数固定、token 预算固定时，**每个选项分到的 token 就是准确率天花板**——77 个选项共享 `head_max_len` ⇒ 每标签仅 3–4 token ⇒ 准确率 0.870 塌到 0.425；其处方是 **coarse-to-fine**（先粗分类相关组、再组内细选）。
  - 工具集同形：`ConfigFactory.build` 默认装配 **33 个工具且全部直载**（`listDirect()` 无一个 deferred），实测 **6937 token（`tokenize` 口径）** 的固定开销**与任务无关**地出现在每一步。

  **改动**

  - 新增 `src/core/toolExposurePlanner.ts`（纯函数、零依赖、确定性）：按任务文本判**类别相关性**（英文按词边界、中文按子串），产出 `visible`/`deferred`/`matchedCategories`/可读 `reason`；`modeFromEnv()` 解析 `OMNI_TOOL_EXPOSURE`，**默认 `off`**。
  - `stepContextBuilder.effectiveTools()` 增 `exposeByRelevance()`：仅 `plan` 模式下按相关性裁剪**直载**集；**经 `tool_search` 发现的工具无条件保留**（不打断 #M1 闭环）。
  - 新增 `evals/tool-exposure-ab.mjs` + npm `metrics:tool-exposure`（免网络免模型，走生产装配本体）。

  **为什么隐藏不等于能力删除（接线安全性的前提）**

  - `ToolIndex` 建自 `registry.list()`（**全部**工具，非 `listDirect()`），且命中经 `discovery.add()` 使后续回合可见 ⇒ 被延迟的工具**仍可经 `tool_search` 找回**。

  **三护栏（方向与权限门禁相反：此处宁多给不少给）**

  - ① 未登记进任何类别的工具**恒可见**（新工具忘登记只会更保守）；② `alwaysVisible` = `tool_search`/`ask_user`/`spill_read`（找回/澄清/回读三通道）**恒可见**；③ **无类别命中 ⇒ 全部可见**（fail-safe，理由如实写进 `reason`）。

  **实测（`npm run metrics:tool-exposure`）**

  - 平均 **33→10.0 个工具、6937→2167 token（−68.8%）**；逐条 −64.9% ~ −86.7%；**无信号任务 33→33、−0.0%**（fail-safe 在数字里可见）。
  - 类别表登记 30 个工具，与真实注册表**零脱节**（不一致即中止，防假绿灯）；未覆盖的恰为恒可见三通道本身。
  - 三护栏回归 10/10、10/10、10/10。

  **行为变更提示**：默认**无**行为变更（`OMNI_TOOL_EXPOSURE` 未设 ⇒ `off`，与本次之前逐字等价）；显式置 `plan` 时，与任务不相关类别的工具将从直载集移出、改为经 `tool_search` 按需发现。

- 8de336a: **工具名收成单一来源**（用户指定，收尾审计 §3.4 的最后一项）：新增 `src/ports/tool/toolNames.ts`，`TOOL_NAMES` 成为工具标识在全仓的唯一声明处。

  **动机**：工具名此前「两头都写」——注册侧 33 个工具类各写一遍 `name: 'read_file'`，消费侧的策略表再写一遍
  （`MUTATING_TOOLS`、plan 模式只读白名单、调度器串行屏障、工具输出信任分级、diff 追踪钩子、变更目标解析、
  默认审批规则、类别暴露表、评估夹具）。改一个名字要改多处，而**漏改策略表不会报错**：只会让
  「写类必须串行 / plan 模式必须拦」这类安全契约对该工具静默失效（§20.8 就实测过
  `rollback | read_file | remember` 同批并发）。

  **改动**：

  - 新增 `src/ports/tool/toolNames.ts`：`TOOL_NAMES`（45 个工具名常量）+ `ToolName` 类型 +
    `MUTATING_TOOL_NAMES`（写类单一口径）。放在**端口层**是因为消费方横跨 core / adapters / security / cli / eval，
    而 `adapters/**`、`security/**` 都不得 import `core/`——只有端口层是共同下游；文件本身是纯常量 + 纯类型。
  - 注册侧：33 个工具类改为 `name: TOOL_NAMES.xxx`（含 `--defer-tools` 涉及的 shell/lsp 全族）。
  - 消费侧：上述策略表全部改为引用 `TOOL_NAMES.*`；`core/toolGate.ts` 的 `MUTATING_TOOLS` 保留导出名与
    `ReadonlySet<string>` 形态（`indexBeta` 有导出），内容直接取自 `MUTATING_TOOL_NAMES` ⇒ 既有调用点零改动。
  - 域内既有常量（`LSP_*_TOOL_NAME`、`RUN_GOAL_TOOL_NAME`、`RUN_WORKFLOW_TOOL_NAME`、`POLICY_EVAL_TOOL_NAME`、
    `AGENT_IDENTITY_TOOL_NAME`）改为别名指向同一张表：导出名不变，值只声明一次。
  - 顺带修掉 `autonomy/workflowRunner.ts` 里残留的 `'run_goal'` 字面量。

  **兼容性**：全部工具名字面量**逐字未变**（有测试逐条钉住历史值）；对外可见的导出名、集合形态、
  审批/白名单语义均不变。`TOOL_NAMES` 未进公开桶（内部单一来源）。

  **机械防线**：新增 `tests/unit/toolNames.test.ts` 4 例，其中两条是**反硬编码守卫**——
  ① 策划分级模块不得再出现工具名字面量（`keywords:` 任务文本模式与类别 `id:`/`hint:` 除外，注释不计）；
  ② `src/adapters/tool/**` 的工具类不得写 `name: '<字面量>'`。以后新增工具若忘了登记，测试直接失败。

  **验证**：`npm test` 2091 例 / 2086 过 / 1 失败（本机 Chrome 环境用例，与基线同一条）/ 4 skip（本轮新增 4 例）；
  `typecheck`（含 web）/ `lint` / `format:check` / `check --strict`（569 文件零违规）/ `arch:gate --strict` /
  `audit:config-wiring`（569 文件、七条不变量）/ `api:check` 全通过。

- 12ab9cf: 消灭「有实现、无接线」：把入口可达性审计查出的 15 个不可达模块全部接进生产路径，并补齐审计中发现的两处真缺口。

  **接线（新增生产调用点，不只是 import）**

  - 可观测性：`otlpTraceExporter` 此前只有自己的单测引用它（写了没接线）。新增 `traceSpanBuilder`（事件→span 纯构造，tool/model/session 三类 span）、`traceCollectingEventPort`（事件端口装饰器：事件原样透传 + 产出并导出 span）、`traceExporterAssembly`（设了 `OTEL_EXPORTER_OTLP_ENDPOINT` 才包装，未设**原样返回**零行为变更）。接线点：`corePortsAssembler`（CLI/服务端/子代理共用一处）与 `Agent.runTask` 的 finally（`EventPort` 增可选 `flush`）。端到端实测：起本地 collector 跑真实回合 → POST 出 `tool.shell` + `session` span。
  - trace 自省（端口 + 只读适配器）：接入服务端与 CLI（只读、冻结快照语义，agent 可自省但不能借道改历史）。
  - TS SDK 客户端（`sdkClient` + `webSocketSdkSocket`）：接入 CLI，可对 `serve` 的 WS 端点发真实 JSON-RPC。
  - MCP 官方 SDK 服务端适配器：`mcp serve` 优先走 SDK 适配器，不可用时回落手写实现并如实报因。
  - eval 门禁件（`bootstrap`/`passK`/`isolatedEvaluator`/`reasoningRouter`/`editDriftDetector`）与进化算子（`annealedAcceptance`/`diversityGuard`/`failurePatternMiner`/`rewardCoverageMeter`）：接入 eval 脚本与 RLVR 闭环的真实调用路径。

  **审计中新发现并修掉的两处真缺口**

  - **服务端默认绑定**：`httpServer.listen(port)` 未传地址 ⇒ Node 默认绑 `0.0.0.0`，而该服务能驱动 agent 执行任意工具（含 `--auto-approve`）⇒ 等于把无鉴权的远程执行入口开到局域网。新增 `ServerAuthGuard`：默认只绑回环；非回环**必须**配令牌否则拒绝启动（fail-closed）；配了令牌后除 `/healthz` 外一律要求 `Authorization: Bearer`，HTTP 与 WebSocket 共用同一守卫。`serve` 支持 `OMNI_SERVE_HOST` / `OMNI_SERVE_TOKEN`。
  - **`config.update` 无法清空覆盖**：`undefined` 是 no-op、空串/null 会被原样写坏（`baseUrl=''`/`null` 破坏厂商端点拼装）⇒ `null` 现定义为**显式清除**（从覆盖集合与落盘结果双双删除，避免 `mergeConfigs` 只覆盖不删除导致旧值复活）；前端留空即发 `null`。

  **前端 F4/F5/F6/F8 缺口收口**：四项此前已在 `fefadc3`/`33f9f51`/`9763db6` 落地（roadmap 表滞后）；本轮补真实缺口——中止**立即**收口且不残留 streaming、重生成补**回退**、编辑重发改为**回填输入框**、配置保存后**重拉并刷厂商目录**、路由未变也立即收口且打开文件写 hash。web 单测 137 → 157。

  **另修** `stress` 假红（测法：预热后取基线 + 强制 GC）与 `eval:veto` 断链（引用不存在的 `context/codeGraph.js`）。

- 12ab9cf: 补齐「不完整项」与「写了但未接线」：工具面（LSP 全局符号/浏览器截图/PTY/OS 沙箱自述/非 npm 自验证）、可观测（trace 只读自省 + TS SDK + MCP 官方 SDK）、评测与进化（RLVR 晋升准入/隔离评测/漂移检测），以及**基准可复现**（uv 定位修复）；入口可达性检测器修正后 **src 553 文件、不可达 0**。

  **工具面**

  - LSP：新增 `lsp_workspace_symbols`（`workspace/symbol`，不需先知道文件）、`lsp_document_symbols`（层级压平）、`lsp_code_action`（只呈现不应用），全部按能力门控注册并进规划模式只读白名单；`LspResultNormalizer` 抽离使 `LspProcessAdapter` 从 27 方法降到 16（守住「上帝类」红线）。
  - 浏览器：`browser_screenshot` 产品化——注册前可用性探测（不暴露必然失败的死工具）、三类失败各给**可执行**建议（`CHROME_PATH` / `OMNI_CDP_ENDPOINT`）、跨调用复用同一 headless 浏览器、断链时在途 CDP 请求立即失败、截图经 `ToolResult.files` 附件通道返回。
  - PTY：新增 `shell_interactive`（无 PTY 能力如实报错，不静默降级成管道）+ `ptyCapability`；进 `ToolGate.MUTATING_TOOLS`（不能绕过审批）。
  - OS 沙箱：新增 `sandboxCapabilityTable`（`doctor` 如实打印各 profile 可达性与依据，不伪造）、`linuxLandlockSandbox`、`linuxUnshareSandbox` 与 `unshare` profile（CLI/配置枚举同步）。
  - 自验证：`SelfVerifyCommandDetector` 支持非 npm 仓库（pytest/cargo/go/maven/gradle/rspec/dotnet/make），并修「显式 `selfVerify.command` 被『仓库有测试脚本』闸门否决」的断链；`testCommandNarrower` 把整仓测试收窄到失败用例。
  - `htmlToText` 保留标题层级与链接（`text (URL)`，仅 http/https）。

  **可观测**

  - 只读 trace 自省接线：`trace.read` RPC + `omniharness trace read`（冻结快照、无写方法）；修 `ReadonlyTraceReader.byKind` 的 `seq` 语义错（过滤后子流下标 ⇒ 「按 seq 回放定位」指错）。
  - TS SDK 客户端：`omniharness sdk call/ping` 打真实 `/ws`（`ping` 用真实存在的最轻 RPC，不自造方法名）。
  - MCP：官方 SDK 成为 `mcp serve` 默认路径（`McpSdkProbe` 逐子路径实载探测；不可用/启动失败回落手写实现并**如实打印原因**）；新增 `GatedToolPort` 保证换实现后审批+沙箱门禁不丢。

  **评测 / 进化**

  - `PromotionAdmission`（多样性闸 → 退火接受 → 失败模式挖掘）接入 RLVR 晋升路径，回调只由外层控制器持（否则两级闸只是事后观测）；覆盖率低于阈值**整轮不晋升**（fail-closed + 诚实降级表述）。
  - 评测隔离路由（只在快照副本上跑评测，生成方工作区不留副作用）、SWE-bench gold 漂移检测。
  - `SafeRemoveTree` 入库：修 `9dc88d9` 引用未入库文件导致的**干净检出构建失败**。

  **基准可复现（真缺口）**

  - `NativeExecutor` 原先只用 PATH 探测 uv，而 uv 官方脚本默认装在 `~/.local/bin`（不在 PATH）⇒ 装了却判不可用、整条判定链路 fail-closed。新增 `UvLocator`（`OMNI_UV` → PATH → 平台已知位置，按目标平台拼路径，找不到列出全部候选），`describe()` 如实暴露 `uv=<路径|缺少>`，`uv venv`/`uv pip install` 改用解析出的绝对路径。
  - 出数（子集口径，非官方满分；产物与命令见 `docs/TASK_BOARD.md` §15.3）：Gitee 两关 ✅✅；SWE-bench Verified 33 子集 1/33、25 子集 0/25（envError 0）；Terminal-Bench 20 题 gold 3/20、grep 基线 0/20（envError 3）⇒ **原生 Terminal-Bench 保真度不足以出官方分**（如实登记）。
  - **live 真模型路径修复 + 首跑出数**：`evals/live/bench.mjs` 的 live 分支此前从未执行过，首跑即暴露两处缺陷——`main()` 里 `const cfg = resolveConfig()` 声明在 `if` 块内而标签行三元读 `cfg.model`（scripted 路径短路掩盖 ⇒ live 必抛 `ReferenceError`）；`fixTask()` 把测试文件**内容**当文件名（`seedFiles: { [testSrc]: testSrc }` ⇒ 10 个任务全 `ENOENT mkdir <测试源码>`）。修后实测：`--repeat 1` **12/12 通过**、885,596 tokens、隔离评测 12/12、exit 0；`--repeat 3 --min-pass-k 3,0.9 --min-pass-k-ci 3,0.9` ⇒ **Pass@1/2/3 = 1.000，CI=[1.000,1.000]**（bootstrap 95%、2000 轮固定种子）、2,505,441 tokens、`✅ 门禁达标`。另更正：`npm run eval:ci` 零 key（`--swebench` 走 ScriptedModel，`总 token: 0`），已实测 exit 0——旧记载说它「含真实模型调用」是错的。

  **前端 F4/F5/F6/F8 收口 + `threads.rewind`**

  - 重生成改为**服务端真回退**：新增 `threads.rewind`（截断持久化事件流、运行中拒绝、失败不写盘），前端先等服务端回退成功再重发，失败报因不重发；协议 schema / `docs/protocol.md` / Rust SDK fixture 同步。
  - 中止**立即**收口（幂等、迟到增量丢弃）；配置保存后重拉配置并刷新厂商目录；ChangesTab hunk/文件级 accept/reject 真写回；路由未变也立即收口 + 同一会话去重 + 打开文件写 hash。

  **检测器修正**：入口不再把 `src/cli/**`、`src/server/**` 整体当入口（那会让「丢进这两个目录」自动算接线，实测漏报 `sessionRewindService`），并新增「只被单测引用」判据（单测是证据、不是调用方）。

### Patch Changes

- 27bbf01: Agent 核心探针审计（7 处真实缺陷）+ 开场注入幂等化（长会话不再重复堆同一段技能/记忆指令）。

  **修掉的 7 处缺陷（每处都有「修前红 → 修后绿」探针）**

  - **工具调用链抛错留下孤儿 `tool_call`**：`ToolScheduler.safeExecute` 的失败结果被 `StepToolExecutor` 丢弃 ⇒ 投影出含**未响应 `tool_call_id`** 的 `assistant(tool_calls)`，上游兼容端点硬 400（可达路径：插件 `pre` 钩子抛错、外溢落盘失败、工具端口抛错）。现补录失败 `tool_result` 并上报 supervisor。
  - **native 执行成功后回退 JS 重跑**：`catch` 把「记录结果/`post` 钩子失败」误判为原生失败 ⇒ 写类工具可能双写。现 `try` 只包住 `native.runTool`。
  - **plan 只读白名单漏 3 个只读工具**（`lsp_workspace_symbols` / `recall` / `spill_read`）：文档与档位描述都说要放行，实现漏登记（写类工具仍逐一断言拒绝）。
  - **`SemanticIndexCache.clear(root)` 是空操作**：键含两个 `|` 却按第一个切分 ⇒ 陈旧向量索引脏读。
  - **`ToolResultSpiller.replace` 丢 `error`**：失败结果外溢后模型只看到「未知错误」，且拿不到 `spill://` 读回句柄。
  - **`DeterministicCompressor` 破自身「三大定律」**：截断不按 `maxLines` 收敛 ⇒ 逐轮变长（16→17→18）、非幂等、`ratio>1`、标记自称「省略 0 行」。
  - **`run_workflow` 步骤失败仍返回 `ok:true`**（与其 `@returns` 相反）⇒ 所有按 `ok` 分流的消费者被骗。

  **开场注入幂等化（本笔同时修）**

  - `resume`/`fork` 会先 hydrate 历史，而技能/记忆 primer 原先**每回合**无条件注入 ⇒ 同一段技能指令在长会话里出现 N 次（第 3 轮 3 份），白烧 token 并稀释注意力。
  - 现改为：技能**按逐条渲染文本判重**（保留「每回合重新匹配、任务转向后新技能仍注入」的能力），记忆 primer 按内容特征前缀判重；primer 仍默认关闭。行为可观测：长会话 prompt token 与重复 system 条数下降。

  **验证**：新增探针/回归 5 个文件共 **22 例全绿**；既有 `planApproval` 4/4、`deterministicCompressor` 13/13、`contextEfficiency` 16/16 未退；`typecheck`/`build`/`check --strict`（554 文件零违规）/`arch:gate`/`audit:config-wiring`/`audit:maturity`/`eslint --max-warnings=0` 全绿。

  **行为变更提示**：① 工具 `pre` 钩子抛错从「注释声称上抛、实际被吞且丢结果」改为「记为失败 `tool_result` 并继续」（保住配对不变量，否则上游 400）；② 压缩后长会话 prompt token 显著下降（每次压缩从 O(steps) 份摘要降到 O(1)）；③ plan 模式放行 3 个只读工具；④ `run_workflow` 失败时返回 `ok:false`。

  **已知未修（如实登记，待产品决策）**：压缩器「无模型则退化为截断」未实现且 head 空分支 fail-open（超预算可能原样透传却报 `compacted:true`）；`shrinkLossless` 的 JSON 往返并非无损（`1e400`→`null`、重复键、>2^53 精度）；原生 token 估算用 Unicode 标量而 JS 用 UTF-16 码元（emoji/星平面不一致）；`run_workflow` 的 `maxConcurrency:0` 可能永久挂起（疑，未独立复现）；子代理/工作流的取消不传播（功能缺口）。

- 05c4d4f: **审计 §3.5 六项清理**（用户指定「全部进行清理过」）：哈希链算法合一 + 修裸 NUL 缺陷、覆盖率门禁从**假绿**改成真门禁（并挖出同源第二层假绿）、eval 脚本全部接入 npm script、文档死链门禁、并**更正一条不成立的审计结论**。

  - **审计哈希链**：新增 `src/util/hashChain.ts`（`HashChain.GENESIS` + `static hash(prev, canonical, sep)`）
    作为算法与创世哈希的**唯一定义**；`auditSink` 与 `jsonlRuntimeTelemetry` 改为调用它，各自保留
    自己的**规范化正文**与**分隔符**——分隔符参与哈希，改它等于改写已落盘历史，故**不做统一**（这才是先前
    「分叉」的真相，审计只说对了一半）。顺带修掉一个真缺陷：`auditSink.ts` 的分隔符原为源码内的**裸 NUL 字节**
    （不是转义序列），使该文件被读取工具 / diff 判为二进制；改为 `'\u0000'` 后**行为逐字节不变**（golden 实测一致）。
    新增 `tests/unit/hashChain.test.ts`：两条链各一条 golden 哈希（防止静默改链）、算法等价性与分隔符敏感性、
    以及 **`src/**` 与 `defaults/**` 内无裸 NUL 字节**的守卫。**已落盘的审计链与遥测链哈希不变。**
  - **覆盖率门禁（修 bug，两层）**：`coverage` 脚本里的 `--test-coverage-include='dist/**'` **匹配不到任何文件**，
    覆盖率表只输出 `# all files | 100.00` 一行 ⇒ 旧门禁**恒真**（审计以为只是「粒度粗」，实测是假绿）。
    修正为 `dist/src/**/*.js` 后真实聚合 **90.54%（508 文件）**；`scripts/coverageGate.mjs` 重写为
    **按文件冻结基线**（`scripts/coverageBaseline.json`）：任一文件低于基线（容差 0.01）即红、
    新增文件低于 `MIN_NEW_FILE_COVERAGE`（默认 30%）即红、高于基线则提示用 `--dump-baseline` 收紧。
    支持 `--from-file <报告>`（离线复核，兼容 PowerShell 重定向产出的 UTF-16LE）与 `--list`。
    **同源第二层假绿（收尾时实测发现）**：npm 在 Windows 走 `cmd.exe`，脚本里的**单引号是字面量**，
    于是 include 变成带引号的字符串、又匹配不到文件，报告再度只剩聚合行——**门禁只在看「表里有几行」，
    不在看「本该有行」**。故：① 脚本引号改双引号（cmd/sh 均正确）；② 门禁新增**空表守卫**，
    没有任何逐文件行即阻断，并把「检查引号口径」写进报错（已用旧报告反证能被拦下）。
    另：按文件冻结值会**随宿主漂移**（`bashAppRootMapper.js` 的被覆盖分支取决于本机能否发现 POSIX bash；
    本机 `bash` 是 WSL 存根，源码未改动而单测重跑两次一致 72.85%，基线 78.81% 来自当时能探到 bash 的运行），
    故新增 `scripts/coverageEnvDependent.json`：**经实测诊断**的宿主相关文件按**下限**校验并在输出中标注，
    **不对任何文件静默放宽**。
  - **eval 接入 npm script**：新增 `scripts/runEval.mjs`（唯一入口：`--list`、缺 `dist` 时给出构建提示、
    参数与退出码透传、脚本名不存在时退出 2 并列出可用项），新增 `eval:list` / `eval:run`，
    并把**顶层 `evals/*.mjs` 全部 38 个**接成 `eval:<名字>` 别名。`evals/context-efficiency/bench.mjs`
    **有意未接线**（依赖同目录 `run.sh` 的 bash + tsc 管线，硬接成别名在无 bash 的 Windows 上会「永远红」）。
  - **文档死链门禁**：新增 `scripts/docLinkCheck.mjs` —— **markdown 链接目标**不存在即红（阻塞），
    反引号内的路径提及按**文档相对 OR 仓库根相对**双口径解析后与冻结基线比较（基线
    `scripts/docLinkBaseline.json`，当前 90 处唯一提及），并接入 `pre-commit` 与 `npm run check:doc-links`。
    实测：**markdown 链接目标 0 处死链**。
  - **审计结论更正（不改代码）**：「公开面泄漏测试替身（`MockModel` / `MemoryStorage` / `PassthroughSandbox`）」
    **不成立**——三者都是**生产可达**的正式实现（默认模型适配器 / `--storage-adapter memory` 的实现 /
    沙箱档位 `passthrough` 的注册实现）。按原建议弃用或删除，等于宣布默认适配器与可选档位将移除。
    核验证据与「不要删」的结论已写入 `docs/API_STABILITY.md`。
  - **仍未清（1 项，附迁移清单）**：JSON-RPC pending 六处**去重**。其**缺陷层**（`mcpClient` 无 reject 通道）
    已修并有回归；去重层未做，因为实测六个站点形态不一致（`httpBridgeTransport` 只有 `resolve` 回调、
    `serverEventBridge` 是 `{resolve, timer?}` + 计数式 `denyAllPending`、`a2aClient`/`cdpClient`/
    `lspJsonRpcConnection` 是 `{resolve, reject, timer}`、`sdkClient` 是 `{resolve, reject}` + socket close 钩子），
    统一需一张支持「可选 reject / 可选定时器 / 纯回调」且保留 `failAll → count` 的泛型表。

- 773bdb7: 修掉两条 CI 门禁的本地红灯，并把内核编码修复在本机端到端验证完毕。

  - `npm audit --audit-level=high` 原报 4 个 high：全部来自可选依赖 `@huggingface/transformers` 的传递
    依赖。用 npm `overrides` 钉到已修版本：`sharp@^0.35.4`（原 0.34.5 命中 libvips/libheif 公告）、
    `adm-zip@^0.6.1`（原 0.5.x 命中 zip 解压内存放大/符号链接覆盖公告）⇒ 现在 `npm audit` 报
    **found 0 vulnerabilities**。语义嵌入真机复验仍正常（pipeline 0.4s，区分度 gap 0.0779）。
  - `npm run format:check` 原对 28 个文件报红，现全量格式化后为 `All matched files use Prettier code style!`。
  - 本机补齐 Rust 工具链（rustup + rsproxy 的 `stable-x86_64-pc-windows-gnu`，复用仓库自带
    `.cargo/config.toml` 的 rsproxy 源与 `rust-lld`）后重编内核：`cargo fmt --check` /
    `clippy --workspace --all-targets -- -D warnings` / `cargo test --workspace` 全绿；
    `nativeAliasBridge` 由「产物过期 skip」变为 3/3 实跑通过，真机 `echo 别名桥-ok` 回传正确中文
    （此前 `鍒悕妗?ok`）。

- 8de336a: 修「默认数据不随包发布」与「SSRF 策略在探测路径上不生效」两处配置化收尾缺陷，并新增一条门禁不变量。

  **缺陷 1（发布即不可用）**：`package.json#files` 未含 `defaults`，而 `defaults/README.md` 与迁移说明都已写明
  「必须含 `defaults`，否则安装后启动即报错」——**声明与事实不符**（自我宣称未落实）。npm 包会缺
  `defaults/*.json`，安装后**启动即抛错**（`builtinDefaults.json()` 读不到数据，fail-closed）。
  已修：`files` 加入 `defaults`。

  **缺陷 2（配了却不生效）**：`server/services/providerProbe.ts` 两处
  `assertNotSsrf(url, defaultSsrfOptions())` 写死默认档 ⇒ 用户在 `omniharness.json` 配的 `ssrfPolicy`
  在**厂商探测路径**上不生效（与本仓反复登记的「声明未接线」同型）。已修：新增
  `ssrfOptionsFor(policy)` 统一入口（默认档 + 注入策略，避免「只传 policy ⇒ 本地端点被误拦」的 E2 形态），
  `fetchModelsEndpoint` / `probeViaChat` / `probeProvider` 增加可选策略入参，
  `ModelCatalogService` 的两个探测点注入 `resolveSsrfPolicy(file.ssrfPolicy)`；
  组合根 A2A 传输（`makeA2aTransport`）也收敛到同一入口。

  **新门禁不变量 I6（内建数据即随包发布）**：`audit:config-wiring` 由六条不变量扩到七条——
  `builtinDefaults.json('<name>')` 的每个数据名必须有 `defaults/<name>.json`，且 `package.json#files`
  必须含 `defaults`；带故障注入 selftest 用例（护栏自身不是假绿）。这一条正是缺陷 1 的机械防线。

  **回归测试**：`providerAccess.test.ts` 新增「注入策略 ⇒ 发请求前即被 SSRF 拦 / 默认档不拦同一主机」；
  `ssrfPolicy.test.ts` 新增「`ssrfOptionsFor` 不丢默认档」；`configWiring.test.ts` 随门禁覆盖 I6。

  **验证**：`npm test` **2087 例 / 2082 过 / 1 失败（本机 Chrome e2e，环境问题，与基线同一例）/ 4 skip**；
  `check --strict`（569 文件零违规）、`arch:gate`、`api:check`、`audit:config-wiring`（569 文件、七条不变量
  ＋ selftest）、`audit:maturity`、`checkNodeEngine`、`lint`（0 告警）、`format:check`、`typecheck`（含 web）全绿。

  **清理**：删除两个一次性 codemod 临时脚本 `scripts/tmpPolicyTableCodemod.mjs` /
  `scripts/tmpToolNameCodemod.mjs`（脚本自述「跑完即删，不入库」），避免它们入库变成新的死资产。

  **留档（刻意未改）**：`util/builtinDefaults.ts` 的包根反推写死 `'../../..'`——对 `dist/`（测试与发布布局）
  正确，源码布局直跑会指向仓库**父目录**。**不做向上搜索**：那会在「某一层意外存在 `defaults/`」时静默读到
  别的数据，属 fail-open，与本模块 fail-closed 的口径冲突；现口径为「要么读到正确目录、要么响亮抛错」，
  且仓库内所有入口（`npm test` / `coverage` / evals / bench）都是先 build 再跑。

- c12d5b5: 修 `npm run smoke` 的 4 GB 堆爆（确定性、非网络问题）。根因：`ContextEngine.walk` 自带一套只跳 `node_modules`/`dist`/点目录的遍历，与本仓 `WorkspaceFileWalker.DEFAULT_IGNORED_DIRS` 不一致，于是 `eval-data/`（2.3 GB、10.4 万个随仓克隆的 `.py`）与 `target/`（2.2 GB Rust 产物）被 repo-map 全量读进内存（本工作区实测可遍历语料 152,249 文件 / 4.6 GB）。修法：忽略策略收敛为一份（复用 walker 清单）+ 跳过符号链接 + 三道内存闸（文件数 2 万 / 单文件 512 KiB / 语料总量 32 MiB），并把「截断」与「超大文件被排除」经 `IndexedCorpus.truncated` / `skippedLargeFiles` 与 repo-map 尾部一行「覆盖度」如实回报，不静默。顺带修掉被堆爆掩盖的第二个真缺陷：repo-map 作为尾部 system 消息注入时，`MockModel` 按「末条必须是 user」判定首回合，导致工具回路在真实装配下走不到（`smoke` 步数 1 而非 ≥2）——改判「末条非 system 消息是 user」。验收：`npm run smoke` 退出码 0；新增 `contextEngineCoverage` 单测 5/5（含真机回归：索引本仓根目录 4.6 GB → 1.5 秒）。
- cdf7da3: 把上一条审计里"未根治/残留/假红"的四类问题全部闭环。

  1. full 模式（`light:false`）不再可能静默吃内存：`IndexOptions.light` 语义由"默认 full"翻为
     `light !== false`（不传即安全档 light，生产 `CorpusIndexCache` 行为不变），并给 full 加硬预算
     `MAX_TOTAL_BYTES_FULL = 5 MiB`（依据实测 0.37 GB/MiB ⇒ 峰值 ≤ ~1.9 GB）：触顶即**拒跑**
     （fail-closed，绝不静默只索引一半），确需更大语料必须显式传 `maxTotalBytes` 承认代价。
     两个确需 full 的评测脚本（`rank-veto-retro.mjs`、`context-efficiency/bench.mjs`）改为显式声明。
  2. 两个按 root 键的进程级缓存加界：`codeReferenceGraph` 图信号缓存 `MAX_CACHED_ROOTS=8` +
     插入序淘汰；`projectInstructions` 指令缓存 `MAX_INSTRUCTIONS_CACHE_KEYS=16` + 先清过期再淘汰最旧。
  3. 修掉一个真缺陷：原生内核 `decode_output` 只按 `CP_OEMCP` 解码，而受限令牌子进程实测输出
     UTF-8 ⇒ `echo 别名桥-ok` 回传 `鍒悕妗?ok`（`?` 不可逆）。现与 JS 侧 `OutputDecoder` 对齐为
     "先严格 UTF-8、再 OEM 回退"，并加 Rust 单测。
  4. 清掉假红与门禁污染：3 例 shell 单测原本在 Windows 上用 POSIX 命令（`ls`/`cat|grep|wc`）而
     平台 shell 是 cmd.exe，改为各平台自洽命令（意图不变），`shellTool` 14/14；`.omniharness/**`
     进 eslint ignore、`.omniharness/`+`.omni-worktrees/`+`target/` 进 `.prettierignore`（运行时产物
     不再能让门禁 EPERM）；`nativeAliasBridge` 增"预编译产物 vs 源码 mtime"判定，产物过期时显式
     skip 并提示 `npm run native:build`，不伪装通过也不制造假红。

  终态：全量单测 1763 项 / 1758 通过 / 0 失败 / 5 skip；`npm run smoke` 退出码 0；`npm run lint`
  0 告警；`check --strict` 零违规；`arch:gate` 无新增违规。诚实边界：本机无 Rust 工具链，第 3 项
  的内核修复无法在本机重编验证（由 CI 的 cargo job 覆盖）。

- 2783f00: 配置化收尾三件：包根定位改为「包根锚点」、全仓 JSDoc 脱块修复 + 新标准规则、临时脚本清理。

  **1. `util/builtinDefaults.ts` 的包根定位不再写死级数**（上一轮登记为「刻意不做」，本轮改为有锚点的实现）：
  原先 `resolve(dirname(import.meta.url), '../../..', 'defaults')` 只对 `dist/src/**`（测试与发布布局）正确，
  源码布局（`src/util/`）会解析到仓库**父目录**。现改为 `BuiltinDefaults.locatePackageRoot()`：从模块自身目录
  向上逐级查找**同时含 `package.json` 与 `defaults/`** 的那一级（最近者胜，上限 4 级），两种布局都命中。

  **为什么这不是 fail-open**：若只找名为 `defaults/` 的目录，一旦某一级父目录碰巧存在同名目录就会**静默读到
  别人的数据**；要求同级存在 `package.json` 作为包根身份锚点后，命中的必然是本包根，向上 4 级仍找不到就
  **当场抛错**（而不是拿一个猜出来的相对路径去读）。回归测试覆盖：随包布局、源码布局、只有 `defaults/` 而
  无 `package.json`（必须抛错）、向上有界（深目录必须抛错）、嵌套包根取最近者。

  **2. JSDoc「注释脱块」清零 + 新标准规则（`auditStandards` 第 12 项）**：全仓 **31 个文件 / 94 行**的
  JSDoc 续行缩进不等于「注释起始列 + 1」——即历史上自动补写 `@returns 无返回值。` 时被追加到**注释块外**
  （`*` 与 `*/` 缩进为 0–2，而块首 `/**` 在第 2 列），Prettier 不管 JSDoc 缩进、原门禁也不查，故长期存在。
  现一次性机器修复并把规则接入 `auditStandards.mjs`：`--delta` 增量门禁**只增即红**，全量审计在 SUMMARY
  打印该度量，另加 `tests/unit/standardsJsdocIndent.test.ts` 钉住「度量已接线 + 真实仓库为 0」。

  **刻意不做的相反方向（附理由）**：本规则**不**禁止 `void` 方法写 `@returns 无返回值。`——`auditStandards`
  增量门禁的「方法缺@returns」项把「有显式返回类型的方法」（含 `void` / `Promise<void>`）计入分母，
  `@returns 无返回值。` 正是满足该项的合规写法；要改这条政策，须先改那条门禁的口径（属独立决策，不在本笔）。

  **3. 清理**：删除本轮一次性 codemod 脚本（`scripts/tmpJsdocIndentFix.mjs` 等，脚本自述「跑完即删」）。
  codemod 第一版按注释 token 起点累加行长算偏移，导致替换位置右移 `openCol` 个字符、把正文改坏
  （`@returns 无返   回值。`）；已回滚那 31 个文件后重写为「按整行偏移 + 改完自证 0 违约才写入」。

  **验证**：见看板 §20.15；`check --strict`、`arch:gate`、`audit:config-wiring`（七条不变量＋selftest）、
  `audit:maturity`、`audit:standard --delta`、`lint`、`format:check`、`tsc --noEmit`（含 web）与全量单测全绿。

- cda9a14: **JSON-RPC 在途请求簿记收成单一实现**（用户指定「把其他问题全解决掉」）：新增 `src/util/pendingRequests.ts`，七个站点全部改接，删掉各自的 pending/超时/id 关联拷贝。**未改动任何对外行为**（超时文案、计数契约、幂等语义逐条保真）。

  - **动机**：审计 §3.5 记「JSON-RPC pending/超时/id 关联重复 6 处」。那份重复里**已经**长出一个真缺陷
    （`mcpClient` 无 reject 通道，传输关闭时在途请求只能等各自超时，调用方表现为「卡住」——已在上一轮单独修掉），
    而它之所以会长出来，正是因为七份实现各自演进：有的记得清超时定时器、有的忘了；有的有拒绝通道、有的只有 resolve。
    本轮把**簿记**收成一份，把**语义差异**交给调用方显式表达。
  - **新增 `PendingRequests<K, V>`**：`register` / `take` / `settle` / `fail` / `failAll` / `settleAll` / `size`。
    不变量：① 每个被登记的处理器**恰好**在一条路径上收尾；② **移出条目的同时清掉超时定时器**
    （因此不存在「已兑现但定时器仍在、稍后又 reject 一次」的双收尾，超时回调通过 `take` 的返回值判幂等）；
    ③ 一次性收尾返回条数（供日志与断言）。
  - **差异如何保留**（不是把七种形态硬抹成一种）：
    `reject` 可缺省（`httpBridgeTransport` 只登记成功通道，语义不变）；超时可缺省（审批等待上限可 0 = 不限时，
    保留 `OMNI_APPROVAL_UPLINK_TIMEOUT_MS=0` 旧行为）；超时动作由 `onTimeout` 决定
    （`a2aClient`/`cdpClient`/`lspJsonRpcConnection`/`mcpClient`/`sdkClient` 为 **reject**，
    `serverEventBridge` 为 **兑现 deny**）；一次性收尾分 `failAll`（断开全拒）与 `settleAll`
    （断连一律 deny，`denyAllPending(reason)` 仍**返回条数**）。
  - **改接站点（7）**：`a2aClient`、`httpBridgeTransport`、`cdpClient`、`lspJsonRpcConnection`、`mcpClient`、
    `sdkClient`、`serverEventBridge`。连带删掉：本地 `Pending`/`PendingRequest`/`PendingCall` 接口、
    `cdpClient`/`lspJsonRpcConnection`/`mcpClient` 的私有 `failAll`、`sdkClient` 的私有 `rejectPending`
    与「包一层只为 clearTimeout」的 resolve/reject 包装、`serverEventBridge` 内联的 `settle` 与定时器分支。
    `cdpClient`「任何 promise 都不得永久悬着」与 `mcpClient`「传输无关闭通知 ⇒ 必须显式 close」两条不变量
    **提升到类注释**，不再挂在被删的私有方法上。
  - **行为保真（逐条核对）**：超时文案逐字未变（`A2A 调用超时` / `CDP 命令超时（<ms>ms）` / `LSP 请求超时` /
    `MCP 请求超时` / `SDK 请求超时`）；登记仍发生在**发送之前**；`mcp.request.timeout` 告警字段与触发时机不变；
    重复响应与重复审批保持幂等。
  - **回归**：新增 `tests/unit/pendingRequests.test.ts`（9 例）；站点侧 **15 个测试文件 97 例** +
    审批/LSP 侧 **9 个文件 67 例**全过。
  - **覆盖率效应（含门禁处理，均标明判定依据）**：去重后 `mcpClient` 87.26→85.29、
    `httpBridgeTransport` 97.66→97.63（两次全量复现一致 ⇒ 删掉**被覆盖的样板**使分母变小，逻辑搬进
    98.83% 覆盖的 `pendingRequests.js`，非行为覆盖丢失 ⇒ 更新冻结值）；`wsConnection` 85.14→84.42
    则**源码未被触及**，去掉新增测试文件后全量恰好回到 85.14% ⇒ 判定为**测试文件集合改变并发交错**的
    度量抖动，**不改基线**而是登记为**下限 84%**（`scripts/coverageEnvDependent.json`，附证据）。
    同时 6 个站点覆盖率上升（`a2aClient` 94.44→100、`sdkClient` 91.14→95.38、`serverEventBridge` 95.68→96.5 等），
    基线与聚合相应收紧：**90.54% → 90.56%（509 文件）**。

- 9b01d81: 性能与安全加固（2026-09-22 全量盘点后收尾，全部带实测数字与回归测试）

  **性能**

  - `Bm25Index` 补倒排表：`search` 原为「每个查询词 × 每篇文档 × 每个 token」的全量扫描
    （实测真实 `src/` 语料 563 文件 / 98.6 万 token：英文 5 词 **18.6 ms**、中文 22 词 **252 ms**，
    且按 token 数严格线性 ⇒ 32 MiB 配置上限外推 **≈2.6 s/步**）。改为 `addDocuments` 期建 postings
    后实测 **0.9 ms / 1.8 ms（20×–138×）**，`query()` 生产链路高热后 **33–223 ms → 2.7–5.6 ms**。
  - 顺带修一处**既有缺陷**：`addDocuments` 分批调用时 `averageLength` 只用「本批 token / 全部文档数」，
    平均长度被算小（由新回归测试「分批 ≡ 单批」逐位对拍暴露）。生产调用点均为单批，故零行为变更。
  - `ConcurrencyLimiter.release` 的 `waiters.shift()` 改游标 + 过半压缩：`parallelMap` 会先为全部条目建
    promise ⇒ 原为 O(N²/concurrency)，实测 n=20k/40k **576 / 927 ms → 45 / 63 ms（≈14.8×）**。
  - `TokenEstimator.countCjk` 由 `match(/CJK/g)`（为计数分配整个命中数组）改码点区间循环：
    实测 170 KB 文本 **101.0 → 48.2 µs（2.10×）**，零分配、计数逐字相等。
  - `ContextBreakdownEstimator.toolTokens` 增按定义对象的 WeakMap 缓存：原先每步对 33 个工具
    重新 `JSON.stringify`（该步实测占 2.53–34.41 ms 的一部分）。

  **安全**

  - **SsrfGuard 元数据拦截被 IPv6 写法绕过（实测复现）**：`inspectUrl('http://[::ffff:169.254.169.254]/…')`
    在默认策略下返回 `blocked:false`，与「云元数据地址永远拦截」的声明矛盾（`[::ffff:7f00:1]`、
    `[0:0:0:0:0:ffff:a9fe:a9fe]` 同理）。现按 IPv6 数值分组解析内嵌 IPv4（mapped / compatible / NAT64 / 6to4，
    含尾部点分写法），不可解析一律 fail-closed。
  - **`safeReadFile` 缺 realpath 校验（实测复现越权读）**：工作区内指向外部的 junction/symlink 可读到宿主任意
    文件（RPC `fs.read` 与 HTTP `/files` 共用该函数），而同路径 `WorkspaceGuard.isInside` 为 false——
    属漏用既有守卫。现改为复用 `WorkspaceGuard.resolveSafe`（词法 + realpath 双层），对外文案不变。

  **回归测试**：新增 `tests/unit/bm25Index.test.ts`（与暴力实现逐位对拍 / 分批等价 / df·idf 同源）、
  `tests/unit/concurrencyLimiter.test.ts`（FIFO 链式移交 / 5000 等待者 / 异常释放）；
  `ssrfGuard.test.ts` 与 `safeFs.test.ts` 补绕过用例。检索零回归：生产默认档命中率仍为
  **78.8%**（对抗口径）/ **100%**（自然口径）。

- 29ceb96: **性能两节收口（审计 §2.4 / §2.5）**：repo-map 结果记忆化、消息级 token 计数缓存（带实测门槛）、SQLite 单事务写入、前端滚动帧派生缓存。**每条先实测再决定**——其中 `all()` 浅拷贝实测为可忽略，明确不修并留档。

  - **repo-map 结果记忆化（§2.4）**：新增 `src/context/repoMapMemo.ts`（单槽位 memo）。
    键 = `root + 查询 + 生效旋钮指纹`（`layered/fileK/symK/rerank/prf/payloadPlan` 的**env 覆盖后**取值，
    故运行期改 env 不会命中旧键）；失效判据**另加语料实例比对**——`CorpusIndexCache` 重新索引即产出新实例，
    于是「缓存生命期严格不长于语料生命期」，比按 TTL 猜更精确；`clear()` 同步失效。
    实测（本仓真实语料）：memo 未命中 24.1 ms → 命中 **0.557 ms/次**。
  - **消息级 token 计数缓存（§2.4）**：新增 `src/context/tokenCountCache.ts`（按内容字符串的**有界 LRU**，
    默认 512 条），接在 `TokenEstimator.estimate` **内部**——`ContextBreakdownEstimator` / `ContextCompactor`
    零改动受益。实测：40 步混合长度会话 **11.48 → 1.61 ms（7.13×）**；长文本命中 0.1–0.6 µs
    （重算最长 1712 µs @256 KB）。
    **关键取舍（实测驱动）**：极短文本上「查表 + LRU 续命」会**倒挂**（哈希 + 两次 Map 操作 > 直接逐码元计数），
    故设 `MIN_CACHEABLE_CHARS = 512` 门槛，短文本直接计数、不进缓存；交叉点数据表写在源码注释里可复算。
  - **SQLite 写入改单事务（§2.5）**：`save` 的 `DELETE` + 逐条 `INSERT` 原各自自动提交，
    既慢又会留下半截会话。改为 `BEGIN … COMMIT`，失败 `ROLLBACK`（fail-closed：宁可留旧快照，不要半截历史）。
    实测 500 事件 **3360 ms → 16.9 ms（≈199×）**（审计原文记 8.1 ms，与本机差两个数量级，以本次实测为准并并列）。
  - **前端滚动帧派生缓存（§2.5）**：新增 `web/src/ui/models/StreamModelCache.ts`（单击缓存，
    键 = `events 引用 + events.length + busy`），把「块划分 / 键 / 末条 user·assistant id / 工具调用 id 集合」
    移出**滚动帧**路径（`scrollTop` 是 state，每帧都重渲染）。实测每帧 **147 / 151 / 380 µs**
    （1000 / 3000 / 10000 事件）→ 命中 **0.1–0.3 µs**。失效判据含 `length` 以兜住「就地 push 同一数组」，
    残留边界（长度不变的就地内容修改）写在类注释里。
  - **明确不修（实测为可忽略）**：`AppendOnlyEventLog.all()` 的浅拷贝实测 4.5 / 9.2 / 17.9 µs
    （1000 / 3000 / 10000 事件），每步 2–4 次 ⇒ 0.018–0.072 ms/步，比上面第一项的 24.1 ms 小三个数量级；
    改它需要把返回类型收成 `readonly` 并冻结共享快照（调用方可能就地排序/改写），**风险大于收益**，留档不修。
  - **回归**：`tests/unit/tokenCountCache.test.ts`（9 例）、`tests/unit/repoMapContext.test.ts`（+4 例，
    含「旋钮不同即不同键」与早退不污染槽位）、`tests/unit/sqliteStorage.test.ts`（+2 例，
    含**写入中途失败整体回滚**）、`web/test/streamModelCache.test.mjs`（7 例）。
    web e2e 那条既有失败经回退本次 web 改动复测同样失败 ⇒ 环境性、非本轮引入。

- ae189a6: **持久化耐久性两处缺陷修复**（审计 §1.7 P3 批次，第十轮）：`EventPersister` 会**丢弃**在飞期间到达的落盘请求；`JsonlStorage` 一行坏 JSON 就让 `load` **静默返回空历史**。两处均带窗口复现级回归测试。

  - **`EventPersister` 落盘竞态（修 bug）**：原 `flush()` 在「已有 flush 在飞」时**直接 return**，
    该请求即被丢弃——write-behind 定时器触发时若上一次写仍在飞，期间新增的事件要等**下一次** `schedule()`
    才可能落盘；回合末的 `await persister.flush()` 也会在在飞写完成**之前**返回，调用方误以为已持久化。
    改为 **flush 串行队列**（每个 flush 排在上一次之后）：既不丢请求，又保证 `flush()` 返回时
    **它自己的快照确已写入**。失败仍降级为 `session.persist.failed` warn 且不推进 `lastSavedCount`
    （下一次 flush 自动重试同一批），dispose 后不再接受新请求但**已排队**的落盘照常完成。
    回归：`tests/unit/eventPersister.test.ts`（5 例）——用可控存储替身把写入挂在闸门上，
    真实复现「在飞期间的新事件」与「await flush 早于写入完成」两个窗口；另覆盖增量跳过、空事件、
    fail-soft 重试、定时器落盘与 dispose 语义。
  - **`JsonlStorage` 静默空历史（修 bug）**：原 `load` 把整文件 `JSON.parse` 放在同一个 `catch` 里，
    **一行**非法 JSON（崩溃残行/截断）就让 `load` 返回 `[]`，调用方无法区分「没有历史」与「读不出来」
    ⇒ 会话续跑与回放会**悄悄丢光全部上下文**。改为逐行解析：坏行**跳过并告警**（`storage.jsonl.bad_line`，
    带行号），其余事件照常返回；有内容却全部行失败时另发 `storage.jsonl.all_lines_corrupt`（文件级损坏信号）；
    非 ENOENT 的读取失败改为 `storage.jsonl.unreadable` 告警后返回 `[]`（对外契约不变，但不再无声）。
  - **`JsonlStorage.save` 原子写（同轮顺带）**：原为整文件 `writeFile` 覆盖，崩在半途会留下**半截文件**
    （读方要么解析失败、要么读到看似完整却缺尾的历史）。改为先写 `<file>.tmp` 再 **`rename`** 覆盖
    （同目录 rename 原子），失败时清理半成品，不留 `.tmp` 堆积。
    回归：`tests/unit/storageDurability.test.ts`（5 例：往返保序、覆盖写不留 `.tmp`、
    **个别坏行只丢那一行**、全坏行仍返回 `[]` 不抛错、文件缺失/不可读均返回 `[]`）。
  - **仍未清（审计 §1.7 剩余 2 条，下一轮）**：shell 不消费取消信号（`shellTool.ts` 不传 `signal`，
    最长跑满 600 s 且只杀直接子进程）；spill 产物与涡环包无回收（`fileSpill` 文件只增不减、
    `vortexRingSpillAdapter` 的 `rings` 表只增不减）——收口须按本项目纪律把**限额进配置**而非硬编码常数。
  - **覆盖率门禁两处政策修正（工具）**：新增测试文件会让**未被改动**的文件覆盖率抖动
    （实测第三次：`evalHarness.js` 87.78↔87.28，源码未动、去掉新测试文件即精确回到 87.78）⇒ 不再逐个登记豁免，改为
    ① **1 点度量漂移容差**（容差内的下浮如实列出、不阻断；真实回退远大于 1 点），
    ② **基线棘轮**：`--dump-baseline` 默认只升不降（新值更低时保留旧值，`--force` 才可下调）。
    本轮实测：收紧 3 个（`jsonlStorage` 96.61→100、`eventPersister` 95.7→100、`browserSession` 91.75→92.41），
    棘轮拒绝对 `evalHarness` 下调；聚合 **90.58% / 509 文件**。

- b65d60e: **余项清理**（用户指定「把余下的问题全部处理干净」）：文档化全部 CLI 旗标、修掉 `mcpClient` 缺拒绝通道、shell 超时口径合一、Python 源码迁出 `src/`、README 死引用改正。

  - **CLI 帮助**：上轮冻结的 15 个「在 `FLAG_TABLE` 里但帮助未记载」的旗标全部补进 `defaults/cliHelp.json`
    （`--prompt` / `--model` / `--memory-encrypt` / `--memory-key-file` / `--model-router` / `--model-router-file` /
    `--turn-token-budget` / `--stream-text` / `--no-model-retry` / `--no-model-circuit-breaker` /
    `--model-circuit-breaker-threshold` / `--model-circuit-breaker-open-ms` / `--cost-budget-usd` /
    `--cost-budget-on-exceed` / `--cost-budget-soft-ratio`）。测试里的「未文档化冻结基线」随之**清空**
    ⇒ 此后**任何**新增旗标未写进帮助即测试失败。`--cost-budget-on-exceed` 的取值也纳入「枚举必须派生」检查。
  - **`McpClient` 拒绝通道（修 bug）**：`PendingRequest` 增加 `reject` 与超时定时器句柄，新增 `close(reason)`
    立即拒绝全部在途请求并拒绝新请求；`mcpConnector` 的连接句柄关闭改为**先 `client.close()`、再关传输**
    （原先 `Transport` 契约无关闭通知 ⇒ 在途请求只能等各自超时（默认 10s）才被拒，调用方表现为「卡住」）。
    回归测试：`close()` 立即拒绝（超时故意设 60s，证明不是等超时）+ 幂等 + 关闭后新请求快速失败。
  - **shell 工具族超时**：新增 `adapters/tool/shell/shellTimeouts.ts`，把两族**重复的 1s 下限**收成一处；
    默认值与上限**刻意保持分开**并注明语义差异（前台 shell 的 600s 是**钳制上界**；交互式另有**默认超时**
    与 1 小时上限）。新增两条断言钉住「下限共用 / 上限确实不同」。
  - **Python 源码迁出 `src/`**：`src/omniharness/*.py`（3 文件 3919 行，此前不在任何 TS 门禁内）移至
    `python/omniharness/`；`scripts/run_omniharness.py` 的 `SOURCE_ROOT` 与文档串同步（路径深度不变）。
  - **文档死引用**：`docs/TASK_BOARD_2026-09-13.md` 从未存在（真实看板为 `docs/TASK_BOARD.md`），而 README
    写明「以它为准」；非归档文档 8 处引用（README、docs/README、两张历史板、llms.txt）全部改正。
  - **如实说明**：`--auth-required` 由裸 `serveArgs.includes(...)` 改为 `CliArgReader.has(...)` 属**惯例统一**，
    **不是** bug 修复（`Array.includes` 本就是精确匹配）。

  **仍未清（附理由，见 `docs/DEFICIENCY_AUDIT_2026-09-22.md` §3.5 逐项状态）**：审计哈希链 canonical 分叉
  （改哈希须逐字节保真 + golden 测试）、JSON-RPC pending 六处重复（7 个传输类语义各异，需专项重构）、
  公开面泄漏测试替身（破坏性 API 变更，须走弃用流程）、覆盖率门禁聚合（门禁政策决策）、
  35 个 eval 脚本接线（需决策且可能变「永远红」）、余下文档死路径（建议先做死链检查器再按批修）。

- 0509393: **审计 §1.7 剩余两条缺陷修复（shell 会话取消 / spill 无回收）+ §3.2 逐条核实**：shell 此前**完全没消费取消信号**（回合已取消的命令仍跑满自己的超时，最长 10 分钟），spill 产物与涡环包**只增不减**。

  - **shell 不消费取消信号（修 bug）**：`ToolContext.signal` 早已由 `stepToolExecutor` 注入，但 `ShellTool`
    没把它传进执行参数。修法三件：① `ShellRunOptions.signal` 参数透传；② 新增 `ProcessTreeKiller`
    **终止整棵进程树**——Windows 走 `taskkill /PID <pid> /T /F`（失败回退单进程 kill），POSIX 让 shell 成为
    进程组长（`detached: true`）后用 `kill(-pid)`；**超时与输出超限两条路径一并换用**，因此
    「只杀直接子进程」这个更广的隐患在三条终止路径上一起消失；③ 执行结果新增 `aborted` 字段，工具层
    状态优先级改为 **取消 > 超时 > 截断 > 退出码**，文案「命令被会话取消（已终止整棵进程树）」。
    回归：`shellTool.test.ts` 新增 2 例；「整棵树都死了」用**孙进程心跳停止**断言。
    **反向验证**：临时改回「只杀直接子进程」后该用例**会红且是挂死**——存活孙进程仍持有 stdout 管道，
    Node 的 `close` 永不触发 ⇒ 工具调用 Promise 永不 settle（即该缺陷在生产里的真实后果）。
  - **spill 产物与涡环包无回收（修 bug，限额进配置）**：`FileSpill` 新增 `maxFiles`（默认 **512**，`0`=不回收），
    每次写入后按 **mtime 删除最旧**（失败只告警）；`VortexRingSpillAdapter` 新增 `maxRings`（默认 **256**，
    `0`=不淘汰），超限按 **LRU** 淘汰（`read` 命中即续命）并 `spill.ring.evicted` 告警，被淘汰 id 读回仍
    `undefined`（既有 fail-closed 语义）。两个限额均以 `OmniHarnessConfig` 字段
    （`spillMaxFiles` / `spillMaxRings`）暴露，由 `configBuilder.buildSpill` 与 `corePortsAssembler` 消费，
    **不硬编码策略**。回归：`spill.test.ts` 新增 6 例（上限回收最旧、`0`=不回收、**上限经配置生效**、
    LRU 续命、`maxRings=0`、**回收路径的三条失败分支**：根缺失 / `stat` 失败（悬空 junction）/ `rm` 失败
    （非空目录），三者都只告警不中断其余回收 ⇒ `fileSpill` 行/分支覆盖 96.43%→**100%**）。
  - **§3.2 逐条核实（结论含一处判断更正）**：`resources/comfyui_node_reference` 与 `evals/*.report.json`
    **均已 0 tracked**（前两条确已结项）；第三条「记忆引擎三份重复＝死资产」**不成立、故不删**——
    两个引擎在 `resonantField.enabled === false` 时由 `memoryStackAssembler` 显式构造，有 3 个测试文件断言，
    覆盖率 87.4% / 97.95%，且 `src/index.ts` **对外导出**（删除属破坏性 API 变更）。
    正解是先 `@deprecated` 再按次版本移除并迁移到 U1 统一基板；审计标题与结论已据此更正。
  - **新登记一条待办（本轮不修）**：Windows 下 `cmd /d /s /c` 会破坏性重解析**带引号参数**的命令
    （探针实测：`node "<绝对路径>" "<目录>"` 被粘成一个参数）。属解析契约级改动，需先建用例矩阵，见审计 §1.9。

- 40833c6: shell 工具加固：绑定 `workspaceRoot` 限制工作区外路径、增加最大输出长度护栏与超时可配、修正此前与实现不符的「沙箱内执行」注释（实际经统一门禁 `ToolGate.gate` 拦截，工具层不再声称自带沙箱隔离）。
- 4a19976: 子代理 / 工作流 / 取消传播：3 处已复现缺陷修复 + 1 处接线缺口补齐（每处都有「修前红 → 修后绿」探针）。

  **修掉的缺陷**

  - **`run_workflow` 的 `maxConcurrency: 0` 永久挂起（已独立复现，最危险）**：`ConcurrencyLimiter` 的 `acquire()` 对 `limit < 1` 恒不满足 `active < limit`，且永无释放者 ⇒ 工作流**永不 settle**（无异常、无日志、无法收尾）。实测 `maxConcurrency` 为 `0 / -1 / NaN / "2"` 时 1000ms 内不 settle。现 `ConcurrencyLimiter` 构造期 fail-closed（`RangeError`，带可执行信息），`WorkflowRunner` 对构造期选项与每轮 `def.maxConcurrency` 双重校验并抛 `WorkflowSpecError`（新增错误码 `WORKFLOW_SPEC`），`run_workflow` 工具把它转成 `ok:false` 的可执行错误。同一根因的 `--subagent-concurrency 0` 也一并堵住。
  - **成功但无 `finalText` 的步骤被当成依赖失败**：`WorkflowRunner.run` 原先把「`ok && output === undefined`」并入失败集合 ⇒ 下游被 fail-closed 跳过、整体 `ok` 变 false（把「这一步没吐文本」误判为「这一步失败了」，并传染全部下游）。现语义为「成功即成功，空产出只是没有内容可注入下游」，下游照常执行。
  - **`--subagent-max-steps` 只覆盖三条子代路径之一**：`run_goal` / `run_workflow` 的子代 runtime 读的是**主会话** `maxSteps`，只有 `subagent` 走 `SubagentOrchestrator` 的子代预算。现三条路径共用同一份子代步数预算，缺省口径与编排器一致（`DEFAULT_SUBAGENT_MAX_STEPS`）。实测：`subagentMaxSteps: 1` 时子步模型调用从 9 次（= 主会话 8 + 1）降为 2 次（= 1 步 + 1 次兜底总结）。

  **功能缺口补齐：取消传播（父 `cancelCurrentRun` → 子代）**

  - 传播路径：`Agent` 会话取消令牌 → `StepRunnerDeps.signal` → `StepToolExecutor` 注入 `ToolContext.signal`（新增可选字段）→ `subagent` / `run_workflow` / `run_goal` 工具 → 子代 runtime 的模型端口装饰器 `cancellableModel`（父信号并入每次模型请求的 `signal`，请求结束后解绑监听，长会话不堆监听器）。
  - 收尾语义：父取消后子代在飞模型请求立即中止并抛 `CancelledError`（不再继续烧 token）；工作流不再启动下一层步骤（记为「已取消」并继续阻塞其下游）；目标循环不再开启下一轮迭代（含跳过达成度判定那次模型调用）；子代理编排器在「已取消」时 fail-closed 拒绝派生（连并发槽位都不等、不建隔离工作树），隔离工作树仍由既有 `finally` 回收，不留孤儿。
  - 修前实测（真实 Agent 主循环 + 真实工具注册表）：父取消后工作流步骤 / 目标循环 / 子代理的在飞请求**均未收到 abort**（子代继续跑）；子代理 `SubagentRunner` 取消后模型调用计数不收敛。修后 6 例全绿。

  **验证**：新增 3 个测试文件共 16 例全绿；既有 `workflowRunner` 9/9、`runWorkflowToolContract` 3/3、`runGoalTool` 3/3、`stepToolExecutorPairing` 5/5、`goalRunner` 4/4、`loopV21` 7/7、`errors` 2/2 未退；`typecheck`/`build`/`check --strict`（558 文件零违规）/`arch:gate`/`audit:config-wiring`/`audit:maturity`/`eslint --max-warnings=0` 全绿。（`subagent.test.js`、`configBuilder.test.js`、`apiStability.test.js` 等在本机沙箱下因禁写临时目录而红：全部 13 例为 `EPERM: mkdtemp`，与本笔无关。）

  **行为变更提示**：① 非法并发上限从「永久挂起」变为「立即拒绝」（`ConcurrencyLimiter` 抛 `RangeError`；启动期若配置了非法 `subagentConcurrency` 会直接报错而非挂死）；② `run_goal` / `run_workflow` 的子代步数上限改为子代预算（缺省 12，不再跟随主会话 `maxSteps`）；③ 成功但无产出的工作流步骤不再导致下游跳过（`ok` 变 true，属**修复**而非破坏，但会改变依赖该假故障的观测）；④ 新增公开导出 `WorkflowSpecError`、`requireConcurrencyLimit`，`ToolContext` / `SubagentRequest` / `WorkflowRunnerOptions` / `GoalRunnerOptions` 新增可选 `signal` 字段（向后兼容）。

  **已知未修（如实登记）**：① 子代工具级事件绕过事件桥进父流并改写父状态——已复现：子代调用 `todo_write` 后父事件流收到 1 条 `todo` 事件（子代自身的 `session_meta/user/tool_call/tool_result/assistant` 仍留在桥内），且父待办被整表替换（`last-write-wins`）；根因是子代工具视图复用父注册表的**同一批工具实例**（实例在注册期已捕获父 `EventPort` / 共享 `TodoPort`），修法需按子代为工具重新绑定端口（组合根重构），未在本轮动手。② `rerootStorage` 对未知存储后端直接复用父存储，与其 JSDoc「不静默共享父存储」自相矛盾（未复现实害，未改）。③ `withWorktreeLock` 只锁创建未含清理（本机沙箱禁 spawn，无法用真实 worktree 复现）。

- 675fc56: **Windows 带引号参数的 shell 命令修复（审计 §1.9）**：`cmd /d /s /c` 与 Node 的 argv 转义两层叠加，把带空格路径/引号参数**粘成一个参数**（实测报错 `Cannot find module '...\"...\"'`）。修法是给命令整体加一层引号并让 spawn **原样传递 argv**。

  - **根因**：`ShellInvocation.args()` 的 Windows 形态是 `['/d','/s','/c', command]`。`cmd.exe` 的 `/s`
    会按自己的规则剥引号并重解析命令行，而 Node 在拼 Windows 命令行时也会对 argv 转义一次；
    命令自带引号（带空格路径、`-e "..."`）时两层规则错位。
  - **实测选型（探针，脚本路径与文件名都含空格）**：旧形态 ❌、`/d /c` + 原文 ❌、
    **`/d /s /c` + 整体加引号 + `windowsVerbatimArguments: true` ✅**（`/s` 恰好剥掉我们加的那层）。
  - **修法**：cmd 形态改为 `['/d','/s','/c', '"' + command + '"']`；新增
    `ShellInvocation.needsVerbatimArgs()`，并在**三个 spawn 点**（`shellProcessRunner` /
    `backgroundJobRegistry` / `shellInteractiveExecutor`）统一传 `windowsVerbatimArguments`——
    避免「前台修了、后台没修」的口径分叉。**POSIX 形态逐字未变**（`['-c', command]`）。
  - **回归矩阵**（`tests/unit/shellProcessRunner.test.ts` 新增 3 例）：① 含空格路径的脚本与其参数
    **逐字到达子进程**（直接断言子进程收到的 argv）；② 引号内含空格的参数不被拆开；
    ③ **引号内的 `&` 不得被执行成第二条命令**。
  - **反向验证**：临时改回旧形态重跑，矩阵立刻红（报错与当初探针一致：`Cannot find module '...\"...\"'`）。
  - **兼容性复验**：`echo a & echo b` → `a b`、`echo "a&b"` → 字面量、`echo %OS%` → `Windows_NT`、
    管道 / `1>&2` 重定向 / `node -e "console.log(1+1)"` / 引号内套引号 —— 全部正常；
    **不含引号的命令行为不变**（这正是该缺陷长期未被发现的原因），受影响的是「参数带引号 / 路径含空格」类。
  - **一处既有断言随语义更新**：`ptyCapability.test.ts` 的 cmd 形态 argv 期望改为带整体引号的形态；
    `shellInteractiveTool.test.ts` 的 inherit 形态断言由「只断末位」改为**断言整段 argv 形态**
    （两者都附原因注释，均为收紧而非放宽）。
  - **覆盖率门禁容差按实测证据调整（工具）**：本轮又出现两个**未改动**文件超容差下浮
    （`jsonFileKv` −2.41、`memoryStackAssembler` −1.59），用「把新增测试文件从全量集合里去掉即精确回到基线」
    的排除实验确认是**度量抖动**（第四次同型）。故漂移容差 1 → **2.5 点**，四次实测幅度表写进门禁注释；
    同时写明诚实边界：小于 2.5 点的真实回退与噪声无法可靠区分，靠「棘轮只升不降 + 下调须先做排除实验」兜底。
    本轮 `--dump-baseline` 棘轮**保留 6 个更高基线、未下调任何一个**。

本项目遵循 [Keep a Changelog](https://keepachangelog.com/) 精神，版本号采用语义化版本（SemVer）。
未发布版本记录在 `Unreleased` 下；每个已发布版本独立成节。

> 注：当前仍处于 0.x 预发布阶段（API 稳定性标注见各导出符号的源码注释），0.x 的次版本号变更可能包含不兼容修改。

## [Unreleased]

### Added

- 审计日志哈希链：`AuditSink.record` 写入 `seq/prev/hash`（`h_n = SHA256(prev ‖ canonical(e_n))`），`verify()` 三重篡改检出（改内容 / 删条目 / 插条目），跨进程重启 `resumeChain()` 续链。旧格式日志判 `ok:null`（不可验证而非篡改）。
- 合规导出接入链校验：`buildComplianceReport` 暴露 `summary.chain`；CLI `audit export --compliance` 仅在链确凿断裂（`ok:false`）时告警退出。
- 健康探针：`GET /healthz`（存活恒 200）与 `GET /readyz`（核心组件齐备才 200，否则 503）。
- 结构化日志基座 `src/util/logger.ts`：level 过滤 + `AsyncLocalStorage` 传播 traceId，JSON 行写入 stderr；接入审计与 HTTP 请求层。受 `OMNI_LOG_LEVEL` 控制（默认 info）。
- 结构化日志全量铺开：agent 主循环 / 回合 / 单步 / 上下文压缩 / MCP 客户端的高频路径均记结构化事件（session.start/end、turn.start/end、model.request、tool.call/denied/native.fallback/spilled、compaction._、mcp._），经 `log.withTrace` 绑定单次会话 traceId。
- API 稳定性标注：实验性子系统导出符号补 `@beta`（共 293 符号 / 100 文件，覆盖 autonomy/subagent/spill/lsp/identity/policy/tui/plan-todo/worker/code/native/mcp/search/eval/schema/daemon/model 新增适配/retrieval/live/audit/enterprise/skill/plugin）；稳定核心（ports 基础接口、Agent、Container、RuntimeFactory、基础适配器）不标。无 `@deprecated` 候选。
- 零依赖规范自检 `scripts/check.mjs`：阻断级（零运行时依赖 / 禁止第三方裸导入 / TS 文件名 camelCase）恒 exit 1；报告级（文件>400 行、函数>80 行）默认提示，`--strict` 升级为阻断。
- CI 工作流 `.github/workflows/ci.yml`：gate（check + typecheck + build）与 test（npm test + 内置覆盖率文本）。
- 企业能力（D1/D2）：分发包硬化、`src/enterprise/sso.ts` OIDC 库（PKCE S256 + RS256 JWKS + `EnterpriseAuth.authenticate` fail-closed）、`auth login|callback` 子命令、合规导出。
- CLI 枚举参数严格校验（9 个白名单，非法值抛错而非静默回落 passthrough）。
- 工程化基建：ESLint v9 扁平配置（typescript-eslint，仅真 bug 规则 error，未用变量 warn）+ Prettier 3 风格基线；铁律自检 / ESLint / Prettier 三者各司其职，互不抢活。
- 覆盖率门禁 `scripts/coverageGate.mjs`：零依赖解析 Node 内置覆盖率表，行覆盖率低于阈值（默认 80%）exit 1。
- 零依赖 pre-commit 钩子（`scripts/git-hooks/pre-commit`，经 `core.hooksPath` 激活）：铁律自检 + ESLint + Prettier 增量格式化已暂存文件。
- 集中错误码 catalog `src/errors.ts`：`OmniError` 基类 + `ErrorCode` 常量；核心错误类统一继承（带 `code`）。
- 提示注入缓解基线 `src/security/promptInjection.ts`：`PromptInjectionGuard.scan` 启发式检测，仅观测不阻断。
- SSRF 加固：`NetworkEgressGuard` 默认拦截私有/链路本地地址（含云元数据 169.254.169.254、IPv6 ::1/fe80/fc00/fd00），白名单不可覆盖；`blockPrivateRanges` 逃生口。
- 提权复核沙箱默认 `policy`（fail-closed）：`CliDefaults.elevatedSandbox` 与 `ConfigFactory` 回落点由 `passthrough` 翻转，枚举扩 `'restricted'`。
- eval 烟雾任务扩容（2→6）；新增混沌/故障注入测试 `sandboxRobustness.test.ts`。
- CI：gate job 增 `npm run lint`；test job 改 `npm run coverage:check`（构建+测试+覆盖率+门禁合一）。
- **U2：repo-map 上下文引擎接入生产循环**：新增 `src/context/repoMapContext.ts`（进程级按 workspace 根路径 TTL 缓存索引，fail-closed，任意失败返回 null 不崩 agent）；`ContextAssembler.build` 支持动态系统碎片（向后兼容）；`StepRunner` 每步从最近 ≤3 条 user 消息推导查询、取 repo-map 注入 system 消息；`agent.ts` 经 `config.workspaceRoot` 注入。配套 `contextEngine.indexCorpus` 新增 `light` 开关（跳过频域共振/44 万边代码图/LSA SVD，仅留已验证有效的 morph+双 BM25，省时且召回不变）。默认开，env `OMNI_REPO_MAP=0` 关闭。此前该能力仅躺在基准脚本里、真实任务未用上。
- **U4：写类工具执行后主动失效 repo-map 缓存**：`StepRunner.runToolCall` 在 `write_file`/`apply_patch`/`shell`/`delegate`/`subagent` 等 `MUTATING_TOOLS` 成功执行后调用 `clearRepoMapCache(workspaceRoot)`，消除纯 30s TTL 的陈旧窗口（native 与 JS 双执行路径均覆盖）；`maybeInvalidateRepoMap` 全程 fail-closed。新增 U4 不变量单测。
- **本地 Embedding 依赖登记 + 语义召回骨架（破 U3 语义鸿沟）**：按新铁律登记 `@huggingface/transformers`（Apache-2.0，预算超限已显式审批，allowlist 覆盖 `maxInstallKb`/`maxTransitiveDeps`）。新增 `src/ports/embedding.ts`（`EmbeddingPort`，第三方-free 端口层）+ `src/context/semanticRecall.ts`（`SemanticIndex` 余弦最近邻 + `rrfMerge` 混合检索融合，DI 注入端口）+ `src/adapters/embedding/transformersEmbedding.ts`（真实适配器，动态 `import()` 懒加载、模型缺失 fail-closed 回退 BM25）。单测用确定性 FakeEmbedding 证明：查询词与代码字面不同但语义同义时 BM25 漏召回、向量召回命中（U3 残留鸿沟被补）。生产接线（repo-map 同时走语义召回）待模型权重就绪后接入。详见 `docs/EMBEDDING_EVALUATION.md`。
- **真实 LLM live 跑分脚手架（evals/live/bench.mjs）**：复用 `src/eval/evalHarness.ts` 的 `runTask`（已泛化为可注入真实 `ModelPort`，并将 `EvalTask.script` 改为可选 + 结果新增 `usage` token 统计）。脚本读 `OMNIHARNESS_API_KEY`/`DEEPSEEK_API_KEY`/`OPENAI_API_KEY` 与对应 `BASE_URL`，用 `OpenAiCompatibleModel`（DeepSeek/OpenAI 兼容）跑真实编码任务，产出 steps/tool_calls/tokens/成功率。无密钥时打印设置指引并 exit 1，**绝不伪造 mock**；已用不通端点做端到端冒烟测试，确认配置→模型→Agent→RuntimeFactory→模型调用全链路贯通（仅联网失败被如实捕获）。

### Fixed

- 安全：CLI 枚举参数（含 `--sandbox`）由 `as` 裸强转改为白名单校验；`SandboxManager.build` 未知 profile 返回 `UnsupportedSandbox`（fail-closed），消除拼错即静默全放行的 fail-open 链。
- 测试：清理 `native*` 三件套共 12 处 `console.warn + return` / 裸 `return` 静默假绿，改 `test({ skip })` 真跳过。
- 安全：NetworkEgressGuard 漏防 IPv6 环回 `[::1]`（URL hostname 带方括号未剥离）→ `hostOf` 规范去方括号，SSRF 判定统一覆盖 IPv6。
- 可观测性（#OBS-1）：`ToolGate.gate` 把真实拒绝原因（plan mode 未批准 / 审批策略名 / 沙箱拒绝 reason+category+target）透传到 `ToolResult.error`，不再一律压缩成 `"被拒绝: <name>"`。修复 plan mode 用户看到 shell/write_file "失败"却没有任何详情、误以为工具坏的问题——现在 UI/日志直接拿到根因与修复建议。新增 `tests/unit/toolGateDenialReason.test.ts` 覆盖三类透传路径，codeMode/MCP 两处依赖旧字符串的测试同步放宽为 `/拒绝/`。
- **live 跑分 token 用量遗漏（#S29 计量断点）**：`StepRunner.run` 此前只记 `recorder.assistant(text)`，丢弃模型返回的 `usage`，导致事件流无 `usage` 字段、`extractUsage` 恒扫不到、`evals/live/bench.mjs` 全程 `tokens=n/a`。新增 `model` 事件类型 + `EventFactory.model` + `SessionRecorder.usage`，在每步模型响应后立即落库 `usage`，`extractUsage` 现能聚合真实 token 成本。
- **live 评审过严误判**：`fix-off-by-one` 任务原先强校验 `apply_patch` 工具名，但 agent 用整文件重写（`write_file`）同样正确修复了 off-by-one；改为校验修正后文件内容含 `i <= n`（正确性导向），并通过。真实跑分现 3/3 全通过。
- 测试：cliEnumValidation 误将已合法枚举值 `restricted` 当非法值断言（与提权沙箱扩枚举冲突）→ 改用真不在枚举内的值 `passthru`。
- 工程化：`scripts/check.mjs` 的「函数体 >80 行」检测存在 brace-on-next-line 盲区（`function foo()\n{` 写法因开括号不在签名同行而被整段跳过）。改为签名行先匹配、开括号同行则直接用、否则向下（跳过空行/纯注释）最多 3 行定位开括号（箭头体收窄到 2 行防误挂后续无关块），盲区已堵。
- 启动#OBS-3：`buildModel` 用 `args.model === CliDefaults.model` 字符串相等判断「用户是否显式设了 model」——极常见场景下误判：用户配置文件里写 `model: "deepseek-v4-flash"`（恰等于 CliDefaults 占位符），被覆写成 `gpt-4o-mini`，发到 deepseek 端点 → HTTP 400 (`supported: deepseek-v4-pro/flash/vision-exp, you passed gpt-4o-mini`)。改为 `args.model ?? env.OPENAI_MODEL ?? 'gpt-4o-mini'`（`??` 真测 undefined，不再字符串比较），anthropic/responses/llamacpp 三处同样 bug 同步修复。端到端：turns.run 真实命中 `deepseek-v4-flash` 返回「你好！有什么可以帮你的吗？…」，日志无 `model.http.error`。#OBS-2 修复后立即暴露此 bug，两者连环生效——前者让 CLI 能起来真打 API，后者保证打 API 时模型名是用户要的。

- **#OBS-4 — 模型下拉只显示当前选中那一个**：「重新刷新网页时，当前 key 能用的全部模型应全部显示」。根因：`providerPresets.ts` deepseek 兜底仍写 `['deepseek-chat','deepseek-reasoner']`（2026 老版本已作废）+ `modelCatalog()` 仅当 `probeCache` 真测过才列全模型，但探测需 UI 点「检测」才触发——冷启动刷新时下拉永远只 1 项。双重修：① 兜底更新到 `deepseek-v4-flash / -v4-flash-vision-exp / -v4-pro`（实测存在）；② `AppServer` 构造里 `fire-and-forget` 调 `warmActiveProvider()`——按 `baseUrl→modelAdapter+providerKeys` 反查当前 active 厂商并探测，把 `/v1/models` 真实清单灌进 `probeCache`；mock/纯本地适配器跳过探测避免无意义流量。端到端冷启动 + 等 7s 后 `model.catalog` 立即返回 `active.models: [flash, pro, vision-exp]` 三项，不再只 1 个。
- **#OBS-5 — DeepSeek v4 多轮对话 HTTP 400**：错误 `reasoning_content in the thinking mode must be passed back to the API`。原实现依赖 `reasoning` 事件先于 `assistant` 事件到达，事件时序脆弱，跨回合混编就丢字段。修法：① `EventFactory.assistant`/`SessionRecorder.assistant` 增 `reasoning?: string` 可选形参；② `StepRunner.run` 把同一回合 `output.reasoning` 同步塞进 assistant 事件；③ `contextAssembler` 优先读事件自身 `payload.reasoning`，退到老路径 `pendingReasoning`。同一回合思考+正文原子绑定一条事件，下轮 API 必收到 `reasoning_content`。端到端 `create` + `continue` 两轮真模型对话正常返回，无 `model.http.error`。

### Changed

- **依赖铁律翻转：零依赖 → 必要即可依赖（准入制 + 分层隔离）**：`scripts/check.mjs` 由「禁止一切第三方依赖」改为「准入登记 + 分层隔离」四闸门——依赖须登记于 `dependency-allowlist.json`；登记字段 `reason`/`capability`/`license`/`approvedAt`/`layer` 缺一即阻断；许可证仅允 permissive（拒绝 GPL/AGPL/SSPL/BUSL 等）；`src/ports/**` 与 `src/core/**` 恒为第三方-free（架构不塌的底线）。新增机器可读 `dependency-allowlist.json` 与 `docs/DEPENDENCY_POLICY.md`。既有零依赖实现（BM25 / RFC6455 / Ed25519 / N-API FFI / LCS diff）全部保留，不因政策放宽而废弃；当前 `dependencies` 仍为 0。看板 LOCKED 项「零依赖铁律」同步更名为「依赖准入门禁」（门禁恒锁定 ON，严禁 OFF）。
- **默认 `--sandbox` 从 `passthrough` 翻转为 `policy`（P0 安全行为变更）**：开箱即默认拦截危险命令 + 工作区外路径（对标 Codex/Claude 默认拦截）；CLI 默认值（`CliDefaults.sandbox`）与配置文件回落点（`loadedFile.sandbox ?? args.sandbox ?? 'policy'`）同步翻转。需显式 `--sandbox passthrough` 才退回全放行。
- 测试门禁：`package.json` test 脚本加 `--test-timeout=120000` 兜底。
- 分发包：`files` 增补 `examples` / `omniharness.json.example`，加 `publishConfig` / `prepublishOnly` / `repository` / `homepage` / `bugs`。
- CLI 入口 `src/cli/exec.ts` god-class（原 2153 行）拆解为薄调度层 + 继承链 6 个基类（`cliBuildConfig` / `cliServerCmds` / `cliMcpCmds` / `cliDataCmds` / `cliCompareCmds` / `cliNativeCmds` / `cliAgentCmds`）；方法体逐字节等价，仅 `private`→`protected`。`package.json` bin 仍指向 `dist/src/cli/exec.js`，`main()`/`isEntry` 留在该文件；零运行时依赖 / Node 20 兼容 / 禁大函数铁律不变。
- 文件级「过大」债务清零：`src/server/appServer.ts`（原 864 行）拆为继承链三文件——`appServerBase.ts`（共享状态 + 核心助手）/ `appServerHandlers.ts`（profile·bundle·plugin 处理器）/ `appServer.ts`（叶：graph·memory·线程·runGraph 调度）；`AppServerOptions`、三常量（`AUTO_ALLOW`/`DENY_ALL`/`PERSISTABLE_KEYS`）、`GraphRunState` 外提 `appServerState.ts`。`AppServer` 经 `appServerState` 再导出 `AppServerOptions`，对外 API 不变；`loadPlugins`/`applyPluginProfile` 保持 `public`。
- `src/config/omniharnessConfig.ts`（原 666 行）拆为配置类 + `configBuilders.ts`（`build*` 自由函数族）；工具注册簇（`defaultTools` + `registerCore/Agent/AuxiliaryTools` + `demoWorkers`）再外提 `configToolRegistry.ts`。`ConfigFactory.build()` 内 `this.`/`ConfigFactory.` 调用改为自由函数调用；`SubagentPortSeed` 补 `export type`。
- `src/plugin/registry.ts`（原 472 行）拆为 `PluginRegistry` + `registrySources.ts`（4 类 `RegistrySource` 实现与远程抓取助手）；旧文件 `export *` 保 API。
- `scripts/check.mjs` 报告级「文件 >400 行」债务清零：当前 243 个 TS 源文件全部 <400 行、函数体全部 <80 行。
- 死代码清理：引入 `eslint-plugin-unused-imports`（devDep）安全批量摘除未用导入（只动 import 不碰局部变量，零副作用风险）；`@typescript-eslint/no-unused-vars` 剩余 9 处局部变量/参数逐一最小化修复（未用参数加 `_` 前缀、未用 `const` 删除、`ed25519Identity` 累加器 `o` 去末次赋值捕获）。ESLint 警告由 386 → 0。`.omni-worktrees/**` 加入 ESLint ignores（harness 运行时 worktree 产物，非本仓库维护源码）。
- 文件级「过大」债务清零：`src/cli/args.ts`（原 583 行）拆为 `args.ts`（CLI DTO/默认值/解析入口，287 行）+ `cliEnums.ts`（9 个枚举白名单常量，51 行）+ `cliFlagTable.ts`（VALUE_FLAGS + valueOf/checkEnum/enumOf + FLAG_TABLE 数据驱动表，263 行）。`args.ts` 经 `export *` 再导出枚举常量、`export { checkEnum }` 再导出校验函数，外部 import 路径不变；无运行时循环依赖（cliEnums 仅 `import type`，cliFlagTable 仅 `import type` 回指 args）。公开 API 与解析行为逐字节等价。

### 2026-09-06 完善度补齐（对标业界成熟 harness）

#### Added

- 仓库常驻指令加载：AGENTS.md / AGENTS.override.md / CLAUDE.md / CLAUDE.local.md（含 @import 嵌套）与 llms.txt，按用户级/项目级/子目录级分层注入系统上下文。
- headless 模式：`-p` / `--print` 单次非交互执行 + `--output-format json` 机器可读输出；`approval=ask` 在 CI 无 stdin 环境显式失败（防挂起）。
- 多档权限：在 auto/deny/rules/guardian/ask 基础上新增 `plan` 只读档。
- MCP：协议版本对齐 2025-06-18；新增 resources/prompts 能力声明与对应方法（未配置后端返回空列表）。
- 检查点文件级回滚：checkpoint 基于 git 工作树差异快照工作区，rollback 同时还原对话与代码。
- SSRF 防护：云元数据端点默认拦截，A2A HTTP 与 provider 探针 fail-closed 校验。
- CI `security` job：依赖审计 + 密钥扫描 + 依赖准入检查。
- ADR 文档体系：`docs/adr/` 首批 7 条架构决策记录。

#### Changed

- shell 工具：绑定 `workspaceRoot` 工作区约束、增加输出长度护栏与可配超时；修正与实现不符的「沙箱内执行」注释。
- MCP：保留 `initialize` 握手（协议核心，未移除），补全能力声明。

#### Fixed

- 审计遗留：检查点此前仅回滚对话事件、不回滚文件（自称「Escape 式安全网」实为半截 rewind），现已补齐文件级回滚。

## [0.1.0] - 预发布基线

- 六边形端口-适配器架构；22 工具 / 20 端口 / 20 类适配器。
- Rust 内核 N-API FFI（免 MSVC / 免 FFI 库）；工具名别名桥使标准工具下沉 Rust。
- 沙箱多后端（passthrough / policy / restricted + landlock|seatbelt|bwrap fail-closed）；升级审批 EscalationPort。
- 双 BM25 语义检索（工具检索 + 会话检索）；配置四层合并；Spill 外溢；MCP 双向；subagent；plan/todo/UserResponder；goal/ralph 自主长循环；agent-team/workflow DAG。
- 审计落盘 + 导出（json/table/csv）+ 在线 `audit.query` RPC。
