import { basename } from 'node:path';
import { AuditChain } from './auditChain.ts';
import type {
  AuditChainedRecord,
  AuditFileChange,
  AuditLoadedSource,
  AuditRecord,
  AuditRecordDraft,
  AuditReport,
  AuditReportOptions,
  AuditSummary,
} from './auditTypes.ts';

/**
 * 把"解析结果"组装成**自包含报告**：编号 → 上链 → 摘要 → 文件表 → 覆盖率。
 *
 * 编号由本类统一负责（1 起始、按时间线顺序），解析器不得自带序号——否则四种来源
 * 会各自定义序号口径，复核方对不上。摘要里的每个数字都能从 `records` 重算出来：
 * 报告被改一个数字，链校验就会在同一处失败。`coverage.recognized` 同理取
 * `chained.length`（复核器据此机械对账）；`coverage.unrecognized` 来自解析器的
 * 明确计数（口径见 `docs/audit/ATTESTATION.md` §3）。
 */
export class AuditReportBuilder {
  /** 哈希链实现。 */
  private readonly chain: AuditChain;

  /**
   * @param chain 哈希链（缺省新建；判据可注入替身）。
   */
  public constructor(chain: AuditChain = new AuditChain()) {
    this.chain = chain;
  }

  /**
   * 构建报告。
   * @param source 已加载并解析的来源。
   * @param options 标题 / 生成时间 / 生成器版本。
   * @returns 完整报告。
   */
  public build(source: AuditLoadedSource, options: AuditReportOptions): AuditReport {
    const records = this.stamp(source.result.records);
    const chained = this.chain.link(records);
    return {
      schema: 'omniharness.audit.report/v1',
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      generator: { name: 'omniharness', version: options.generatorVersion },
      title: options.title ?? this.defaultTitle(source),
      source: {
        path: source.path,
        format: source.result.format,
        sessionId: source.result.sessionId,
        workspace: source.result.workspace,
        model: source.result.model,
        startedAt: source.result.startedAt,
        endedAt: source.result.endedAt,
        sha256: source.sha256,
      },
      summary: this.summarize(records, source.result.startedAt, source.result.endedAt),
      coverage: {
        recognized: chained.length,
        unrecognized: source.result.unrecognized,
      },
      tokens: source.result.tokens,
      files: this.collectFiles(records),
      records: chained,
      integrity: {
        algorithm: 'sha256',
        genesis: AuditChain.GENESIS,
        head: this.chain.headOf(chained),
        count: chained.length,
      },
    };
  }

  /**
   * 给草稿记录编号，并用结果回填工具调用的结局（callId 对上才算，缺结果保持 pending）。
   * @param drafts 解析器产出的记录。
   * @returns 带 seq 的记录。
   */
  private stamp(drafts: readonly AuditRecordDraft[]): AuditRecord[] {
    const statuses = new Map<string, 'ok' | 'error' | 'pending'>();
    for (const draft of drafts) {
      if (
        draft.kind === 'tool_result' &&
        draft.callId !== undefined &&
        draft.status !== undefined
      ) {
        statuses.set(draft.callId, draft.status);
      }
    }
    return drafts.map((draft, index) => {
      const resolved =
        draft.kind === 'tool_call' && draft.callId !== undefined
          ? statuses.get(draft.callId)
          : undefined;
      return {
        ...draft,
        seq: index + 1,
        ...(resolved === undefined ? {} : { status: resolved }),
      };
    });
  }

  /**
   * 计算摘要。
   * @param records 记录。
   * @param startedAt 首条时间戳。
   * @param endedAt 末条时间戳。
   * @returns 摘要。
   */
  private summarize(
    records: readonly AuditRecord[],
    startedAt: string | null,
    endedAt: string | null,
  ): AuditSummary {
    const byKind: Record<string, number> = {};
    let toolCalls = 0;
    let toolFailures = 0;
    let approvals = 0;
    const files = new Set<string>();
    for (const record of records) {
      byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
      if (record.kind === 'tool_call') {
        toolCalls += 1;
      }
      if (record.kind === 'tool_result' && record.status === 'error') {
        toolFailures += 1;
      }
      if (record.kind === 'approval') {
        approvals += 1;
      }
      for (const file of record.files ?? []) {
        files.add(file);
      }
    }
    return {
      total: records.length,
      byKind,
      toolCalls,
      toolFailures,
      approvals,
      filesChanged: files.size,
      firstTs: startedAt,
      lastTs: endedAt,
      durationMs: this.durationOf(startedAt, endedAt),
    };
  }

  /**
   * 汇总文件表（触及次数 + 可得的增删行数）。
   * @param records 记录。
   * @returns 按路径排序的文件表。
   */
  private collectFiles(records: readonly AuditRecord[]): AuditFileChange[] {
    const table = new Map<string, { added: number; removed: number; touches: number }>();
    const ensure = (path: string): { added: number; removed: number; touches: number } => {
      const entry = table.get(path) ?? { added: 0, removed: 0, touches: 0 };
      table.set(path, entry);
      return entry;
    };
    for (const record of records) {
      for (const file of record.files ?? []) {
        ensure(file).touches += 1;
      }
      for (const stat of record.fileStats ?? []) {
        const entry = ensure(stat.path);
        entry.added += stat.added;
        entry.removed += stat.removed;
      }
    }
    return [...table.entries()]
      .map(([path, value]) => ({
        path,
        added: value.added,
        removed: value.removed,
        touches: value.touches,
      }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  /**
   * 计算耗时（两端都有效且顺序正常才给值）。
   * @param startedAt 首条时间戳。
   * @param endedAt 末条时间戳。
   * @returns 毫秒；不可得为 null。
   */
  private durationOf(startedAt: string | null, endedAt: string | null): number | null {
    if (startedAt === null || endedAt === null) {
      return null;
    }
    const start = Date.parse(startedAt);
    const end = Date.parse(endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return null;
    }
    return end - start;
  }

  /**
   * 默认标题。
   * @param source 来源。
   * @returns 标题文本。
   */
  private defaultTitle(source: AuditLoadedSource): string {
    const suffix = source.result.sessionId ?? basename(source.path);
    return `审计报告 · ${source.result.format} · ${suffix}`;
  }

  /**
   * 把链记录摊平成记录数组（报表渲染用）。
   * @param chained 带链记录。
   * @returns 记录数组。
   */
  public static recordsOf(chained: readonly AuditChainedRecord[]): AuditRecord[] {
    return chained.map((item) => item.record);
  }
}
