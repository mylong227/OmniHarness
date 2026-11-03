/**
 * 审计出证（audit attestation）的**数据契约**——只放类型，无运行时实现。
 *
 * 设计口径（见 `docs/audit/ATTESTATION.md`）：
 * - 报告是**自包含**的：时间线 + 文件变更 + 成本 + 哈希链，全部在同一个文件里；
 * - 哈希链覆盖每条规范化记录的**规范 JSON**，因此复核方不需要本仓库即可重算；
 * - 一切"不知道"都写成 `null` / 缺省，**不猜、不补**（与全仓诚实降级口径一致）。
 */

/** 审计时间线上的记录类别。 */
export type AuditRecordKind =
  | 'session'
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'approval'
  | 'error'
  | 'system'
  | 'turn'
  | 'other';

/** 工具调用的结局（缺省 = 源里没有给出明确结局，不臆测）。 */
export type AuditStatus = 'ok' | 'error' | 'pending';

/** 时间线上的一条规范化记录。 */
export interface AuditRecord {
  /** 报告内 1 起始的单调序号（由报告构建器统一编号，不沿用源文件的 seq）。 */
  readonly seq: number;
  /** ISO-8601 时间戳；源文件没有时为 null。 */
  readonly ts: string | null;
  /** 记录类别。 */
  readonly kind: AuditRecordKind;
  /** 一行可读标题（用于 HTML/Markdown 时间线）。 */
  readonly title: string;
  /** 正文（模型消息、命令、工具输出等）；超长会按上限截断并标注。 */
  readonly text: string;
  /** 工具名（仅工具类记录）。 */
  readonly tool?: string;
  /** 源文件里的调用 id（用于把 call / result 对上）。 */
  readonly callId?: string;
  /** 结局（仅工具类记录）。 */
  readonly status?: AuditStatus;
  /** 该记录触及的文件（写类工具 / 回合 diff）。 */
  readonly files?: readonly string[];
  /**
   * 每个文件的增删行数（只有源里带 unified diff 时才有；与 {@link AuditRecord.files}
   * 同源但更细——文件表据此显示 `+n/−n`）。
   */
  readonly fileStats?: readonly AuditFileChange[];
  /** 额外结构化字段（仅标量，便于规范 JSON 与 HTML 展示）。 */
  readonly meta?: Readonly<Record<string, string | number | boolean | null>>;
}

/** 不含序号与链字段的草稿记录——解析器产出、构建器编号。 */
export type AuditRecordDraft = Omit<AuditRecord, 'seq'>;

/** 支持的会话来源格式。 */
export type AuditSourceFormat = 'omni' | 'claude-code' | 'codex' | 'acp';

/** 报告来源（一份报告对应一个输入会话文件）。 */
export interface AuditSourceInfo {
  /** 输入文件路径（报告里保留调用方给的路径，便于对账）。 */
  readonly path: string;
  /** 识别出的格式。 */
  readonly format: AuditSourceFormat;
  /** 会话 id；源文件没有时为 null。 */
  readonly sessionId: string | null;
  /** 工作区目录；源文件没有时为 null。 */
  readonly workspace: string | null;
  /** 模型名；源文件没有时为 null。 */
  readonly model: string | null;
  /** 第一条记录的时间戳。 */
  readonly startedAt: string | null;
  /** 最后一条记录的时间戳。 */
  readonly endedAt: string | null;
  /** 输入文件原始字节的 SHA-256（把报告与这一份输入绑定）。 */
  readonly sha256: string;
}

/** 成本口径（token 数；`cached` 是缓存读，**不**与 prompt 相加）。 */
export interface AuditTokenUsage {
  readonly prompt: number;
  readonly completion: number;
  readonly cached: number;
  readonly total: number;
}

/** 一个被触及的文件及其增删行数（只有源里带 diff 时才有增删）。 */
export interface AuditFileChange {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** 该文件被触及的次数（工具调用 + 回合 diff 各计一次）。 */
  readonly touches: number;
}

/** 报告摘要（机读 + 人读共用）。 */
export interface AuditSummary {
  readonly total: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly toolCalls: number;
  readonly toolFailures: number;
  readonly approvals: number;
  readonly filesChanged: number;
  readonly firstTs: string | null;
  readonly lastTs: string | null;
  readonly durationMs: number | null;
}

/**
 * 源文件的覆盖率口径（2026-11-03 P0「未识别记录可见化」）：回答复核方的第一个问题
 * ——「这份报告覆盖了源文件的全部内容吗？」。语义详见 `docs/audit/ATTESTATION.md` §3。
 */
export interface AuditCoverage {
  /** 载入时间线的记录数（= `records.length` = `summary.total`，`verify` 机械对账）。 */
  readonly recognized: number;
  /** 解析器明确不认识的来源条目数（坏行 / 非对象 / 类型缺失或未知 / 非法帧）。 */
  readonly unrecognized: number;
}

/** 带链字段的一条记录。 */
export interface AuditChainedRecord {
  /** 前一条的哈希（首条为创世哈希）。 */
  readonly prev: string;
  /** `SHA-256(prev + "\n" + canonical(record))` 的十六进制。 */
  readonly hash: string;
  /** 被保护的规范化记录。 */
  readonly record: AuditRecord;
}

/** 链摘要：复核方只要重算到 `head` 即可判定报告未被改动。 */
export interface AuditIntegrity {
  readonly algorithm: 'sha256';
  readonly genesis: string;
  readonly head: string;
  readonly count: number;
}

/** 一份完整的审计报告（也是 HTML/Markdown 里内嵌的载荷）。 */
export interface AuditReport {
  readonly schema: 'omniharness.audit.report/v1';
  readonly generatedAt: string;
  readonly generator: { readonly name: 'omniharness'; readonly version: string };
  readonly title: string;
  readonly source: AuditSourceInfo;
  readonly summary: AuditSummary;
  /**
   * 覆盖率口径。可选是为兼容本字段引入前的存量报告（复核器只在字段在场时对账）；
   * 新构建的报告一律携带。
   */
  readonly coverage?: AuditCoverage;
  readonly tokens: AuditTokenUsage | null;
  readonly files: readonly AuditFileChange[];
  readonly records: readonly AuditChainedRecord[];
  readonly integrity: AuditIntegrity;
  /**
   * 文件级自指纹（**仅 HTML / Markdown**）：报告载体（含展示层）整份文本的 SHA-256。
   * 计算时把本字段的值替换为占位标记再哈希——于是"改一个显示字符"也能被
   * `audit verify` 检出；JSON 形态没有展示层，故不带该字段（载荷本身就是数据）。
   */
  readonly artifact?: { readonly sha256: string };
}

/** 单个解析器的产出（尚未编号、尚未上链）。 */
export interface AuditParseResult {
  readonly format: AuditSourceFormat;
  readonly sessionId: string | null;
  readonly workspace: string | null;
  readonly model: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly records: readonly AuditRecordDraft[];
  readonly tokens: AuditTokenUsage | null;
  /** 解析器明确不认识的来源条目数（进报告的 `coverage.unrecognized`；口径见 ATTESTATION §3）。 */
  readonly unrecognized: number;
}

/** 加载并解析后的一个来源（原始字节哈希 + 解析结果）。 */
export interface AuditLoadedSource {
  /** 输入文件路径。 */
  readonly path: string;
  /** 原始字节的 SHA-256（与报告内 `source.sha256` 同口径）。 */
  readonly sha256: string;
  /** 解析结果。 */
  readonly result: AuditParseResult;
}

/** 构建一份报告所需的选项。 */
export interface AuditReportOptions {
  /** 报告标题；缺省由来源与会话 id 派生。 */
  readonly title?: string;
  /** 生成时间（注入以便判据可复现）。 */
  readonly generatedAt?: string;
  /** 生成器版本（由调用方给，避免本模块反向依赖 CLI 版本）。 */
  readonly generatorVersion: string;
}

/** 报告输出格式。 */
export type AuditOutputFormat = 'html' | 'md' | 'json';

/** 链校验结果（fail-closed：任何一处对不上都给出位置与原因）。 */
export interface AuditChainVerification {
  readonly ok: boolean;
  /** 第一处对不上的 0 起始下标；ok 时为 null。 */
  readonly brokenAt: number | null;
  /** 失败原因（`prev` / `hash` / `genesis` / `count`）；ok 时为 null。 */
  readonly reason: string | null;
}
