// 判据：删掉 web/vendor 之后，三条渲染管线仍然真的在产物里。
//
// 为什么需要这条（2026-10-17 迁移的最后一步）：
//   此前 markdown-it / KaTeX / highlight.js 是 `web/vendor/` 里的 UMD 文件，由 `index.html`
//   用 `<script>` 注入 `window.*`，`markdown.ts` 再做运行时特性检测。改成 npm import 后，
//   它们由 Vite 打进 bundle —— 而 **"构建成功"不等于"库真的进包了"**：
//     · 有人把 import 写成动态/条件分支却没接上，构建照样过，运行时静默退化成无色无排版；
//     · KaTeX 的 CSS 若没被 import，公式会渲染成一堆无样式的 span（看起来像"乱码"）；
//     · 字体若没被 CSS 引用，公式能排版但符号会掉字形（本机有系统字体，肉眼可能看不出来）。
//   这些都是"页面能开、功能静默降级"，正是本仓最想防的一类缺陷。
//
// 为什么不在浏览器里遍历 CSSOM：`index.css` 有 186KB / 数千条规则，把 CSSOM 转成数组会让
// CDP 返回的对象图过深，直接报 `Object reference chain is too long`（实测）。
// 读产物文件同样能判定，且稳定。页面"能否挂载"由真 Chrome 的那 13 条判据覆盖，不在这里重复。
//
// 前置：需要先 `npm run web:build`（`npm run web:test` 已保证）。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(REPO, 'web', 'dist');
const ASSETS = join(DIST, 'assets');

/**
 * 取产物目录下匹配文件名正则的文件内容。
 * @param dir 目录
 * @param re 文件名正则
 * @returns {name,text} 数组
 */
function readMatching(dir, re) {
  return readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));
}

test('产物里三条渲染管线齐全、KaTeX 样式与字体就位、web/vendor 已彻底消失', () => {
  const jsChunks = readMatching(ASSETS, /\.js$/);
  const cssChunks = readMatching(ASSETS, /\.css$/);
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const allJs = jsChunks.map((c) => c.text).join('\n');
  const allCss = cssChunks.map((c) => c.text).join('\n');
  const fonts = readdirSync(ASSETS).filter((f) => /^KaTeX_/.test(f)).length;

  // 单 bundle（目标要求"Vite 默认单 bundle"）：恰好 1 个入口 JS。
  // 若变成多个，说明有人加了 manualChunks 或引入了动态 import 分包 —— 那会改变部署形态
  //（每个 chunk 都要 200，多一个就多一个 404 面），值得有人确认一次。
  assert.equal(jsChunks.length, 1, `产物应为单 bundle，实为 ${String(jsChunks.length)} 个 JS 文件`);
  // 三个库的指纹（任一缺失即"构建过了但库没进包"）。
  assert.match(allJs, /escapeHtml|fence/i, 'markdown-it 未进入 bundle');
  assert.match(allJs, /katex/i, 'KaTeX 未进入 bundle');
  assert.match(allJs, /hljs/, 'highlight.js 未进入 bundle');
  // KaTeX 样式与字体（此前是手抄的 web/vendor/katex.min.css + fonts/）。
  assert.match(allCss, /\.katex/, 'KaTeX 样式未进入 CSS bundle：公式会渲染成无样式 span');
  assert.match(allCss, /KaTeX_[A-Za-z]+-Regular[^)]*\.woff2/, 'KaTeX 字体未被产物 CSS 引用');
  assert.ok(fonts >= 20, `KaTeX 字体文件过少（${String(fonts)} 个）`);
  // 体积预算（单 bundle 必然 >500KB，故阈值在 vite.config 里写死为 1200KB）。
  // 这里守的是"别悄悄翻倍"：1.03MB → 2MB 这类回归会被抓住。
  const bundleBytes = jsChunks[0].text.length;
  assert.ok(
    bundleBytes < 1_400_000,
    `单 bundle 体积 ${String(Math.round(bundleBytes / 1024))}KB 超出预算（约 1030KB + 余量）`,
  );
  // vendor 必须已彻底消失，且宿主页不再引用它。
  //
  // 口径说明：不断言"磁盘上不存在 `web/vendor/`"——本机会有外部工具把已删除的
  // **已跟踪文件**还原回磁盘（`polish.css` 与 `web/vendor/` 都实测过）。那种还原不进索引、
  // 不被 publicDir 复制、也不被页面引用，因此是惰性的。真正要守的是"没进产物"：
  // 产物根出现 UMD 文件才是真的回归（说明 publicDir 又指回了 vendor）。
  for (const legacy of ['markdown-it.min.js', 'katex.min.js', 'highlight.min.js']) {
    assert.ok(
      !existsSync(join(DIST, legacy)),
      `产物根出现旧 UMD 文件 ${legacy}：publicDir 可能又被指回 web/vendor`,
    );
  }
  assert.doesNotMatch(
    html,
    /<script src="\.\/(?:markdown-it|katex|highlight)\./,
    '宿主页仍引用旧 vendor 脚本（会造成双份运行时/静默覆盖）',
  );
  assert.match(html, /src="\.\/assets\/index-[^"]+\.js"/, '宿主页应以 assets/* 作为模块入口');
});
