// E1：浏览器验证 / computer use（CDP 路线，零依赖）。
//
// 可证伪验收（同 board E1 行）：CDP 驱动本机已装浏览器做「截图 → 视觉核对 → 操作回环」一例。
// 本例用 Node 22 内置 WebSocket 直连 Chrome DevTools Protocol，全程不引入任何浏览器自动化库：
//   1. 启动零依赖静态服务 + 注入假后端的 stub 页（与 D3 同源）；
//   2. 以 `--remote-debugging-port` 起 headless Chrome，直连 page target 的 CDP WebSocket；
//   3. 截图（Page.captureScreenshot）作为「视觉核对」首帧；
//   4. 视觉核对：用 Runtime.evaluate 读取关键 DOM 结构（React 已挂载 / composer / send / #root 内容量）；
//   5. 操作回环：真实 CDP 键入 + 点击 send（Input.dispatchMouseEvent）→ 断言 clicks 触达 app（RPC turns.run）；
//      再推假后端 SSE 事件驱动流式 → 断言 app 对回环产生反应（流式卡片出现）；
//   6. 回环后再截图，断言状态已变（流式文本合入）。
// 无浏览器时显式 skip（不伪装通过）；可用 OMNI_CHROME_PATH 指定浏览器。调试：OMNI_E2E_VERBOSE=1。

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
  waitForPageWs,
  CdpSession,
  WEB_ROOT_PATH,
} from './browserHarness.mjs';

const STUB_NAME = '_e2e-stub-cdp.html';

test('E1 CDP：截图 → 视觉核对 → 操作回环（本机 Chrome，零依赖）', async (t) => {
  const browser = findBrowser();
  if (!browser) {
    t.skip('未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 指定浏览器可执行文件后重跑');
    return;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('Node 缺全局 WebSocket（需 Node >= 22）');
    return;
  }

  const server = await serveStatic(WEB_ROOT_PATH, { [`/${STUB_NAME}`]: stubHtmlCdp() });
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-cdp-ud-'));
  const shotDir = mkdtempSync(join(tmpdir(), 'omni-cdp-shots-'));
  let cdp;
  let proc;
  try {
    const port = await getFreePort();
    const url = `http://127.0.0.1:${server.port}/${STUB_NAME}`;
    proc = launchChromeForCdp(browser, url, userDataDir, port);
    const wsUrl = await waitForPageWs(port, STUB_NAME);
    cdp = new CdpSession(wsUrl);

    const mounted = await cdp.waitMounted();
    assert.ok(mounted, 'E1 失败：app 未挂载（CDP 路线）');

    // ① 截图首帧
    const shot1 = join(shotDir, 'e2e-cdp-1.png');
    const len1 = await cdp.screenshot(shot1);
    assert.ok(len1 > 1024, 'E1 失败：首帧截图过小，疑似空白页（len=' + len1 + '）');

    // ② 视觉核对（结构）：关键 DOM 节点存在、React 已挂载
    const visual = await cdp.evaluate(`(function(){
      return {
        react: typeof window.React,
        composer: document.querySelectorAll('.composer-input textarea').length,
        send: document.querySelectorAll('button.send').length,
        rootLen: (document.getElementById('root') || { innerHTML: '' }).innerHTML.length
      };
    })()`);
    assert.strictEqual(visual.composer, 1, 'E1 视觉核对失败：composer textarea 缺失');
    assert.strictEqual(visual.send, 1, 'E1 视觉核对失败：send 按钮缺失');
    assert.ok(visual.rootLen > 500, 'E1 视觉核对失败：#root 内容过少（app 可能未渲染，len=' + visual.rootLen + '）');

    // ③ 操作回环：真实 CDP 键入 + 点击 send
    await cdp.type('.composer-input textarea', '给我写一个文件');
    await cdp.click('button.send');
    const dispatched = await cdp.waitFor(
      "window.__RPC_CALLS__ && window.__RPC_CALLS__.some(function(c){ return c.method === 'turns.run'; })",
    );
    assert.ok(dispatched, 'E1 失败：CDP 点击 send 未触达 turns.run（输入未真正到达 app）');

    // 驱动流式（假后端事件），验证 app 对回环产生反应
    await cdp.push({ method: 'thread.text_delta', params: { text: '正在分析…' } });
    const streaming = await cdp.waitFor("!!document.querySelector('.streaming-assistant .content')");
    assert.ok(streaming, 'E1 失败：流式卡片未出现（app 未响应操作回环）');

    // ④ 回环后再截图 + 状态变化断言
    const shot2 = join(shotDir, 'e2e-cdp-2.png');
    const len2 = await cdp.screenshot(shot2);
    assert.ok(len2 > 1024, 'E1 失败：回环后截图过小（len=' + len2 + '）');

    const after = await cdp.evaluate(
      "document.querySelector('.streaming-assistant .content') ? document.querySelector('.streaming-assistant .content').textContent : ''",
    );
    assert.strictEqual(after, '正在分析…', 'E1 失败：回环后流式文本未合入（after=' + after + '）');

    if (process.env.OMNI_E2E_VERBOSE === '1') {
      console.error(`[e1-cdp] shots: ${shot1} (${len1}B), ${shot2} (${len2}B)`);
    }
  } finally {
    if (cdp) cdp.close();
    if (proc) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    await server.close();
    // Chrome 退出瞬时可能仍持 user-data-dir 锁（Affiliation Database 等），
    // 强行同步 rm 会 EBUSY 误判失败；改为尽力而为，残目录交由 OS 回收。
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* 锁未释放，忽略 */
    }
    try {
      rmSync(shotDir, { recursive: true, force: true });
    } catch {
      /* 同上 */
    }
  }
});
