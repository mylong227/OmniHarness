// 中栏虚拟化「滚动空洞」门禁（真浏览器 + CDP）：跳转式滚动下，视口**必须**被已渲染块覆盖。
//
// ## 缺陷形态（2026-09-27 用户报「滚动到该区域就没有任何显示，再往下滚又出现」+ 截图空白区）
//
// 中栏虚拟化用 `BlockHeightIndex`（实测 ∪ 估算）算 padTop/padBottom 与滚动定位，而**浏览器的 scrollTop
// 是真实 DOM 高度**。两者只要不一致（估算 88px vs 长回复几百 px、簇展开折叠后的陈旧高、忙/闲分组换掉
// 块含义），错位就会累积：跳转滚动（拖滚动条）时视口正好落进占位区 ⇒ **一个块都看不到**。
// 真实会话实测（152 事件 / 81–142 块）：**跳转式滚动下每轮 2–4 处空白，最差一档覆盖率 0%**（DOM 里
// 却有 23 个块）；顺序滚动不明显 —— 故本用例刻意用**跳转**驱动。
//
// ## 判据
//
// 造一条「高矮块混杂」的长流（长 reasoning/assistant + 大量短工具块），按 5%~95% 的比例**跳转**滚动，
// 每档等测量/校正收敛后量「视口被已渲染块覆盖的比例」，**任何一档低于 60% 即失败**。
// 修复点：`StreamWindow.anchorDelta` + `StreamView` 的锚定自愈校正（把「最接近视口顶的已渲染块」的
// 真实偏移对齐到模型偏移）。
//
// ## 第二形态（2026-10-07 用户报「会话流滚动时出现大面积空白」）：**零高空块**
//
// 上面那条合成流（长块为主）**不复现**本形态 —— 逐条/批量推事件与「从服务端 batch 载入真实会话」
// 在测量时序与估算/实测失配量上都不同（真实会话跳转滚动每轮 2–4 处空白，长块合成流始终 ≥96%）。
//
// 真成因是**块构建把「渲染为 null 的事件」也当成块**：`session_meta` / `model`（每步一条）/ 已被
// 调用卡内联的 `tool_result` 在渲染层返回 null（真实高度 0），旧块构建却给它们分配 key 与 88px 估算。
// 于是 `BlockHeightIndex` 永远测不到这些块（测量循环 `h > 0` 跳过 0 高），索引与真实 DOM **系统性
// 漂移**：一个窗口里十几~三十几个空块 ⇒ padBottom 把视口顶满 ⇒ 一屏空白。
//
// 故本文件第二条用例专门喂这种混杂流（大量 `model` + 少量短消息），并同时钉两条判据：
// ① 任何一档覆盖率 ≥ 60%；② **DOM 里不得存在 0 高的 `.sw-block`**（= 空块没有进入块列表）。
//
// 可证伪性（2026-10-07 实测，隔离变量 = 只把 `isRenderedEvent` 改成恒 true，其余代码不变）：
// 同一混合流 13 档里 5 档覆盖率 **0%**、DOM 里 31 个 0 高块；修复后 13 档全 100%、0 高块 0 个。
// 真会话复核（`sess_mujefco0_1`，152 事件 / 35 条 model）：修复前最低 **42%**（最多 32 个 0 高块），
// 修复后 13 档全 100%。
//
// 直跑：node --test web/test/streamScrollCoverage.test.mjs（需先 npm run web:build）。
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

const STUB = '_scroll-coverage.html';
/** 长块正文（约 720 字）：制造「估算 88px vs 真实几百 px」的高度失配。 */
const LONG_TEXT = '这是一段很长的推理内容，用来把单块高度撑到远超估算值。'.repeat(30);
/** 覆盖比例下限（%）：低于此值视为「视口落进占位区」。 */
const MIN_COVERAGE = 60;

/**
 * 在 stub 页里造一条高矮混杂的长流。
 * @param {object} cdp CDP 会话。
 * @returns {Promise<void>} 无
 */
async function seedLongStream(cdp) {
  await cdp.evaluate(`(function(){
    var push = window.__PUSH__;
    var n = 0;
    for (var g = 0; g < 18; g++) {
      push({ method:'thread.event', params:{ event:{ id:'u'+g, type:'user', timestamp:n++, payload:{ content:'任务 ' + g } } } });
      push({ method:'thread.event', params:{ event:{ id:'R'+g, type:'reasoning', timestamp:n++, payload:{ content: ${JSON.stringify(LONG_TEXT)} } } } });
      for (var i = 0; i < 3; i++) {
        push({ method:'thread.event', params:{ event:{ id:'c'+g+'_'+i, type:'tool_call', timestamp:n++, payload:{ callId:'k'+g+'_'+i, name:'read_file', args:{ path:'src/a'+g+'.ts' } } } } });
        push({ method:'thread.event', params:{ event:{ id:'x'+g+'_'+i, type:'tool_result', timestamp:n++, payload:{ callId:'k'+g+'_'+i, ok:true, output:'内容 ' + g + '-' + i } } } });
      }
      push({ method:'thread.event', params:{ event:{ id:'A'+g, type:'assistant', timestamp:n++, payload:{ content: ${JSON.stringify(LONG_TEXT)} } } } });
    }
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 1500));
}

/**
 * 按比例跳转滚动，返回每档的视口覆盖率与「0 高空块」计数。
 * @param {object} cdp CDP 会话。
 * @returns {Promise<{samples:Array<{ratio:number, pos:number, nodes:number, zeroH:number}>, max:number, total:string}>} 度量。
 */
function sampleCoverage(cdp) {
  return cdp.evaluate(`(async function(){
    var s = document.querySelector('.stream');
    if (!s) return { error: 'no-stream' };
    var max = s.scrollHeight - s.clientHeight;
    var ratios = [0.05,0.15,0.25,0.35,0.45,0.55,0.65,0.75,0.85,0.95,0.5,0.2,0.8];
    var samples = [];
    for (var k = 0; k < ratios.length; k++) {
      s.scrollTop = Math.round(max * ratios[k]);          // 跳转：等价拖动滚动条
      s.dispatchEvent(new Event('scroll'));
      await new Promise(function(r){ setTimeout(r, 250); }); // 等测量 / 锚定校正收敛
      var vTop = s.getBoundingClientRect().top, vBottom = vTop + s.clientHeight;
      var covered = 0;
      var zeroH = 0;
      var nodes = s.querySelectorAll('.sw-block');
      for (var i = 0; i < nodes.length; i++) {
        var r = nodes[i].getBoundingClientRect();
        if (r.height === 0) zeroH += 1;                    // 渲染为 null 的事件不该出现在这里
        var top = Math.max(r.top, vTop), bottom = Math.min(r.bottom, vBottom);
        if (bottom > top) covered += (bottom - top);
      }
      samples.push({ ratio: Math.round((covered / s.clientHeight) * 100), pos: s.scrollTop, nodes: nodes.length, zeroH: zeroH });
    }
    return { samples: samples, max: max, total: s.getAttribute('data-total-count') };
  })()`);
}

/**
 * 造一条「零高空块混杂」的流：1 条 session_meta + 30 条 model + 10 条短消息。
 *
 * `model` 与 `session_meta` 在渲染层返回 null（真实高度 0）。修复前它们会被算成 88px 的块，
 * 30 个空块 = 2640px 幽灵高度，把真实内容只有 ~450px 的流算成三千多像素高 ⇒ 跳转滚动后视口
 * 落进 padBottom（实测 5 档覆盖率 0%）。
 * @param {object} cdp CDP 会话。
 * @returns {Promise<void>} 无
 */
async function seedNullRenderedMix(cdp) {
  const events = [];
  let t = 0;
  events.push({ id: `m${t}`, type: 'session_meta', timestamp: t++, payload: { workspace: 'D:\\tmp' } });
  for (let i = 0; i < 30; i++) events.push({ id: `model${t}`, type: 'model', timestamp: t++, payload: { model: 'x' } });
  for (let i = 0; i < 10; i++) {
    events.push({ id: `a${t}`, type: 'assistant', timestamp: t++, payload: { content: `好的，我来处理这一步（第 ${i} 步）。` } });
  }
  // 分批推（每批 20 条）：与真实装载/流式的到达形态一致。
  for (let i = 0; i < events.length; i += 20) {
    const envs = events.slice(i, i + 20).map((e) => ({ method: 'thread.event', params: { event: e } }));
    await cdp.evaluate(`(function(){ var a=${JSON.stringify(envs)}; for (var k=0;k<a.length;k++) window.__PUSH__(a[k]); return true; })()`);
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 1200));
}

/**
 * 起一次「真 Chrome + stub 页（真前端 + 假后端）」会话。
 * @param {object} t node:test 上下文（环境不可用时用于显式 skip）。
 * @returns {Promise<{cdp:object, close:()=>Promise<void>}|null>} 会话；不可用返回 null（已 skip）。
 */
async function openStubSession(t) {
  const browser = findBrowser();
  if (browser === null) {
    t.skip('未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 后重跑');
    return null;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('Node 缺全局 WebSocket（需 Node ≥22）');
    return null;
  }
  const server = await serveStatic(WEB_ROOT_PATH, { [`/${STUB}`]: stubHtmlCdp() });
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-scrollcov-'));
  const cdpPort = await getFreePort();
  const proc = launchChromeForCdp(browser, `http://127.0.0.1:${server.port}/${STUB}`, userDataDir, cdpPort);
  /** 无论成败都收干净：浏览器整树 + 静态服务 + 临时 profile。 @returns {Promise<void>} 无 */
  const cleanup = async () => {
    killChromeTree(proc, userDataDir);
    await server.close();
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* 锁未释放，交由 OS 回收 */
    }
  };
  let cdp;
  try {
    cdp = new CdpSession(await waitForPageWs(cdpPort, STUB));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
    await cdp.navigate(`http://127.0.0.1:${server.port}/${STUB}`);
    await cdp.waitFor("!!document.querySelector('.composer-input textarea')", 1200);
  } catch (err) {
    if (cdp !== undefined) cdp.close();
    await cleanup();
    throw err;
  }
  return {
    cdp,
    async close() {
      cdp.close();
      await cleanup();
    },
  };
}

test('① 长块流：跳转滚动不得出现「视口全是占位」的空洞', { timeout: 120_000 }, async (t) => {
  const page = await openStubSession(t);
  if (page === null) return;
  try {
    await seedLongStream(page.cdp);

    // 两轮：第一轮索引尚冷（多为估算），第二轮索引已热身 —— 两轮都不得出现空洞。
    for (const round of [1, 2]) {
      const res = await sampleCoverage(page.cdp);
      assert.ok(res.samples !== undefined, `第 ${round} 轮取样失败：${JSON.stringify(res)}`);
      assert.ok(res.samples.length > 0, '未取到任何滚动样本');
      const bad = res.samples.filter((s) => s.ratio < MIN_COVERAGE);
      assert.deepStrictEqual(
        bad,
        [],
        `第 ${round} 轮出现滚动空洞（覆盖 < ${MIN_COVERAGE}%）：${JSON.stringify(bad)}（总块 ${res.total}）`,
      );
    }
  } finally {
    await page.close();
  }
});

test('② 零高空块混杂流：跳转滚动不得空白，且 DOM 里不得有 0 高的块', { timeout: 120_000 }, async (t) => {
  const page = await openStubSession(t);
  if (page === null) return;
  try {
    await seedNullRenderedMix(page.cdp);
    for (const round of [1, 2]) {
      const res = await sampleCoverage(page.cdp);
      assert.ok(res.samples !== undefined, `第 ${round} 轮取样失败：${JSON.stringify(res)}`);
      assert.ok(res.samples.length > 0, '未取到任何滚动样本');
      const blank = res.samples.filter((s) => s.ratio < MIN_COVERAGE);
      assert.deepStrictEqual(
        blank,
        [],
        `第 ${round} 轮出现空白视口（覆盖 < ${MIN_COVERAGE}%）：${JSON.stringify(blank)}（总块 ${res.total}）`,
      );
      // 根因判据：`session_meta` / `model` 在渲染层返回 null，**不得**作为 `.sw-block` 出现在 DOM 里
      // （它们的 88px 估算就是索引漂移的来源）。这一条对已知坏输入变红：旧块构建 31 个 0 高块。
      const empty = res.samples.filter((s) => s.zeroH > 0);
      assert.deepStrictEqual(
        empty,
        [],
        `第 ${round} 轮 DOM 里出现 0 高的 .sw-block（渲染为 null 的事件被算成了块）：${JSON.stringify(empty)}`,
      );
    }
  } finally {
    await page.close();
  }
});
