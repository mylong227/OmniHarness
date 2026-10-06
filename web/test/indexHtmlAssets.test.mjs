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
import test from 'node:test';
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

test('② 宿主页引用的本地资源必须真实存在且非空（防"标签在、文件没了"的静默降级）', () => {
  const source = html();
  const refs = [...source.matchAll(/(?:href|src)=["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((url) => !/^(https?:|data:|mailto:|#|\/\/)/i.test(url));
  assert.ok(refs.length >= 5, `宿主页引用的本地资源太少（${refs.length}），解析可能失效`);
  for (const url of refs) {
    const clean = url.split('?')[0];
    if (clean === '') continue;
    const abs = join(WEB_ROOT, clean);
    assert.ok(existsSync(abs), `index.html 引用了不存在的资源：${clean}`);
    assert.ok(statSync(abs).size > 0, `index.html 引用的资源是空文件：${clean}`);
  }
});
