// 弹层不得越出视口 / 不得被裁切祖先切掉（2026-09-27 用户报「页面被截断遮挡」的回归门禁）。
//
// ## 缺陷形态（真实，非假想）
//
// `.addmenu-pop` / `.cap-pop` 原先 `position:absolute; left:0; width:300/320px` 挂在**触发器**上
// （`.addmenu` 30px / `.cap` 107px，位于 `.composer-bar` 里会随 flex 排到右半侧）。于是弹层整体向右
// 展开，右边缘冲出视口——800×900 实测：`.addmenu-pop` 右边缘 **920px**（视口 800）、`.cap-pop`
// **826px**；再被可滚动列（`.col.center`，`overflow:auto`）裁掉右半边，文案在半个字上被切断。
//
// 修法：把定位基准从触发器换成整个 `.composer`（恒 ≳570px 宽）并水平居中，另加
// `width:min(320px, calc(100vw - 24px))` 兜底极窄窗口。
//
// ## 判据（比「没有横向滚动条」更严）
//
// ① 弹层四边必须落在视口内；② 弹层不得越出**任何**裁切祖先（`overflow != visible`）的边界——
// 只查 `documentElement.scrollWidth` 抓不到本缺陷（实测它恒等于视口宽，因为裁切发生在列容器上）。
// 三个宽度各测一次（窄窗是原先暴露问题的档位，1280 是常规桌面档）。
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

const STUB_NAME = '_popover-fit.html';
/** 逐档测：窄窗（原缺陷档）/ 中间档 / 桌面档。 */
const WIDTHS = [600, 800, 1280];
/** 视口高度（够弹层 60vh 展开）。 */
const HEIGHT = 900;

/**
 * 取出选择器命中的元素矩形，并列出把它裁掉的祖先（`overflow != visible` 且边界小于元素）。
 * @param {import('./browserHarness.mjs').CdpSession} cdp CDP 会话。
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

test('响应形状不符时弹层降级展示，而不是把整个工作台卸载（旧版服务端 ⇒ RPC 回落成 {}）', async (t) => {
  const browser = findBrowser();
  if (browser === null) {
    t.skip('未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 后重跑');
    return;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('Node 缺全局 WebSocket（需 Node ≥22）');
    return;
  }

  // 把三个「结构型」响应的载荷换成 `{}`（模拟服务端版本不匹配 / 方法不存在时的回落值）。
  const EMPTY_METHODS = ['quota.get', 'plugins.list', 'agents.list'];
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
  const html = baseHtml.replace(/<\/body>/i, `${override}</body>`);
  assert.notStrictEqual(html, baseHtml, '夹具改动失败：stub 页里没有 </body>');

  const server = await serveStatic(WEB_ROOT_PATH, { [`/${STUB_NAME}`]: html });
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-popfit-degrade-'));
  const cdpPort = await getFreePort();
  let cdp;
  let proc;
  try {
    proc = launchChromeForCdp(browser, `http://127.0.0.1:${server.port}/${STUB_NAME}`, userDataDir, cdpPort);
    cdp = new CdpSession(await waitForPageWs(cdpPort, STUB_NAME));
    await cdp.waitFor("!!document.querySelector('.composer-input textarea')", 1200);

    // 添加菜单：旧实现把 `plugins.list` 的 undefined 塞进 state ⇒ 点开即 `.length` 抛错、输入区整块消失。
    await cdp.click('.addmenu');
    await cdp.waitFor("!!document.querySelector('.addmenu-pop')", 300);
    const afterAdd = await cdp.evaluate(
      "(function(){return {pop: !!document.querySelector('.addmenu-pop'), composer: !!document.querySelector('.composer'), rootLen: document.getElementById('root').innerHTML.length};})()",
    );
    assert.ok(afterAdd.pop, '形状不符时添加菜单仍应渲染（降级为空目录）');
    assert.ok(afterAdd.composer, '形状不符不得让输入区整个消失');
    assert.ok(afterAdd.rootLen > 200, `工作台被卸载了（#root=${afterAdd.rootLen}）`);
    await cdp.click('.addmenu');

    // 上下文容量面板：`QuotaView` 会读 `status.plan.upgraded` ⇒ 旧实现在构造处抛错、整个工作台清空。
    await cdp.click('.cap');
    await cdp.waitFor("!!document.querySelector('.cap-pop')", 300);
    const afterCap = await cdp.evaluate(
      "(function(){return {pop: !!document.querySelector('.cap-pop'), composer: !!document.querySelector('.composer'), rootLen: document.getElementById('root').innerHTML.length};})()",
    );
    assert.ok(afterCap.pop, '形状不符时容量面板仍应渲染（缺配额数据即降级）');
    assert.ok(afterCap.composer, '形状不符不得让输入区整个消失');
    assert.ok(afterCap.rootLen > 200, `工作台被卸载了（#root=${afterCap.rootLen}）`);
    assertFits(await measure(cdp, '.cap-pop'), '上下文容量面板（降级态）', 800);
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

test('输入区弹层在窄/中/宽三档视口下都完整可见（不被视口或列容器裁切）', async (t) => {
  const browser = findBrowser();
  if (browser === null) {
    t.skip('未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 后重跑');
    return;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('Node 缺全局 WebSocket（需 Node ≥22）');
    return;
  }

  const server = await serveStatic(WEB_ROOT_PATH, { [`/${STUB_NAME}`]: stubHtmlCdp() });
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-popfit-ud-'));
  const cdpPort = await getFreePort();
  let cdp;
  let proc;
  try {
    proc = launchChromeForCdp(browser, `http://127.0.0.1:${server.port}/${STUB_NAME}`, userDataDir, cdpPort);
    cdp = new CdpSession(await waitForPageWs(cdpPort, STUB_NAME));

    for (const width of WIDTHS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.navigate(`http://127.0.0.1:${server.port}/${STUB_NAME}`);
      await cdp.waitFor("!!document.querySelector('.composer-input textarea')", 1200);

      // ① 添加菜单（+）
      await cdp.click('.addmenu');
      await cdp.waitFor("!!document.querySelector('.addmenu-pop')", 200);
      assertFits(await measure(cdp, '.addmenu-pop'), '添加菜单', width);
      await cdp.click('.addmenu'); // 关掉
      await cdp.waitFor("!document.querySelector('.addmenu-pop')", 200);

      // ② 上下文容量面板（📊）
      const hasCap = await cdp.evaluate("!!document.querySelector('.cap')");
      assert.ok(hasCap, `${width}px：上下文容量触发器 .cap 未渲染（stub 数据缺失？）`);
      await cdp.click('.cap');
      await cdp.waitFor("!!document.querySelector('.cap-pop')", 200);
      assertFits(await measure(cdp, '.cap-pop'), '上下文容量面板', width);
      await cdp.click('.cap');
      await cdp.waitFor("!document.querySelector('.cap-pop')", 200);

      // ③ 兜底：整个文档不得横向溢出（弹层修好前由列容器裁切，这条恒绿，故只作附加守卫）
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
