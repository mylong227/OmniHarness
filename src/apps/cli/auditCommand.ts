/**
 * audit 子命令（AuditCommand）——三条能力，共用一个入口：
 *
 * 1. `audit export`：导出落盘审计日志，或生成带哈希链校验的合规报告（原有行为，逐字节保持）；
 * 2. `audit report <file|dir>`：把**任意受支持的会话文件**（OmniHarness JSONL / Claude Code
 *    transcript / Codex rollout / ACP 转录）转成自包含审计报告（HTML / Markdown / JSON）；
 * 3. `audit verify <report>`：复核报告哈希链（HTML / Markdown / JSON 都认）。
 *
 * 失败语义：用法错误 2；输入/读盘/解析失败 1；`export --compliance` 的链断裂仍为 1（原有语义）；
 * `verify` 任一份不完整为 1。所有错误都打印可执行的原因，不静默降级。
 */

import { writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { AuditSink, type AuditEvent } from '../server/services/auditSink.ts';
import {
  AuditExporter,
  type AuditFormat,
  type AuditQuery,
} from '../server/services/auditExporter.ts';
import { AuditTool } from '../audit/auditTool.ts';
import type { AuditOutputFormat, AuditSourceFormat } from '../audit/auditTypes.ts';
import { CliArgReader } from './cliArgReader.ts';

/** 用法提示（`audit` 三种形态的完整说明）。 */
const USAGE =
  '用法:\n' +
  '  omniharness audit export [--audit-dir DIR | --audit-file PATH] [--since ISO] [--until ISO]\n' +
  '                          [--type T] [--session S] [--actor A] [--format json|table|csv]\n' +
  '                          [--out FILE] [--limit N] [--compliance]\n' +
  '  omniharness audit report <FILE|DIR...> [--format html|md|json] [--out PATH]\n' +
  '                          [--title TEXT] [--source-format omni|claude-code|codex|acp]\n' +
  '  omniharness audit verify <REPORT...> [--json]\n' +
  '  omniharness audit <FILE|DIR...>            # report 的简写\n';

/** `report` 的取值型旗标。 */
const REPORT_VALUE_FLAGS: readonly string[] = ['--format', '--out', '--title', '--source-format'];

/** `verify` 的开关型旗标。 */
const VERIFY_BOOL_FLAGS: readonly string[] = ['--json'];

/** `export` 的取值型旗标（沿用原有集合）。 */
const EXPORT_VALUE_FLAGS: readonly string[] = [
  '--audit-dir',
  '--audit-file',
  '--audit-hmac-key',
  '--since',
  '--until',
  '--type',
  '--session',
  '--actor',
  '--format',
  '--out',
  '--limit',
];

/** `export` 的开关型旗标。 */
const EXPORT_BOOL_FLAGS: readonly string[] = ['--compliance'];

/** 位置参数解析结果。 */
interface Positionals {
  /** 非旗标参数（保序）。 */
  readonly paths: readonly string[];
  /** 不认识的旗标。 */
  readonly unknown: readonly string[];
}

export class AuditCommand {
  /** 出证工具（报告 / 复核）。 */
  private readonly tool = new AuditTool();

  /**
   * 执行 audit 子命令。
   * @param args 子命令参数（已去掉 `audit`，首元素为子命令名或输入路径）。
   * @returns 进程退出码（0 成功 / 1 失败 / 2 用法错误）。
   */
  public async run(args: readonly string[]): Promise<number> {
    const first = args[0];
    if (first === undefined || first.startsWith('-')) {
      process.stdout.write(USAGE);
      return 2;
    }
    if (first === 'export') {
      return this.runExportMode(args.slice(1));
    }
    if (first === 'verify') {
      return this.runVerifyMode(args.slice(1));
    }
    if (first === 'report') {
      return this.runReportMode(args.slice(1));
    }
    // 简写：`audit <file>` 等价 `audit report <file>`。
    return this.runReportMode(args);
  }

  /**
   * `export` 分支（原有实现，逐行为等价）。
   * @param rest 去掉 `export` 后的参数。
   * @returns 退出码。
   */
  private runExportMode(rest: readonly string[]): number {
    const parsed = this.positionalsOf(rest, EXPORT_VALUE_FLAGS, EXPORT_BOOL_FLAGS);
    if (parsed.unknown.length > 0 || parsed.paths.length > 0) {
      process.stderr.write(
        `[omniharness] audit export 不认识这些参数：${parsed.unknown.join(' ')}\n`,
      );
      process.stdout.write(USAGE);
      return 2;
    }
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
   * `report` 分支。
   * @param rest 参数。
   * @returns 退出码。
   */
  private runReportMode(rest: readonly string[]): number {
    const parsed = this.positionalsOf(rest, REPORT_VALUE_FLAGS, []);
    if (parsed.unknown.length > 0) {
      process.stderr.write(
        `[omniharness] audit report 不认识的旗标：${parsed.unknown.join(' ')}\n`,
      );
      process.stdout.write(USAGE);
      return 2;
    }
    if (parsed.paths.length === 0) {
      process.stdout.write(USAGE);
      return 2;
    }
    const reader = new CliArgReader(rest);
    const out = reader.value('--out') ?? null;
    const format = this.resolveFormat(reader.value('--format'), out);
    if (format === null) {
      process.stderr.write('[omniharness] --format 只支持 html / md / json\n');
      return 2;
    }
    const sourceFormat = this.resolveSourceFormat(reader.value('--source-format'));
    if (sourceFormat === 'invalid') {
      process.stderr.write(
        '[omniharness] --source-format 只支持 omni / claude-code / codex / acp\n',
      );
      return 2;
    }
    try {
      return this.tool.report({
        inputs: parsed.paths,
        format,
        out,
        title: reader.value('--title') ?? null,
        ...(sourceFormat === null ? {} : { sourceFormat }),
      });
    } catch (error) {
      process.stderr.write(`[omniharness] 审计报告生成失败：${this.messageOf(error)}\n`);
      return 1;
    }
  }

  /**
   * `verify` 分支。
   * @param rest 参数。
   * @returns 退出码。
   */
  private runVerifyMode(rest: readonly string[]): number {
    const parsed = this.positionalsOf(rest, [], VERIFY_BOOL_FLAGS);
    if (parsed.unknown.length > 0) {
      process.stderr.write(
        `[omniharness] audit verify 不认识的旗标：${parsed.unknown.join(' ')}\n`,
      );
      return 2;
    }
    if (parsed.paths.length === 0) {
      process.stdout.write(USAGE);
      return 2;
    }
    try {
      return this.tool.verify(parsed.paths, rest.includes('--json'));
    } catch (error) {
      process.stderr.write(`[omniharness] 审计报告复核失败：${this.messageOf(error)}\n`);
      return 1;
    }
  }

  /**
   * 解析输出格式：显式 --format 优先，其次按 --out 扩展名推断，缺省 html。
   * @param raw --format 值。
   * @param out --out 值。
   * @returns 格式；非法返回 null。
   */
  private resolveFormat(raw: string | undefined, out: string | null): AuditOutputFormat | null {
    if (raw !== undefined) {
      return raw === 'html' || raw === 'md' || raw === 'json' ? raw : null;
    }
    if (out !== null) {
      const ext = extname(out).toLowerCase();
      if (ext === '.md' || ext === '.markdown') {
        return 'md';
      }
      if (ext === '.json') {
        return 'json';
      }
    }
    return 'html';
  }

  /**
   * 解析输入格式覆盖值。
   * @param raw --source-format 值。
   * @returns 格式 / null（自动）/ 'invalid'。
   */
  private resolveSourceFormat(raw: string | undefined): AuditSourceFormat | null | 'invalid' {
    if (raw === undefined) {
      return null;
    }
    return raw === 'omni' || raw === 'claude-code' || raw === 'codex' || raw === 'acp'
      ? raw
      : 'invalid';
  }

  /**
   * 提取位置参数与不认识的旗标。
   * @param args 参数列表。
   * @param valueFlags 取值型旗标（其后的 token 不是位置参数）。
   * @param boolFlags 开关型旗标。
   * @returns 解析结果。
   */
  private positionalsOf(
    args: readonly string[],
    valueFlags: readonly string[],
    boolFlags: readonly string[],
  ): Positionals {
    const paths: string[] = [];
    const unknown: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === undefined) {
        continue;
      }
      if (!arg.startsWith('-')) {
        paths.push(arg);
        continue;
      }
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (valueFlags.indexOf(name) >= 0) {
        if (eq < 0) {
          index += 1;
        }
        continue;
      }
      if (boolFlags.indexOf(name) >= 0) {
        continue;
      }
      unknown.push(arg);
    }
    return { paths, unknown };
  }

  /**
   * 取错误消息文本。
   * @param error 捕获值。
   * @returns 文本。
   */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 构造审计 sink：--audit-file 优先，其次 --audit-dir 或 env OMNI_AUDIT_DIR，均无则 no-op。
   * @param reader 参数读取器（在去掉 `audit export` 后的参数上）。
   * @returns 审计 sink；`--audit-hmac-key` / env `OMNI_AUDIT_HMAC_KEY` 给出时链升级为 HMAC 防篡改模式。
   */
  private buildSink(reader: CliArgReader): AuditSink {
    const auditDir = reader.value('--audit-dir') ?? process.env['OMNI_AUDIT_DIR'];
    const auditFile = reader.value('--audit-file');
    // 密钥只从旗标/环境变量取，绝不落盘（进日志/配置文件会让 HMAC 形同虚设）。
    // exactOptionalPropertyTypes：未配置时不产出显式 undefined 键。
    const hmacKey = reader.value('--audit-hmac-key') ?? process.env['OMNI_AUDIT_HMAC_KEY'];
    const withKey = hmacKey !== undefined ? { hmacKey } : {};
    return new AuditSink(
      auditFile !== undefined
        ? { path: auditFile, ...withKey }
        : auditDir !== undefined
          ? { dir: auditDir, ...withKey }
          : withKey,
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
    const report = AuditExporter.buildComplianceReport(
      events,
      query,
      { generatedBy: 'omniharness' },
      chain,
    );
    if (chain.ok === false) {
      process.stderr.write(
        `[omniharness] 审计哈希链校验失败：${chain.reason ?? '未知原因'}（断裂处 seq=${String(chain.brokenAt)}）\n` +
          `              该报告不可作为合规证据，请核查审计日志完整性。\n`,
      );
    }
    const chainLabel = chain.ok === true ? '完整' : chain.ok === false ? '断裂' : '未启用';
    const text = AuditExporter.formatCompliance(report);
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
    const filtered = AuditExporter.queryAudit(events, query);
    const matched = AuditExporter.formatAudit(filtered, format);
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
