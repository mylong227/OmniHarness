// 判据：全站保持**单调色**（任何可见元素的计算颜色都必须是灰阶）。
//
// ## 为什么需要这条
//
// `web/styles/layout.css` / `chat.css` 里还留着 45 处旧彩色字面量
//（`#3fb950` 绿 / `#f85149` 红 / `#58a6ff` 蓝 / `#bc8cff` 紫…）。此前的口径是
// "已被 `minimal.css` 覆盖 ⇒ 惰性"。那是**假设**。本判据把它变成**实测**：
//
//   · 对整页每个可见元素读 `color` / `backgroundColor` / `borderColor` / `outlineColor`；
//   · 再把那些**动态元素**的 class（diff 徽章、图节点、权限片、来源徽章、语法 token）
//     临时注入页面，问浏览器"这会让它变成什么颜色"——空态页面里这些元素根本不存在，
//     只扫现有 DOM 会漏掉它们（这正是最容易骗过自己的地方）。
//
// ## 为什么两条主题都要验
//
// 彩色字面量往往只在**一套**主题下露头：浅色主题里白底 + `#ff9a9a` 的对比度只有 2.03:1，
// 而深色下同一处可能刚好被后续规则盖住。只验一套等于没验。
//
// ## 容差
//
// r/g/b 三通道相差 ≤3 视为灰阶（抗子像素与取整误差）；`rgba(...,0)` 全透明算无颜色。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession, CdpSession } from './browserHarness.ts';

/** 真机窗口尺寸。 */
const VIEWPORT = { width: 1440, height: 900 };

/**
 * 带彩色字面量的选择器（来自 layout.css / chat.css 的实测清单）。
 * 这些是**动态元素**：空态页面里不渲染，必须主动注入才能验到它们的最终颜色。
 */
const DYNAMIC_CLASSES = [
  'pill warn',
  'change-badge add',
  'change-badge del',
  'change-badge mod',
  'change-badge ren',
  'change-nums',
  'src-badge bundled',
  'src-badge remote',
  'src-badge local',
  'src-badge loaded',
  'src-badge unloaded',
  'perm danger',
  'graph-node running',
  'graph-node done',
  'graph-node failed',
  'tok-kw',
  'hljs-keyword',
];

/**
 * 在页面里执行一次单调色检查。
 * @param {object} cdp CDP 会话
 * @param {string} theme dark / light
 * @returns {Promise<{page: object[], injected: object[]}>} 违规清单
 */
function scan(
  cdp: CdpSession,
  theme: string,
): Promise<{ page: { who: string; hits: string[] }[]; injected: { who: string; hits: string[] }[] }> {
  // cdp.evaluate 返回未标类型（browserHarness 桩），按页面脚本真实返回形状收窄（例外 a）
  return cdp.evaluate(`(function(){
    var TOL = 3;
    function parse(s){
      var m = /rgba?\\(([^)]+)\\)/.exec(s || '');
      if (!m) return null;
      var p = m[1].split(',').map(parseFloat);
      if (p.length < 3) return null;
      return { r:p[0], g:p[1], b:p[2], a: p.length > 3 ? p[3] : 1 };
    }
    function grey(c){
      return c === null || c.a === 0 || (Math.abs(c.r-c.g) <= TOL && Math.abs(c.g-c.b) <= TOL);
    }
    function colourful(s){ return !grey(parse(s)); }
    function label(el){
      var cls = String(el.className || '').trim().split(/\\s+/).slice(0, 3).join('.');
      return el.tagName.toLowerCase() + (cls === '' ? '' : '.' + cls);
    }
    document.documentElement.setAttribute('data-theme', '${theme}');

    // ① 整页（当前渲染出来的所有可见元素）
    var page = [];
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.getClientRects().length === 0) continue;
      var s = getComputedStyle(el);
      var hits = [];
      if (colourful(s.color)) hits.push('color=' + s.color);
      if (colourful(s.backgroundColor)) hits.push('background=' + s.backgroundColor);
      if (colourful(s.borderTopColor)) hits.push('border=' + s.borderTopColor);
      if (colourful(s.outlineColor)) hits.push('outline=' + s.outlineColor);
      if (hits.length > 0) page.push({ who: label(el), hits: hits });
    }

    // ② 动态元素：注入后问最终颜色
    var host = document.getElementById('__mono_probe');
    if (host === null) {
      host = document.createElement('div');
      host.id = '__mono_probe';
      host.style.position = 'fixed';
      host.style.left = '-99999px';
      document.body.appendChild(host);
    }
    host.innerHTML = '';
    var names = ${JSON.stringify(DYNAMIC_CLASSES)};
    var injected = [];
    for (var j = 0; j < names.length; j++) {
      var node = document.createElement('div');
      node.className = names[j];
      node.textContent = 'x';
      host.appendChild(node);
      var cs = getComputedStyle(node);
      var bad = [];
      if (colourful(cs.color)) bad.push('color=' + cs.color);
      if (colourful(cs.backgroundColor)) bad.push('background=' + cs.backgroundColor);
      if (colourful(cs.borderTopColor)) bad.push('border=' + cs.borderTopColor);
      if (bad.length > 0) injected.push({ who: names[j], hits: bad });
    }
    host.innerHTML = '';
    return { page: page, injected: injected };
  })()`) as Promise<{ page: { who: string; hits: string[] }[]; injected: { who: string; hits: string[] }[] }>;
}

/**
 * 把违规清单格式化成可读的断言消息。
 * @param {object[]} rows 违规项
 * @param {string} theme 主题名
 * @returns {string} 消息
 */
function report(rows: { who: string; hits: string[] }[], theme: string) {
  return (
    `${theme} 主题下出现非灰阶颜色（单色不变量被破坏）：\n` +
    rows
      .slice(0, 12)
      .map((r) => `  · ${r.who} → ${r.hits.join(' | ')}`)
      .join('\n')
  );
}

test('单调色不变量：两套主题下整页与动态元素的计算颜色都必须是灰阶', { timeout: 120_000 }, async (t) => {
  const page = await openStubSession(t, { stub: '_monochrome.html', ...VIEWPORT });
  if (page === null) return;
  try {
    const cdp = page.cdp;
    await new Promise((r) => setTimeout(r, 1200));

    for (const theme of ['dark', 'light']) {
      const result = await scan(cdp, theme);
      assert.deepEqual(
        result.page,
        [],
        report(result.page, theme) + '\n（若是新加的彩色样式：单色体系只允许灰阶与反白，见 minimal.css 头注释）',
      );
      assert.deepEqual(
        result.injected,
        [],
        report(result.injected, theme) +
          '\n（这些是 layout.css / chat.css 里的旧彩色字面量位置；它们本应被 minimal.css 覆盖。' +
          '若这里红了，说明覆盖规则被改坏或新增了彩色，动态元素会真的露出颜色）',
      );
    }
  } finally {
    await page.close();
  }
});
