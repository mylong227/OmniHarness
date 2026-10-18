// F8 窄栏重排判据（真 Chrome + CDP，量**真 SPA** 的中栏横向溢出）。
//
// ## 登记口径（docs/PROJECT_BOARD.md §8.5 未修两条之一）
//
// 原文：「F8 中栏在 1000/1280 窄视口 + 两栏展开时横向溢出（`.col center` scrollWidth 447 >
// clientWidth 319）——正解是输入条**断点重排**，有独立视觉验收面（responsiveProbe 的 640px 档）」。
//
// ## 为什么是判据而不是探针
//
// `responsiveProbe.mjs` 是**探针**（发现溢出也 exit 0），且注入的是合成 DOM；本文件是**判据**：
// 用桩后端让**真 SPA 真挂载**（与 e2e-cdp 同路线），摆出 F8 的确切状态，然后断言
// 中栏**不溢出**；并附**正对照**（把修复前的几何强加回去，断言同一测量**必须变红**）——
// 否则"绿"可能只是因为判据量错了地方。
//
// 无浏览器时按 `OMNI_REQUIRE_BROWSER` 决定 skip 还是失败（缺环境不得静默变绿）。

import assert from 'node:assert/strict';
import { test } from 'vitest';
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
} from './browserHarness.ts';
import { skipReasonFor } from './browserSwitch.ts';

const STUB_NAME = '_narrow-reflow-stub.html';
const HEIGHT = 900;
/** F8 登记的两个视口宽度。 */
const WIDTHS = [1000, 1280];

/** serveStatic 返回的内存静态服务器句柄（browserHarness.ts 未标注类型，这里给出本地口径）。 */
interface StaticServerHandle {
  port: number;
  close: () => Promise<void>;
}

/** measure() 页面脚本的单次度量结果（cdp.evaluate 返回未标类型，按真实形状收窄）。 */
interface MeasureResult {
  center?: { scrollW?: number; clientW?: number };
  overflow?: boolean;
  docOverflow?: boolean;
  topOffenders?: unknown[];
}

/**
 * 摆出「两栏展开」状态（用 app 自己使用的类，等价于点抽屉开关）。
 * @returns {string} 求值源码
 */
function openBothDrawers() {
  return `(function(){
    var l = document.querySelector('.col.left');
    var r = document.querySelector('.col.right');
    if (l) l.className = 'col left open';
    if (r) r.className = 'col right open';
    return { left: l ? l.className : null, right: r ? r.className : null };
  })()`;
}

/**
 * 测量中栏与文档级横向溢出，并列出中栏内最宽的若干后代（定位真凶用）。
 * @returns {string} 求值源码
 */
function measure() {
  return `(function(){
    var center = document.querySelector('.col.center');
    if (!center) return { error: 'no .col.center' };
    var kids = [];
    var all = center.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.scrollWidth > center.clientWidth + 1) {
        kids.push({
          cls: String(el.className || el.tagName).slice(0, 60),
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
          offsetW: el.offsetWidth,
          minContent: (function(){
            var prev = el.style.width;
            el.style.width = 'min-content';
            var w = el.offsetWidth;
            el.style.width = prev;
            return w;
          })()
        });
      }
    }
    kids.sort(function(a, b){ return b.scrollW - a.scrollW; });
    return {
      viewportW: window.innerWidth,
      center: { scrollW: center.scrollWidth, clientW: center.clientWidth, offsetW: center.offsetWidth },
      overflow: center.scrollWidth > center.clientWidth + 1,
      docOverflow: document.documentElement.scrollWidth > window.innerWidth,
      topOffenders: kids.slice(0, 6)
    };
  })()`;
}

/**
 * 强加「修复前几何」：把当年的窄栏行为写回去（用于正对照）。
 *
 * 2026-10-17 更新（原正对照失效，不是判据失效）：
 *   本条正对照原先靠 `.composer-bar{flex-wrap:nowrap}` + `.starter-tasks` 两项把中栏顶宽。
 *   当轮把输入区右侧的两个下拉（推理强度 + 模型）合并成一个 `.mp` 之后，**输入条本身变窄了**，
 *   于是"只强制 nowrap"已经造不出溢出 ⇒ 正对照假红（`测不到溢出 ⇒ 判据没有牙`）。
 *   修法不是放宽判据，而是让正对照**如实还原修复前的输入条内容**：克隆一份 `.mp`
 *   当作当年的第二个下拉塞回 bar 里，再强制 nowrap。这样它检验的仍是同一件事
 *   ——「输入条很宽时，中栏能不能靠换行/收缩化解」——只是不再依赖某个控件的存在。
 * @returns {string} 求值源码
 */
function forceLegacyGeometry() {
  return `(function(){
    var s = document.createElement('style');
    s.id = 'legacy-f8-geometry';
    // 修复前的有效几何：空态块固定 460px 上限且列表恒两列；输入条不换行。
    s.textContent =
      '.starter-tasks{max-width:460px !important;}' +
      '.starter-list{grid-template-columns:repeat(2,minmax(0,1fr)) !important;}' +
      '.composer-bar{flex-wrap:nowrap !important;}' +
      '.composer-bar-left,.composer-bar-right{flex-wrap:nowrap !important;}';
    document.head.appendChild(s);
    // 还原"两个下拉并排"的输入条宽度：把当前唯一的 .mp 复制一份作为第二个（不可换行的）控件。
    var right = document.querySelector('.composer-bar-right');
    var mp = document.querySelector('.composer-bar-right .mp');
    if (right && mp) {
      var clone = mp.cloneNode(true);
      clone.id = 'legacy-f8-extra-mp';
      clone.setAttribute('data-legacy-control', '1');
      right.appendChild(clone);
    }
    return true;
  })()`;
}

/** 移除正对照样式与注入节点。 @returns {string} 求值源码 */
function clearLegacyGeometry() {
  return `(function(){
    var s = document.getElementById('legacy-f8-geometry');
    if (s && s.parentNode) s.parentNode.removeChild(s);
    var extra = document.getElementById('legacy-f8-extra-mp');
    if (extra && extra.parentNode) extra.parentNode.removeChild(extra);
    return true;
  })()`;
}

test('F8：1000/1280 窄视口 + 两栏展开时，中栏不得横向溢出（附正对照）', async (t) => {
  const found = findBrowser();
  const skipReason = skipReasonFor(found !== null);
  if (skipReason !== null) {
    // 2026-10-17 Vitest 化：vitest 的 reporter **默认不打印** `t.skip(reason)` 的文本
    //（node:test 的 TAP 会打 `# SKIP <reason>`）。而"跳过原因必须可读"本身是被断言的行为
    //（见 browserSwitch.test.mjs ④，它检查子进程输出里含「未找到本机 Chrome/Edge」），
    // 故把原因拼进 skip 文本的第一段，让 reporter 的 skipped 行也能带出关键短语。
    process.stdout.write(`[skip] ${skipReason}\n`);
    t.skip(); // 未找到本机 Chrome/Edge（原因已由上一行 console.log 带出）
    return;
  }
  const browser = found;
  assert.ok(browser !== null, 'OMNI_REQUIRE_BROWSER=1 时必须有浏览器');

  // serveStatic 在 browserHarness.ts 中未标类型（返回推断为 unknown），按本地句柄口径收窄
  const server = (await serveStatic(WEB_ROOT_PATH, { [`/${STUB_NAME}`]: stubHtmlCdp() })) as StaticServerHandle;
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-f8-ud-'));
  let cdp;
  let proc;
  try {
    const port = await getFreePort();
    const url = `http://127.0.0.1:${server.port}/${STUB_NAME}`;
    proc = launchChromeForCdp(browser, url, userDataDir, port);
    const wsUrl = await waitForPageWs(port, STUB_NAME);
    cdp = new CdpSession(wsUrl);
    await cdp.send('Runtime.enable');

    // 等真 SPA 挂载出中栏（桩后端已让 React 真渲染；最多等 15s）。
    let mounted = false;
    for (let i = 0; i < 60; i += 1) {
      const probe = await cdp.evaluate(
        `(function(){ var c = document.querySelector('.col.center'); return c ? c.clientWidth : 0; })()`,
      );
      if (typeof probe === 'number' && probe > 0) {
        mounted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(mounted, '真 SPA 未在 15s 内挂载出 .col.center（桩后端或前端构建可能有问题）');

    const results = [];
    for (const width of WIDTHS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.evaluate(openBothDrawers());
      await new Promise((r) => setTimeout(r, 350));
      // evaluate 返回 unknown，按页面脚本真实返回形状收窄（例外 a）
      const m = (await cdp.evaluate(measure())) as MeasureResult;
      results.push({ width, ...m });
      process.stdout.write(
        `[F8] ${String(width)}px 两栏展开 ⇒ 中栏 scrollW=${String(m.center?.scrollW)} ` +
          `clientW=${String(m.center?.clientW)} 溢出=${String(m.overflow)} ` +
          `最宽后代=${JSON.stringify((m.topOffenders ?? []).slice(0, 3))}\n`,
      );
    }

    // ① 主判据：登记的两个宽度下都不得溢出。
    for (const r of results) {
      assert.strictEqual(
        r.overflow,
        false,
        `${String(r.width)}px + 两栏展开：中栏仍横向溢出（scrollW ${String(r.center?.scrollW)} > ` +
          `clientW ${String(r.center?.clientW)}）；越界元素：${JSON.stringify(r.topOffenders)}`,
      );
      assert.strictEqual(
        r.docOverflow,
        false,
        `${String(r.width)}px + 两栏展开：文档级也溢出了（应只影响中栏内部滚动）`,
      );
    }

    // ② 正对照：把修复前的几何强加回去，同一测量**必须**变红（否则判据没有牙）。
    const control = [];
    for (const width of WIDTHS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.evaluate(openBothDrawers());
      await cdp.evaluate(forceLegacyGeometry());
      await new Promise((r) => setTimeout(r, 350));
      const m = (await cdp.evaluate(measure())) as MeasureResult;
      control.push({ width, ...m });
      await cdp.evaluate(clearLegacyGeometry());
    }
    assert.ok(
      control.some((r) => r.overflow === true),
      '正对照失败：强加修复前几何后**测不到**溢出 ⇒ 本判据量不到 F8 这个缺陷（绿是假的）',
    );
  } finally {
    // 清理必须**逐步独立容错**：首版 rmSync 抛 EBUSY（Chrome 还在写 profile）后，
    // 后面的 server.close() 就没跑到 ⇒ 静态服务吊住事件循环 ⇒ node --test 直到超时才结束
    // （表现为"判据超时"，掩盖了真正要报的测量结果）。
    try {
      if (cdp !== undefined) cdp.close();
    } catch {
      /* 关闭失败不影响结论 */
    }
    try {
      if (proc !== undefined) killChromeTree(proc, userDataDir);
    } catch {
      /* 同上 */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* profile 目录被占用不是判据失败 */
    }
    try {
      await server.close();
    } catch {
      /* 同上 */
    }
  }
});
