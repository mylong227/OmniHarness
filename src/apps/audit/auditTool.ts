import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { API_VERSION } from '../../version.ts';
import { AuditFormatting } from './auditFormatting.ts';
import { AuditRedactor } from './auditRedactor.ts';
import { AuditReportBuilder } from './auditReportBuilder.ts';
import { AuditReportStore } from './auditReportStore.ts';
import { AuditReportVerifier } from './auditReportVerifier.ts';
import { AuditSourceLoader } from './auditSourceLoader.ts';
import type {
  AuditOutputFormat,
  AuditRedactMode,
  AuditReport,
  AuditSourceFormat,
} from './auditTypes.ts';

/** `audit report` 的请求参数。 */
export interface AuditReportRequest {
  /** 输入会话文件或目录（可多个）。 */
  readonly inputs: readonly string[];
  /** 输出格式（缺省 html）。 */
  readonly format: AuditOutputFormat;
  /** 输出路径：单文件时可为文件；多文件/目录时必须是目录；缺省 `audit-reports/`。 */
  readonly out: string | null;
  /** 报告标题（缺省由来源派生）。 */
  readonly title: string | null;
  /** 强制输入格式（缺省自动识别）。 */
  readonly sourceFormat?: AuditSourceFormat;
  /**
   * 严格模式（2026-11-03 P0）：任一输入的未识别条目 > 0 ⇒ 退出码 1。
   * 报告**仍然逐份生成**——strict 失败不销毁证据。语义详见 `docs/audit/EXIT_CODES.md` §2。
   */
  readonly strict?: boolean;
  /**
   * 脱敏模式（2026-11-04 P3，默认 off——证据保真优先）：off/paths/secrets/all。
   * 规则与边界见 `docs/audit/README.md` §4。
   */
  readonly redact?: AuditRedactMode;
  /** 注入生成时间（判据用）。 */
  readonly generatedAt?: string;
}

/**
 * 「审计出证」用例编排：读 → 解析 → 构建 → 落盘 / 复核。
 *
 * 这一层只做**流程**（不含解析细节、不含渲染细节），因此 CLI、未来的 Web 入口与判据
 * 可以共用同一套行为与退出码（正式契约见 `docs/audit/EXIT_CODES.md`）：
 * - `0`：全部成功 / 全部链完整；
 * - `1`：有报告链不完整（或复核失败）；`--strict` 下任一输入有未识别条目；
 * - `2`：用法 / 输入错误（由 CLI 层在参数阶段返回）。
 */
export class AuditTool {
  /** 来源加载器。 */
  private readonly loader: AuditSourceLoader;

  /** 报告构建器。 */
  private readonly builder: AuditReportBuilder;

  /** 报告存储。 */
  private readonly store: AuditReportStore;

  /** 复核器。 */
  private readonly verifier: AuditReportVerifier;

  /**
   * @param loader 来源加载器（缺省新建）。
   * @param builder 报告构建器（缺省新建）。
   * @param store 报告存储（缺省新建）。
   * @param verifier 复核器（缺省新建）。
   */
  public constructor(
    loader: AuditSourceLoader = new AuditSourceLoader(),
    builder: AuditReportBuilder = new AuditReportBuilder(),
    store: AuditReportStore = new AuditReportStore(),
    verifier: AuditReportVerifier = new AuditReportVerifier(),
  ) {
    this.loader = loader;
    this.builder = builder;
    this.store = store;
    this.verifier = verifier;
  }

  /**
   * 生成报告。
   * @param request 请求参数。
   * @returns 进程退出码（0 成功；`strict` 且任一文件有未识别条目时 1）。
   * @throws Error 输入非法 / 格式认不出 / 写盘失败时由调用方捕获。
   */
  public report(request: AuditReportRequest): number {
    const files = this.expandAll(request.inputs);
    const multiple = files.length > 1;
    if (multiple && request.out !== null && !this.isDirectory(request.out)) {
      const ext = extname(request.out).toLowerCase();
      if (ext === '.html' || ext === '.htm' || ext === '.md' || ext === '.json') {
        throw new Error('多个输入文件时 --out 必须是目录（不能是单份报告的路径）');
      }
    }
    const outIsDir = multiple || this.isDirectory(request.out);
    let unrecognizedFiles = 0;
    for (const file of files) {
      const loaded = this.loader.load(file, request.sourceFormat);
      const redaction = AuditRedactor.redactSource(loaded, request.redact ?? 'off');
      const options = {
        generatorVersion: API_VERSION,
        ...(request.title !== null && !multiple ? { title: request.title } : {}),
        redaction: redaction.info,
        ...(request.generatedAt !== undefined ? { generatedAt: request.generatedAt } : {}),
      };
      const built = this.builder.build(redaction.source, options);
      const target = this.targetOf(built, file, request, outIsDir);
      this.store.write(built, request.format, target);
      process.stdout.write(this.summaryLine(target, built));
      const hits = built.coverage?.unrecognized ?? 0;
      if (hits > 0) {
        unrecognizedFiles += 1;
        process.stdout.write(
          `  ⚠ 未识别 ${String(hits)} 条来源条目（已以 other 记录保留；详见报告 coverage）` +
            `${request.strict === true ? '——--strict 判为失败\n' : '\n'}`,
        );
      }
    }
    return request.strict === true && unrecognizedFiles > 0 ? 1 : 0;
  }

  /**
   * 复核报告（可一次给多份）。
   * @param paths 报告路径。
   * @param json 是否输出机读 JSON（缺省人类可读）。
   * @returns 进程退出码（0 全部完整 / 1 有失败）。
   * @throws Error 文件读不到 / 载荷缺失时由调用方捕获。
   */
  public verify(paths: readonly string[], json = false): number {
    let failed = 0;
    const results: {
      readonly path: string;
      readonly ok: boolean;
      readonly records: number;
      readonly head: string;
      readonly brokenAt: number | null;
      readonly reason: string | null;
    }[] = [];
    for (const path of this.reportTargets(paths)) {
      const { report, format, text } = this.store.read(path);
      const result = this.verifier.verifyFile(report, text, format);
      results.push({
        path,
        ok: result.ok,
        records: report.records.length,
        head: report.integrity.head,
        brokenAt: result.brokenAt,
        reason: result.reason,
      });
      if (!result.ok) {
        failed += 1;
      }
    }
    if (json) {
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      return failed === 0 ? 0 : 1;
    }
    for (const item of results) {
      if (item.ok) {
        process.stdout.write(
          `✓ ${item.path} — 链完整（${AuditFormatting.number(item.records)} 条记录，链头 ${item.head.slice(0, 16)}…）\n`,
        );
        continue;
      }
      const where = item.brokenAt === null ? '报告字段' : `第 ${String(item.brokenAt + 1)} 条记录`;
      process.stdout.write(
        `✗ ${item.path} — ${where}：${item.reason ?? '未知原因'}（报告可能被改动，不可作为证据）\n`,
      );
    }
    return failed === 0 ? 0 : 1;
  }

  /**
   * 展开全部输入。
   * @param inputs 输入列表。
   * @returns 文件列表（保序、去重）。
   */
  private expandAll(inputs: readonly string[]): string[] {
    const files: string[] = [];
    for (const input of inputs) {
      for (const file of this.loader.expand(input)) {
        if (files.indexOf(file) < 0) {
          files.push(file);
        }
      }
    }
    if (files.length === 0) {
      throw new Error('没有可处理的输入文件');
    }
    return files;
  }

  /**
   * 判断输出路径是否是目录（存在的目录，或"看起来像目录"：无扩展名 / 以分隔符结尾）。
   * @param out 输出路径（可为 null）。
   * @returns 是目录则 true。
   */
  private isDirectory(out: string | null): boolean {
    if (out === null) {
      return false;
    }
    const stats = statSync(out, { throwIfNoEntry: false });
    if (stats !== undefined) {
      return stats.isDirectory();
    }
    return out.endsWith('/') || out.endsWith('\\') || extname(out) === '';
  }

  /**
   * 展开待复核的报告路径：目录 → 其中的 `.html` / `.md` / `.json`（排序、限量）。
   * @param paths 用户给的文件或目录。
   * @returns 报告文件列表（去重、保序）。
   * @throws Error 输入里没有任何报告文件时抛出（不静默返回 0）。
   */
  private reportTargets(paths: readonly string[]): string[] {
    const targets: string[] = [];
    for (const path of paths) {
      const stats = statSync(path, { throwIfNoEntry: false });
      if (stats === undefined) {
        throw new Error(`路径不存在：${path}`);
      }
      if (!stats.isDirectory()) {
        targets.push(path);
        continue;
      }
      const found = readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(?:html?|md|markdown|json)$/i.test(entry.name))
        .map((entry) => join(path, entry.name))
        .sort();
      for (const file of found) {
        if (targets.indexOf(file) < 0) {
          targets.push(file);
        }
      }
    }
    if (targets.length === 0) {
      throw new Error('没有可复核的报告文件（支持 .html / .md / .json，或它们的目录）');
    }
    return targets;
  }

  /**
   * 计算输出文件路径。
   * @param report 报告。
   * @param input 来源文件。
   * @param request 请求。
   * @param outIsDir 输出是否为目录。
   * @returns 目标路径。
   * @throws Error 多文件却给了单文件输出路径时抛出。
   */
  private targetOf(
    report: AuditReport,
    input: string,
    request: AuditReportRequest,
    outIsDir: boolean,
  ): string {
    const ext = request.format === 'md' ? 'md' : request.format === 'json' ? 'json' : 'html';
    if (request.out !== null && !outIsDir) {
      return request.out;
    }
    const dir = request.out ?? 'audit-reports';
    return join(dir, `${this.stemOf(report, input)}.audit.${ext}`);
  }

  /**
   * 计算输出文件名主干。
   * @param report 报告。
   * @param input 输入文件。
   * @returns 安全文件名主干。
   */
  private stemOf(report: AuditReport, input: string): string {
    const raw = report.source.sessionId ?? basename(input, extname(input));
    const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return safe === '' ? 'session' : safe;
  }

  /**
   * 打印一行摘要。
   * @param target 输出路径。
   * @param report 报告。
   * @returns 文本行（含换行）。
   */
  private summaryLine(target: string, report: AuditReport): string {
    const tokens = report.tokens === null ? '—' : AuditFormatting.number(report.tokens.total);
    return (
      `审计报告已生成：${target}\n` +
      `  记录 ${AuditFormatting.number(report.summary.total)} · 工具 ${AuditFormatting.number(report.summary.toolCalls)}` +
      ` · 失败 ${AuditFormatting.number(report.summary.toolFailures)} · 文件 ${AuditFormatting.number(report.summary.filesChanged)}` +
      ` · token ${tokens} · 未识别 ${AuditFormatting.number(report.coverage?.unrecognized ?? 0)}` +
      ` · 脱敏 ${report.redaction?.mode ?? 'off'}` +
      ` · 链头 ${report.integrity.head.slice(0, 16)}…\n`
    );
  }
}
