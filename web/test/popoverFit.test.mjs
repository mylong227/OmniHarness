// 输入区弹层两件事的门禁（真浏览器 + CDP，**一个文件只起一次 Chrome / 一个服务器**）：
//   ① 形状不符时弹层降级展示，而不是把整个工作台卸载（旧版服务端 ⇒ RPC 回落成 `{}`）；
//   ② 600/800/1280 三档视口下弹层完整可见（不越视口、也不被任何裁切祖先切掉）。
//
// ## 缺陷形态（2026-09-27 用户报「页面被截断遮挡」+ 实测取证）
//
// `.addmenu-pop` / `.cap-pop` 原先 `position:absolute; left:0; width:300/320px` 挂在**触发器**上
// （`.addmenu` 30px / `.cap` 107px，位于 `.composer-bar` 里会随 flex 排到右半侧）⇒ 弹层整体向右展开、
// 右边缘冲出视口（800×900 实测 920 / 826px），再被可滚动列（`.col.center`，`overflow:auto`）裁掉右半边。
// 修法：基准换成整个 `.composer`（恒 ≳570px 宽）并水平居中 + 宽度兜底。
//
// ## 为什么「只查横向滚动条」不够
//
// 实测 `documentElement.scrollWidth` 恒等于视口宽（裁切发生在**列容器**上），故判据必须是
// 「弹层四边在视口内」+「不被任何 `overflow != visible` 的祖先切掉」。另加一条：形状不符时
// `setPlugins(undefined)` / `new QuotaView({})` 会在渲染期抛错并**卸载整棵树**（`#root` 清空）。
//
// **性能约束**：`npm run web:test` 并行跑 23 个文件，真机 CDP 用例一多就互相争抢（实测「每例各起
// Chrome」的写法在并行档里被挤过 30s 预算）⇒ 本文件复用**一次 Chrome 启动 + 一个服务器**，多处导航。
//
// 无浏览器时显式 skip（不伪装通过）；可用 OMNI_CHROME_PATH 指定。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findBrowser,
  serveStatic,
  stubHtmlCdp,
  getFreePort,
  launchChromeForCdp,
  killChromeTree,
  waitForPageWs,
  CdpSession,
  WEB_ROOT_PATH,
} from './browserHarness.mjs';

const FIT_PAGE = '_popover-fit.html';
const DEGRADE_PAGE = '_popover-degrade.html';
/** 逐档测：窄窗（原缺陷档）/ 中间档 / 桌面档。 */
const WIDTHS = [600, 800, 1280];
/** 视口高度（够弹层 60vh 展开）。 */
const HEIGHT = 900;
/** 把结构型响应换成 `{}`（模拟服务端版本不匹配 / 方法不存在时的回落值）。 */
const EMPTY_METHODS = ['quota.get', 'plugins.list', 'agents.list'];

/**
 * 取出选择器命中的元素矩形，并列出把它裁掉的祖先（`overflow != visible` 且边界小于元素）。
 * @param {object} cdp CDP 会话。
 * @param {string} sel 选择器。
 * @returns {Promise<{rect:object, clippedBy:string[], viewport:object}|null>} 度量结果（元素不存在为 null）。
 */
function measure(cdp, sel) {
  return cdp.evaluate(`(function(){
    var el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    var r = el.getBoundingClientRect();
    var clippedBy = [];
    for (var p = el.parentElement; p; p = p.parentElement) {
      var cs = getComputedStyle(p);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      var pr = p.getBoundingClientRect();
      if (r.left < pr.left - 0.5 || r.right > pr.right + 0.5 || r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5) {
        clippedBy.push((p.className || p.tagName) + '[' + Math.round(pr.left) + '..' + Math.round(pr.right) + ']');
      }
    }
    return {
      rect: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) },
      clippedBy: clippedBy,
      viewport: { w: window.innerWidth, h: window.innerHeight }
    };
  })()`);
}

/**
 * 断言：弹层在视口内、且不被任何裁切祖先切掉。
 * @param {object|null} m measure 的结果。
 * @param {string} label 断言消息前缀。
 * @param {number} width 当前视口宽。
 * @returns {void}
 */
function assertFits(m, label, width) {
  assert.ok(m !== null, `${label}：弹层未渲染（触发器/数据缺失）`);
  const { rect, viewport } = m;
  assert.ok(
    rect.left >= 0 && rect.right <= viewport.w + 0.5,
    `${label}：弹层横向越出视口（${rect.left}..${rect.right}，视口 ${viewport.w}）`,
  );
  assert.ok(
    rect.top >= 0 && rect.bottom <= viewport.h + 0.5,
    `${label}：弹层纵向越出视口（${rect.top}..${rect.bottom}，视口 ${viewport.h}）`,
  );
  assert.deepStrictEqual(
    m.clippedBy,
    [],
    `${label}：弹层被裁切祖先切掉（${width}px 视口）——${m.clippedBy.join(', ')}`,
  );
}

/** 打开「添加菜单」并返回其度量。 @param {object} cdp CDP 会话。 @returns {Promise<object|null>} 度量。 */
async function openAddMenu(cdp) {
  await cdp.evaluate("(function(){document.querySelector('.addmenu').click();return true;})()");
  await cdp.waitFor("!!document.querySelector('.addmenu-pop')", 400);
  return measure(cdp, '.addmenu-pop');
}

/** 打开「上下文容量面板」并返回其度量。 @param {object} cdp CDP 会话。 @returns {Promise<object|null>} 度量。 */
async function openCapPanel(cdp) {
  await cdp.evaluate("(function(){document.querySelector('.cap').click();return true;})()");
  await cdp.waitFor("!!document.querySelector('.cap-pop')", 400);
  await new Promise((r) => setTimeout(r, 900));
  return measure(cdp, '.cap-pop');
}

test('输入区弹层：三档视口下完整可见 + 形状不符时降级展示（不卸载工作台）', { timeout: 120_000 }, async (t) => {
  const browser = findBrowser();
  if (browser === null) {
    t.skip('未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 后重跑');
    return;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('Node 缺全局 WebSocket（需 Node ≥22）');
    return;
  }

  // 降级页：追加一段脚本，把三个「结构型」响应换成 `{}`（只改夹具，不改产品代码）。
  const override = `<script>(function(){
    var prev = window.fetch;
    window.fetch = function(url, opts){
      var method = '';
      try { method = JSON.parse((opts && opts.body) || '{}').method || ''; } catch (e) {}
      if (${JSON.stringify(EMPTY_METHODS)}.indexOf(method) >= 0) {
        return Promise.resolve({ ok:true, status:200,
          json: function(){ return Promise.resolve({ jsonrpc:'2.0', id:1, result:{} }); },
          text: function(){ return Promise.resolve('{"jsonrpc":"2.0","id":1,"result":{}}'); } });
      }
      return prev(url, opts);
    };
  })();</script>`;
  const baseHtml = stubHtmlCdp();
  const degradeHtml = baseHtml.replace(/<\/body>/i, `${override}</body>`);
  assert.notStrictEqual(degradeHtml, baseHtml, '夹具改动失败：stub 页里没有 </body>');

  const server = await serveStatic(WEB_ROOT_PATH, {
    [`/${FIT_PAGE}`]: baseHtml,
    [`/${DEGRADE_PAGE}`]: degradeHtml,
  });
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-popfit-'));
  const cdpPort = await getFreePort();
  const proc = launchChromeForCdp(browser, `http://127.0.0.1:${server.port}/${FIT_PAGE}`, userDataDir, cdpPort);
  let cdp;
  try {
    cdp = new CdpSession(await waitForPageWs(cdpPort, FIT_PAGE, 60_000));

    // ① 三档视口：弹层必须完整可见（原缺陷：800px 下 addmenu 右边缘到 920）
    for (const width of WIDTHS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.navigate(`http://127.0.0.1:${server.port}/${FIT_PAGE}`);
      await cdp.waitFor("!!document.querySelector('.composer-input textarea')", 1200);

      assertFits(await openAddMenu(cdp), '添加菜单', width);
      await cdp.evaluate("(function(){document.querySelector('.addmenu').click();return true;})()");
      await cdp.waitFor("!document.querySelector('.addmenu-pop')", 200);

      assert.ok(await cdp.evaluate("!!document.querySelector('.cap')"), `${width}px：容量触发器缺失`);
      assertFits(await openCapPanel(cdp), '上下文容量面板', width);
      await cdp.evaluate("(function(){document.querySelector('.cap').click();return true;})()");
      await cdp.waitFor("!document.querySelector('.cap-pop')", 200);

      const overflow = await cdp.evaluate(
        '(function(){return {sw: document.documentElement.scrollWidth, iw: window.innerWidth};})()',
      );
      assert.ok(
        overflow.sw <= overflow.iw + 0.5,
        `${width}px：文档横向溢出（scrollWidth=${overflow.sw} > innerWidth=${overflow.iw}）`,
      );
      if (process.env['OMNI_E2E_VERBOSE'] === '1') {
        console.error(`[popover-fit] ${width}px 通过`);
      }
    }

    // ② 形状不符：两个弹层都降级渲染，`#root` 不得被清空
    await cdp.navigate(`http://127.0.0.1:${server.port}/${DEGRADE_PAGE}`);
    await cdp.waitFor("!!document.querySelector('.composer-input textarea')", 1200);

    await cdp.evaluate("(function(){document.querySelector('.addmenu').click();return true;})()");
    await cdp.waitFor("!!document.querySelector('.addmenu-pop')", 400);
    const afterAdd = await cdp.evaluate(
      "(function(){return {pop: !!document.querySelector('.addmenu-pop'), composer: !!document.querySelector('.composer'), rootLen: document.getElementById('root').innerHTML.length};})()",
    );
    assert.ok(afterAdd.pop, '形状不符时添加菜单仍应渲染（降级为空目录）');
    assert.ok(afterAdd.composer, '形状不符不得让输入区整个消失');
    assert.ok(afterAdd.rootLen > 200, `工作台被卸载了（#root=${afterAdd.rootLen}）`);
    await cdp.evaluate("(function(){document.querySelector('.addmenu').click();return true;})()");

    assertFits(await openCapPanel(cdp), '上下文容量面板（降级态）', 800);
    const afterCap = await cdp.evaluate(
      "(function(){return {pop: !!document.querySelector('.cap-pop'), composer: !!document.querySelector('.composer'), rootLen: document.getElementById('root').innerHTML.length};})()",
    );
    assert.ok(afterCap.pop, '形状不符时容量面板仍应渲染（缺配额数据即降级）');
    assert.ok(afterCap.composer, '形状不符不得让输入区整个消失');
    assert.ok(afterCap.rootLen > 200, `工作台被卸载了（#root=${afterCap.rootLen}）`);
  } finally {
    if (cdp !== undefined) cdp.close();
    killChromeTree(proc, userDataDir);
    await server.close();
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* 锁未释放，交由 OS 回收 */
    }
  }
});
