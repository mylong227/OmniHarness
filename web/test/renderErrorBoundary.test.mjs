// 渲染错误边界门禁：渲染期抛错**不得**整页空白，必须降级为可读错误面板并留存现场。
//
// ## 背景（2026-09-27 用户两次报障「按 Enter 后整页空白」）
//
// React 在渲染期抛错且**没有错误边界**时会卸载整棵树 ⇒ 全黑空白页、没有任何线索。该缺陷在真机上
// 复现不到（同一 URL、短回合、带工具的回合都正常），故先按工程惯例兜住：加边界 + 留存现场。
//
// ## 判据（真浏览器 + CDP）
//
// 用内存路由把构建产物里的 `TopBar.js` 换成一进函数就抛错的版本（**只改测试夹具，不改产品代码**）：
//   ① `#root` 必须非空（页面不空白）；② 必须出现 `.crash-panel` 且文案含「界面渲染出错」与注入消息；
//   ③ 现场必须写进 `sessionStorage['omni-last-render-error']`；④ 点「重试」后仍在降级面板（不白屏）。
// 对照组（未注入）：边界不得误报，输入区正常挂载。
//
// 直跑：node --test web/test/renderErrorBoundary.test.mjs（需先 npm run web:build）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const HERE = dirname(fileURLToPath(import.meta.url));
const TOPBAR_JS = join(HERE, '..', 'dist', 'ui', 'components', 'TopBar.js');
const STUB = '_crash-boundary.html';
const NEEDLE = 'export function TopBar(props) {';
const INJECTED = '注入的渲染错误（错误边界用例）';

/**
 * 造一个「一渲染就抛错」的 TopBar 模块源码。
 * @returns {string} 打过补丁的模块源码。
 */
function patchedTopBar() {
  const src = readFileSync(TOPBAR_JS, 'utf8');
  assert.ok(
    src.includes(NEEDLE),
    `夹具失效：${TOPBAR_JS} 里找不到锚点「${NEEDLE}」（构建产物形态变了，请同步本测试）`,
  );
  return src.replace(NEEDLE, `${NEEDLE}\n    throw new Error('${INJECTED}');`);
}

/**
 * 起浏览器加载指定页面并返回度量。
 * @param {string} url 页面地址。
 * @returns {Promise<{state:object, cdp:object, proc:object, userDataDir:string, port:number}>} 会话与度量。
 */
async function open(url) {
  const browser = findBrowser();
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-crash-'));
  const port = await getFreePort();
  const proc = launchChromeForCdp(browser, url, userDataDir, port);
  const cdp = new CdpSession(await waitForPageWs(port, STUB));
  await cdp.waitFor("!!document.querySelector('#root')", 600);
  return { state: { cdp, proc, userDataDir, port }, cdp, proc, userDataDir, port };
}

/** 读取降级面板与现场。 @param {object} cdp CDP 会话。 @returns {Promise<object>} 度量。 */
function readCrash(cdp) {
  return cdp.evaluate(`(function(){
    var panel = document.querySelector('.crash-panel');
    var root = document.getElementById('root');
    var stored = null;
    try { stored = sessionStorage.getItem('omni-last-render-error'); } catch (e) { stored = 'ERR:' + e.message; }
    return {
      rootLen: root ? root.innerHTML.length : -1,
      hasPanel: !!panel,
      text: panel ? panel.textContent.slice(0, 240) : '',
      hasReload: !!document.querySelector('.crash-reload'),
      stored: stored,
      mounted: !!document.querySelector('.composer-input textarea')
    };
  })()`);
}

test('渲染期抛错 → 降级为可读面板（不整页空白），并留存现场；对照组不误报', async (t) => {
  const browser = findBrowser();
  if (browser === null) {
    t.skip('未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 后重跑');
    return;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('Node 缺全局 WebSocket（需 Node ≥22）');
    return;
  }
  const html = stubHtmlCdp();
  const server = await serveStatic(WEB_ROOT_PATH, { [`/${STUB}`]: html });
  const sessions = [];
  try {
    // ① 对照组：未注入 ⇒ 正常挂载、无降级面板
    const ok = await open(`http://127.0.0.1:${server.port}/${STUB}`);
    sessions.push(ok);
    await ok.cdp.waitFor("!!document.querySelector('.composer-input textarea')", 1200);
    const normal = await readCrash(ok.cdp);
    assert.ok(normal.mounted, '对照组：输入区应正常挂载');
    assert.ok(!normal.hasPanel, '对照组：不得误报渲染错误');

    // ② 实验组：把 TopBar 换成「一渲染就抛错」的版本
    await server.close();
    const crashServer = await serveStatic(WEB_ROOT_PATH, {
      [`/${STUB}`]: html,
      '/dist/ui/components/TopBar.js': patchedTopBar(),
    });
    try {
      const crash = await open(`http://127.0.0.1:${crashServer.port}/${STUB}`);
      sessions.push(crash);
      const seen = await crash.cdp.waitFor("!!document.querySelector('.crash-panel')", 600);
      const m = await readCrash(crash.cdp);
      assert.ok(seen && m.hasPanel, `注入渲染错误后必须出现降级面板（实测：${JSON.stringify(m)}）`);
      assert.ok(m.rootLen > 200, `页面不得空白（#root=${m.rootLen}）`);
      assert.match(m.text, /界面渲染出错/, '降级面板必须有可读标题');
      assert.ok(m.text.includes(INJECTED), '降级面板必须显示真实错误消息');
      assert.ok(m.hasReload, '降级面板必须提供「重新加载」出口');
      assert.ok(typeof m.stored === 'string' && m.stored.includes(INJECTED), '现场必须写进 sessionStorage');

      // ③ 点「重试」：仍会再次抛错（补丁还在），关键是不白屏、面板仍在
      await crash.cdp.click('.crash-retry');
      const again = await crash.cdp.waitFor("!!document.querySelector('.crash-panel')", 300);
      const after = await readCrash(crash.cdp);
      assert.ok(again && after.rootLen > 200, '重试后不得白屏（应仍在降级面板）');
    } finally {
      await crashServer.close();
    }
  } finally {
    for (const s of sessions) {
      s.cdp.close();
      killChromeTree(s.proc, s.userDataDir);
      try {
        rmSync(s.userDataDir, { recursive: true, force: true });
      } catch {
        /* 锁未释放，交由 OS 回收 */
      }
    }
    await server.close().catch(() => {});
  }
});
