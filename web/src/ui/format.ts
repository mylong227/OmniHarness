// 纯函数工具层：vanilla 版中散落的字符串拼接与 innerHTML 注入，统一改写为返回 React 元素的纯函数。
// 组件层调用这些函数，既保持视觉一致（复用同一套 CSS class），又避免直接操作 DOM。

import { React } from './deps.js';
import { markdownRender, markdownLibsReady, handleCodeblockCopyClick } from './markdown.js';
import type { ThreadEvent } from '../types/models.js';

/**
 * HTML 转义：把 `& < > " '` 五个字符转成实体，供纯文本安全地放进元素子节点。
 * @param s 任意待转义值（非字符串先经 String() 归一化）。
 * @returns 转义后的字符串。
 */
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

/**
 * 事件类型徽标：命中 `BADGE_MAP` 时用「中文标签 + 专属类」，未命中回退 `b-system`。
 * @param type 事件类型字符串（如 `tool_call`）。
 * @returns 徽标元素。
 */
export function badge(type: string): ReactElement {
  const m = BADGE_MAP[type] ?? [type, 'b-system'];
  return React.createElement('span', { className: 'badge ' + m[1] }, m[0]);
}

/**
 * 时间戳转本地时间字符串；缺失或非法时间戳一律返回空串（不抛错）。
 * @param ts 毫秒时间戳，可空。
 * @returns `toLocaleTimeString()` 结果，或空串。
 */
export function timeOf(ts?: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return '';
  }
}

/**
 * 空状态插画占位（图标 + 主文案 + 副提示）。
 * @param icon 图标字符或短文本。
 * @param text 主文案。
 * @param hint 副提示文案。
 * @returns 空状态元素。
 */
export function emptyState(icon: string, text: string, hint: string): ReactElement {
  return React.createElement(
    'div',
    { className: 'empty illu' },
    React.createElement('div', { className: 'illu-icon' }, icon),
    React.createElement('div', { className: 'illu-text' }, text),
    React.createElement('div', { className: 'illu-hint' }, hint),
  );
}

/**
 * 把任意值序列化为缩进 JSON，渲染进 `<pre class="json">`（内容已转义）。
 * @param obj 待展示的任意值（对象 / 数组 / 原始值均可）。
 * @returns 只读的 JSON 预览元素。
 */
export function jsonView(obj: unknown): ReactElement {
  return React.createElement('pre', { className: 'json' }, esc(JSON.stringify(obj, null, 2)));
}

/**
 * 模型向用户提问的只读渲染（当前环境自动返回默认值，UI 先展示问题内容）。
 * @param questions 提问数组，或单个提问对象 / 字符串。
 * @returns 提问清单元素，选项按钮恒为 disabled（非交互式环境）。
 */
export function questionView(questions: unknown): ReactElement {
  const items = Array.isArray(questions) ? questions : [questions];
  // 选项列表：key 由外层传入前缀，避免同层兄弟节点 key 冲突。
  const optionList = (options: Record<string, string>[], keyPrefix: string): ReactElement =>
    React.createElement(
      'div',
      { className: 'question-options' },
      ...options.map((o, j) =>
        React.createElement(
          'button',
          {
            key: `${keyPrefix}-o-${j}`,
            className: 'question-option',
            disabled: true,
            title: '当前环境自动跳过提问',
          },
          React.createElement('span', { className: 'opt-label' }, esc(o.label ?? '')),
          o.description ? React.createElement('span', { className: 'opt-desc' }, esc(o.description)) : null,
        ),
      ),
    );
  return React.createElement(
    'div',
    { className: 'question-list' },
    ...items.map((q, i) => {
      const rec = typeof q === 'object' && q !== null ? (q as Record<string, unknown>) : null;
      const header = rec ? String(rec.header ?? '') : '';
      const text = rec ? String(rec.question ?? '') : String(q);
      const rawOptions: unknown = rec ? rec.options : undefined;
      const options = Array.isArray(rawOptions) ? (rawOptions as Record<string, string>[]) : [];
      const key = `q-${i}`;
      return React.createElement(
        'div',
        { key, className: 'question-item' },
        header ? React.createElement('div', { className: 'question-header' }, esc(header)) : null,
        React.createElement('div', { className: 'question-text' }, esc(text)),
        options.length > 0 ? optionList(options, key) : null,
      );
    }),
    React.createElement('div', { className: 'question-note' }, '当前非交互式环境，已自动返回默认值继续执行。'),
  );
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

/**
 * 把权限标识渲染为一枚 chip；命中危险权限正则时追加 `danger` 高亮。
 * @param p 权限标识（如 `fs.write` / `shell`）。
 * @returns 权限 chip 元素。
 */
export function permChip(p: string): ReactElement {
  const danger = DANGER_PERM.test(p);
  const label = PERM_LABELS[p] || p;
  return React.createElement(
    'span',
    { key: p, className: 'perm' + (danger ? ' danger' : ''), title: esc(p) },
    esc(label),
  );
}

/**
 * 待办清单渲染：按状态给圆点上 `done` / `doing` 修饰类。
 *
 * 状态词表**必须与生产者一致**（2026-09-26 审计 F8）：生产者
 * （`ports/runtime/todo.ts` 的 `TodoStatus`）只发 `pending | in_progress | completed`，
 * 而渲染器原先只认 `done` / `doing` ⇒ 所有圆点恒为中性灰，每个待办的进度在 UI 上不可见。
 * 两种词表都接受（兼容历史事件），语义映射：completed→done、in_progress→doing。
 * @param todos 待办项数组，每项含可选 status 与 content。
 * @returns 待办卡片元素。
 */
export function todoView(todos: { status?: string; content?: string }[]): ReactElement {
  const dotClass = (status?: string): string => {
    if (status === 'completed' || status === 'done') return 'todo-dot done';
    if (status === 'in_progress' || status === 'doing') return 'todo-dot doing';
    return 'todo-dot ';
  };
  return React.createElement(
    'div',
    { className: 'card' },
    ...todos.map((t, i) =>
      React.createElement(
        'div',
        { key: `todo-${i}`, className: 'todo-item' },
        React.createElement('span', { className: dotClass(t.status) }),
        React.createElement('span', null, esc(t.content || '')),
      ),
    ),
  );
}

/**
 * 统一 diff 文本逐行染色：新增行 `add`、删除行 `del`、其余 `ctx`。
 * @param diff 原始 unified diff 文本。
 * @returns 差异行列表元素。
 */
export function diffView(diff: string): ReactElement {
  const lineClass = (line: string): string => {
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'del';
    return 'ctx';
  };
  return React.createElement(
    'div',
    { className: 'diff' },
    ...diff
      .split('\n')
      .map((line, i) => React.createElement('span', { key: `dl-${i}`, className: lineClass(line) }, esc(line))),
  );
}

/**
 * 事件在折叠态的一行摘要（纯字符串，供列表标题使用）。
 * @param ev 线程事件。
 * @param p 事件 payload。
 * @returns 摘要文本，按事件类型分别截断。
 */
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
  | { type: 'quote'; text: string }
  | { type: 'table'; header: string[]; rows: string[][] };

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
    // 表格：以 `|` 开头，下一行是纯分隔行（`|---|` / `|:--|`），收集到空行为止（#OBS-15）。
    const sepRow = i + 1 < lines.length ? lines[i + 1]!.trim() : '';
    // 分隔行：去掉可选首尾管道后 split('|')，每一段都只含 `-` 与可选 `:` 对齐符。
    const isSep = ((): boolean => {
      if (!sepRow.includes('-')) return false;
      const inner = sepRow.replace(/^\|/, '').replace(/\|$/, '');
      const cells = inner.split('|');
      return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
    })();
    if (line.trim().startsWith('|') && isSep) {
      const splitRow = (s: string): string[] =>
        s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2; // 跳过表头行与分隔行
      while (i < lines.length && lines[i].trim() !== '') {
        if (lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i]));
        i++;
      }
      if (header.length > 0) blocks.push({ type: 'table', header, rows });
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

/**
 * 行内 Markdown 解析：反引号代码、`**`/`__` 粗体、`*`/`_` 斜体、`[x](url)` 链接。
 * @param text 行内文本。
 * @param keyPrefix 生成 React key 的前缀，保证同层唯一。
 * @returns React 子节点数组（纯文本段与元素交替）。
 */
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

/**
 * Markdown 标题层级映射：为避免与页面 h1/h2 抢语义，整体下移两级（h1→h3）。
 * @param level 源码中的 `#` 个数（1–6）。
 * @returns 实际渲染使用的标签名。
 */
function mdHeadingTag(level: number): 'h3' | 'h4' | 'h5' {
  if (level === 1) return 'h3';
  if (level === 2) return 'h4';
  return 'h5';
}

/**
 * 单个 Markdown 块渲染为 React 元素。
 * @param b 解析后的块。
 * @param idx 块序号，用于生成稳定 key。
 * @returns 该块对应的元素。
 */
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
    case 'code': {
      const langLabel = b.lang ? b.lang : 'text';
      const bar = React.createElement(
        'div',
        { key: `${key}-bar`, className: 'md-codeblock__bar' },
        React.createElement('span', { key: `${key}-lang`, className: 'md-codeblock__lang' }, langLabel),
        React.createElement(
          'button',
          { key: `${key}-copy`, type: 'button', className: 'md-codeblock__copy' },
          '复制',
        ),
      );
      const pre = React.createElement(
        'pre',
        { key, className: 'md-pre' },
        React.createElement(
          'code',
          { key: `${key}-code`, className: b.lang ? `lang-${b.lang}` : '' },
          b.text,
        ),
      );
      return React.createElement('div', { key, className: 'md-codeblock' }, bar, pre);
    }
    case 'quote':
      return React.createElement('blockquote', { key, className: 'md-quote' }, ...parseInline(b.text, key));
    case 'table':
      return React.createElement(
        'table',
        { key, className: 'md-table' },
        React.createElement(
          'thead',
          { key: `${key}-head` },
          React.createElement(
            'tr',
            { key: `${key}-head-tr` },
            ...b.header.map((h, ci) =>
              React.createElement('th', { key: `${key}-th-${ci}` }, ...parseInline(h, `${key}-th-${ci}`)),
            ),
          ),
        ),
        React.createElement(
          'tbody',
          { key: `${key}-body` },
          ...b.rows.map((row, ri) =>
            React.createElement(
              'tr',
              { key: `${key}-tr-${ri}` },
              ...row.map((cell, ci) =>
                React.createElement('td', { key: `${key}-td-${ri}-${ci}` }, ...parseInline(cell, `${key}-td-${ri}-${ci}`)),
              ),
            ),
          ),
        ),
      );
    default:
      return React.createElement('div', { key });
  }
}

/**
 * 把 Markdown 源码渲染为结构化元素（零依赖解析器，不使用 innerHTML）。
 * @param src Markdown 源码，空串或空内容时返回 `md-empty` 占位。
 * @returns Markdown 渲染结果元素。
 */
/**
 * 手写零依赖 Markdown 渲染器（回落实现）。
 * 仅在成熟依赖（markdown-it / KaTeX / highlight.js）未就绪时使用，保证无回归与离线可用。
 * @param src Markdown 源码。
 * @returns 渲染结果元素（结构化 React 元素，不使用 innerHTML）。
 */
export function legacyRenderMarkdown(src: string): ReactElement {
  const blocks = parseBlocks(src || '');
  if (blocks.length === 0) {
    return React.createElement('div', {
      className: 'md-content md-empty',
      spellCheck: 'false',
      onClick: handleCodeblockCopyClick,
    });
  }
  return React.createElement(
    'div',
    { className: 'md-content', key: 'md', spellCheck: 'false', onClick: handleCodeblockCopyClick },
    ...blocks.map((b, i) => renderBlock(b, i)),
  );
}

/**
 * Markdown 渲染统一入口：成熟依赖就绪时走 markdown.ts 的 markdown-it + KaTeX + highlight.js 管线
 * （数学公式、代码高亮、GFM 表格/任务列表等），否则回落到手写实现。
 * @param src Markdown 源码。
 * @returns 渲染结果元素。
 */
export function renderMarkdown(src: string): ReactElement {
  if (markdownLibsReady()) return markdownRender(src);
  return legacyRenderMarkdown(src);
}
