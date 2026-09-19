// 成熟依赖加持的 Markdown 渲染器（回复模式 / 会话模式核心展示层）。
//
// 设计取舍（回应「不要求零依赖，善用成熟知识代替从零造轮子」）：
//   - 解析交给 markdown-it（与 deepseek-harness 的 micromark 同代成熟方案），
//     取代 format.ts 里手写、易踩坑的零依赖解析器；
//   - 行内/块级数学交给 KaTeX（deepseek-harness 亦用 KaTeX）；
//   - 代码高亮交给 highlight.js（deepseek-harness 用 Shiki，这里用零构建步骤、
//     离线可用的 highlight.js，效果同级且更轻）。
//
// 安全：markdown-it 以 `html:false` 运行——用户原始 HTML 一律被转义，仅以下产出为受信任 HTML：
//   - KaTeX.renderToString 的结果（我们自己生成的数学排版）；
//   - highlight.js 的结果（先转义源码再包 span，绝不注入用户输入）。
//   => 整体不弱于原「零 innerHTML」安全姿态（用户内容仍不可注入）。
//
// 渐进迁移：若三个 UMD 全局未就绪（如单测桩环境），`renderMarkdown` 回落到 format.ts 的
// 手写实现，保证旧契约测试与无依赖部署继续可用。

import { React } from './deps.js';
import { ClipboardCopier } from './models/ClipboardCopier.js';

/** markdown-it 单条 token 的最小接口（避免引入 any / 第三方类型）。 */
interface MdToken {
  content: string;
  markup: string;
  info: string;
  block?: boolean;
  map?: number[];
  attrGet(name: string): string | null;
  attrSet(name: string, value: string): void;
}

/** markdown-it 行内状态的最小接口。 */
interface MdInlineState {
  src: string;
  pos: number;
  push(name: string, type: string, nesting: number): MdToken;
}

/** markdown-it 块状态的最小接口。 */
interface MdBlockState {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  blkIndent: number;
  line: number;
  getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string;
  push(name: string, type: string, nesting: number): MdToken;
}

/** markdown-it 渲染器 self 的最小接口（用于回退默认规则）。 */
interface MdSelf {
  renderToken(tokens: MdToken[], idx: number, options: unknown): string;
}

/** markdown-it 渲染规则签名（用于回退默认 fence 规则）。 */
type MdRenderRule = (
  tokens: MdToken[],
  idx: number,
  options: unknown,
  env: unknown,
  self: MdSelf,
) => string;

/** markdown-it 构造器与实例的最小接口（避免引入 any / 第三方类型）。 */
interface MarkdownItInstance {
  render(src: string): string;
  set(options: Record<string, unknown>): MarkdownItInstance;
  use(plugin: unknown, ...args: unknown[]): MarkdownItInstance;
  utils: { escapeHtml(s: string): string };
  inline: { ruler: { after(before: string, name: string, fn: unknown): void } };
  block: { ruler: { before(before: string, name: string, fn: unknown, opts?: unknown): void } };
  renderer: { rules: Record<string, unknown> };
}

interface KatexApi {
  renderToString(tex: string, options?: Record<string, unknown>): string;
}

interface HljsApi {
  getLanguage(name: string): unknown;
  highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
  highlightAuto(code: string): { value: string };
}

interface VendorGlobals {
  markdownit?: () => MarkdownItInstance;
  katex?: KatexApi;
  hljs?: HljsApi;
}

/** 读取已注入的 UMD 全局（index.html 按序加载 markdown-it / katex / highlight.js）。 */
function vendor(): VendorGlobals {
  const w = (typeof window !== 'undefined' ? window : ({} as Record<string, never>)) as unknown as VendorGlobals;
  return w;
}

/**
 * 三个成熟依赖是否全部就绪。缺任一则回落到手写渲染器，保证无回归。
 * @returns 是否可启用 markdown-it + KaTeX + highlight.js 管线。
 */
export function markdownLibsReady(): boolean {
  const v = vendor();
  return Boolean(v.markdownit) && Boolean(v.katex) && Boolean(v.hljs);
}

/**
 * 代码块「一键复制」的事件委托处理：挂在 md-content 容器上，点击命中
 * `.md-codeblock__copy` 按钮时，取出同块 `<pre><code>` 文本经 ClipboardCopier 写入剪贴板，
 * 并给按钮一个短暂的「已复制」反馈。命中其它元素则静默跳过（与文件链接点击委托互不干扰）。
 * @param e 冒泡到此容器的点击事件。
 */
export function handleCodeblockCopyClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const btn = target.closest('.md-codeblock__copy') as HTMLButtonElement | null;
  if (!btn) return;
  const block = btn.closest('.md-codeblock');
  const codeEl = block ? (block.querySelector('pre code') ?? block.querySelector('pre')) : null;
  const text = codeEl?.textContent ?? '';
  void ClipboardCopier.copy(text);
  const original = btn.textContent ?? '复制';
  btn.textContent = '已复制';
  btn.classList.add('md-codeblock__copy--done');
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('md-codeblock__copy--done');
  }, 1400);
}

/** 模块级单例缓存：首次用到时才构造（避免单测桩里访问未定义全局）。 */
let mdCache: MarkdownItInstance | null = null;

/** 构造并缓存配置好的 markdown-it 实例（含数学插件与代码高亮）。 */
function getMd(): MarkdownItInstance {
  const v = vendor();
  if (mdCache !== null) return mdCache;
  const md = (v.markdownit as NonNullable<VendorGlobals['markdownit']>)();

  // 代码高亮：优先按语言高亮，未知语言走自动识别。输出受信任（hljs 先转义后加色）。
  md.set({
    highlight: (str: string, lang: string): string => {
      const hljs = v.hljs as NonNullable<VendorGlobals['hljs']>;
      const esc = (s: string): string => md.utils.escapeHtml(s);
      try {
        if (lang && hljs.getLanguage(lang)) {
          const out = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
          return '<pre class="hljs"><code>' + out + '</code></pre>';
        }
        const auto = hljs.highlightAuto(str).value;
        return '<pre class="hljs"><code>' + auto + '</code></pre>';
      } catch {
        return '<pre class="hljs"><code>' + esc(str) + '</code></pre>';
      }
    },
  });

  // ---- 行内数学：$...$（避免与货币 $5 / 5$ 误匹配） ----
  md.inline.ruler.after(
    'escape',
    'math_inline',
    (state: MdInlineState, silent: boolean): boolean => {
      const src = state.src;
      const start = state.pos;
      if (src[start] !== '$') return false;
      const prevChar = start > 0 ? (src[start - 1] ?? '') : ' ';
      if (/\d/.test(prevChar)) return false;
      const end = src.indexOf('$', start + 1);
      if (end === -1) return false;
      const nextChar = src[end + 1] ?? '';
      if (/\d/.test(nextChar)) return false;
      const content = src.slice(start + 1, end);
      if (content.length === 0) return false;
      if (!silent) {
        const token = state.push('math_inline', 'math', 0);
        token.content = content;
        token.markup = '$';
      }
      state.pos = end + 1;
      return true;
    },
  );

  // ---- 块级数学：$$...$$ 独立成块 ----
  md.block.ruler.before(
    'fence',
    'math_block',
    (state: MdBlockState, begLine: number, endLine: number, silent: boolean): boolean => {
      const src = state.src;
      const pos = (state.bMarks[begLine] ?? 0) + (state.tShift[begLine] ?? 0);
      const max = state.eMarks[begLine] ?? 0;
      if (pos + 1 > max || src.slice(pos, pos + 2) !== '$$') return false;
      let found = false;
      let last = begLine;
      for (let i = begLine + 1; i < endLine; i++) {
        const p = (state.bMarks[i] ?? 0) + (state.tShift[i] ?? 0);
        if (src.slice(p, p + 2) === '$$') {
          found = true;
          last = i;
          break;
        }
      }
      if (!found) return false;
      if (!silent) {
        const content = state.getLines(begLine + 1, last, state.blkIndent, false);
        const token = state.push('math_block', 'math', 0);
        token.block = true;
        token.content = content;
        token.map = [begLine, last + 1];
        token.markup = '$$';
      }
      state.line = last + 1;
      return true;
    },
    { alt: [] } as unknown,
  );

  const katex = v.katex as NonNullable<VendorGlobals['katex']>;

  // ---- 渲染：数学交 KaTeX ----
  md.renderer.rules.math_inline = (tokens: MdToken[], idx: number): string => {
    const token = tokens[idx];
    if (!token) return '';
    try {
      return katex.renderToString(token.content, { displayMode: false, throwOnError: false });
    } catch {
      return md.utils.escapeHtml(token.content);
    }
  };
  md.renderer.rules.math_block = (tokens: MdToken[], idx: number): string => {
    const token = tokens[idx];
    if (!token) return '';
    try {
      const html = katex.renderToString(token.content, { displayMode: true, throwOnError: false });
      return '<div class="md-math-block">' + html + '</div>';
    } catch {
      return '<pre>' + md.utils.escapeHtml(token.content) + '</pre>';
    }
  };

  // ---- 链接按「文件路径 / 外链」分流（保留右侧面板开文件体验） ----
  const defaultLinkOpen = (md.renderer.rules.link_open ??
    ((tokens: MdToken[], idx: number, opts: unknown, _env: unknown, self: MdSelf): string =>
      self.renderToken(tokens, idx, opts))) as (
    tokens: MdToken[],
    idx: number,
    opts: unknown,
    env: unknown,
    self: MdSelf,
  ) => string;

  md.renderer.rules.link_open = (
    tokens: MdToken[],
    idx: number,
    opts: unknown,
    env: unknown,
    self: MdSelf,
  ): string => {
    const token = tokens[idx];
    if (!token) return '';
    const href = token.attrGet('href') ?? '';
    const isExternal = /^https?:\/\//i.test(href);
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(href);
    const isFilePath = !hasScheme || /^file:/i.test(href);
    if (isFilePath && !isExternal) {
      // 去掉 file:// 前缀，挂 data-file-path，由 AssistantCard 的点击委托拦截并在右侧面板打开。
      token.attrSet('data-file-path', href.replace(/^file:\/\//i, ''));
    }
    if (isExternal) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    }
    return defaultLinkOpen(tokens, idx, opts, env, self);
  };

  // ---- 代码块包工具条：语言标签 + 一键复制（对标 deepseek-harness 回复观感） ----
  const defaultFence = (md.renderer.rules.fence ??
    ((tokens: MdToken[], idx: number, opts: unknown, env: unknown, self: MdSelf): string =>
      self.renderToken(tokens, idx, opts))) as MdRenderRule;

  md.renderer.rules.fence = (
    tokens: MdToken[],
    idx: number,
    opts: unknown,
    env: unknown,
    self: MdSelf,
  ): string => {
    const token = tokens[idx];
    if (!token) return '';
    const info = (token.info ?? '').trim();
    const langName = info.split(/\s+/u)[0] ?? '';
    // 语言名来自围栏信息串，属用户输入——防注入先转义；未标注语言统一显示 text。
    const langLabel = langName ? md.utils.escapeHtml(langName) : 'text';
    const inner = defaultFence(tokens, idx, opts, env, self);
    return (
      '<div class="md-codeblock">' +
      '<div class="md-codeblock__bar">' +
      '<span class="md-codeblock__lang">' + langLabel + '</span>' +
      '<button type="button" class="md-codeblock__copy">复制</button>' +
      '</div>' +
      inner +
      '</div>'
    );
  };

  mdCache = md;
  return md;
}

/**
 * 用成熟依赖管线渲染 Markdown 为受信任 HTML 并包进一个 React 容器。
 * 仅在 `markdownLibsReady()` 为真时调用；否则由 format.ts 回落到手写实现。
 * @param src Markdown 源码。
 * @returns 渲染结果元素（md-content 容器，内部用 dangerouslySetInnerHTML 注入受信任 HTML）。
 */
export function markdownRender(src: string): ReactElement {
  const text = src ?? '';
  if (text.trim() === '') {
    return React.createElement('div', {
      className: 'md-content md-empty',
      spellCheck: 'false',
      onClick: handleCodeblockCopyClick,
    });
  }
  // 剥掉 markdown-it 的**块终止符**：其 render() 给每个块（含整篇末尾）都补一个 `\n`。
  // 末尾那个 `\n` 在 DOM 里是一个真实文本节点，会进容器的 textContent —— 使「渲染出的文本」
  // 比原文多一个换行（文本选中、复制、无障碍朗读都会带上），与「textContent == 原文」这一契约
  // 不符（两条独立 e2e：D3 dump-DOM 与 E1 CDP，都是按该契约写的严格断言）。
  // 只剥**末尾一个字符**，块内换行（如 fenced code 的源码）一概不受影响。
  const html = getMd().render(text).replace(/\n$/, '');
  return React.createElement('div', {
    className: 'md-content',
    spellCheck: 'false',
    dangerouslySetInnerHTML: { __html: html },
    onClick: handleCodeblockCopyClick,
  });
}
