import crypto from 'node:crypto';
import type { AuditChainReport, AuditEvent } from './auditSink.js';

/**
 * @beta
 * 审计导出查询条件（全字段可选；未给则不过滤）。
 */
export interface AuditQuery {
  /** 时间下界（含），ISO 字符串；按字典序比较（ISO 时间可字典序排序）。 */
  readonly since?: string;
  /** 时间上界（含），ISO 字符串。 */
  readonly until?: string;
  /** 事件类型精确匹配。 */
  readonly type?: string;
  /** 会话 ID 精确匹配。 */
  readonly session?: string;
  /** 操作者精确匹配。 */
  readonly actor?: string;
  /** 最多返回条数（截尾取最近 N 条）。 */
  readonly limit?: number;
}

/**
 * @beta
 * 导出格式。
 */
export type AuditFormat = 'json' | 'table' | 'csv';

/**
 * 审计导出器。
 *
 * 无状态、无 IO：同一实例可并发复用（默认实例见文件末尾组合根门面）。
 * `OOP 收口`（2026-09-11）：原静态方法族改为实例方法，消除 `static`。
 */
export class AuditExporter {
  /**
   * @beta
   * 按查询条件过滤审计事件。
   * 时间比较采用 ISO 字符串字典序（ISO-8601 具备该性质）；坏值按宽松处理。
   * @param events 全量审计事件。
   * @param query 过滤条件（全字段可选）。
   * @returns 过滤后的事件数组（limit 取最近 N 条）。
   */
  public queryAudit(events: readonly AuditEvent[], query: AuditQuery): AuditEvent[] {
    let out = events.filter((e) => {
      if (query.type !== undefined && e.type !== query.type) return false;
      if (query.session !== undefined && e.sessionId !== query.session) return false;
      if (query.actor !== undefined && e.actor !== query.actor) return false;
      if (query.since !== undefined && (e.ts ?? '') < query.since) return false;
      if (query.until !== undefined && (e.ts ?? '') > query.until) return false;
      return true;
    });
    if (query.limit !== undefined && query.limit >= 0) {
      out = out.slice(-query.limit);
    }
    return out;
  }

  /**
   * @beta
   * 把审计事件格式化为指定格式的文本。
   * @param events 待格式化的事件。
   * @param format 输出格式（json / csv / table）。
   * @returns 格式化文本（table 为 TSV，末尾带换行）。
   */
  public formatAudit(events: readonly AuditEvent[], format: AuditFormat): string {
    if (format === 'json') {
      return JSON.stringify(events, null, 2);
    }
    if (format === 'csv') {
      const header = 'ts,type,sessionId,actor';
      const rows = events.map((e) =>
        [e.ts ?? '', e.type, e.sessionId ?? '', e.actor ?? '']
          .map((cell) => this.csvCell(cell))
          .join(','),
      );
      return [header, ...rows].join('\n') + '\n';
    }
    // table（默认）：TSV，便于终端阅读
    const lines = ['ts\ttype\tsessionId\tactor'];
    for (const e of events) {
      lines.push([e.ts ?? '', e.type, e.sessionId ?? '', e.actor ?? ''].join('\t'));
    }
    return lines.join('\n') + '\n';
  }

  /**
   * CSV 单元格转义（RFC 4180 最简实现：含特殊字符用双引号包裹并转义内部引号）。
   * @param value 原始单元格文本。
   * @returns 转义后的 CSV 单元格。
   */
  private csvCell(value: string): string {
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }

  /**
   * @beta
   * 一步到位：过滤 + 格式化（供 CLI / RPC 直接调用）。
   * @param events 全量审计事件。
   * @param query 过滤条件。
   * @param format 输出格式。
   * @returns 过滤并格式化后的文本。
   */
  public exportAudit(
    events: readonly AuditEvent[],
    query: AuditQuery,
    format: AuditFormat,
  ): string {
    return this.formatAudit(this.queryAudit(events, query), format);
  }

  /**
   * @beta
   * 由审计事件构造合规报告（先按 query 过滤，再汇总摘要 + 完整性哈希）。
   * 完整性哈希覆盖筛选后的全部事件 JSON，任一事件被改动都会改变哈希，fail-closed 可审计。
   * @param events 全量审计事件。
   * @param query 过滤条件（写入报告供复现）。
   * @param meta 报告元数据（组织 / 生成方 / 备注，缺省为空）。
   * @param chain 可选的哈希链校验结果（由调用方传入 AuditSink.verify() 的返回值）。
   * @returns 合规报告（含摘要、按类型计数、时间范围与完整性哈希）。
   */
  public buildComplianceReport(
    events: readonly AuditEvent[],
    query: AuditQuery,
    meta: ComplianceReportMeta = {},
    chain?: AuditChainReport,
  ): ComplianceReport {
    const filtered = this.queryAudit(events, query);
    const byType: Record<string, number> = {};
    for (const e of filtered) byType[e.type] = (byType[e.type] ?? 0) + 1;
    const actors = Array.from(new Set(filtered.map((e) => e.actor ?? '')))
      .filter((a) => a.length > 0)
      .sort();
    const times = filtered
      .map((e) => e.ts ?? '')
      .filter((t) => t.length > 0)
      .sort();
    const firstEvent = times.length > 0 ? times[0]! : null;
    const lastEvent = times.length > 0 ? times[times.length - 1]! : null;
    const integrityHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(filtered))
      .digest('hex');
    return {
      schema: 'omniharness.audit.compliance/v1',
      generatedAt: new Date().toISOString(),
      meta,
      query,
      summary: {
        total: filtered.length,
        byType,
        actors,
        firstEvent,
        lastEvent,
        integrityHash,
        ...(chain !== undefined ? { chain } : {}),
      },
      events: filtered,
    };
  }

  /**
   * @beta
   * 合规报告序列化为 JSON 文本。
   * @param report 合规报告。
   * @returns 缩进 2 的 JSON 文本。
   */
  public formatCompliance(report: ComplianceReport): string {
    return JSON.stringify(report, null, 2);
  }
}

// ---- 门面兼容：保留原导出名，委托默认实例 ----
const auditExporter = new AuditExporter();

/**
 * @beta
 * 按查询条件过滤审计事件。
 * 时间比较采用 ISO 字符串字典序（ISO-8601 具备该性质）；坏值按宽松处理。
 * @param events 全量审计事件。
 * @param query 过滤条件（全字段可选）。
 * @returns 过滤后的事件数组（limit 取最近 N 条）。
 */
export function queryAudit(events: readonly AuditEvent[], query: AuditQuery): AuditEvent[] {
  return auditExporter.queryAudit(events, query);
}

/**
 * @beta
 * 把审计事件格式化为指定格式的文本。
 * @param events 待格式化的事件。
 * @param format 输出格式（json / csv / table）。
 * @returns 格式化文本（末尾带换行）。
 */
export function formatAudit(events: readonly AuditEvent[], format: AuditFormat): string {
  return auditExporter.formatAudit(events, format);
}

/**
 * @beta
 * 一步到位：过滤 + 格式化（供 CLI / RPC 直接调用）。
 * @param events 全量审计事件。
 * @param query 过滤条件。
 * @param format 输出格式。
 * @returns 过滤并格式化后的文本。
 */
export function exportAudit(
  events: readonly AuditEvent[],
  query: AuditQuery,
  format: AuditFormat,
): string {
  return auditExporter.exportAudit(events, query, format);
}

/**
 * @beta
 * 由审计事件构造合规报告（先按 query 过滤，再汇总摘要 + 完整性哈希）。
 * 完整性哈希覆盖筛选后的全部事件 JSON，任一事件被改动都会改变哈希，fail-closed 可审计。
 * @param events 全量审计事件。
 * @param query 过滤条件（写入报告供复现）。
 * @param meta 报告元数据（缺省为空）。
 * @param chain 可选的哈希链校验结果（由调用方传入）。
 * @returns 合规报告（含摘要与完整性哈希）。
 */
export function buildComplianceReport(
  events: readonly AuditEvent[],
  query: AuditQuery,
  meta: ComplianceReportMeta = {},
  chain?: AuditChainReport,
): ComplianceReport {
  return auditExporter.buildComplianceReport(events, query, meta, chain);
}

/**
 * @beta
 * 合规报告序列化为 JSON 文本。
 * @param report 合规报告。
 * @returns 缩进 2 的 JSON 文本。
 */
export function formatCompliance(report: ComplianceReport): string {
  return auditExporter.formatCompliance(report);
}

/** @beta 合规报告元数据（可由调用方填入组织/生成方/备注）。 */
export interface ComplianceReportMeta {
  readonly organization?: string;
  readonly generatedBy?: string;
  readonly note?: string;
}

/**
 * @beta
 * 合规报告结构：含事件摘要、按类型计数、时间范围与 SHA256 完整性哈希。
 */
export interface ComplianceReport {
  readonly schema: 'omniharness.audit.compliance/v1';
  readonly generatedAt: string;
  readonly meta: ComplianceReportMeta;
  readonly query: AuditQuery;
  readonly summary: {
    readonly total: number;
    readonly byType: Record<string, number>;
    readonly actors: string[];
    readonly firstEvent: string | null;
    readonly lastEvent: string | null;
    /** 对筛选后事件做 SHA256，供下游校验这批导出数据未被改动。 */
    readonly integrityHash: string;
    /**
     * 哈希链校验结果（`AuditSink.verify()` 的返回值，由调用方传入）。
     *
     * 注意区分两种完整性：`integrityHash` 只是**这批导出数据的快照摘要**，
     * 检测不到「源日志中间条目被删改」；`chain` 才是逐条链式校验，能检出删/插/改。
     * 合规消费方应以 `chain.ok === true` 为准，仅凭 integrityHash 不足以证明日志可信。
     */
    readonly chain?: AuditChainReport;
  };
  readonly events: AuditEvent[];
}
