// 成熟依赖加持的 Markdown 渲染器（回复模式 / 会话模式核心展示层）。
//
// 设计取舍（回应「不要求无第三方依赖，善用成熟知识代替从零造轮子」）：
//   - 解析交给 markdown-it（与 deepseek-harness 的 micromark 同代成熟方案），
//     取代 format.ts 里手写、易踩坑的无第三方依赖解析器；
//   - 行内/块级数学交给 KaTeX（deepseek-harness 亦用 KaTeX）；
//   - 代码高亮交给 highlight.js（deepseek-harness 用 Shiki，这里用零构建步骤、
//     离线可用的 highlight.js，效果同级且更轻）。
//
// 安全：markdown-it 以 `html:false` 运行——用户原始 HTML 一律被转义，仅以下产出为受信任 HTML：
//   - KaTeX.renderToString 的结果（我们自己生成的数学排版）；
//   - highlight.js 的结果（先转义源码再包 span，绝不注入用户输入）。
//   => 整体不弱于原「零 innerHTML」安全姿态（用户内容仍不可注入）。
//
// ## 2026-10-17：从 UMD 全局改为 npm import（随 Vite 迁移一并完成）
//
// 迁移前这三个库以 UMD `<script>` 注入 `window.markdownit / window.katex / window.hljs`，
// 本文件再做运行时特性检测（缺任一即回落到 `format.ts` 的手写渲染器）。
// 现在改为**标准 npm import + Vite 打包**，`web/vendor/` 因此可以整体删除。
//
// 关于回落路径：`markdownLibsReady()` 仍保留，但打包后的依赖**不存在"加载失败"这种运行时态**
// （要么构建期就失败、要么一定在）。所以它现在恒为 true —— 手写实现
// （`format.ts` 的 `legacyRenderMarkdown`）按 `docs/DEPENDENCY_POLICY.md` 的
// 「既有手写实现保留为资产与回退路径」继续存在并有独立判据，只是生产路径不再会走到它。
//
// `katex` 与它的样式**不再静态 import**（2026-10-18，首屏体积优化）：
// KaTeX 是 266 KB min / 75 KB gzip，而数学公式在对话里是低频内容——静态引入等于让
// 每个用户都为"也许会用到的公式"付首屏解析代价。现在改成**首次遇到 `$…$` / `$$…$$` 时**
// 才 `import('katex')`（Vite 会拆成独立异步 chunk，含 CSS 与字体）。
//
// 公式在库到位前先渲染成**占位元素**（`<span class="md-math" data-tex="…">`，内容是转义后的
// TeX 源码，读起来像等宽文本），库到位后由 `upgradeMathInDocument()` 原地替换成排版结果。
// 这样：① 消息流不会被异步加载阻塞；② 无公式的会话永不下载 KaTeX；③ 渲染顺序不变。
import markdownit from 'markdown-it';
// highlight.js 用 **core + 显式注册的语言子集**（2026-10-18 起，18 种）：
//
//   · `lib/common` 是 36 种语言的打包入口，实测 **291 KB 原始 / 94 KB gzip**；
//     全量入口更大（+800 KB），而代理产出的代码其实集中在下面这 18 种里。
//   · 未注册的语言**不会报错**：`getLanguage()` 返回 undefined ⇒ 回落到 `highlightAuto()`
//     （自动识别只在已注册集合里挑，所以冷门语言会退化成"不精确但不坏"的着色）。
//   · 加一门语言的成本约 5–25 KB 原始（gzip 2–8 KB）：在下方 import 一行 + `registerLanguage` 一行。
//     2026-10-18 刻意**没有**注册 csharp / kotlin / php / ruby：四门合计约 61 KB 原始，
//     而本仓产出的上下文里它们极少出现；需要时按上面两行加回即可（判据会随语言表同步）。
//   · 判据：`web/test/vendorAndTypeSource.test.ts` 断言"core + 注册表"，并检查关键语言在列。
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('go', go);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

import * as React from 'react';
import { ClipboardCopier } from './models/ClipboardCopier.ts';
import { t } from './i18n/i18n.ts';

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

/** markdown-it 构造器签名（npm 包默认导出即工厂函数）。 */
type MarkdownItFactory = (options?: Record<string, unknown>) => MarkdownItInstance;

/** 三个依赖的绑定（markdown-it / highlight.js 静态；KaTeX 见下方懒加载状态）。 */
const libs = {
  markdownit: markdownit as unknown as MarkdownItFactory,
  hljs: hljs as unknown as HljsApi,
};

/**
 * KaTeX 的懒加载状态（2026-10-18）：
 *   · `katexApi` 就位前，公式渲染成占位元素；
 *   · `katexLoading` 保证只发一次动态 import（流式渲染会反复经过同一条规则）；
 *   · 失败只记 debug（不抛）：公式退化成等宽源码，对话其余部分照常。
 */
let katexApi: KatexApi | undefined;
let katexLoading = false;

/** 触发 KaTeX 的异步加载（幂等）。 */
function requestKatex(): void {
  if (katexApi !== undefined || katexLoading) return;
  katexLoading = true;
  void Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([mod]) => {
      katexApi = (mod.default ?? mod) as unknown as KatexApi;
      upgradeMathInDocument();
    })
    .catch(() => {
      // 加载失败保持占位（源码可读），下次有公式时可以重试。
      katexLoading = false;
    });
}

/**
 * 把文档里所有公式占位替换成 KaTeX 排版结果（库到位后调用一次）。
 *
 * 为什么扫全文档而不是只扫新渲染的节点：占位可能在**多个容器**里（消息流、详情面板、
 * 折叠文档），而加载回调只有一个；统一扫一遍最简单，且占位数量通常是个位数。
 * @returns 无返回值。
 */
function upgradeMathInDocument(): void {
  if (katexApi === undefined || typeof document === 'undefined') return;
  const nodes = document.querySelectorAll<HTMLElement>('.md-math[data-display]');
  for (const node of nodes) {
    const tex = node.textContent ?? '';
    const display = node.getAttribute('data-display') === '1';
    try {
      const html = katexApi.renderToString(tex, { displayMode: display, throwOnError: false });
      if (display) {
        const block = node.closest('.md-math-block') ?? node;
        block.outerHTML = '<div class="md-math-block">' + html + '</div>';
      } else {
        node.outerHTML = html;
      }
    } catch {
      // 单条公式失败就保留占位文本（已转义，安全）。
    }
  }
}

/**
 * 三个成熟依赖是否全部就绪。
 *
 * KaTeX 自 2026-10-18 起是**懒加载**的，因此这里只要求「静态那两项」存在：
 * 数学渲染在库到位前走占位、到位后原地升级，主渲染管线不需要等它。
 * 保留这个函数是为了不动 `format.ts` 的调用形态。
 * @returns 恒 true（markdown-it / highlight.js 已随 bundle 就位）。
 */
export function markdownLibsReady(): boolean {
  return libs.markdownit !== undefined && libs.hljs !== undefined;
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
  const original = btn.textContent ?? t('复制');
  btn.textContent = t('已复制');
  btn.classList.add('md-codeblock__copy--done');
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('md-codeblock__copy--done');
  }, 1400);
}

/** 模块级单例缓存：首次用到时才构造（配置一次、渲染多次）。 */
let mdCache: MarkdownItInstance | null = null;

/** 构造并缓存配置好的 markdown-it 实例（含数学插件与代码高亮）。 */
function getMd(): MarkdownItInstance {
  if (mdCache !== null) return mdCache;
  const md = libs.markdownit();

  // 代码高亮：优先按语言高亮，未知语言走自动识别。输出受信任（hljs 先转义后加色）。
  md.set({
    highlight: (str: string, lang: string): string => {
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


  // ---- 渲染：数学交 KaTeX（懒加载；库未到位时先出占位，到位后原地升级） ----
  /** 数学统一入口：库就绪 ⇒ 直接排版；未就绪 ⇒ 占位 + 触发一次异步加载。 */
  const renderMath = (tex: string, display: boolean): string => {
    if (katexApi === undefined) {
      requestKatex();
      const body = md.utils.escapeHtml(tex);
      const span = '<span class="md-math" data-display="' + (display ? '1' : '0') + '">' + body + '</span>';
      return display ? '<div class="md-math-block">' + span + '</div>' : span;
    }
    try {
      const html = katexApi.renderToString(tex, { displayMode: display, throwOnError: false });
      return display ? '<div class="md-math-block">' + html + '</div>' : html;
    } catch {
      return display ? '<pre>' + md.utils.escapeHtml(tex) + '</pre>' : md.utils.escapeHtml(tex);
    }
  };
  md.renderer.rules.math_inline = (tokens: MdToken[], idx: number): string => {
    const token = tokens[idx];
    if (!token) return '';
    return renderMath(token.content, false);
  };
  md.renderer.rules.math_block = (tokens: MdToken[], idx: number): string => {
    const token = tokens[idx];
    if (!token) return '';
    return renderMath(token.content, true);
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
    ((tokens: MdToken[], idx: number, opts: unknown, _env: unknown, self: MdSelf): string =>
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
      '<button type="button" class="md-codeblock__copy">' + t('复制') + '</button>' +
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
