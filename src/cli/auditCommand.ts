/**
 * audit 子命令（AuditCommand）——导出落盘审计日志，或生成带哈希链校验的合规报告。
 *
 * 从原 CliDataCmds 抽出，行为逐字节等价。fail-closed 语义保持不变：哈希链确凿断裂（ok===false）
 * 时告警并以非零码退出；旧格式日志（ok===null，无链字段）仅不可验证、非篡改，正常出具。
 */

import { writeFileSync } from 'node:fs';
import { AuditSink, type AuditEvent } from '../server/services/auditSink.js';
import {
  formatAudit,
  queryAudit,
  buildComplianceReport,
  formatCompliance,
  type AuditFormat,
  type AuditQuery,
} from '../server/services/auditExporter.js';
import { CliArgReader } from './cliArgReader.js';

/** 用法提示。 */
const USAGE =
  '用法: omniharness audit export [--audit-dir DIR | --audit-file PATH] ' +
  '[--since ISO] [--until ISO] [--type T] [--session S] [--actor A] ' +
  '[--format json|table|csv] [--out FILE] [--limit N] [--compliance]\n';

export class AuditCommand {
  /**
   * 执行 audit 子命令。
   * @param args 子命令参数（已去掉 `audit`，首元素为子命令名）。
   * @returns 进程退出码（0 成功 / 1 链断裂 / 2 用法错误）。
   */
  public async run(args: readonly string[]): Promise<number> {
    if (args[0] !== 'export') {
      process.stdout.write(USAGE);
      return 2;
    }
    const rest = args.slice(1);
    const reader = new CliArgReader(rest);
    const sink = this.buildSink(reader);
    const query = this.buildQuery(reader);
    const events = sink.read();
    if (rest.includes('--compliance')) {
      return this.runCompliance(sink, events, query, reader);
    }
    return this.runExport(events, query, reader);
  }

  /**
   * 构造审计 sink：--audit-file 优先，其次 --audit-dir 或 env OMNI_AUDIT_DIR，均无则 no-op。
   * @param reader 参数读取器（在去掉 `audit export` 后的参数上）。
   * @returns 审计 sink。
   */
  private buildSink(reader: CliArgReader): AuditSink {
    const auditDir = reader.value('--audit-dir') ?? process.env['OMNI_AUDIT_DIR'];
    const auditFile = reader.value('--audit-file');
    return new AuditSink(
      auditFile !== undefined
        ? { path: auditFile }
        : auditDir !== undefined
          ? { dir: auditDir }
          : {},
    );
  }

  /**
   * 构造审计查询条件（未提供的条件保留为 undefined 键，与原实现一致）。
   * @param reader 参数读取器。
   * @returns 审计查询条件。
   */
  private buildQuery(reader: CliArgReader): AuditQuery {
    return {
      since: reader.value('--since') ?? undefined,
      until: reader.value('--until') ?? undefined,
      type: reader.value('--type') ?? undefined,
      session: reader.value('--session') ?? undefined,
      actor: reader.value('--actor') ?? undefined,
      limit: this.parseLimit(reader.value('--limit')),
    };
  }

  /**
   * 解析 --limit：非数字/非有限值回落 undefined（不产出 NaN 污染查询）。
   * @param raw 原始字符串或 undefined。
   * @returns 正整数限额或 undefined。
   */
  private parseLimit(raw: string | undefined): number | undefined {
    if (raw === undefined) {
      return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  /**
   * 合规导出分支：生成结构化报告（摘要 + 完整性哈希 + 哈希链校验）。
   * @param sink 审计 sink（用于校验链）。
   * @param events 已读事件。
   * @param query 查询条件。
   * @param reader 参数读取器。
   * @returns 退出码（链断裂 1，否则 0）。
   */
  private runCompliance(
    sink: AuditSink,
    events: readonly AuditEvent[],
    query: AuditQuery,
    reader: CliArgReader,
  ): number {
    const chain = sink.verify();
    const report = buildComplianceReport(events, query, { generatedBy: 'omniharness' }, chain);
    if (chain.ok === false) {
      process.stderr.write(
        `[omniharness] 审计哈希链校验失败：${chain.reason ?? '未知原因'}（断裂处 seq=${String(chain.brokenAt)}）\n` +
          `              该报告不可作为合规证据，请核查审计日志完整性。\n`,
      );
    }
    const chainLabel = chain.ok === true ? '完整' : chain.ok === false ? '断裂' : '未启用';
    const text = formatCompliance(report);
    const outFile = reader.value('--out');
    if (outFile !== undefined) {
      writeFileSync(outFile, text);
      process.stdout.write(
        `已导出合规报告（${report.summary.total} 条事件，完整性哈希 ${report.summary.integrityHash.slice(0, 16)}…，哈希链 ${chainLabel}）到 ${outFile}\n`,
      );
    } else {
      process.stdout.write(text + '\n');
    }
    return chain.ok === false ? 1 : 0;
  }

  /**
   * 普通导出行：按条件过滤并以指定格式导出（默认 table）。
   * @param events 已读事件。
   * @param query 查询条件。
   * @param reader 参数读取器。
   * @returns 退出码（恒 0）。
   */
  private runExport(
    events: readonly AuditEvent[],
    query: AuditQuery,
    reader: CliArgReader,
  ): number {
    const formatRaw = reader.value('--format');
    const format: AuditFormat = formatRaw === 'json' || formatRaw === 'csv' ? formatRaw : 'table';
    const filtered = queryAudit(events, query);
    const matched = formatAudit(filtered, format);
    const outFile = reader.value('--out');
    if (outFile !== undefined) {
      writeFileSync(outFile, matched);
      process.stdout.write(`已导出 ${filtered.length} 条审计事件到 ${outFile}\n`);
    } else {
      process.stdout.write(matched);
    }
    return 0;
  }
}
