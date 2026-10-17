// 宿主页（`web/index.html`）的两条健康契约（2026-10-06 第六十二轮真机跑测补齐）。
//
// ## 为什么需要它（都是真机 CDP 跑测实测出来的）
//
// 1. **必须显式声明站点图标**。不声明 `rel="icon"` 时，浏览器会回退请求 `/favicon.ico`，而 `serve`
//    没有这条路由 ⇒ 每次加载都在控制台留一条 `404` 错误。这会把"前端控制台零错误"这条健康判据
//    逼成**假红**（真机跑测首轮就是这个红），也污染用户的开发者控制台。
//    ⇒ 本文件把"宿主页自带图标（内联 data URI，零额外请求、零网络依赖）"钉成契约。
//
// 2. **宿主页引用的本地资源必须真实存在且非空**。历史教训是"标签在、文件被删/为空"（页面看似能开、
//    功能静默降级，例如 markdown 代码高亮与数学排版整段失效）。这里对 `href/src` 的相对路径做存在性
//    与大小断言；外部 URL（http/https/data/mailto）不在此列。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 读宿主页源码。
 * @returns `index.html` 的 UTF-8 文本。
 */
function html() {
  return readFileSync(join(WEB_ROOT, 'index.html'), 'utf8');
}

test('① 宿主页必须自带站点图标（否则浏览器回退请求 /favicon.ico ⇒ 控制台每次一条 404）', () => {
  const source = html();
  assert.match(
    source,
    /<link[^>]+rel=["']icon["']/i,
    'index.html 未声明 rel="icon"：浏览器会回退请求 /favicon.ico，serve 无此路由 ⇒ 控制台 404',
  );
  // 图标必须是自带的（内联 data URI 或本地文件），不得引入网络依赖——本仓铁律是离线可用。
  const icon = /<link[^>]+rel=["']icon["'][^>]*href=["']([^"']+)["']/i.exec(source);
  assert.ok(icon !== null, '无法解析 rel="icon" 的 href');
  const href = icon[1];
  assert.ok(
    href.startsWith('data:') || !/^https?:/i.test(href),
    `站点图标不得依赖网络（零网络依赖铁律）：${href}`,
  );
});

test('② 宿主页只引用一个模块入口，且它真实存在、非空', () => {
  const source = html();
  const refs = [...source.matchAll(/(?:href|src)=["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((url) => !/^(https?:|data:|mailto:|#|\/\/)/i.test(url));

  // 2026-10-17 第二轮标准化：样式已从 index.html 的 20 条 `<link>` 移入 `src/main.ts` 的
  // import（标准 Vite 做法），所以宿主页现在**只有一条**本地引用 —— 那个模块入口。
  //
  // 判据因此从"资源 ≥5 条且都存在"改成"**恰好一条，且就是那个入口**"：
  //   · 原来那半句防的是"标签在、文件被删"，现在对应的风险是"入口路径写错"；
  //   · 样式是否齐全由 `a11yContrast.test.mjs` 的孤儿样式表判据负责（它扫 main.ts 的 import）；
  //   · 资源是否真的产出（assets/*）由 `vendorFreePipeline.test.mjs` 负责。
  // 三条判据各管一段，不再用"数量下限"这种间接信号。
  assert.equal(refs.length, 1, `宿主页应恰好引用一个本地资源（入口模块），实为 ${String(refs.length)} 个：${refs.join(', ')}`);
  const entry = refs[0];
  assert.equal(entry, './src/main.ts', '宿主页引用的唯一本地资源必须是源码入口 ./src/main.ts');

  const clean = entry.split('?')[0];
  const hit = [join(WEB_ROOT, clean), join(WEB_ROOT, 'dist', clean)].find((p) => existsSync(p));
  assert.ok(hit !== undefined, `入口模块不存在：${clean}`);
  assert.ok(statSync(hit).size > 0, `入口模块是空文件：${clean}`);
});
