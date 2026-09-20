// 响应式溢出探针（零依赖，真实浏览器）：测量 OmniHarness Web UI 在 640px / 1280px 视口下
// 是否出现横向溢出，并给出具体越界元素。
//
// 路线与 e2e-cdp.test.mjs 完全同源（复用 ./browserHarness.mjs）：
//   1. 零依赖静态服务托管 web/ + 注入假后端的 CDP stub 页；
//   2. headless Chrome（--remote-debugging-port）→ Node 22 内置 WebSocket 直连 CDP；
//   3. 用 Emulation.setDeviceMetricsOverride 精确设定视口宽度；
//   4. 先注入「有代表性内容」（真实 DOM 容器 + app 自身 CSS 类），再测量：
//      - 文档级：scrollWidth / clientWidth / 是否溢出（并列出越界元素）
//      - 区域级：.rail / .tabs / .col.right / .col.left / .composer-input(/textarea) 的宽度
//   5. 640px 下分别测「抽屉关闭 / 左抽屉开 / 右抽屉开」，1280px 下测「抽屉关闭」。
//
// 这是探针而非门禁：发现溢出也 exit 0；找不到浏览器则打印 SKIP 并 exit 0。
// 用法：node web/test/responsiveProbe.mjs [--full]
//   --full 额外打印每个区域与每个越界元素的完整明细（默认只在有溢出时打印越界元素）。
// 环境变量：
//   OMNI_PROBE_WS=ws://127.0.0.1:<port>/devtools/page/<id>  跳过启动，直连既有 CDP page target（受限沙箱下可用）；
//   OMNI_PROBE_WAIT_MS=<ms>                                 等待 page target 的超时（默认 12000）。
// 受限环境说明：本机沙箱若拒绝 node→子进程 的 stdio 管道（spawn EPERM），会回退到等价的
// launchChromeNoPipe（仅 stdio 改 'ignore'）；若连命名管道都被拒（Chrome FATAL platform_channel.cc），
// 则浏览器无法启动，本探针打印 browser-unavailable 诊断后以 0 退出，不产生测量值。

import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
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

const STUB_NAME = '_responsive-probe-stub.html';
const HEIGHT = 900;
const FULL = process.argv.includes('--full');

/** 打印一行 JSON（stdout，机器可读）。 */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * 受限沙箱回退启动器：与 browserHarness.launchChromeForCdp 完全同参、同 flag，
 * 唯一差别是 stdio 用 'ignore' 而非 ['ignore','pipe','pipe']。
 * 原因：`spawn(node→任意子进程, stdio:'pipe')` 在受限模式下抛 EPERM（管道创建被拒），
 * 而无管道（'ignore'/'inherit'）的 spawn 正常——实测 `spawn(chrome, [...], {stdio:'ignore'})` 能起浏览器。
 * 仅在主路径 EPERM 时使用；Chrome 的 stdout/stderr 本探针不使用。
 * @param {string} browser 浏览器可执行文件
 * @param {string} url 启动页地址
 * @param {string} userDataDir 独立用户数据目录
 * @param {number} port 远程调试端口
 * @returns {import('node:child_process').ChildProcess} Chrome 子进程
 */
function launchChromeNoPipe(browser, url, userDataDir, port) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--no-proxy-server',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--user-data-dir=' + userDataDir,
    '--window-size=1280,860',
    '--remote-debugging-port=' + port,
    url,
  ];
  return spawn(browser, args, { stdio: 'ignore' });
}

/**
 * 预检：能否连上 CDP 调试端口（区分「Chrome 根本没起来」与「起来了但 /json 未就绪」）。
 * @param {number} port 调试端口
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<boolean>} 可连接为 true
 */
function tcpReachable(port, timeoutMs = 1200) {
  return new Promise((res) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    const done = (v) => {
      try {
        sock.destroy();
      } catch {
        /* 已销毁 */
      }
      res(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

/**
 * 运行期启动失败的诊断：给出可操作的原因，而不是一句 EPERM。
 * @param {Error} err 启动异常
 * @param {number} port 调试端口
 * @param {import('node:child_process').ChildProcess|undefined} proc Chrome 子进程
 * @returns {Promise<Record<string, unknown>>} 诊断对象
 */
async function startupDiagnosis(err, port, proc) {
  const stderr = proc && proc.stderr ? String(globalThis.__PROBE_STDERR__ || '') : '';
  const portUp = await tcpReachable(port);
  const hints = [];
  if (/EPERM/.test(String(err && err.message))) {
    hints.push(
      '子进程 stdio 管道被沙箱拒绝（spawn EPERM）：browserHarness.launchChromeForCdp 用 stdio:["ignore","pipe","pipe"]，' +
        '受限模式下任何 node→子进程 的管道创建都会被拒；改用 Start-Process 从 pwsh 直接起 Chrome 也仍会因命名管道被拒而 ' +
        'FATAL platform_channel.cc(86) / crashpad OpenProcess (0x5) 退出。',
    );
  }
  if (proc && proc.exitCode === -1) {
    hints.push(
      'Chrome 进程已启动但立即以 0xFFFFFFFF(-1) 退出且调试端口不可达：实测 stderr 为 ' +
        'FATAL platform_channel.cc(86) Check failed / crashpad OpenProcess (0x5) —— 浏览器多进程 IPC 必须创建命名管道，' +
        '受限沙箱禁止创建命名管道，故本环境下 Chrome 无法运行（--single-process / --in-process-gpu / --disable-crashpad 均无效）。',
    );
  } else if (proc && (proc.exitCode !== null || /platform_channel|crashpad|OpenProcess/.test(stderr))) {
    hints.push(
      'Chrome 自身以 FATAL platform_channel.cc / crashpad OpenProcess (0x5) 退出：浏览器多进程 IPC 需要命名管道，' +
        '受限沙箱禁止创建命名管道 → 本环境下无法真正启动 Chrome。',
    );
  }
  hints.push(
    '可在放开子进程/命名管道限制的会话中重跑；或先自行启动带 --remote-debugging-port=<port> 的 Chrome，' +
      '再用 OMNI_PROBE_WS=ws://127.0.0.1:<port>/devtools/page/<id> 让本探针跳过启动步骤直接测量。',
  );
  return {
    kind: 'browser-unavailable',
    error: String((err && err.message) || err),
    chromeStderrHead: stderr.split('\n').slice(0, 3).join(' | ').trim(),
    debugPortReachable: portUp,
    chromeExitCode: proc ? proc.exitCode : null,
    hints,
  };
}

/** 在页面里求值的测量函数源码（字符串化后经 CDP 注入）。 */
export function measureScript() {
  return `(function(){
  var W = document.documentElement.clientWidth;
  var AREAS = ['.rail', '.tabs', '.col.right', '.col.left', '.composer-input', '.composer-input textarea'];

  function pathOf(el){
    var parts = [];
    var n = el;
    for (var i = 0; i < 4 && n && n.nodeType === 1 && n !== document.documentElement; i++) {
      var s = n.tagName.toLowerCase();
      if (n.id) { s += '#' + n.id; parts.unshift(s); break; }
      if (n.className && typeof n.className === 'string') {
        var cs = n.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3);
        if (cs.length) s += '.' + cs.join('.');
      }
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  function clipAncestor(el){
    var p = el.parentElement;
    while (p && p !== document.documentElement) {
      var ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return p;
      p = p.parentElement;
    }
    return null;
  }

  function areaOf(el){
    for (var i = 0; i < AREAS.length; i++) {
      var host = document.querySelector(AREAS[i]);
      if (host && (host === el || host.contains(el))) return AREAS[i];
    }
    return '(root)';
  }

  // 遍历所有元素，找横向越界者（排除 position:fixed、被滚动容器裁剪者、以及设计上屏外放置的抽屉）。
  var offenders = [];
  var all = document.querySelectorAll('*');
  for (var k = 0; k < all.length; k++) {
    var el = all[k];
    var st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    if (st.position === 'fixed') continue;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    var clipped = clipAncestor(el);
    if (clipped) continue;
    var right = r.right, left = r.left;
    if (right > W + 1 || left < -1) {
      offenders.push({
        path: pathOf(el),
        area: areaOf(el),
        position: st.position,
        overflowX: st.overflowX,
        rect: { left: +left.toFixed(2), right: +right.toFixed(2), width: +r.width.toFixed(2) },
        beyondRight: +Math.max(0, right - W).toFixed(2),
        beyondLeft: +Math.max(0, -left).toFixed(2),
        offscreen: right <= 0 || left >= W,
        transform: st.transform === 'none' ? '' : st.transform,
        nowrap: st.whiteSpace,
        scrollW: el.scrollWidth,
        clientW: el.clientWidth
      });
    }
  }
  offenders.sort(function(a, b){ return (b.beyondRight + b.beyondLeft) - (a.beyondRight + a.beyondLeft); });

  var areas = AREAS.map(function(sel){
    var el = document.querySelector(sel);
    if (!el) return { sel: sel, found: false };
    var st = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    return {
      sel: sel,
      found: true,
      rect: { left: +r.left.toFixed(2), right: +r.right.toFixed(2), width: +r.width.toFixed(2) },
      hidden: st.display === 'none' ? st.display : false,
      position: st.position,
      overflowX: st.overflowX,
      exceedsViewport: r.width > W + 1,
      beyondRight: +Math.max(0, r.right - W).toFixed(2),
      offscreen: r.width > 0 && (r.right <= 0 || r.left >= W)
    };
  });

  return {
    viewportW: W,
    docEl: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    },
    body: {
      scrollWidth: document.body.scrollWidth,
      clientWidth: document.body.clientWidth,
      overflow: document.body.scrollWidth > document.body.clientWidth
    },
    // 若 body 被 overflow-x:hidden/clip 裁剪，文档级 scrollWidth 可能"看起来正常"，
    // 此时真正的溢出只体现在 offending 元素上 —— 记录该值以便正确解读。
    htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
    overflow: document.documentElement.scrollWidth > W,
    offendingCount: offenders.length,
    // 注意：FULL 是 **Node 侧**变量，必须在此处插值成字面量；直接写它会原样送进页面变成
    // ReferenceError（探针此前就卡在这；页面侧变量如 W 则必须保持裸名）。
    offending: offenders.slice(0, ${FULL ? 40 : 12}),
    areas: areas
  };
})()`;
}

/** 注入「有代表性内容」的源码：全部用 app 真实容器 + 真实 CSS 类，保证真实样式生效。 */
export function injectScript() {
  return `(function(){
  var long = new Array(401).join('x');               // 400 个无空格字符（不可断 token 压力）
  var deep = 'src/some/very/deeply/nested/path/that/keeps/going/and/going/file.ts';
  var made = { sessions: 0, taskCards: 0, wsProjects: 0, changeItems: 0, patch: 0, diffRows: 0, reviewHelp: 0, textarea: 0 };

  var sessions = document.getElementById('sessions');
  if (sessions) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 12; i++) {
      var row = document.createElement('div');
      row.className = 'session';
      var lab = document.createElement('span');
      lab.className = 'session-label';
      lab.textContent = '一个很长的会话标题_' + String(1000000 + i) + '_' + i;
      var acts = document.createElement('span');
      acts.className = 'session-actions';
      acts.textContent = '✎ 🗑 ⇄';
      row.appendChild(lab); row.appendChild(acts);
      frag.appendChild(row); made.sessions++;
    }
    var cards = document.createElement('div');
    cards.className = 'session-cards';
    var card = document.createElement('div');
    card.className = 'task-card';
    var top = document.createElement('div');
    top.className = 'tc-top';
    var dot = document.createElement('span'); dot.className = 'tc-dot on';
    var tlab = document.createElement('span'); tlab.className = 'session-label';
    tlab.textContent = '这是一个非常长的并行任务标题_用于压测窄视口下的截断行为_' + long.slice(0, 80);
    top.appendChild(dot); top.appendChild(tlab);
    var meta = document.createElement('div'); meta.className = 'tc-meta';
    var ws = document.createElement('span'); ws.className = 'tc-ws';
    ws.textContent = 'D:/deepseek/omniharness/very/deep/workspace/path';
    meta.appendChild(ws);
    card.appendChild(top); card.appendChild(meta);
    cards.appendChild(card); made.taskCards++;
    frag.appendChild(cards);

    var projs = document.createElement('div');
    projs.className = 'ws-projects';
    var p1 = document.createElement('div'); p1.className = 'ws-project active';
    var pd = document.createElement('span'); pd.className = 'ws-project-dot';
    var pn = document.createElement('span'); pn.className = 'ws-project-name';
    pn.textContent = 'D:/deepseek/omniharness/very/deep/workspace/path/that/keeps/going';
    p1.appendChild(pd); p1.appendChild(pn);
    projs.appendChild(p1); made.wsProjects++;
    frag.appendChild(projs);

    sessions.appendChild(frag);
  }

  var pane = document.querySelector('.pane.active');
  if (pane) {
    var list = document.createElement('div');
    list.className = 'changes-list';
    for (var j = 0; j < 6; j++) {
      var item = document.createElement('div');
      item.className = 'change-item';
      var crow = document.createElement('div');
      crow.className = 'change-row';
      var badge = document.createElement('span');
      badge.className = 'change-badge ' + (j % 2 ? 'del' : 'mod');
      badge.textContent = j % 2 ? '删除' : '修改';
      var cpath = document.createElement('span'); cpath.className = 'change-path'; cpath.textContent = deep;
      var nums = document.createElement('span'); nums.className = 'change-nums';
      nums.textContent = '+12 −3';
      var caret = document.createElement('span'); caret.className = 'change-caret'; caret.textContent = '▸';
      crow.appendChild(badge); crow.appendChild(cpath); crow.appendChild(nums); crow.appendChild(caret);
      item.appendChild(crow);
      list.appendChild(item); made.changeItems++;
    }

    var patch = document.createElement('div');
    patch.className = 'change-patch';
    var rows = document.createElement('div');
    rows.className = 'diff-rows';
    for (var d = 0; d < 20; d++) {
      var dr = document.createElement('div');
      dr.className = 'diff-row ' + (d % 2 ? 'del' : 'add');
      var no = document.createElement('span'); no.className = 'diff-no'; no.textContent = String(d + 1);
      var sg = document.createElement('span'); sg.className = 'diff-sign'; sg.textContent = d % 2 ? '-' : '+';
      var tx = document.createElement('span'); tx.className = 'diff-text'; tx.textContent = long;
      dr.appendChild(no); dr.appendChild(sg); dr.appendChild(tx);
      rows.appendChild(dr); made.diffRows++;
    }
    patch.appendChild(rows); made.patch++;
    list.appendChild(patch);

    var help = document.createElement('div');
    help.className = 'review-help';
    help.textContent =
      '审查帮助：在 diff 行上点击右侧铅笔图标可以对该行发起行内评论；hunk 头部右侧的按钮可以对整个 hunk 执行 stage 或 revert。' +
      '这条帮助文本刻意写得很长，用来检验未换行长文本在窄视口下是否把容器撑出横向滚动。' +
      long.slice(0, 60);
    list.appendChild(help); made.reviewHelp++;

    pane.appendChild(list);
  }

  var ta = document.querySelector('.composer-input textarea');
  if (ta) { ta.value = long.slice(0, 300); made.textarea++; }

  return made;
})()`;
}

/** 主流程。 @returns {Promise<number>} 进程退出码 */
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-probe-ud-'));
  let cdp;
  let proc;
  let port = 0;
  let exitCode = 0;
  try {
    let wsUrl = externalWs;
    if (!wsUrl) {
      port = await getFreePort();
      const url = `http://127.0.0.1:${server.port}/${STUB_NAME}`;
      try {
        proc = launchChromeForCdp(browser, url, userDataDir, port);
      } catch (err) {
        if (!/EPERM/.test(String(err && err.message))) throw err;
        emit({ kind: 'launch-fallback', reason: 'spawn EPERM（stdio 管道被沙箱拒绝）', used: 'launchChromeNoPipe' });
        proc = launchChromeNoPipe(browser, url, userDataDir, port);
      }
      try {
        proc.on('error', (e) => {
          globalThis.__PROBE_SPAWN_ERROR__ = e;
        });
        wsUrl = await waitForPageWs(port, STUB_NAME, Number(process.env.OMNI_PROBE_WAIT_MS || 12000));
      } catch (err) {
        const spawnErr = globalThis.__PROBE_SPAWN_ERROR__;
        emit(await startupDiagnosis(spawnErr || err, port, proc));
        process.stderr.write('PROBE: 无法启动浏览器，未产生测量值（见上一条 browser-unavailable）。\n');
        return 0;
      }
    } else {
      process.stdout.write('using external CDP target from OMNI_PROBE_WS\n');
    }
    cdp = new CdpSession(wsUrl);

    const mounted = await cdp.waitMounted(1200);
    if (!mounted) throw new Error('app 未挂载：无法测量（stub 页或假后端可能已变更）');

    // 注意：CDP evaluate 接收的是**表达式**——裸对象字面量会被当成语句块解析（`Unexpected token ':'`），
    // 故必须用括号包成表达式。这里修的就是这个语法错误（探针此前根本跑不到测量阶段）。
    const present = await cdp.evaluate(`({
      sessions: !!document.getElementById('sessions'),
      paneActive: !!document.querySelector('.pane.active'),
      left: !!document.querySelector('.col.left'),
      right: !!document.querySelector('.col.right'),
      rail: !!document.querySelector('.rail'),
      tabs: !!document.querySelector('.tabs'),
      composer: !!document.querySelector('.composer-input textarea'),
      toggles: document.querySelectorAll('.drawer-toggle').length
    })`);
    emit({ kind: 'env', browser, viewportHeight: HEIGHT, present });

    const made = await cdp.evaluate(injectScript());
    emit({ kind: 'injected', made });

    const states = [
      { width: 640, drawers: 'closed', cls: null },
      { width: 640, drawers: 'left-open', cls: ['col left', 'open'] },
      { width: 640, drawers: 'right-open', cls: ['col right', 'open'] },
      { width: 1280, drawers: 'closed', cls: null },
    ];

    const verdicts = [];
    for (const state of states) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: state.width,
        height: HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });
      // 抽屉状态：直接设置 app 自己使用的类（`.col.left/.col.right` + `open`），等价于点 .drawer-toggle。
      await cdp.evaluate(
        `(function(){
          var l = document.querySelector('.col.left');
          var r = document.querySelector('.col.right');
          if (l) l.className = 'col left';
          if (r) r.className = 'col right';
          var want = ${JSON.stringify(state.cls ? state.cls[0] : null)};
          if (want === 'col left' && l) l.className = 'col left open';
          if (want === 'col right' && r) r.className = 'col right open';
          return true;
        })()`,
      );
      // 等两帧 + 过渡（.col 有 .25s transform 过渡），确保布局稳定后再测。
      await new Promise((r) => setTimeout(r, 350));
      const m = await cdp.evaluate(measureScript());
      const record = { kind: 'measure', width: state.width, drawers: state.drawers, ...m };
      emit(
        FULL
          ? record
          : {
              kind: 'measure',
              width: record.width,
              drawers: record.drawers,
              viewportW: record.viewportW,
              docScrollWidth: record.docEl.scrollWidth,
              docClientWidth: record.docEl.clientWidth,
              bodyScrollWidth: record.body.scrollWidth,
              bodyOverflowX: record.bodyOverflowX,
              overflow: record.overflow,
              offendingCount: record.offendingCount,
              offending: record.offending.map((o) => ({
                path: o.path,
                area: o.area,
                beyondRight: o.beyondRight,
                beyondLeft: o.beyondLeft,
                offscreen: o.offscreen,
              })),
              areas: record.areas.map((a) => ({
                sel: a.sel,
                found: a.found,
                width: a.rect ? a.rect.width : null,
                exceedsViewport: a.exceedsViewport || false,
                hidden: a.hidden,
                offscreen: a.offscreen,
              })),
            },
      );
      // 仅「抽屉关闭」的基线计入最终裁决（抽屉开启时的屏外元素是设计如此）。
      if (state.drawers === 'closed') {
        verdicts.push({ width: state.width, overflow: record.overflow, scrollWidth: record.docEl.scrollWidth, clientWidth: record.docEl.clientWidth, offendingCount: record.offendingCount });
      }
    }

    emit({ kind: 'verdict', verdicts });
  } catch (err) {
    exitCode = 0; // 探针不因运行期异常而伪装成门禁失败：明确打印错误后仍以 0 退出。
    emit({ kind: 'error', message: String((err && err.message) || err) });
    process.stderr.write('PROBE ERROR: ' + String((err && err.stack) || err) + '\n');
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
  return exitCode;
}

process.exitCode = await main();
