import { AUDIT_VERIFIER_SCRIPT } from './auditVerifierScript.ts';
import { AuditFormatting } from './auditFormatting.ts';
import type { AuditChainedRecord, AuditRecord, AuditReport } from './auditTypes.ts';

/**
 * 单文件 HTML 报告渲染器（离线可开、自带复核按钮）。
 *
 * 产物约束：**零外部资源**（无 CDN、无字体文件、无脚本外链），因此可以进邮件、进
 * U 盘、进内网只读目录；报告正文里的所有外部文本都经 {@link AuditFormatting.escapeHtml}
 * 转义，内嵌 JSON 里的 `<` / `>` / `&` 也被转义，避免提前闭合 `<script>`。
 */
export class AuditHtmlRenderer {
  /** 页面样式（单文件自包含；深色由 `prefers-color-scheme` 切换）。 */
  private static readonly CSS = [
    ':root{color-scheme:light dark;--bg:#f7f7f8;--panel:#fff;--ink:#17181a;--muted:#6b7078;--line:#e3e4e7;--accent:#1f6feb;--ok:#18794e;--bad:#c0392b}',
    '@media (prefers-color-scheme:dark){:root{--bg:#111315;--panel:#191c1f;--ink:#e8e9eb;--muted:#9aa0a6;--line:#2c3035;--accent:#6ea8fe;--ok:#3fb950;--bad:#f85149}}',
    '*{box-sizing:border-box}',
    'body{margin:0;padding:32px 20px 64px;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,"Segoe UI","Noto Sans SC",sans-serif}',
    'main{max-width:1080px;margin:0 auto}',
    'h1{font-size:26px;margin:0 0 6px}h2{font-size:18px;margin:32px 0 10px}',
    '.sub{color:var(--muted);font-size:13px;word-break:break-all}',
    '.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;border:1px solid var(--line);color:var(--muted)}',
    '.badge.ok{color:var(--ok);border-color:var(--ok)}.badge.bad{color:var(--bad);border-color:var(--bad)}',
    '.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}',
    '.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}',
    '.card .k{color:var(--muted);font-size:12px}.card .v{font-size:22px;font-weight:600;margin-top:2px}',
    'table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}',
    'th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}',
    'th{color:var(--muted);font-weight:600;background:color-mix(in srgb,var(--panel) 88%,var(--bg))}',
    'tr:last-child td{border-bottom:0}',
    'code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}',
    'pre{white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;margin:6px 0 0}',
    'details summary{cursor:pointer;color:var(--ink)}',
    'details summary::marker{color:var(--muted)}',
    '.muted{color:var(--muted)}.kind{text-transform:uppercase;font-size:11px;letter-spacing:.04em;color:var(--muted)}',
    '.time{white-space:nowrap;color:var(--muted)}',
    '.ok{color:var(--ok)}.bad{color:var(--bad)}',
    '.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}',
    'button{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}',
    'button:hover{border-color:var(--accent)}',
    'footer{margin-top:40px;color:var(--muted);font-size:12px}',
    '@media print{body{padding:0;background:#fff}.cards{grid-template-columns:repeat(4,1fr)}button{display:none}}',
  ].join('\n');

  /**
   * 渲染整份报告。
   * @param report 报告。
   * @returns 完整 HTML 文本。
   */
  public render(report: AuditReport): string {
    return [
      '<!doctype html>',
      '<html lang="zh-CN"><head>',
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      `<title>${AuditFormatting.escapeHtml(report.title)}</title>`,
      `<style>${AuditHtmlRenderer.CSS}</style>`,
      '</head><body><main>',
      this.headerHtml(report),
      this.cardsHtml(report),
      this.integrityHtml(report),
      this.filesHtml(report),
      this.timelineHtml(report),
      this.footerHtml(report),
      '</main>',
      this.payloadHtml(report),
      `<script>${AUDIT_VERIFIER_SCRIPT}</script>`,
      '</body></html>',
    ].join('\n');
  }

  /**
   * 页头。
   * @param report 报告。
   * @returns HTML。
   */
  private headerHtml(report: AuditReport): string {
    const source = report.source;
    return [
      '<header>',
      `<h1>${AuditFormatting.escapeHtml(report.title)}</h1>`,
      `<div class="sub">${AuditFormatting.escapeHtml(report.generator.name)} ${AuditFormatting.escapeHtml(report.generator.version)} · 生成于 ${AuditFormatting.escapeHtml(report.generatedAt)} · 格式 ${AuditFormatting.escapeHtml(source.format)} · 会话 ${AuditFormatting.escapeHtml(source.sessionId ?? '未知')}</div>`,
      `<div class="sub">来源 <code>${AuditFormatting.escapeHtml(source.path)}</code> · 工作区 ${AuditFormatting.escapeHtml(source.workspace ?? '未知')} · 模型 ${AuditFormatting.escapeHtml(source.model ?? '未知')}</div>`,
      `<p><span class="badge" id="oh-verify-state">复核中…</span></p>`,
      '</header>',
    ].join('\n');
  }

  /**
   * 摘要卡片。
   * @param report 报告。
   * @returns HTML。
   */
  private cardsHtml(report: AuditReport): string {
    const summary = report.summary;
    const cards = [
      this.card('记录', AuditFormatting.number(summary.total)),
      this.card('工具调用', AuditFormatting.number(summary.toolCalls)),
      this.card('工具失败', AuditFormatting.number(summary.toolFailures)),
      this.card('涉及文件', AuditFormatting.number(summary.filesChanged)),
      this.card('审批', AuditFormatting.number(summary.approvals)),
      this.card('耗时', AuditFormatting.duration(summary.durationMs)),
    ];
    if (report.tokens !== null) {
      cards.push(this.card('输入 token', AuditFormatting.number(report.tokens.prompt)));
      cards.push(this.card('输出 token', AuditFormatting.number(report.tokens.completion)));
      cards.push(this.card('缓存读 token', AuditFormatting.number(report.tokens.cached)));
    }
    return `<section class="cards">${cards.join('')}</section>`;
  }

  /**
   * 单张卡片。
   * @param key 标签。
   * @param value 值文本。
   * @returns HTML。
   */
  private card(key: string, value: string): string {
    return `<div class="card"><div class="k">${AuditFormatting.escapeHtml(key)}</div><div class="v">${AuditFormatting.escapeHtml(value)}</div></div>`;
  }

  /**
   * 完整性面板。
   * @param report 报告。
   * @returns HTML。
   */
  private integrityHtml(report: AuditReport): string {
    const integrity = report.integrity;
    return [
      '<section class="panel">',
      '<h2>完整性</h2>',
      `<div class="sub">算法 <code>${AuditFormatting.escapeHtml(integrity.algorithm)}</code> · 链头 <code>${AuditFormatting.escapeHtml(integrity.head)}</code></div>`,
      `<div class="sub">创世 <code>${AuditFormatting.escapeHtml(integrity.genesis)}</code> · 记录数 ${AuditFormatting.number(integrity.count)} · 输入文件 SHA-256 <code>${AuditFormatting.escapeHtml(report.source.sha256)}</code></div>`,
      '<p><button id="oh-verify">在本页复核</button></p>',
      '<p class="muted" id="oh-verify-result">正在重算哈希链…</p>',
      '<p class="muted">页内按钮复核的是载荷链；文件级完整性（含本页展示层）请用 <code>omniharness audit verify &lt;本文件&gt;</code>。</p>',
      '<details><summary>复核算法（可与第三方实现逐字节对照）</summary><pre>规范化：对象键按 UTF-16 码元升序；省略 undefined；数组保持顺序。',
      '哈希：hash_n = SHA-256(prev_n + "\\n" + canonical(record_n))；prev_1 = 64 个 "0"。',
      '链头：最后一条的 hash；空链时为创世哈希。</pre></details>',
      '</section>',
    ].join('\n');
  }

  /**
   * 文件表。
   * @param report 报告。
   * @returns HTML。
   */
  private filesHtml(report: AuditReport): string {
    if (report.files.length === 0) {
      return '<h2>文件变更</h2><p class="muted">源里没有可识别的写类工具调用或 diff。</p>';
    }
    const rows = report.files.map((file) =>
      [
        '<tr>',
        `<td><code>${AuditFormatting.escapeHtml(file.path)}</code></td>`,
        `<td>${AuditFormatting.number(file.touches)}</td>`,
        `<td class="ok">+${AuditFormatting.number(file.added)}</td>`,
        `<td class="bad">−${AuditFormatting.number(file.removed)}</td>`,
        '</tr>',
      ].join(''),
    );
    return [
      '<h2>文件变更</h2>',
      '<table><thead><tr><th>路径</th><th>触及</th><th>新增</th><th>删除</th></tr></thead><tbody>',
      rows.join(''),
      '</tbody></table>',
    ].join('\n');
  }

  /**
   * 时间线。
   * @param report 报告。
   * @returns HTML。
   */
  private timelineHtml(report: AuditReport): string {
    const shown = report.records.slice(0, AuditFormatting.MAX_DISPLAY_RECORDS);
    const rows = shown.map((item) => this.recordRow(item));
    const note =
      report.records.length > shown.length
        ? `<p class="muted">仅展示前 ${String(shown.length)} 条（共 ${String(report.records.length)} 条）；完整数据在内嵌载荷中。</p>`
        : '';
    return [
      '<h2>时间线</h2>',
      note,
      '<table><thead><tr><th>#</th><th>时间</th><th>类别</th><th>事件</th><th>详情</th></tr></thead><tbody>',
      rows.join(''),
      '</tbody></table>',
    ].join('\n');
  }

  /**
   * 一条时间线记录。
   * @param item 带链记录。
   * @returns HTML 行。
   */
  private recordRow(item: AuditChainedRecord): string {
    const record: AuditRecord = item.record;
    const name = record.callId === undefined ? record.title : `${record.title} · ${record.callId}`;
    return [
      '<tr>',
      `<td>${String(record.seq)}</td>`,
      `<td class="time">${AuditFormatting.escapeHtml(AuditFormatting.timestamp(record.ts))}</td>`,
      `<td><span class="kind">${AuditFormatting.escapeHtml(record.kind)}</span></td>`,
      `<td>${AuditFormatting.escapeHtml(name)}${record.status === undefined ? '' : ` <span class="kind">${AuditFormatting.escapeHtml(record.status)}</span>`}</td>`,
      `<td>${AuditFormatting.detailHtml(record.text)}</td>`,
      '</tr>',
    ].join('');
  }

  /**
   * 页脚。
   * @param report 报告。
   * @returns HTML。
   */
  private footerHtml(report: AuditReport): string {
    return [
      '<footer>',
      '<p>哈希链证明“这份报告自生成后未被改动”，<strong>不证明</strong>会话本身真实、也不证明是谁生成的。',
      '需要来源可信时，请与留存副本或外部时间戳一起使用。</p>',
      `<p>schema ${AuditFormatting.escapeHtml(report.schema)} · 输入文件 <code>${AuditFormatting.escapeHtml(report.source.path)}</code></p>`,
      '</footer>',
    ].join('');
  }

  /**
   * 内嵌载荷（JSON）。
   * @param report 报告。
   * @returns `<script type="application/json">` 标签。
   */
  private payloadHtml(report: AuditReport): string {
    const json = AuditFormatting.embedJson(JSON.stringify(report));
    return `<script type="application/json" id="oh-audit-payload">${json}</script>`;
  }
}
