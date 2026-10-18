// 判据：KaTeX **懒加载**的端到端行为（2026-10-18，首屏体积优化）。
//
// ## 守的是什么
//
// 2026-10-18 把 KaTeX 从静态 import 改成 `import('katex')`（266 KB min / 80 KB gzip 从首屏移出）。
// 代价是渲染变成两段：库未到位 ⇒ 公式先出**占位**（`.md-math[data-display]`，内容是转义后的 TeX），
// 动态 chunk 到位 ⇒ `upgradeMathInDocument()` 原地替换成排版结果。
//
// 这条判据盯三件事（任何一件坏了，用户看到的就是"公式变成一坨源码"）：
//   ① 公式最终真的变成 `.katex`（懒加载 chunk 接上了）；
//   ② 升级后**不残留占位**（否则同一公式会显示两遍）；
//   ③ 入口 chunk 里没有 KaTeX 实现（懒加载没被改回静态 import）。
//
// 直跑：先 `npm run web:build`（serve 的是 dist），再 `npx vitest run --project web web/test/mathLazy.test.ts`。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { openStubSession } from './browserHarness.ts';

const ASSETS = join('web', 'dist', 'assets');

test('数学懒加载：入口不含 KaTeX，公式最终渲染成 KaTeX 且不残留占位', { timeout: 120_000 }, async (t) => {
  // ③ 静态判据：入口 chunk 不含 KaTeX 实现（大写 "KaTeX" 只在实现/错误文案里出现）。
  const entry = readdirSync(ASSETS).find((f) => /^index-.*\.js$/.test(f));
  assert.ok(entry !== undefined, '缺少入口 chunk（先 npm run web:build）');
  const entryText = readFileSync(join(ASSETS, entry), 'utf8');
  assert.doesNotMatch(entryText, /KaTeX/, '入口 chunk 又含 KaTeX 实现：懒加载被改回静态 import');

  // ①② 真浏览器：发一条带公式的助手消息，等它升级完成。
  const page = await openStubSession(t, { stub: '_math-lazy.html', width: 1200, height: 800 });
  if (page === null) return;
  try {
    await page.cdp.waitFor("!!document.querySelector('.composer-input textarea')", 8000);
    // 先造出一个当前会话（推送 thread.event 需要 thread 上下文）。
    await page.cdp.evaluate(
      `(function(){ var ta=document.querySelector('.composer-input textarea'); var b=document.querySelector('button.send'); if(ta&&b){ ta.value='公式渲染'; ta.dispatchEvent(new Event('input',{bubbles:true})); b.click(); } return true; })()`,
    );
    await page.cdp.waitFor('!!window.__RESOLVE_TURN__', 8000);
    await page.cdp.evaluate(
      "window.__RESOLVE_TURN__ && window.__RESOLVE_TURN__({ threadId:'math-t1', finalText:'', steps:1 });",
    );
    const tex = '行内 $x^2 + y^2$ 与块级公式：\n\n$$\n\\frac{a}{b}\n$$';
    await page.cdp.push({
      method: 'thread.event',
      params: {
        event: {
          id: 'math-ev-1',
          type: 'assistant',
          timestamp: new Date().toISOString(),
          payload: { content: tex },
        },
      },
    });

    const upgraded = await page.cdp.waitFor("document.querySelectorAll('.katex').length >= 2", 8000);
    assert.ok(upgraded, '公式最终没有变成 KaTeX（异步 chunk 未接上或升级函数未执行）');
    const leftovers = await page.cdp.evaluate(
      "document.querySelectorAll('.md-math[data-display]').length",
    );
    assert.strictEqual(leftovers, 0, '升级后仍残留公式占位（同一公式会显示两遍）');
  } finally {
    await page.close();
  }
});
