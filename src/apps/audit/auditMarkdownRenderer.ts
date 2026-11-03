import { AuditFormatting } from './auditFormatting.ts';
import type { AuditChainedRecord, AuditReport } from './auditTypes.ts';

/**
 * Markdown 报告渲染器（给 issue / PR / 邮件正文用）。
 *
 * 完整载荷以 `<details>` + 围栏 JSON 附在文末，前面有固定标记
 * {@link AuditMarkdownRenderer.PAYLOAD_MARKER}，`audit verify` 靠它取出载荷。
 */
export class AuditMarkdownRenderer {
  /** 载荷标记（解析器与渲染器共用的唯一字面量）。 */
  public static readonly PAYLOAD_MARKER = '<!--oh-audit-payload-->';

  /**
   * 渲染 Markdown 报告。
   * @param report 报告。
   * @returns Markdown 文本。
   */
  public render(report: AuditReport): string {
    const payload = JSON.stringify(report);
    return [
      `# ${report.title}`,
      '',
      `> ${report.generator.name} ${report.generator.version} · 生成于 ${report.generatedAt} · schema \`${report.schema}\``,
      '',
      '## 来源',
      '',
      `- 文件：\`${this.code(report.source.path)}\``,
      `- 格式：\`${report.source.format}\` · 会话：\`${this.code(report.source.sessionId ?? '未知')}\``,
      `- 工作区：\`${this.code(report.source.workspace ?? '未知')}\` · 模型：\`${this.code(report.source.model ?? '未知')}\``,
      `- 输入 SHA-256：\`${report.source.sha256}\``,
      `- 时间范围：${AuditFormatting.timestamp(report.source.startedAt)} → ${AuditFormatting.timestamp(report.source.endedAt)}（${AuditFormatting.duration(report.summary.durationMs)}）`,
      '',
      '## 摘要',
      '',
      '| 项目 | 值 |',
      '| ---- | -- |',
      `| 记录 | ${AuditFormatting.number(report.summary.total)} |`,
      ...(report.coverage === undefined
        ? []
        : [`| 未识别 | ${AuditFormatting.number(report.coverage.unrecognized)} |`]),
      `| 工具调用 | ${AuditFormatting.number(report.summary.toolCalls)} |`,
      `| 工具失败 | ${AuditFormatting.number(report.summary.toolFailures)} |`,
      `| 涉及文件 | ${AuditFormatting.number(report.summary.filesChanged)} |`,
      `| 审批 | ${AuditFormatting.number(report.summary.approvals)} |`,
      ...this.tokenRows(report),
      '',
      '## 完整性',
      '',
      `- 算法：\`sha256\` · 链头：\`${report.integrity.head}\``,
      `- 记录数：${AuditFormatting.number(report.integrity.count)} · 创世：\`${report.integrity.genesis}\``,
      '- 复核：`omniharness audit verify <本文件>`（或与报告内嵌载荷逐字节对照）',
      '',
      ...this.filesSection(report),
      ...this.timelineSection(report),
      '## 完整载荷',
      '',
      '<details><summary>展开 JSON（哈希链覆盖其中每条记录）</summary>',
      '',
      AuditMarkdownRenderer.PAYLOAD_MARKER,
      `${this.fenceFor(payload)}json`,
      payload,
      this.fenceFor(payload),
      '',
      '</details>',
      '',
      '---',
      '',
      '哈希链证明“报告自生成后未被改动”，不证明会话本身真实、也不证明生成者身份。',
    ].join('\n');
  }

  /**
   * token 行。
   * @param report 报告。
   * @returns 表格行。
   */
  private tokenRows(report: AuditReport): string[] {
    if (report.tokens === null) {
      return [];
    }
    return [
      `| 输入 token | ${AuditFormatting.number(report.tokens.prompt)} |`,
      `| 输出 token | ${AuditFormatting.number(report.tokens.completion)} |`,
      `| 缓存读 token | ${AuditFormatting.number(report.tokens.cached)} |`,
      `| 总 token | ${AuditFormatting.number(report.tokens.total)} |`,
    ];
  }

  /**
   * 文件表段。
   * @param report 报告。
   * @returns Markdown 行。
   */
  private filesSection(report: AuditReport): string[] {
    if (report.files.length === 0) {
      return ['## 文件变更', '', '源里没有可识别的写类工具调用或 diff。', ''];
    }
    return [
      '## 文件变更',
      '',
      '| 路径 | 触及 | 新增 | 删除 |',
      '| ---- | ---- | ---- | ---- |',
      ...report.files.map(
        (file) =>
          `| \`${this.code(file.path)}\` | ${String(file.touches)} | +${String(file.added)} | −${String(file.removed)} |`,
      ),
      '',
    ];
  }

  /**
   * 时间线段。
   * @param report 报告。
   * @returns Markdown 行。
   */
  private timelineSection(report: AuditReport): string[] {
    const shown = report.records.slice(0, AuditFormatting.MAX_DISPLAY_RECORDS);
    const lines = [
      '## 时间线',
      '',
      ...(report.records.length > shown.length
        ? [
            `> 仅展示前 ${String(shown.length)} 条（共 ${String(report.records.length)} 条）；完整数据见文末载荷。`,
            '',
          ]
        : []),
      '| # | 时间 | 类别 | 事件 | 详情 |',
      '| - | ---- | ---- | ---- | ---- |',
    ];
    for (const item of shown) {
      lines.push(this.timelineRow(item));
    }
    lines.push('');
    return lines;
  }

  /**
   * 一条时间线行。
   * @param item 带链记录。
   * @returns Markdown 行。
   */
  private timelineRow(item: AuditChainedRecord): string {
    const record = item.record;
    const status = record.status === undefined ? '' : ` (${record.status})`;
    return `| ${String(record.seq)} | ${AuditFormatting.timestamp(record.ts)} | ${record.kind} | ${AuditFormatting.markdownCell(record.title)}${status} | ${AuditFormatting.markdownCell(record.text)} |`;
  }

  /**
   * 选择围栏长度：必须比载荷里任意连续反引号更长，否则正文里的 ``` 会提前闭合围栏，
   * 回读时拿到被截断的 JSON（报告"看起来有载荷"，复核却报坏 JSON）。
   * @param payload 载荷 JSON。
   * @returns 围栏字符串。
   */
  private fenceFor(payload: string): string {
    const runs = payload.match(/`+/g) ?? [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    return '`'.repeat(Math.max(3, longest + 1));
  }

  /**
   * 行内代码转义（反引号替换为直角引号，避免提前闭合）。
   * @param text 原始文本。
   * @returns 可放进反引号内的文本。
   */
  private code(text: string): string {
    return text.replace(/`/g, 'ˋ');
  }
}
