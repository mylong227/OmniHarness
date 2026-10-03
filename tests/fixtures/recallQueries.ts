/**
 * 检索评测查询集（**单一真相来源**）——34 → 84 条（2026-09-22 扩容）→ **193 条**（2026-09-27 再扩）。
 *
 * ## 为什么扩容（`docs/archive/RECALL_HEADROOM_SURVEY.md` §5 建议 4，长期未做）
 *
 * 原集合 33 条使 bootstrap 95% CI 宽达 **±13–15pp**，于是「+3pp / +6pp」量级的改进**不可判定**——
 * 语义路（+6.1pp）与 PRF（+3pp）都是因此长期停在 opt-in。扩容后 CI 收窄，3–6pp 级效果才可判。
 * 2026-09-27 再扩到 193 条（见 {@link GROWTH_RECALL_QUERIES} 的模块注释）：84 条的成对 CI 依旧宽达
 * ±7pp，「1–3pp」级问题（精排判别器）仍不可判。
 *
 * ## 为什么不直接改原 33 条
 *
 * 原 33 条是**历史口径**：看板 §17、调研报告、多处「两关」判定都引用它们的数字。故本模块把
 * 原 33 条**逐字冻结**为 {@link CORE_RECALL_QUERIES}，新增的 51 条放在
 * {@link EXTENDED_RECALL_QUERIES}；消费方应当**同时**报告两档（`core33` 与 `all84`），
 * 既保历史可比，又拿到统计功效。第三批 109 条同理独立成 {@link GROWTH_RECALL_QUERIES}，
 * 并用 {@link FROZEN_COUNT} 标出「84 条冻结全量」这一历史切片。
 *
 * ## 采集协议（新增条目的可复核约束）
 *
 * 1. **锚点必存在**：锚点字面量必须在 `src/` 中真实出现（GT 非空），由
 *    `evals/recall-query-audit.mjs` 机械校验，缺失即中止（防「锚点写错却被当成检索失败」）。
 * 2. **对抗性**：查询文本**刻意避开锚点的全部子词**（camelCase 拆分后的小写词元），
 *    目的是度量「非字面」检索能力，而不是让 BM25 白送分。该约束由
 *    `tests/unit/recallQueries.test.ts` 强制（交集非空即测试失败），作用范围为
 *    {@link EXTENDED_RECALL_QUERIES} **与** {@link GROWTH_RECALL_QUERIES}（所有「新增」条目）。
 *    **范围说明**：冻结的 {@link CORE_RECALL_QUERIES} 保留 2026-09-17 的历史措辞
 *    （当时的口径是「避开锚点的**定义字面**」，如 `registerTool` 的查询里允许出现 `tool`），
 *    改动它们会使历史数字失去可比性。
 *
 *    > **违规处置（2026-10-02）**：以脚本对全部 160 条新增条目复扫，查出 **1 处**违规——
 *    > 锚点 `class PromptCacheUsageReader` 的查询含 `cache`（子词交集非空）。该条属
 *    > **协议违规**（而非「阈值太严」），故按本模块既有处置方式改查询措辞
 *    > （`REPLACE_QUERY`，见该条上方注释），**不放宽判定**。处置后复扫 **0 处**违规。
 *    > 此前 `③` 长期真红的状态记录见 `docs/TASK_BOARD.md` §38.5 / §39.1。
 * 3. **同一语料与协议**：所有条目共用同一 `src/` 语料、同一 GT 定义（锚点字面量所在文件集合）、
 *    同一 hitRate@K 口径。
 *
 * ## 已知代价（诚实登记）
 *
 * 新增条目由人（模型）按上述协议撰写；**2026-09-25 已完成第二方逐条复核**（独立会话，
 * 51 条：KEEP 43 / FIX_ANCHOR 4 / REPLACE_QUERY 4 / DROP 0——4 处锚点过泛改为定义字面
 * `scanForInjection` / `class LineTransport` / `class AuditSink` / `class MemoryExtractor`，
 * 4 处查询答非所问或描述不存在的能力已重写），修正后经单测三不变量 + audit 门禁复验通过。
 * 后续若再修条目，难度分布见 audit 报告（替换即破坏该条的纵向可比性，故不轻易动）。
 */

/**
 * 冻结的历史查询集（33 条，2026-09-17 口径）。
 *
 * **不得修改**（查询文本逐字冻结）：任何改动都会使看板 §17 与 `RECALL_HEADROOM_SURVEY.md` 的历史数字失去可比性。
 *
 * **唯一例外（2026-09-25，被迫）**：第 13 条的**锚点**由 `CosmicWebOptions` 改为 `ResonantFieldOptions`——
 * 前者随 §21.10「遗留记忆双引擎移除」从 `src/` 删除，GT 变空 ⇒ `recall-query-audit` / `recall-precision` /
 * `headroom-analysis` / `production-defaults-check` 四个脚本**当场 fail-closed**（锚点不存在被误读成检索失败，
 * 正是本仓反复治的假信号）。查询文本**逐字未动**（可比性锚在查询侧），只把 GT 定位子改到同一能力的**迁移目标**
 * （U1 统一基板 `ResonantFieldOptions`，`src/ports/memory/resonantField.ts`）。
 * 口径变更登记：本条的历史命中/未命中不再跨 2026-09-25 可比（改动前的历史数字见看板 §17/§21.2）。
 */
export const CORE_RECALL_QUERIES = [
  { q: 'where is tool registration handled', anchor: 'registerTool' },
  { q: 'how does sandbox denial escalate to approval', anchor: 'EscalationPort' },
  { q: 'what does ContextAssembler project events into', anchor: 'class ContextAssembler' },
  { q: 'how are images attached to model messages', anchor: 'imagesOf' },
  { q: 'where is reasoning_effort sent to the openai model', anchor: 'reasoning_effort' },
  { q: 'how does BM25 tokenize CJK text', anchor: 'public static tokenize' },
  { q: 'how is the resonant memory probe mapped from text', anchor: 'resonateByText' },
  { q: 'where is the sandbox policy evaluated', anchor: 'execPolicy' },
  { q: 'how are tool results spilled out of context', anchor: 'spill_read' },
  {
    q: 'which component remembers decisions the operator already blessed',
    anchor: 'ApprovalStore',
  },
  { q: 'how is a signed claim from an agent packaged', anchor: 'AgentAssertionEnvelope' },
  { q: 'tuning knobs for the graph that links distant memories', anchor: 'ResonantFieldOptions' },
  { q: 'settings for the planner that gradually cools down', anchor: 'HeatAnnealerOptions' },
  {
    q: 'options controlling what gets pulled out of conversations',
    anchor: 'MemoryExtractorOptions',
  },
  { q: 'knobs for the parity based error correction layer', anchor: 'QECOptions' },
  { q: 'what signals that a parity check has failed', anchor: 'Syndrome' },
  { q: 'where is the remaining spend captured at a point in time', anchor: 'BudgetSnapshot' },
  { q: 'how is a chain of thought persisted to disk', anchor: 'StoredTrace' },
  { q: 'what normalizes text before it is compared', anchor: 'Canonicalizer' },
  { q: 'how long is a prior yes remembered before asking again', anchor: 'CachedApprovalOptions' },
  { q: 'settings for the belief updater that follows curvature', anchor: 'NaturalGradientOptions' },
  {
    q: 'tunables for the sampler tracking many hypotheses at once',
    anchor: 'ParticleFilterOptions',
  },
  { q: 'how is the local vector model configured', anchor: 'TransformersEmbeddingOptions' },
  { q: 'where are ed25519 signing credentials created', anchor: 'KeyPairSync' },
  { q: 'how are orphaned tool call identifiers tracked', anchor: 'ToolCallRef' },
  { q: 'how is the chat completion provider configured', anchor: 'OpenAiCompatibleModel' },
  { q: 'where do language server error reports come from', anchor: 'Diagnostics' },
  { q: 'how many characters of a conversation are retained', anchor: 'TranscriptChars' },
  { q: 'what does a delegated child task return', anchor: 'SubagentResult' },
  { q: 'what represents one entry in a multi stage plan', anchor: 'PlanStep' },
  { q: 'where are capabilities discovered and registered', anchor: 'SkillRegistry' },
  { q: 'which component gates dangerous tool calls at runtime', anchor: 'SupervisorKernel' },
];

/**
 * 新增查询集（51 条，2026-09-22；2026-09-25 第二方逐条复核并修正 8 条——
 * 见模块头「已知代价」节）。覆盖 core / context / security / server / adapters /
 * observability / evolution / plugin / subagent / eval / memory / sandbox 各域，
 * 每条均满足模块头的采集协议（锚点存在 + 查询避开锚点子词）。
 */
export const EXTENDED_RECALL_QUERIES = [
  // —— 权限 / 审批 / 沙箱 ——
  {
    q: 'how are the five permission levels described to the operator',
    anchor: 'ApprovalTierCatalog',
  },
  {
    q: 'how are allow and deny outcomes derived from configured criteria',
    anchor: 'ApprovalRuleDecision',
  },
  { q: 'which component decides whether an elevated action may proceed', anchor: 'AskEscalation' },
  {
    q: 'how are rule expressions judged without executing any code',
    anchor: 'SafePolicyEvaluator',
  },
  {
    q: 'how are equivalent shell invocations reduced to a single canonical form',
    anchor: 'CommandCanonicalizer',
  },
  { q: 'which isolation backends actually work on this machine', anchor: 'SandboxCapabilityTable' },
  { q: 'is an interactive terminal available on this host', anchor: 'PtyCapability' },

  // —— 检索 / 上下文 ——
  { q: 'where is the growing run history kept in memory', anchor: 'AppendOnlyEventLog' },
  { q: 'how is the parsed repository reused between searches', anchor: 'CorpusIndexCache' },
  { q: 'how are vector lookups reused across successive queries', anchor: 'SemanticIndexCache' },
  { q: 'which dials tune the retrieval behaviour', anchor: 'RecallKnobs' },
  { q: 'how are candidates reordered in a second pass', anchor: 'FileReranker' },
  { q: 'how much of the outline is injected for each hit', anchor: 'RepoMapPayload' },
  { q: 'how are the lexical and vector rankings fused', anchor: 'HybridRanker' },
  { q: 'when does a large tool result get written to a side file', anchor: 'SpillPolicy' },
  { q: 'how is markup stripped before counting characters', anchor: 'HtmlToText' },

  // —— 安全 ——
  {
    q: 'how are outbound requests filtered against private address ranges',
    anchor: 'NetworkEgressGuard',
  },
  { q: 'how is the reliability of fetched content graded', anchor: 'ToolOutputTrust' },
  {
    q: 'how are hostile instructions inside fetched text isolated',
    anchor: 'scanForInjection',
  },
  {
    q: 'how does an in flight request learn that it should stop early',
    anchor: 'CancellationToken',
  },
  {
    q: 'how does cleanup fall back to a child process when bulk deletion is blocked',
    anchor: 'SafeRemoveTree',
  },

  // —— 服务端 / 传输 ——
  { q: 'how are remote procedure calls framed over a socket', anchor: 'JsonRpc' },
  { q: 'how are messages delimited when sent down a pipe', anchor: 'class LineTransport' },
  { q: 'how is the local dashboard protected from other machines', anchor: 'ServerAuthGuard' },
  { q: 'where are past conversations stored for later listing', anchor: 'SessionArchive' },
  {
    q: 'how can an operator return a conversation to an earlier point',
    anchor: 'SessionCheckpoints',
  },
  { q: 'how are file modifications collected for review', anchor: 'WorkspaceChanges' },
  { q: 'how can reviewed hunks be staged or reverted', anchor: 'DiffReview' },
  { q: 'how are daily token budgets reported per model', anchor: 'QuotaService' },
  { q: 'where are extensions loaded and isolated at runtime', anchor: 'PluginHost' },
  { q: 'how are available vendors discovered from the endpoint', anchor: 'ProviderProbe' },

  // —— 可观测 / 审计 ——
  { q: 'where do tamper evident records get written', anchor: 'class AuditSink' },
  { q: 'how are nested timing records assembled for export', anchor: 'TraceSpanBuilder' },
  { q: 'how is spend assigned back to the individual calls', anchor: 'TokenAttribution' },
  { q: 'how is the reusable prefix ratio monitored', anchor: 'CacheHitRateWatch' },

  // —— 进化 / 学习 ——
  { q: 'how does reinforcement from verified outcomes drive promotion', anchor: 'RlvrController' },
  { q: 'how are near duplicate candidates rejected', anchor: 'DiversityGuard' },
  {
    q: 'how does a cooling schedule decide whether to take a worse candidate',
    anchor: 'AnnealedAcceptance',
  },
  { q: 'how is the share of reachable outcomes measured', anchor: 'RewardCoverageMeter' },
  {
    q: 'how are recurring breakdown signatures extracted from runs',
    anchor: 'FailurePatternMiner',
  },
  { q: 'how is the injected capability list trimmed', anchor: 'SkillSparsifier' },
  { q: 'what pulls durable facts out of a conversation', anchor: 'class MemoryExtractor' },
  { q: 'how are repeated identical actions detected and stopped', anchor: 'LoopGuard' },

  // —— 工具 / 工作区 / 并发 ——
  { q: 'where are long running shell commands tracked', anchor: 'BackgroundJobRegistry' },
  { q: 'how are per agent git checkouts created and removed', anchor: 'WorktreeOps' },
  { q: 'how are wildcard patterns turned into regular expressions', anchor: 'GlobMatcher' },
  { q: 'how are picture dimensions read without decoding them', anchor: 'ImageProbe' },
  { q: 'how is the number of simultaneous tasks capped', anchor: 'ConcurrencyLimiter' },
  { q: 'how are many similar items processed at once with a bound', anchor: 'ParallelMap' },
  { q: 'how are transient failures attempted again with growing delays', anchor: 'BackoffParams' },
  { q: 'how is a patch rendered as readable hunks', anchor: 'UnifiedDiff' },
];

/**
 * 扩容查询集（109 条，2026-09-27；R1「精排判别器」调研所需判定力）。
 *
 * ## 为什么再扩（`fileReranker.ts` 模块头明写的缺口）
 *
 * 84 条使成对 bootstrap 95% CI 宽达 **±7pp 量级**，于是「兄弟文件抬升的修法能否带来 1–3pp」这类问题
 * **不可判定**——R1 第一轮（稀有词门）就是在噪声里被读成「−2.4pp / −1.2pp」。本次把集合扩到
 * `193` 条（core33 + ext51 + growth109），CI 收窄约 1.5×，让 2–3pp 级效果可判。
 *
 * ## 采集与复核协议（在模块头三条之上再加两条）
 *
 *  1. **锚点必存在**、2. **对抗性（查询避开锚点全部子词）**、3. **同语料同口径** —— 同模块头。
 *  4. **锚点不过泛**：锚点字面量在 `src/` 中出现的文件数 ≤ 3（过泛锚点把 GT 摊大、命中率被抬成
 *     噪声；本批因此淘汰 `FileContentLedger`(7) / `CommandGlob`(6) / `A2aCapabilityDeclaration`(4) /
 *     `DenyApproval`(4)` 等候选）。
 *  5. **查询不含 GT 文件路径词**（目录名与文件名分出的词一并算）：避免「靠文件名白送分」——
 *     这一条 ext51 没管，本批机械校验据此拦下并修好 5 条。
 *
 * ## 生成与复核分离（防「自证」）
 *
 * 三名**互不相通**的作者会话按域切片各写 36 条（context/检索/记忆；server/工具/安全；监督/进化/
 * 工具链），再由**独立会话**逐条机械复验（锚点存在性、GT 计数、锚点子词交集、路径词交集、条目重复），
 * 拦下的 16 条由**第三个独立会话**修复（14 条改写措辞 + 2 条换锚点），最后经
 * `evals/recall-query-audit.mjs` 与 `tests/unit/recallQueries.test.ts` 复验。
 *
 * **诚实边界**：作者是模型（与 ext51 同），复核是**机械判据**（存在性 / 交集 / 计数）而非逐条人工
 * 语义审读——「查询是否真描述锚点所在文件的能力」只由作者自查 + 抽样人工抽查覆盖。故本档数字用于
 * **同集内成对对照**（同一查询集上的 A/B），不作跨仓库绝对命中率承诺。
 */
export const GROWTH_RECALL_QUERIES = [
  // —— src/a2a（1 条）——
  {
    q: 'which numeric codes are handed back for a rejected or unknown call',
    anchor: 'A2A_ERROR_UNAUTHORIZED',
  },
  // —— src/adapters（11 条）——
  {
    q: 'how is raw input broken into runnable segments or a refusal',
    anchor: 'ShellParseOutcome',
  },
  {
    q: 'what must the composition root supply to check code after a save',
    anchor: 'PostWriteDiagnosticsWiring',
  },
  {
    q: 'what pieces come back after a remote page is retrieved',
    anchor: 'FetchedDocument',
  },
  {
    q: 'what gets injected to build the check that runs as a reply finishes',
    anchor: 'TurnEndCompletionGateDeps',
  },
  {
    q: 'how many times may the check command fire in one conversation',
    anchor: 'SelfVerifyPolicyOptions',
  },
  {
    q: 'which slice of rows can be requested when opening a document',
    anchor: 'LineWindowResult',
  },
  {
    q: 'how closely must text agree before a swap is accepted',
    anchor: 'MatchKind',
  },
  {
    q: 'how is a risky request rendered for a model to judge',
    anchor: 'GuardianPrompt',
  },
  {
    q: 'where are repeated identical permission verdicts kept in memory',
    anchor: 'class CachedApproval',
  },
  {
    q: 'what does a terminal session report once its process exits',
    anchor: 'InteractiveRunOutcome',
  },
  {
    q: 'how is drift spotted before a stored copy is overwritten',
    anchor: 'class FileContentLedger',
  },
  // —— src/adapters/approval（1 条）——
  {
    q: 'how are the escape characters kept out of pattern expansion',
    anchor: 'REGEX_META',
  },
  // —— src/adapters/embedding（1 条）——
  {
    q: 'which surface of a third party model package does the wrapper consume',
    anchor: 'interface TransformersModuleLike',
  },
  // —— src/adapters/memory（7 条）——
  {
    q: 'which stateless helpers sit beside the resonance simulation code',
    anchor: 'class ResonantFieldMath',
  },
  {
    q: 'a durable store kept as one growing append only journal',
    anchor: 'class FileLongTermMemory',
  },
  {
    q: 'which ceiling governs how many latest jottings survive',
    anchor: 'interface FileScratchpadOptions',
  },
  {
    q: 'how many degrees of temperature a diffusion step applies per connection',
    anchor: 'class HeatEquationAnnealer',
  },
  {
    q: 'at most how many engraved results are kept before the oldest is dropped',
    anchor: 'class InsightEtchingEngine',
  },
  {
    q: 'how is a note laid out in a grid with row and column parity',
    anchor: 'class QECEncoder',
  },
  {
    q: 'a candidate paired with its relevance number before ageing is applied',
    anchor: 'interface ScoredFact',
  },
  // —— src/adapters/tool（9 条）——
  {
    q: 'how many warning lines are drawn for one file at most',
    anchor: 'MAX_RENDERED_DIAGNOSTICS',
  },
  {
    q: 'what an attached terminal reports about this host',
    anchor: 'PtyReport',
  },
  {
    q: 'how is an unresponsive build command given a ceiling',
    anchor: 'SHELL_INTERACTIVE_MAX_TIMEOUT_MS',
  },
  {
    q: 'tunables for the capability that downloads a page',
    anchor: 'WebFetchToolOptions',
  },
  {
    q: 'callback shape used to notice an unfinished stub after a write',
    anchor: 'FakeCompletionProbe',
  },
  {
    q: 'how is a live capture hook supplied when taking a picture',
    anchor: 'ScreenshotSessionFactory',
  },
  {
    q: 'what outcome comes back when a change bundle is applied across documents',
    anchor: 'PatchApplierResult',
  },
  {
    q: 'what can be undone once a saved point exists',
    anchor: 'checkpointDefinition',
  },
  {
    q: 'how is a stored command managed while it is still running',
    anchor: 'ShellJobTool',
  },
  // —— src/cli（6 条）——
  {
    q: 'which confinement backends were detected as usable on this host',
    anchor: 'SandboxStatus',
  },
  {
    q: 'what collaborators are injected into the kit bridge',
    anchor: 'SdkCommandDeps',
  },
  {
    q: 'one row describing an available switch in the manual',
    anchor: 'HelpEntry',
  },
  {
    q: 'a canned bundle of settings for a known vendor',
    anchor: 'AdapterPreset',
  },
  {
    q: 'what inputs are needed to materialize secrets for the runtime',
    anchor: 'CredentialHydrationArgs',
  },
  {
    q: 'a reference to one of the interchangeable record backends',
    anchor: 'KvHandle',
  },
  // —— src/context（10 条）——
  {
    q: 'what marks how much of a chat was already folded away',
    anchor: 'interface CompactionState',
  },
  {
    q: 'what bounds how many hops a neighborhood scan may take',
    anchor: 'interface WalkLimits',
  },
  {
    q: 'which artifact carries the sparse adjacency plus normalized importance',
    anchor: 'interface GraphSignal',
  },
  {
    q: 'how many characters of a symbol body may a slice retain',
    anchor: 'const CHUNK_BODY_MAX_LINES',
  },
  {
    q: 'how often the memoized measurements were reused',
    anchor: 'interface TokenCountCacheStats',
  },
  {
    q: 'what a remembered lookup reports back plus a nullable payload',
    anchor: 'interface RepoMapMemoHit',
  },
  {
    q: 'when is a big output swapped for a bounded preview and a locator',
    anchor: 'class ToolResultSpiller',
  },
  {
    q: 'identifiers whose output must never be offloaded',
    anchor: 'interface SpillerOptions',
  },
  {
    q: 'which category keys and window size are handed to the size auditor',
    anchor: 'interface ContextBreakdownInput',
  },
  {
    q: 'which knob list and share of identical leading bytes are reported',
    anchor: 'interface PrefixStabilityReport',
  },
  // —— src/context/rankVeto（3 条）——
  {
    q: 'what the first pass produced alongside the tuning knobs',
    anchor: 'interface RankVetoInput',
  },
  {
    q: 'how many citations point at a node and how uneven they are',
    anchor: 'interface StructuralDiagnostics',
  },
  {
    q: 'which numeric cut offs decide if a ranking route is discarded',
    anchor: 'interface VetoThresholds',
  },
  // —— 缓存与命中率（5 条；2026-10-02 替换 src/eval 已删符号，条数不变）——
  // 锚点须为查询集**尚未收录**的目标，否则同一 GT 被重复计入，会扭曲全量命中率统计。
  {
    q: 'what trims a long transcript back under the window',
    anchor: 'class ContextCompactor',
  },
  {
    q: 'where is the size of a piece of text remembered',
    anchor: 'class TokenCountCache',
  },
  {
    q: 'which marks tell one provider what may be reused',
    anchor: 'class AnthropicCacheBreakpoints',
  },
  {
    // 2026-10-02 REPLACE_QUERY：原措辞 `what reads back how many tokens were served from cache`
    // 与锚点子词 `cache` 字面重合（第三条采集协议要求零交集），属**协议违规**且一直让
    // `tests/unit/recallQueries.test.ts ③` 真红。改为不落任何锚点子词的等价问法；
    // GT 定位子未动（仍是 `class PromptCacheUsageReader`），故该条的纵向可比性受影响之处仅在查询措辞。
    q: 'what reads back how many tokens were served from a reused prefix',
    anchor: 'class PromptCacheUsageReader',
  },
  {
    q: 'what reorders the shortlist after the first pass',
    anchor: 'class FileReranker',
  },
  // —— src/core/selfChecklist（原 src/eval，2026-10-02 随 SelfChecklist 迁出）——
  {
    q: 'the overall outcome of grading against a list of criteria',
    anchor: 'ChecklistVerdict',
  },
  // —— src/evolution（4 条）——
  {
    q: 'the outcome telling whether a worse candidate was taken',
    anchor: 'AcceptanceDecision',
  },
  {
    q: 'what change was taken on board after a flaw was found',
    anchor: 'AdoptedImprovement',
  },
  {
    q: 'why was a candidate turned away before being merged',
    anchor: 'AdmissionRejection',
  },
  {
    q: 'what comes back after one pass of reinforced sampling',
    anchor: 'RlvrRoundResult',
  },
  // —— src/genesis（3 条）——
  {
    q: 'what each step hands back to the driver',
    anchor: 'HarnessOperatorResult',
  },
  {
    q: 'the lookup translating each stage label into a key',
    anchor: 'REPORT_FIELD',
  },
  {
    q: 'the running picture of budget and consumed work',
    anchor: 'GenesisState',
  },
  // —— src/native（2 条）——
  {
    q: 'the shape of the compiled addon this process loads',
    anchor: 'NativeModule',
  },
  {
    q: 'how is a label from our side rewritten for the inner dialect',
    anchor: 'toNativeToolName',
  },
  // —— src/observability（3 条）——
  {
    q: 'which settings point at the collector and name the service',
    anchor: 'OtlpExporterOptions',
  },
  {
    q: 'dials controlling how spans are gathered from the bus',
    anchor: 'TraceCollectingOptions',
  },
  {
    q: 'what flags a moment when too little of the prompt prefix was reused',
    anchor: 'CacheHitRateBreach',
  },
  // —— src/plugin（1 条）——
  {
    q: 'how is an extension pulled in by dynamically loading its entry module',
    anchor: 'importPlugin',
  },
  // —— src/ports/intelligence（10 条）——
  {
    q: 'what an immutable base unit lists besides its group and tags',
    anchor: 'interface ElementDef',
  },
  {
    q: 'how can two symbols be joined when their valences cancel out',
    anchor: 'interface ElementComposerPort',
  },
  {
    q: 'how many normal samples trained the detector and what it last flagged',
    anchor: 'interface ImmuneSelfReport',
  },
  {
    q: 'how far a data point sits from the learned normal band',
    anchor: 'interface AnomalyAlert',
  },
  {
    q: 'the four speaker kinds a stored utterance may belong to',
    anchor: 'type RetrievalRole',
  },
  {
    q: 'where a promoted skill is written down and what it came from',
    anchor: 'interface FrozenCapability',
  },
  {
    q: 'a named slice of divergence computed for one axis instead of the total',
    anchor: 'interface BeliefKlComponent',
  },
  {
    q: 'a call that may only look, naming a chat and a cap on rows',
    anchor: 'interface TraceReadRequest',
  },
  {
    q: 'how is a passage sealed into a compact packet and opened again',
    anchor: 'interface VortexRingPort',
  },
  {
    q: 'one observation of how much a skill was leaned on',
    anchor: 'interface UsageSample',
  },
  // —— src/ports/memory（1 条）——
  {
    q: 'which pluggable backend keeps a log of sessions for later reading',
    anchor: 'interface StoragePort',
  },
  // —— src/ports/model（1 条）——
  {
    q: 'how do we learn whether the warm up succeeded and how long it took',
    anchor: 'interface EmbeddingPreloadOutcome',
  },
  // —— src/search（3 条）——
  {
    q: 'what a scored slot in the inverted list hands back',
    anchor: 'interface Bm25Hit',
  },
  {
    q: 'how many picks can the lookup table score the same way',
    anchor: 'interface Bm25Options',
  },
  {
    q: 'where a plain text request is matched against known schemas',
    anchor: 'class ToolIndex',
  },
  // —— src/server（14 条）——
  {
    q: 'how is a one way notice delivered without awaiting a reply',
    anchor: 'RpcNotification',
  },
  {
    q: 'what comes back when a long workflow starts and can be aborted later',
    anchor: 'GraphRunHandle',
  },
  {
    q: 'which preferences survive a restart and get written back',
    anchor: 'PERSISTABLE_KEYS',
  },
  {
    q: 'what extra fields travel with a generated regulatory filing',
    anchor: 'ComplianceReportMeta',
  },
  {
    q: 'tunables for keeping operator remarks about proposed changes',
    anchor: 'DiffCommentStoreOptions',
  },
  {
    q: 'which plan is chosen when no subscription was picked',
    anchor: 'QUOTA_DEFAULT_ID',
  },
  {
    q: 'what value stands in when nothing has been toggled yet',
    anchor: 'EMPTY_SESSION_MODES',
  },
  {
    q: 'possible results of moving an exchange backwards in time',
    anchor: 'SessionRewindOutcome',
  },
  {
    q: 'what comes back when a bounded workspace fetch succeeds or fails',
    anchor: 'SafeReadResult',
  },
  {
    q: 'what the dashboard reports for an external uptime checker',
    anchor: 'HealthStatus',
  },
  {
    q: 'how long each exchange took at the lowest and highest',
    anchor: 'TurnStats',
  },
  {
    q: 'what snapshot does the status call hand back about a workflow',
    anchor: 'GraphRunState',
  },
  {
    q: 'payload carrying a numeric fault code back to the caller',
    anchor: 'RpcError',
  },
  {
    q: 'how is the loopback listener configured together with an access credential',
    anchor: 'HttpServerOptions',
  },
  // —— src/skill（1 条）——
  {
    q: 'how is a sliding average applied to a grid of numbers',
    anchor: 'boxBlur',
  },
  // —— src/spark（2 条）——
  {
    q: 'the bundle of subsystem handles handed to each round',
    anchor: 'SparkEngineSet',
  },
  {
    q: 'where per round readings are pushed to the sink',
    anchor: 'SparkCycleTelemetry',
  },
  // —— src/subagent（2 条）——
  {
    q: 'a handle that relays an outside abort to an inner request',
    anchor: 'LinkedSignal',
  },
  {
    q: 'the role description that shapes how a helper behaves',
    anchor: 'AgentPersona',
  },
  // —— src/supervisor（1 条）——
  {
    q: 'what tracks the recent pass or fail record of each executable',
    anchor: 'ToolStat',
  },
  // —— src/util（6 条）——
  {
    q: 'the split of divergence into two additive parts',
    anchor: 'KlDecomposition',
  },
  {
    q: 'a reading of how many recent calls failed plus the open instant',
    anchor: 'CircuitSnapshot',
  },
  {
    q: 'what comes back from scanning every path in a tree',
    anchor: 'WorkspaceWalkResult',
  },
  {
    q: 'callbacks stored while an answer is still awaited',
    anchor: 'PendingHandlers',
  },
  {
    q: 'fallback vendor settings used when nothing was configured',
    anchor: 'ModelAdapterDefaults',
  },
  {
    q: 'raised when a relative route escapes its root',
    anchor: 'PathTraversalError',
  },
];

/** 全量查询集（193 条 = core33 + ext51 + growth109）。 */
export const RECALL_QUERIES: readonly RecallQuery[] = [
  ...CORE_RECALL_QUERIES,
  ...EXTENDED_RECALL_QUERIES,
  ...GROWTH_RECALL_QUERIES,
];

/**
 * 2026-09-27 之前的**冻结全量**（84 条）——历史数字（`all84`）的对照切片。
 * 新报告应**同时**给出 `frozen84` 与 `all193` 两档：前者与看板 §23 可比，后者是新判定口径。
 */
export const FROZEN_COUNT: number = CORE_RECALL_QUERIES.length + EXTENDED_RECALL_QUERIES.length;

/** 历史子集条数（33）——报告里用于「core33 / all84」双档对照。 */
export const CORE_COUNT: number = CORE_RECALL_QUERIES.length;

/** 仅作对照用的英文功能词（对抗性判定时不算「内容词」）。 */
const FUNCTION_WORDS = new Set([
  'how',
  'what',
  'where',
  'which',
  'who',
  'why',
  'when',
  'does',
  'did',
  'the',
  'and',
  'for',
  'are',
  'was',
  'were',
  'with',
  'from',
  'into',
  'that',
  'this',
  'than',
  'then',
  'there',
  'their',
  'them',
  'these',
  'those',
  'been',
  'being',
  'will',
  'would',
  'can',
  'could',
  'should',
  'may',
  'might',
  'must',
  'not',
  'but',
  'all',
  'any',
  'some',
  'each',
  'every',
  'most',
  'other',
  'such',
  'only',
  'own',
  'same',
  'too',
  'very',
  'just',
  'also',
  'more',
  'out',
  'get',
  'gets',
  'one',
  'its',
  'it',
]);

/**
 * 把标识符/文本切成小写词元（与检索侧 camelCase + 分隔符拆分口径一致）。
 * @param text 原始文本（标识符或自然语言）
 * @returns 小写词元数组（去重前的原始序列）
 */
export function subtokensOf(text: string): string[] {
  return text
    .replace(/\.(ts|tsx|mjs|js)$/i, '')
    .split(/[^A-Za-z0-9]+/)
    .flatMap((segment) => segment.split(/(?=[A-Z])/))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

/**
 * 查询的「内容词」集合：长度 ≥3 且非功能词。
 * @param query 查询文本
 * @returns 内容词集合
 */
export function contentTokensOf(query: string): Set<string> {
  return new Set(
    subtokensOf(query).filter((token) => token.length >= 3 && !FUNCTION_WORDS.has(token)),
  );
}

/**
 * 锚点的子词集合（长度 ≥3）——查询不得与之相交。
 * @param anchor 锚点字面量（可为 `class X` / `export function y` 形式）
 * @returns 锚点子词集合
 */
export function anchorTokensOf(anchor: string): Set<string> {
  return new Set(subtokensOf(anchor).filter((token) => token.length >= 3));
}

/**
 * 对抗性判定：查询内容词与锚点子词的交集（空集 = 合格）。
 * @param entry 查询条目
 * @returns 相交的词元数组（应为空）
 */
export function adversarialOverlap(entry: RecallQuery): string[] {
  const anchorTokens = anchorTokensOf(entry.anchor);
  return [...contentTokensOf(entry.q)].filter((token) => anchorTokens.has(token));
}

/** 一条检索评测查询：`q` 为自然语言查询，`anchor` 为定位 GT 的字面量。 */
export interface RecallQuery {
  readonly q: string;
  readonly anchor: string;
}
