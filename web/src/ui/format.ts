// 纯函数工具层：vanilla 版中散落的字符串拼接与 innerHTML 注入，统一改写为返回 React 元素的纯函数。
// 组件层调用这些函数，既保持视觉一致（复用同一套 CSS class），又避免直接操作 DOM。

import { html, React } from './deps.js';
import type { ThreadEvent } from '../types/models.js';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

const BADGE_MAP: Record<string, [string, string]> = {
  user: ['你', 'b-user'],
  assistant: ['助手', 'b-assistant'],
  reasoning: ['推理', 'b-reasoning'],
  tool_call: ['工具调用', 'b-tool_call'],
  tool_result: ['工具结果', 'b-tool_result'],
  system: ['系统', 'b-system'],
  todo: ['待办', 'b-todo'],
  plan: ['计划', 'b-plan'],
  question: ['提问', 'b-question'],
  turn_diff: ['变更', 'b-turn_diff'],
};

export function badge(type: string): ReactElement {
  const m = BADGE_MAP[type] ?? [type, 'b-system'];
  return html`<span className="badge ${m[1]}">${m[0]}</span>`;
}

export function timeOf(ts?: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return '';
  }
}

export function emptyState(icon: string, text: string, hint: string): ReactElement {
  return html`<div className="empty illu">
    <div className="illu-icon">${icon}</div>
    <div className="illu-text">${text}</div>
    <div className="illu-hint">${hint}</div>
  </div>`;
}

export function jsonView(obj: unknown): ReactElement {
  return html`<pre className="json">${esc(JSON.stringify(obj, null, 2))}</pre>`;
}

/** 模型向用户提问的只读渲染（当前环境自动返回默认值，UI 先展示问题内容）。 */
export function questionView(questions: unknown): ReactElement {
  const items = Array.isArray(questions) ? questions : [questions];
  return html`<div className="question-list">
    ${items.map((q, i) => {
      const header = typeof q === 'object' && q !== null ? String((q as Record<string, unknown>).header ?? '') : '';
      const text = typeof q === 'object' && q !== null ? String((q as Record<string, unknown>).question ?? '') : String(q);
      const options = Array.isArray((q as Record<string, unknown>)?.options) ? ((q as Record<string, unknown>).options as Record<string, string>[]) : [];
      return html`<div className="question-item" key=${i}>
        ${header ? html`<div className="question-header">${esc(header)}</div>` : null}
        <div className="question-text">${esc(text)}</div>
        ${options.length > 0
          ? html`<div className="question-options">
              ${options.map(
                (o, j) =>
                  html`<button className="question-option" key=${j} disabled title="当前环境自动跳过提问">
                    <span className="opt-label">${esc(o.label ?? '')}</span>
                    ${o.description ? html`<span className="opt-desc">${esc(o.description)}</span>` : null}
                  </button>`,
              )}
            </div>`
          : null}
      </div>`;
    })}
    <div className="question-note">当前非交互式环境，已自动返回默认值继续执行。</div>
  </div>`;
}

const PERM_LABELS: Record<string, string> = {
  'fs.read': '读取文件',
  'fs.write': '写入文件',
  'fs.delete': '删除文件',
  network: '网络访问',
  shell: '执行命令',
  exec: '执行命令',
  spawn: '执行命令',
  'env.read': '读取环境变量',
  kv: '键值存储',
  vault: '凭据保管',
  memory: '记忆读写',
};

const DANGER_PERM = /delete|shell|exec|spawn|network|fs\.write/i;

export function permChip(p: string): ReactElement {
  const danger = DANGER_PERM.test(p);
  const label = PERM_LABELS[p] || p;
  return html`<span
    key=${p}
    className=${'perm' + (danger ? ' danger' : '')}
    title=${esc(p)}
    >${esc(label)}</span
  >`;
}

export function todoView(todos: { status?: string; content?: string }[]): ReactElement {
  return html`<div className="card"
    >${todos.map(
      (t, i) =>
        html`<div className="todo-item" key=${i}>
          <span
            className=${'todo-dot ' + (t.status === 'done' ? 'done' : t.status === 'doing' ? 'doing' : '')}
          ></span
          ><span>${esc(t.content || '')}</span>
        </div>`,
    )}</div
  >`;
}

export function diffView(diff: string): ReactElement {
  return html`<div className="diff"
    >${diff.split('\n').map((line, i) => {
      if (line.startsWith('+')) return html`<span className="add" key=${i}>${esc(line)}</span>`;
      if (line.startsWith('-')) return html`<span className="del" key=${i}>${esc(line)}</span>`;
      return html`<span className="ctx" key=${i}>${esc(line)}</span>`;
    })}</div
  >`;
}

export function detailSummary(
  ev: ThreadEvent,
  p: Record<string, unknown>,
): string {
  switch (ev.type) {
    case 'tool_call': {
      const ks = p.args ? Object.keys(p.args as Record<string, unknown>) : [];
      const name = (p.name as string) || 'tool';
      return (
        name +
        (ks.length ? '(' + ks.slice(0, 3).join(', ') + (ks.length > 3 ? '…' : '') + ')' : '')
      );
    }
    case 'tool_result':
      return (
        (p.ok === true ? '✓ ' : '✗ ') +
        String(
          p.error != null
            ? p.error
            : p.output != null
              ? p.output
              : p.ok
                ? '成功'
                : '失败',
        ).slice(0, 140)
      );
    case 'user':
    case 'assistant':
      return ((p.content as string) || '').slice(0, 180);
    case 'reasoning':
      return '推理轨迹（' + ((p.content as string) || '').length + ' 字）';
    case 'system':
      return (p.content as string) || '';
    case 'plan':
      return '计划（' + (Array.isArray(p.steps) ? p.steps.length : Object.keys(p).length) + ' 项）';
    case 'question':
      return ((p.questions as unknown[]) ? (p.questions as unknown[]).length : 0) + ' 个提问';
    case 'todo':
      return '待办 ' + ((p.todos as unknown[]) || []).length + ' 项';
    case 'turn_diff':
      return '本回合变更（' + ((p.diff as string) || '').split('\n').length + ' 行）';
    default:
      return ev.type + ' 事件';
  }
}

// =====================================================================
// 零依赖 Markdown 渲染器（assistant 回复结构化展示用）。
// 支持：标题（#/##/###）、无序/有序列表、粗体（** / __）、斜体（* / _）、
//       行内代码（`）、代码块（```）、引用（>）。不使用 innerHTML，安全。
// =====================================================================

type MdBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; text: string };

function parseBlocks(src: string): MdBlock[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const fence = line.match(/^```(\w*)/)?.[1] ?? '';
      const start = i + 1;
      let end = start;
      while (end < lines.length && !lines[end].startsWith('```')) end++;
      blocks.push({ type: 'code', lang: fence, text: lines.slice(start, end).join('\n') });
      i = end + 1;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }
    if (line.startsWith('>')) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        items.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: items.join(' ').trim() });
      continue;
    }
    const paras: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '') {
      paras.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', text: paras.join(' ').trim() });
  }
  return blocks;
}

function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let plainStart = 0;

  const flush = (end: number) => {
    if (plainStart < end) {
      out.push(text.slice(plainStart, end));
      plainStart = end;
    }
  };

  while (i < text.length) {
    if (text[i] === '`') {
      const endCode = text.indexOf('`', i + 1);
      if (endCode > i) {
        flush(i);
        out.push(React.createElement('code', { key: `${keyPrefix}-c-${i}` }, text.slice(i + 1, endCode)));
        i = endCode + 1;
        plainStart = i;
        continue;
      }
    }
    if ((text[i] === '*' && text[i + 1] === '*') || (text[i] === '_' && text[i + 1] === '_')) {
      const marker = text[i] === '*' ? '**' : '__';
      const endBold = text.indexOf(marker, i + 2);
      if (endBold > i) {
        flush(i);
        out.push(
          React.createElement(
            'strong',
            { key: `${keyPrefix}-b-${i}` },
            ...parseInline(text.slice(i + 2, endBold), `${keyPrefix}-ib-${i}`),
          ),
        );
        i = endBold + 2;
        plainStart = i;
        continue;
      }
    }
    if (text[i] === '*' || text[i] === '_') {
      const marker = text[i];
      const endItalic = text.indexOf(marker, i + 1);
      if (endItalic > i) {
        flush(i);
        out.push(
          React.createElement(
            'em',
            { key: `${keyPrefix}-i-${i}` },
            ...parseInline(text.slice(i + 1, endItalic), `${keyPrefix}-ii-${i}`),
          ),
        );
        i = endItalic + 1;
        plainStart = i;
        continue;
      }
    }
    if (text[i] === '[') {
      const endLabel = text.indexOf(']', i + 1);
      const endUrl = text.indexOf(')', endLabel + 1);
      if (endLabel > i && endLabel + 1 < text.length && text[endLabel + 1] === '(' && endUrl > endLabel) {
        flush(i);
        const label = text.slice(i + 1, endLabel);
        const url = text.slice(endLabel + 2, endUrl);
        out.push(
          React.createElement(
            'a',
            {
              key: `${keyPrefix}-a-${i}`,
              href: url,
              'data-file-path': url,
              className: 'md-link',
            },
            ...parseInline(label, `${keyPrefix}-al-${i}`),
          ),
        );
        i = endUrl + 1;
        plainStart = i;
        continue;
      }
    }
    i++;
  }
  flush(i);
  return out;
}

function mdHeadingTag(level: number): 'h3' | 'h4' | 'h5' {
  return level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5';
}

function renderBlock(b: MdBlock, idx: number): ReactElement {
  const key = `b-${idx}`;
  switch (b.type) {
    case 'heading': {
      const Tag = mdHeadingTag(b.level);
      return React.createElement(Tag, { key, className: `md-h${b.level}` }, ...parseInline(b.text, key));
    }
    case 'paragraph':
      return React.createElement('p', { key, className: 'md-p' }, ...parseInline(b.text, key));
    case 'ul':
      return React.createElement(
        'ul',
        { key, className: 'md-ul' },
        ...b.items.map((item, li) =>
          React.createElement('li', { key: `${key}-li-${li}` }, ...parseInline(item, `${key}-li-${li}`)),
        ),
      );
    case 'ol':
      return React.createElement(
        'ol',
        { key, className: 'md-ol' },
        ...b.items.map((item, li) =>
          React.createElement('li', { key: `${key}-li-${li}` }, ...parseInline(item, `${key}-li-${li}`)),
        ),
      );
    case 'code':
      return React.createElement(
        'pre',
        { key, className: 'md-pre' },
        React.createElement(
          'code',
          { key: `${key}-code`, className: b.lang ? `lang-${b.lang}` : '' },
          b.text,
        ),
      );
    case 'quote':
      return React.createElement('blockquote', { key, className: 'md-quote' }, ...parseInline(b.text, key));
    default:
      return html`<div key=${key}></div>`;
  }
}

export function renderMarkdown(src: string): ReactElement {
  const blocks = parseBlocks(src || '');
  if (blocks.length === 0) return html`<div className="md-content md-empty" spellCheck="false"></div>`;
  return React.createElement('div', { className: 'md-content', key: 'md', spellCheck: 'false' }, ...blocks.map((b, i) => renderBlock(b, i)));
}
