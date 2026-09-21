// 逐块真实高度 —— 真机探针（零依赖，真实浏览器）：把 OmniHarness Web UI 在一台真 Chrome 里
// 推成一個「长短不一」的长会话，验证：
//   1) 虚拟窗口确实生效（data-rendered-count 远小于 data-total-count，DOM 里只挂有限个 .sw-block）；
//   2) 滚动条总高来自「真实高度累加」而非 index×估算（scrollHeight 与 N×88 明显不同）；
//   3) 测量容器 .sw-block 真实存在（真实高度路径已接线，不是死代码）；
//   4) 截图存档到 web/archive/（真机视觉留档）。
//
// 这是探针而非门禁：发现异常也 exit 0；找不到浏览器则打印 SKIP 并 exit 0。
// 路线与 responsiveProbe.mjs 完全同源（复用 ./browserHarness.mjs）。
// 用法：node web/test/virtualProbe.mjs
// 环境变量：OMNI_CHROME_PATH 指定浏览器；OMNI_PROBE_WS 直连既有 CDP page target。

import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
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

const STUB_NAME = '_virtual-probe-stub.html';
const HEIGHT = 900;
const N = 200;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 受限沙箱回退启动器：stdio 改 'ignore'（同 responsiveProbe 口径）。 */
function launchChromeNoPipe(browser, url, userDataDir, port) {
  const args = [
    '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox',
    '--no-proxy-server', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-crash-reporter', '--disable-breakpad',
    '--user-data-dir=' + userDataDir, '--window-size=1280,860',
    '--remote-debugging-port=' + port, url,
  ];
  return spawn(browser, args, { stdio: 'ignore' });
}

/** 造 N 条「长短极度不均」的事件：每 3 条一个超长 assistant，其余短 system / 工具簇。 */
function makeEvents(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i % 3 === 0) {
      // 超长 markdown 回复：高度远大于估算 88px。
      const para = '段落' + i + '：' + new Array(40).fill('这是一段会被渲染成多行的较长文本，用于制造真实的块高度差异。').join('');
      out.push({ id: 'a' + i, type: 'assistant', timestamp: i, payload: { content: '# 长回复 ' + i + '\n\n' + para + '\n\n' + para } });
    } else if (i % 5 === 0) {
      out.push({ id: 't' + i, type: 'tool_call', timestamp: i, payload: { callId: 'c' + i, name: 'read_file', args: { path: 'src/very/deep/module-' + i + '.ts' } } });
      out.push({ id: 'r' + i, type: 'tool_result', timestamp: i, payload: { callId: 'c' + i, ok: true, text: '读取成功' } });
    } else {
      out.push({ id: 's' + i, type: 'system', timestamp: i, payload: { content: '短事件 ' + i } });
    }
  }
  return out;
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    process.stdout.write('SKIP: browser not found\n');
    return 0;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    process.stdout.write('SKIP: Node 缺全局 WebSocket（需 Node >= 22）\n');
    return 0;
  }
  const externalWs = process.env.OMNI_PROBE_WS || '';
  const server = await serveStatic(WEB_ROOT_PATH, { [`/${STUB_NAME}`]: stubHtmlCdp() });
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-virtual-ud-'));
  let cdp;
  let proc;
  let port = 0;
  try {
    let wsUrl = externalWs;
    if (!wsUrl) {
      port = await getFreePort();
      const url = `http://127.0.0.1:${server.port}/${STUB_NAME}`;
      try {
        proc = launchChromeForCdp(browser, url, userDataDir, port);
      } catch (err) {
        if (!/EPERM/.test(String(err && err.message))) throw err;
        emit({ kind: 'launch-fallback', reason: 'spawn EPERM', used: 'launchChromeNoPipe' });
        proc = launchChromeNoPipe(browser, url, userDataDir, port);
      }
      try {
        proc.on('error', () => {});
        wsUrl = await waitForPageWs(port, STUB_NAME, Number(process.env.OMNI_PROBE_WAIT_MS || 12000));
      } catch (err) {
        emit({ kind: 'error', message: '无法启动浏览器：' + String((err && err.message) || err) });
        return 0;
      }
    }
    cdp = new CdpSession(wsUrl);
    const mounted = await cdp.waitMounted(1200);
    if (!mounted) throw new Error('app 未挂载');

    // 建立 SSE 连接：发一条消息触发 turns.run，再用 __RESOLVE_TURN__ 收尾，使 app 进入有 thread 的渲染态。
    await cdp.evaluate("(function(){ var ta=document.querySelector('.composer-input textarea'); var send=document.querySelector('button.send'); if(ta&&send){ ta.value='探针长会话'; send.click(); } })()");
    await cdp.waitFor("!!window.__RESOLVE_TURN__ && document.querySelectorAll('.composer-input textarea').length>0", 600);
    await cdp.evaluate("if(window.__RESOLVE_TURN__) window.__RESOLVE_TURN__({ threadId:'t-probe', finalText:'', steps:1 });");

    // 推 N 条事件（长短不均）。
    const events = makeEvents(N);
    for (const ev of events) {
      await cdp.push({ method: 'thread.event', params: { event: ev } });
    }
    const ok = await cdp.waitFor(
      "var s=document.querySelector('.stream'); s && Number(s.getAttribute('data-total-count'))>=" + N,
      800,
    );
    if (!ok) {
      emit({ kind: 'warn', message: '事件未全部渲染（app 可能未进入 thread 渲染态）' });
    }

    // 滚到中部，逼出 padTop > 0，验证虚拟化与真实高度路径。
    await cdp.evaluate("(function(){ var s=document.querySelector('.stream'); if(s){ s.scrollTop = s.scrollHeight * 0.55; s.dispatchEvent(new Event('scroll')); } })()");
    await new Promise((r) => setTimeout(r, 300));

    const m = await cdp.evaluate(`(function(){
      var s = document.querySelector('.stream');
      var total = s ? Number(s.getAttribute('data-total-count')) : 0;
      var rendered = s ? Number(s.getAttribute('data-rendered-count')) : 0;
      var blocks = document.querySelectorAll('.sw-block').length;       // 测量容器真实存在 = 真实高度路径已接线
      var heights = Array.prototype.map.call(document.querySelectorAll('.sw-block'), function(b){ return Math.round(b.getBoundingClientRect().height); });
      var varied = new Set(heights).size > 3;                            // 真实高度确实在变，不是统一 88
      return {
        total: total,
        rendered: rendered,
        blocks: blocks,
        scrollHeight: s ? s.scrollHeight : 0,
        uniformHeight: ${N} * ${88},
        maxBlock: heights.length ? Math.max.apply(null, heights) : 0,
        varied: varied
      };
    })()`);
    emit({ kind: 'measure', ...m });

    const verdict = {
      totalReached: m.total >= N,
      virtualized: m.rendered > 0 && m.rendered < m.total, // 渲染块数远小于总数
      wrapperWired: m.blocks > 0 && m.blocks <= m.rendered + 1, // .sw-block 与渲染块一一对应
      realHeightsUsed: Math.abs(m.scrollHeight - m.uniformHeight) > m.uniformHeight * 0.2, // 总高明显偏离 N×88
      varied: m.varied,
    };
    emit({ kind: 'verdict', verdict });

    // 真机截图存档：1280 全量 + 顶部；640 抽屉态各一张。
    const stamp = Date.now();
    const shots = [];
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 200));
    shots.push(await cdp.screenshot(join(WEB_ROOT_PATH, 'archive', 'virtual-1280-' + stamp + '.png')));
    await cdp.evaluate("(function(){ var s=document.querySelector('.stream'); if(s){ s.scrollTop=0; s.dispatchEvent(new Event('scroll')); } })()");
    await new Promise((r) => setTimeout(r, 200));
    shots.push(await cdp.screenshot(join(WEB_ROOT_PATH, 'archive', 'virtual-1280-top-' + stamp + '.png')));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 300));
    shots.push(await cdp.screenshot(join(WEB_ROOT_PATH, 'archive', 'virtual-640-' + stamp + '.png')));
    emit({ kind: 'screenshots', files: ['virtual-1280-' + stamp + '.png', 'virtual-1280-top-' + stamp + '.png', 'virtual-640-' + stamp + '.png'], bytes: shots });
  } catch (err) {
    emit({ kind: 'error', message: String((err && err.message) || err) });
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
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* Chrome 退出瞬时仍可能持锁，交由 OS 回收 */
    }
  }
  return 0;
}

process.exitCode = await main();
