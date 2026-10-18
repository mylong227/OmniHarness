// 页面级滚动锁死门禁（真浏览器 + CDP）：无论视口多矮，文档**不得**可滚。
//
// ## 缺陷形态（2026-10-14 用户报「滚动会导致整个页面完全被滚上去」+ 截图：侧栏/顶栏/输入框
// 全部被滚出视口，只剩输入框悬在页面顶部与一片空黑）
//
// 根因是布局的最小尺寸传播：`.app` 用 `grid-template-rows:1fr`，而 **`1fr` 轨道的最小尺寸函数
// 是 auto**——矮视口下左栏内容（项目列表 + 会话列表 + 页脚）的最小内容高度把轨道顶破 100vh，
// `.app` 随内容长高 ⇒ 文档本身可滚。此后任何一处内层滚动到边界后的链式滚动（或滚轮落在非
// 可滚区域）都会滚动**整个文档**：侧栏、顶栏、输入框全部被滚走。
//
// 可证伪性（CDP 实测，2026-10-14）：视口 400px 时文档 scrollHeight 433px（可滚 33px 起步，
// 会话越多越严重），元凶链 `.app > .body > .col.left > … ws-list/session`；修复（行高
// `minmax(0,1fr)` + `html/body overflow:hidden`）后 656/600/550/500/450/400 六档全部锁死。
//
// 高内容的正确出路是**栏内滚动**（`.col` 本就有 `min-height:0; overflow:auto`），不是把整页撑高。
//
// 直跑：node --test web/test/pageScrollLock.test.mjs（需先 npm run web:build）。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession } from './browserHarness.ts';

test('页面级滚动锁死：任何视口高度文档都不可滚，高内容由栏内滚动消化', async (t) => {
  const opened = await openStubSession(t, { width: 1053, height: 656 });
  if (!opened) return;
  const { cdp, close } = opened;
  try {
    for (const h of [656, 500, 400]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1053,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
      // 等 reflow 稳定（resize 后布局/虚拟化测量各需一帧以上）。
      await new Promise((r) => setTimeout(r, 300));
      const r = await cdp.evaluate(
        '({ sh: document.scrollingElement.scrollHeight, ih: window.innerHeight })',
      );
      assert.ok(
        r.sh <= r.ih,
        `视口 ${h}px 时文档可滚（scrollHeight=${r.sh} > innerHeight=${r.ih}）——页面级滚动锁被破坏：` +
          '根因通常是某层容器把 .app 撑破 100vh（见本文件头注释），应让该栏内部滚动而不是撑高文档',
      );
    }
  } finally {
    await close();
  }
});
