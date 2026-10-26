// 侧栏页脚可达性（真 Chrome，1000×700 矮视口）：
// 高 DPI/小窗口下侧栏内容可能高于视口；设置入口不能掉到屏幕外。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession } from './browserHarness.ts';

test('侧栏页脚与设置入口在矮视口内可见可点', { timeout: 120_000 }, async (t) => {
  const page = await openStubSession(t, {
    width: 1000,
    height: 700,
    waitFor: '.side-foot',
  });
  if (page === null) return;
  try {
    const metrics = (await page.cdp.evaluate(`(function(){
        var foot = document.querySelector('.side-foot');
        var btn = document.querySelector('.side-foot button[aria-label="打开设置"]');
        var fr = foot ? foot.getBoundingClientRect() : null;
        var br = btn ? btn.getBoundingClientRect() : null;
        var hit = null;
        if (br) {
          var el = document.elementFromPoint(Math.round(br.x + br.width / 2), Math.round(br.y + br.height / 2));
          hit = el ? String(el.className || el.tagName) : null;
        }
        return {
          innerHeight: innerHeight,
          top: fr ? fr.top : null,
          bottom: fr ? fr.bottom : null,
          btnTop: br ? br.top : null,
          btnBottom: br ? br.bottom : null,
          hit: hit,
        };
      })()`)) as {
      innerHeight: number;
      top: number | null;
      bottom: number | null;
      btnTop: number | null;
      btnBottom: number | null;
      hit: string | null;
    };
    assert.ok(metrics.bottom !== null && metrics.top !== null, '页脚必须渲染');
    assert.ok(
      metrics.bottom <= metrics.innerHeight + 0.5 && metrics.top >= 0,
      `页脚必须在视口内：${JSON.stringify(metrics)}`,
    );
    assert.ok(
      metrics.btnBottom !== null && metrics.btnBottom <= metrics.innerHeight + 0.5,
      '设置按钮必须在视口内',
    );
    assert.ok(metrics.hit !== null && metrics.hit !== '', '设置按钮中心必须有命中元素');
    assert.match(String(metrics.hit), /iconbtn|BUTTON|svg|SVG/u, '设置按钮中心必须可点击');
    await page.cdp.evaluate(
      `(function(){ var b=document.querySelector('.side-foot button[aria-label="打开设置"]'); if(b) b.click(); })()`,
    );
    assert.ok(
      await page.cdp.waitFor("!!document.querySelector('.csl')", 2000),
      '点设置后必须打开工作台控制台',
    );
  } finally {
    await page.close();
  }
});
