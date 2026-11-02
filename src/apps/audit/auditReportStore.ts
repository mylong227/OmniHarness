import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AuditHtmlRenderer } from './auditHtmlRenderer.ts';
import { AuditMarkdownRenderer } from './auditMarkdownRenderer.ts';
import type { AuditOutputFormat, AuditReport } from './auditTypes.ts';

/**
 * 报告的落盘与回读（HTML / Markdown / JSON 三种形态）。
 *
 * 三者的关系：HTML 与 Markdown 都是**载体的渲染**，完整载荷原样内嵌；JSON 就是载荷本身。
 * 回读时按内容识别（不只看扩展名），因为用户会把 `.html` 改名、也会把报告贴进邮件再另存。
 *
 * ## 文件级自指纹
 *
 * HTML / Markdown 除了载荷链，还写一个 `artifact.sha256`：把该字段临时替换成占位标记，
 * 对**整份文本**（含展示层）做 SHA-256，再把标记换回摘要。于是"只改页面上的一个显示字符、
 * 不动内嵌 JSON"也能被 `audit verify` 检出——这是出证工具与"好看的报表"的区别。
 * JSON 没有展示层，不写该字段（否则改完 JSON 重算即可，意义不大）。
 */
export class AuditReportStore {
  /** HTML 载荷的正则（与渲染器的标签逐字对应）。 */
  private static readonly HTML_PAYLOAD =
    /<script type="application\/json" id="oh-audit-payload">([\s\S]*?)<\/script>/;

  /** 计算文件级自指纹时的占位标记（长度不必等于摘要，替换只发生一次）。 */
  public static readonly ARTIFACT_TOKEN = '__OH_ARTIFACT_SHA256__';

  /**
   * 渲染为指定格式。
   * @param report 报告。
   * @param format 输出格式。
   * @returns 文本。
   */
  public render(report: AuditReport, format: AuditOutputFormat): string {
    if (format === 'json') {
      return JSON.stringify(report, null, 2);
    }
    const renderer = format === 'html' ? new AuditHtmlRenderer() : new AuditMarkdownRenderer();
    const tokenized: AuditReport = {
      ...report,
      artifact: { sha256: AuditReportStore.ARTIFACT_TOKEN },
    };
    const text = renderer.render(tokenized);
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    return text.replace(AuditReportStore.ARTIFACT_TOKEN, digest);
  }

  /**
   * 写入文件（自动建父目录）。
   * @param report 报告。
   * @param format 输出格式。
   * @param path 目标路径。
   * @returns 无返回值。
   */
  public write(report: AuditReport, format: AuditOutputFormat, path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.render(report, format), 'utf8');
  }

  /**
   * 回读并解析报告（含原文，供文件级自指纹复核）。
   * @param path 报告文件路径。
   * @returns 报告对象、识别出的格式与原文本。
   * @throws Error 文件不含载荷或 JSON 非法时抛出。
   */
  public read(path: string): {
    readonly report: AuditReport;
    readonly format: AuditOutputFormat;
    readonly text: string;
  } {
    const text = readFileSync(path, 'utf8');
    return { ...this.parse(text, path), text };
  }

  /**
   * 从文本中解析报告（供回读与判据使用）。
   * @param text 文件全文。
   * @param path 报错定位用的路径。
   * @returns 报告与格式。
   * @throws Error 找不到载荷或解析失败时抛出。
   */
  public parse(
    text: string,
    path: string,
  ): { readonly report: AuditReport; readonly format: AuditOutputFormat } {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{')) {
      return { report: this.parseJson(trimmed, path), format: 'json' };
    }
    const html = AuditReportStore.HTML_PAYLOAD.exec(text);
    if (html !== null && html[1] !== undefined) {
      return { report: this.parseJson(html[1], path), format: 'html' };
    }
    const markdown = this.markdownPayload(text);
    if (markdown !== null) {
      return { report: this.parseJson(markdown, path), format: 'md' };
    }
    throw new Error(
      `${path} 里找不到审计载荷（期望 HTML 的 oh-audit-payload 标签、Markdown 的 ${AuditMarkdownRenderer.PAYLOAD_MARKER} 标记或裸 JSON）。`,
    );
  }

  /**
   * 提取 Markdown 里的围栏 JSON。
   * @param text Markdown 全文。
   * @returns JSON 文本；没有载荷返回 null。
   */
  private markdownPayload(text: string): string | null {
    const marker = text.indexOf(AuditMarkdownRenderer.PAYLOAD_MARKER);
    if (marker < 0) {
      return null;
    }
    const rest = text.slice(marker);
    const fence = /(`{3,})json\r?\n([\s\S]*?)\r?\n\1/.exec(rest);
    return fence !== null && fence[2] !== undefined ? fence[2] : null;
  }

  /**
   * 解析 JSON 载荷并做最小形状校验。
   * @param text JSON 文本。
   * @param path 报错定位。
   * @returns 报告。
   * @throws Error JSON 非法或不是报告对象时抛出。
   */
  private parseJson(text: string, path: string): AuditReport {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `${path} 的审计载荷不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${path} 的审计载荷不是对象`);
    }
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record['records']) || typeof record['integrity'] !== 'object') {
      throw new Error(`${path} 的审计载荷缺少 records / integrity 字段`);
    }
    return value as AuditReport;
  }
}
