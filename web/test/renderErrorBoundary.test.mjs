// 渲染错误边界门禁：渲染期抛错**不得**整页空白，必须降级为可读错误面板（含组件栈）并留存现场。
//
// ## 背景（2026-09-27 用户两次报障「按 Enter 后整页空白」）
//
// React 在渲染期抛错且**没有错误边界**时会卸载整棵树 ⇒ 全黑空白页、没有任何线索。加上边界后，
// 用户在真机上复现时拿到了 `Illegal invocation`（原生方法被脱离宿主调用）——但该消息本身不含位置，
// 只有**组件栈**能定位，故降级面板必须把组件栈显示出来（本用例对此有断言）。
//
// ## 判据（真浏览器 + CDP）
//
// 用内存路由把构建产物里的 `SessionPanel.js` 换成一进函数就抛错的版本（**只改测试夹具，不改产品代码**）：
//   ① `#root` 必须非空（页面不空白）；② 必须出现 `.crash-panel`，且含「界面渲染出错」+ 注入消息 +
//   **组件栈（位置：… SessionPanel …）**；③ 现场必须写进 `sessionStorage['omni-last-render-error']`；
//   ④ 点「重试」后仍在降级面板（不白屏）。对照组（未注入）：边界不得误报，输入区正常挂载。
//
// **性能约束**：`npm run web:test` 并行跑 23 个文件，真机 CDP 用例一多就会互相争抢（实测本文件
// 「两服务器 + 两 Chrome」的写法在并行档里被挤过 30s 预算）。故这里**只起一个服务器、一次 Chrome**，
// 用两次导航分别验证对照组与注入组；两个页面用不同路由共存于同一服务器（补丁路由只被注入页加载）。
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
const CRASH_JS = join(HERE, '..', 'dist', 'ui', 'components', 'SessionPanel.js');
const OK_PAGE = '_boundary-ok.html';
const CRASH_PAGE = '_boundary-crash.html';
const NEEDLE = 'export function SessionPanel(props) {';
const INJECTED = '注入的渲染错误（错误边界用例）';

/**
 * 造一个「一渲染就抛错」的 SessionPanel 模块源码。
 * @returns {string} 打过补丁的模块源码。
 */
function patchedCrashModule() {
  const src = readFileSync(CRASH_JS, 'utf8');
  assert.ok(
    src.includes(NEEDLE),
    `夹具失效：${CRASH_JS} 里找不到锚点「${NEEDLE}」（构建产物形态变了，请同步本测试）`,
  );
  return src.replace(NEEDLE, `${NEEDLE}\n    throw new Error('${INJECTED}');`);
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
      text: panel ? panel.textContent.slice(0, 300) : '',
      hasReload: !!document.querySelector('.crash-reload'),
      hasCopy: !!document.querySelector('.crash-copy'),
      stored: stored,
      mounted: !!document.querySelector('.composer-input textarea')
    };
  })()`);
}

test('渲染期抛错 → 降级为可读面板（含组件栈、不整页空白）；对照组不误报', { timeout: 120_000 }, async (t) => {
  const browser = findBrowser();
  if (browser === null) {
    t.skip('未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 后重跑');
    return;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('Node 缺全局 WebSocket（需 Node ≥22）');
    return;
  }

  // 两个静态服务器（对照组用未打补丁的产物、注入组用打补丁的 SessionPanel），但**只起一次 Chrome**：
  // 服务器很便宜，Chrome 启动才是并行档里的瓶颈（实测两 Chrome → 被挤过 30s 预算）。
  const html = stubHtmlCdp();
  const controlServer = await serveStatic(WEB_ROOT_PATH, {
    [`/${OK_PAGE}`]: html,
    '/dist/ui/components/SessionPanel.js': readFileSync(CRASH_JS, 'utf8'),
  });
  const crashServer = await serveStatic(WEB_ROOT_PATH, {
    [`/${CRASH_PAGE}`]: html,
    '/dist/ui/components/SessionPanel.js': patchedCrashModule(),
  });
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-crash-'));
  const port = await getFreePort();
  const proc = launchChromeForCdp(
    browser,
    `http://127.0.0.1:${controlServer.port}/${OK_PAGE}`,
    userDataDir,
    port,
  );
  let cdp;
  try {
    cdp = new CdpSession(await waitForPageWs(port, OK_PAGE, 60_000));

    // ① 对照组：未注入 ⇒ 正常挂载、无降级面板
    await cdp.waitFor("!!document.querySelector('.composer-input textarea')", 1200);
    const normal = await readCrash(cdp);
    assert.ok(normal.mounted, '对照组：输入区应正常挂载');
    assert.ok(!normal.hasPanel, '对照组：不得误报渲染错误');

    // ② 注入组：同一浏览器导航到「SessionPanel 会抛错」的页面
    await cdp.navigate(`http://127.0.0.1:${crashServer.port}/${CRASH_PAGE}`);
    const seen = await cdp.waitFor("!!document.querySelector('.crash-panel')", 1200);
    await cdp.waitFor("!!document.querySelector('.crash-where')", 200);
    const m = await readCrash(cdp);
    assert.ok(seen && m.hasPanel, `注入渲染错误后必须出现降级面板（实测：${JSON.stringify(m)}）`);
    assert.ok(m.rootLen > 200, `页面不得空白（#root=${m.rootLen}）`);
    assert.match(m.text, /界面渲染出错/, '降级面板必须有可读标题');
    assert.ok(m.text.includes(INJECTED), '降级面板必须显示真实错误消息');
    // 组件栈必须**显示在面板上**：`Illegal invocation` 这类消息本身不含位置，只有组件栈能定位。
    assert.ok(m.text.includes('位置：'), '降级面板必须显示出错位置（组件栈）');
    assert.ok(m.text.includes('SessionPanel'), `组件栈必须指到抛错组件（实测：${m.text.slice(0, 200)}）`);
    assert.ok(m.hasReload && m.hasCopy, '降级面板必须提供「重新加载」与「复制详情」出口');
    assert.ok(typeof m.stored === 'string' && m.stored.includes(INJECTED), '现场必须写进 sessionStorage');

    // ③ 点「重试」：仍会再次抛错（补丁还在），关键是不白屏、面板仍在
    await cdp.click('.crash-retry');
    const again = await cdp.waitFor("!!document.querySelector('.crash-panel')", 600);
    const after = await readCrash(cdp);
    assert.ok(again && after.rootLen > 200, '重试后不得白屏（应仍在降级面板）');
  } finally {
    if (cdp !== undefined) cdp.close();
    killChromeTree(proc, userDataDir);
    await controlServer.close();
    await crashServer.close();
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* 锁未释放，交由 OS 回收 */
    }
  }
});
