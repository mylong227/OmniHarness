/**
 * 检索评测查询集（**单一真相来源**）——34 → 84 条，2026-09-22 扩容。
 *
 * ## 为什么扩容（`docs/RECALL_HEADROOM_SURVEY.md` §5 建议 4，长期未做）
 *
 * 原集合 33 条使 bootstrap 95% CI 宽达 **±13–15pp**，于是「+3pp / +6pp」量级的改进**不可判定**——
 * 语义路（+6.1pp）与 PRF（+3pp）都是因此长期停在 opt-in。扩容后 CI 收窄，3–6pp 级效果才可判。
 *
 * ## 为什么不直接改原 33 条
 *
 * 原 33 条是**历史口径**：看板 §17、调研报告、多处「两关」判定都引用它们的数字。故本模块把
 * 原 33 条**逐字冻结**为 {@link CORE_RECALL_QUERIES}，新增的 51 条放在
 * {@link EXTENDED_RECALL_QUERIES}；消费方应当**同时**报告两档（`core33` 与 `all84`），
 * 既保历史可比，又拿到统计功效。
 *
 * ## 采集协议（新增条目的可复核约束）
 *
 * 1. **锚点必存在**：锚点字面量必须在 `src/` 中真实出现（GT 非空），由
 *    `evals/recall-query-audit.mjs` 机械校验，缺失即中止（防「锚点写错却被当成检索失败」）。
 * 2. **对抗性**：查询文本**刻意避开锚点的全部子词**（camelCase 拆分后的小写词元），
 *    目的是度量「非字面」检索能力，而不是让 BM25 白送分。该约束由
 *    `tests/unit/recallQueries.test.ts` 强制（交集非空即测试失败）。
 *    **范围说明**：该严格约束只作用于 {@link EXTENDED_RECALL_QUERIES}；冻结的
 *    {@link CORE_RECALL_QUERIES} 保留 2026-09-17 的历史措辞（当时的口径是「避开锚点的**定义字面**」，
 *    如 `registerTool` 的查询里允许出现 `tool`），改动它们会使历史数字失去可比性。
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
  { q: 'how does BM25 tokenize CJK text', anchor: 'export function tokenize' },
  { q: 'how is the resonant memory probe mapped from text', anchor: 'resonateByText' },
  { q: 'where is the sandbox policy evaluated', anchor: 'execPolicy' },
  { q: 'how are tool results spilled out of context', anchor: 'spill_read' },
  {
    q: 'which component remembers decisions the operator already blessed',
    anchor: 'ApprovalStore',
  },
  { q: 'how is a signed claim from an agent packaged', anchor: 'AgentAssertionEnvelope' },
  { q: 'which key-value store replicates records across nodes', anchor: 'OobleckStore' },
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

/** 全量查询集（84 条）。 */
export const RECALL_QUERIES: readonly RecallQuery[] = [
  ...CORE_RECALL_QUERIES,
  ...EXTENDED_RECALL_QUERIES,
];

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
