// 轻量语法高亮（零依赖，本地内置）：把源码文本按 token 切成带 class 的 span，
// 供右侧文件面板做「编辑器式」分色预览。工程零网络依赖，不引 highlight.js，
// 只覆盖常见语言（js/ts/json/md/css/html/shell/python/yaml），未识别语言退化为纯文本。
// 安全：始终先 esc() 再包 span，绝不直接注入原文（与项目「不用 innerHTML」铁律一致）。

import { html, React } from './deps.js';

type Tok =
  | { t: 'comment'; v: string }
  | { t: 'string'; v: string }
  | { t: 'kw'; v: string }
  | { t: 'num'; v: string }
  | { t: 'fn'; v: string }
  | { t: 'type'; v: string }
  | { t: 'prop'; v: string }
  | { t: 'punct'; v: string }
  | { t: 'plain'; v: string };

const LANG_CLASS: Record<string, string> = {
  '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js', '.ts': 'ts', '.tsx': 'tsx',
  '.json': 'json', '.jsonc': 'json', '.md': 'md', '.markdown': 'md',
  '.css': 'css', '.scss': 'css', '.html': 'html', '.htm': 'html',
  '.sh': 'sh', '.bash': 'sh', '.py': 'py', '.yaml': 'yaml', '.yml': 'yaml',
  '.rs': 'rs', '.go': 'go', '.sql': 'sql', '.java': 'java',
};

/** 从文件路径 / 文件名提取语言 class；未知回退空串（纯文本）。 */
export function langOf(nameOrPath: string): string {
  const base = nameOrPath.toLowerCase().split('?')[0]!;
  // 取最后一段，剥掉前导路径分隔符
  const name = base.slice(base.lastIndexOf('/') + 1).slice(base.lastIndexOf('\\') + 1);
  for (const [ext, l] of Object.entries(LANG_CLASS)) {
    if (name.endsWith(ext)) return l;
  }
  return '';
}

/** 语言敏感的分词规则：对 JS/TS/JSON/Java/C/Rust/Go/SQL 等 C 系语言生效。 */
const CJ_KW = new Set([
  'const','let','var','function','return','if','else','for','while','do','switch','case','break','continue',
  'new','class','extends','super','import','export','from','default','async','await','try','catch','finally','throw',
  'typeof','instanceof','in','of','void','delete','this','null','undefined','true','false','interface','type',
  'enum','public','private','protected','static','readonly','abstract','implements','as','namespace','declare',
  'get','set','yield','int','float','double','bool','boolean','string','char','void','long','short','byte',
  'struct','union','typedef','fn','pub','use','mod','let','mut','impl','trait','package','select','from','where',
  'group','by','order','having','join','on','insert','into','values','update','set','delete','create','table',
  'def','class','lambda','pass','with','elif','global','nonlocal','is','not','and','or',
]);
const CJ_TYPE_WORDS = new Set([
  'string','number','boolean','object','Array','Promise','Map','Set','Record','Partial','Pick','Omit',
  'unknown','any','never','void','bigint','symbol','Error','Date','RegExp','Function','Buffer','console',
]);
// 关键字优先整体匹配，避免误把 key 里的 "type" 当关键字。
const KW_RE = /[A-Za-z_$][\w$]*/;

/**
 * 单 token 分类。c 语言 type（js/ts/json/rs/go/java/sql/py）。
 */
function classify(word: string, lang: string): Tok['t'] {
  if (CJ_KW.has(word)) return 'kw';
  if (CJ_TYPE_WORDS.has(word) && lang !== 'py') return 'type';
  return 'plain';
}

/** 把一段源码切成 token 序列。lang 是小写 id（'js'|'ts'|...）。 */
function tokenize(src: string, lang: string): Tok[] {
  if (lang === 'md') return tokenizeMarkdown(src);
  if (lang === 'css' || lang === 'scss') return tokenizeCss(src);
  if (lang === 'html') return tokenizeHtml(src);
  // 默认走 C 系通用
  const out: Tok[] = [];
  const buf: string[] = [];
  const flushPlain = (): void => {
    if (buf.length) {
      out.push({ t: 'plain', v: buf.join('') });
      buf.length = 0;
    }
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    // 行注释
    if (ch === '/' && src[i + 1] === '/') {
      flushPlain();
      const e = src.indexOf('\n', i);
      const end = e === -1 ? n : e;
      out.push({ t: 'comment', v: src.slice(i, end) });
      i = end;
      continue;
    }
    // 块注释
    if (ch === '/' && src[i + 1] === '*') {
      flushPlain();
      const e = src.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      out.push({ t: 'comment', v: src.slice(i, end) });
      i = end;
      continue;
    }
    // 字符串 / 模板串（含单双反引号）
    if (ch === '"' || ch === "'" || ch === '`') {
      flushPlain();
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        const c = src[j]!;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === quote) {
          j++;
          break;
        }
        j++;
      }
      out.push({ t: 'string', v: src.slice(i, j) });
      i = j;
      continue;
    }
    // 数字
    if (/[0-9]/.test(ch)) {
      flushPlain();
      const m = /^\d[\w.]*/.exec(src.slice(i));
      const word = m ? m[0] : ch;
      out.push({ t: 'num', v: word });
      i += word.length;
      continue;
    }
    // 标识符
    if (/[A-Za-z_$]/.test(ch)) {
      flushPlain();
      const m = KW_RE.exec(src.slice(i));
      const word = m ? m[0] : ch;
      const k = classify(word, lang);
      // 函数名启发：后随 '('
      let finalK: Tok['t'] = k;
      const after = src[i + word.length];
      if ((k === 'plain' || k === 'type') && after === '(' && /[a-z_$]/.test(word[0]!)) {
        finalK = 'fn';
      }
      out.push({ t: finalK, v: word });
      i += word.length;
      continue;
    }
    buf.push(ch);
    i++;
  }
  flushPlain();
  return out;
}

// Markdown：标题(#)、粗体(**)、行内码(`)、链接、列表标记浅分类（主要保可读性，不强求全 token）。
function tokenizeMarkdown(src: string): Tok[] {
  const out: Tok[] = [];
  for (const line of src.split('\n')) {
    const m = /^(\s*)(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/.exec(line);
    if (m) {
      out.push({ t: 'kw', v: m[1]! + m[2]! });
      out.push({ t: 'plain', v: line.slice(m[0].length) });
    } else if (/^```/.test(line.trim())) {
      out.push({ t: 'comment', v: line });
    } else if (/^---+$/.test(line.trim()) || /^===+$/.test(line.trim())) {
      out.push({ t: 'comment', v: line });
    } else {
      // 行内高亮：`` `code` ``
      const parts = splitInline(line);
      for (const [txt, isCode] of parts) {
        out.push(isCode ? { t: 'string', v: txt } : { t: 'plain', v: txt });
      }
    }
    out.push({ t: 'plain', v: '\n' });
  }
  return out;
}

function splitInline(line: string): Array<[string, boolean]> {
  const parts: Array<[string, boolean]> = [];
  let cur = '';
  let inCode = false;
  for (const ch of line) {
    if (ch === '`') {
      if (cur !== '') {
        parts.push([cur, inCode]);
        cur = '';
      }
      inCode = !inCode;
      continue;
    }
    cur += ch;
  }
  if (cur !== '') parts.push([cur, inCode]);
  return parts;
}

// CSS：注释、字符串、选择器里的类/ID、属性和值基本可用。
function tokenizeCss(src: string): Tok[] {
  const out: Tok[] = [];
  const buf: string[] = [];
  const flush = (): void => {
    if (buf.length) {
      out.push({ t: 'plain', v: buf.join('') });
      buf.length = 0;
    }
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (ch === '/' && src[i + 1] === '*') {
      flush();
      const e = src.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      out.push({ t: 'comment', v: src.slice(i, end) });
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      flush();
      let j = i + 1;
      while (j < n && src[j] !== ch) j++;
      out.push({ t: 'string', v: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (ch === '#') {
      flush();
      const m = /^#[0-9a-fA-F]{3,8}\b|^#[A-Za-z_][\w-]*/.exec(src.slice(i));
      out.push({ t: 'num', v: m ? m[0] : ch });
      i += m ? m[0].length : 1;
      continue;
    }
    if (ch === '.') {
      flush();
      const m = /^\.[A-Za-z_][\w-]*/.exec(src.slice(i));
      out.push({ t: 'type', v: m ? m[0] : ch });
      i += m ? m[0].length : 1;
      continue;
    }
    if (/[A-Za-z-]/.test(ch)) {
      flush();
      const m = /^[A-Za-z-]+/.exec(src.slice(i));
      const word = m ? m[0] : ch;
      // 属性名冒号前 or 值是关键字
      let j = i + word.length;
      while (j < n && src[j] === ' ') j++;
      if (src[j] === ':') {
        out.push({ t: 'prop', v: word });
      } else {
        out.push({ t: 'kw', v: word }); // 值里的关键词
      }
      i += word.length;
      continue;
    }
    buf.push(ch);
    i++;
  }
  flush();
  return out;
}

// HTML：标签名 + 属性 + 引号字符串 + 注释。
function tokenizeHtml(src: string): Tok[] {
  const out: Tok[] = [];
  const buf: string[] = [];
  const flush = (): void => {
    if (buf.length) {
      out.push({ t: 'plain', v: buf.join('') });
      buf.length = 0;
    }
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (ch === '<' && src[i + 1] === '!') {
      flush();
      const e = src.indexOf('>', i);
      const end = e === -1 ? n : e + 1;
      out.push({ t: 'comment', v: src.slice(i, end) });
      i = end;
      continue;
    }
    if (ch === '<') {
      flush();
      const m = /^<\/?[A-Za-z][\w-]*/.exec(src.slice(i));
      const tag = m ? m[0] : '<';
      out.push({ t: 'kw', v: tag });
      i += tag.length;
      continue;
    }
    if (ch === '>' || ch === '/' || ch === '=') {
      flush();
      out.push({ t: 'punct', v: ch });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      flush();
      let j = i + 1;
      while (j < n && src[j] !== ch) j++;
      out.push({ t: 'string', v: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      flush();
      const m = /^[A-Za-z_:][\w:-]*/.exec(src.slice(i));
      const word = m ? m[0] : ch;
      out.push({ t: 'prop', v: word });
      i += word.length;
      continue;
    }
    buf.push(ch);
    i++;
  }
  flush();
  return out;
}

const CLS: Record<Tok['t'], string> = {
  comment: 'tok-cmt',
  string: 'tok-str',
  kw: 'tok-kw',
  num: 'tok-num',
  fn: 'tok-fn',
  type: 'tok-typ',
  prop: 'tok-prop',
  punct: 'tok-pun',
  plain: 'tok-pln',
};

/**
 * 把源码渲染成带高亮的 <pre><code>。lang 小写（js/ts/...）。空返回 null。
 * 安全：每个 token 都经过 esc() 转义后才放进 span。
 */
export function highlightCode(src: string, lang: string): ReactElement | null {
  const text = src ?? '';
  if (text === '') return null;
  const toks = tokenize(text, lang);
  const spans = toks.map((tk, idx) => {
    const cls = CLS[tk.t];
    if (tk.t === 'plain' && tk.v === '\n') {
      return html`<span key=${idx}>\n</span>`;
    }
    return html`<span className=${cls} key=${idx}>${tk.v}</span>`;
  });
  return html`<pre className=${'hl-code' + (lang ? ' hl-' + lang : '')} spellCheck="false"><code>${spans}</code></pre>`;
}
