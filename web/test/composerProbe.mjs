// 输入区几何与配色诊断：在真 Chrome 里打印 .composer / .composer-box / textarea 的
// 实际计算样式与盒模型，用来定位"框里还有一块更亮的框"到底是哪一层。
//
// 为什么需要它：这类"看起来亮/看起来厚"的问题，靠读 CSS 猜层容易错——同一处可能被
// 5 个层叠文件写过，还可能被伪类/继承影响。把浏览器的 computedStyle 打出来是唯一可靠的口径。
// 路由与 visualProbe / responsiveProbe 同源（复用 browserHarness 与假后端 stub 页）。
//
// 这是探针而非门禁：异常也 exit 0。
// 用法：node web/test/composerProbe.mjs [--focus]

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireBrowser } from './browserSwitch.mjs';
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

const STUB_NAME = '_composer-probe-stub.html';
const HEIGHT = 900;
const WIDTH = 1280;

/** 打印一行 JSON（stdout，机器可读）。 */
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
    '--user-data-dir=' + userDataDir, '--window-size=' + WIDTH + ',' + HEIGHT,
    '--remote-debugging-port=' + port, url,
  ];
  return spawn(browser, args, { stdio: 'ignore' });
}

import { spawn } from 'node:child_process';

/**
 * 采集表达式：把 composer 四层的计算样式与矩形打平。
 * CDP evaluate 接收的是**表达式**，裸对象字面量会被当语句块解析 ⇒ 必须用括号包起来。
 * @returns {string} 可直接 evaluate 的表达式
 */
function probeExpr() {
  return `(() => {
    const pick = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 40),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        bg: cs.backgroundColor,
        border: cs.borderTopWidth + '|' + cs.borderTopStyle + '|' + cs.borderTopColor,
        radius: cs.borderTopLeftRadius,
        outline: cs.outlineWidth + '|' + cs.outlineStyle + '|' + cs.outlineColor,
        outlineOffset: cs.outlineOffset,
        boxShadow: cs.boxShadow,
      };
    };
    /* 元素命中测试：沿 textarea 上缘往左扫，把"那一圈可见描边"落到具体元素上。
       这是"看起来有个框但读 CSS 找不到来源"时唯一可靠的办法——比逐层猜快得多。 */
    const hits = (el) => {
      if (!el) return [];
      const r = el.getBoundingClientRect();
      const out = [];
      const probes = [
        [r.left - 1, r.top + r.height / 2, 'left'],
        [r.right + 1, r.top + r.height / 2, 'right'],
        [r.left + r.width / 2, r.top - 1, 'top'],
        [r.left + r.width / 2, r.bottom + 1, 'bottom'],
      ];
      for (const [x, y, side] of probes) {
        const node = document.elementFromPoint(x, y);
        out.push({
          side,
          at: [Math.round(x), Math.round(y)],
          el: node ? node.tagName.toLowerCase() + '.' + String(node.className || '').slice(0, 30) : null,
        });
      }
      return out;
    };
    /* 侧栏会话行：探针夹具里没有真实会话，就按真实 DOM（SessionViews.tsx:338 的结构）
       造一行出来读级联——这是"白底灰字"这类问题的唯一可靠口径：颜色由 5 个层叠文件
       共同决定，读 CSS 容易判错谁赢。 */
    const ta = document.querySelector('.composer textarea, .composer-input textarea');
    /* 模型/强度入口（.mp）的内部几何：这里量的是"两段文案有没有互相压住"。
       2026-10-17 实测到过真重叠（模型名与强度叠在一起）——读 CSS 看不出来，
       因为根因是 flex 收缩 + 绝对定位的组合，量 rect 才现形。 */
    const mpParts = (() => {
      const mp = document.querySelector('.composer .mp');
      if (!mp) return null;
      const parts = ['.mp', '.mp-ico', '.mp-label', '.mp-sub', '.mp-caret'].map((sel) => {
        const el = sel === '.mp' ? mp : mp.querySelector(sel.replace('.mp-', '.mp-').replace('.mp', '.mp'));
        if (!el) return { sel, missing: true };
        const r = el.getBoundingClientRect();
        return {
          sel,
          text: String(el.textContent || '').trim().slice(0, 20),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          right: Math.round(r.right),
          display: getComputedStyle(el).display,
          position: getComputedStyle(el).position,
        };
      });
      const rect = mp.getBoundingClientRect();
      return { box: [Math.round(rect.x), Math.round(rect.width)], parts };
    })();
    const host = document.createElement('div');
    host.className = 'col left side';
    host.style.cssText = 'position:fixed;left:0;top:0;width:240px;z-index:99999';
    host.innerHTML =
      '<div class="session active">' +
      '<span class="drag-handle">&#10495;</span>' +
      '<span class="session-label">当前会话</span>' +
      '<span class="session-time">23小时</span>' +
      '</div>' +
      '<div class="session"><span class="session-label">普通会话</span>' +
      '<span class="session-time">1天</span></div>';
    document.body.appendChild(host);
    const sessionRows = Array.from(host.querySelectorAll('.session')).map((row) => {
      const cs = getComputedStyle(row);
      const time = row.querySelector('.session-time');
      const tcs = time ? getComputedStyle(time) : null;
      const label = row.querySelector('.session-label');
      return {
        cls: String(row.className),
        rowBg: cs.backgroundColor,
        rowColor: cs.color,
        labelColor: label ? getComputedStyle(label).color : null,
        timeColor: tcs ? tcs.color : null,
        timeOpacity: tcs ? tcs.opacity : null,
      };
    });
    const activeRow = host.querySelector('.session.active');
    const activeStyles = activeRow
      ? { cls: String(activeRow.className), bg: getComputedStyle(activeRow).backgroundColor, color: getComputedStyle(activeRow).color }
      : null;
    const activeChildren = activeRow
      ? Array.from(activeRow.querySelectorAll('*')).slice(0, 8).map((el) => {
          const cs = getComputedStyle(el);
          return {
            el: el.tagName.toLowerCase() + '.' + String(el.className || '').slice(0, 22),
            color: cs.color,
            opacity: cs.opacity,
            text: String(el.textContent || '').trim().slice(0, 6),
          };
        })
      : [];
    host.remove();
    /* 其余「反白块」容器一并体检：只要容器被反白，任何"被旧层单独点名过颜色"的后代
       都可能留在原地变成不可读（session-label 就是这么被抓到的）。这里把每个反白块
       连同它的典型后代造出来，逐个报告 前景/背景 是否同色。 */
    const inverted = [
      ['rail-btn active', '.rail', '<button class="rail-btn active"><span class="rail-icon">x</span></button>'],
      ['cmdk-item active', '.cmdk', '<div class="cmdk-item active"><span class="cmdk-item-title">标题</span><span class="cmdk-hint">⌘K</span></div>'],
      ['dd-item active', '.dd-menu', '<div class="dd-item active"><span class="dd-ico">i</span>项</div>'],
      ['addmenu-item active', '.addmenu', '<div class="addmenu-item active"><span class="addmenu-item-ico">i</span><span class="addmenu-item-label">标签</span></div>'],
      ['pp-item active', '.pp-menu', '<button class="pp-item active"><span class="pp-ico">i</span><span class="pp-title">面板</span></button>'],
    ];
    const invertedReport = inverted.map(([name, wrapperCls, html]) => {
      const wrap = document.createElement('div');
      wrap.className = String(wrapperCls).replace('.', '');
      wrap.style.cssText = 'position:fixed;left:0;top:0;z-index:99999';
      wrap.innerHTML = html;
      document.body.appendChild(wrap);
      const root = wrap.querySelector('*');
      const cs = root ? getComputedStyle(root) : null;
      const kids = root
        ? Array.from(root.querySelectorAll('*')).slice(0, 5).map((el) => {
            const k = getComputedStyle(el);
            return { el: el.tagName.toLowerCase() + '.' + String(el.className || '').slice(0, 20), color: k.color, bg: k.backgroundColor };
          })
        : [];
      const out = { name, bg: cs ? cs.backgroundColor : null, color: cs ? cs.color : null, kids };
      wrap.remove();
      return out;
    });
    return {
      composer: pick(document.querySelector('.composer')),
      box: pick(document.querySelector('.composer-box')),
      input: pick(document.querySelector('.composer-input')),
      textarea: pick(ta),
      focused: document.activeElement === ta,
      hitsAroundTextarea: hits(ta),
      mpParts,
      sessionRows,
      activeStyles,
      activeChildren,
      invertedReport,
    };
  })()`;
}

/**
 * 探针主流程：两套主题 × 静态/聚焦两态。
 * @returns {Promise<number>} 退出码
 */
async function main() {
  const browser = findBrowser();
  if (!browser) {
    process.stdout.write('SKIP: browser not found\n');
    return requireBrowser() ? 1 : 0;
  }
  const server = await serveStatic(WEB_ROOT_PATH, { [`/${STUB_NAME}`]: stubHtmlCdp() });
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-composer-ud-'));
  let cdp;
  let proc;
  let exitCode = 0;
  try {
    const port = await getFreePort();
    const url = `http://127.0.0.1:${server.port}/${STUB_NAME}`;
    try {
      proc = launchChromeForCdp(browser, url, userDataDir, port);
    } catch (err) {
      if (!/EPERM/.test(String(err && err.message))) throw err;
      emit({ kind: 'launch-fallback', used: 'launchChromeNoPipe' });
      proc = launchChromeNoPipe(browser, url, userDataDir, port);
    }
    const wsUrl = await waitForPageWs(port, STUB_NAME, Number(process.env.OMNI_PROBE_WAIT_MS || 12000));
    cdp = new CdpSession(wsUrl);
    const mounted = await cdp.waitMounted(1200);
    if (!mounted) throw new Error('app 未挂载：无法测量');

    for (const theme of ['dark', 'light']) {
      await cdp.evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
      await new Promise((r) => setTimeout(r, 250));
      emit({ kind: 'composer', theme, value: await cdp.evaluate(probeExpr()) });
      await cdp.evaluate(`(function(){ var t=document.querySelector('.composer textarea, .composer-input textarea'); if(t) t.focus(); })()`);
      await new Promise((r) => setTimeout(r, 250));
      emit({ kind: 'composer-focused', theme, value: await cdp.evaluate(probeExpr()) });
    }
  } catch (err) {
    emit({ kind: 'error', message: String(err && err.message ? err.message : err) });
    exitCode = 0;
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    try { proc?.kill(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return exitCode;
}

main().then((code) => process.exit(code));
