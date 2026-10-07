// 对话区稳定性门禁（真浏览器 + CDP + 一条源码级守卫）：
//   ① SSE 徽标三态：瞬时抖动显示「重连中」（黄），**不闪红「断开」**；超过宽限期才判「断开」；
//   ② 重连成功必须清掉宽限定时器（不能在 4s 后把已经恢复的连接刷成断开）；
//   ③ 源码守卫：`.ev` 不得再挂入场动画（虚拟化列表会反复重挂块 ⇒ 动画重放 ⇒ 对话区一直闪）。
//
// ## 背景（2026-09-27 用户报「上下文显示区会出现一直闪，同时显示区域会出现显示断开」）
//
// 两处机制性成因（实测）：
//   · 中栏是**虚拟化列表**（`StreamWindow` + `BlockHeightIndex`：只有滚动窗口内的块在 DOM 里），
//     窗口随内容高度重算而滑动 ⇒ 块被反复卸载/重挂；而 `.ev` 曾带 `animation:fade .22s`，
//     CSS 动画在重新插入时**重放**（opacity 0→1）⇒ 视觉上「一直在闪」，块短暂消失又被读成「显示断开」。
//   · 徽标 `connected` 原先在 `EventSource.onerror` 一触发就翻成红色「断开」；而 EventSource 本就
//     自动重连（服务端 `retry: 1000`），任何瞬时抖动都会闪一下红 ⇒ 假故障。改为三态 + 4s 宽限。
//
// 直跑：node --test web/test/streamStability.test.mjs（需先 npm run web:build）。
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
const CHAT_CSS = join(HERE, '..', 'styles', 'chat.css');
const STUB = '_stream-stability.html';

/** 读徽标文案与配色类。 @param {object} cdp CDP 会话。 @returns {Promise<object>} 度量。 */
function readBadge(cdp) {
  return cdp.evaluate(`(function(){
    var pill = document.querySelector('.side-foot .pill');
    return pill ? { text: pill.textContent.trim(), cls: pill.className, sources: (window.__SOURCES__||[]).length } : null;
  })()`);
}

test('SSE 徽标三态（重连中不闪红）+ .ev 不得再有入场动画', { timeout: 60_000 }, async (t) => {
  // ③ 源码守卫：先做无第三方依赖的那条（不依赖浏览器）。
  const css = readFileSync(CHAT_CSS, 'utf8');
  const evRule = /(^|\n)\.ev\s*\{([^}]*)\}/.exec(css);
  assert.ok(evRule !== null, 'chat.css 里找不到 .ev 规则（口径变了，请同步本测试）');
  assert.ok(
    !/animation\s*:/.test(evRule[2]),
    '.ev 不得挂入场动画：中栏是虚拟化列表，块会反复重挂 ⇒ 动画重放 ⇒ 对话区一直闪（曾用 animation:fade）',
  );

  const browser = findBrowser();
  if (browser === null) {
    t.skip('未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 后重跑');
    return;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('Node 缺全局 WebSocket（需 Node ≥22）');
    return;
  }

  const server = await serveStatic(WEB_ROOT_PATH, { [`/${STUB}`]: stubHtmlCdp() });
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-badge-'));
  const cdpPort = await getFreePort();
  const proc = launchChromeForCdp(browser, `http://127.0.0.1:${server.port}/${STUB}`, userDataDir, cdpPort);
  let cdp;
  try {
    cdp = new CdpSession(await waitForPageWs(cdpPort, STUB));
    await cdp.waitFor("!!document.querySelector('.composer-input textarea')", 1200);
    // ① 首次连接成功 → 已连接（绿）
    assert.ok(
      await cdp.waitFor("((document.querySelector('.side-foot .pill')||{}).textContent||'').trim() === '已连接'", 600),
      'SSE 打开后徽标应为「已连接」',
    );
    const open = await readBadge(cdp);
    assert.match(open.cls, /pill on/, '已连接时 pill 应带 on 类（绿）');

    // ② 瞬时抖动：先「重连中」（黄），绝不立刻变「断开」
    await cdp.evaluate("(function(){ var es=(window.__SOURCES__||[])[0]; if(!es) return 'no-source'; es.onerror({}); return 'ok'; })()");
    const transient = await cdp.waitFor("((document.querySelector('.side-foot .pill')||{}).textContent||'').trim() === '重连中'", 200);
    assert.ok(transient, '瞬时抖动后徽标应为「重连中」');
    const mid = await readBadge(cdp);
    assert.match(mid.cls, /pill warn/, '重连中时 pill 应带 warn 类（黄）');
    assert.doesNotMatch(mid.text, /断开/, '瞬时抖动**不得**显示成「断开」（这正是用户看到的假故障）');

    // ③ 宽限期内重连成功 → 回到「已连接」，且此后不会因旧定时器再刷成「断开」
    await cdp.evaluate("(function(){ var es=(window.__SOURCES__||[])[0]; es.readyState = 1; if (es.onopen) es.onopen({}); return true; })()");
    assert.ok(
      await cdp.waitFor("((document.querySelector('.side-foot .pill')||{}).textContent||'').trim() === '已连接'", 200),
      '重连成功后徽标应回到「已连接」',
    );
    await new Promise((r) => setTimeout(r, 4500)); // 越过 4s 宽限期：旧定时器必须已被清掉
    const afterGrace = await readBadge(cdp);
    assert.strictEqual(afterGrace.text, '已连接', '重连成功后的宽限定时器必须被清掉（不得 4s 后刷成断开）');

    // ④ 真断线：抖动后再不恢复 → 宽限期到点后落成「断开」（证明三态不是「永远重连中」）
    await cdp.evaluate("(function(){ var es=(window.__SOURCES__||[])[0]; es.readyState = 0; es.onerror({}); return true; })()");
    assert.ok(
      await cdp.waitFor("((document.querySelector('.side-foot .pill')||{}).textContent||'').trim() === '断开'", 1200),
      '宽限期内未恢复应落成「断开」',
    );
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
