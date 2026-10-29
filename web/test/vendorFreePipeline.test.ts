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
function readMatching(dir: string, re: RegExp) {
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

  // 单入口 bundle（目标要求"Vite 默认单 bundle"）：恰好 1 个 `index-*.js` 入口。
  // 2026-10-18：KaTeX 改成**动态 import**后，产物会多出一个 `katex-*.js` 异步块——
  // 这是刻意的（首屏不背 266 KB 的公式引擎），故从"恰好 1 个 JS"放宽为"恰好 1 个入口"。
  const entryJs = jsChunks.filter((c) => /^index-.*\.js$/.test(c.name));
  const katexChunks = jsChunks.filter((c) => /^katex-.*\.js$/.test(c.name));
  assert.strictEqual(
    entryJs.length,
    1,
    `入口应为单个 index-*.js，实为 ${String(entryJs.length)} 个入口`,
  );
  assert.strictEqual(
    katexChunks.length,
    1,
    `KaTeX 应拆成 1 个异步块（懒加载），实为 ${String(katexChunks.length)} 个`,
  );
  // 三个库的指纹（任一缺失即"构建过了但库没进包"）。
  assert.match(allJs, /escapeHtml|fence/i, 'markdown-it 未进入 bundle');
  assert.match(allJs, /KaTeX/i, 'KaTeX 未进入 bundle（异步块也算）');
  assert.match(allJs, /hljs/, 'highlight.js 未进入 bundle');
  // 懒加载的判据：**入口块里不能有 KaTeX 的实现**（大写 "KaTeX" 只出现在其错误文案与类名里；
  // 入口只会出现异步 chunk 的文件名 `katex-*.js`，那是小写）。
  const entryText = entryJs[0]?.text ?? '';
  assert.doesNotMatch(
    entryText,
    /KaTeX/,
    'KaTeX 实现又被打回入口块：首屏会多背 266 KB（应为动态 import）',
  );
  assert.ok(
    (katexChunks[0]?.text.length ?? 0) > 200_000,
    'KaTeX 异步块异常偏小，可能没把引擎打进去',
  );
  // KaTeX 样式与字体（此前是手抄的 web/vendor/katex.min.css + fonts/）。CSS 由入口 + 异步块共同组成。
  assert.match(allCss, /\.katex/, 'KaTeX 样式未进入 CSS bundle：公式会渲染成无样式 span');
  assert.match(allCss, /KaTeX_[A-Za-z]+-Regular[^)]*\.woff2/, 'KaTeX 字体未被产物 CSS 引用');
  assert.ok(fonts >= 20, `KaTeX 字体文件过少（${String(fonts)} 个）`);
  // 入口体积预算：KaTeX 拆走后从 ~1030 KB 降到 ~780 KB；这里守"别悄悄长回去"。
  const bundleBytes = entryText.length;
  assert.ok(
    bundleBytes < 900_000,
    `入口 chunk 体积 ${String(Math.round(bundleBytes / 1024))}KB 超出预算（约 780KB + 余量）`,
  );

  // ---- 分块边界（2026-10-29 W4 分块改造，看板 §179）----
  //
  // vite.config 的 manualChunks 把面板级 antd 组件族（Table/Menu/Form/…）收进异步共享块
  // panel-antd。这里钉四条边界，防两类回归：
  //   ① 面板库回流首屏：manualChunks 名单漏了族、或有人在静态（壳层）文件里 import 面板族
  //      ——panel-antd 会被 vendor 静态可达，出现在 index.html 的 modulepreload 里；
  //   ② 循环块：vendor 与 panel 互相静态引用（Rollup 会打印 Circular chunk 并发裸
  //      `import "./panel-antd-*.js"`）——构建不失败，但 panel-antd 仍在首屏关键路径上。
  // 指纹用 keepNames 保留的 Table 内部名（useFilter / MeasureRow）：它们只存在于面板族模块。
  const vendorReact = jsChunks.filter((c) => /^vendor-react-/.test(c.name));
  const vendorAntd = jsChunks.filter((c) => /^vendor-antd-/.test(c.name));
  const panelAntd = jsChunks.filter((c) => /^panel-antd-/.test(c.name));
  assert.strictEqual(vendorReact.length, 1, 'vendor-react 基座应恰 1 个');
  assert.strictEqual(vendorAntd.length, 1, 'vendor-antd 基座应恰 1 个');
  assert.strictEqual(panelAntd.length, 1, 'panel-antd（面板级 antd 异步共享块）应恰 1 个');
  assert.doesNotMatch(
    html,
    /panel-antd-/,
    'index.html 预加载了 panel-antd：面板库被静态可达（分块边界被打破），首屏背回面板库',
  );
  for (const host of [entryText, vendorAntd[0]?.text ?? '']) {
    assert.doesNotMatch(
      host,
      /import[^;\n]{0,80}"\.\/panel-antd-/,
      'vendor/entry 静态导入 panel-antd：循环块 + 面板库进首屏（看 vite.config.ts 的 denylist 准入纪律）',
    );
    assert.doesNotMatch(
      host,
      /useFilter|MeasureRow/,
      '面板族指纹（Table 的 useFilter/MeasureRow）落入首屏块：面板级组件被静态引用了',
    );
  }
  assert.match(panelAntd[0]?.text ?? '', /useFilter/, 'panel-antd 缺 Table 指纹：面板族被搬回 vendor？');
  assert.match(panelAntd[0]?.text ?? '', /MeasureRow/, 'panel-antd 缺 Table 指纹：面板族被搬回 vendor？');

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
